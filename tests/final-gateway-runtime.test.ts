import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipelineFixture } from './fixtures/gateway-producer-memory';
import { produceGatewayArchive } from '../scripts/lib/gateway-archive-producer.mjs';
import {
    createFinalGatewayObserver,
    GatewayRuntimeObservationFailure,
} from '../scripts/lib/final-gateway-runtime.mjs';
import { openGatewayArchiveBytes } from '../scripts/lib/inner-archive-inspection.mjs';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const tick = async () => {
    for (let n = 0; n < 100; n++) await Promise.resolve();
};
const deferred = () => {
    let resolve!: (v?: any) => void, reject!: (e: any) => void;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
async function fixture() {
    const f = pipelineFixture(),
        { record: r } = await produceGatewayArchive(f.context, f.options, f.io);
    const root = '/installed/gateway',
        nodePath = '/runtime/node';
    for (const row of r.payload)
        f.filesystem.write(
            root + '/' + row.path,
            f.filesystem.bytes(r.lockPreparation.cwd + '/' + row.path),
        );
    const prepared = JSON.parse(f.filesystem.bytes(root + '/package-lock.json').toString());
    for (const [name, value] of Object.entries(prepared.packages) as [string, any][]) {
        if (!name || value.optional) continue;
        f.filesystem.write(
            root + '/' + name + '/package.json',
            Buffer.from(
                JSON.stringify({
                    name: name.split('node_modules/').at(-1),
                    version: value.version,
                }),
            ),
        );
        f.filesystem.write(
            root + '/' + name + '/lib/index.js',
            Buffer.from('synthetic installed JS; never loaded'),
        );
    }
    const nodeBytes = Buffer.from([127, 69, 76, 70, 1, 2, 3]);
    f.filesystem.write(nodePath, nodeBytes);
    const metadata = (stat: any, file: string) => ({
        ...stat,
        uid: 1000,
        mode: file === nodePath ? 0o100755 : stat.mode,
    });
    const filesystem = {
        ...f.filesystem.fs,
        lstat: async (file: string) => metadata(await f.filesystem.fs.lstat(file), file),
        open: async (file: string, flags: number) => {
            assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const h = await f.filesystem.fs.open(file, 'r');
            return { ...h, stat: async () => metadata(await h.stat(), file) };
        },
    };
    const archive = f.filesystem.bytes(
            r.lockPreparation.cwd.replace(/\/stage$/, '') + '/artifacts/' + r.archive.name,
        ),
        recordBytes = Buffer.from(JSON.stringify(r) + '\n'),
        sourceLock = f.files.get('package-lock.json')!,
        selection = { root, node: { path: nodePath, sha256: hash(nodeBytes) }, uid: 1000 };
    const owner = createFinalGatewayObserver(
        archive,
        recordBytes,
        f.context,
        sourceLock,
        selection,
        filesystem,
    );
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = null;
    child.pid = 4242;
    child.spawnfile = nodePath;
    child.spawnargs = [nodePath, root + '/dist-gateway/main.cjs'];
    child.on('error', () => {});
    child.kill = () => assert.fail('No signal permitted');
    function normal(code = 0) {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from('synthetic startup text'));
        child.stdout.emit('close');
        child.stderr.emit('close');
        child.emit('exit', code, null);
        child.emit('close', code, null);
    }
    return {
        ...f,
        record: r,
        root,
        nodePath,
        archive,
        recordBytes,
        sourceLock,
        selection,
        filesystem,
        fsModel: f.filesystem,
        owner,
        child,
        normal,
    };
}
test('checked Gateway tar members remain byte snapshots without extraction or execution', async () => {
    const f = await fixture(),
        handle = openGatewayArchiveBytes(f.archive, f.record),
        entry = handle.read('dist-gateway/main.cjs');
    f.archive.fill(0);
    const copy = handle.read('dist-gateway/main.cjs');
    copy.fill(1);
    assert.deepEqual(handle.read('dist-gateway/main.cjs'), entry);
    handle.releaseBytes();
    assert.throws(() => handle.read('dist-gateway/main.cjs'));
});
test('independent file census binds complete installed regular files, required metadata and selected Node bytes', async () => {
    const f = await fixture(),
        result = await f.owner.observeInstallation();
    assert.equal(result.root, f.root);
    const wanted = f.record.payload.find((p: any) => p.path === 'dist-gateway/main.cjs');
    assert.ok(wanted);
    assert.ok(
        result.files.some(
            (row: any) => row.path === 'dist-gateway/main.cjs' && row.sha256 === wanted.sha256,
        ),
    );
    assert.deepEqual(result.lockedPackageMetadataAgreement, [
        'node_modules/dep',
        'node_modules/ssh2',
    ]);
    assert.equal(result.selectedNode.sha256, f.selection.node.sha256);
    assert.equal(result.dependencyArchiveIntegrity, null);
    assert.equal(result.loadedJavaScriptMapping, null);
    assert.equal(f.owner.snapshot().pendingIO, 0);
    assert.equal(f.owner.snapshot().descriptors, 0);
    assert.equal(f.owner.snapshot().executionAllowed, false);
});
for (const mode of ['archive', 'source-lock', 'record-source'])
    test('unmatched ' + mode + ' refuses all installation I/O', async () => {
        const f = await fixture();
        let accesses = 0;
        const fs: any = Object.fromEntries(
            ['open', 'readdir', 'realpath', 'lstat'].map((n) => [
                n,
                () => {
                    accesses++;
                    assert.fail('unexpected access');
                },
            ]),
        );
        const archive = Buffer.from(f.archive),
            source = Buffer.from(f.sourceLock),
            context = { ...f.context };
        if (mode === 'archive') archive[0] ^= 1;
        if (mode === 'source-lock') source[0] ^= 1;
        if (mode === 'record-source') context.sourceCommit = 'f'.repeat(40);
        assert.throws(() =>
            createFinalGatewayObserver(archive, f.recordBytes, context, source, f.selection, fs),
        );
        assert.equal(accesses, 0);
    });
