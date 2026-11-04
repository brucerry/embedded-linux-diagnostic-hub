import assert from 'node:assert/strict';
import test from 'node:test';
import { serialAutomationCustody, runnerCustody, sshClientCustody, sshHostCustody,
    activityReleaseCustody, browserExportCustody } from './fixtures/memory-product-ownership';
import { ActivityReleaseQueue } from '../src/features/automation/activity-release';
import { SshStreamClient } from '../src/features/automation/capture/ssh-stream-client';
import { SshStreamHost } from '../backend/ssh/stream-host';
import { CAPTURE_STORAGE } from '../shared/capture-store';
import { trackProduct, productOwnership } from './fixtures/memory-product-registry';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};
function owner() {
    return { port: {}, writer: {}, generation: 1, retirement: Promise.resolve(), acknowledge() {},
        finishing: true, retired: false, releaseRequested: false, closeRequested: false,
        closed: false, closeFailed: false,
        write: { task: Promise.resolve(), settled: false, failed: false, retainedReason: 'UART break' } };
}

test('Serial pending/rejected writes and failed close retain custody until actual owner removal', () => {
    const value = owner();
    let called = 0;
    value.acknowledge = () => { called++; };
    assert.equal(serialAutomationCustody(value).writer, 1);
    assert.equal(serialAutomationCustody(value).cleanup, 1);
    value.write.settled = true;
    value.write.failed = true;
    let snapshot = serialAutomationCustody(value);
    assert.equal(snapshot.writer, 0);
    assert.equal(snapshot.producer, 1);
    assert.equal(snapshot.cleanup, 1);
    assert.equal(snapshot.details.rejectedWrite, true);
    value.closeRequested = true;
    value.closeFailed = true;
    assert.equal(serialAutomationCustody(value).details.closeFailed, true);
    value.closeFailed = false;
    value.closed = true;
    value.retired = true;
    snapshot = serialAutomationCustody(value);
    assert.equal(snapshot.cleanup, 0);
    assert.equal(snapshot.producer, 1, 'Acknowledged retirement alone does not remove a retained owner.');
    assert.equal(serialAutomationCustody(undefined).producer, 0);
    assert.equal(called, 0, 'Observation must never acknowledge, cancel or release product work.');
});

test('missing or malformed Serial and runner observations fail closed', () => {
    for (const changed of [{ ...owner(), generation: -1 }, { ...owner(), retired: 'yes' },
        { ...owner(), retirement: undefined }, { ...owner(), write: { task: null, settled: true, failed: true } }])
        assert.throws(() => serialAutomationCustody(changed));
    assert.throws(() => serialAutomationCustody(Symbol('old owner shape')));
    assert.throws(() => runnerCustody({}));
    assert.throws(() => runnerCustody({ active: undefined, controller: undefined, cleanupRetry: undefined,
        executing: false, cleanup: { retry() {}, release() {} } }));
});

test('runner cleanup and concurrent retry remain separate custody witnesses', () => {
    const gate = deferred();
    const value = { active: undefined, controller: {}, executing: false,
        cleanup: { retry() { throw Error('Never invoke'); }, release() { throw Error('Never invoke'); }, label: 'SSH' },
        cleanupRetry: gate.promise };
    assert.equal(runnerCustody(value).cleanup, 2);
    assert.equal(runnerCustody(value).details.sshCleanup, true);
    gate.resolve();
    assert.equal(runnerCustody(value).cleanup, 2, 'Promise settlement does not clear actual retained fields.');
    assert.equal(runnerCustody({ ...value, cleanupRetry: undefined }).cleanup, 1);
    assert.equal(runnerCustody({ ...value, controller: undefined, cleanup: undefined, cleanupRetry: undefined }).cleanup, 0);
});

test('actual SSH client unknown start is observed as uncertainty rather than no owner', async () => {
    const actions: string[] = [];
    const client = new SshStreamClient(async request => {
        actions.push(request.action);
        return request.action === 'capabilities'
            ? { protocol: 1, independentStream: 1, receiveTimeSource: 'local-client',
                frameBytes: CAPTURE_STORAGE.frameBytes, backlogBytes: CAPTURE_STORAGE.backlogBytes, epoch: 'a'.repeat(32) }
            : { protocol: 1, capability: 'invalid' };
    }, 'local-client');
    let rejected = 0;
    await assert.rejects(client.execute({ id: 'projection-start-command', connection: 'projection-connection',
        command: 'synthetic', timeoutMs: 1000 }, { append: async () => {}, flush: async () => {},
        rejectObservation: () => { rejected++; } }, new AbortController().signal));
    const projection = sshClientCustody(client);
    assert.equal(projection.cleanup, 1);
    assert.equal(projection.details.startUncertain, true);
    assert.equal(projection.details.capabilityHeld, false);
    await assert.rejects(client.finalize(), /uncertain/);
    assert.deepEqual(actions, ['capabilities', 'start']);
    assert.equal(rejected, 1);
});

