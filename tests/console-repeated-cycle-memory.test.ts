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
    consoleHeader,
    consoleSegment,
    type ConsoleRepository,
    type ConsoleSnapshot,
    type ConsoleMatch,
    type ConsoleCompletionReason,
} from '../shared/console-journal';
import { consoleSnapshot } from '../shared/console-storage';
import { CONSOLE_IDLE_RENEWAL_MS } from '../shared/console-rpc';

// Public memory boundaries from console-between-command-cancel-memory.test.ts;
// product runner/backend/client/host/actor are imported, never reimplemented.
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}
async function pump() {
    for (let i = 0; i < 256; i++) await Promise.resolve();
}
async function until(check: () => boolean, label: string) {
    for (let i = 0; i < 256 && !check(); i++) await Promise.resolve();
    assert.ok(check(), 'Memory cycle boundary not reached: ' + label);
}
class ReadableSide extends EventEmitter {
    readableLength = 0;
    readableEnded = false;
    pause() {
        return this;
    }
    resume() {
        return this;
    }
    read(): never {
        throw Error('No buffered channel reads are admitted.');
    }
    endReadable() {
        if (!this.readableEnded) {
            this.readableEnded = true;
            this.emit('end');
        }
    }
}
class MemoryChannel extends ReadableSide {
    stderr = new ReadableSide();
    writes: Buffer[] = [];
    closeRequests = 0;
    private callback?: (error?: Error | null) => void;
    close() {
        assert.equal(++this.closeRequests, 1);
        return this;
    }
    write(bytes: Buffer, callback: (error?: Error | null) => void) {
        assert.equal(this.callback, undefined);
        assert.equal(this.writes.length, 0);
        assert.ok(bytes.length <= 8193);
        this.writes.push(Buffer.from(bytes));
        this.callback = callback;
        return true;
    }
    acknowledgeWrite(error?: Error) {
        const callback = this.callback;
        this.callback = undefined;
        callback?.(error);
    }
}
type Mode = 'success' | 'cancel' | 'write-error';
interface Arm {
    index: number;
    mode: Mode;
    channel: MemoryChannel;
    closeGate: ReturnType<typeof gate>;
    journal: ConsoleRepository;
    snapshot: ConsoleSnapshot | null;
    actor?: PersistentSshConsole;
    resourceClosed: boolean;
    operations: number;
    opens: number;
    sent: number;
    closes: number;
    releases: number;
    settled: boolean;
    actions: string[];
    rpcTasks: Set<Promise<unknown>>;
    outcomes: { completion: ConsoleCompletionReason; match: ConsoleMatch | null; exitCode: null }[];
    command: string;
    unrelated: () => void;
    task?: Promise<void>;
}