for (const mode of [
    'payload',
    'package-version',
    'extraneous-package',
    'optional-package',
    'native-addon',
    'credential-file',
    'alias',
    'foreign-node',
])
    test('installed mismatch refuses readiness: ' + mode, async () => {
        const f = await fixture();
        if (mode === 'payload')
            f.fsModel.write(f.root + '/dist-gateway/main.cjs', Buffer.from('substituted'));
        if (mode === 'package-version')
            f.fsModel.write(
                f.root + '/node_modules/ssh2/package.json',
                Buffer.from('{"name":"ssh2","version":"999.0.0"}'),
            );
        if (mode === 'extraneous-package')
            f.fsModel.write(f.root + '/node_modules/foreign/index.js', Buffer.from('foreign'));
        if (mode === 'optional-package')
            f.fsModel.write(f.root + '/node_modules/opt/index.js', Buffer.from('optional'));
        if (mode === 'native-addon')
            f.fsModel.write(f.root + '/node_modules/ssh2/addon.node', Buffer.from('not loaded'));
        if (mode === 'credential-file')
            f.fsModel.write(
                f.root + '/.env.gateway',
                Buffer.from('synthetic file must not be opened'),
            );
        if (mode === 'alias')
            f.fsModel.records.get(f.root + '/node_modules/ssh2/package.json').target = '/outside';
        if (mode === 'foreign-node') f.fsModel.write(f.nodePath, Buffer.from('different'));
        await assert.rejects(f.owner.observeInstallation(), GatewayRuntimeObservationFailure);
        assert.equal(f.owner.snapshot().executionAllowed, false);
        if (mode === 'credential-file')
            assert.ok(
                !f.fsModel.events.some(
                    (event: string) => event.startsWith('open:') && event.endsWith('/.env.gateway'),
                ),
            );
    });
test('held descriptor close preserves file custody and prevents child observation', async () => {
    const f = await fixture(),
        d = deferred();
    const admitted = deferred();
    f.fsModel.hooks.close = () => {
        admitted.resolve();
        return d.promise;
    };
    let ready = false;
    const observe = f.owner.observeInstallation().then((v: unknown) => {
        ready = true;
        return v;
    });
    await admitted.promise;
    assert.equal(ready, false);
    assert.ok(f.owner.snapshot().descriptors > 0);
    assert.throws(() => f.owner.observeChild(f.child), /not ready/);
    d.resolve();
    await observe;
});
test('rejected close retains descriptor and primary read failure plus cleanup diagnostics', async () => {
    const f = await fixture(),
        primary = Error('synthetic read'),
        cleanup = Error('synthetic close');
    f.fsModel.hooks.read = () => {
        throw primary;
    };
    f.fsModel.hooks.close = () => {
        throw cleanup;
    };
    await assert.rejects(f.owner.observeInstallation(), (error: any) => {
        assert.equal(error.cause, primary);
        return true;
    });
    assert.equal(f.owner.snapshot().descriptors, 1);
    assert.equal(f.owner.diagnostics().filter((e: unknown) => e === cleanup).length, 1);
});
test('unknown open failure is registered before acquisition and cannot be forgotten', async () => {
    const f = await fixture();
    f.fsModel.hooks.open = () => {
        throw Error('synthetic unknown acquisition');
    };
    await assert.rejects(f.owner.observeInstallation());
    assert.equal(f.owner.snapshot().descriptors, 1);
});
test('normal direct-child events join independent post-census and emit facts without granting runtime qualification', async () => {
    const f = await fixture();
    await f.owner.observeInstallation();
    const observation = f.owner.observeChild(f.child);
    f.normal();
    const out = await observation.completion;
    await observation.joined;
    assert.equal(out.sha256, hash(out.bytes));
    assert.deepEqual(JSON.parse(out.bytes.toString()), out.record);
    assert.equal(out.record.archive.sha256, f.record.archive.sha256);
    assert.equal(out.record.installation.selectedNode.sha256, f.selection.node.sha256);
    assert.equal(out.record.parentReportedChild.pid, 4242);
    for (const key of [
        'kernelExecutableMapping',
        'loadedDependencyMapping',
        'descendantRetirement',
        'gatewayResourceOwnership',
        'configurationIdentity',
        'reviewedPolicy',
        'normalGC',
        'forcedGC',
    ] as const)
        assert.equal(out.record[key], null);
    assert.equal(out.record.releaseAcceptance, false);
    assert.equal(f.owner.snapshot().listenersHeld, 0);
    assert.equal(f.owner.snapshot().processRetirementProven, false);
});
for (const missing of ['stdout', 'stderr', 'close'])
    test('direct child cannot settle before ' + missing + ' acknowledgement', async () => {
        const f = await fixture();
        await f.owner.observeInstallation();
        const o = f.owner.observeChild(f.child);
        let done = false;
        o.completion.then(
            () => (done = true),
            () => {},
        );
        f.child.emit('spawn');
        if (missing !== 'stdout') f.child.stdout.emit('close');
        if (missing !== 'stderr') f.child.stderr.emit('close');
        f.child.emit('exit', 0, null);
        if (missing !== 'close') f.child.emit('close', 0, null);
        await tick();
        assert.equal(done, false);
        if (missing === 'stdout') f.child.stdout.emit('close');
        if (missing === 'stderr') f.child.stderr.emit('close');
        if (missing === 'close') f.child.emit('close', 0, null);
        await o.completion;
        await o.joined;
    });
