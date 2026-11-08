import assert from 'node:assert/strict';
import test from 'node:test';
import {
    encodeReorderDiagnostic,
    emitReorderDiagnostic,
    REORDER_DIAGNOSTIC_BYTES,
} from './ui/fixtures/reorder-diagnostic-format';
import type { ReorderObserver } from './ui/fixtures/reorder-diagnostic';

const id = '11111111-1111-4111-8111-111111111111';
const sdk = {
    status: 'available',
    version: '1.63.0',
    packageSha256: 'a'.repeat(64),
    coreSha256: 'b'.repeat(64),
    coreBytes: 15_368_192,
};
const rect = { x: -100, y: 200, width: 123456.125, height: 654321.125 };
const state = {
    view: [0, 200, 1440, 1050],
    rows: Array.from({ length: 3 }, () => ({ id, draggable: true, placeholder: false, rect })),
    source: rect,
    target: rect,
    notice: 'cancelled',
    hidden: false,
    running: false,
    dialogs: 0,
};
const event = {
    type: 'dragover',
    phase: 'bubble',
    ms: 10,
    trusted: true,
    prevented: true,
    x: 22,
    y: 33,
    button: 0,
    buttons: 1,
    target: { tag: 'TEXTAREA', role: 'textbox', row: id },
    hit: { tag: 'LI', role: '', row: id },
    transfer: { types: ['text/plain'], allowed: 'move', drop: 'move' },
    state,
};

test('diagnostic whitelists structural fields and retains exact SDK hash/size without content', () => {
    const secret = 'DO_NOT_RETAIN_SECRET';
    const input = {
        status: 'active',
        data: {
            events: [
                {
                    ...event,
                    command: secret,
                    transfer: { types: [secret], allowed: secret, payload: secret },
                    target: { tag: secret, role: secret, row: secret },
                    x: Infinity,
                    y: NaN,
                    state: { ...state, notice: secret, source: { ...rect, x: 1e20 } },
                },
            ],
            counts: { 'dragover:bubble': 1 },
            snapshots: [{ stage: 'final', state }],
            secret,
        },
        secret,
    };
    const encoded = encodeReorderDiagnostic(input, { ...sdk, secret });
    assert.equal(encoded.includes(secret), false);
    const parsed = JSON.parse(encoded);
    assert.equal(parsed.sdk.coreBytes, sdk.coreBytes);
    assert.equal(parsed.sdk.coreSha256, sdk.coreSha256);
    assert.equal(parsed.events[0].target.row, null);
    assert.equal(parsed.events[0].state.notice, 'other');
    assert.equal(parsed.events[0].state.source[0], null);
    assert.equal(parsed.events[0].x, null);
    assert.equal(parsed.events[0].y, null);
    assert.equal(parsed.snapshots[0].state.rows[0].id, id);
});

test('diagnostic deterministic byte cap retains initial and recent events plus final snapshot', () => {
    const input = {
        status: 'active',
        data: {
            events: Array.from({ length: 64 }, (_, ms) => ({ ...event, ms })),
            snapshots: ['before', 'after-gesture', 'final'].map((stage) => ({ stage, state })),
            overflow: true,
        },
    };
    const encoded = encodeReorderDiagnostic(input, sdk);
    assert.equal(encoded, encodeReorderDiagnostic(input, sdk));
    assert.ok(new TextEncoder().encode(encoded).length <= REORDER_DIAGNOSTIC_BYTES);
    const parsed = JSON.parse(encoded);
    assert.ok(parsed.droppedAtSerialization > 0);
    assert.equal(parsed.overflow, true);
    assert.equal(parsed.events[0].ms, 0);
    assert.equal(parsed.events.at(-1).ms, 63);
    assert.equal(parsed.snapshots.at(-1).stage, 'final');
});

test('diagnostic ignores accessors and cycles; reflection failure produces a bounded fixed marker', () => {
    const cycle: Record<string, unknown> = { status: 'active' };
    cycle.self = cycle;
    Object.defineProperty(cycle, 'data', {
        get() {
            assert.fail('Accessor must not run');
        },
    });
    assert.doesNotThrow(() => JSON.parse(encodeReorderDiagnostic(cycle, sdk)));
    const hostile = new Proxy(
        {},
        {
            getOwnPropertyDescriptor() {
                throw Error('private content');
            },
        },
    );
    const encoded = encodeReorderDiagnostic(hostile, sdk);
    assert.equal(JSON.parse(encoded).status, 'serialization-failed');
    assert.equal(encoded.includes('private content'), false);
});

test('diagnostic emits once on success and retains collection/disposal failure without throwing', async () => {
    for (const failed of [false, true]) {
        let disposed = 0;
        const lines: string[] = [];
        const observer = {
            status: 'active',
            markFailed: false,
            handle: {
                evaluate: async () => {
                    if (failed) throw Error('private error');
                    return { events: [event], snapshots: [] };
                },
                dispose: async () => {
                    disposed++;
                    if (failed) throw Error('private dispose');
                },
            },
        } as unknown as ReorderObserver;
        await emitReorderDiagnostic(observer, sdk, (line) => lines.push(line));
        assert.equal(disposed, 1);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].includes('private'), false);
        assert.equal(JSON.parse(lines[0]).status, failed ? 'collect-failed' : 'active');
        assert.equal(JSON.parse(lines[0]).disposeFailed, failed);
    }
});

test('diagnostic failure cannot mask the original behavioral error in finally', async () => {
    const primary = Error('original behavioral assertion');
    const observer: ReorderObserver = { handle: null, status: 'not-started', markFailed: false };
    await assert.rejects(
        async () => {
            try {
                throw primary;
            } finally {
                await emitReorderDiagnostic(observer, sdk, () => {
                    throw Error('output failure');
                });
            }
        },
        (error) => error === primary,
    );
});