test('actual SSH host receipt is bounded metadata, not proof of a live owner or a new execution', async (t) => {
    let runs = 0;
    const host = new SshStreamHost(async (_request, _sink, complete, finalized) => {
        runs++;
        complete({ stdout: '', stderr: '', exitCode: 0, completion: 'exit', truncated: false, chunks: [], previewClipped: false });
        await finalized;
    }, () => {});
    t.after(() => host.shutdown());
    const caps = await host.dispatch({ protocol: 1, action: 'capabilities' }) as { epoch: string };
    const started = await host.dispatch({ protocol: 1, action: 'start', epoch: caps.epoch,
        request: { id: 'projection-host-command', connection: 'projection-connection', command: 'synthetic', timeoutMs: 1000 } }) as { capability: string };
    const finalize = { protocol: 1, action: 'finalize', id: 'projection-host-command',
        connection: 'projection-connection', capability: started.capability };
    assert.equal(sshHostCustody(host).producer, 1);
    await host.dispatch(finalize);
    assert.equal(sshHostCustody(host).producer, 0);
    assert.equal(sshHostCustody(host).cleanup, 0);
    assert.equal(sshHostCustody(host).details.retirementReceipt, 1);
    await host.dispatch(finalize);
    assert.equal(runs, 1);
    host.clear();
    assert.equal(sshHostCustody(host).details.retirementReceipt, 0);
    await assert.rejects(host.dispatch(finalize));
});

test('host reader/ACK and retiring states remain active independently of a receipt', () => {
    const state = { runningDone: false, reading: true, ack: { promise: Promise.resolve() }, data: { totalBytes: 12 } };
    const value = { state, retiring: new Set([state]), finalizedOwner: undefined, shutdownTask: undefined };
    const projection = sshHostCustody(value);
    assert.equal(projection.producer, 1, 'A state present in both slots is not counted twice.');
    assert.equal(projection.reader, 1);
    assert.equal(projection.ack, 1);
    assert.equal(projection.cleanup, 1);
    assert.equal(projection.details.pendingDataBytes, 12);
    assert.throws(() => sshHostCustody({ ...value, finalizedOwner: {} }));
    assert.throws(() => sshClientCustody({ executing: undefined, owner: undefined }));
});

test('actual release queue keeps failed host release and failed local resumes until explicit acknowledgement', async () => {
    const queue = new ActivityReleaseQueue(() => {});
    let releases = 0, resumeFails = true;
    const retire = queue.create(async () => {
        releases++;
        if (releases === 1) throw Error('Synthetic release failure');
    }, [() => { if (resumeFails) throw Error('Synthetic resume failure'); }]);
    await assert.rejects(retire());
    assert.equal(activityReleaseCustody(queue).cleanup, 1);
    assert.equal(activityReleaseCustody(queue).details.releasePending, 1);
    await assert.rejects(queue.retryFailures());
    const held = activityReleaseCustody(queue);
    assert.equal(held.cleanup, 1);
    assert.equal(held.details.releasePending, 0);
    assert.equal(held.details.resumePending, 1);
    assert.equal(held.details.failed, 1);
    resumeFails = false;
    await queue.retryFailures();
    assert.equal(activityReleaseCustody(queue).cleanup, 0);
    assert.equal(releases, 2, 'Acknowledged host release is not replayed for a failed local resume.');
});

test('export RPC settlement cannot stand in for retirement and bounded reusable helpers are permitted', () => {
    const blocked = { active: 1, rpc: 0, helpers: 1, busyHelpers: 1, connectedHelpers: 1 };
    assert.deepEqual(browserExportCustody(blocked), { export: 1, rpc: 0 });
    assert.deepEqual(browserExportCustody({ ...blocked, active: 0, busyHelpers: 0 }), { export: 0, rpc: 0 });
    assert.deepEqual(browserExportCustody({ ...blocked, active: 0, busyHelpers: 0, rpc: 1 }), { export: 0, rpc: 1 });
    for (const changed of [{ ...blocked, rpc: undefined }, { ...blocked, active: -1 },
        { ...blocked, helpers: 5 }, { ...blocked, busyHelpers: 2 }]) assert.throws(() => browserExportCustody(changed));
});

test('registry joins new lifetime witnesses and rejects malformed installed export observation', () => {
    const serial = { port: undefined, opened: undefined, reader: undefined, writer: undefined,
        opening: undefined, reading: undefined, writing: undefined, closing: undefined,
        queue: [], queuedBytes: 0, capture: undefined, automationOwner: owner(), receiveBusy: false,
        listeners: new Set() };
    const client = { executing: undefined, owner: undefined, startUncertain: true };
    const releases = { attempts: new Set() };
    trackProduct('serial', serial);
    trackProduct('ssh-stream-client', client);
    trackProduct('activity-release', releases);
    const previous = (globalThis as any).__memoryBrowserExports;
    try {
        (globalThis as any).__memoryBrowserExports = () => ({ active: 1, rpc: 0, helpers: 0, busyHelpers: 0, connectedHelpers: 0 });
        const held = productOwnership();
        assert.equal(held.owners.producer, 1);
        assert.equal(held.owners.writer, 1);
        assert.equal(held.owners.cleanup, 2);
        assert.equal(held.owners.export, 1);
        assert.equal(held.owners.rpc, 0);
        for (const changed of [() => null, () => ({ active: 0 }), 0]) {
            (globalThis as any).__memoryBrowserExports = changed;
            assert.throws(() => productOwnership());
        }
        // Explicit state transitions in these synthetic observations; no GC or product cleanup claim.
        Object.assign(serial, { automationOwner: undefined });
        client.startUncertain = false;
        (globalThis as any).__memoryBrowserExports = () => ({ active: 0, rpc: 0, helpers: 0, busyHelpers: 0, connectedHelpers: 0 });
        assert.ok(Object.values(productOwnership().owners).every(value => value === 0));
    } finally {
        (globalThis as any).__memoryBrowserExports = previous;
    }
});
