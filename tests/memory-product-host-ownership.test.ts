import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hostPins, observeHostStreams, observeProductHost, verifyProductHostObservation,
    assertHostStreamsRetired, validateHostBinding } from './fixtures/memory-product-host-ownership';
import { verifyProductHostSources, createProductHostObservation } from './fixtures/memory-product-host-source';
import { SshStreamHost } from '../backend/ssh/stream-host';
import { SshStreamClient } from '../src/features/automation/capture/ssh-stream-client';
import { sshClientCustody } from './fixtures/memory-product-ownership';

const binding = (realm: 'gateway' | 'native' = 'gateway') => ({ protocol: 1,
    production: '96a56cdbb462320c54fe74022d7436e665a31d31', realm, pins: hostPins(realm) });
const zero = () => ({ currentStates: 0, retiringStates: 0, producers: 0, readers: 0,
    pendingAcks: 0, pendingDataBytes: 0, shutdownWaiters: 0 });
const snapshot = (streams = zero()) => ({ ownedSessions: 1, allSessionOwners: [{ streams }] });
const completion = () => ({ stdout: '', stderr: '', exitCode: 0, completion: 'exit' as const,
    truncated: false, chunks: [], previewClipped: false });
const request = { id: 'host-ownership-command', connection: 'host-ownership-connection', command: 'synthetic', timeoutMs: 1000 };
async function start(host: SshStreamHost) {
    const caps = await host.dispatch({ protocol: 1, action: 'capabilities' }, 'gateway') as { epoch: string };
    const owner = await host.dispatch({ protocol: 1, action: 'start', epoch: caps.epoch, request }, 'gateway') as { capability: string };
    return { protocol: 1, id: request.id, connection: request.connection, capability: owner.capability };
}
const observed = (host: SshStreamHost) => observeProductHost(snapshot(host.ownershipSnapshot), binding(), 'gateway');

test('exact producer preimages pass and changed, missing, wrong-root or unsupported sources refuse admission', async () => {
    const root = process.cwd();
    const verified = await verifyProductHostSources(root, 'gateway');
    assert.deepEqual(verified, binding());
    assert.ok(Object.isFrozen(verified) && Object.isFrozen(verified.pins));
    assert.deepEqual(await verifyProductHostSources(root, 'native'), binding('native'));
    for (const name of Object.keys(hostPins('gateway'))) {
        await assert.rejects(verifyProductHostSources(root, 'gateway', async file => {
            const value = await fs.readFile(file, 'utf8');
            return file === path.join(root, name) ? value + '\n' : value;
        }), /preimage changed/);
    }
    await assert.rejects(verifyProductHostSources('relative', 'gateway'));
    await assert.rejects(verifyProductHostSources(root, 'unsupported' as 'gateway'));
    await assert.rejects(verifyProductHostSources(root, 'gateway', async () => { throw Error('Missing source'); }));
});

test('missing, inherited, malformed and unassessed stream fields cannot become zero observations', () => {
    for (const name of Object.keys(zero())) {
        for (const value of [undefined, null, -1, 0.5, NaN, '0'])
            assert.throws(() => observeHostStreams({ ...zero(), [name]: value }));
        const inherited = Object.assign(Object.create({ [name]: 0 }), zero());
        delete inherited[name];
        assert.throws(() => observeHostStreams(inherited));
        const active = { ...zero(), [name]: 1 };
        assert.throws(() => assertHostStreamsRetired(observeProductHost(snapshot(active), binding(), 'gateway')));
    }
    assert.throws(() => observeHostStreams({ ...zero(), extraOwner: 0 }));
    assert.throws(() => observeHostStreams({ ...zero(), currentStates: 2 }));
    for (const value of [null, {}, { ownedSessions: 0 }, { ownedSessions: 0, allSessionOwners: [{}] },
        { ownedSessions: 1, allSessionOwners: [{}] }])
        assert.throws(() => observeProductHost(value, binding(), 'gateway'));
});

