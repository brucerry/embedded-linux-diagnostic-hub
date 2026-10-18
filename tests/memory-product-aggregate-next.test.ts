import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';
import type { InspectionNativeStop } from './fixtures/memory-product-inspection';
import {
    aggregateCaptureAccounting,
    aggregateNativeResourceCounts,
    assertDistinctAggregateScopes,
    aggregateSupported,
    assertAggregateWindowTransition,
    type AggregateWindowTransition,
} from './fixtures/memory-product-aggregate-contract';

test('window transition contract separates real browser visibility from native background execution', () => {
    const browser: AggregateWindowTransition = {
        kind: 'browser',
        requestedHidden: true,
        windowId: 1,
        nativeWindowState: 'minimized',
        documentVisibility: 'hidden',
        activityLeaseHeld: null,
        leaseRetained: null,
        backgroundThrottling: null,
    };
    const native: AggregateWindowTransition = {
        kind: 'native',
        requestedHidden: true,
        windowId: 2,
        nativeWindowState: 'minimized',
        documentVisibility: 'visible',
        activityLeaseHeld: true,
        leaseRetained: true,
        backgroundThrottling: false,
    };
    assert.doesNotThrow(() => assertAggregateWindowTransition(browser, true));
    assert.doesNotThrow(() => assertAggregateWindowTransition(native, true));
    for (const good of [browser, native])
        assert.doesNotThrow(() =>
            assertAggregateWindowTransition(
                {
                    ...good,
                    requestedHidden: false,
                    nativeWindowState: 'normal',
                    documentVisibility: 'visible',
                },
                false,
            ),
        );
    for (const bad of [
        { ...browser, documentVisibility: 'visible' },
        { ...browser, activityLeaseHeld: false },
        { ...native, nativeWindowState: 'normal' }, // A hidden but unminimized window does not qualify.
        { ...native, activityLeaseHeld: false },
        { ...native, leaseRetained: false },
        { ...native, backgroundThrottling: true },
        { ...native, documentVisibility: 'hidden' },
        { ...native, requestedHidden: false },
        { ...native, windowId: undefined },
    ])
        assert.throws(() =>
            assertAggregateWindowTransition(bad as AggregateWindowTransition, true),
        );
});
import {
    assertAggregateWorkerQuiescent,
    AggregateExportWorker,
    type AggregateWorkerSnapshot,
} from './fixtures/memory-product-aggregate-worker';
import { requirements } from './fixtures/memory-resource-verdict';
import {
    AggregateCallTracker,
    recordAggregateFailure,
    type AggregateDiagnosticClock,
} from './fixtures/memory-product-aggregate-diagnostics';

class DiagnosticModelClock implements AggregateDiagnosticClock {
    private sequence = 0;
    readonly callbacks = new Map<number, () => void>();
    set(callback: () => void, milliseconds: number) {
        assert.equal(milliseconds, 10000, 'The actual fixture deadline must not be widened.');
        const id = ++this.sequence;
        this.callbacks.set(id, callback);
        return id;
    }
    clear(handle: unknown) {
        this.callbacks.delete(handle as number);
    }
    expire() {
        const callbacks = [...this.callbacks.values()];
        this.callbacks.clear();
        for (const callback of callbacks) callback();
    }
}
async function settleModelPromises() {
    for (let index = 0; index < 16; index++) await Promise.resolve();
}

