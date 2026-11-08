import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
    prepareShippingGatewayHost,
    shippingGatewayHostBuildCommand,
} from './fixtures/shipping-gateway-host.ts';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function deferred() {
    let resolve!: (value?: any) => void, reject!: (e: unknown) => void;
    const promise = new Promise<any>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}
function fixture() {
    const input = {
        archive: Buffer.from('archive'),
        recordBytes: Buffer.from('record'),
        sourceLockBytes: Buffer.from('lock'),
        context: {
            scope: 'gateway',
            sourceCommit: '1'.repeat(40),
            sourceTree: '2'.repeat(40),
            version: '0.6.0',
            runId: '1',
            runAttempt: '1',
            jobKey: 'synthetic',
        },
        selection: {
            root: '/owned/isolated/validation/gateway-runtime/install',
            uid: 1000,
            node: { path: '/owned/node', sha256: '3'.repeat(64) },
        },
        dependencyArchives: [{ path: 'node_modules/ssh2', bytes: Buffer.from('archive-data') }],
        token: '4'.repeat(64),
        attemptId: '5'.repeat(32),
    };
    const receipt: any = {
        schema: 'shipping-gateway-session-diagnostic-v1',
        context: structuredClone(input.context),
        archive: { sha256: hash(input.archive) },
        buildRecordSHA256: hash(input.recordBytes),
        sourceLockSHA256: hash(input.sourceLockBytes),
        selectedNode: { ...input.selection.node, bytes: 123, identity: { ino: 1 } },
        authenticatedProducerProvenance: null,
        loadedCodeIdentity: null,
        wholeGroupRetirement: null,
        releaseAcceptance: false,
    };
    const observed = deferred(),
        retirement = deferred();
    let prepareCount = 0,
        startCount = 0,
        closeCount = 0,
        failures = 0,
        lifetimeCount = 0,
        writes = 0;
    let callback: ((e?: Error) => void) | undefined;
    let bytes: Buffer | undefined;
    const stream = Object.assign(new EventEmitter(), {
        write(value: Buffer, cb: (e?: Error) => void) {
            writes++;
            bytes = Buffer.from(value);
            callback = cb;
            return true;
        },
    });
    const caller = Object.freeze({
        result: observed.promise,
        closed: retirement.promise,
        close() {
            closeCount++;
            return retirement.promise;
        },
    });
    const ports = {
        assertRuntime: () => {},
        lifetime: Object.freeze({
            assertActive(root: string) {
                assert.equal(root, input.selection.root);
                lifetimeCount++;
            },
        }),
        prepareCaller(value: any, lifetime: any) {
            prepareCount++;
            assert.notEqual(value, input);
            assert.notEqual(value.archive, input.archive);
            assert.equal(lifetime, ports.lifetime);
            return Object.freeze({
                start() {
                    startCount++;
                    return caller;
                },
            });
        },
        stdout: stream,
        setFailure() {
            failures++;
        },
    };
    return {
        input,
        receipt,
        observed,
        retirement,
        ports,
        stream,
        caller,
        counts: () => ({ prepareCount, startCount, closeCount, failures, lifetimeCount, writes }),
        written: () => bytes,
        ack: (error?: Error) => {
            assert.ok(callback);
            callback(error);
        },
    };
}