for (const mode of ['arguments', 'nonzero', 'signal', 'child-error', 'byte-change'])
    test('failed child does not emit success on ' + mode, async () => {
        const f = await fixture();
        await f.owner.observeInstallation();
        const o = f.owner.observeChild(f.child);
        if (mode === 'arguments') f.child.spawnargs.push('--unreviewed');
        if (mode === 'child-error') f.child.emit('error', Error('never serialize raw child error'));
        if (mode === 'byte-change')
            f.fsModel.write(f.root + '/node_modules/ssh2/lib/index.js', Buffer.from('changed'));
        if (mode === 'signal') {
            f.child.emit('spawn');
            f.child.stdout.emit('close');
            f.child.stderr.emit('close');
            f.child.emit('exit', null, 'SIGTERM');
            f.child.emit('close', null, 'SIGTERM');
        } else f.normal(mode === 'nonzero' ? 7 : 0);
        await assert.rejects(o.completion, GatewayRuntimeObservationFailure);
        await o.joined;
        assert.equal(f.owner.snapshot().processRetirementProven, false);
        assert.equal(f.owner.snapshot().phase, 'failed');
    });
test('observer listener retirement rejection retains custody rather than declaring joined', async () => {
    const f = await fixture();
    await f.owner.observeInstallation();
    const o = f.owner.observeChild(f.child);
    f.child.stdout.off = () => {
        throw Error('synthetic unsubscribe failure');
    };
    f.normal();
    await assert.rejects(o.completion);
    let joined = false;
    o.joined.then(() => (joined = true));
    await tick();
    assert.equal(joined, false);
    assert.ok(f.owner.snapshot().listenersHeld > 0);
});
test('one census cannot be reset or replayed onto a replacement child after completion', async () => {
    const f = await fixture();
    await f.owner.observeInstallation();
    const o = f.owner.observeChild(f.child);
    f.normal();
    await o.completion;
    await o.joined;
    assert.throws(() => f.owner.observeChild(new EventEmitter()), /not ready/);
    const phase = f.owner.snapshot().phase;
    f.child.emit('spawn');
    f.child.emit('close', 0, null);
    assert.equal(f.owner.snapshot().phase, phase);
});

test('caller mutation cannot rebind a parsed record to a later different record digest', async () => {
    const f = await fixture(),
        original = hash(f.recordBytes);
    f.recordBytes.fill(0);
    await f.owner.observeInstallation();
    const o = f.owner.observeChild(f.child);
    f.normal();
    const out = await o.completion;
    await o.joined;
    assert.equal(out.record.buildRecordSHA256, original);
    assert.notEqual(out.record.buildRecordSHA256, hash(f.recordBytes));
});

test('a parent-reported PID change cannot relabel an earlier spawn timeline', async () => {
    const f = await fixture();
    await f.owner.observeInstallation();
    const o = f.owner.observeChild(f.child);
    f.child.emit('spawn');
    f.child.pid++;
    f.normal();
    await assert.rejects(o.completion, GatewayRuntimeObservationFailure);
    await o.joined;
    assert.equal(f.owner.snapshot().phase, 'failed');
});