test('the primary error precedes reads and a diagnostic deadline leaves its actual call unjoined', async () => {
    const events: { stage: string; data: any }[] = [],
        clock = new DiagnosticModelClock(),
        emit = async (stage: string, data: unknown) => {
            events.push({ stage, data });
        },
        calls = new AggregateCallTracker(emit, 'model-call', clock),
        primary = Error('original product failure');
    let release!: (value: unknown) => void;
    const actual = new Promise((resolve) => {
        release = resolve;
    });
    const receipt = recordAggregateFailure({
        error: primary,
        emit,
        calls,
        collect() {
            assert.equal(events[0].stage, 'aggregate-cycle-failed');
            assert.equal(events[0].data.primary, String(primary));
            return [
                { name: 'worker', read: () => actual },
                { name: 'status', read: async () => 'still readable' },
            ];
        },
    });
    await settleModelPromises();
    clock.expire();
    await receipt;
    const context = events.find((row) => row.stage === 'aggregate-failure-context')!.data;
    assert.equal(context.observations.find((row: any) => row.name === 'worker').status, 'unjoined');
    assert.equal(
        context.observations.find((row: any) => row.name === 'status').value,
        'still readable',
    );
    assert.equal(calls.pending().length, 1);
    assert.equal(calls.pending()[0].deadlineExpired, true);
    assert.throws(() => calls.assertJoined(), /remain unjoined/);
    release({ actualLateResolution: true });
    await settleModelPromises();
    calls.assertJoined();
    assert.ok(events.some((row) => row.data.state === 'settled-after-deadline'));
    assert.equal(clock.callbacks.size, 0);
});

test('diagnostic rejection and construction failure retain the already-recorded primary', async () => {
    for (const constructionFails of [false, true]) {
        const events: { stage: string; data: any }[] = [],
            clock = new DiagnosticModelClock(),
            emit = async (stage: string, data: unknown) => {
                events.push({ stage, data });
            },
            calls = new AggregateCallTracker(emit, 'model-call', clock);
        await recordAggregateFailure({
            error: Error('primary'),
            emit,
            calls,
            collect() {
                if (constructionFails) throw Error('construction failure');
                return [
                    {
                        name: 'worker',
                        read: async () => {
                            throw Error('read failure');
                        },
                    },
                ];
            },
        });
        assert.equal(events[0].stage, 'aggregate-cycle-failed');
        assert.equal(events[0].data.primary, 'Error: primary');
        const context = events.find((row) => row.stage === 'aggregate-failure-context')!.data;
        if (constructionFails) assert.match(context.collectionError, /construction failure/);
        else assert.equal(context.observations[0].status, 'rejected');
        calls.assertJoined();
        assert.equal(clock.callbacks.size, 0);
    }
});

test('failed receipt writes preserve both the original error and the recording error', async () => {
    for (const failStage of ['aggregate-cycle-failed', 'aggregate-failure-context']) {
        const original = Error('original'),
            recording = Error('receipt unavailable'),
            clock = new DiagnosticModelClock(),
            emit = async (stage: string) => {
                if (stage === failStage) throw recording;
            },
            calls = new AggregateCallTracker(emit, 'model-call', clock);
        let reads = 0;
        await assert.rejects(
            recordAggregateFailure({
                error: original,
                emit,
                calls,
                collect: () => [
                    {
                        name: 'status',
                        read: async () => {
                            reads++;
                            return 'value';
                        },
                    },
                ],
            }),
            (error) => {
                assert.ok(error instanceof AggregateError);
                assert.deepEqual(error.errors, [original, recording]);
                return true;
            },
        );
        if (failStage === 'aggregate-cycle-failed') assert.equal(reads, 0);
        calls.assertJoined();
        assert.equal(clock.callbacks.size, 0);
    }
});

test('old diagnostic-before-primary order is a failing sensitivity model', async () => {
    const events: string[] = [];
    let release!: () => void;
    const diagnostic = new Promise<void>((resolve) => {
        release = resolve;
    });
    const oldOrder = (async () => {
        await Promise.allSettled([diagnostic]);
        events.push('primary');
    })();
    await settleModelPromises();
    assert.deepEqual(
        events,
        [],
        'The old order cannot provide the required early primary receipt.',
    );
    release();
    await oldOrder;
    assert.deepEqual(events, ['primary']);
});

