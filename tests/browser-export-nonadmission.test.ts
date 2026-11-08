import assert from 'node:assert/strict';
import test from 'node:test';
import { isExportNonAdmissionReply } from '../src/features/automation/capture/export-admission';
import { startBrowserCaptureExport } from '../src/features/automation/capture/browser-export';
import { ConsoleResultsOwner } from '../src/features/automation/capture/console-results-owner';
import { IndexedDbConsoleJournal } from '../src/features/automation/capture/indexeddb-console';

test('non-admission receipts require the exact prepare request and strict protocol shape', () => {
    const requestId = crypto.randomUUID();
    const receipt = { version: 1, requestId, state: 'not-admitted' };
    const reply = { ok: false, error: 'Capacity reached.', nonAdmission: receipt };
    assert.equal(isExportNonAdmissionReply(reply, requestId), true);
    for (const value of [
        null,
        {},
        { ...reply, ok: true },
        { ...reply, ok: 0 },
        { ...reply, error: 0 },
        { ...reply, error: 'x'.repeat(513) },
        { ...reply, nonAdmission: undefined },
        { ...reply, nonAdmission: [] },
        ...[
            { ...receipt, version: 2 },
            { ...receipt, requestId: crypto.randomUUID() },
            { ...receipt, state: 'pending' },
            { ...receipt, extra: true },
        ].map((nonAdmission) => ({ ...reply, nonAdmission })),
    ])
        assert.equal(isExportNonAdmissionReply(value, requestId), false);
});

class Events {
    listeners = new Map<string, Set<(event: any) => void>>();
    addEventListener(type: string, callback: (event: any) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(callback);
    }
    removeEventListener(type: string, callback: (event: any) => void) {
        this.listeners.get(type)?.delete(callback);
    }
    emit(type: string, event: any) {
        for (const callback of this.listeners.get(type) ?? []) callback(event);
    }
    count(type: string) {
        return this.listeners.get(type)?.size ?? 0;
    }
}
class Port {
    peer!: Port;
    closed = false;
    onmessage?: (event: { data: any }) => void;
    transform?: (data: any) => any;
    postMessage(input: any) {
        const data = this.transform ? this.transform(input) : input;
        if (data === undefined) return;
        const peer = this.peer;
        queueMicrotask(() => {
            if (!peer.closed) peer.onmessage?.({ data });
        });
    }
    close() {
        this.closed = true;
    }
}
class Channel {
    port1 = new Port();
    port2 = new Port();
    constructor() {
        this.port1.peer = this.port2;
        this.port2.peer = this.port1;
    }
}
function observed(promise: Promise<unknown>) {
    const state: { settled: boolean; error?: unknown; value?: unknown } = { settled: false };
    void promise.then(
        (value) => Object.assign(state, { settled: true, value }),
        (error) => Object.assign(state, { settled: true, error }),
    );
    return state;
}
async function drain() {
    for (let i = 0; i < 256; i++) await Promise.resolve();
}

