import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SshConsoleHost } from '../backend/ssh/console-host';
import type { SshSession } from '../backend/ssh/session';
import { createQuitController, runQuitCleanup } from '../shared/quit-cleanup';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}
async function pump() { for (let i = 0; i < 128; i++) await Promise.resolve(); }
async function until(predicate: () => boolean) {
    for (let i = 0; i < 128 && !predicate(); i++) await Promise.resolve();
    assert.ok(predicate(), 'The bounded memory shutdown observation did not settle.');
}
function observe<T>(task: Promise<T>) {
    const result: { done: boolean; value?: T; error?: unknown } = { done: false };
    void task.then((value) => { result.value = value; result.done = true; },
        (error: unknown) => { result.error = error; result.done = true; });
    return result;
}
function reasons(error: unknown): unknown[] {
    return error instanceof AggregateError ? error.errors.flatMap(reasons) : [error];
}
function readSnapshot(host: SshConsoleHost) { return host.snapshot; }
function strict<T extends object>(target: T): T {
    return new Proxy(target, { get(object, key, receiver) {
        if (!Object.hasOwn(object, key)) throw Error('Unexpected memory capability: ' + String(key));
        return Reflect.get(object, key, receiver);
    } });
}
type Step = { failure?: Error; held?: ReturnType<typeof gate> };

async function memory(t: TestContext, plans: readonly (readonly Step[])[], run: (f: {
    host: SshConsoleHost;
    actors: { owned: boolean; cancels: number }[];
    open(index: number): Promise<{ protocol: 1; id: string; connection: string; capability: string }>;
    root(preparation?: ReturnType<typeof gate>): {
        quit: ReturnType<typeof createQuitController>;
        counts: { disconnect: number; prepare: number; join: number; finalize: number };
    };
}) => Promise<void>) {
    const names = ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const;
    const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)!]));
    const active = new Set<object>(), requests: { input: unknown; before: unknown }[] = [];
    const privateGates = plans.flatMap((plan) => plan.flatMap((step) => step.held ? [step.held] : []));
    const actors: { owned: boolean; cancels: number }[] = [];
    let created = 0, intervals = 0, factoryCalls = 0;
    const connection = 'memory-shutdown-connection';
    const session = strict({
        get automationConnection() { return connection; },
        createAutomationConsole() {
            const plan = plans[created++];
            assert.ok(plan, 'Unexpected additional actor admission.');
            const state = { owned: false, cancels: 0 };
            actors.push(state);
            const actor = strict({
                get owned() { return state.owned; },
                get snapshot() { return null; },
                async open(_header: unknown, signal: AbortSignal, timeout: number) {
                    assert.equal(signal.aborted, false);
                    assert.equal(timeout, 1000);
                    assert.equal(state.owned, false);
                    state.owned = true;
                    return null;
                },
                async cancel() {
                    const step = plan[state.cancels++];
                    assert.ok(step, 'Unexpected automatic re-cancellation.');
                    assert.equal(state.owned, true);
                    await step.held?.promise;
                    if (step.failure) throw step.failure;
                    state.owned = false;
                    return null;
                },
            });
            return { actor, signal: new AbortController().signal,
                target: { endpoint: 'memory.invalid:22', username: 'synthetic' } };
        },
    }) as unknown as SshSession;
    const host = new SshConsoleHost(session, async () => {
        factoryCalls++;
        throw Error('No actual journal is admitted by this memory fixture.');
    });
    const f = {
        host, actors,
        async open(index: number) {
            const capabilities = await host.dispatch({ protocol: 1, action: 'capabilities' }) as { epoch: string };
            const input = { protocol: 1, action: 'open', epoch: capabilities.epoch,
                id: 'memory-shutdown-run-' + index, connection,
                ready: { role: 'shell-prompt', literals: ['memory# '] }, timeoutMs: 1000 };
            requests.push({ input, before: structuredClone(input) });
            const owner = await host.dispatch(input) as { protocol: 1; id: string; connection: string; capability: string };
            await until(() => host.snapshot?.phase === 'ready');
            return owner;
        },
        root(preparation?: ReturnType<typeof gate>) {
            if (preparation) privateGates.push(preparation);
            const counts = { disconnect: 0, prepare: 0, join: 0, finalize: 0 };
            const quit = createQuitController(() => runQuitCleanup({
                cancelConnection: () => {}, clearHostVerification: () => {},
                disconnect: () => { counts.disconnect++; host.invalidate(); },
                prepareConsole: async () => { counts.prepare++; await preparation?.promise; },
                joinConnection: async () => {},
                joinSsh: async () => { counts.join++; await host.shutdown(); },
                finishConsole: async () => { counts.finalize++; },
                shutdownCapture: async () => {},
            }));
            return { quit, counts };
        },
    };
    try {
        Object.defineProperty(globalThis, 'setInterval', { ...descriptors.get('setInterval'),
            value: (callback: unknown, delay: unknown, ...args: unknown[]) => {
                assert.equal(typeof callback, 'function'); assert.equal(delay, 250); assert.equal(args.length, 0);
                assert.ok(++intervals <= plans.length);
                const handle = Object.freeze({ unref() {} });
                active.add(handle);
                return handle;
            } });
        Object.defineProperty(globalThis, 'clearInterval', { ...descriptors.get('clearInterval'), value: (handle: unknown) => {
            if (handle !== undefined) assert.equal(active.delete(handle as object), true);
        } });
        await run(f);
        assert.equal(factoryCalls, 0);
        assert.equal(created, plans.length);
        assert.equal(active.size, 0);
        for (const request of requests) assert.deepEqual(request.input, request.before);
    } finally {
        for (const held of privateGates) held.release();
        try { await pump(); }
        finally {
            for (const name of names) Object.defineProperty(globalThis, name, descriptors.get(name)!);
            for (const name of names)
                assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), descriptors.get(name));
            t.diagnostic(JSON.stringify({ exactTimerDescriptorsRestored: true, activeVirtualIntervals: active.size,
                repositoryCalls: factoryCalls, cancellations: actors.map((actor) => actor.cancels) }));
        }
    }
}

