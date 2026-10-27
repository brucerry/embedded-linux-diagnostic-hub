import test from 'node:test';
import assert from 'node:assert/strict';
import { workerReadFault, workerQuotaMessage } from './memory-product-worker-faults';
import type { CaptureRepository, CaptureRead } from '../../shared/capture-store';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test('held real iterator return retains reader and underlying lease until both gates settle', async () => {
    let lease = false,
        finallyEntered = false,
        finish!: () => void;
    const disposal = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const store = workerReadFault.wrap({
        async *read() {
            lease = true;
            try {
                yield { type: 'metadata' } as CaptureRead;
            } finally {
                finallyEntered = true;
                await disposal;
                lease = false;
            }
        },
    } as Pick<CaptureRepository, 'read'>);
    workerReadFault.arm('hold');
    const iterator = store.read('synthetic-unit-id')[Symbol.asyncIterator]();
    const first = iterator.next();
    await tick();
    assert.equal(workerReadFault.status()?.entered, true);
    assert.equal(workerReadFault.activeReads(), 1);
    assert.equal(lease, true);
    let returned = false;
    const closed = iterator.return!().then(() => {
        returned = true;
    });
    await tick();
    assert.equal(returned, false);
    assert.equal(lease, true);
    workerReadFault.release();
    await first;
    await tick();
    assert.equal(finallyEntered, true);
    assert.equal(workerReadFault.activeReads(), 1);
    assert.equal(lease, true);
    finish();
    await closed;
    assert.equal(workerReadFault.activeReads(), 0);
    assert.equal(lease, false);
    workerReadFault.clear();
});
test('quota fault propagates after the actual iterator finally closes its lease', async () => {
    let lease = false;
    const store = workerReadFault.wrap({
        async *read() {
            lease = true;
            try {
                yield { type: 'metadata' } as CaptureRead;
            } finally {
                lease = false;
            }
        },
    } as Pick<CaptureRepository, 'read'>);
    workerReadFault.arm('quota');
    await assert.rejects(store.read('synthetic-unit-id')[Symbol.asyncIterator]().next(), {
        message: workerQuotaMessage,
    });
    assert.equal(workerReadFault.activeReads(), 0);
    assert.equal(lease, false);
    assert.equal(workerReadFault.status()?.released, true);
    workerReadFault.clear();
});
