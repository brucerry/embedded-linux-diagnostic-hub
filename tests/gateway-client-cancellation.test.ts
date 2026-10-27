import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayClient } from '../src/services/GatewayClient';
import { ConnectionFailure } from '../shared/connection';

const options = {
    host: 'fixture',
    port: 22,
    username: 'engineer',
    auth: 'password' as const,
    password: 'never-log-this',
    expectedFingerprint: 'pinned',
};
function environment(request: typeof fetch) {
    const previousFetch = globalThis.fetch;
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const window = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { protocol: 'http:' },
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    globalThis.fetch = request;
    return () => {
        globalThis.fetch = previousFetch;
        if (location) Object.defineProperty(globalThis, 'location', location);
        else Reflect.deleteProperty(globalThis, 'location');
        if (window) Object.defineProperty(globalThis, 'window', window);
        else Reflect.deleteProperty(globalThis, 'window');
    };
}
const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
const client = () => new GatewayClient({ url: 'http://127.0.0.1:1234', token: 'x'.repeat(32) });

test('an older gateway pauses before SSH session POST when cancellation capability is absent', async () => {
    const urls: string[] = [];
    const restore = environment(async (url) => {
        urls.push(String(url));
        return response({ version: 'old' });
    });
    try {
        const gateway = client();
        await assert.rejects(
            gateway.connect(options, '1'.repeat(32)),
            (error: unknown) => error instanceof ConnectionFailure && error.code === 'policy',
        );
        await gateway.cancelConnect('1'.repeat(32));
        assert.equal(urls.length, 1);
        assert.ok(urls[0].endsWith('/api/health'));
    } finally {
        restore();
    }
});

test('gateway Cancel after session creation uses the owned ID and rejects a late response', async () => {
    let late!: (value: Response) => void;
    let posted!: () => void;
    const reached = new Promise<void>((resolve) => {
        posted = resolve;
    });
    let cancelledId = '';
    const restore = environment(async (url, init) => {
        if (String(url).endsWith('/api/health')) return response({ connectionCancellation: true });
        if (String(url).endsWith('/api/connection-attempts/cancel')) {
            cancelledId = JSON.parse(String(init?.body)).attemptId;
            return response({ cancelled: true });
        }
        posted();
        return new Promise<Response>((resolve) => {
            late = resolve;
        });
    });
    try {
        const gateway = client();
        const id = '2'.repeat(32);
        const work = gateway.connect(options, id);
        const rejected = assert.rejects(
            work,
            (error: unknown) => error instanceof ConnectionFailure && error.code === 'cancelled',
        );
        await reached;
        await gateway.cancelConnect(id);
        late(response({ sessionId: 'a'.repeat(32) }, 201));
        await rejected;
        assert.equal(cancelledId, id);
        await assert.rejects(gateway.collect(), /Connect through a gateway first/);
    } finally {
        restore();
    }
});

test('page exit aborts a pending gateway attempt and sends authenticated best-effort cleanup', async () => {
    let late!: (value: Response) => void;
    let posted!: () => void;
    const reached = new Promise<void>((resolve) => {
        posted = resolve;
    });
    let cancelled = false;
    const restore = environment(async (url, init) => {
        if (String(url).endsWith('/api/health')) return response({ connectionCancellation: true });
        if (String(url).endsWith('/api/connection-attempts/cancel')) {
            assert.equal(init?.keepalive, true);
            assert.equal(
                new Headers(init?.headers).get('Authorization'),
                'Bearer ' + 'x'.repeat(32),
            );
            cancelled = true;
            return response({ cancelled: true });
        }
        posted();
        return new Promise<Response>((resolve) => {
            late = resolve;
        });
    });
    try {
        const gateway = client();
        const pending = gateway.connect(options, '4'.repeat(32));
        const rejected = assert.rejects(
            pending,
            (error: unknown) => error instanceof ConnectionFailure && error.code === 'cancelled',
        );
        await reached;
        window.dispatchEvent(new Event('pagehide'));
        late(response({ sessionId: 'a'.repeat(32) }, 201));
        await rejected;
        assert.equal(cancelled, true);
        await assert.rejects(gateway.collect(), /Connect through a gateway first/);
    } finally {
        restore();
    }
});

test('gateway permanent authentication errors do not surface arbitrary server text or credentials', async () => {
    const restore = environment(async (url) =>
        String(url).endsWith('/api/health')
            ? response({ connectionCancellation: true })
            : response({ code: 'authentication', error: 'server echoed never-log-this' }, 502),
    );
    try {
        const gateway = client();
        await assert.rejects(
            gateway.connect(options, '3'.repeat(32)),
            (error: unknown) =>
                error instanceof ConnectionFailure &&
                error.code === 'authentication' &&
                !error.message.includes('never-log-this'),
        );
    } finally {
        restore();
    }
});
