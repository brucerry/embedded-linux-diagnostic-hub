import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayClient } from '../src/services/GatewayClient';
import { terminalEvent, TERMINAL_CHUNK_BYTES, type TerminalEvent } from '../shared/terminal';

const id = 'terminal-consumption-0001';
const event = (bytes: Uint8Array, sequence: number): TerminalEvent => ({
    id,
    type: 'data',
    sequence,
    data: Buffer.from(bytes).toString('base64'),
});

async function consume(events: TerminalEvent[], onData?: () => Promise<void>) {
    const originalFetch = globalThis.fetch;
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
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
    globalThis.fetch = async (url) => {
        if (String(url).endsWith('/api/health')) return json({ connectionCancellation: true });
        if (String(url).endsWith('/api/sessions')) return json({ sessionId: 'a'.repeat(32) });
        if (String(url).endsWith('/terminal'))
            return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
        return json({});
    };
    const gateway = new GatewayClient({ url: 'http://127.0.0.1:1234', token: 'x'.repeat(32) });
    const received: TerminalEvent[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
        finish = resolve;
    });
    gateway.onTerminalEvent(async (value) => {
        received.push(terminalEvent(value));
        if (value.type === 'data') await onData?.();
        if (value.type === 'state' && value.state === 'closed') finish();
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
        await gateway.disconnect();
        globalThis.fetch = originalFetch;
        if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
        else Reflect.deleteProperty(globalThis, 'location');
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else Reflect.deleteProperty(globalThis, 'window');
    }
}

test('already-received gateway byte frames share one awaited consumer turn without losing split UTF-8 or ANSI', async () => {
    const bytes = Buffer.from('/tmp $ unicode\r\n\x1b[32m裝置✓\x1b[0m\r\n/tmp $ ');
    let turns = 0;
    let consumerFinished = false;
    const received = await consume(
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

test('gateway output batches retain byte bounds and state ordering', async () => {
    const a = Buffer.alloc(TERMINAL_CHUNK_BYTES - 1, 65);
    const b = Buffer.from('BC');
    const received = await consume([
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
