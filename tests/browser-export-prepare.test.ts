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
type Job = Awaited<ReturnType<CaptureExportBroker['prepare']>>;
type Request = {
    type: string;
    id?: string;
    format?: 'markdown';
    source?: 'console';
    scope?: { title: string };
};

// Candidate88 characterization is preserved externally. This regression now requires
// prepare-window takeover detection and honest legacy capability refusal.
test('prepare takeover before reply and missing capability retain explicit owner accounting', async (t) => {
    const scope = 'https://prepare-memory.invalid/hub/',
        scriptURL = scope + 'capture-download-sw.js';
    const windowEvents = new MemoryEvents(),
        servicesEvents = new MemoryEvents();
    const replyGate = gate(),
        pins = [gate(), gate()];
    const prepared: Job[] = [],
        releases = [0, 0],
        released = [false, false],
        cancelRequests = [0, 0];
    const diagnostics: { retirement: string; message: string }[][] = [[], []];
    const disposals = [0, 0],
        owners: ConsoleResultsOwner[] = [],
        tasks = new Set<Promise<void>>();
    const ports: MemoryPort[] = [],
        timers = new Map<object, { delay: number; callback: () => void }>();
    const frames: object[] = [];
    let replacementRequests = 0,
        broker!: CaptureExportBroker,
        pinCount = 0;
    class MemoryChannel {
        port1 = new MemoryPort();
        port2 = new MemoryPort();
        constructor() {
            assert.ok(ports.length < 20);
            this.port1.peer = this.port2;
            this.port2.peer = this.port1;
            ports.push(this.port1, this.port2);
        }
    }
    const timer = (callback: () => void, delay = 0) => {
        assert.ok(timers.size < 12);
        const key = {};
        timers.set(key, { delay, callback });
        return key;
    };
    const clear = (key?: object) => {
        if (key) timers.delete(key);
    };
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
                        const index = prepared.length;
                        assert.ok(index < 2);
                        prepared.push(job);
                        if (index === 0) await replyGate.promise;
                        // The second message is a faithful legacy wire shape, not an actual old worker.
                        if (index === 1) {
                            const { retirementProtocol: _capability, ...legacy } = job;
                            value = legacy;
                        } else value = job;
                    } else if (request.type === 'capture-export-cancel') {
                        const index = prepared.findIndex((job) => job.id === request.id);
                        assert.ok(index >= 0);
                        cancelRequests[index]++;
                        const receipt = await broker.cancel(request.id!, 'owner');
                        value = index === 1 ? undefined : receipt;
                    } else assert.fail('No polling or replacement preparation expected');
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
            tasks.add(task);
            void task.finally(() => tasks.delete(task)).catch(() => {});
        },
    };
    const replacement = {
        scriptURL,
        postMessage() {
            replacementRequests++;
            assert.fail('Never replay prepare or cancel on a replacement owner');
        },
    };
    const registration = { scope, active: worker };
    const services = Object.assign(servicesEvents, {
        controller: worker as typeof worker | typeof replacement,
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
            assert.ok(frames.length < 2);
            const frame = {
                hidden: false,
                title: '',
                src: '',
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
            append(frame: { isConnected: boolean }) {
                frame.isConnected = true;
            },
        },
    };
    const source: ExportReportSource = {
        filename: 'console-results',
        validateScope(input) {
            assert.ok(input && typeof input === 'object');
            const value = input as { title: string };
            assert.equal(typeof value.title, 'string');
            return { title: value.title };
        },
        async pin() {
            const index = pinCount++;
            assert.ok(index < 2);
            return {
                through: 1,
                async release() {
                    assert.equal(++releases[index], 1);
                    await pins[index].promise;
                    released[index] = true;
                },
            };
        },
        async *streamReport() {
            assert.fail('No download or stored-record access');
        },
    };
    const empty: ConsoleArchive = {
        async pin() {
            assert.fail('No view pin');
        },
        async list() {
            assert.fail('No catalog');
        },
        async *read() {
            assert.fail('No reader');
        },
        async delete() {
            assert.fail('No deletion');
        },
    };
    const values: Record<string, unknown> = {
        window: windowEvents,
        document,
        navigator: { serviceWorker: services },
        location: { protocol: 'https:', origin: 'https://prepare-memory.invalid' },
        isSecureContext: true,
        MessageChannel: MemoryChannel,
        setTimeout: timer,
        setInterval: timer,
        clearTimeout: clear,
        clearInterval: clear,
    };
    const originals = new Map(
        Object.keys(values).map((name) => [
            name,
            Object.getOwnPropertyDescriptor(globalThis, name),
        ]),
    );
    const failures: unknown[] = [],
        observations: Record<string, unknown> = {};
    const start = (index: number) => {
        const owner = new ConsoleResultsOwner(
            async () => ({
                archive: empty,
                dispose: async () => {
                    disposals[index]++;
                },
            }),
            () => {},
        );
        owners.push(owner);
        let handle: Awaited<ReturnType<typeof startBrowserCaptureExport>> | undefined;
        const exported = observe(
            owner.export(async () => {
                handle = await startBrowserCaptureExport(
                    'markdown',
                    { title: 'prepare ' + index },
                    'console',
                    (value) => {
                        diagnostics[index].push(value);
                    },
                );
                return handle;
            }),
        );
        return {
            owner,
            exported,
            get handle() {
                return handle;
            },
        };
    };
    try {
        for (const [name, value] of Object.entries(values))
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        broker = new CaptureExportBroker(
            source,
            {
                scope,
                now: () => 0,
                client: async (id) =>
                    id === 'owner' ? { id, url: scope, frameType: 'top-level' } : undefined,
                clients: async () => [{ id: 'owner', url: scope, frameType: 'top-level' }],
                notify: async (_id, data) => {
                    servicesEvents.emit('message', { source: worker, data });
                },
            },
            60000,
            source,
        );
        const first = start(0);
        await until(() => prepared.length === 1, 'captured worker prepare held');
        services.controller = replacement;
        servicesEvents.emit('controllerchange', {});
        for (let turn = 0; turn < 16; turn++) await Promise.resolve();
        assert.ok(
            diagnostics[0].some(
                (value) =>
                    value.retirement === 'blocked' && value.message.includes('worker changed'),
            ),
        );
        assert.equal(frames.length, 0);
        assert.equal(first.handle, undefined);
        assert.equal(cancelRequests[0], 0);
        replyGate.release();
        await until(() => releases[0] === 1, 'captured job retired once after id arrives');
        assert.equal(frames.length, 0, 'No stale frame starts after detected takeover');
        assert.equal(first.handle, undefined);
        assert.equal(Boolean(first.exported.outcome), false);
        assert.equal(cancelRequests[0], 1);
        assert.equal(replacementRequests, 0);
        const firstClose = observe(first.owner.close());
        assert.equal(Boolean(firstClose.outcome), false);
        observations.takeover = {
            frames: frames.length,
            diagnostics: diagnostics[0].length,
            cancelRequests: cancelRequests[0],
            exportedPending: !first.exported.outcome,
            pinOwned: !released[0],
        };
        pins[0].release();
        await until(
            () => firstClose.outcome !== undefined && first.exported.outcome !== undefined,
            'first genuine old-owner closure',
        );
        assert.equal(firstClose.outcome!.ok, true);
        assert.equal(first.exported.outcome!.ok, false);
        assert.equal(disposals[0], 1);
        services.controller = worker;
        const legacy = start(1);
        await until(() => releases[1] === 1, 'legacy capability refusal requests one cancellation');
        assert.ok(
            diagnostics[1].some(
                (d) =>
                    d.retirement === 'blocked' &&
                    d.message.includes('does not support acknowledged retirement'),
            ),
        );
        assert.equal(legacy.handle, undefined);
        assert.equal(Boolean(legacy.exported.outcome), false);
        assert.equal(frames.length, 0);
        const legacyClose = observe(legacy.owner.close());
        pins[1].release();
        await until(() => released[1] && tasks.size === 0, 'legacy wire acknowledgement returned');
        assert.equal(Boolean(legacyClose.outcome), false);
        assert.equal(Boolean(legacy.exported.outcome), false);
        assert.equal(disposals[1], 0);
        assert.deepEqual(cancelRequests, [1, 1]);
        assert.deepEqual(releases, [1, 1]);
        assert.equal(replacementRequests, 0);
        assert.equal(prepared.length, 2);
        assert.equal(timers.size, 0);
        assert.equal(
            ports.every((p) => p.closed),
            true,
        );
        observations.legacy = {
            handleReturned: Boolean(legacy.handle),
            exportPending: !legacy.exported.outcome,
            workerPinsReleased: [...released],
            cancelRequests: [...cancelRequests],
            diagnostics: diagnostics[1],
            replacementRequests,
        };
    } catch (error) {
        failures.push(error);
    } finally {
        replyGate.release();
        for (const pin of pins) pin.release();
        try {
            if (broker)
                for (const job of prepared) {
                    const outcome = observe(broker.cancel(job.id, 'owner'));
                    await until(
                        () => outcome.outcome !== undefined,
                        'final memoized broker receipt',
                    );
                    if (!outcome.outcome!.ok) failures.push(outcome.outcome!.error);
                }
            for (const owner of owners) observe(owner.close());
            await until(() => tasks.size === 0, 'all fake worker callbacks');
            for (let turn = 0; turn < 64; turn++) await Promise.resolve();
            assert.equal(timers.size, 0);
            assert.equal(
                ports.every((p) => p.closed),
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
                assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), descriptor);
            } catch (error) {
                failures.push(error);
            }
        }
    }
    t.diagnostic(JSON.stringify(observations));
    if (failures.length)
        throw new AggregateError(failures, 'Prepare takeover observation/restoration failed', {
            cause: failures[0],
        });
});
