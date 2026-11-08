import test from 'node:test';
import assert from 'node:assert/strict';
import { startBrowserCaptureExport } from '../src/features/automation/capture/browser-export';
import {
    CaptureExportBroker,
    type ExportReportSource,
} from '../src/features/automation/capture/export-broker';
import { ConsoleResultsOwner } from '../src/features/automation/capture/console-results-owner';
import { CaptureStorageError } from '../shared/capture-store';
import type { ConsoleArchive } from '../shared/console-storage';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}
function observe<T>(promise: Promise<T>) {
    const state: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
    void promise.then(
        (value) => {
            state.outcome = { ok: true, value };
        },
        (error) => {
            state.outcome = { ok: false, error };
        },
    );
    return state;
}
async function until(check: () => boolean, label: string) {
    for (let turn = 0; turn < 512; turn++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.fail('Bounded microtask gate did not settle: ' + label);
}
type Event = { source?: unknown; origin?: string; data?: unknown };
type Listener = (event: Event) => void;
class MemoryEvents {
    private listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, listener: Listener) {
        let set = this.listeners.get(type);
        if (!set) this.listeners.set(type, (set = new Set()));
        set.add(listener);
    }
    removeEventListener(type: string, listener: Listener) {
        this.listeners.get(type)?.delete(listener);
    }
    emit(type: string, event: Event) {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }
    count(type: string) {
        return this.listeners.get(type)?.size ?? 0;
    }
}
class MemoryPort {
    peer!: MemoryPort;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;
    postMessage(data: unknown) {
        assert.equal(this.closed, false, 'Worker may reply only through its owned open port');
        const receiver = this.peer;
        void Promise.resolve().then(() => {
            if (!receiver.closed) receiver.onmessage?.({ data });
        });
    }
    close() {
        this.closed = true;
    }
}
type Status = {
    type: string;
    id: string;
    state: string;
    retirement: string;
    bytes: number;
    error?: string;
    cleanupError?: string;
};
type Job = Awaited<ReturnType<CaptureExportBroker['prepare']>>;
type Plan = {
    label: string;
    pinGate?: ReturnType<typeof gate>;
    pinError?: Error;
    iteratorError?: Error;
    prepareGate?: ReturnType<typeof gate>;
    dropPrepare?: boolean;
    rejectCancelReply?: boolean;
    suppressFinal?: boolean;
};
type State = {
    plan: Plan;
    job?: Job;
    releaseCalls: number;
    released: boolean;
    iteratorFinally: number;
    cancelRequests: number;
    statuses: Status[];
};
type Request = {
    type: string;
    id?: string;
    format?: 'markdown';
    source?: 'console';
    scope?: { title: string };
};