test('host issues owner before effects; emits existing receipt before unproved caller retirement', async () => {
    const f = fixture(),
        prepared = prepareShippingGatewayHost(f.input, f.ports),
        owner = prepared.start();
    assert.equal(f.counts().prepareCount, 0);
    assert.equal(f.counts().lifetimeCount, 0);
    assert.throws(() => prepared.start(), /one-use/);
    await flush();
    f.observed.resolve({ receipt: f.receipt });
    await flush();
    assert.equal(f.counts().writes, 1);
    assert.equal(owner.snapshot().outputWriteRetired, false);
    let done = false;
    void owner.result.then(() => {
        done = true;
    });
    await flush();
    assert.equal(done, false);
    f.ack();
    assert.deepEqual(await owner.result, f.receipt);
    assert.deepEqual(JSON.parse(f.written()!.toString()), f.receipt);
    assert.equal(owner.snapshot().knownResourcesJoined, false);
    for (const key of [
        'inheritedPipeClosure',
        'hostRetirement',
        'namespaceRetirement',
        'cryptoWorkerRetirement',
        'wholeGroupRetirement',
    ])
        assert.equal((owner.snapshot() as any)[key], null);
    assert.equal(owner.snapshot().releaseAcceptance, false);
    f.retirement.resolve();
    await owner.closed;
    assert.equal(owner.snapshot().knownResourcesJoined, true);
});
test('late stdout error remains a failure after receipt acknowledgment without inventing pipe closure', async () => {
    const f = fixture(),
        owner = prepareShippingGatewayHost(f.input, f.ports).start();
    await flush();
    f.observed.resolve({ receipt: f.receipt });
    await flush();
    f.ack();
    await owner.result;
    f.stream.emit('error', Error('late fake stdout failure'));
    assert.equal(owner.snapshot().failed, true);
    assert.ok(f.counts().failures > 0);
    assert.equal(owner.snapshot().inheritedPipeClosure, null);
});
test('cancellation before preparation fences all caller effects and returns the same join', async () => {
    const f = fixture(),
        owner = prepareShippingGatewayHost(f.input, f.ports).start();
    const joined = owner.close();
    assert.equal(owner.close(), joined);
    await assert.rejects(owner.result);
    await joined;
    assert.equal(f.counts().prepareCount, 0);
    assert.equal(f.counts().writes, 0);
});
test('cancellation while result is pending joins original caller once and fences late output', async () => {
    const f = fixture(),
        owner = prepareShippingGatewayHost(f.input, f.ports).start();
    await flush();
    const joined = owner.close();
    assert.equal(owner.close(), joined);
    assert.equal(f.counts().closeCount, 1);
    f.observed.resolve({ receipt: f.receipt });
    await flush();
    await assert.rejects(owner.result);
    assert.equal(f.counts().writes, 0);
    assert.equal(owner.snapshot().knownResourcesJoined, false);
    f.retirement.resolve();
    await joined;
});
test('caller rejection reports before an unresolved retirement join', async () => {
    const f = fixture(),
        owner = prepareShippingGatewayHost(f.input, f.ports).start();
    await flush();
    f.observed.reject(Error('fake initialization failure'));
    await assert.rejects(owner.result);
    await flush();
    assert.equal(f.counts().closeCount, 1);
    assert.equal(owner.snapshot().knownResourcesJoined, false);
    f.retirement.resolve();
    await owner.closed;
});
for (const mode of [
    'throw-preparation',
    'async-preparation',
    'throw-start',
    'invalid-owner',
    'wrong-close-join',
] as const)
    test('host retains unsupported acquisition or closure: ' + mode, async () => {
        const f = fixture(),
            late = deferred();
        (f.ports as any).prepareCaller = () => {
            if (mode === 'throw-preparation') throw Error('unknown acquisition');
            if (mode === 'async-preparation') return late.promise;
            return Object.freeze({
                start() {
                    if (mode === 'throw-start') throw Error('unknown start');
                    if (mode === 'invalid-owner') return Object.freeze({});
                    return Object.freeze({ ...f.caller, close: () => late.promise });
                },
            });
        };
        const owner = prepareShippingGatewayHost(f.input, f.ports).start();
        await flush();
        if (mode === 'wrong-close-join') f.observed.reject(Error('fake result failure'));
        await assert.rejects(owner.result);
        late.resolve(f.caller);
        f.retirement.resolve();
        await flush();
        assert.ok(owner.snapshot().unknownOperations > 0);
        assert.equal(owner.snapshot().knownResourcesJoined, false);
        assert.equal(f.counts().writes, 0);
    });
for (const mode of [
    'context',
    'archive',
    'record',
    'lock',
    'node-path',
    'node-hash',
    'provenance',
    'loaded',
    'group',
    'release',
    'oversize',
] as const)
    test('host refuses mismatched or qualifying receipt: ' + mode, async () => {
        const f = fixture();
        if (mode === 'context') f.receipt.context.runId = '9';
        if (mode === 'archive') f.receipt.archive.sha256 = '0'.repeat(64);
        if (mode === 'record') f.receipt.buildRecordSHA256 = '0'.repeat(64);
        if (mode === 'lock') f.receipt.sourceLockSHA256 = '0'.repeat(64);
        if (mode === 'node-path') f.receipt.selectedNode.path = '/wrong/node';
        if (mode === 'node-hash') f.receipt.selectedNode.sha256 = '0'.repeat(64);
        if (mode === 'provenance') f.receipt.authenticatedProducerProvenance = {};
        if (mode === 'loaded') f.receipt.loadedCodeIdentity = {};
        if (mode === 'group') f.receipt.wholeGroupRetirement = true;
        if (mode === 'release') f.receipt.releaseAcceptance = true;
        if (mode === 'oversize') f.receipt.extra = 'x'.repeat(16384);
        const owner = prepareShippingGatewayHost(f.input, f.ports).start();
        await flush();
        f.observed.resolve({ receipt: f.receipt });
        await assert.rejects(owner.result);
        await flush();
        assert.equal(f.counts().writes, 0);
        f.retirement.resolve();
        await owner.closed;
    });
