import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientChannel } from 'ssh2';
import type { SshSession } from '../backend/ssh/session';
import { PersistentSshConsole } from '../backend/ssh/persistent-console';
import { SshConsoleHost } from '../backend/ssh/console-host';
import { FlowRunner, type FlowState, type RunClock } from '../src/features/automation/runner';
import { sshConsoleBackend } from '../src/features/automation/capture/console-backend';
import type { AutomationPlan, AutomationRecord } from '../shared/automation';
import {
    consoleHeader, consoleSegment, type ConsoleRepository, type ConsoleSnapshot,
    type ConsoleMatch, type ConsoleCompletionReason,
} from '../shared/console-journal';
import { consoleSnapshot } from '../shared/console-storage';
import { CONSOLE_IDLE_RENEWAL_MS } from '../shared/console-rpc';

// Reuse the public-boundary approach of persistent-console-shutdown-memory.test.ts:
// actual actor/host, strict journal and EventEmitter-shaped channel, no ssh2 runtime.
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}
async function pump() { for (let i = 0; i < 256; i++) await Promise.resolve(); }
async function until(check: () => boolean, label: string) {
    for (let i = 0; i < 256 && !check(); i++) await Promise.resolve();
    assert.ok(check(), 'Memory boundary not reached: ' + label);
}
class ReadableSide extends EventEmitter {
    readableLength = 0;
    readableEnded = false;
    pause() { return this; }
    resume() { return this; }
    read(): never { throw Error('No buffered channel reads are admitted.'); }
    endReadable() {
        if (!this.readableEnded) { this.readableEnded = true; this.emit('end'); }
    }
}
class MemoryChannel extends ReadableSide {
    stderr = new ReadableSide();
    writes: Buffer[] = [];
    closeRequests = 0;
    private callback?: (error?: Error | null) => void;
    close() { assert.equal(++this.closeRequests, 1); return this; }
    write(bytes: Buffer, callback: (error?: Error | null) => void) {
        assert.equal(this.callback, undefined);
        assert.ok(this.writes.length < 2, 'A later command or repeat was dispatched.');
        assert.ok(bytes.length <= 8193);
        this.writes.push(Buffer.from(bytes)); this.callback = callback;
        return true;
    }
    acknowledgeWrite() {
        const callback = this.callback; this.callback = undefined; callback?.();
    }
}

