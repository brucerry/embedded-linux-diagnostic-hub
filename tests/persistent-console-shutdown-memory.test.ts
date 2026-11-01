import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientChannel } from 'ssh2';
import type { SshSession } from '../backend/ssh/session';
import { PersistentSshConsole } from '../backend/ssh/persistent-console';
import { SshConsoleHost } from '../backend/ssh/console-host';
import { consoleHeader, consoleSegment, type ConsoleRepository, type ConsoleSnapshot } from '../shared/console-journal';
import { consoleSnapshot } from '../shared/console-storage';
import { bytesBase64 } from '../shared/capture-store';
import { sshInputBytes } from '../shared/ssh-console';
import { createQuitController, runQuitCleanup } from '../shared/quit-cleanup';

function gate() { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; }
async function pump() { for (let i = 0; i < 256; i++) await Promise.resolve(); }
async function until(check: () => boolean) {
    for (let i = 0; i < 256 && !check(); i++) await Promise.resolve();
    assert.ok(check(), 'Actual actor did not reach the bounded memory boundary.');
}
function observe<T>(task: Promise<T>) {
    const result: { done: boolean; value?: T; error?: unknown } = { done: false };
    void task.then((value) => { result.value = value; result.done = true; },
        (error: unknown) => { result.error = error; result.done = true; });
    return result;
}
function reasons(error: unknown): unknown[] { return error instanceof AggregateError ? error.errors.flatMap(reasons) : [error]; }
function strict<T extends object>(value: T): T {
    return new Proxy(value, { get(target, key, receiver) {
        if (!Object.hasOwn(target, key)) throw Error('Unexpected memory repository method: ' + String(key));
        return Reflect.get(target, key, receiver);
    } });
}
class ReadableSide extends EventEmitter {
    readableLength = 0;
    readableEnded = false;
    pause() { return this; }
    resume() { return this; }
    read(): never { throw Error('No buffered stream reads are admitted.'); }
    endReadable() { if (!this.readableEnded) { this.readableEnded = true; this.emit('end'); } }
}
class MemoryChannel extends ReadableSide {
    stderr = new ReadableSide();
    closeRequests = 0;
    writes: Buffer[] = [];
    private callback?: (error?: Error | null) => void;
    close() { assert.equal(++this.closeRequests, 1); return this; }
    write(bytes: Buffer, callback: (error?: Error | null) => void) {
        assert.equal(this.writes.length, 0); assert.ok(bytes.length <= 8193);
        this.writes.push(Buffer.from(bytes)); this.callback = callback; return true;
    }
    acknowledgeWrite() { const callback = this.callback; this.callback = undefined; callback?.(); }
}