function workerRetirementModel(closeOnUnload: boolean, rejectRetirementEvidence = false) {
    const clock = new DiagnosticModelClock(),
        trace: string[] = [],
        events: { stage: string; data: any }[] = [];
    const url = 'http://aggregate.test/capture-download-sw.js';
    let storeClosed = false,
        unregistered = false,
        targetClosed = false;
    const product = () => ({
        owners: { export: 0, pin: 0, reader: 0, writer: 0, cleanup: 0 },
        jobs: [],
        services: { captureConnection: !storeClosed, consoleConnection: false },
        cache: { finished: 8 },
    });
    const independent = () => ({
        installedBeforeStore: true,
        owners: { openRequest: 0, transaction: 0 },
        connections: storeClosed
            ? []
            : [{ id: 1, name: 'real-model', version: 2, transactions: 0, closeRequested: false }],
        logicalCloseAcknowledgements: Number(storeClosed),
        physicalClose: 'not inferred',
    });
    const realm = vm.createContext({
        __name: (value: unknown) => value,
        __memoryProductWorker: {
            snapshot: async () => product(),
            ledger: independent,
            closeIdleStores: async () => {
                trace.push('store-close');
                storeClosed = true;
                return { after: independent() };
            },
        },
        clients: {
            matchAll: async () => [
                { id: 'helper', url: 'http://aggregate.test/capture-download-frame.html' },
            ],
        },
        navigator: {
            serviceWorker: {
                getRegistrations: async () => [
                    {
                        active: { scriptURL: url },
                        unregister: async () => {
                            trace.push('unregister');
                            unregistered = true;
                            return true;
                        },
                    },
                ],
            },
        },
    });
    const evaluate = async (fn: Function, argument: unknown) => {
        realm.argument = argument;
        return structuredClone(await vm.runInContext('(' + fn.toString() + ')(argument)', realm));
    };
    const worker = Object.assign(new EventEmitter(), { url: () => url, evaluate });
    const closeTarget = () => {
        targetClosed = true;
        trace.push('actual-worker-close');
        worker.emit('close');
    };
    const protocol = Object.assign(new EventEmitter(), {
        async send(method: string) {
            assert.equal(
                method,
                'ServiceWorker.enable',
                'No forced stop or alternate target-closing API.',
            );
            protocol.emit('ServiceWorker.workerVersionUpdated', {
                versions: [
                    { scriptURL: url, versionId: 'actual-model-version', runningStatus: 'running' },
                ],
            });
            return {};
        },
        async detach() {
            protocol.emit('close');
        },
    });
    const context = {
        serviceWorkers: () => (targetClosed ? [] : [worker]),
        newCDPSession: async () => protocol,
    };
    const page = { url: () => 'http://aggregate.test/', context: () => context, evaluate };
    const observer = new AggregateExportWorker(
        page as never,
        async (stage, data) => {
            if (stage === 'aggregate-service-worker-retired' && rejectRetirementEvidence)
                throw Error('model retirement evidence rejected');
            events.push({ stage, data });
        },
        clock,
    );
    const unload = async () => {
        assert.equal(storeClosed, true);
        assert.equal(unregistered, true);
        trace.push('destroy-owning-clients');
        if (closeOnUnload) closeTarget();
    };
    return { observer, clock, trace, events, unload, closeTarget, page };
}

test('worker retirement requires logical joins, unregister, actual client unload and actual worker close', async () => {
    const model = workerRetirementModel(true);
    await model.observer.initialize();
    await model.observer.retire(model.unload);
    assert.deepEqual(model.trace, [
        'store-close',
        'unregister',
        'destroy-owning-clients',
        'actual-worker-close',
    ]);
    const receipt = model.events.find(
        (row) => row.stage === 'aggregate-service-worker-retired',
    )!.data;
    assert.equal(receipt.playwrightWorkerCloseObserved, true);
    assert.equal(receipt.nativeStop, null);
    assert.equal(receipt.stores.after.connections.length, 0);
    assert.equal(model.observer.idleSnapshot().retired, 1);
    await model.observer.dispose();
    assert.equal(model.clock.callbacks.size, 0);
});

