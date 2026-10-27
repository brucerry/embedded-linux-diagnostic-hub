import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertSerialLifecycleRead,
    assertSerialLifecycleClosed,
} from './memory-product-serial-lifecycle';
const row = () => ({
    id: 'capture',
    command: 'test',
    state: 'complete',
    committedBytes: 32,
    observedBytes: 32,
});
const read = () => ({
    bytes: 32,
    frames: 1,
    crcAndBoundariesVerified: true,
    streamBytes: { serial: 32, stdout: 0, stderr: 0 },
    outcome: { completion: 'prompt-observed', exitCode: null as number | null },
});
test('Serial lifecycle raw receipt rejects active, unverified and cross-transport evidence', () => {
    assert.equal(assertSerialLifecycleRead(row(), read(), 'prompt-observed').bytes, 32);
    assert.throws(() =>
        assertSerialLifecycleRead({ ...row(), state: 'active' }, read(), 'prompt-observed'),
    );
    assert.throws(() =>
        assertSerialLifecycleRead(
            row(),
            { ...read(), crcAndBoundariesVerified: false },
            'prompt-observed',
        ),
    );
    assert.throws(() =>
        assertSerialLifecycleRead(
            row(),
            { ...read(), streamBytes: { serial: 31, stdout: 1, stderr: 0 } },
            'prompt-observed',
        ),
    );
    assert.throws(() =>
        assertSerialLifecycleRead(
            { ...row(), state: 'incomplete', observedBytes: null },
            read(),
            'prompt-observed',
        ),
    );
});
test('Serial interruption receipts require exact actual completion and no invented exit status', () => {
    const timeout = { ...read(), outcome: { completion: 'timeout', exitCode: null } };
    assertSerialLifecycleRead(row(), timeout, 'timeout');
    assert.throws(() => assertSerialLifecycleRead(row(), read(), 'timeout'));
    assert.throws(() =>
        assertSerialLifecycleRead(
            row(),
            { ...timeout, outcome: { completion: 'timeout', exitCode: 0 } },
            'timeout',
        ),
    );
    assert.throws(() => assertSerialLifecycleRead(row(), { ...timeout, outcome: null }, 'timeout'));
});

test('selected status cannot hide a held write, unjoined pump or missing close acknowledgment', () => {
    const value = {
        opens: 1,
        closes: 1,
        sent: 1,
        produced: 0,
        readerActive: false,
        writerActive: false,
        pumping: false,
        remaining: 0,
        promptPending: false,
        heldOpen: false,
        heldWrite: false,
        events: [],
    };
    assertSerialLifecycleClosed(value, { isOwned: false });
    assert.throws(() => assertSerialLifecycleClosed(value, { isOwned: true }));
    for (const changed of [
        { closes: 0 },
        { heldWrite: true },
        { writerActive: true },
        { readerActive: true },
        { pumping: true },
        { remaining: 1 },
        { promptPending: true },
    ])
        assert.throws(() =>
            assertSerialLifecycleClosed({ ...value, ...changed }, { isOwned: false }),
        );
});
