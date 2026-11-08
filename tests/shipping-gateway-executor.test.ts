import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareShippingGatewayExecutor } from './fixtures/shipping-gateway-executor.ts';
import { shippingExecutorMemory } from './fixtures/shipping-gateway-executor-memory.ts';

test('existing observer and raw runtime join the issued SSH fixture only after exact byte census and locked origin', async () => {
    const f = await shippingExecutorMemory(),
        prepared = prepareShippingGatewayExecutor(f.input, f.ports);
    assert.deepEqual(f.calls, []);
    const owner = prepared.start(),
        out = await owner.result;
    await owner.closed;
    assert.deepEqual(f.calls, ['fixture-factory', 'launch', 'SIGTERM']);
    assert.equal(out.receipt.fixture.counts.execs, 41);
    assert.equal(out.receipt.runtime.publicSession.probeRows, 36);
    assert.equal(out.receipt.selectedNode.sha256, f.input.selection.node.sha256);
    assert.equal(out.receipt.archive.sha256, f.record.archive.sha256);
    assert.equal(
        out.observation.record.dependencyOrigin.gatewayArchiveSHA256,
        f.record.archive.sha256,
    );
    assert.equal(out.receipt.dependencyOrigin.loadedCodeObserved, false);
    assert.equal(out.receipt.releaseAcceptance, false);
    assert.equal(out.receipt.authenticatedProducerProvenance, null);
    assert.equal(owner.snapshot().phase, 'known-resources-closed');
    assert.equal(f.ssh.fixture.snapshot().retired, true);
    for (const secret of [f.input.token, f.ssh.credentials.password, f.ssh.credentials.fingerprint])
        assert.ok(!JSON.stringify(out.receipt).includes(secret));
    assert.throws(() => prepared.start());
});
for (const mode of ['archive', 'node-selection', 'source-lock', 'source-context'])
    test('invalid ' + mode + ' refuses all fixture and child acquisition', async () => {
        const f = await shippingExecutorMemory();
        if (mode === 'archive') f.input.archive[0] ^= 1;
        if (mode === 'node-selection') f.input.selection.node.sha256 = 'f'.repeat(64);
        if (mode === 'source-lock') f.input.sourceLockBytes[0] ^= 1;
        if (mode === 'source-context') f.input.context.sourceCommit = 'f'.repeat(40);
        assert.throws(() => prepareShippingGatewayExecutor(f.input, f.ports));
        assert.deepEqual(f.calls, []);
    });
for (const mode of ['node-bytes', 'payload', 'dependency-bytes', 'dependency-sri'])
    test('observed ' + mode + ' mismatch refuses the fixture before launch', async () => {
        const f = await shippingExecutorMemory();
        if (mode === 'node-bytes') f.filesystem.write(f.nodePath, Buffer.from('foreign Node'));
        if (mode === 'payload')
            f.filesystem.write(f.root + '/dist-gateway/main.cjs', Buffer.from('foreign payload'));
        if (mode === 'dependency-bytes')
            f.filesystem.write(
                f.root + '/node_modules/ssh2/lib/index.js',
                Buffer.from('foreign dependency'),
            );
        if (mode === 'dependency-sri') f.input.dependencyArchives[0].bytes[20] ^= 1;
        const owner = prepareShippingGatewayExecutor(f.input, f.ports).start();
        await assert.rejects(owner.result);
        await owner.closed;
        assert.deepEqual(f.calls, []);
        assert.equal(owner.snapshot().failed, true);
    });
for (const mode of ['holdChild', 'holdPipes'])
    test('owned runtime ' + mode + ' prevents fixture close and a completed result', async () => {
        const f = await shippingExecutorMemory();
        f.controls[mode] = true;
        const owner = prepareShippingGatewayExecutor(f.input, f.ports).start();
        let settled = false;
        owner.result.then(() => {
            settled = true;
        });
        await f.normalCloseRequested;
        assert.ok(f.calls.includes('SIGTERM'));
        assert.equal(settled, false);
        assert.equal(f.ssh.fixture.snapshot().closing, false);
        if (mode === 'holdChild') f.closeChild();
        else {
            f.child.stdout.emit('close');
            f.child.stderr.emit('close');
        }
        await owner.result;
        await owner.closed;
        assert.equal(f.ssh.fixture.snapshot().retired, true);
    });
