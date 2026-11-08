import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { GatewayClient } from '../src/services/GatewayClient';
import { ConnectionFailure } from '../shared/connection';
import { terminalEvent, TERMINAL_CHUNK_BYTES, type TerminalEvent } from '../shared/terminal';

const id = 'terminal-consumption-0001';
const event = (bytes: Uint8Array, sequence: number): TerminalEvent => ({
    id,
    type: 'data',
    sequence,
    data: Buffer.from(bytes).toString('base64'),
});

async function consume(
    t: TestContext,
    events: TerminalEvent[],
    onData?: () => Promise<void>,
    rejectDisconnect = false,
) {
    const originalFetch = globalThis.fetch;
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    let gateway: GatewayClient | undefined;
    let closing: Promise<void> | undefined;
    let cleanupFromBody = false;
    const cleanup = () =>
        (closing ??= (async () => {
            try {
                await gateway?.disconnect();
            } finally {
                globalThis.fetch = originalFetch;
                if (originalLocation)
                    Object.defineProperty(globalThis, 'location', originalLocation);
                else Reflect.deleteProperty(globalThis, 'location');
                if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
                else Reflect.deleteProperty(globalThis, 'window');
            }
        })());
    // Also owns setup failure or a cancelled body that never reaches its finally.
    t.after(async () => {
        if (!cleanupFromBody) await cleanup();
    });

    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { protocol: 'http:' },
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    const encode = (items: TerminalEvent[]) =>
        new TextEncoder().encode(items.map((item) => JSON.stringify(item) + '\n').join(''));
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encode([{ id, type: 'state', state: 'open' }]));
            controller.enqueue(encode(events));
            controller.enqueue(encode([{ id, type: 'state', state: 'closed' }]));
            controller.close();
        },
    });
    const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (url, init) => {
        if (rejectDisconnect && init?.method === 'DELETE')
            throw Error('Synthetic disconnect failure.');
        if (String(url).endsWith('/api/health')) return json({ connectionCancellation: true });
        if (String(url).endsWith('/api/sessions')) return json({ sessionId: 'a'.repeat(32) });
        if (String(url).endsWith('/terminal'))
            return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
        return json({});
    };
    gateway = new GatewayClient({ url: 'http://127.0.0.1:1234', token: 'x'.repeat(32) });
    const received: TerminalEvent[] = [];
    let finish!: () => void, fail!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
    });
    void completed.catch(() => {});
    gateway.onTerminalEvent(async (value) => {
        received.push(terminalEvent(value));
        if (value.type === 'data') await onData?.();
        if (value.type === 'state' && value.state === 'closed') finish();
        if (value.type === 'state' && value.state === 'error')
            fail(Error(value.message ?? 'Terminal consumer failed.'));
    });
    try {
        await gateway.connect(
            {
                host: 'fixture',
                port: 22,
                username: 'engineer',
                auth: 'password',
                expectedFingerprint: 'pinned',
            },
            '1'.repeat(32),
        );
        await gateway.openTerminal({ id, cols: 80, rows: 24 });
        await completed;
        return received;
    } finally {
        cleanupFromBody = true;
        await cleanup();
    }
}

test('already-received gateway byte frames share one awaited consumer turn without losing split UTF-8 or ANSI', async (t) => {
    const bytes = Buffer.from('/tmp $ unicode\r\n\x1b[32m裝置✓\x1b[0m\r\n/tmp $ ');
    let turns = 0;
    let consumerFinished = false;
    const received = await consume(
        t,
        [...bytes].map((byte, index) => event(Uint8Array.of(byte), index + 1)),
        async () => {
            turns++;
            await new Promise<void>((resolve) => setImmediate(resolve));
            consumerFinished = true;
        },
    );
    const data = received.filter((value) => value.type === 'data');
    assert.deepEqual(Buffer.concat(data.map((value) => Buffer.from(value.data, 'base64'))), bytes);
    assert.equal(
        turns,
        1,
        'one awaited consumer callback must cover byte frames already in one HTTP read',
    );
    assert.equal(data[0].sequence, bytes.length);
    assert.equal(consumerFinished, true, 'the next stream state must await byte consumption');
});

test('gateway output batches retain byte bounds and state ordering', async (t) => {
    const a = Buffer.alloc(TERMINAL_CHUNK_BYTES - 1, 65);
    const b = Buffer.from('BC');
    const received = await consume(t, [
        event(a, 1),
        event(b, 2),
        { id, type: 'state', state: 'opening' },
        event(Buffer.from('D'), 3),
    ]);
    assert.deepEqual(
        received.map((value) =>
            value.type === 'data' ? Buffer.from(value.data, 'base64').length : value.state,
        ),
        ['open', a.length, 2, 'opening', 1, 'closed'],
    );
    assert(
        received
            .filter((value) => value.type === 'data')
            .every((value) => Buffer.from(value.data, 'base64').length <= TERMINAL_CHUNK_BYTES),
    );
});

test('terminal consumer failure settles the fixture and restores its globals', async (t) => {
    const fetch = globalThis.fetch;
    const window = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    await assert.rejects(
        consume(t, [event(Uint8Array.of(65), 1)], async () => {
            throw Error('Synthetic consumer failure.');
        }),
        /Synthetic consumer failure/,
    );
    assert.equal(globalThis.fetch, fetch);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'window'), window);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'location'), location);
});

test('disconnect rejection remains a failure while restoring the fixture globals', async (t) => {
    const fetch = globalThis.fetch;
    const window = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    await assert.rejects(consume(t, [], undefined, true), (error: unknown) => {
        assert.ok(error instanceof ConnectionFailure);
        assert.equal(error.code, 'network');
        assert.equal(
            error.message,
            'Cannot reach the gateway. Check its HTTPS address, allowed website origin and network access.',
        );
        return true;
    });
    assert.equal(globalThis.fetch, fetch);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'window'), window);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'location'), location);
});