// The pre-fix bug characterization is preserved with its exact source/bundle/receipts outside
// the candidate. This historical filename now holds corrected actual-stack safety regressions.
test('browser export retirement keeps actual broker/helper/view ownership until matching proof', async (t) => {
    const scope = 'https://memory.invalid/hub/',
        scriptURL = scope + 'capture-download-sw.js';
    const windowEvents = new MemoryEvents(),
        serviceEvents = new MemoryEvents(),
        unrelated = () => {};
    windowEvents.addEventListener('message', unrelated);
    serviceEvents.addEventListener('message', unrelated);
    serviceEvents.addEventListener('controllerchange', unrelated);
    const ports: MemoryPort[] = [];
    class MemoryChannel {
        port1 = new MemoryPort();
        port2 = new MemoryPort();
        constructor() {
            assert.ok(ports.length < 100);
            this.port1.peer = this.port2;
            this.port2.peer = this.port1;
            ports.push(this.port1, this.port2);
        }
    }
    const timers = new Map<object, { callback: () => void; delay: number; kind: string }>();
    const timer = (kind: string, callback: () => void, delay = 0) => {
        assert.ok(timers.size < 24);
        const handle = {};
        timers.set(handle, { kind, callback, delay });
        return handle;
    };
    const clear = (handle?: object) => {
        if (handle) timers.delete(handle);
    };
    const privateGates: ReturnType<typeof gate>[] = [];
    const held = () => {
        const value = gate();
        privateGates.push(value);
        return value;
    };
    const states: State[] = [],
        queued: Plan[] = [],
        byLabel = new Map<string, State>();
    const rpcTasks = new Set<Promise<void>>(),
        owners: ConsoleResultsOwner[] = [];
    const disposal: number[] = [],
        busy: boolean[] = [],
        diagnostics: { retirement: string; message: string }[][] = [];
    const frames: {
        src: string;
        hidden: boolean;
        title: string;
        isConnected: boolean;
        sandbox: { add(...flags: string[]): void };
    }[] = [];
    const assignments: string[] = [],
        withheld: Status[] = [];
    let broker!: CaptureExportBroker;
    const worker = {
        scriptURL,
        postMessage(request: Request, transfer: MemoryPort[]) {
            assert.equal(transfer.length, 1);
            const reply = transfer[0];
            const task = Promise.resolve().then(async () => {
                try {
                    let value: unknown;
                    if (request.type === 'capture-export-prepare') {
                        assert.equal(request.format, 'markdown');
                        assert.equal(request.source, 'console');
                        const job = await broker.prepare(
                            'owner',
                            request.format,
                            request.scope,
                            request.source,
                        );
                        const state = byLabel.get(request.scope!.title)!;
                        state.job = job;
                        await state.plan.prepareGate?.promise;
                        if (state.plan.dropPrepare) return;
                        value = job;
                    } else if (request.type === 'capture-export-cancel') {
                        const state = states.find((s) => s.job?.id === request.id)!;
                        assert.ok(state);
                        state.cancelRequests++;
                        const retirement = broker.cancel(request.id!, 'owner');
                        if (state.plan.rejectCancelReply) {
                            observe(retirement);
                            reply.postMessage({
                                ok: false,
                                error: 'synthetic cancellation reply uncertain',
                            });
                            return;
                        }
                        value = await retirement;
                    } else if (request.type === 'capture-export-status')
                        value = await broker.status(request.id!, 'owner');
                    else assert.fail('Unexpected worker request');
                    reply.postMessage({ ok: true, value });
                } catch (error) {
                    reply.postMessage({
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    });
                } finally {
                    reply.close();
                }
            });
            rpcTasks.add(task);
            void task.finally(() => rpcTasks.delete(task)).catch(() => {});
        },
    };
    const registration = { scope, active: worker };
    const services = Object.assign(serviceEvents, {
        controller: worker,
        ready: Promise.resolve(registration),
        async getRegistration(url: string) {
            assert.equal(url, scope);
            return registration;
        },
        async register(url: string, options: { scope: string }) {
            assert.equal(url, scriptURL);
            assert.equal(options.scope, scope);
            return registration;
        },
    });
    const document = {
        baseURI: scope,
        createElement(name: string) {
            assert.equal(name, 'iframe');
            assert.ok(frames.length < 4);
            let src = '';
            const frame = {
                get src() {
                    return src;
                },
                set src(value: string) {
                    src = value;
                    assignments.push(value);
                },
                hidden: false,
                title: '',
                isConnected: false,
                sandbox: {
                    add(...flags: string[]) {
                        assert.deepEqual(flags, [
                            'allow-scripts',
                            'allow-same-origin',
                            'allow-downloads',
                        ]);
                    },
                },
            };
            frames.push(frame);
            return frame;
        },
        body: {
            append(frame: (typeof frames)[number]) {
                assert.ok(frames.includes(frame));
                frame.isConnected = true;
            },
        },
    };
    const source: ExportReportSource = {
        filename: 'console-results',
        validateScope(input) {
            assert.ok(input && typeof input === 'object');
            const value = input as { title: string };
            assert.ok(queued.length || byLabel.has(value.title));
            return { title: value.title };
        },
        async pin() {
            const plan = queued.shift();
            assert.ok(plan);
            const state: State = {
                plan,
                releaseCalls: 0,
                released: false,
                iteratorFinally: 0,
                cancelRequests: 0,
                statuses: [],
            };
            states.push(state);
            byLabel.set(plan.label, state);
            return {
                through: 1,
                async release() {
                    assert.equal(++state.releaseCalls, 1, 'No release retry');
                    await plan.pinGate?.promise;
                    if (plan.pinError) throw plan.pinError;
                    state.released = true;
                },
            };
        },
        async *streamReport(format, input, _through, progress) {
            const state = byLabel.get(input.title!)!;
            try {
                await progress();
                if (state.plan.iteratorError) throw state.plan.iteratorError;
                yield new TextEncoder().encode(format === 'json' ? '{}' : '# memory\n');
            } finally {
                state.iteratorFinally++;
            }
        },
    };
    const legacy: ExportReportSource = {
        ...source,
        async pin() {
            assert.fail('No legacy storage route');
        },
    };
    const empty: ConsoleArchive = {
        async pin() {
            assert.fail('No view pin');
        },
        async list() {
            assert.fail('No catalog read');
        },
        async *read() {
            assert.fail('No record read');
        },
        async delete() {
            assert.fail('No deletion');
        },
    };
    const replacements: Record<string, unknown> = {
        window: windowEvents,
        document,
        navigator: { serviceWorker: services },
        location: { protocol: 'https:', origin: 'https://memory.invalid' },
        isSecureContext: true,
        MessageChannel: MemoryChannel,
        setTimeout: (callback: () => void, delay?: number) => timer('timeout', callback, delay),
        clearTimeout: clear,
        setInterval: (callback: () => void, delay?: number) => timer('interval', callback, delay),
        clearInterval: clear,
    };
    const originals = new Map(
        Object.keys(replacements).map((name) => [
            name,
            Object.getOwnPropertyDescriptor(globalThis, name),
        ]),
    );
    const failures: unknown[] = [],
        observations: Record<string, unknown> = {};
    const start = (plan: Plan) => {
        queued.push(plan);
        const index = owners.length;
        disposal.push(0);
        busy.push(false);
        diagnostics.push([]);
        const owner = new ConsoleResultsOwner(
            async () => ({
                archive: empty,
                dispose: async () => {
                    disposal[index]++;
                },
            }),
            (value) => {
                busy[index] = value;
            },
        );
        owners.push(owner);
        let job: Awaited<ReturnType<typeof startBrowserCaptureExport>> | undefined;
        const exported = observe(
            owner.export(async () => {
                job = await startBrowserCaptureExport(
                    'markdown',
                    { title: plan.label },
                    'console',
                    (value) => {
                        diagnostics[index].push(value);
                    },
                );
                return job;
            }),
        );
        return {
            index,
            owner,
            exported,
            get job() {
                return job;
            },
            state: () => byLabel.get(plan.label)!,
        };
    };
    const drain = async (job: Job) => {
        const frameId = 'frame-' + job.id;
        await broker.frame(job.nonce, frameId);
        const claim = await broker.claim(job.nonce, frameId);
        const download = await broker.download(new URL(claim.url).pathname.split('/').at(-1)!, {
            clientId: frameId,
            mode: 'navigate',
            referrer: job.frameUrl,
        });
        let bytes = 0,
            pulls = 0;
        for await (const part of download.stream) {
            assert.ok(++pulls <= 4);
            bytes += part.length;
            assert.ok(bytes <= 64);
        }
        await download.done;
        return bytes;
    };
    try {
        for (const [name, value] of Object.entries(replacements))
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        broker = new CaptureExportBroker(
            legacy,
            {
                scope,
                now: () => 0,
                client: async (id) =>
                    id === 'owner'
                        ? { id, url: scope, frameType: 'top-level' }
                        : (() => {
                              const state = states.find((s) => 'frame-' + s.job?.id === id);
                              return state?.job
                                  ? { id, url: state.job.frameUrl, frameType: 'nested' }
                                  : undefined;
                          })(),
                clients: async () => [{ id: 'owner', url: scope, frameType: 'top-level' }],
                notify: async (id, input) => {
                    assert.equal(id, 'owner');
                    const value = input as Status;
                    const state = states.find((s) => s.job?.id === value.id)!;
                    assert.ok(state);
                    state.statuses.push(value);
                    if (state.plan.suppressFinal && value.retirement === 'acknowledged')
                        withheld.push(value);
                    else serviceEvents.emit('message', { source: worker, data: value });
                },
            },
            60000,
            source,
        );
        // Held cleanup, repeated Cancel, no slot reuse, stale/foreign messages, then proof.
        const aGate = held(),
            a = start({ label: 'held cancellation', pinGate: aGate });
        await until(() => Boolean(a.job), 'A admitted');
        const aCancel = observe(a.job!.cancel()),
            aClose = observe(a.owner.close());
        const aDuplicate = observe(a.job!.cancel());
        await until(() => a.state().releaseCalls === 1, 'A final pin held');
        assert.equal(Boolean(aCancel.outcome), false);
        assert.equal(Boolean(aClose.outcome), false);
        assert.equal(Boolean(a.exported.outcome), false);
        assert.equal(a.state().cancelRequests, 1);
        assert.equal(disposal[a.index], 0);
        assert.equal(busy[a.index], true);
        assert.deepEqual(a.owner.resourceSnapshot, {
            pending: 1,
            export: true,
            closing: true,
            closed: false,
        });
        assert.deepEqual(
            [
                windowEvents.count('message'),
                serviceEvents.count('message'),
                serviceEvents.count('controllerchange'),
            ],
            [2, 2, 2],
        );
        const b = start({ label: 'success wins before Cancel', suppressFinal: true });
        await until(() => Boolean(b.job), 'B admitted');
        assert.equal(frames.length, 2, 'Held A slot cannot be reused');
        assert.equal(await drain(b.state().job!), 9);
        await until(() => withheld.length === 1, 'B final status withheld');
        const bCancel = observe(b.job!.cancel());
        await until(
            () => bCancel.outcome !== undefined && b.exported.outcome !== undefined,
            'stored success receipt answers late Cancel',
        );
        assert.equal(b.exported.outcome!.ok, true);
        assert.equal(b.state().releaseCalls, 1);
        const bReceipt = await broker.cancel(b.state().job!.id, 'owner');
        assert.equal(bReceipt.state, 'stream-sent');
        serviceEvents.emit('message', { source: worker, data: withheld[0] });
        serviceEvents.emit('message', {
            source: {},
            data: { ...bReceipt, type: 'capture-export-status', id: a.job!.id },
        });
        assert.equal(Boolean(a.exported.outcome), false);
        aGate.release();
        await until(
            () =>
                aClose.outcome !== undefined &&
                aCancel.outcome !== undefined &&
                aDuplicate.outcome !== undefined,
            'A acknowledged retirement',
        );
        assert.equal(a.exported.outcome!.ok, false);
        assert.equal(aClose.outcome!.ok, true);
        assert.equal(a.state().releaseCalls, 1);
        await b.owner.close();
        observations.heldAndSuccess = {
            heldPinReleaseCalls: a.state().releaseCalls,
            cancelRequests: a.state().cancelRequests,
            frames: frames.length,
            successOutcome: b.exported.outcome,
        };
        // Late admission after close: a negative RPC reply is diagnostic, never retirement.
        const cPrepare = held(),
            cPin = held();
        const c = start({
            label: 'late admission uncertain RPC',
            prepareGate: cPrepare,
            pinGate: cPin,
            rejectCancelReply: true,
        });
        await until(() => Boolean(c.state()?.job), 'C prepared before reply');
        const cClose = observe(c.owner.close());
        cPrepare.release();
        await until(
            () =>
                c.state().releaseCalls === 1 &&
                diagnostics[c.index].some((s) => s.retirement === 'blocked'),
            'C RPC rejected while pin held',
        );
        assert.equal(Boolean(c.exported.outcome), false);
        assert.equal(Boolean(cClose.outcome), false);
        assert.equal(disposal[c.index], 0);
        assert.equal(busy[c.index], true);
        services.controller = { scriptURL, postMessage: worker.postMessage };
        serviceEvents.emit('controllerchange', {});
        serviceEvents.emit('message', {
            source: services.controller,
            data: {
                type: 'capture-export-status',
                id: c.state().job!.id,
                retirement: 'acknowledged',
                state: 'failed',
                bytes: 0,
            },
        });
        assert.equal(Boolean(cClose.outcome), false);
        assert.equal(c.state().cancelRequests, 1);
        cPin.release();
        await until(() => cClose.outcome !== undefined, 'C genuine old-owner receipt');
        assert.equal(cClose.outcome!.ok, true);
        services.controller = worker;
        observations.lateAdmission = {
            disposed: disposal[c.index],
            cancelRequests: c.state().cancelRequests,
            diagnosticStates: diagnostics[c.index].map((x) => x.retirement),
        };
        // Rejected release is terminally blocked, retained and never retried.
        const pinError = new Error('synthetic pin-release rejection');
        const d = start({ label: 'release rejection', pinError });
        await until(() => Boolean(d.job), 'D admitted');
        const dCancel = observe(d.job!.cancel()),
            dClose = observe(d.owner.close());
        await until(
            () => diagnostics[d.index].some((x) => x.retirement === 'blocked'),
            'D blocked diagnostics',
        );
        const dStatus = await broker.status(d.job!.id, 'owner');
        assert.equal(dStatus.retirement, 'blocked');
        assert.equal(dStatus.state, 'closing');
        assert.ok('error' in dStatus && String(dStatus.error).includes('cancelled'));
        assert.ok(
            'cleanupError' in dStatus && String(dStatus.cleanupError).includes(pinError.message),
        );
        const repeated = observe(broker.cancel(d.job!.id, 'owner'));
        await until(() => repeated.outcome !== undefined, 'D repeated cancel rejection');
        assert.equal(repeated.outcome!.ok, false);
        if (!repeated.outcome!.ok) assert.equal(repeated.outcome!.error, pinError);
        assert.equal(d.state().releaseCalls, 1);
        assert.equal(Boolean(dCancel.outcome), false);
        assert.equal(Boolean(dClose.outcome), false);
        assert.equal(Boolean(d.exported.outcome), false);
        // A genuine earlier broker snapshot may arrive after its blocked notification.
        const oldPending = d.state().statuses.find((s) => s.retirement === 'pending');
        assert.ok(oldPending);
        serviceEvents.emit('message', { source: worker, data: oldPending });
        assert.equal(diagnostics[d.index].at(-1)!.retirement, 'blocked');
        assert.ok(diagnostics[d.index].at(-1)!.message.includes(pinError.message));
        // Unclassified iterator failure cannot be reinterpreted as successful nested closure.
        const iteratorError = new Error('synthetic encoder or nested-cleanup failure');
        const e = start({ label: 'unclassified iterator', iteratorError });
        await until(() => Boolean(e.job), 'E admitted');
        const eDownload = observe(drain(e.state().job!));
        await until(() => eDownload.outcome !== undefined, 'E verification fails');
        assert.equal(eDownload.outcome!.ok, false);
        if (!eDownload.outcome!.ok) assert.equal(eDownload.outcome!.error, iteratorError);
        await until(
            () => diagnostics[e.index].some((x) => x.retirement === 'blocked'),
            'E blocked',
        );
        const eStatus = await broker.status(e.job!.id, 'owner');
        assert.equal(eStatus.retirement, 'blocked');
        assert.equal(e.state().releaseCalls, 0);
        assert.equal(e.state().iteratorFinally, 1);
        const eCancel = observe(e.job!.cancel());
        await until(() => e.state().cancelRequests === 1, 'E joins failed retirement');
        assert.equal(Boolean(eCancel.outcome), false);
        assert.equal(Boolean(e.exported.outcome), false);
        assert.equal(e.state().releaseCalls, 0);
        // Lost prepare reply retains startup admission even if the fixture later proves worker cleanup.
        const f = start({ label: 'lost prepare reply', dropPrepare: true });
        await until(() => Boolean(f.state()?.job), 'F worker owns job');
        await until(() => rpcTasks.size === 0, 'F worker closed unanswered reply port');
        const deadline = [...timers].filter(
            ([, value]) => value.kind === 'timeout' && value.delay === 10000,
        );
        assert.equal(deadline.length, 1);
        timers.delete(deadline[0][0]);
        deadline[0][1].callback();
        await until(
            () => diagnostics[f.index].some((x) => x.retirement === 'blocked'),
            'F original RPC deadline',
        );
        const fClose = observe(f.owner.close());
        assert.equal(f.job, undefined);
        assert.equal(Boolean(f.exported.outcome), false);
        assert.equal(Boolean(fClose.outcome), false);
        assert.equal(disposal[f.index], 0);
        assert.equal(busy[f.index], true);
        const fixtureReceipt = await broker.cancel(f.state().job!.id, 'owner');
        assert.equal(fixtureReceipt.retirement, 'acknowledged');
        await until(() => f.state().released, 'F worker resources actually closed');
        assert.equal(
            Boolean(f.exported.outcome),
            false,
            'Unknown helper job cannot claim that unrelated receipt',
        );
        await until(
            () => rpcTasks.size === 0 && ports.every((x) => x.closed),
            'all bounded fake RPC ports closed',
        );
        observations.blocked = {
            pin: dStatus,
            iterator: eStatus,
            lostPrepare: {
                workerReleased: f.state().released,
                helperStillPending: !f.exported.outcome,
            },
            releaseCalls: states.map((x) => x.releaseCalls),
            retainedHelperReservations: 3,
        };
        assert.equal(timers.size, 0);
        assert.equal(frames.length, 2);
        assert.deepEqual(
            [
                windowEvents.count('message'),
                serviceEvents.count('message'),
                serviceEvents.count('controllerchange'),
            ],
            [3, 3, 4],
            'Two blocked known-job helpers and the lost-prepare controller observer remain owned',
        );
        assert.deepEqual(disposal, [1, 1, 1, 0, 0, 0]);
        t.diagnostic(
            '6 bounded ownership scenarios; blocked fake reservations intentionally retained, not forcibly reset',
        );
    } catch (error) {
        failures.push(error);
    } finally {
        for (const value of privateGates) value.release();
        try {
            // One attempt per admitted fake job, including failed attempts. No release retry,
            // deletion or private product reset; intentionally blocked owners stay retained.
            if (broker)
                for (const state of states)
                    if (state.job) {
                        const result = observe(broker.cancel(state.job.id, 'owner'));
                        await until(
                            () => result.outcome !== undefined,
                            'final known fake broker outcome',
                        );
                        if (
                            !result.outcome!.ok &&
                            result.outcome!.error !== state.plan.pinError &&
                            result.outcome!.error !== state.plan.iteratorError
                        )
                            failures.push(result.outcome!.error);
                    }
            await until(() => rpcTasks.size === 0, 'final fake RPC settlement');
            for (const owner of owners) observe(owner.close());
            for (let turn = 0; turn < 64; turn++) await Promise.resolve();
            assert.equal(timers.size, 0);
            assert.equal(
                ports.every((x) => x.closed),
                true,
            );
        } catch (error) {
            failures.push(error);
        }
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        for (const [name, descriptor] of originals) {
            try {
                assert.deepEqual(
                    Object.getOwnPropertyDescriptor(globalThis, name),
                    descriptor,
                    'Exact global restoration: ' + name,
                );
            } catch (error) {
                failures.push(error);
            }
        }
    }
    t.diagnostic(JSON.stringify(observations));
    if (failures.length)
        throw new AggregateError(failures, 'Export retirement regression/restoration failed', {
            cause: failures[0],
        });
});
