import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertProductSshRead,
    assertProductSshStreamRoutes,
    assertInterruptedProductSshRead,
    type ProductSshRead,
} from './memory-product-ssh-ui';
import type { AutomationOutcome } from '../../shared/automation-result';

const row = () => ({
    id: 'capture-id',
    state: 'complete' as const,
    committedBytes: 96,
    observedBytes: 96,
    command: 'fixture',
    failure: null,
});
const read = (): ProductSshRead => ({
    bytes: 96,
    frames: 2,
    streamBytes: { stdout: 64, stderr: 32, serial: 0 },
    streamSamples: { stdout: Array(32).fill(65), stderr: Array(32).fill(66), serial: [] },
    crcAndBoundariesVerified: true,
    outcome: { completion: 'exit', exitCode: 0, truncated: false } as AutomationOutcome,
});
test('SSH storage receipt requires complete raw stream counts and verified pinned data', () => {
    assert.equal(assertProductSshRead(row(), read(), { stdout: 64, stderr: 32 }).bytes, 96);
    for (const mutate of [
        (value: ProductSshRead) => {
            value.crcAndBoundariesVerified = false;
        },
        (value: ProductSshRead) => {
            value.bytes = 64;
        },
        (value: ProductSshRead) => {
            value.streamBytes = { stdout: 96, stderr: 0, serial: 0 };
        },
        (value: ProductSshRead) => {
            value.streamBytes = { stdout: 64, stderr: 31, serial: 1 };
        },
        (value: ProductSshRead) => {
            value.streamSamples.stderr[0] = 65;
        },
        (value: ProductSshRead) => {
            value.outcome = null;
        },
        (value: ProductSshRead) => {
            value.outcome!.completion = 'uncertain-close';
            value.outcome!.exitCode = null;
        },
        (value: ProductSshRead) => {
            value.outcome!.truncated = true;
        },
    ]) {
        const value = read();
        mutate(value);
        assert.throws(() => assertProductSshRead(row(), value, { stdout: 64, stderr: 32 }));
    }
    assert.throws(() =>
        assertProductSshRead({ ...row(), state: 'incomplete' }, read(), { stdout: 64, stderr: 32 }),
    );
    assert.throws(() =>
        assertProductSshRead({ ...row(), observedBytes: null }, read(), { stdout: 64, stderr: 32 }),
    );
});
test('legacy automation and missing credit/finalization traffic cannot satisfy streaming proof', () => {
    const valid = {
        start: 1,
        read: 3,
        ack: 2,
        finalize: 1,
        cancel: 0,
        legacy: 0,
        failedResponses: 0,
    };
    assertProductSshStreamRoutes(valid);
    for (const key of ['start', 'read', 'ack', 'finalize'] as const)
        assert.throws(() => assertProductSshStreamRoutes({ ...valid, [key]: 0 }));
    assert.throws(() => assertProductSshStreamRoutes({ ...valid, legacy: 1 }));
    assert.throws(() => assertProductSshStreamRoutes({ ...valid, failedResponses: 1 }));
});
test('interruption cannot publish success, an active owner or a fabricated exit code', () => {
    const value = read();
    value.outcome!.completion = 'cancelled';
    value.outcome!.exitCode = null;
    assertInterruptedProductSshRead(row(), value);
    assertInterruptedProductSshRead(
        { ...row(), state: 'incomplete', observedBytes: null },
        { ...value, outcome: null },
    );
    assert.throws(() => assertInterruptedProductSshRead(row(), read()));
    assert.throws(() => assertInterruptedProductSshRead({ ...row(), state: 'active' }, value));
    assert.throws(() => assertInterruptedProductSshRead(row(), { ...value, outcome: null }));
    assert.throws(() =>
        assertInterruptedProductSshRead(row(), {
            ...value,
            outcome: { ...value.outcome!, completion: 'prompt-observed' },
        }),
    );
    assert.throws(() =>
        assertInterruptedProductSshRead(row(), {
            ...value,
            outcome: { ...value.outcome!, exitCode: 1 },
        }),
    );
});