test('settled invalidation failure is adopted once and blocks root finalization with its original error', { concurrency: false }, async (t) => {
    const failure = Error('Synthetic owned cancellation failed.'), preparation = gate();
    await memory(t, [[{ failure }]], async (f) => {
        await f.open(1);
        const { quit, counts } = f.root(preparation), task = quit.begin(undefined), result = observe(task);
        await until(() => f.host.snapshot?.phase === 'cleanup-pending');
        await pump();
        assert.equal(f.actors[0].owned, true);
        assert.equal(counts.join, 0);
        f.host.invalidate();
        await pump();
        assert.equal(f.actors[0].cancels, 1);
        preparation.release();
        await until(() => result.done);
        assert.equal(result.error, undefined);
        assert.equal(result.value?.status, 'blocked');
        if (result.value?.status !== 'blocked') throw Error('Expected blocked quit.');
        assert.ok(reasons(result.value.error).includes(failure));
        assert.equal(quit.phase, 'blocked');
        assert.equal(quit.begin(undefined), task);
        f.host.invalidate();
        await pump();
        assert.equal(f.actors[0].cancels, 1);
        assert.equal(f.actors[0].owned, true);
        assert.equal(f.host.snapshot?.phase, 'cleanup-pending');
        assert.deepEqual(counts, { disconnect: 1, prepare: 1, join: 1, finalize: 0 });
    });
});

test('shutdown adopts its pending successful invalidation and waits before root finalization', { concurrency: false }, async (t) => {
    const held = gate();
    await memory(t, [[{ held }]], async (f) => {
        await f.open(1);
        const { quit, counts } = f.root(), result = observe(quit.begin(undefined));
        await until(() => counts.join === 1);
        await pump();
        assert.equal(f.actors[0].cancels, 1);
        assert.equal(f.actors[0].owned, true);
        assert.equal(result.done, false);
        assert.equal(counts.finalize, 0);
        held.release();
        await until(() => result.done);
        assert.deepEqual(result.value, { status: 'ready' });
        assert.equal(f.actors[0].cancels, 1);
        assert.equal(f.actors[0].owned, false);
        assert.equal(f.host.snapshot, null);
        assert.deepEqual(counts, { disconnect: 1, prepare: 1, join: 1, finalize: 1 });
    });
});

test('explicit non-quit recovery can replace failure and a new run must close its own actor', { concurrency: false }, async (t) => {
    const failure = Error('Synthetic earlier run failure.'), recovery = gate(), newClosure = gate();
    await memory(t, [[{ failure }, { held: recovery }], [{ held: newClosure }]], async (f) => {
        const previous = await f.open(1);
        f.host.invalidate();
        await until(() => f.host.snapshot?.phase === 'cleanup-pending');
        await pump();
        const recovered = observe(f.host.dispatch({ ...previous, action: 'finish', reason: 'cancelled' }));
        await until(() => f.actors[0].cancels === 2);
        assert.equal(recovered.done, false);
        recovery.release();
        await until(() => recovered.done);
        assert.equal(recovered.error, undefined);
        assert.equal(f.actors[0].owned, false);
        await f.host.dispatch({ ...previous, action: 'release' });
        assert.equal(f.host.snapshot, null);
        const current = await f.open(2);
        assert.notEqual(current.id, previous.id);
        assert.notEqual(current.capability, previous.capability);
        assert.equal(readSnapshot(f.host)?.error, null);
        const { quit, counts } = f.root(), result = observe(quit.begin(undefined));
        await until(() => counts.join === 1);
        await pump();
        assert.equal(f.actors[0].cancels, 2);
        assert.equal(f.actors[1].cancels, 1);
        assert.equal(f.actors[1].owned, true);
        assert.equal(result.done, false, 'An old cleanup result must not acknowledge the new actor.');
        assert.equal(counts.finalize, 0);
        newClosure.release();
        await until(() => result.done);
        assert.deepEqual(result.value, { status: 'ready' });
        assert.equal(f.actors[1].owned, false);
        assert.equal(f.actors[1].cancels, 1);
        assert.equal(counts.finalize, 1);
        assert.equal(f.host.snapshot, null);
    });
});
