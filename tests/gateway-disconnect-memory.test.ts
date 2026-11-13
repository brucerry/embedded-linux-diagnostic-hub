import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { GatewayClient } from '../src/services/GatewayClient';
import { ConnectionFailure } from '../shared/connection';
import type { ConnectOptions } from '../shared/types';

// These are client/callback controls only: no Gateway, SSH, real clock or network.
const A = 'a'.repeat(32),
    B = 'b'.repeat(32);
const options = (): ConnectOptions => ({
    host: 'memory.invalid',
    port: 22,
    username: 'memory',
    auth: 'password',
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const turn = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

async function memory(run: (ports: ReturnType<typeof memoryPorts>) => Promise<void>) {
    const ports = memoryPorts();
    try {
        await run(ports);
    } finally {
        await ports.restore();
    }
}

function memoryPorts() {
    const restores: (() => void)[] = [],
        timers = new Map<number, () => void>();
    const intervals = new Map<number, () => void>(),
        pageListeners = new Set<EventListenerOrEventListenerObject>();
    const requests: { route: string; method: string; keepalive: boolean }[] = [];
    const tasks: Promise<unknown>[] = [],
        releases: (() => void)[] = [];
    let nextTimer = 0,
        nextSession = 0;
    let deletion: (route: string) => Response | Promise<Response> = () =>
        json({ disconnected: true });
    function replace(target: object, name: PropertyKey, value: unknown) {
        const original = Object.getOwnPropertyDescriptor(target, name);
        Object.defineProperty(target, name, { configurable: true, writable: true, value });
        restores.push(() =>
            original
                ? Object.defineProperty(target, name, original)
                : Reflect.deleteProperty(target, name),
        );
    }
    class Page extends EventTarget {
        override addEventListener(
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            settings?: AddEventListenerOptions | boolean,
        ) {
            if (type === 'pagehide' && callback) pageListeners.add(callback);
            super.addEventListener(type, callback, settings);
        }
        override removeEventListener(
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            settings?: EventListenerOptions | boolean,
        ) {
            if (type === 'pagehide' && callback) pageListeners.delete(callback);
            super.removeEventListener(type, callback, settings);
        }
    }
    const page = new Page();
    replace(globalThis, 'window', page);
    replace(globalThis, 'location', { protocol: 'http:' });
    replace(globalThis, 'setInterval', (callback: () => void) => {
        const id = ++nextTimer;
        intervals.set(id, callback);
        return id;
    });
    replace(globalThis, 'clearInterval', (id: number) => intervals.delete(id));
    replace(globalThis, 'setTimeout', (callback: () => void) => {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id;
    });
    replace(globalThis, 'clearTimeout', (id: number) => timers.delete(id));
    // Native AbortSignal.timeout creates an actual timer even when fetch is replaced.
    replace(AbortSignal, 'timeout', () => new AbortController().signal);
    replace(AbortSignal, 'any', (signals: AbortSignal[]) => {
        const owner = new AbortController();
        for (const signal of signals) {
            if (signal.aborted) owner.abort(signal.reason);
            else signal.addEventListener('abort', () => owner.abort(signal.reason), { once: true });
        }
        return owner.signal;
    });
    replace(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
        const route = new URL(String(input)).pathname,
            method = init?.method ?? 'GET';
        requests.push({ route, method, keepalive: init?.keepalive === true });
        if (method === 'DELETE') return Promise.resolve(deletion(route));
        if (route === '/api/health') return Promise.resolve(json({ connectionCancellation: true }));
        if (route === '/api/sessions' && method === 'POST')
            return Promise.resolve(json({ sessionId: ++nextSession === 1 ? A : B }));
        if (route.endsWith('/heartbeat')) return Promise.resolve(json({ connected: true }));
        if (route === '/api/connection-attempts/cancel')
            return Promise.resolve(json({ cancelled: true }));
        throw Error('Unexpected memory route: ' + route);
    });
    return {
        requests,
        intervals,
        timers,
        pageListeners,
        page,
        client: () =>
            new GatewayClient({
                url: 'http://localhost:1',
                token: 'test-only-memory-token-'.repeat(2),
            }),
        deletion(value: typeof deletion) {
            deletion = value;
        },
        deferred() {
            let settle!: (value: Response) => void;
            const promise = new Promise<Response>((resolve) => {
                settle = resolve;
            });
            releases.push(() => settle(json({ disconnected: true })));
            return { promise, resolve: settle };
        },
        watch<T>(task: Promise<T>): Promise<T> {
            tasks.push(task);
            void task.catch(() => {});
            return task;
        },
        deletes: () => requests.filter((entry) => entry.method === 'DELETE').length,
        async restore() {
            // Settle only model responses before restoring the clock/fetch globals.
            releases.forEach((release) => release());
            await Promise.allSettled(tasks);
            await turn();
            restores.reverse().forEach((restore) => restore());
        },
    };
}

function cleanup(error: unknown) {
    return error instanceof ConnectionFailure && error.code === 'cleanup';
}
function lifecycle(client: GatewayClient) {
    const clock = new AbortController(),
        terminal = new AbortController();
    Object.assign(client, { clockAbort: clock, terminalAbort: terminal });
    return { clock, terminal };
}

test(
    'Gateway DELETE refusal retains ownership, lifecycle and explicit later retry',
    { concurrency: false },
    async () =>
        memory(async (p) => {
            const client = p.client();
            await client.connect(options(), '1'.repeat(32));
            const { clock, terminal } = lifecycle(client);
            let notifications = 0;
            client.onDisconnected(() => notifications++);
            p.deletion(() => json({ error: 'busy' }, 409));
            await assert.rejects(p.watch(client.disconnect()));
            assert.equal(client.automationConnection(), A);
            assert.equal(p.intervals.size, 1);
            assert.equal(p.pageListeners.size, 1);
            assert.equal(clock.signal.aborted, false);
            assert.equal(terminal.signal.aborted, false);
            for (const callback of p.intervals.values()) callback();
            await turn();
            assert.equal(
                p.requests.filter((entry) => entry.route.endsWith('/heartbeat')).length,
                1,
            );
            const count = p.requests.length;
            await assert.rejects(p.watch(client.connect(options(), '2'.repeat(32))), cleanup);
            assert.equal(
                p.requests.length,
                count,
                'replacement must not retry DELETE or open another session',
            );
            p.deletion(() => json({ disconnected: true }));
            await p.watch(client.disconnect());
            assert.equal(
                p.deletes(),
                2,
                'a separate explicit user action can retry a known refusal',
            );
            assert.equal(client.automationConnection(), '');
            assert.equal(p.intervals.size, 0);
            assert.equal(p.pageListeners.size, 0);
            assert.equal(clock.signal.aborted, true);
            assert.equal(terminal.signal.aborted, true);
            assert.equal(
                notifications,
                0,
                'intentional success does not emit unexpected-loss notification',
            );
        }),
);

test(
    'Gateway ambiguous and invalid acknowledgements retain owner without automatic replacement',
    { concurrency: false },
    async () => {
        for (const response of [
            () => {
                throw undefined;
            },
            () => new Response('{', { status: 200 }),
            () => json(null),
            () => json({}),
            () => json({ disconnected: false }),
        ])
            await memory(async (p) => {
                const client = p.client();
                await client.connect(options(), '1'.repeat(32));
                const { clock, terminal } = lifecycle(client);
                p.deletion(response);
                await assert.rejects(p.watch(client.disconnect()));
                assert.equal(client.automationConnection(), A);
                assert.equal(p.intervals.size, 1);
                assert.equal(p.pageListeners.size, 1);
                assert.equal(clock.signal.aborted || terminal.signal.aborted, false);
                await assert.rejects(p.watch(client.connect(options(), '2'.repeat(32))), cleanup);
                assert.equal(p.deletes(), 1);
                assert.equal(
                    p.requests.filter((entry) => entry.route === '/api/sessions').length,
                    1,
                );
            });
    },
);

test(
    'Gateway publishes pending DELETE before reentry and shares it with reconnect',
    { concurrency: false },
    async () =>
        memory(async (p) => {
            const client = p.client(),
                response = p.deferred();
            await client.connect(options(), '1'.repeat(32));
            const { clock } = lifecycle(client);
            let reentrant: Promise<void> | undefined;
            p.deletion(() => {
                reentrant = client.disconnect();
                return response.promise;
            });
            const closing = p.watch(client.disconnect());
            assert.equal(client.disconnect(), closing);
            const reconnect = p.watch(client.connect(options(), '2'.repeat(32)));
            await turn();
            assert.equal(reentrant, closing);
            assert.equal(p.deletes(), 1);
            assert.equal(client.automationConnection(), A);
            assert.equal(clock.signal.aborted, false);
            assert.equal(p.requests.filter((entry) => entry.route === '/api/sessions').length, 1);
            response.resolve(json({ disconnected: true }));
            await closing;
            await reconnect;
            assert.equal(client.automationConnection(), B);
            assert.equal(p.intervals.size, 1);
            assert.equal(p.pageListeners.size, 1);
            assert.equal(clock.signal.aborted, true);
        }),
);

test(
    'Gateway first ambiguous release fails reconnect as cleanup with no repeated ownership effect',
    { concurrency: false },
    async () =>
        memory(async (p) => {
            const client = p.client(),
                response = p.deferred();
            await client.connect(options(), '1'.repeat(32));
            p.deletion(() => response.promise);
            const reconnect = p.watch(client.connect(options(), '2'.repeat(32)));
            await turn();
            const shared = p.watch(client.disconnect());
            response.resolve(json({ error: 'busy' }, 409));
            await assert.rejects(reconnect, cleanup);
            await assert.rejects(shared);
            await assert.rejects(p.watch(client.connect(options(), '3'.repeat(32))), cleanup);
            assert.equal(p.deletes(), 1);
            assert.equal(client.automationConnection(), A);
        }),
);

test(
    'Gateway pending close pagehide avoids duplicate effects and stale ACK cannot erase replacement',
    { concurrency: false },
    async () =>
        memory(async (p) => {
            const client = p.client(),
                old = p.deferred(),
                current = p.deferred();
            await client.connect(options(), '1'.repeat(32));
            p.deletion((route) => (route.endsWith(A) ? old.promise : current.promise));
            const oldClose = p.watch(client.disconnect());
            await turn();
            p.page.dispatchEvent(new Event('pagehide'));
            await turn();
            assert.equal(p.deletes(), 1);
            assert.equal(p.requests.filter((entry) => entry.route.endsWith('/cancel')).length, 0);
            assert.equal(client.automationConnection(), '');
            await client.connect(options(), '2'.repeat(32));
            const { clock, terminal } = lifecycle(client);
            const currentClose = p.watch(client.disconnect());
            await turn();
            old.resolve(json({ disconnected: true }));
            await assert.rejects(oldClose, cleanup);
            assert.equal(client.automationConnection(), B);
            assert.equal(client.disconnect(), currentClose);
            assert.equal(clock.signal.aborted || terminal.signal.aborted, false);
            assert.equal(p.intervals.size, 1);
            current.resolve(json({ disconnected: true }));
            await currentClose;
            assert.equal(client.automationConnection(), '');
        }),
);

test(
    'Gateway stale failure cannot poison the current session replacement marker',
    { concurrency: false },
    async () =>
        memory(async (p) => {
            const client = p.client(),
                old = p.deferred();
            await client.connect(options(), '1'.repeat(32));
            p.deletion((route) => (route.endsWith(A) ? old.promise : json({ disconnected: true })));
            const oldClose = p.watch(client.disconnect());
            await turn();
            p.page.dispatchEvent(new Event('pagehide'));
            await client.connect(options(), '2'.repeat(32));
            old.resolve(json({ error: 'old refusal' }, 409));
            await assert.rejects(oldClose);
            await p.watch(client.disconnect(true));
            assert.equal(p.deletes(), 2);
            assert.equal(client.automationConnection(), '');
        }),
);

const hookSource = readFileSync(
    new URL('../src/hooks/useDeviceSession.ts', import.meta.url),
    'utf8',
);
const hookTree = ts.createSourceFile(
    'useDeviceSession.ts',
    hookSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);
const hook = hookTree.statements.find(
    (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'useDeviceSession',
);
assert.ok(hook?.body);
function hookFunction(name: string) {
    const node = hook!.body!.statements.find(
        (entry): entry is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(entry) && entry.name?.text === name,
    );
    assert.ok(node, 'actual hook callback missing: ' + name);
    return node.getText(hookTree);
}
let disconnectedArrow: ts.ArrowFunction | undefined;
function findListener(node: ts.Node) {
    if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'onDisconnected'
    ) {
        assert.equal(disconnectedArrow, undefined, 'exactly one actual listener is expected');
        assert.ok(ts.isArrowFunction(node.arguments[0]));
        disconnectedArrow = node.arguments[0];
    }
    ts.forEachChild(node, findListener);
}
findListener(hook!);
assert.ok(disconnectedArrow);
const callbackCode = ts.transpileModule(
    hookFunction('connect') +
        '\n' +
        hookFunction('disconnect') +
        '\n' +
        'globalThis.callbacks = { connect, disconnect, onDisconnected: ' +
        disconnectedArrow.getText(hookTree) +
        ' };',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

function hookCallbacks(
    transport: { disconnect: (...args: any[]) => Promise<void> },
    bridge?: unknown,
) {
    const active = { username: 'retained', endpoint: 'memory.invalid:22', generation: 1 };
    const state = {
        connected: true,
        active: active as unknown,
        gateway: transport as unknown,
        error: '',
        notice: '',
        disconnecting: false,
        operationCalls: 0,
    };
    const connectedRef = { current: true },
        collectingRef = { current: false },
        disconnectingRef = { current: false };
    const context = vm.createContext({
        GatewayClient,
        transport,
        bridge,
        connected: true,
        resettingRef: { current: false },
        collectingRef,
        disconnectingRef,
        connectedRef,
        dataGeneration: { current: 0 },
        connectionGeneration: { current: 1 },
        connectionOperation: {
            current: {
                connect: async () => {
                    state.operationCalls++;
                    assert.equal(connectedRef.current, false);
                    assert.equal(state.active, null);
                    return false;
                },
            },
        },
        idleWaiters: { current: new Set() },
        setActiveDevice: (value: unknown) => {
            state.active = value;
        },
        setConnected: (value: boolean) => {
            state.connected = value;
        },
        setGateway: (value: unknown) => {
            state.gateway = value;
        },
        setError: (value: string) => {
            state.error = value;
        },
        setNotice: (value: string) => {
            state.notice = value;
        },
        setDisconnecting: (value: boolean) => {
            state.disconnecting = value;
        },
        setConnecting: () => {},
        setConnectionProgress: () => {},
        setBusy: () => {},
        pauseLiveUpdates: () => {},
        message: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    });
    vm.runInContext(callbackCode, context);
    const callbacks = context.callbacks as {
        connect: (options: ConnectOptions) => Promise<void>;
        disconnect: () => Promise<void>;
        onDisconnected: (reason?: 'update') => void;
    };
    return { state, connectedRef, disconnectingRef, active, ...callbacks };
}

test(
    'actual hook retains UI and old device after failed close/replacement, then explicit retry succeeds',
    { concurrency: false },
    async () =>
        memory(async (p) => {
            const client = p.client();
            await client.connect(options(), '1'.repeat(32));
            const h = hookCallbacks(client);
            p.deletion(() => json({ error: 'busy' }, 409));
            await h.connect(options());
            assert.equal(h.state.active, h.active);
            assert.equal(h.connectedRef.current, true);
            assert.equal(h.state.connected, true);
            assert.equal(h.state.gateway, client);
            assert.equal(h.state.operationCalls, 0);
            await h.connect(options());
            assert.equal(
                p.deletes(),
                1,
                'hook replacement intent cannot automatically repeat failed close',
            );
            await h.disconnect();
            assert.equal(h.state.connected, true);
            assert.equal(h.state.active, h.active);
            assert.equal(h.state.gateway, client);
            assert.equal(h.state.disconnecting, false);
            assert.notEqual(h.state.error, '');
            p.deletion(() => json({ disconnected: true }));
            await h.disconnect();
            assert.equal(h.state.connected, false);
            assert.equal(h.connectedRef.current, false);
            assert.equal(h.state.active, null);
            assert.equal(h.state.gateway, null);
        }),
);

test(
    'actual hook ambiguous close retains UI and does not overwrite an independently observed disconnect',
    { concurrency: false },
    async () =>
        memory(async (p) => {
            const client = p.client(),
                response = p.deferred();
            await client.connect(options(), '1'.repeat(32));
            const h = hookCallbacks(client);
            p.deletion(() => {
                throw Error('memory network failure');
            });
            await h.disconnect();
            assert.equal(h.state.connected, true);
            assert.equal(h.connectedRef.current, true);
            assert.equal(h.state.active, h.active);
            p.deletion(() => response.promise);
            const closing = p.watch(h.disconnect());
            await turn();
            assert.equal(h.disconnectingRef.current, true);
            h.onDisconnected();
            assert.equal(h.state.connected, false);
            assert.equal(h.connectedRef.current, false);
            assert.equal(h.state.active, null);
            response.resolve(json({ error: 'busy' }, 409));
            await closing;
            assert.equal(h.state.connected, false, 'failure must not force connected=true');
        }),
);

test(
    'actual 401/404 invalidation updates hook while intentional disconnect is pending',
    { concurrency: false },
    async () => {
        for (const status of [401, 404])
            await memory(async (p) => {
                const client = p.client();
                await client.connect(options(), '1'.repeat(32));
                const h = hookCallbacks(client);
                let notifications = 0;
                client.onDisconnected(() => {
                    notifications++;
                    h.onDisconnected();
                });
                p.deletion(() => json({ error: 'not available' }, status));
                await h.disconnect();
                assert.equal(notifications, 1);
                assert.equal(client.automationConnection(), '');
                assert.equal(h.state.connected, false);
                assert.equal(h.connectedRef.current, false);
                assert.equal(h.state.active, null);
                assert.equal(p.intervals.size, 0);
                assert.equal(p.pageListeners.size, 0);
                assert.equal(p.deletes(), 1);
                assert.equal(h.state.error.includes('unexpectedly'), false);
            });
    },
);

test(
    'actual hook waits for replacement ACK and preserves DesktopBridge zero-argument close',
    { concurrency: false },
    async () =>
        memory(async (p) => {
            const client = p.client(),
                response = p.deferred();
            await client.connect(options(), '1'.repeat(32));
            const replacement = {},
                h = hookCallbacks(client, replacement);
            p.deletion(() => response.promise);
            const connecting = p.watch(h.connect(options()));
            await turn();
            assert.equal(h.state.active, h.active);
            assert.equal(h.connectedRef.current, true);
            assert.equal(h.state.operationCalls, 0);
            response.resolve(json({ disconnected: true }));
            await connecting;
            assert.equal(h.state.active, null);
            assert.equal(h.connectedRef.current, false);
            assert.equal(h.state.operationCalls, 1);
            const args: unknown[][] = [];
            const bridge = {
                disconnect: async (...values: unknown[]) => {
                    args.push(values);
                },
            };
            const desktop = hookCallbacks(bridge, bridge);
            await desktop.connect(options());
            assert.deepEqual(args, [[]]);
            const direct = hookCallbacks(bridge, bridge);
            await direct.disconnect();
            assert.deepEqual(args, [[], []]);
            assert.equal(direct.state.connected, false);
        }),
);
