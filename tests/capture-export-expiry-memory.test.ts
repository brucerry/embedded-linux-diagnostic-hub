import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureExportBroker, type ExportReportSource } from '../src/features/automation/capture/export-broker';
import { CaptureStorageError } from '../shared/capture-store';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}
function observe<T>(promise: Promise<T>) {
    const state: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
    void promise.then((value) => { state.outcome = { ok: true, value }; }, (error) => { state.outcome = { ok: false, error }; });
    return state;
}
async function until(check: () => boolean, label: string) {
    for (let turn = 0; turn < 256; turn++) { if (check()) return; await Promise.resolve(); }
    assert.fail('Bounded expiry gate did not settle: ' + label);
}

test('live export expiry holds its capacity slot until one acknowledged pin release and preserves the expiry reason', async (t) => {
    const originalSet = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const originalClear = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout');
    const timers = new Map<object, { callback: () => void; delay: number }>();
    const closing = gate(), pinStates: { calls: number; released: boolean }[] = [];
    const jobs: Awaited<ReturnType<CaptureExportBroker['prepare']>>[] = [];
    const notices: { id: string; retirement: string; state: string; error?: string }[] = [];
    const scope = 'https://expiry-memory.invalid/hub/', expiryReason = 'Export expired or download stopped consuming data.';
    let now = 0, broker: CaptureExportBroker | undefined;
    const failures: unknown[] = [], observations: Record<string, unknown> = {};
    const source: ExportReportSource = {
        filename: 'automation-results',
        validateScope(input) { assert.deepEqual(input, {}); return {}; },
        async pin() {
            const index = pinStates.length; assert.ok(index < 9);
            const state = { calls: 0, released: false }; pinStates.push(state);
            return { through: 1, async release() {
                assert.equal(++state.calls, 1, 'No pin release retry');
                if (index === 0) await closing.promise;
                state.released = true;
            } };
        },
        async *streamReport() { assert.fail('Prepared-only expiry must not open records or storage'); },
    };
    try {
        Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: (callback: () => void, delay: number) => {
            assert.ok(timers.size < 9); const handle = {}; timers.set(handle, { callback, delay }); return handle;
        } });
        Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, writable: true, value: (handle?: object) => { if (handle) timers.delete(handle); } });
        broker = new CaptureExportBroker(source, {
            scope, now: () => now,
            client: async (id) => id === 'owner' ? { id, url: scope, frameType: 'top-level' } : undefined,
            clients: async () => [{ id: 'owner', url: scope, frameType: 'top-level' }],
            notify: async (id, value) => { assert.equal(id, 'owner'); notices.push(value as typeof notices[number]); },
        }, 60000);
        const expiring = await broker.prepare('owner', 'json'); jobs.push(expiring);
        const firstWatch = [...timers][0]; assert.equal(firstWatch[1].delay, 60001);
        // Seven newer controls reach their deadline at60001, while the first already expired.
        // This tests the actual eight-job admission bound, not a fabricated global writer fence.
        now = 1;
        for (let index = 0; index < 7; index++) jobs.push(await broker.prepare('owner', 'json'));
        assert.equal(pinStates.length, 8); assert.equal(timers.size, 8);
        now = 60001;
        timers.delete(firstWatch[0]); firstWatch[1].callback();
        await until(() => pinStates[0].calls === 1, 'actual watchdog enters held retirement');
        const pending = await broker.status(expiring.id, 'owner');
        assert.equal(pending.id, expiring.id); assert.equal(pending.state, 'closing'); assert.equal(pending.retirement, 'pending');
        assert.ok('cleanupPending' in pending && pending.cleanupPending === true);
        assert.equal(pending.error, expiryReason); assert.equal(pinStates[0].released, false);
        const joined = observe(broker.cancel(expiring.id, 'owner'));
        const duplicate = observe(broker.cancel(expiring.id, 'owner'));
        for (let index = 0; index < 3; index++) assert.deepEqual(await broker.status(expiring.id, 'owner'), pending);
        assert.equal(Boolean(joined.outcome), false); assert.equal(Boolean(duplicate.outcome), false);
        assert.equal(pinStates[0].calls, 1);
        await assert.rejects(broker.prepare('owner', 'json'), (error: unknown) => error instanceof CaptureStorageError && error.code === 'busy');
        assert.equal(pinStates.length, 8, 'Pending retirement still consumes its capacity reservation');
        assert.equal(notices.some((value) => value.id === expiring.id && value.retirement === 'acknowledged'), false);
        observations.held = { status: pending, pinCalls: pinStates[0].calls, released: pinStates[0].released, occupiedReservations: 8 };
        closing.release();
        await until(() => joined.outcome !== undefined && duplicate.outcome !== undefined, 'genuine retirement acknowledgement');
        assert.equal(joined.outcome!.ok, true); assert.equal(duplicate.outcome!.ok, true);
        if (!joined.outcome!.ok || !duplicate.outcome!.ok) assert.fail('Expected acknowledged expiry retirement');
        const receipt = joined.outcome!.value;
        assert.deepEqual(receipt, { id: expiring.id, retirement: 'acknowledged', state: 'failed', bytes: 0, error: expiryReason });
        assert.deepEqual(duplicate.outcome!.value, receipt);
        assert.deepEqual(await broker.status(expiring.id, 'owner'), receipt);
        assert.deepEqual(await broker.cancel(expiring.id, 'owner'), receipt);
        assert.equal(pinStates[0].calls, 1); assert.equal(pinStates[0].released, true);
        const replacement = await broker.prepare('owner', 'json'); jobs.push(replacement);
        assert.equal(pinStates.length, 9, 'A slot becomes available after actual retirement');
        for (const job of jobs.slice(1)) {
            const retired: Awaited<ReturnType<CaptureExportBroker['cancel']>> = await broker.cancel(job.id, 'owner');
            assert.equal(retired.id, job.id); assert.equal(retired.retirement, 'acknowledged');
        }
        await until(() => notices.filter((value) => value.retirement === 'acknowledged').length === 9, 'final receipt notifications');
        assert.equal(notices.filter((value) => value.id === expiring.id && value.retirement === 'acknowledged').length, 1);
        assert.ok(pinStates.every((state) => state.calls === 1 && state.released)); assert.equal(timers.size, 0);
        observations.final = { receipt, prepared: jobs.length, pinReleaseCalls: pinStates.map((state) => state.calls), timers: timers.size };
    } catch (error) { failures.push(error); }
    finally {
        closing.release();
        try {
            if (broker) for (const job of jobs) {
                const retired = observe(broker.cancel(job.id, 'owner'));
                await until(() => retired.outcome !== undefined, 'final memoized fake-job retirement');
                if (!retired.outcome!.ok) failures.push(retired.outcome!.error);
            }
            assert.equal(timers.size, 0);
        } catch (error) { failures.push(error); }
        if (originalSet) Object.defineProperty(globalThis, 'setTimeout', originalSet);
        else Reflect.deleteProperty(globalThis, 'setTimeout');
        if (originalClear) Object.defineProperty(globalThis, 'clearTimeout', originalClear);
        else Reflect.deleteProperty(globalThis, 'clearTimeout');
        try { assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'setTimeout'), originalSet); assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout'), originalClear); }
        catch (error) { failures.push(error); }
    }
    t.diagnostic(JSON.stringify(observations));
    if (failures.length) throw new AggregateError(failures, 'Memory expiry protocol/restoration failed', { cause: failures[0] });
});