test('stdout write failure does not release inherited pipe or caller custody', async () => {
    const f = fixture(),
        owner = prepareShippingGatewayHost(f.input, f.ports).start();
    await flush();
    f.observed.resolve({ receipt: f.receipt });
    await flush();
    f.ack(Error('fake write failure'));
    await assert.rejects(owner.result);
    assert.equal(owner.snapshot().failed, true);
    assert.equal(owner.snapshot().knownResourcesJoined, false);
    assert.equal(owner.snapshot().inheritedPipeClosure, null);
});
test('pending lifetime assertion refuses before caller activation and stays uncertain after late settlement', async () => {
    const f = fixture(),
        late = deferred();
    (f.ports as any).lifetime = Object.freeze({ assertActive: () => late.promise });
    const owner = prepareShippingGatewayHost(f.input, f.ports).start();
    await assert.rejects(owner.result);
    late.resolve();
    await flush();
    assert.equal(f.counts().prepareCount, 0);
    assert.ok(owner.snapshot().unknownOperations > 0);
});
for (const mode of ['prepared', 'started'] as const)
    test(
        'malformed ' + mode + ' owner retains actual values and observes rejected native promises',
        async () => {
            const f = fixture();
            const malformed = () =>
                Object.freeze({
                    result: Promise.reject(Error('fake unhandled-risk return')),
                    closed: f.retirement.promise,
                });
            (f.ports as any).prepareCaller = () =>
                mode === 'prepared' ? malformed() : Object.freeze({ start: malformed });
            const owner = prepareShippingGatewayHost(f.input, f.ports).start();
            await assert.rejects(owner.result);
            f.retirement.resolve();
            await flush();
            assert.equal(owner.snapshot().acquisitionValuesRetained, mode === 'prepared' ? 1 : 2);
            assert.ok(owner.snapshot().unknownOperations > 0);
            assert.equal(owner.snapshot().knownResourcesJoined, false);
            assert.equal(f.counts().writes, 0);
        },
    );
test('asynchronous runtime assertion cannot authorize caller preparation', async () => {
    const f = fixture();
    (f.ports as any).assertRuntime = () => Promise.resolve();
    const owner = prepareShippingGatewayHost(f.input, f.ports).start();
    await assert.rejects(owner.result);
    await flush();
    assert.equal(f.counts().prepareCount, 0);
    assert.ok(owner.snapshot().unknownOperations > 0);
});
test('rejected caller retirement fences a later diagnostic result', async () => {
    const f = fixture(),
        owner = prepareShippingGatewayHost(f.input, f.ports).start();
    await flush();
    f.retirement.reject(Error('fake unacknowledged close'));
    await assert.rejects(owner.result);
    f.observed.resolve({ receipt: f.receipt });
    await flush();
    assert.equal(f.counts().writes, 0);
    assert.equal(owner.snapshot().callerClosed, false);
});
test('build plan is exact and inert; source/output overlap and malformed paths refuse', () => {
    const s = {
        sourceRoot: '/source',
        outputRoot: '/helper',
        nodePath: '/selected/bin/node',
        esbuildPath: '/tools/esbuild/bin/esbuild',
    };
    assert.deepEqual(shippingGatewayHostBuildCommand(s), [
        s.nodePath,
        s.esbuildPath,
        '/source/tests/fixtures/shipping-gateway-host-native.mts',
        '--bundle',
        '--platform=node',
        '--format=cjs',
        '--external:ssh2',
        '--outfile=/helper/shipping-gateway-host.cjs',
        '--metafile=/helper/shipping-gateway-host.meta.json',
    ]);
    for (const delta of [
        { outputRoot: '/source/output' },
        { sourceRoot: '/' },
        { outputRoot: '/' },
        { sourceRoot: '/source/../other' },
        { nodePath: '/selected/node\0' },
        { esbuildPath: '/tools/compiler' },
    ])
        assert.throws(() => shippingGatewayHostBuildCommand({ ...s, ...delta }));
});