test('unregister and client-unload claims cannot substitute for a missing actual worker close', async () => {
    const model = workerRetirementModel(false);
    await model.observer.initialize();
    const retiring = model.observer.retire(model.unload);
    const rejected = assert.rejects(retiring, /join-worker-close/);
    await settleModelPromises();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await settleModelPromises();
    assert.ok(model.observer.pending().some((row) => row.phase === 'join-worker-close'));
    model.clock.expire();
    await rejected;
    assert.throws(() => model.observer.idleSnapshot(), /unjoined/);
    await assert.rejects(model.observer.dispose(), /unjoined/);
    assert.equal(
        model.events.some((row) => row.stage === 'aggregate-service-worker-retired'),
        false,
    );
    model.closeTarget();
    await settleModelPromises();
    await model.observer.dispose();
    assert.equal(model.clock.callbacks.size, 0);
});

// Model DTO only. Native qualification requires the independent provider's actual receipt.
const modelNativeStop: InspectionNativeStop = {
    releaseAt: 1,
    deadline: 10001,
    cutoffOrdinal: 4,
    nativeStop: {
        eventOrdinal: 5,
        observedAt: 2,
        version: {
            versionId: 'actual-model-version',
            registrationId: 'model-registration',
            scriptURL: 'http://aggregate.test/capture-download-sw.js',
            status: 'redundant',
            runningStatus: 'stopped',
            controlledClients: [],
        },
    },
    nativeStopLatencyMilliseconds: 1,
    releaseJoinMilliseconds: 2,
};
function bindModelInspection(model: ReturnType<typeof workerRetirementModel>) {
    const token = Object.freeze({ modelOnly: true });
    model.observer.configureInspection({
        async bind(url, version) {
            assert.equal(url, modelNativeStop.nativeStop.version.scriptURL);
            assert.equal(version(), 'actual-model-version');
            assert.equal(model.trace.length, 0, 'Native identity binds before any unregister.');
            model.trace.push('bind-exact-model-identity');
            return token;
        },
        async transition(binding, input) {
            assert.equal(binding, token);
            assert.equal(input.closed(), false);
            await model.observer.releaseForInspection();
            model.observer.assertInspectionReleased();
            model.closeTarget();
            await input.joinWorkerClose();
            await input.acknowledge(modelNativeStop);
            await model.observer.bindInspection(model.page as never, 2);
            model.observer.assertInspectionBound(model.page as never, 2);
        },
    });
}
test('inspection export hooks retain worker-close ownership through release then bind the next generation', async () => {
    const model = workerRetirementModel(false);
    bindModelInspection(model);
    await model.observer.initialize();
    await model.observer.retire(model.unload);
    assert.deepEqual(model.trace, [
        'bind-exact-model-identity',
        'store-close',
        'unregister',
        'destroy-owning-clients',
        'actual-worker-close',
    ]);
    assert.equal(model.observer.idleSnapshot().retired, 1);
    assert.equal(model.observer.pending().length, 0);
    const receipt = model.events.find(
        (row) => row.stage === 'aggregate-service-worker-retired',
    )!.data;
    assert.equal(receipt.playwrightWorkerCloseObserved, true);
    assert.deepEqual(receipt.nativeStop, modelNativeStop);
    await model.observer.dispose();
    assert.equal(model.clock.callbacks.size, 0);
});
test('inspection evidence rejection retains the old owner and blocks reuse without counting a retirement', async () => {
    const model = workerRetirementModel(false, true);
    bindModelInspection(model);
    await model.observer.initialize();
    await assert.rejects(model.observer.retire(model.unload), /model retirement evidence rejected/);
    assert.equal(model.observer.idleSnapshot().retired, 0);
    assert.equal(model.observer.inspectionPageForCleanup(), model.page);
    await assert.rejects(
        model.observer.bindInspection(model.page as never, 2),
        /Native retirement evidence/,
    );
    await assert.rejects(model.observer.retire(model.unload));
    const disposal = await model.observer.dispose();
    assert.equal(disposal.disposition, 'session-close-observed');
    assert.equal(disposal.workerCloseObserved, true);
    assert.equal(model.clock.callbacks.size, 0);
});