test(
    'one runner and console host retire success, Cancel and acknowledged write error before successful rearm',
    { concurrency: false },
    async (t) => {
        const timerNames = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
        const descriptors = new Map(
            timerNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)!]),
        );
        const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
        const dateDescriptor = Object.getOwnPropertyDescriptor(Date, 'now')!;
        const wall = Date.parse('2026-10-30T00:00:00.000Z');
        let now = 0,
            handles = 0,
            callbacks = 0,
            sleeps = 0,
            leased: number | null = null;
        const timers = new Map<
            object,
            { at: number; delay: number; repeat: boolean; callback: () => void }
        >();
        const schedule = (callback: () => void, delay: number, repeat: boolean) => {
            assert.equal(typeof callback, 'function');
            assert.ok(repeat ? delay === 250 : delay === 10 || delay === CONSOLE_IDLE_RENEWAL_MS);
            assert.ok(++handles <= 128);
            const handle = Object.freeze({ id: handles, unref() {} });
            timers.set(handle, { at: now + delay, delay, repeat, callback });
            return handle;
        };
        const clear = (handle: object | undefined) => {
            if (handle) timers.delete(handle);
        };
        const advance = () => {
            now += 60;
            for (const [handle, timer] of [...timers])
                if (timer.at <= now) {
                    assert.ok(++callbacks <= 24);
                    if (timer.repeat) timer.at = now + timer.delay;
                    else timers.delete(handle);
                    timer.callback();
                }
        };
        const clock: RunClock = {
            local: () => wall + now,
            mono: () => now,
            sleep: async () => {
                sleeps++;
                throw Error('No schedule, delay or repeat sleep is admitted.');
            },
        };
        const states: FlowState[] = [],
            rows: AutomationRecord[] = [],
            arms: Arm[] = [];
        const summaries: object[] = [],
            preservedRows: string[] = [],
            preservedSnapshots: string[] = [];
        const writeFailure = Error('Synthetic write acknowledgement failure.');
        let active: Arm | undefined;
        const prompt = { role: 'shell-prompt' as const, literals: ['memory# '] };
        const connection = 'repeated-memory-console-connection';
        function makeArm(index: number, mode: Mode): Arm {
            const a: Arm = {
                index,
                mode,
                channel: new MemoryChannel(),
                closeGate: gate(),
                journal: undefined as unknown as ConsoleRepository,
                snapshot: null,
                resourceClosed: false,
                operations: 0,
                opens: 0,
                sent: 0,
                closes: 0,
                releases: 0,
                settled: false,
                actions: [],
                rpcTasks: new Set(),
                outcomes: [],
                command: 'phase-' + index,
                unrelated: () => {},
            };
            const touch = () => {
                assert.ok(++a.operations <= 40);
                if (a.snapshot) {
                    a.snapshot.records++;
                    a.snapshot.offset++;
                }
            };
            const journal: ConsoleRepository = {
                get snapshot() {
                    return a.snapshot ? consoleSnapshot(structuredClone(a.snapshot)) : null;
                },
                get resourceClosed() {
                    return a.resourceClosed;
                },
                async begin(input) {
                    assert.equal(a.snapshot, null);
                    touch();
                    a.snapshot = consoleSnapshot({
                        schema: 2,
                        header: consoleHeader({
                            ...input,
                            schema: 2,
                            id: '00000000-0000-4000-8000-' + String(index + 81).padStart(12, '0'),
                        }),
                        state: 'active',
                        offset: 0,
                        records: 0,
                        bytes: 0,
                        observations: 0,
                        segments: 0,
                        finalizedAt: null,
                        reason: null,
                        observedBytes: null,
                        failure: null,
                        shellClosed: false,
                    });
                    return structuredClone(a.snapshot);
                },
                async start(input) {
                    const segment = consoleSegment(input);
                    if (segment.kind === 'command')
                        assert.deepEqual(segment.input, { intent: 'script', command: a.command });
                    touch();
                    return ++a.snapshot!.segments;
                },
                async inputSent() {
                    touch();
                    assert.equal(++a.sent, 1);
                },
                async discardPreparation(): Promise<never> {
                    throw Error('No unsent preparation is expected.');
                },
                async observe(bytes) {
                    assert.ok(bytes.length <= 32);
                    touch();
                    a.snapshot!.bytes += bytes.length;
                    a.snapshot!.observations++;
                },
                async end() {
                    touch();
                },
                async outcome(completion, match) {
                    touch();
                    a.outcomes.push({ completion, match, exitCode: null });
                },
                async finish(reason, observed, shellClosed) {
                    touch();
                    assert.equal(shellClosed, true);
                    assert.equal(observed, a.snapshot!.bytes);
                    assert.equal(
                        reason,
                        a.mode === 'success'
                            ? 'complete'
                            : a.mode === 'cancel'
                              ? 'cancelled'
                              : 'transport-error',
                    );
                    a.snapshot!.state = reason === 'complete' ? 'complete' : 'incomplete';
                    a.snapshot!.reason = reason;
                    a.snapshot!.observedBytes = observed;
                    a.snapshot!.shellClosed = true;
                    a.snapshot!.finalizedAt = new Date().toISOString();
                    return structuredClone(a.snapshot!);
                },
                async fail(): Promise<never> {
                    throw Error('No journal failure is admitted.');
                },
                async close() {
                    assert.equal(++a.closes, 1);
                    await a.closeGate.promise;
                    a.resourceClosed = true;
                },
            };
            a.journal = new Proxy(journal, {
                get(target, key, receiver) {
                    if (key === 'then') return undefined;
                    assert.ok(
                        Object.hasOwn(target, key),
                        'Unexpected journal property: ' + String(key),
                    );
                    return Reflect.get(target, key, receiver);
                },
            });
            a.channel.on('data', a.unrelated);
            a.channel.stderr.on('data', a.unrelated);
            return a;
        }
        const session = {
            automationConnection: connection,
            createAutomationConsole(
                remote: ConsoleRepository,
                selected: string,
                fresh: () => void,
            ) {
                const a = active!;
                assert.ok(a);
                assert.equal(a.actor, undefined);
                assert.equal(selected, connection);
                a.actor = new PersistentSshConsole(
                    {
                        acquire() {
                            assert.equal(leased, null);
                            leased = a.index;
                            return () => {
                                assert.equal(leased, a.index);
                                assert.equal(a.resourceClosed, true);
                                assert.equal(++a.releases, 1);
                                leased = null;
                            };
                        },
                        assertCurrent() {
                            assert.equal(active, a);
                            assert.equal(selected, connection);
                        },
                        assertFresh: fresh,
                        open(callback) {
                            assert.equal(++a.opens, 1);
                            callback(undefined, a.channel as unknown as ClientChannel);
                            a.channel.emit('data', Buffer.from('memory# '));
                        },
                    },
                    remote,
                    50,
                );
                return {
                    actor: a.actor,
                    signal: new AbortController().signal,
                    target: { endpoint: 'memory.invalid:22', username: 'synthetic' },
                };
            },
        } as unknown as SshSession;
        // Deliberately stable: these are not reconstructed between outcomes.
        const host = new SshConsoleHost(session, async () => {
            assert.ok(active);
            return active.journal;
        });
        const transport = {
            automationConnection: () => connection,
            automationConsole(request: Parameters<SshConsoleHost['dispatch']>[0]) {
                const a = active!;
                a.actions.push((request as { action: string }).action);
                const task = host.dispatch(request, 'local-client');
                a.rpcTasks.add(task);
                void task.finally(() => a.rpcTasks.delete(task)).catch(() => {});
                return task;
            },
        };
        const runner = new FlowRunner(
            (state) => states.push(state),
            (row) => {
                rows.push(structuredClone(row));
            },
            clock,
        );
        const modes: Mode[] = ['success', 'cancel', 'write-error', 'success'];
        try {
            Object.defineProperty(globalThis, 'setTimeout', {
                ...descriptors.get('setTimeout'),
                value: (cb: () => void, ms: number) => schedule(cb, ms, false),
            });
            Object.defineProperty(globalThis, 'setInterval', {
                ...descriptors.get('setInterval'),
                value: (cb: () => void, ms: number) => schedule(cb, ms, true),
            });
            for (const name of ['clearTimeout', 'clearInterval'])
                Object.defineProperty(globalThis, name, { ...descriptors.get(name), value: clear });
            Object.defineProperty(performance, 'now', {
                configurable: true,
                writable: true,
                value: () => now,
            });
            Object.defineProperty(Date, 'now', { ...dateDescriptor, value: () => wall + now });
            for (const [index, mode] of modes.entries()) {
                const a = makeArm(index, mode);
                arms.push(a);
                active = a;
                const backend = sshConsoleBackend(
                    transport,
                    'local-client',
                    { endpoint: 'synthetic repeated console' },
                    () => true,
                );
                const plan: AutomationPlan = {
                    transport: 'ssh',
                    ssh: { mode: 'console', ready: prompt, completion: prompt },
                    steps: [
                        {
                            id: 'one',
                            name: a.command,
                            enabled: true,
                            command: a.command,
                            delaySeconds: 0,
                            ssh: { intent: 'script' },
                        },
                    ],
                    timeoutSeconds: 1,
                    repeatSeconds: null,
                    start: null,
                    serial: { lineEnding: 'none', prompt: '', timestampPrefix: '' },
                };
                const unchangedPlan = JSON.stringify(plan),
                    stateStart = states.length;
                assert.equal(runner.busy, false);
                assert.equal(host.ownershipSnapshot.activeStates, 0);
                assert.equal(timers.size, 0);
                assert.equal(leased, null);
                a.task = runner.start(plan, backend);
                void a.task.then(
                    () => {
                        a.settled = true;
                    },
                    () => {
                        a.settled = true;
                    },
                );
                await until(
                    () =>
                        a.snapshot?.observations === 1 &&
                        a.actor?.ownershipSnapshot.pendingBytes === 0,
                    'startup ' + index,
                );
                advance();
                await until(
                    () => a.channel.writes.length === 1 && a.sent === 1,
                    'owned write ' + index,
                );
                await pump();
                assert.deepEqual(a.channel.writes, [Buffer.from(a.command + '\r')]);
                if (mode === 'success') {
                    a.channel.acknowledgeWrite();
                    a.channel.emit('data', Buffer.from('ok\r\nmemory# '));
                    await until(
                        () =>
                            a.snapshot?.observations === 2 &&
                            a.actor?.ownershipSnapshot.pendingBytes === 0,
                        'output ' + index,
                    );
                    advance();
                } else if (mode === 'cancel') {
                    runner.cancel();
                    a.channel.acknowledgeWrite();
                } else {
                    a.channel.acknowledgeWrite(writeFailure);
                }
                await until(() => a.channel.closeRequests === 1, 'channel closure ' + index);
                assert.equal(a.settled, false);
                assert.equal(runner.busy, true);
                assert.equal(leased, index);
                assert.throws(() => runner.start(plan, backend), /already armed/);
                a.channel.emit('close');
                a.channel.endReadable();
                a.channel.stderr.endReadable();
                await until(() => a.closes === 1, 'journal closure ' + index);
                assert.equal(a.settled, false);
                assert.equal(runner.busy, true);
                assert.equal(a.actor!.owned, true);
                assert.equal(a.releases, 0);
                assert.equal(a.actions.includes('release'), false);
                a.closeGate.release();
                await until(() => a.settled, 'settled ' + index);
                await a.task;
                await pump();
                assert.equal(runner.busy, false);
                assert.equal(runner.cleanupPending, false);
                assert.equal(leased, null);
                assert.equal(a.resourceClosed, true);
                assert.equal(a.releases, 1);
                assert.equal(a.opens, 1);
                assert.equal(a.closes, 1);
                assert.equal(a.channel.closeRequests, 1);
                assert.equal(a.actor!.owned, false);
                assert.equal(a.actor!.ownershipSnapshot.listeners, 0);
                assert.equal(a.actor!.ownershipSnapshot.abortListeners, 0);
                assert.equal(a.actor!.ownershipSnapshot.pendingBytes, 0);
                assert.equal(a.rpcTasks.size, 0);
                assert.equal(timers.size, 0);
                assert.equal(a.actions.filter((action) => action === 'step').length, 1);
                assert.equal(a.actions.filter((action) => action === 'finish').length, 1);
                assert.equal(a.actions.filter((action) => action === 'release').length, 1);
                assert.deepEqual(a.channel.listeners('data'), [a.unrelated]);
                assert.deepEqual(a.channel.stderr.listeners('data'), [a.unrelated]);
                const owned = host.ownershipSnapshot;
                assert.deepEqual(
                    [
                        owned.activeStates,
                        owned.actors,
                        owned.opening,
                        owned.executing,
                        owned.closing,
                        owned.heartbeatTimers,
                    ],
                    [0, 0, 0, 0, 0, 0],
                );
                assert.equal(owned.port, null);
                assert.equal(owned.terminalReceipts, index + 1); // Retained statuses are intentional.
                assert.equal(owned.receiptLimit, 128);
                assert.equal(owned.receiptTtlMs, 600000);
                assert.ok(owned.terminalReceiptBytes > 0);
                assert.equal(rows.length, index + 1);
                assert.equal(rows[index].command, a.command);
                assert.equal(
                    rows[index].completion,
                    mode === 'success'
                        ? 'prompt-observed'
                        : mode === 'cancel'
                          ? 'cancelled'
                          : 'transport-error',
                );
                assert.equal(rows[index].exitCode, null);
                if (mode === 'write-error') assert.equal(rows[index].stderr, writeFailure.message);
                assert.equal(states.at(-1)?.state, mode === 'success' ? 'finished' : 'paused');
                if (mode !== 'success')
                    assert.ok(
                        states.slice(stateStart).every((state) => state.state !== 'finished'),
                    );
                assert.equal(a.outcomes.length, 1);
                assert.equal(
                    a.outcomes[0].completion,
                    mode === 'success'
                        ? 'prompt-observed'
                        : mode === 'cancel'
                          ? 'cancelled'
                          : 'transport-error',
                );
                assert.equal(a.snapshot!.state, mode === 'success' ? 'complete' : 'incomplete');
                assert.equal(a.snapshot!.shellClosed, true);
                assert.equal(JSON.stringify(plan), unchangedPlan);
                for (let old = 0; old < index; old++) {
                    assert.equal(JSON.stringify(rows[old]), preservedRows[old]);
                    assert.equal(JSON.stringify(arms[old].snapshot), preservedSnapshots[old]);
                }
                preservedRows.push(JSON.stringify(rows[index]));
                preservedSnapshots.push(JSON.stringify(a.snapshot));
                summaries.push({
                    index,
                    mode,
                    terminal: states.at(-1)?.state,
                    completion: rows[index].completion,
                    activeStates: owned.activeStates,
                    timers: timers.size,
                    inflightRPCs: a.rpcTasks.size,
                    ownedListeners: a.actor!.ownershipSnapshot.listeners,
                    terminalReceipts: owned.terminalReceipts,
                    opens: a.opens,
                    closes: a.closes,
                    releases: a.releases,
                });
            }
            assert.equal(new Set(rows.map((row) => row.runId)).size, 4);
            assert.equal(new Set(arms.map((a) => a.snapshot!.header.flowId)).size, 4);
            assert.equal(new Set(arms.map((a) => a.snapshot!.header.id)).size, 4);
            assert.equal(new Set(arms.map((a) => a.actor)).size, 4);
            assert.equal(new Set(arms.map((a) => a.journal)).size, 4);
            assert.equal(transport.automationConnection(), connection);
            assert.equal(sleeps, 0);
        } finally {
            // Only already-owned in-memory events/gates; no second Cancel/close or real cleanup.
            for (const a of arms) {
                a.closeGate.release();
                a.channel.acknowledgeWrite();
                a.channel.emit('close');
                a.channel.endReadable();
                a.channel.stderr.endReadable();
            }
            try {
                await pump();
            } finally {
                for (const [name, descriptor] of descriptors)
                    Object.defineProperty(globalThis, name, descriptor);
                if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
                else Reflect.deleteProperty(performance, 'now');
                Object.defineProperty(Date, 'now', dateDescriptor);
                for (const [name, descriptor] of descriptors)
                    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), descriptor);
                assert.deepEqual(
                    Object.getOwnPropertyDescriptor(performance, 'now'),
                    nowDescriptor,
                );
                assert.deepEqual(Object.getOwnPropertyDescriptor(Date, 'now'), dateDescriptor);
                t.diagnostic(
                    JSON.stringify({
                        restored: true,
                        virtualTimers: timers.size,
                        leased,
                        summaries,
                        retainedRows: rows.length,
                        createdArms: arms.length,
                        sameHostAndRunner: true,
                    }),
                );
            }
        }
    },
);