test('source admission can be pending or rejected without an observation or implicit retry', async () => {
    let release!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observer = createProductHostObservation(process.cwd(), 'gateway', async file => {
        reads++; await gate; return fs.readFile(file, 'utf8');
    });
    assert.equal(reads, 0, 'Construction must not await IO before IPC listener registration.');
    assert.throws(() => observer.observeProductOwnership(snapshot()));
    const pending = observer.beforeInit();
    assert.equal(observer.beforeInit(), pending);
    assert.throws(() => observer.observeProductOwnership(snapshot()));
    release(); await pending;
    assertHostStreamsRetired(observer.observeProductOwnership(snapshot()));
    assert.equal(reads, 3);
    let failures = 0;
    const rejected = createProductHostObservation(process.cwd(), 'gateway', async () => {
        failures++; throw Error('Synthetic source read failure');
    });
    const failed = rejected.beforeInit(); await assert.rejects(failed);
    assert.equal(rejected.beforeInit(), failed);
    await assert.rejects(rejected.beforeInit());
    assert.throws(() => rejected.observeProductOwnership(snapshot()));
    assert.equal(failures, 1);
});

test('readback binds source, realm, all owned sessions and exact raw counters without a cardinality shortcut', () => {
    const raw = { ownedSessions: 2, allSessionOwners: [
        { streams: { ...zero(), currentStates: 1 } }, { streams: { ...zero(), currentStates: 1, readers: 1 } }] };
    const value = observeProductHost(raw, binding(), 'gateway');
    assert.equal(value.owners.currentStates, 2);
    assert.deepEqual(verifyProductHostObservation(value, raw, 'gateway'), value);
    assert.throws(() => assertHostStreamsRetired(value));
    assert.throws(() => verifyProductHostObservation({ ...value, owners: zero() }, raw, 'gateway'));
    assert.throws(() => verifyProductHostObservation(value, raw, 'native'));
    const bad = binding(); Object.assign(bad.pins, { 'backend/ssh/stream-host.ts': '0'.repeat(64) });
    assert.throws(() => validateHostBinding(bad, 'gateway'));
    assert.throws(() => verifyProductHostObservation(null, raw, 'gateway'));
    const retired = observeProductHost({ ownedSessions: 0, allSessionOwners: [] }, binding(), 'gateway');
    assert.equal(assertHostStreamsRetired(retired).commandAcknowledgement, 'not-implied');
    assert.equal(retired.receiptMetadata, 'not-exposed');
});

test('actual fake host keeps producer ownership through held finalize continuation', async t => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const host = new SshStreamHost(async (_request, _sink, complete, finalized) => {
        complete(completion()); await finalized; await gate;
    }, () => {});
    t.after(async () => { release(); await host.shutdown(); });
    const owner = await start(host);
    const finishing = host.dispatch({ ...owner, action: 'finalize' }, 'gateway');
    assert.equal(observed(host).owners.currentStates, 1);
    assert.equal(observed(host).owners.producers, 1);
    assert.throws(() => assertHostStreamsRetired(observed(host)));
    release(); await finishing;
    assert.equal(assertHostStreamsRetired(observed(host)).scope, 'observed-host-stream-custody-only');
});

test('actual fake host data/ACK custody remains visible until durable ACK and finalization', async t => {
    const host = new SshStreamHost(async (_request, sink, complete, finalized) => {
        await sink.append(new Uint8Array([65, 66, 67]), '2026-11-04T00:00:00.000Z', 'stdout');
        complete(completion()); await finalized;
    }, () => {});
    t.after(() => host.shutdown());
    const owner = await start(host);
    const held = observed(host);
    assert.equal(held.owners.pendingAcks, 1); assert.equal(held.owners.pendingDataBytes, 3);
    const event = await host.dispatch({ ...owner, action: 'read' }, 'gateway') as { sequence: number };
    await host.dispatch({ ...owner, action: 'ack', sequence: event.sequence }, 'gateway');
    assert.equal(observed(host).owners.pendingAcks, 0);
    assert.throws(() => assertHostStreamsRetired(observed(host)), 'ACK is not execution retirement.');
    await host.dispatch({ ...owner, action: 'finalize' }, 'gateway');
    assertHostStreamsRetired(observed(host));
});

