import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayClient } from '../src/services/GatewayClient';
import { parseDeviceClock } from '../shared/diagnostics/device-clock';
import { clockOutput } from './fixtures/device-clock';
import { demoSnapshot } from './fixtures/snapshots';

test('gateway clock incompatibility and malformed samples preserve a session; expiry still disconnects', async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    const originalLocation = globalThis.location;
    globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
    globalThis.location = { protocol: 'http:' } as Location;
    let clockStatus = 404;
    let heartbeatStatus = 200;
    let malformed = false;
    let heartbeat: (() => void) | undefined;
    const originalInterval = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    globalThis.setInterval = ((callback: () => void) => {
        heartbeat = callback;
        return 1;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    let disconnected = 0;
    const client = new GatewayClient({ url: 'http://127.0.0.1:9000', token: 'x'.repeat(32) });
    client.onDisconnected(() => disconnected++);
    globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.endsWith('/clock'))
            return Response.json(
                clockStatus === 200
                    ? malformed
                        ? { status: 'available', sample: {} }
                        : { status: 'available', sample: parseDeviceClock(clockOutput()) }
                    : { error: 'Unknown gateway route.' },
                { status: clockStatus },
            );
        if (url.endsWith('/heartbeat'))
            return Response.json({ connected: true }, { status: heartbeatStatus });
        if (url.endsWith('/snapshot')) return Response.json(demoSnapshot());
        return Response.json({ sessionId: 'a'.repeat(32) });
    };
    try {
        await client.connect({ host: 'device', port: 22, username: 'engineer', auth: 'password' });
        assert.deepEqual(await client.readDeviceClock(), {
            status: 'unavailable',
            reason: 'unsupported',
        });
        assert.equal(disconnected, 0);
        assert.equal((await client.collect()).results.length, 36);
        clockStatus = 200;
        malformed = true;
        await assert.rejects(client.readDeviceClock(), /Invalid device clock/);
        assert.equal(disconnected, 0);
        malformed = false;
        assert.equal((await client.readDeviceClock()).status, 'available');
        heartbeatStatus = 404;
        heartbeat!();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(disconnected, 1);
        await assert.rejects(client.readDeviceClock(), /Connect through/);
    } finally {
        await client.disconnect();
        globalThis.fetch = originalFetch;
        globalThis.window = originalWindow;
        globalThis.location = originalLocation;
        globalThis.setInterval = originalInterval;
        globalThis.clearInterval = originalClear;
    }
});