test('actual worker releases explicit refusals and preserves all uncertain admission holds', async (t) => {
    const scope = 'https://nonadmission-memory.invalid/hub/';
    const scriptURL = scope + 'capture-download-sw.js';
    const serviceEvents = new Events(),
        windowEvents = new Events(),
        hostEvents = new Events();
    const timers = new Map<object, { callback: () => void; delay: number }>();
    const tasks = new Set<Promise<unknown>>(),
        replies: any[] = [];
    const requests: any[] = [],
        diagnostics: unknown[] = [];
    const owners: ConsoleResultsOwner[] = [];
    const pins: { released: boolean; release(): Promise<void> }[] = [];
    let frameCalls = 0,
        disposeCalls = 0,
        pinFailure = false,
        failWatch = false;
    let corruptReply = false,
        dropReply = false;
    const waitUntil = (promise: Promise<unknown>) => {
        tasks.add(promise);
        void promise.finally(() => tasks.delete(promise)).catch(() => {});
    };
    const dispatch = (id: string, data: any, port: Port) =>
        hostEvents.emit('message', {
            source: { id },
            data,
            ports: [port],
            waitUntil,
        });
    const worker = {
        scriptURL,
        postMessage(request: any, [port]: Port[]) {
            requests.push(request);
            port.transform = (reply) => {
                replies.push(reply);
                if (dropReply) return undefined;
                return corruptReply && reply.nonAdmission
                    ? {
                          ...reply,
                          nonAdmission: { ...reply.nonAdmission, requestId: crypto.randomUUID() },
                      }
                    : reply;
            };
            dispatch('owner', request, port);
        },
    };
    const registration = { scope, active: worker };
    const services = Object.assign(serviceEvents, {
        controller: worker,
        ready: Promise.resolve(registration),
        async getRegistration() {
            return registration;
        },
        async register() {
            return registration;
        },
    });
    const timer = (callback: () => void, delay: number) => {
        if (failWatch && delay === 60001)
            throw Error('Synthetic post-allocation watchdog failure.');
        const key = {};
        timers.set(key, { callback, delay });
        return key;
    };
    const values: Record<string, unknown> = {
        window: windowEvents,
        navigator: { serviceWorker: services },
        isSecureContext: true,
        performance: { now: () => 0 },
        location: { protocol: 'https:', origin: 'https://nonadmission-memory.invalid' },
        document: {
            baseURI: scope,
            createElement() {
                frameCalls++;
                assert.fail('No helper creation expected');
            },
        },
        MessageChannel: Channel,
        setTimeout: timer,
        setInterval: timer,
        clearTimeout: (key: object) => timers.delete(key),
        clearInterval: (key: object) => timers.delete(key),
        registration,
        addEventListener: hostEvents.addEventListener.bind(hostEvents),
        clients: {
            async get(id: string) {
                return {
                    id,
                    url: scope,
                    frameType: 'top-level',
                    postMessage(data: any) {
                        if (id === 'owner') serviceEvents.emit('message', { source: worker, data });
                    },
                };
            },
            async matchAll() {
                return [];
            },
            async claim() {},
        },
        async skipWaiting() {},
    };
    const originals = new Map(
        Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    const originalOpen = IndexedDbConsoleJournal.open;
    const send = async (owner: string, data: any) => {
        const channel = new Channel();
        const promise = new Promise<any>((resolve) => {
            channel.port1.onmessage = (event) => resolve(event.data);
        });
        dispatch(owner, data, channel.port2);
        const result = await promise;
        channel.port1.close();
        return result;
    };
    const start = (format: any = 'json') => {
        const owner = new ConsoleResultsOwner(
            async () => ({
                archive: {} as any,
                dispose: async () => {
                    disposeCalls++;
                },
            }),
            () => {},
        );
        owners.push(owner);
        return {
            owner,
            exported: observed(
                owner.export(() =>
                    startBrowserCaptureExport(format, {}, 'console', (value) =>
                        diagnostics.push(value),
                    ),
                ),
            ),
        };
    };
    try {
        for (const [key, value] of Object.entries(values))
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        IndexedDbConsoleJournal.open = async () =>
            ({
                async pin() {
                    if (pinFailure)
                        throw Error('Synthetic pin acquisition failed after entering storage.');
                    const pin = {
                        released: false,
                        async release() {
                            pin.released = true;
                        },
                    };
                    pins.push(pin);
                    return pin;
                },
            }) as unknown as IndexedDbConsoleJournal;
        // This imports the real production worker and uses its registered message handler.
        await import('../src/features/automation/capture/capture-download-worker');
        const admitted: { owner: string; id: string }[] = [];
        const concurrent = await Promise.all(
            Array.from({ length: 12 }, async (_, i) => {
                const owner = 'other-tab-' + i;
                const requestId = crypto.randomUUID();
                const reply = await send(owner, {
                    type: 'capture-export-prepare',
                    requestId,
                    format: 'json',
                    source: 'console',
                });
                if (reply.ok) admitted.push({ owner, id: reply.value.id });
                else assert.equal(isExportNonAdmissionReply(reply, requestId), true);
                return reply;
            }),
        );
        assert.equal(concurrent.filter((reply) => reply.ok).length, 8);
        assert.equal(
            pins.length,
            8,
            'Concurrent request admission preserves the existing capacity bound',
        );
        for (let i = 0; i < 6; i++) {
            const attempt = start();
            await drain();
            assert.equal(attempt.exported.settled, true);
            assert.match(String(attempt.exported.error), /Finish or cancel another export first/);
            await attempt.owner.cancelExport();
            await attempt.owner.close();
            assert.equal(attempt.owner.resourceSnapshot.closed, true);
            assert.equal(pins.length, 8, 'Capacity refusal acquires no new pin');
        }
        assert.equal(disposeCalls, 6);
        assert.equal(serviceEvents.count('controllerchange'), 0);
        assert.equal(
            diagnostics.length,
            0,
            'Proven refusal is an ordinary failure, not blocked cleanup',
        );
        for (const job of admitted)
            await send(job.owner, { type: 'capture-export-cancel', id: job.id });
        assert.equal(
            pins.every((pin) => pin.released),
            true,
        );
        const invalid = start('invalid-format');
        await drain();
        assert.equal(invalid.exported.settled, true);
        assert.match(String(invalid.exported.error), /Invalid export format/);
        await invalid.owner.close();
        // Compatibility: a legacy request without an attempt id still gets its original success shape.
        const legacy = await send('legacy', {
            type: 'capture-export-prepare',
            format: 'json',
            source: 'console',
        });
        assert.equal(legacy.ok, true);
        assert.equal(legacy.value.retirementProtocol, 1);
        await send('legacy', { type: 'capture-export-cancel', id: legacy.value.id });

        // Each unsafe case deliberately retains only memory fixtures until this isolated test exits.
        corruptReply = true;
        const mismatch = start('invalid-format');
        await drain();
        corruptReply = false;
        assert.equal(mismatch.exported.settled, false);
        pinFailure = true;
        const failedPin = start();
        await drain();
        pinFailure = false;
        assert.equal(failedPin.exported.settled, false);
        assert.equal(replies.at(-1).nonAdmission, undefined);
        failWatch = true;
        const afterAllocation = start();
        await drain();
        failWatch = false;
        assert.equal(afterAllocation.exported.settled, false);
        assert.equal(replies.at(-1).nonAdmission, undefined);
        dropReply = true;
        const lost = start();
        await drain();
        dropReply = false;
        const lostJob = replies.at(-1).value;
        assert.ok(lostJob?.id);
        const timeout = [...timers].find(([, value]) => value.delay === 10000);
        assert.ok(timeout);
        timers.delete(timeout[0]);
        timeout[1].callback();
        await drain();
        await send('owner', { type: 'capture-export-cancel', id: lostJob.id });
        await drain();
        assert.equal(
            lost.exported.settled,
            false,
            'Out-of-band release cannot substitute for a lost admission reply',
        );
        for (const attempt of [mismatch, failedPin, afterAllocation, lost]) {
            const cancellation = observed(attempt.owner.cancelExport());
            const closure = observed(attempt.owner.close());
            await drain();
            assert.equal(cancellation.settled, false);
            assert.equal(closure.settled, false);
        }
        assert.equal(disposeCalls, 7);
        assert.equal(frameCalls, 0);
        assert.equal(tasks.size, 0);
        assert.equal(timers.size, 0);
        t.diagnostic(
            JSON.stringify({
                recoveredRefusals: 7,
                uncertainHolds: 4,
                actualWorker: true,
                helperCreations: frameCalls,
                disposeCalls,
            }),
        );
    } finally {
        // Fixture-only resource release is not reported to production as an acknowledgement.
        for (const pin of pins) await pin.release();
        IndexedDbConsoleJournal.open = originalOpen;
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});
