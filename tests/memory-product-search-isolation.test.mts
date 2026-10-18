/** Reviewer controls: actual synthetic producer and production matcher, no browser/native workload. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { installProductSerial } from './fixtures/memory-product-serial';
import { serialExpectation } from './fixtures/memory-product-aggregate-contract';
import { matchesCapture, capturePreview } from '../shared/capture-query';
import {
    appendFrames,
    newCapture,
    frameCrc,
    type CaptureRepository,
} from '../shared/capture-store';

const query = 'native-aggregate-200000';
const settings = {
    baudRate: 115200,
    dataBits: 8 as const,
    parity: 'none' as const,
    stopBits: 1 as const,
    flowControl: 'none' as const,
    bufferSize: 16384,
};
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function producer(t: { after(fn: () => void): void }) {
    const before = Object.getOwnPropertyDescriptor(navigator, 'serial');
    t.after(() => {
        if (before) Object.defineProperty(navigator, 'serial', before);
        else delete (navigator as any).serial;
    });
    const api = installProductSerial();
    api.configure({ bytes: 65536, tail: query, delayMs: 0 });
    await api.port.open(settings);
    const reader = api.port.readable!.getReader(),
        writer = api.port.writable!.getWriter();
    return {
        api,
        async response() {
            await writer.write(new TextEncoder().encode('unrelated-command\n'));
            const buffers: Uint8Array[] = [];
            do {
                const r = await reader.read();
                assert.equal(r.done, false);
                buffers.push(r.value!);
                await new Promise<void>((resolve) => setImmediate(resolve));
            } while (
                api.snapshot().remaining ||
                api.snapshot().promptPending ||
                api.snapshot().pumping
            );
            return Buffer.concat(buffers);
        },
        async close() {
            await reader.cancel();
            reader.releaseLock();
            writer.releaseLock();
            await api.port.close();
            const s = api.snapshot();
            assert.equal(s.opens, s.closes);
            for (const key of [
                'readerActive',
                'writerActive',
                'pumping',
                'remaining',
                'promptPending',
            ] as const)
                assert.ok(!s[key]);
        },
    };
}
function stored(bytes: Uint8Array, state: 'complete' | 'incomplete') {
    const at = '2026-10-18T00:00:00.000Z';
    const frames = Array.from({ length: Math.ceil(bytes.length / 16384) }, (_, index) => {
        const offset = index * 16384,
            piece = bytes.subarray(offset, offset + 16384);
        return {
            observation: 0,
            receivedAt: at,
            stream: 'serial' as const,
            offset,
            totalBytes: bytes.length,
            bytes: piece,
            crc32: frameCrc(piece),
        };
    });
    const capture = {
        ...appendFrames(
            newCapture('12345678-1234-4123-8123-123456789abc', 1, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'control',
                stepId: 'control',
                command: 'fault-only-command',
                name: 'Fault control',
                startedAt: at,
            }),
            frames,
        ),
        state,
    };
    const store = {
        async *read() {
            yield { type: 'metadata', capture };
            for (const frame of frames) yield { type: 'frame', frame };
        },
    } as unknown as CaptureRepository;
    return { capture, store };
}
test('unchanged configuration leaks the primary output token into the next 32768-byte response', async (t) => {
    const p = await producer(t);
    try {
        for (const bytes of [65536, 64, 32768]) {
            p.api.configure({ bytes, delayMs: 0 });
            const actual = await p.response();
            assert.equal(actual.length, serialExpectation(bytes, query).bytes);
            assert.equal(digest(actual), serialExpectation(bytes, query).sha256);
            assert.ok(actual.toString().includes(query));
        }
    } finally {
        await p.close();
    }
});
test('the production matcher correctly includes full-output matches in complete and incomplete captures', async (t) => {
    const p = await producer(t);
    try {
        p.api.configure({ bytes: 32768, delayMs: 0 });
        const bytes = await p.response();
        assert.ok(bytes.indexOf(query) > 8192);
        for (const state of ['complete', 'incomplete'] as const) {
            const { capture, store } = stored(bytes, state);
            assert.ok(!JSON.stringify(capture.header).includes(query));
            assert.equal(
                await matchesCapture(store, capture, { filter: { transport: 'serial', query } }),
                true,
            );
            assert.ok(!(await capturePreview(store, capture)).stdout.includes(query));
        }
    } finally {
        await p.close();
    }
});
test('clearing the tail at fault entry preserves both primaries and excludes subsequent fault-output matches', async (t) => {
    const p = await producer(t);
    try {
        for (const bytes of [65536, 64]) {
            p.api.configure({ bytes, delayMs: 0 });
            assert.equal(digest(await p.response()), serialExpectation(bytes, query).sha256);
        }
        // The proposed helper transition; each fault configuration still changes bytes/delay only.
        p.api.configure({ tail: '' });
        for (let i = 0; i < 6; i++) {
            p.api.configure({ bytes: 32768, delayMs: 0 });
            const actual = await p.response();
            assert.equal(digest(actual), serialExpectation(32768, '').sha256);
            const { capture, store } = stored(actual, i % 2 ? 'incomplete' : 'complete');
            assert.equal(
                await matchesCapture(store, capture, { filter: { transport: 'serial', query } }),
                false,
            );
        }
    } finally {
        await p.close();
    }
});
