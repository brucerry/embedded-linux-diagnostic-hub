import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayClient } from '../src/services/GatewayClient';
import { simulatedInventory, sampleProfile } from '../shared/testing/simulation';
import { demoSnapshot } from './fixtures/snapshots';

test('gateway testing detects older routes, bounded malformed responses and changed session ownership', async () => {
    const original = {
        fetch: globalThis.fetch,
        window: globalThis.window,
        location: globalThis.location,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
    };
    globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
    globalThis.location = { protocol: 'http:' } as Location;
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    let state = 'old',
        release: ((value: Response) => void) | undefined,
        disconnected = 0;
    const client = new GatewayClient({ url: 'http://127.0.0.1:9000', token: 'x'.repeat(32) });
    client.onDisconnected(() => disconnected++);
    globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes('/tests/')) {
            if (state === 'old')
                return Response.json({ error: 'Unknown gateway route.' }, { status: 404 });
            if (state === 'large') return new Response(' '.repeat(16 * 1024 * 1024 + 1));
            if (state === 'late') return new Promise<Response>((r) => (release = r));
            return Response.json({ command: 'evil' });
        }
        if (url.endsWith('/snapshot')) return Response.json(demoSnapshot());
        if (url.endsWith('/heartbeat')) return Response.json({ connected: true });
        return Response.json({ sessionId: 'a'.repeat(32) });
    };
    try {
        await client.connect({ host: 'fixture', port: 22, username: 'engineer', auth: 'password' });
        await assert.rejects(client.discoverTests(), /support|update|unavailable/i);
        assert.equal(disconnected, 0);
        assert.equal((await client.collect()).results.length, 36);
        state = 'invalid';
        await assert.rejects(client.discoverTests(), /unsupported field/);
        state = 'large';
        await assert.rejects(client.discoverTests(), /invalid response|limit/i);
        state = 'late';
        const pending = client.discoverTests();
        await new Promise((r) => setImmediate(r));
        await client.disconnect();
        release!(Response.json(simulatedInventory()));
        await assert.rejects(pending, /changed|Connect/i);
        await assert.rejects(client.prepareTests(sampleProfile()), /Connect/);
    } finally {
        await client.disconnect();
        Object.assign(globalThis, original);
    }
});