test('known CLI closure cannot pass before actual fixture raw socket and listener acknowledgement', async () => {
    const f = await shippingExecutorMemory();
    f.ssh.controls.holdSocket = true;
    const owner = prepareShippingGatewayExecutor(f.input, f.ports).start();
    let settled = false;
    owner.result.then(() => {
        settled = true;
    });
    await f.fixtureCloseRequested;
    assert.equal(owner.snapshot().runtime.retired, true);
    assert.equal(owner.snapshot().fixture.retired, false);
    assert.equal(settled, false);
    f.ssh.controls.holdSocket = false;
    for (const client of f.ssh.allClients) client.socket.closeNow();
    await owner.result;
    await owner.closed;
    assert.equal(owner.snapshot().fixture.zeroTCPConnectionsObserved, true);
});
test('failed public collection stays failed after acknowledged CLI and fixture closure', async () => {
    const f = await shippingExecutorMemory();
    f.controls.badSnapshot = true;
    const owner = prepareShippingGatewayExecutor(f.input, f.ports).start();
    await assert.rejects(owner.result);
    await owner.closed;
    assert.equal(owner.snapshot().phase, 'failed-known-resources-closed');
    assert.equal(f.calls.filter((x) => x === 'SIGTERM').length, 1);
    assert.equal(f.ssh.fixture.snapshot().retired, true);
});
for (const held of ['holdListenerAck', 'holdSocket'])
    test('fixture failure joins the first close acknowledgement while ' + held, async () => {
        const f = await shippingExecutorMemory();
        f.controls.holdChild = true;
        f.ssh.controls[held] = true;
        const owner = prepareShippingGatewayExecutor(f.input, f.ports).start(),
            failure = assert.rejects(owner.result);
        let closed = false,
            childReleased = false;
        void owner.closed.then(() => {
            closed = true;
        });
        await f.normalCloseRequested;
        try {
            f.ssh.tcp.emit('error', Error('authored fixture failure before child closure'));
            await failure;
            await f.fixtureCloseRequested;
            assert.equal(f.ssh.fixture.snapshot().retired, false);
            f.closeChild();
            childReleased = true;
            await f.pulse();
            assert.equal(owner.snapshot().runtime.retired, true);
            assert.equal(owner.snapshot().fixture.retired, false);
            assert.equal(closed, false, 'Outer closure must join the first fixture close promise.');
        } finally {
            if (!childReleased) f.closeChild();
            if (held === 'holdListenerAck') f.ssh.tcp.releaseCloseAck();
            else {
                f.ssh.controls.holdSocket = false;
                for (const client of f.ssh.allClients) client.socket.closeNow();
            }
            await owner.closed;
        }
        assert.equal(closed, true);
        assert.equal(owner.snapshot().phase, 'failed-known-resources-closed');
        assert.equal(owner.snapshot().fixture.failed, true);
        assert.equal(owner.snapshot().fixture.retired, true);
        assert.equal(f.ssh.calls.filter((call: string) => call === 'listener-close').length, 1);
        assert.equal(owner.snapshot().releaseAcceptance, false);
    });
for (const mode of [
    'foreignFixture',
    'asyncFixture',
    'throwFactory',
    'throwUndefinedFactory',
    'throwFalseFactory',
])
    test('unknown fixture acquisition retains custody on ' + mode, async () => {
        const f = await shippingExecutorMemory();
        f.controls[mode] = true;
        const owner = prepareShippingGatewayExecutor(f.input, f.ports).start();
        await assert.rejects(owner.result);
        await f.pulse();
        assert.equal(owner.snapshot().phase, 'retirement-unproved');
        assert.equal(owner.snapshot().unknownFactoryRetained, true);
        assert.equal(owner.snapshot().failed, true);
        assert.ok(!f.calls.includes('launch'));
    });