test('persistent SSH Enter outcome is retained when Cancel fences later input and joins owned closure', { concurrency: false }, async (t) => {
    const descriptors = new Map(
        ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map(
            (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)!],
        ),
    );
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    const dateDescriptor = Object.getOwnPropertyDescriptor(Date, 'now')!;
    const wall = Date.parse('2026-10-30T00:00:00.000Z');
    let now = 0, handles = 0, callbacks = 0, sleeps = 0;
    const timers = new Map<object, { at: number; delay: number; repeat: boolean; callback: () => void }>();
    const schedule = (callback: () => void, delay: number, repeat: boolean) => {
        assert.ok(typeof callback === 'function');
        assert.ok(repeat ? delay === 250 : delay === 10 || delay === CONSOLE_IDLE_RENEWAL_MS);
        assert.ok(++handles <= 32);
        const handle = Object.freeze({ id: handles, unref() {} });
        timers.set(handle, { at: now + delay, delay, repeat, callback });
        return handle;
    };
    const clear = (handle: object | undefined) => { if (handle) timers.delete(handle); };
    const advance = () => {
        now += 60;
        for (const [handle, timer] of [...timers]) if (timer.at <= now) {
            assert.ok(++callbacks <= 8);
            if (timer.repeat) timer.at = now + timer.delay;
            else timers.delete(handle);
            timer.callback();
        }
    };
    const clock: RunClock = {
        local: () => wall + now, mono: () => now,
        sleep: async () => { sleeps++; throw Error('No schedule, delay or repetition sleep is expected.'); },
    };
    const channel = new MemoryChannel(), resultGate = gate(), closeGate = gate();
    const trace: string[] = [], states: FlowState[] = [], rows: AutomationRecord[] = [];
    const actions: string[] = [];
    const prepared: Extract<ReturnType<typeof consoleSegment>, { kind: 'command' }>[] = [];
    const outcomes: { completion: ConsoleCompletionReason; match: ConsoleMatch | null; exitCode: null }[] = [];
    let current: ConsoleSnapshot | null = null, closed = false, operations = 0;
    let openCount = 0, closeCount = 0, releaseCount = 0, resultHeld = false, settled = false;
    let actor: PersistentSshConsole | undefined, running: Promise<void> | undefined;
    const touch = (name: string) => {
        assert.ok(++operations <= 64); trace.push(name);
        if (current) { current.records++; current.offset++; }
    };
    const journal: ConsoleRepository = {
        get snapshot() { return current ? consoleSnapshot(structuredClone(current)) : null; },
        get resourceClosed() { return closed; },
        async begin(input) {
            assert.equal(current, null); touch('begin');
            current = consoleSnapshot({ schema: 2, header: consoleHeader({ ...input, schema: 2,
                id: '00000000-0000-4000-8000-000000000071' }),
                state: 'active', offset: 0, records: 0, bytes: 0, observations: 0, segments: 0,
                finalizedAt: null, reason: null, observedBytes: null, failure: null, shellClosed: false });
            return structuredClone(current);
        },
        async start(input) {
            const segment = consoleSegment(input);
            if (segment.kind === 'command') prepared.push(segment);
            touch('start-' + segment.kind); return ++current!.segments;
        },
        async inputSent() { touch('input-sent'); },
        async discardPreparation(): Promise<never> { throw Error('No command preparation may be discarded.'); },
        async observe(bytes) {
            assert.ok(bytes.length <= 32); touch('observe');
            current!.bytes += bytes.length; current!.observations++;
        },
        async end(reason) { touch('end-' + reason); },
        async outcome(completion, match) {
            touch('outcome'); outcomes.push({ completion, match, exitCode: null });
        },
        async finish(reason, observed, shellClosed) {
            touch('finish-' + reason); assert.equal(reason, 'cancelled');
            assert.equal(observed, current!.bytes); assert.equal(shellClosed, true);
            current!.state = 'incomplete'; current!.reason = reason;
            current!.observedBytes = observed; current!.shellClosed = true;
            current!.finalizedAt = new Date().toISOString();
            return structuredClone(current!);
        },
        async fail(): Promise<never> { throw Error('Unexpected journal failure route.'); },
        async close() {
            assert.equal(++closeCount, 1); trace.push('journal-close-enter');
            await closeGate.promise; closed = true; trace.push('journal-close-ack');
        },
    };
    const strictJournal = new Proxy(journal, {
        get(target, key, receiver) {
            if (key === 'then') return undefined;
            assert.ok(Object.hasOwn(target, key), 'Unexpected journal property: ' + String(key));
            return Reflect.get(target, key, receiver);
        },
    });
    const connection = 'bounded-memory-console-connection';
    const session = {
        automationConnection: connection,
        createAutomationConsole(remote: ConsoleRepository, selected: string, fresh: () => void) {
            assert.equal(selected, connection); assert.equal(actor, undefined);
            actor = new PersistentSshConsole({
                acquire() {
                    trace.push('lease-acquire');
                    return () => {
                        assert.equal(closed, true); assert.equal(++releaseCount, 1);
                        trace.push('lease-release');
                    };
                },
                assertCurrent() { assert.equal(selected, connection); }, assertFresh: fresh,
                open(callback) {
                    assert.equal(++openCount, 1);
                    callback(undefined, channel as unknown as ClientChannel);
                    channel.emit('data', Buffer.from('memory# '));
                },
            }, remote, 50);
            return { actor, signal: new AbortController().signal, target: { endpoint: 'memory.invalid:22', username: 'synthetic' } };
        },
    } as unknown as SshSession;
    const host = new SshConsoleHost(session, async () => strictJournal);
    const transport = {
        automationConnection: () => connection,
        automationConsole: async (request: Parameters<SshConsoleHost['dispatch']>[0]) => {
            // This is only the in-memory transport boundary; dispatch validates the request.
            actions.push((request as { action: string }).action);
            return host.dispatch(request, 'local-client');
        },
    };
    const backend = sshConsoleBackend(transport, 'local-client', { endpoint: 'synthetic console' }, () => true);
    const runner = new FlowRunner((state) => states.push(state), async (row) => {
        rows.push(structuredClone(row));
        if (rows.length === 2) { resultHeld = true; trace.push('result-held'); await resultGate.promise; trace.push('result-ack'); }
    }, clock);
    const prompt = { role: 'shell-prompt' as const, literals: ['memory# '] };
    const plan: AutomationPlan = {
        transport: 'ssh', ssh: { mode: 'console', ready: prompt, completion: prompt },
        steps: [
            { id: 'cd', name: 'Change directory', command: 'cd /', enabled: true, delaySeconds: 0, ssh: { intent: 'script' } },
            { id: 'enter', name: 'Intentional Enter', command: '', enabled: true, delaySeconds: 0, ssh: { intent: 'send-enter' } },
            { id: 'll', name: 'Never dispatched', command: 'll', enabled: true, delaySeconds: 0, ssh: { intent: 'script' } },
        ],
        timeoutSeconds: 1, repeatSeconds: 1, start: null,
        serial: { lineEnding: 'none', prompt: '', timestampPrefix: '' },
    };
    const unchangedPlan = JSON.stringify(plan);
    const unrelated = () => {};
    channel.on('data', unrelated); channel.stderr.on('data', unrelated);
    try {
        Object.defineProperty(globalThis, 'setTimeout', { ...descriptors.get('setTimeout'), value: (cb: () => void, ms: number) => schedule(cb, ms, false) });
        Object.defineProperty(globalThis, 'setInterval', { ...descriptors.get('setInterval'), value: (cb: () => void, ms: number) => schedule(cb, ms, true) });
        for (const name of ['clearTimeout', 'clearInterval']) Object.defineProperty(globalThis, name, { ...descriptors.get(name), value: clear });
        Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => now });
        Object.defineProperty(Date, 'now', { ...dateDescriptor, value: () => wall + now });
        running = runner.start(plan, backend);
        void running.then(() => { settled = true; }, () => { settled = true; });
        await until(() => current?.observations === 1 && actor?.ownershipSnapshot.pendingBytes === 0, 'startup observation');
        advance();
        await until(() => channel.writes.length === 1, 'cd write');
        assert.deepEqual(channel.writes[0], Buffer.from('cd /\r'));
        channel.acknowledgeWrite(); channel.emit('data', Buffer.from('/\r\nmemory# '));
        await until(() => current?.observations === 2 && actor?.ownershipSnapshot.pendingBytes === 0, 'cd output persisted');
        advance();
        await until(() => channel.writes.length === 2, 'explicit Enter write');
        assert.deepEqual(channel.writes[1], Buffer.from('\r'));
        channel.acknowledgeWrite(); channel.emit('data', Buffer.from('\r\nmemory# '));
        await until(() => current?.observations === 3 && actor?.ownershipSnapshot.pendingBytes === 0, 'Enter output persisted');
        advance();
        await until(() => resultHeld, 'Enter result callback');
        const retainedRows = JSON.stringify(rows), retainedOutcomes = JSON.stringify(outcomes);
        assert.deepEqual(prepared.map((s) => s.input), [{ intent: 'script', command: 'cd /' }, { intent: 'send-enter', command: '' }]);
        assert.deepEqual(rows.map((row) => [row.ordinal, row.command, row.completion, row.exitCode, row.consoleCapture?.intent]),
            [[1, 'cd /', 'prompt-observed', null, 'script'], [2, '', 'prompt-observed', null, 'send-enter']]);
        assert.equal(new Set(rows.map((row) => row.runId)).size, 1);
        assert.deepEqual(outcomes.map((o) => o.completion), ['prompt-observed', 'prompt-observed']);
        runner.cancel();
        await until(() => channel.closeRequests === 1, 'owned close requested');
        assert.equal(runner.busy, true); assert.equal(settled, false);
        assert.throws(() => runner.start(plan, backend), /already armed/);
        resultGate.release(); await pump();
        assert.equal(settled, false); assert.equal(closeCount, 0); assert.equal(releaseCount, 0);
        channel.emit('close'); await pump();
        assert.equal(actor!.ownershipSnapshot.outputDrain, 1); assert.equal(closeCount, 0);
        channel.endReadable(); await pump();
        assert.equal(actor!.ownershipSnapshot.extendedDrain, 1); assert.equal(closeCount, 0);
        channel.stderr.endReadable();
        await until(() => closeCount === 1, 'journal close requested');
        assert.equal(settled, false); assert.equal(runner.busy, true); assert.equal(actor!.owned, true);
        assert.equal(releaseCount, 0); assert.equal(actions.includes('release'), false);
        closeGate.release(); await until(() => settled, 'flow and exact-owner release');
        await running;
        assert.equal(runner.busy, false); assert.equal(runner.cleanupPending, false);
        assert.equal(states.at(-1)?.state, 'paused'); assert.match(states.at(-1)!.message, /cancelled/i);
        assert.ok(states.every((state) => state.state !== 'finished'));
        assert.deepEqual(channel.writes.map((b) => b.toString()), ['cd /\r', '\r']);
        assert.equal(sleeps, 0); assert.equal(openCount, 1); assert.equal(channel.closeRequests, 1);
        assert.equal(actions.filter((a) => a === 'step').length, 2);
        assert.equal(actions.filter((a) => a === 'finish').length, 1);
        assert.equal(actions.filter((a) => a === 'release').length, 1);
        assert.equal(closeCount, 1); assert.equal(releaseCount, 1); assert.equal(host.ownershipSnapshot.activeStates, 0);
        assert.equal(actor!.ownershipSnapshot.listeners, 0); assert.equal(actor!.ownershipSnapshot.abortListeners, 0);
        assert.equal(JSON.stringify(rows), retainedRows); assert.equal(JSON.stringify(outcomes), retainedOutcomes);
        assert.equal(JSON.stringify(plan), unchangedPlan);
        assert.ok(trace.indexOf('journal-close-ack') < trace.indexOf('lease-release'));
        assert.deepEqual(channel.listeners('data'), [unrelated]);
        assert.deepEqual(channel.stderr.listeners('data'), [unrelated]);
        assert.equal(timers.size, 0);
    } finally {
        // Release only private fake gates/callbacks, with a bounded Promise drain.
        // No second cancellation/close invocation, real resource cleanup or signals.
        resultGate.release(); closeGate.release(); channel.acknowledgeWrite();
        channel.emit('close'); channel.endReadable(); channel.stderr.endReadable();
        try { await pump(); }
        finally {
            for (const [name, descriptor] of descriptors) Object.defineProperty(globalThis, name, descriptor);
            if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
            else Reflect.deleteProperty(performance, 'now');
            Object.defineProperty(Date, 'now', dateDescriptor);
            for (const [name, descriptor] of descriptors) assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), descriptor);
            assert.deepEqual(Object.getOwnPropertyDescriptor(performance, 'now'), nowDescriptor);
            assert.deepEqual(Object.getOwnPropertyDescriptor(Date, 'now'), dateDescriptor);
            t.diagnostic(JSON.stringify({ restored: true, virtualTimers: timers.size, settled, openCount, closeCount,
                releaseCount, closeRequests: channel.closeRequests, actions, trace }));
        }
    }
});