async function fixture(t: TestContext, failure: Error | undefined, run: (f: {
    actor(): PersistentSshConsole; host: SshConsoleHost; channel: MemoryChannel;
    owner: { protocol: 1; id: string; connection: string; capability: string };
    trace: string[]; counts: { release: number; close: number; observations: number; finalizer: number };
    observationGate: ReturnType<typeof gate>; closeGate: ReturnType<typeof gate>;
    root(): { task: ReturnType<ReturnType<typeof createQuitController>['begin']>; quit: ReturnType<typeof createQuitController> };
}) => Promise<void>) {
    const descriptors = new Map(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)!]));
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    const dateNowDescriptor = Object.getOwnPropertyDescriptor(Date, 'now')!;
    const wallBase = Date.parse('2026-10-30T00:00:00.000Z');
    let now = 0, id = 0, callbacks = 0;
    const timers = new Map<object, { at: number; repeat: boolean; callback: () => void }>();
    const schedule = (callback: () => void, delay: number, repeat: boolean) => {
        assert.ok(typeof callback === 'function' && (delay === 10 || delay === 250));
        const handle = Object.freeze({ id: ++id, unref() {} });
        assert.ok(id <= 8); timers.set(handle, { at: now + delay, repeat, callback }); return handle;
    };
    const clear = (handle: object | undefined) => { if (handle) timers.delete(handle); };
    const advanceReadiness = () => {
        now += 60;
        for (const [handle, timer] of [...timers]) if (timer.at <= now) {
            assert.equal(timer.repeat, false); assert.ok(++callbacks <= 4);
            timers.delete(handle); timer.callback();
        }
    };
    const observationGate = gate(), closeGate = gate(), channel = new MemoryChannel();
    const counts = { release: 0, close: 0, observations: 0, finalizer: 0 };
    const trace: string[] = [];
    let snapshot: ConsoleSnapshot | null = null, resourceClosed = false, actor: PersistentSshConsole | undefined;
    let operations = 0;
    const touch = (name: string) => { assert.ok(++operations <= 32); trace.push(name); if (snapshot) { snapshot.records++; snapshot.offset++; } };
    const store = strict({
        then: undefined,
        get snapshot() { return snapshot ? consoleSnapshot(structuredClone(snapshot)) : null; },
        get resourceClosed() { return resourceClosed; },
        async begin(header: Parameters<ConsoleRepository['begin']>[0]) {
            assert.equal(snapshot, null); touch('begin');
            snapshot = consoleSnapshot({ schema: 2, header: consoleHeader({ ...header, schema: 2,
                id: '00000000-0000-4000-8000-000000000091' }), state: 'active', offset: 0, records: 0,
                bytes: 0, observations: 0, segments: 0, finalizedAt: null, reason: null,
                observedBytes: null, failure: null, shellClosed: false });
            return structuredClone(snapshot);
        },
        async start(_segment: unknown, _at: string) { touch('start'); return ++snapshot!.segments; },
        async inputSent(_at: string) { touch('input-sent'); },
        async discardPreparation(_reason: unknown, _at: string) { touch('discard-preparation'); },
        async observe(bytes: Uint8Array, _at: string, _origin: string) {
            assert.ok(++counts.observations <= 2); touch('observe-enter-' + counts.observations);
            if (counts.observations === 2) await observationGate.promise;
            snapshot!.bytes += bytes.length; snapshot!.observations++;
            trace.push('observe-ack-' + counts.observations);
        },
        async end(_reason: unknown, _match: unknown, _at: string) { touch('end'); },
        async outcome(_reason: unknown, _match: unknown, _at: string) { touch('outcome'); },
        async finish(reason: string, observed: number, closed: true) {
            touch('finish'); assert.equal(observed, snapshot!.bytes); assert.equal(closed, true);
            snapshot!.state = 'incomplete'; snapshot!.reason = reason; snapshot!.observedBytes = observed;
            snapshot!.shellClosed = true; snapshot!.finalizedAt = new Date().toISOString();
            return structuredClone(snapshot!);
        },
        async fail(): Promise<never> { throw Error('Unexpected metadata failure route.'); },
        async close() {
            assert.equal(++counts.close, 1, 'The same transaction must not retry repository closure.');
            trace.push('close-enter'); await closeGate.promise;
            if (failure) { trace.push('close-rejected'); throw failure; }
            resourceClosed = true; trace.push('close-ack');
        },
    }) as unknown as ConsoleRepository;
    const connection = 'actual-memory-connection';
    const session = { automationConnection: connection,
        createAutomationConsole(remote: ConsoleRepository, _connection: string, fresh: () => void) {
            assert.equal(actor, undefined);
            actor = new PersistentSshConsole({
                acquire() { trace.push('lease-acquire'); return () => {
                    assert.equal(resourceClosed, true); assert.equal(++counts.release, 1); trace.push('lease-release');
                }; },
                assertCurrent() {}, assertFresh: fresh,
                open(callback) { callback(undefined, channel as unknown as ClientChannel); channel.emit('data', Buffer.from('memory# ')); },
            }, remote, 50);
            return { actor, signal: new AbortController().signal, target: { endpoint: 'memory.invalid:22', username: 'synthetic' } };
        },
    } as unknown as SshSession;
    const host = new SshConsoleHost(session, async () => store);
    const unrelated = () => {};
    channel.on('data', unrelated); channel.stderr.on('data', unrelated);
    try {
        Object.defineProperty(globalThis, 'setTimeout', { ...descriptors.get('setTimeout'), value: (cb: () => void, delay: number) => schedule(cb, delay, false) });
        Object.defineProperty(globalThis, 'setInterval', { ...descriptors.get('setInterval'), value: (cb: () => void, delay: number) => schedule(cb, delay, true) });
        for (const name of ['clearTimeout', 'clearInterval']) Object.defineProperty(globalThis, name, { ...descriptors.get(name), value: clear });
        Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => now });
        Object.defineProperty(Date, 'now', { ...dateNowDescriptor, value: () => wallBase + now });
        const caps = await host.dispatch({ protocol: 1, action: 'capabilities' }) as { epoch: string };
        const owner = await host.dispatch({ protocol: 1, action: 'open', epoch: caps.epoch, id: 'actual-memory-console', connection,
            ready: { role: 'shell-prompt', literals: ['memory# '] }, timeoutMs: 1000 }) as { protocol: 1; id: string; connection: string; capability: string };
        await until(() => counts.observations === 1 && actor!.ownershipSnapshot.pendingBytes === 0);
        advanceReadiness(); await until(() => host.snapshot?.phase === 'ready');
        const root = () => {
            const quit = createQuitController(() => runQuitCleanup({ cancelConnection() {}, clearHostVerification() {},
                disconnect() { host.invalidate(); }, prepareConsole: async () => {}, joinConnection: async () => {},
                joinSsh: async () => host.shutdown(), finishConsole: async () => {
                    assert.equal(actor!.owned, false); assert.equal(resourceClosed, true); counts.finalizer++; trace.push('root-finalizer');
                }, shutdownCapture: async () => {} }));
            return { quit, task: quit.begin(undefined) };
        };
        await run({ actor: () => actor!, host, channel, owner, trace, counts, observationGate, closeGate, root });
        assert.equal(timers.size, 0);
        assert.equal(channel.listeners('data').includes(unrelated), true);
        assert.equal(channel.stderr.listeners('data').includes(unrelated), true);
    } finally {
        // Settle only already admitted fake callbacks/gates; never call cancel/close again here.
        channel.acknowledgeWrite(); channel.emit('close'); channel.endReadable(); channel.stderr.endReadable();
        observationGate.release(); closeGate.release();
        try { await pump(); }
        finally {
            for (const [name, descriptor] of descriptors) Object.defineProperty(globalThis, name, descriptor);
            if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
            else Reflect.deleteProperty(performance, 'now');
            Object.defineProperty(Date, 'now', dateNowDescriptor);
            for (const [name, descriptor] of descriptors) assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), descriptor);
            assert.deepEqual(Object.getOwnPropertyDescriptor(performance, 'now'), nowDescriptor);
            assert.deepEqual(Object.getOwnPropertyDescriptor(Date, 'now'), dateNowDescriptor);
            t.diagnostic(JSON.stringify({ restored: true, virtualTimers: timers.size, repositoryCloseAttempts: counts.close,
                leaseReleases: counts.release, channelCloseRequests: channel.closeRequests, trace }));
        }
    }
}