test('actual fake host clear retains pending reader/producer retirement and rejected producer still needs finalize', async t => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const host = new SshStreamHost(async () => { await gate; throw Error('Synthetic producer failure'); }, () => {});
    t.after(async () => { release(); await host.shutdown(); });
    const owner = await start(host);
    const read = host.dispatch({ ...owner, action: 'read' }, 'gateway');
    assert.equal(observed(host).owners.readers, 1);
    host.clear();
    const shutdown = host.shutdown();
    await assert.rejects(read);
    assert.equal(observed(host).owners.retiringStates, 1);
    assert.throws(() => assertHostStreamsRetired(observed(host)));
    release(); await shutdown;
    assertHostStreamsRetired(observed(host));
    const rejected = new SshStreamHost(async () => { throw Error('Synthetic immediate failure'); }, () => {});
    t.after(() => rejected.shutdown());
    const second = await start(rejected);
    const result = await rejected.dispatch({ ...second, action: 'read' }, 'gateway') as { capture: { completion: string } };
    assert.equal(result.capture.completion, 'transport-error');
    assert.throws(() => assertHostStreamsRetired(observed(rejected)));
    await rejected.dispatch({ ...second, action: 'finalize' }, 'gateway');
    assertHostStreamsRetired(observed(rejected));
});

test('actual lost finalize reply separates retired host from still-owned client and capability retry never replays', async t => {
    let executions = 0, drop = true;
    const host = new SshStreamHost(async (_request, _sink, complete, finalized) => {
        executions++; complete(completion()); await finalized;
    }, () => {});
    t.after(() => host.shutdown());
    const client = new SshStreamClient(async input => {
        const response = await host.dispatch(input, 'gateway');
        if (input.action === 'finalize' && drop) { drop = false; throw Error('Synthetic lost reply'); }
        return response;
    }, 'gateway');
    await client.execute(request, { append: async () => {}, flush: async () => {}, rejectObservation() {} }, new AbortController().signal);
    await assert.rejects(client.finalize(), /lost reply/);
    assertHostStreamsRetired(observed(host));
    assert.equal(sshClientCustody(client).details.capabilityHeld, true);
    await client.finalize();
    assert.equal(sshClientCustody(client).producer, 0);
    assert.equal(executions, 1);
});

test('private wiring uses owned IPC, validates readback, and checks native source admission before builds', async () => {
    const read = (name: string) => fs.readFile('tests/fixtures/' + name, 'utf8');
    const entry = await read('memory-product-gateway-host.ts');
    assert.match(entry, /void runGatewayHost\(\{ createTarget: createProductTarget, \.\.\.observation \}\)/);
    assert.ok(!entry.includes('await '), 'IPC registration is not delayed by source reads.');
    const adapter = await read('memory-product-gateway.ts');
    assert.match(adapter, /'gateway-node': fileURLToPath/);
    assert.match(adapter, /verifyProductHostObservation\(host.productStreamOwnership, host.productOwnership, 'gateway'\)/);
    const host = await read('memory-resource-gateway-host.ts');
    assert.match(host, /extension\.observeProductOwnership\(productOwnership\) : null/);
    assert.ok(host.indexOf('await extension?.beforeInit?.()') < host.indexOf('gateway = createGateway('));
    assert.ok(host.includes("validHostRequest(input, nonce, role === 'ssh-fixture-node' && Boolean(extension))"),
        'Adding a Gateway observer must not admit target controls in the Gateway role.');
    const native = await read('memory-product-native-host.ts');
    assert.ok(native.indexOf('await verifyNativeMainSources(sourceRoot)') < native.indexOf('await fs.mkdir(desktop'));
    assert.match(native, /transformNativeOwnedSource\(source, file, hostBinding\)/);
    const main = await fs.readFile('electron/main.ts', 'utf8');
    assert.equal(createHash('sha256').update(main).digest('hex'),
        '5c2fb3610fdf1801e521be69cc726572df82d4357c03a2c488695783855b78ef');
});
