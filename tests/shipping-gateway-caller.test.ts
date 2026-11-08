import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareShippingGatewayCaller } from './fixtures/shipping-gateway-caller.ts';
import { shippingExecutorMemory } from './fixtures/shipping-gateway-executor-memory.ts';

function deferred() {
    let resolve!: (value?: any) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<any>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
async function memory() {
    const f = await shippingExecutorMemory(),
        ready = deferred(),
        closed = deferred(),
        failure = deferred();
    const calls: string[] = [],
        controls: any = {},
        value = Object.freeze({ syntheticNamespace: true });
    let parent: any, binding: any;
    const namespace = Object.freeze({
        closed: closed.promise,
        failure: failure.promise,
        snapshot: () => ({ synthetic: true }),
        start() {
            calls.push('initialize');
            assert.equal(parent.snapshot().initializationAttempted, true);
            if (controls.throwStart) throw controls.throwStart;
            if (controls.badStart) return controls.badStart;
            if (!controls.holdReady) ready.resolve(value);
            return ready.promise;
        },
        close() {
            calls.push('namespace-close');
            if (controls.throwClose) throw controls.throwClose;
            if (controls.badClose) return Promise.resolve();
            if (controls.differentRejectedClose)
                return Promise.reject(Error('authored different rejected close'));
            if (!controls.holdClose) closed.resolve();
            return closed.promise;
        },
    });
    const ports = {
        filesystem: { ...f.ports.filesystem },
        runtime: f.ports.runtime,
        prepareNamespace(observed: any, owner: any) {
            calls.push('prepare-namespace');
            parent = owner;
            binding = observed;
            assert.equal(owner.snapshot().namespaceAcquisitionAttempted, true);
            assert.equal(
                owner.snapshot().admission.pendingIO + owner.snapshot().admission.descriptors,
                0,
            );
            if (controls.throwPrepare) throw controls.throwPrepare;
            if (controls.asyncPrepare) return controls.asyncPrepare;
            return namespace;
        },
        createFixture(loaded: any) {
            calls.push('fixture');
            assert.equal(loaded, value);
            assert.equal(parent.snapshot().initializationSettled, true);
            return f.ports.createFixture();
        },
    };
    return {
        f,
        ports,
        calls,
        controls,
        ready,
        closed,
        failure,
        namespace,
        value,
        binding: () => binding,
    };
}
function watch(owner: any) {
    const state = { closed: false };
    void owner.closed.then(() => {
        state.closed = true;
    });
    return state;
}

test('caller preparation is inert; actual memory composition is one-use and keeps diagnostic output nonqualifying', async () => {
    const m = await memory(),
        prepared = prepareShippingGatewayCaller(m.f.input, m.ports);
    assert.deepEqual(m.calls, []);
    assert.deepEqual(m.f.calls, []);
    const owner = prepared.start(),
        result = await owner.result;
    await owner.closed;
    assert.deepEqual(m.calls, ['prepare-namespace', 'initialize', 'fixture', 'namespace-close']);
    assert.equal(result.receipt.releaseAcceptance, false);
    assert.equal(owner.snapshot().retired, true);
    assert.equal(owner.snapshot().namespaceRetirement, null);
    assert.equal(m.binding().context.sourceCommit, m.f.input.context.sourceCommit);
    assert.equal(m.binding().origin.gatewayArchiveSHA256, m.f.record.archive.sha256);
    assert.throws(() => prepared.start());
});
test('result cannot supply namespace closure; repeats join the same pending acknowledgement', async () => {
    const m = await memory();
    m.controls.holdClose = true;
    const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
        state = watch(owner);
    await owner.result;
    await m.f.pulse();
    assert.equal(owner.snapshot().executor.phase, 'known-resources-closed');
    assert.equal(state.closed, false);
    assert.equal(owner.close(), owner.closed);
    assert.equal(owner.close(), owner.closed);
    assert.equal(m.calls.filter((v) => v === 'namespace-close').length, 1);
    m.closed.resolve();
    await owner.closed;
    assert.equal(owner.snapshot().failed, false);
});
test('cancellation before admission returns a closed failed owner without namespace or fixture effects', async () => {
    const m = await memory(),
        owner = prepareShippingGatewayCaller(m.f.input, m.ports).start();
    const rejected = assert.rejects(owner.result);
    owner.close();
    await rejected;
    await owner.closed;
    assert.deepEqual(m.calls, []);
    assert.deepEqual(m.f.calls, []);
    assert.equal(owner.snapshot().failed, true);
});
test('pending initialization retains custody; cancellation defers closure and late success cannot create fixture', async () => {
    const m = await memory();
    m.controls.holdReady = true;
    const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
        state = watch(owner);
    await m.f.pulse();
    assert.ok(m.calls.includes('initialize'));
    const rejected = assert.rejects(owner.result);
    owner.close();
    await rejected;
    await m.f.pulse();
    assert.equal(state.closed, false);
    assert.equal(owner.snapshot().initializationSettled, false);
    assert.equal(m.calls.includes('namespace-close'), false);
    m.ready.resolve(m.value);
    await owner.closed;
    assert.equal(m.calls.includes('fixture'), false);
    assert.deepEqual(m.f.calls, []);
    assert.equal(m.calls.filter((v) => v === 'namespace-close').length, 1);
});
test('rejected initialization stays failed and waits for separate closure acknowledgement', async () => {
    const m = await memory();
    m.controls.holdReady = m.controls.holdClose = true;
    const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
        state = watch(owner);
    const rejected = assert.rejects(owner.result);
    await m.f.pulse();
    m.ready.reject(Error('authored async initialization failure'));
    await rejected;
    await m.f.pulse();
    assert.equal(owner.snapshot().initializationSettled, true);
    assert.equal(state.closed, false);
    m.closed.resolve();
    await owner.closed;
    assert.equal(owner.snapshot().failed, true);
    assert.equal(m.calls.includes('fixture'), false);
});
for (const mode of ['throwStart', 'badStart', 'throwPrepare'])
    test(
        'unsupported or throwing ' +
            mode +
            ' retains uncertainty rather than accepting fake closure',
        async () => {
            const m = await memory();
            m.controls[mode] = mode === 'badStart' ? {} : Error('authored sync failure');
            const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
                state = watch(owner);
            await assert.rejects(owner.result);
            m.closed.resolve();
            await m.f.pulse();
            assert.equal(state.closed, false);
            assert.equal(owner.snapshot().unknownAcquisitionOrClosure, true);
            assert.equal(m.calls.includes('fixture'), false);
        },
    );
test('asynchronous namespace acquisition retains its late returned owner and never starts it', async () => {
    const m = await memory(),
        acquisition = deferred();
    m.controls.asyncPrepare = acquisition.promise;
    const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
        state = watch(owner);
    await assert.rejects(owner.result);
    acquisition.resolve(m.namespace);
    await m.f.pulse();
    assert.equal(owner.snapshot().lateValuesRetained, 1);
    assert.equal(state.closed, false);
    assert.deepEqual(m.calls, ['prepare-namespace']);
});
for (const mode of ['throwClose', 'badClose', 'differentRejectedClose', 'rejectedClose'])
    test(
        'namespace ' + mode + ' cannot discharge custody or cause a repeated close request',
        async () => {
            const m = await memory();
            if (mode === 'rejectedClose') m.controls.holdClose = true;
            else m.controls[mode] = mode === 'badClose' ? true : Error('authored close failure');
            const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
                state = watch(owner);
            await owner.result;
            if (mode === 'rejectedClose') m.closed.reject(Error('authored closure rejection'));
            await m.f.pulse();
            owner.close();
            await m.f.pulse();
            assert.equal(state.closed, false);
            assert.equal(owner.snapshot().failed, true);
            assert.equal(m.calls.filter((v) => v === 'namespace-close').length, 1);
        },
    );
for (const method of ['open', 'close'])
    test(
        'cancellation joins held preliminary file ' + method + ' before discharging caller custody',
        async () => {
            const m = await memory(),
                gate = deferred(),
                entered = deferred();
            let first = true;
            const original: any = m.ports.filesystem.open;
            m.ports.filesystem.open = async (...args: any[]) => {
                if (method === 'open' && first) {
                    first = false;
                    entered.resolve();
                    await gate.promise;
                }
                const handle = await original(...args);
                if (method === 'close' && first) {
                    first = false;
                    return {
                        ...handle,
                        close: async () => {
                            entered.resolve();
                            await gate.promise;
                            return handle.close();
                        },
                    };
                }
                return handle;
            };
            const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
                state = watch(owner);
            const rejected = assert.rejects(owner.result);
            await entered.promise;
            owner.close();
            await rejected;
            await m.f.pulse();
            assert.equal(state.closed, false);
            assert.ok(owner.snapshot().admission.pendingIO > 0);
            gate.resolve();
            await owner.closed;
            assert.deepEqual(m.calls, []);
            assert.deepEqual(m.f.calls, []);
        },
    );
test('failed preliminary descriptor close remains held even with no namespace or child', async () => {
    const m = await memory();
    const original: any = m.ports.filesystem.open;
    m.ports.filesystem.open = async (...args: any[]) => ({
        ...(await original(...args)),
        close: async () => {
            throw Error('authored descriptor close failure');
        },
    });
    const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
        state = watch(owner);
    await assert.rejects(owner.result);
    await m.f.pulse();
    assert.equal(state.closed, false);
    assert.ok(owner.snapshot().admission.descriptors > 0);
    assert.deepEqual(m.calls, []);
});
test('cancellation waits for runtime closure before requesting namespace closure', async () => {
    const m = await memory();
    m.f.controls.holdPipes = true;
    const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
        state = watch(owner);
    await m.f.normalCloseRequested;
    const rejected = assert.rejects(owner.result);
    owner.close();
    await rejected;
    await m.f.pulse();
    assert.equal(state.closed, false);
    assert.equal(owner.snapshot().executor.runtime.retired, false);
    assert.equal(m.calls.includes('namespace-close'), false);
    m.f.child.stdout.emit('close');
    m.f.child.stderr.emit('close');
    await owner.closed;
    assert.equal(owner.snapshot().retired, true);
    assert.equal(owner.snapshot().failed, true);
});
test('an unsolicited early namespace closure is not reusable after late initialization', async () => {
    const m = await memory();
    m.controls.holdReady = true;
    const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
        state = watch(owner);
    const rejected = assert.rejects(owner.result);
    await m.f.pulse();
    m.closed.resolve();
    await rejected;
    m.ready.resolve(m.value);
    await m.f.pulse();
    assert.equal(state.closed, false);
    assert.equal(owner.snapshot().unknownAcquisitionOrClosure, true);
    assert.equal(m.calls.includes('fixture'), false);
});
test('early namespace closure rejection fences fixture admission after late initialization', async () => {
    const m = await memory();
    m.controls.holdReady = true;
    const owner = prepareShippingGatewayCaller(m.f.input, m.ports).start(),
        state = watch(owner);
    const rejected = assert.rejects(owner.result);
    await m.f.pulse();
    m.closed.reject(Error('authored early closure rejection'));
    await rejected;
    m.ready.resolve(m.value);
    await m.f.pulse();
    assert.equal(state.closed, false);
    assert.equal(owner.snapshot().failed, true);
    assert.equal(m.calls.includes('fixture'), false);
});
