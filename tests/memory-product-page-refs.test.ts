import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackProductPageRefs, readProductPageRefs, readProductPageCustody,
    trackProductPageRun } from './fixtures/memory-product-page-refs';

const refs = {
    arming: { current: false }, armAttempt: { current: null as symbol | null },
    cleanupActivity: { current: undefined as string | undefined },
    cleanupActivityRetirement: { current: undefined as (() => Promise<void>) | undefined },
    cleanupClock: { current: undefined as (() => void) | undefined },
    cleanupConsoleResults: { current: undefined as (() => void) | undefined },
    pendingClockSamples: { current: 0 },
};
const inspection = { current: null as string | null }, epoch = { current: 0 };

test('Page refs preserve stable rerender identities and reject absent or malformed observations', () => {
    assert.throws(() => readProductPageRefs(), /not been observed/);
    trackProductPageRefs(inspection, epoch, refs);
    assert.deepEqual(readProductPageRefs(), { inspectionId: null, activityEpoch: 0 });
    inspection.current = 'actual-arm';
    epoch.current = 2;
    trackProductPageRefs(inspection, epoch, refs);
    assert.deepEqual(readProductPageRefs(), { inspectionId: 'actual-arm', activityEpoch: 2 });
    assert.throws(() => trackProductPageRefs(inspection, epoch, { ...refs, arming: { current: false } }), /identity changed/);
    epoch.current = -1;
    assert.throws(() => readProductPageRefs(), /shape changed/);
    assert.throws(() => readProductPageCustody(), /identity shape changed/);
    epoch.current = 2;
    refs.pendingClockSamples.current = NaN;
    assert.throws(() => readProductPageCustody(), /custody shape changed/);
    refs.pendingClockSamples.current = 0;
});

test('Page custody retains host, local suspension and pending samples separately', () => {
    refs.arming.current = true;
    refs.armAttempt.current = Symbol('synthetic');
    refs.cleanupActivity.current = 'lease-observation';
    refs.cleanupActivityRetirement.current = async () => { throw Error('Never invoke'); };
    refs.cleanupClock.current = refs.cleanupConsoleResults.current = () => { throw Error('Never invoke'); };
    refs.pendingClockSamples.current = 2;
    assert.deepEqual(readProductPageCustody(), { pages: 1, pendingRuns: 0, arming: 1, armAttempts: 1,
        hostLeases: 1, retirementContinuations: 1, clockSuspensions: 1, consoleSuspensions: 1, pendingClockSamples: 2 });
    refs.arming.current = false;
    refs.armAttempt.current = null;
    refs.cleanupActivity.current = undefined;
    refs.cleanupActivityRetirement.current = undefined;
    refs.cleanupClock.current = refs.cleanupConsoleResults.current = undefined;
    refs.pendingClockSamples.current = 0;
    assert.equal(readProductPageCustody().hostLeases, 0);
});

test('actual Start promise observation covers cancelled pre-arm wait without retaining Page objects', async () => {
    let resolve!: (value: string) => void;
    const task = new Promise<string>(done => { resolve = done; });
    const receiver = { marker: 'receiver' };
    const wrapped = trackProductPageRun(function (this: typeof receiver, once: boolean) {
        assert.equal(this, receiver);
        assert.equal(once, true);
        return task;
    });
    assert.equal(wrapped.call(receiver, true), task, 'Original promise identity is preserved.');
    assert.equal(readProductPageCustody().pendingRuns, 1);
    refs.arming.current = false;
    refs.armAttempt.current = null;
    assert.equal(readProductPageCustody().pendingRuns, 1);
    resolve('original result');
    assert.equal(await task, 'original result');
    assert.equal(readProductPageCustody().pendingRuns, 0);
});

test('Start observation preserves rejection and sync errors without stranding tickets', async () => {
    const failure = Error('Synthetic original rejection');
    const task = Promise.reject(failure);
    assert.equal(trackProductPageRun(() => task)(), task);
    await assert.rejects(task, error => error === failure);
    assert.equal(readProductPageCustody().pendingRuns, 0);
    assert.throws(() => trackProductPageRun((): Promise<void> => { throw failure; })(), error => error === failure);
    assert.equal(readProductPageCustody().pendingRuns, 0);
});