test('actual actor joins channel, both drains, write callback, observation and storage ACK before lease/root release', { concurrency: false }, async (t) => {
    await fixture(t, undefined, async (f) => {
        const input = { intent: 'script' as const, command: 'printf memory' };
        const segment = consoleSegment({ kind: 'command', runId: 'memory-run', stepId: 'memory-step', ordinal: 1, name: 'Synthetic',
            input, requestBase64: bytesBase64(sshInputBytes('console', input)), criterion: { role: 'shell-prompt', literals: ['memory# '] } });
        const step = observe(f.host.dispatch({ ...f.owner, action: 'step', sequence: 0, segment, timeoutMs: 1000 }));
        await until(() => f.channel.writes.length === 1);
        assert.deepEqual(f.channel.writes[0], Buffer.from('printf memory\r'));
        f.channel.emit('data', Buffer.from('tail'));
        await until(() => f.counts.observations === 2);
        const { task } = f.root(), result = observe(task);
        await until(() => f.channel.closeRequests === 1); await pump();
        assert.equal(result.done, false); assert.equal(f.actor().ownershipSnapshot.channel, 1);
        f.channel.emit('close'); await pump();
        assert.equal(f.actor().ownershipSnapshot.outputDrain, 1);
        f.channel.endReadable(); await pump();
        assert.equal(f.actor().ownershipSnapshot.extendedDrain, 1);
        f.channel.stderr.endReadable(); await pump();
        assert.equal(f.actor().ownershipSnapshot.write, 1); assert.equal(f.counts.close, 0);
        f.channel.acknowledgeWrite(); await pump();
        assert.equal(f.actor().ownershipSnapshot.write, 0); assert.ok(f.actor().ownershipSnapshot.pendingBytes > 0);
        assert.equal(f.counts.close, 0); assert.equal(f.counts.release, 0);
        f.observationGate.release(); await until(() => f.counts.close === 1);
        assert.equal(result.done, false); assert.equal(f.actor().owned, true); assert.equal(f.counts.release, 0);
        f.closeGate.release(); await until(() => result.done && step.done);
        assert.deepEqual(result.value, { status: 'ready' }); assert.equal(step.error instanceof Error, true);
        assert.equal(f.counts.release, 1); assert.equal(f.counts.finalizer, 1);
        assert.equal(f.actor().ownershipSnapshot.listeners, 0); assert.equal(f.actor().ownershipSnapshot.abortListeners, 0);
        assert.ok(f.trace.indexOf('close-ack') < f.trace.indexOf('lease-release'));
        assert.ok(f.trace.indexOf('lease-release') < f.trace.indexOf('root-finalizer'));
    });
});

test('actual actor storage rejection retains lease and original error without host-triggered closure retry', { concurrency: false }, async (t) => {
    const failure = Error('Synthetic journal close acknowledgement failed.');
    await fixture(t, failure, async (f) => {
        const { quit, task } = f.root(), result = observe(task);
        await until(() => f.channel.closeRequests === 1);
        f.channel.emit('close'); f.channel.endReadable(); f.channel.stderr.endReadable();
        await until(() => f.counts.close === 1); assert.equal(f.actor().owned, true);
        f.closeGate.release(); await until(() => result.done); await pump();
        assert.equal(result.value?.status, 'blocked');
        if (result.value?.status !== 'blocked') throw Error('Expected original cleanup failure to block quit.');
        assert.ok(reasons(result.value.error).includes(failure));
        assert.equal(quit.begin(undefined), task);
        f.host.invalidate(); await pump();
        assert.equal(f.counts.close, 1); assert.equal(f.channel.closeRequests, 1);
        assert.equal(f.actor().owned, true); assert.equal(f.counts.release, 0); assert.equal(f.counts.finalizer, 0);
    });
});