test('selected, filtered and all reject both ambiguous fixtures and an always-all exporter', () => {
    const expected = { selected: ['a'], filtered: ['a', 'b'], all: ['a', 'b', 'c'] };
    assert.doesNotThrow(() => assertDistinctAggregateScopes(expected, expected));
    assert.throws(() =>
        assertDistinctAggregateScopes({
            selected: ['a', 'b'],
            filtered: ['a', 'b'],
            all: ['a', 'b'],
        }),
    );
    assert.throws(
        () =>
            assertDistinctAggregateScopes(expected, {
                selected: expected.all,
                filtered: expected.all,
                all: expected.all,
            }),
        /membership mismatch/,
    );
    assert.throws(
        () => assertDistinctAggregateScopes(expected, { ...expected, filtered: ['b', 'c'] }),
        /membership mismatch/,
    );
});
test('accounting includes successful rearm and incomplete/cancelled bytes before any deletion', () => {
    const old = { id: 'old', committedBytes: 7, observedBytes: 7 };
    const rows = [
        old,
        { id: 'success', committedBytes: 65553, observedBytes: 65553 },
        { id: 'rearm', committedBytes: 81, observedBytes: 81 },
        { id: 'cancelled', committedBytes: 16384, observedBytes: 32768 },
        { id: 'quota', committedBytes: 0, observedBytes: 42 },
    ];
    const actual = aggregateCaptureAccounting([old], rows);
    assert.equal(actual.committedBytes, 82018);
    assert.equal(actual.observedBytes, 98444);
    assert.equal(actual.createdRecords, 4);
    assert.notEqual(actual.committedBytes, rows[1].committedBytes);
    assert.throws(() => aggregateCaptureAccounting([old], rows.slice(1)), /vanished/);
    assert.throws(
        () => aggregateCaptureAccounting([old], [{ ...old, committedBytes: 8, observedBytes: 8 }]),
        /changed/,
    );
    assert.throws(() =>
        aggregateCaptureAccounting([], [{ id: 'bad', committedBytes: 8, observedBytes: 7 }]),
    );
});
test('browser capability inventory does not downgrade any mandatory core/viewer case', () => {
    const declared = aggregateSupported(true),
        required = requirements(false, declared, true);
    assert.equal(declared.length, 45);
    assert.deepEqual(
        required.coverage.filter((id) => !declared.includes(id as never)),
        [],
    );
});

test('unknown observed bytes stay unknown while every committed capture remains counted', () => {
    const actual = aggregateCaptureAccounting(
        [],
        [
            { id: 'complete', committedBytes: 8, observedBytes: 8 },
            { id: 'unknown-partial', committedBytes: 4, observedBytes: null },
        ],
    );
    assert.equal(actual.committedBytes, 12);
    assert.equal(actual.observedBytes, null);
    assert.equal(actual.knownObservedSubtotal, 8);
    assert.deepEqual(actual.unknownObservedCaptureIds, ['unknown-partial']);
    assert.equal(actual.createdRecords, 2);
});

