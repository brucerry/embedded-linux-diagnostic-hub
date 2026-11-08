import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Client as TransportClient } from 'ssh2';
import { DeviceMonitor } from '../backend/ssh/monitor';
import { DesktopConnectionAttempts } from '../electron/connection-attempts';
import {
    consoleHeader,
    consoleSegment,
    type ConsoleRepository,
    type ConsoleSnapshot,
} from '../shared/console-journal';
import { consoleSnapshot } from '../shared/console-storage';
import { bytesBase64 } from '../shared/capture-store';
import { sshInputBytes } from '../shared/ssh-console';
import { Client, observe } from './fixtures/ssh-memory-client';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}
async function pump() {
    for (let turn = 0; turn < 64; turn++) await Promise.resolve();
}
async function until(check: () => boolean, label: string) {
    for (let turn = 0; turn < 256; turn++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.ok(check(), label + ' did not settle within 256 logical turns');
}
function strict<T extends object>(object: T): T {
    return new Proxy(object, {
        get(target, key, receiver) {
            if (!Object.hasOwn(target, key))
                throw Error('Unexpected memory repository access: ' + String(key));
            return Reflect.get(target, key, receiver);
        },
    });
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
        throw Error('Unexpected buffered memory-channel read');
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
    closeRequests = 0;
    closeAcknowledged = false;
    writes: Buffer[] = [];
    writeAcknowledgements = 0;
    private pendingWrite?: (error?: Error | null) => void;
    close() {
        assert.equal(++this.closeRequests, 1, 'Actual actor must request channel close once');
        return this;
    }
    acknowledgeClose() {
        if (!this.closeAcknowledged) {
            this.closeAcknowledged = true;
            this.emit('close');
        }
    }
    write(bytes: Buffer, callback: (error?: Error | null) => void) {
        assert.equal(this.writes.length, 0);
        assert.ok(bytes.length <= 8193);
        this.writes.push(Buffer.from(bytes));
        this.pendingWrite = callback;
        return true;
    }
    acknowledgeWrite() {
        const callback = this.pendingWrite;
        this.pendingWrite = undefined;
        if (callback) {
            this.writeAcknowledgements++;
            callback();
        }
    }
}

test(
    'actual desktop replacement waits active console channel, drains, write, storage and physical owners',
    {
        concurrency: false,
        // Ordinary discovery must not turn this memory case into installed ssh2 transport.
        skip: Object.is(TransportClient, Client)
            ? false
            : 'Requires reviewed ssh2 memory compiler alias',
    },
    async (t) => {
        assert.strictEqual(TransportClient, Client);
        assert.equal(Client.instances.length, 0);
        const descriptors = new Map(
            ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map((name) => [
                name,
                Object.getOwnPropertyDescriptor(globalThis, name)!,
            ]),
        );
        const performanceDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
        const dateDescriptor = Object.getOwnPropertyDescriptor(Date, 'now')!;
        const shellDescriptor = Object.getOwnPropertyDescriptor(Client.prototype, 'shell')!;
        assert.equal(typeof shellDescriptor.value, 'function');
        const wallBase = Date.UTC(2026, 9, 30);
        const timers = new Map<object, { at: number; repeat: boolean; run: () => void }>();
        let mono = 0,
            timerId = 0,
            fired = 0,
            unrefs = 0,
            shellCalls = 0;
        const schedule = (run: () => void, delay: number, repeat: boolean) => {
            assert.equal(typeof run, 'function');
            assert.ok(repeat ? delay === 250 : delay === 10 || delay === 60000);
            assert.ok(++timerId <= 16, 'Bound all virtual scheduling');
            const handle = Object.freeze({
                id: timerId,
                unref() {
                    unrefs++;
                },
            });
            timers.set(handle, { at: mono + delay, repeat, run });
            return handle;
        };
        const clear = (handle: object | undefined) => {
            if (handle) timers.delete(handle);
        };
        const observationGate = gate(),
            journalCloseGate = gate();
        const channel = new MemoryChannel();
        const trace: string[] = [];
        const counts = {
            operations: 0,
            observations: 0,
            journalCloses: 0,
            factories: 0,
            sessionReleases: 0,
        };
        let snapshot: ConsoleSnapshot | null = null,
            resourceClosed = false;
        const current = () => {
            assert.ok(snapshot);
            return snapshot;
        };
        const touch = (name: string) => {
            assert.ok(++counts.operations <= 32);
            trace.push(name);
            if (snapshot) {
                snapshot.records++;
                snapshot.offset++;
            }
        };
        const store = strict({
            then: undefined,
            get snapshot() {
                return snapshot ? consoleSnapshot(structuredClone(snapshot)) : null;
            },
            get resourceClosed() {
                return resourceClosed;
            },
            async begin(header: Parameters<ConsoleRepository['begin']>[0]) {
                assert.equal(snapshot, null);
                touch('begin');
                snapshot = consoleSnapshot({
                    schema: 2,
                    header: consoleHeader({
                        ...header,
                        schema: 2,
                        id: '00000000-0000-4000-8000-000000000078',
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
                return structuredClone(snapshot);
            },
            async start() {
                touch('start');
                return ++current().segments;
            },
            async inputSent() {
                touch('input-sent');
            },
            async discardPreparation() {
                touch('discard-preparation');
            },
            async observe(bytes: Uint8Array) {
                assert.ok(++counts.observations <= 2);
                touch('observe-enter-' + counts.observations);
                if (counts.observations === 2) await observationGate.promise;
                current().bytes += bytes.length;
                current().observations++;
                trace.push('observe-ack-' + counts.observations);
            },
            async end() {
                touch('end');
            },
            async outcome() {
                touch('outcome');
            },
            async finish(reason: string, observed: number, closed: true) {
                touch('finish');
                assert.equal(observed, current().bytes);
                assert.equal(closed, true);
                Object.assign(current(), {
                    state: 'incomplete',
                    reason,
                    observedBytes: observed,
                    shellClosed: true,
                    finalizedAt: new Date().toISOString(),
                });
                return structuredClone(current());
            },
            async fail(): Promise<never> {
                throw Error('Unexpected memory metadata-failure route');
            },
            async close() {
                assert.equal(++counts.journalCloses, 1);
                trace.push('journal-close-enter');
                await journalCloseGate.promise;
                resourceClosed = true;
                trace.push('journal-close-ack');
            },
        }) as unknown as ConsoleRepository;
        const monitor = new DeviceMonitor(() => {
            counts.sessionReleases++;
            trace.push('actual-session-console-release');
        });
        const attempts = new DesktopConnectionAttempts(monitor);
        const pending: { done: boolean; error?: unknown }[] = [];
        const track = <T>(promise: Promise<T>) => {
            const item = observe(promise);
            pending.push(item);
            return item;
        };
        const start = (id: string) =>
            attempts.connect(id, (signal) =>
                monitor.configure(
                    {
                        host: 'synthetic.invalid',
                        port: 22,
                        username: 'synthetic',
                        auth: 'password',
                        password: 'SYNTHETIC_PLACEHOLDER',
                    },
                    async () => {
                        throw Error('Unexpected host-key verification');
                    },
                    undefined,
                    signal,
                ),
            );
        const unrelated = () => {};
        channel.on('data', unrelated);
        channel.stderr.on('data', unrelated);
        let failed = false,
            failure: unknown;
        const retain = (error: unknown) => {
            failure = failed
                ? new AggregateError(
                      [failure, error],
                      'Combined case and fixture settlement failed',
                  )
                : error;
            failed = true;
        };
        const snapshots: unknown[] = [];
        try {
            const install = (name: string, value: unknown) =>
                Object.defineProperty(globalThis, name, { ...descriptors.get(name), value });
            install('setTimeout', (run: () => void, delay: number) => schedule(run, delay, false));
            install('setInterval', (run: () => void, delay: number) => schedule(run, delay, true));
            install('clearTimeout', clear);
            install('clearInterval', clear);
            Object.defineProperty(performance, 'now', {
                configurable: true,
                writable: true,
                value: () => mono,
            });
            Object.defineProperty(Date, 'now', { ...dateDescriptor, value: () => wallBase + mono });
            Object.defineProperty(Client.prototype, 'shell', {
                ...shellDescriptor,
                value: function (this: Client, ...args: unknown[]) {
                    assert.strictEqual(this, Client.instances[0]);
                    assert.equal(++shellCalls, 1);
                    assert.equal(args.length, 2);
                    assert.deepEqual(args[0], { term: 'xterm-256color', rows: 40, cols: 120 });
                    const callback = args[1];
                    assert.equal(typeof callback, 'function');
                    (callback as (error: undefined, value: MemoryChannel) => void)(
                        undefined,
                        channel,
                    );
                    channel.emit('data', Buffer.from('memory# '));
                    return this;
                },
            });

            const first = track(start('1'.repeat(32)));
            await until(() => Client.instances.length === 1, 'first memory client');
            Client.instances[0].ready();
            await until(() => first.done, 'first ready');
            assert.equal(first.error, undefined);
            assert.equal(attempts.busy, false);
            const oldConnection = monitor.automationConnection;
            assert.ok(oldConnection);
            const factory = async () => {
                assert.equal(++counts.factories, 1);
                return store;
            };
            const caps = (await monitor.automationConsole(
                { protocol: 1, action: 'capabilities' },
                factory,
            )) as { epoch: string };
            const owner = (await monitor.automationConsole(
                {
                    protocol: 1,
                    action: 'open',
                    epoch: caps.epoch,
                    id: 'combined-memory-console',
                    connection: oldConnection,
                    ready: { role: 'shell-prompt', literals: ['memory# '] },
                    timeoutMs: 1000,
                },
                factory,
            )) as { protocol: 1; id: string; connection: string; capability: string };
            await until(
                () =>
                    counts.observations === 1 &&
                    monitor.ownershipSnapshot.console?.actor?.pendingBytes === 0,
                'startup stored',
            );
            mono += 100; // Actual SshSession uses a 100ms prompt quiet interval.
            for (const [handle, timer] of [...timers]) {
                if (timer.at <= mono) {
                    assert.equal(timer.repeat, false);
                    assert.ok(++fired <= 4);
                    timers.delete(handle);
                    timer.run();
                }
            }
            await until(
                () => monitor.ownershipSnapshot.console?.opening === 0,
                'actual host ready',
            );
            const ready = (await monitor.automationConsole(
                { ...owner, action: 'status' },
                factory,
            )) as { phase: string };
            assert.equal(ready.phase, 'ready');
            const input = { intent: 'script' as const, command: 'pwd' };
            const segment = consoleSegment({
                kind: 'command',
                runId: 'combined-run',
                stepId: 'combined-step',
                ordinal: 1,
                name: 'Synthetic',
                input,
                requestBase64: bytesBase64(sshInputBytes('console', input)),
                criterion: { role: 'shell-prompt', literals: ['memory# '] },
            });
            const step = track(
                monitor.automationConsole(
                    { ...owner, action: 'step', sequence: 0, segment, timeoutMs: 1000 },
                    factory,
                ),
            );
            await until(() => channel.writes.length === 1, 'one synthetic Script');
            assert.deepEqual(channel.writes[0], Buffer.from('pwd\r'));
            channel.emit('data', Buffer.from('held observation'));
            await until(() => counts.observations === 2, 'second observation pending');

            const replacement = track(start('2'.repeat(32)));
            await until(() => channel.closeRequests === 1, 'actual invalidation close request');
            const held = async (phase: string) => {
                await pump();
                assert.equal(
                    Client.instances.length,
                    1,
                    'No replacement client before all owned ACKs',
                );
                assert.equal(replacement.done, false);
                assert.equal(attempts.busy, true);
                assert.equal(attempts.snapshot?.id, '2'.repeat(32));
                assert.equal(monitor.isConnected, false);
                assert.equal(counts.sessionReleases, 0);
                assert.equal(monitor.ownershipSnapshot.consoleActor, 1);
                snapshots.push({
                    phase,
                    owners: structuredClone(monitor.ownershipSnapshot),
                    journalCloses: counts.journalCloses,
                    writeACKs: channel.writeAcknowledgements,
                });
            };
            await held('all seven acknowledgements held');
            assert.equal(Client.instances[0].destroyCalls, 1);
            Client.instances[0].closeOwned();
            await held('physical transport acknowledged only');
            assert.equal(monitor.ownershipSnapshot.connections[0]?.transport, 0);
            assert.equal(monitor.ownershipSnapshot.connections[0]?.channels, 1);
            channel.acknowledgeClose();
            await held('channel close acknowledged; drains still owned');
            assert.equal(monitor.ownershipSnapshot.console?.actor?.outputDrain, 1);
            channel.endReadable();
            await held('stdout EOF acknowledged; stderr still owned');
            assert.equal(monitor.ownershipSnapshot.console?.actor?.extendedDrain, 1);
            channel.stderr.endReadable();
            await held('stderr EOF acknowledged; write callback still owned');
            assert.equal(monitor.ownershipSnapshot.console?.actor?.write, 1);
            assert.equal(counts.journalCloses, 0);
            channel.acknowledgeWrite();
            await held('write acknowledged; observation still pending');
            assert.equal(monitor.ownershipSnapshot.console?.actor?.write, 0);
            assert.ok((monitor.ownershipSnapshot.console?.actor?.pendingBytes ?? 0) > 0);
            assert.equal(counts.journalCloses, 0);
            observationGate.release();
            await until(() => counts.journalCloses === 1, 'actual journal close request');
            await held('observation acknowledged; journal close still pending');
            journalCloseGate.release();
            await until(
                () => Client.instances.length === 2,
                'replacement admitted after every ACK',
            );
            assert.equal(resourceClosed, true);
            assert.equal(counts.sessionReleases, 1);
            assert.equal(monitor.ownershipSnapshot.consoleActor, 0);
            assert.equal(monitor.ownershipSnapshot.console, null);
            assert.equal(channel.closeRequests, 1);
            assert.equal(channel.writeAcknowledgements, 1);
            assert.equal(counts.journalCloses, 1);
            assert.ok(
                trace.indexOf('journal-close-ack') <
                    trace.indexOf('actual-session-console-release'),
            );
            assert.equal(channel.listeners('data').length, 1);
            assert.equal(channel.stderr.listeners('data').length, 1);
            assert.equal(channel.listeners('data')[0], unrelated);
            assert.equal(channel.stderr.listeners('data')[0], unrelated);
            assert.equal(channel.listeners('close').length, 0);
            assert.equal(channel.listeners('end').length, 0);
            assert.equal(channel.stderr.listeners('end').length, 0);
            Client.instances[1].ready();
            await until(
                () => replacement.done && step.done,
                'replacement authenticated and old step settled',
            );
            assert.equal(replacement.error, undefined);
            assert.ok(step.error instanceof Error, 'Interrupted old step must not report success');
            assert.equal(monitor.isConnected, true);
            assert.notEqual(monitor.automationConnection, oldConnection);
            assert.equal(
                Client.instances[1].closed,
                false,
                'Live success must not wait for its own closure',
            );
            assert.equal(attempts.busy, false);
            assert.equal(timers.size, 0);
            assert.equal(shellCalls, 1);
            assert.equal(unrefs, 1);
            assert.equal(counts.observations, 2);
            assert.equal(current().shellClosed, true);
        } catch (error) {
            retain(error);
        } finally {
            // Settle only this fixture's external callbacks/gates; never fabricate product ownership.
            channel.acknowledgeWrite();
            channel.acknowledgeClose();
            channel.endReadable();
            channel.stderr.endReadable();
            observationGate.release();
            journalCloseGate.release();
            try {
                const active = attempts.snapshot;
                const cancelled = active ? track(attempts.cancel(active.id)) : undefined;
                monitor.clear();
                for (const client of Client.instances) client.closeOwned();
                const joined = track(monitor.joinCleanup());
                for (const item of pending)
                    await until(() => item.done, 'observed memory operation during unwind');
                if (cancelled?.error) throw cancelled.error;
                if (joined.error) throw joined.error;
                assert.equal(monitor.hasResources, false);
                assert.equal(attempts.busy, false);
                assert.equal(timers.size, 0);
                for (const client of Client.instances) {
                    assert.equal(client.closed, true);
                    client.removeAllListeners();
                }
                Client.instances.length = 0;
            } catch (error) {
                retain(error);
            } finally {
                Object.defineProperty(Client.prototype, 'shell', shellDescriptor);
                for (const [name, descriptor] of descriptors)
                    Object.defineProperty(globalThis, name, descriptor);
                if (performanceDescriptor)
                    Object.defineProperty(performance, 'now', performanceDescriptor);
                else Reflect.deleteProperty(performance, 'now');
                Object.defineProperty(Date, 'now', dateDescriptor);
                assert.deepEqual(
                    Object.getOwnPropertyDescriptor(Client.prototype, 'shell'),
                    shellDescriptor,
                );
                for (const [name, descriptor] of descriptors)
                    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), descriptor);
                assert.deepEqual(
                    Object.getOwnPropertyDescriptor(performance, 'now'),
                    performanceDescriptor,
                );
                assert.deepEqual(Object.getOwnPropertyDescriptor(Date, 'now'), dateDescriptor);
                t.diagnostic(
                    JSON.stringify({
                        restored: true,
                        virtualTimers: timers.size,
                        clients: Client.instances.length,
                        shellCalls,
                        channelCloses: channel.closeRequests,
                        channelWriteACKs: channel.writeAcknowledgements,
                        counts,
                        trace,
                        snapshots,
                    }),
                );
            }
        }
        if (failed) throw failure;
    },
);
