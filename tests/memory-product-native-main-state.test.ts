import assert from 'node:assert/strict';
import test from 'node:test';
import { observeNativeMain, assertNativeMainRetired, observeNativeCapture, observeNativeActivity,
    observeNativeConsole, assertNativeConsoleRetired, createNativeCaptureOpening } from './fixtures/memory-product-native-main-state';
import { createNativeQuitObserver } from './fixtures/memory-product-native-quit-observer';
import { UpdateOwnership } from '../electron/update-ownership';
import { createQuitController } from '../shared/quit-cleanup';
function gate() {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
const context = (phase = 'ready') => {
    const updateOwnership = new UpdateOwnership();
    if (phase === 'ready') void updateOwnership.shutdown();
    return { quit: { phase }, captureOpening: 0, captureOpeningUnconfirmed: 0,
    collectionTask: null as Promise<void> | null, connectionAttempts: { busy: false },
    hostVerification: { pending: null as unknown }, reportExports: { owner: undefined as unknown, stopping: phase === 'ready' },
    updateOwnership, ownsProfile: true };
};
const consoleSnapshot = () => ({ references: 0, readers: 0, pins: 0, pendingReaders: 0, pendingPins: 0,
    requests: 0, exports: 0, transition: false, writer: false, closed: false });
const capture = () => ({ closing: true, exports: new Set(), server: { writer: undefined,
    beginning: undefined, readers: new Map(), pins: new Map(), mutations: new Set(), calls: 0,
    disposed: true, pinReservations: 0, completed: new Set(['cached']), expiredPins: new Set() },
    store: { active: undefined, modifying: false, closed: true, closing: false, readers: new Map(),
        pins: 0, deleting: new Set(), operation: undefined, resultWriting: new Set(), listing: 0,
        catalog: undefined, metadataQueues: new Map(), metadataUncertain: new Map(), jsonOperations: new Map() } });

test('actual update ownership survives rejection until resource acknowledgement; publication metadata remains separate', async () => {
    const input = context(), pending = gate(), owner = input.updateOwnership;
    const held = owner.hold('synthetic IO', {});
    // Operation admission is independent of an existing hold; use a new owner for the task.
    const active = new UpdateOwnership(); input.updateOwnership = active;
    const task = active.start(() => pending.promise), retirement = active.hold('synthetic held IO', {});
    assert.equal(observeNativeMain(input).owners.updateOperation, 1);
    pending.reject(Error('Synthetic operation failure')); await assert.rejects(task);
    retirement.blocked(Error('Synthetic close rejection'));
    let observed = observeNativeMain(input);
    assert.equal(observed.owners.updateOperation, 0); assert.equal(observed.owners.updateResources, 1);
    assert.equal(observed.owners.updateBlocked, 1); assert.throws(() => assertNativeMainRetired(observed));
    active.publication('synthetic receipt', 'published'); retirement.acknowledge();
    await active.shutdown(); observed = observeNativeMain(input); assertNativeMainRetired(observed);
    assert.equal(observed.metadata.updatePublications.published, 1);
    held.acknowledge();
});

test('main observations retain report publication/cleanup, clock and acquisition witnesses without paths or errors', () => {
    const input = context(); input.reportExports.owner = { custody: { directory: '/not-emitted', temporary: '/not-emitted', handle: {} },
        value: { publication: 'published', retirement: 'blocked' } };
    input.hostVerification.pending = { id: 'not-emitted', finish() { throw Error('Never invoke'); } };
    input.collectionTask = new Promise(() => {}); input.captureOpening = 1; input.connectionAttempts.busy = true;
    const value = observeNativeMain(input); assert.equal(value.owners.reportAttempts, 1);
    assert.equal(value.owners.reportHandles, 1); assert.equal(value.metadata.reportPublication, 'published');
    assert.equal(value.owners.hostVerification, 1); assert.equal(value.owners.collection, 1);
    assert.ok(!JSON.stringify(value).includes('/not-emitted')); assert.throws(() => assertNativeMainRetired(value));
});

test('missing and malformed main/capture/console observations fail closed, including retained uncertainty after closed flags', () => {
    for (const value of [null, {}, { ...context(), captureOpening: NaN }, { ...context(), collectionTask: undefined },
        { ...context(), hostVerification: {} }, { ...context(), quit: { phase: 'unknown' } }])
        assert.throws(() => observeNativeMain(value));
    const value = observeNativeMain(context()); assertNativeMainRetired(value);
    assert.throws(() => assertNativeMainRetired({ ...value, sourceMain: '0'.repeat(64) }));
    assert.throws(() => assertNativeMainRetired({ ...value, owners: {} }));
    const store = capture(); const idle = observeNativeCapture(store)!;
    assert.ok(Object.values(idle.owners).every(value => value === 0)); assert.equal(idle.cache.completed, 1);
    store.store.metadataUncertain.set('synthetic', Error('Never emitted'));
    assert.equal(observeNativeCapture(store)!.owners.cleanup, 1);
    assert.throws(() => observeNativeCapture({ ...capture(), store: {} }));
    const wrong = capture(); Object.assign(wrong.server, { calls: '0' }); assert.throws(() => observeNativeCapture(wrong));
    const nullTask = capture(); Object.assign(nullTask.server, { beginning: null });
    assert.throws(() => observeNativeCapture(nullTask));
    const nullUpdate = context(); Object.assign(nullUpdate.updateOwnership, { operation: null });
    assert.throws(() => observeNativeMain(nullUpdate));
    assert.equal(observeNativeActivity({ lease: '', suspended: false })!.lease, false);
    assert.throws(() => observeNativeActivity({ lease: undefined, suspended: false }));
    const console = observeNativeConsole({ snapshot: consoleSnapshot(), hasResources: false });
    assertNativeConsoleRetired(console.snapshot);
    assert.throws(() => assertNativeConsoleRetired({ ...console.snapshot, pendingReaders: 1 }));
    assert.throws(() => observeNativeConsole({ snapshot: {}, hasResources: false }));
});

test('capture opening preserves promise identity and failed admission is unconfirmed, never silently retired', async () => {
    const tracker = createNativeCaptureOpening(), pending = gate();
    const original = tracker.run(() => pending.promise); assert.equal(original, pending.promise); assert.equal(tracker.pending, 1);
    pending.resolve(); await original; assert.equal(tracker.pending, 0); assert.equal(tracker.unconfirmed, 0);
    const failure = Error('Synthetic uncertain open'), rejected = Promise.reject(failure);
    assert.equal(tracker.run(() => rejected), rejected); await assert.rejects(rejected, error => error === failure);
    assert.equal(tracker.pending, 0); assert.equal(tracker.unconfirmed, 1);
    const input = context(); input.captureOpeningUnconfirmed = tracker.unconfirmed;
    assert.throws(() => assertNativeMainRetired(observeNativeMain(input)));
    assert.throws(() => tracker.run((): Promise<void> => { throw failure; }), error => error === failure);
    assert.equal(tracker.unconfirmed, 2);
});

function fakeHost(phase = 'ready') {
    const queued: (() => void)[] = [], records: unknown[] = [];
    const input = context(phase); let requested = 0;
    const ports = { phase: () => input.quit.phase, snapshot: () => observeNativeMain(input),
        validate: assertNativeMainRetired, write: (value: unknown) => { records.push(value); },
        schedule: (callback: () => void) => { queued.push(callback); }, requestQuit: () => { requested++; } };
    const observer = createNativeQuitObserver(ports);
    return { observer, queued, records, input, ports, requested: () => requested };
}

test('fake native quit joins production-ready barrier, deduplicates scheduling and acknowledges only a completed receipt write', () => {
    const f = fakeHost(); f.observer.request(); f.observer.request(); assert.equal(f.queued.length, 1);
    f.queued.shift()!(); assert.equal(f.requested(), 1);
    assert.throws(() => f.observer.allow());
    let prevented = 0; f.observer.observeWillQuit({ preventDefault() { prevented++; } });
    assert.equal(prevented, 1); assert.equal(f.observer.ready, true); assert.equal(f.records.length, 0);
    f.observer.allow(); f.queued.shift()!(); f.observer.observeWillQuit({ preventDefault() { prevented++; } });
    assert.equal(f.records.length, 1); assert.equal(f.observer.receiptAcknowledged, true);
    assert.equal(prevented, 1); assert.equal(f.requested(), 2);
    f.observer.observeWillQuit({ preventDefault() { prevented++; } });
    assert.equal(f.records.length, 1, 'Duplicate final events cannot rewrite an acknowledged receipt.');
    assert.ok(f.observer.error); assert.equal(prevented, 2);
});

test('fake native quit blocks premature events, owner mutation and receipt failure without retry or false acknowledgement', () => {
    for (const phase of ['idle', 'waiting', 'blocked']) {
        const f = fakeHost(phase); let blocked = false;
        f.observer.observeWillQuit({ preventDefault() { blocked = true; } });
        assert.equal(blocked, true); assert.equal(f.observer.ready, false); assert.equal(f.observer.receiptAcknowledged, false);
        assert.throws(() => f.observer.allow());
    }
    const f = fakeHost(); f.observer.observeWillQuit({ preventDefault() {} }); f.observer.allow();
    const cause = Error('Synthetic receipt write rejection'); f.ports.write = () => { throw cause; };
    let blocked = false; f.observer.observeWillQuit({ preventDefault() { blocked = true; } });
    assert.ok(blocked && f.observer.error); assert.equal(f.observer.failure(), cause);
    assert.equal(f.observer.receiptAcknowledged, false); assert.throws(() => f.observer.allow());
    const changed = fakeHost(); changed.observer.observeWillQuit({ preventDefault() {} });
    changed.input.captureOpeningUnconfirmed = 1; changed.observer.allow();
    changed.observer.observeWillQuit({ preventDefault() {} }); assert.equal(changed.observer.receiptAcknowledged, false);
});

test('actual quit controller held/rejected cleanup cannot be fabricated into a ready fake native observation', async () => {
    const pending = gate(), controller = createQuitController(() => pending.promise), task = controller.begin({});
    const f = fakeHost('waiting');
    assert.equal(controller.phase, 'waiting'); f.observer.observeWillQuit({ preventDefault() {} }); assert.equal(f.observer.ready, false);
    pending.reject(Error('Synthetic cleanup rejection')); assert.equal((await task).status, 'blocked');
    assert.equal(controller.phase, 'blocked');
    const succeeded = createQuitController(async () => {}); assert.equal((await succeeded.begin({})).status, 'ready');
    const good = fakeHost(succeeded.phase); good.observer.observeWillQuit({ preventDefault() {} }); assert.equal(good.observer.ready, true);
});

test('fake native scheduling and Quit invocation failures retain error without receipt acknowledgement', () => {
    const failedSchedule = fakeHost(), scheduleError = Error('Synthetic schedule failure');
    failedSchedule.ports.schedule = () => { throw scheduleError; };
    assert.throws(() => failedSchedule.observer.request(), error => error === scheduleError);
    assert.equal(failedSchedule.observer.scheduled, false);
    assert.equal(failedSchedule.observer.failure(), scheduleError);
    assert.equal(failedSchedule.observer.receiptAcknowledged, false);
    const failedQuit = fakeHost(), quitError = Error('Synthetic Quit failure');
    failedQuit.ports.requestQuit = () => { throw quitError; };
    failedQuit.observer.request(); failedQuit.queued.shift()!();
    assert.equal(failedQuit.observer.failure(), quitError);
    assert.equal(failedQuit.observer.ready, false);
    assert.equal(failedQuit.observer.receiptAcknowledged, false);
});