test('native resource flags retain live owners and reject absent, inherited or malformed zeros', () => {
    const good = {
        sshHasResources: false,
        consoleHasResources: false,
        activity: { lease: false },
    };
    assert.deepEqual(aggregateNativeResourceCounts(good), {
        nativeSshResources: 0,
        nativeConsoleResources: 0,
        nativeActivityLease: 0,
    });
    assert.equal(
        aggregateNativeResourceCounts({ ...good, sshHasResources: true }).nativeSshResources,
        1,
    );
    assert.equal(
        aggregateNativeResourceCounts({ ...good, consoleHasResources: true })
            .nativeConsoleResources,
        1,
    );
    assert.equal(
        aggregateNativeResourceCounts({ ...good, activity: { lease: true } }).nativeActivityLease,
        1,
    );
    for (const value of [
        null,
        { ...good, sshHasResources: undefined },
        { ...good, consoleHasResources: 0 },
        { ...good, activity: null },
        { ...good, activity: { lease: 0 } },
        Object.assign(Object.create({ sshHasResources: false }), {
            consoleHasResources: false,
            activity: { lease: false },
        }),
    ])
        assert.throws(() => aggregateNativeResourceCounts(value));
});
test('independent SW connections and transactions cannot be replaced by product zero counters', () => {
    const good: AggregateWorkerSnapshot = {
        product: {
            owners: { export: 0, pin: 0, reader: 0, writer: 0, cleanup: 0 },
            jobs: [],
            services: { captureConnection: true, consoleConnection: false },
            cache: { finished: 3 },
        },
        independent: {
            installedBeforeStore: true,
            owners: { openRequest: 0, transaction: 0 },
            connections: [
                { id: 1, name: 'real', version: 2, transactions: 0, closeRequested: false },
            ],
            logicalCloseAcknowledgements: 0,
            physicalClose: 'not exposed',
        },
    };
    assert.doesNotThrow(() => assertAggregateWorkerQuiescent(good));
    for (const bad of [
        { ...good, independent: { ...good.independent, installedBeforeStore: false } },
        {
            ...good,
            independent: { ...good.independent, owners: { openRequest: 0, transaction: 1 } },
        },
        { ...good, independent: { ...good.independent, connections: [] } },
        { ...good, product: { ...good.product, jobs: [{ id: 'abandoned' }] } },
    ])
        assert.throws(() => assertAggregateWorkerQuiescent(bad));
});
test('worker logical close remains owned until the actual transaction terminal event', () => {
    class Database extends EventTarget {
        name = 'real';
        version = 2;
        closeCalls = 0;
        close() {
            this.closeCalls++;
        }
        transaction() {
            return new EventTarget();
        }
    }
    class Factory {
        request = Object.assign(new EventTarget(), { result: new Database() });
        open() {
            return this.request;
        }
    }
    const factory = new Factory(),
        realm = vm.createContext({
            EventTarget,
            Event,
            WeakRef,
            IDBFactory: Factory,
            IDBDatabase: Database,
            indexedDB: factory,
        });
    const source = fs.readFileSync(
        new URL('./fixtures/memory-product-worker-ledger.ts', import.meta.url),
        'utf8',
    );
    vm.runInContext(
        transformSync(source, {
            loader: 'ts',
            format: 'iife',
            globalName: 'ledgerModule',
            target: 'es2022',
        }).code,
        realm,
    );
    const ledger = vm.runInContext('ledgerModule.installProductWorkerLedger()', realm);
    const request = factory.open();
    assert.equal(ledger.snapshot().owners.openRequest, 1);
    request.dispatchEvent(new Event('success'));
    const db = request.result,
        tx = db.transaction();
    db.close();
    assert.equal(db.closeCalls, 1);
    assert.equal(ledger.snapshot().connections.length, 1);
    assert.equal(ledger.snapshot().owners.transaction, 1);
    tx.dispatchEvent(new Event('complete'));
    assert.equal(ledger.snapshot().connections.length, 0);
    assert.equal(ledger.snapshot().logicalCloseAcknowledgements, 1);
    // Restore the model prototypes: the production observer is confined to its actual worker realm.
    delete (Factory.prototype as any).open;
    delete (Database.prototype as any).close;
    delete (Database.prototype as any).transaction;
});
