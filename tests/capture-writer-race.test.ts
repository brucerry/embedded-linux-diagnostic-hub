import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptureWriter } from '../shared/capture-writer';
import {
    CaptureStorageError,
    appendFrames,
    newCapture,
    sealedCapture,
    failedCapture,
    type CaptureRepository,
    type StoredCapture,
} from '../shared/capture-store';
import { deferred } from './fixtures/serial-capture';
test('finish joins the next in-flight batch when another flush drains pending frames after the first acknowledgement', async () => {
    const first = deferred(),
        second = deferred(),
        enteredFirst = deferred(),
        enteredSecond = deferred();
    let capture: StoredCapture,
        busy = false,
        commits = 0,
        seals = 0;
    const store: CaptureRepository = {
        async begin(header) {
            capture = newCapture(crypto.randomUUID(), 1, header);
            return capture;
        },
        async append(_id, frames) {
            assert.equal(busy, false);
            busy = true;
            const next = appendFrames(capture, frames);
            commits++;
            if (commits === 1) {
                enteredFirst.resolve();
                await first.promise;
            } else {
                enteredSecond.resolve();
                await second.promise;
            }
            capture = next;
            busy = false;
            return capture;
        },
        async seal(_id, observed, reason) {
            seals++;
            if (busy)
                throw new CaptureStorageError(
                    'backlog',
                    'Only one capture commit may be outstanding.',
                );
            capture = sealedCapture(capture, observed, reason);
            return capture;
        },
        async fail(_id, observed, error) {
            capture = failedCapture(capture, observed, error);
        },
        async page() {
            return { records: [capture], next: null };
        },
        async *read() {
            throw Error('Unexpected reader.');
        },
        async delete() {},
        async close() {},
        async pin() {
            return { through: 1, release: async () => {} };
        },
    };
    const writer = await CaptureWriter.begin(store, {
        transport: 'serial',
        receiveTimeSource: 'local-client',
        runId: 'race',
        stepId: 'one',
        name: 'race',
        command: 'fixture',
        startedAt: '2026-10-15T00:00:00.000Z',
    });
    await writer.append(new Uint8Array([1, 2, 3]), '2026-10-15T00:00:00.000Z', 'serial');
    const background = writer.flush();
    void background.catch(() => {});
    await enteredFirst.promise;
    await writer.append(new Uint8Array([4, 5, 6]), '2026-10-15T00:00:00.001Z', 'serial');
    const finished = writer.finish('prompt-observed');
    void finished.catch(() => {});
    try {
        first.resolve();
        await enteredSecond.promise;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(seals, 0, 'Seal must not overtake the second pending acknowledgement.');
        second.resolve();
        const result = await finished;
        await background;
        assert.equal(result.state, 'complete');
        assert.equal(result.committedBytes, 6);
        assert.equal(commits, 2);
        assert.equal(seals, 1);
    } finally {
        first.resolve();
        second.resolve();
        await Promise.allSettled([background, finished]);
    }
});
