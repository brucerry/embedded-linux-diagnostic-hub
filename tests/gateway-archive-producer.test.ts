import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { gunzipSync } from 'fflate';
import {
    projectGatewayLock,
    validatePreparedGatewayLock,
    GATEWAY_PAYLOAD_FILES,
    gatewayStageFiles,
} from '../scripts/lib/gateway-lock-plan.mjs';
import { OwnedGatewayStage } from '../scripts/lib/owned-gateway-stage.mjs';
import {
    encodeGatewayTar,
    inspectOwnedGatewayTar,
    produceGatewayArchive,
    GatewayProducerFailure,
} from '../scripts/lib/gateway-archive-producer.mjs';
import {
    memoryFilesystem,
    sourceFixture,
    syntheticTools,
    observedLifecycle,
    pipelineFixture,
} from './fixtures/gateway-producer-memory';

const tickUntil = async (predicate: () => boolean) => {
    for (let i = 0; i < 5000 && !predicate(); i++) await Promise.resolve();
    assert.ok(predicate(), 'Bounded memory continuation was not reached.');
};

test('actual committed lock data selects the exact SSH runtime/optional closure without npm execution', async () => {
    const source = JSON.parse(await readFile('package.json', 'utf8')),
        lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
    const before = JSON.stringify(lock),
        value = projectGatewayLock(source, lock);
    assert.deepEqual(value.selected, [
        'node_modules/asn1',
        'node_modules/bcrypt-pbkdf',
        'node_modules/buildcheck',
        'node_modules/cpu-features',
        'node_modules/nan',
        'node_modules/safer-buffer',
        'node_modules/ssh2',
        'node_modules/tweetnacl',
    ]);
    assert.equal(JSON.stringify(lock), before);
    assert.equal(value.manifest.dependencies.ssh2, lock.packages['node_modules/ssh2'].version);
    assert.equal(value.lock.packages['node_modules/cpu-features'].optional, true);
    assert.equal(value.lock.packages['node_modules/ssh2'].optional, undefined);
    assert.equal(validatePreparedGatewayLock(value.lock, value.manifest, lock), value.lock);
});

test('projection excludes unused source entries and prepared lock refuses substitutions, extraneous data and wrong flags', () => {
    const f = sourceFixture(),
        value = projectGatewayLock(f.source, f.lock);
    assert.equal(value.lock.packages['node_modules/unused'], undefined);
    for (const mutate of [
        (lock: any) => {
            lock.packages['node_modules/unused'] = f.lock.packages['node_modules/unused'];
        },
        (lock: any) => {
            lock.packages['node_modules/dep'].version = '1.0.1';
        },
        (lock: any) => {
            lock.packages['node_modules/dep'].resolved = 'https://example.invalid/dep.tgz';
        },
        (lock: any) => {
            lock.packages['node_modules/dep'].integrity = 'sha512-foreign';
        },
        (lock: any) => {
            lock.packages['node_modules/dep'].optional = true;
        },
        (lock: any) => {
            delete lock.packages['node_modules/opt'].optional;
        },
        (lock: any) => {
            lock.packages['node_modules/dep'].dependencies = { unused: '^1.0.0' };
            lock.packages['node_modules/unused'] = f.lock.packages['node_modules/unused'];
        },
        (lock: any) => {
            lock.packages['node_modules/dep'].link = true;
        },
        (lock: any) => {
            lock.packages[''].name = 'foreign';
        },
    ]) {
        const lock = structuredClone(value.lock);
        mutate(lock);
        assert.throws(() => validatePreparedGatewayLock(lock, value.manifest, f.lock));
    }
});

for (const kind of ['peer', 'tag', 'missing', 'credentials'])
    test(
        'unsupported ' + kind + ' source lock fails before projection can pretend npm solved it',
        () => {
            const f = sourceFixture(),
                lock: any = structuredClone(f.lock);
            if (kind === 'peer') lock.packages['node_modules/dep'].peerDependencies = { peer: '*' };
            if (kind === 'tag') lock.packages['node_modules/ssh2'].dependencies.dep = 'latest';
            if (kind === 'missing') delete lock.packages['node_modules/dep'];
            if (kind === 'credentials')
                lock.packages['node_modules/dep'].resolved =
                    'https://name:secret@registry.npmjs.org/dep.tgz';
            assert.throws(() => projectGatewayLock(f.source, lock));
        },
    );

test('owner refuses existing directories, uninitialized work and replayed/forged plans', async () => {
    const fs = memoryFilesystem(),
        stage = new OwnedGatewayStage(fs.fs, '/project', 'new');
    assert.throws(() => stage.plan('build', syntheticTools()));
    await stage.initialize();
    const plan = stage.plan('build', syntheticTools());
    assert.throws(() => stage.plan('build', syntheticTools()));
    await assert.rejects(
        stage.execute(
            Object.freeze({ ...plan, command: Object.freeze(['foreign']) }),
            async () => null,
        ),
    );
    const again = new OwnedGatewayStage(fs.fs, '/project', 'new');
    await assert.rejects(again.initialize(), /EEXIST/);
    assert.equal(again.snapshot().namespace, 'exists-refused');
    assert.equal(fs.bytes('/project/validation/new/config/user.npmrc').length, 0);
});

test('offline lock plan confines config/cache/prefix to the new owner without HOME or permission changes', async () => {
    const fs = memoryFilesystem(),
        stage = new OwnedGatewayStage(fs.fs, '/project', 'new');
    await stage.initialize();
    const build = stage.plan('build', syntheticTools());
    await stage.execute(build, async (plan: any) => ({
        ...plan,
        command: [...plan.command],
        lifecycle: await observedLifecycle(),
    }));
    const plan = stage.plan('lock', syntheticTools());
    for (const flag of [
        '--offline',
        '--ignore-scripts',
        '--package-lock-only',
        '--omit=optional',
        '--global=false',
        '--workspaces=false',
    ])
        assert.ok(plan.command.includes(flag));
    for (const flag of ['--prefix=', '--cache=', '--userconfig=', '--globalconfig='])
        assert.ok(plan.command.some((value) => value.startsWith(flag + stage.directory + '/')));
    assert.equal(plan.cwd, stage.stageDirectory);
    assert.equal(Object.isFrozen(plan.command), true);
    assert.ok(!plan.command.some((value) => /HOME=|hooksPath|chmod|chown|no-sandbox/.test(value)));
});

test('successful memory pipeline binds actual-source orchestration, staged bytes, strict tar, gzip and missing qualification', async () => {
    const f = pipelineFixture(),
        { record, owner } = await produceGatewayArchive(f.context, f.options, f.io);
    assert.equal(record.builder.esbuildEntryFormat, 'node-script');
    assert.equal(Object.hasOwn(record.builder, 'esbuildEntryBytes'), false);
    assert.deepEqual(f.plans[0].command.slice(0, 2), [
        '/synthetic/node',
        '/synthetic/esbuild/bin/esbuild',
    ]);
    assert.equal(record.kind, 'gateway-source-build-archive');
    assert.equal(record.status, 'built');
    assert.equal(record.context.sourceCommit, f.context.sourceCommit);
    assert.equal(f.plans.length, 2);
    assert.equal(owner.sealed, true);
    assert.deepEqual(owner.pendingFiles, []);
    assert.equal(owner.command, null);
    assert.deepEqual(
        [
            record.productRuntime,
            record.loaderProvenance,
            record.normalGC,
            record.forcedGC,
            record.retirement,
        ],
        [null, null, null, null, null],
    );
    assert.equal(record.releaseAcceptance, false);
    assert.equal(f.filesystem.handles.size, 0);
    const base = '/project/validation/gateway-test',
        files = new Map(
            GATEWAY_PAYLOAD_FILES.map((name) => [
                name,
                f.filesystem.bytes(base + '/stage/' + name),
            ]),
        );
    const gzip = f.filesystem.bytes(base + '/artifacts/' + record.archive.name),
        tar = Buffer.from(gunzipSync(gzip));
    assert.deepEqual(inspectOwnedGatewayTar(tar, files), record.tarInventory);
    assert.equal(record.tarInventory.files, 8);
    assert.equal(record.tarInventory.directories, 3);
    assert.equal(
        f.filesystem.bytes(base + '/artifacts/' + record.checksum.name).toString(),
        record.archive.sha256 + '  ' + record.archive.name + '\n',
    );
    assert.equal(f.filesystem.records.has(base + '/stage/node_modules'), false);
});

for (const role of ['build', 'lock'])
    test(
        'pending ' + role + ' acknowledgement cannot publish an archive or replay commands',
        async () => {
            const f = pipelineFixture();
            f.controls.holdRole = role;
            let complete = false;
            const task = produceGatewayArchive(f.context, f.options, f.io).then((value) => {
                complete = true;
                return value;
            });
            await tickUntil(() => typeof f.controls.release === 'function');
            assert.equal(complete, false);
            assert.ok(![...f.filesystem.records.keys()].some((name) => name.endsWith('.tar.gz')));
            const count = f.plans.length;
            f.controls.release();
            await task;
            assert.equal(f.plans.length, role === 'build' ? count + 1 : count);
        },
    );

for (const mode of ['nonzero', 'no-close', 'rejected', 'stale'])
    test('lock ' + mode + ' failure retains truthful ownership and no archive pass', async () => {
        const f = pipelineFixture();
        if (mode === 'rejected') {
            f.controls.throwRole = 'lock';
            f.controls.failure = Error('unknown command disposition');
        } else if (mode === 'stale') f.controls.foreignOwner = 'lock';
        else {
            f.controls.modeRole = 'lock';
            f.controls.mode = mode;
        }
        await assert.rejects(produceGatewayArchive(f.context, f.options, f.io), (error: any) => {
            assert.ok(error instanceof GatewayProducerFailure);
            const snapshot = error.owner.snapshot();
            assert.equal(snapshot.failed, true);
            assert.equal(snapshot.command === null, mode === 'nonzero');
            assert.equal(snapshot.descendantRetirement, null);
            if (mode === 'rejected') assert.equal(error.cause, f.controls.failure);
            return true;
        });
        assert.ok(![...f.filesystem.records.keys()].some((name) => name.endsWith('.tar.gz')));
    });

for (const kind of ['lock', 'extra-file', 'extra-directory', 'source'])
    test(kind + ' mutation cannot be hidden by successful command labels', async () => {
        const f = pipelineFixture();
        if (kind === 'source')
            f.controls.afterBuild = () =>
                f.files.set('gateway/main.ts', Buffer.from('dirty source'));
        else
            f.controls.lock = (lock: any, fs: any, plan: any) => {
                if (kind === 'lock') lock.packages['node_modules/dep'].version = '1.0.1';
                if (kind === 'extra-file')
                    fs.write(plan.cwd + '/secret.env', Buffer.from('synthetic unwanted bytes'));
                if (kind === 'extra-directory') fs.directory(plan.cwd + '/node_modules');
            };
        await assert.rejects(produceGatewayArchive(f.context, f.options, f.io));
        assert.ok(![...f.filesystem.records.keys()].some((name) => name.endsWith('.tar.gz')));
    });

test('file write plus failed close preserves primary diagnostics and the held handle', async () => {
    const fs = memoryFilesystem(),
        stage = new OwnedGatewayStage(fs.fs, '/project', 'write-fail');
    await stage.initialize();
    const primary = Error('synthetic write'),
        cleanup = Error('synthetic close');
    fs.hooks.write = (file: string) => {
        if (file.endsWith('/file')) throw primary;
    };
    fs.hooks.close = (file: string) => {
        if (file.endsWith('/file')) throw cleanup;
    };
    await assert.rejects(
        stage.putPayload(new Map([['file', Buffer.from('bytes')]])),
        (error: any) =>
            error instanceof AggregateError &&
            error.cause === primary &&
            error.errors[1] === cleanup,
    );
    assert.equal(stage.snapshot().failed, true);
    assert.equal(stage.snapshot().pendingFiles.length, 1);
    assert.equal(fs.handles.size, 1);
    assert.throws(() => stage.assertQuiescent());
});

test('canonical tar inventory rejects same-length byte mutations, links, missing members and trailing bytes', () => {
    const f = sourceFixture(),
        prepared = gatewayStageFiles(f.files, Buffer.from('synthetic compiled'));
    const bytes = encodeGatewayTar(prepared.files),
        expected = inspectOwnedGatewayTar(bytes, prepared.files);
    assert.equal(expected.files, 8);
    function checksum(header: Buffer) {
        header.fill(32, 148, 156);
        const sum = header.reduce((a, b) => a + b, 0);
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    }
    for (const mutate of [
        (copy: Buffer) => {
            copy[263] = 0xb0;
            checksum(copy.subarray(0, 512));
        },
        (copy: Buffer) => {
            copy[156] = 50;
            checksum(copy.subarray(0, 512));
        },
        (copy: Buffer) => {
            copy[0] = 47;
            checksum(copy.subarray(0, 512));
        },
        (copy: Buffer) => {
            copy[100] = 0xb0;
            checksum(copy.subarray(0, 512));
        },
        (copy: Buffer) => {
            copy[148] ^= 1;
        },
    ]) {
        const copy = Buffer.from(bytes);
        mutate(copy);
        assert.throws(() => inspectOwnedGatewayTar(copy, prepared.files));
    }
    assert.throws(() =>
        inspectOwnedGatewayTar(bytes.subarray(0, bytes.length - 512), prepared.files),
    );
    assert.throws(() =>
        inspectOwnedGatewayTar(Buffer.concat([bytes, Buffer.alloc(512)]), prepared.files),
    );
    const changed = new Map(prepared.files);
    changed.set('LICENSE', Buffer.from('different source'));
    assert.throws(() => inspectOwnedGatewayTar(bytes, changed));
});

test('a previous stage acknowledgement cannot retire a replacement owner', async () => {
    const fs = memoryFilesystem(),
        tools = syntheticTools();
    const a = new OwnedGatewayStage(fs.fs, '/project', 'first'),
        b = new OwnedGatewayStage(fs.fs, '/project', 'second');
    await a.initialize();
    await b.initialize();
    const first = a.plan('build', tools),
        second = b.plan('build', tools);
    const result = { ...first, command: [...first.command], lifecycle: await observedLifecycle() };
    await a.execute(first, async () => result);
    await assert.rejects(b.execute(second, async () => result));
    assert.equal(a.snapshot().failed, false);
    assert.equal(a.snapshot().command, null);
    assert.equal(b.snapshot().failed, true);
    assert.equal(b.snapshot().command?.id, second.id);
});

test('held file close keeps its owner and blocks build admission until acknowledgement', async () => {
    const fs = memoryFilesystem(),
        stage = new OwnedGatewayStage(fs.fs, '/project', 'held-file');
    let release!: () => void;
    fs.hooks.close = (file: string) =>
        file.endsWith('/user.npmrc')
            ? new Promise<void>((resolve) => {
                  release = resolve;
              })
            : undefined;
    const task = stage.initialize();
    await tickUntil(() => !!release);
    assert.equal(stage.snapshot().pendingFiles.length, 1);
    assert.throws(() => stage.plan('build', syntheticTools()));
    release();
    await task;
    assert.deepEqual(stage.snapshot().pendingFiles, []);
    assert.equal(fs.handles.size, 0);
});

test('late normal closure cannot clear a failure latched during command ownership', async () => {
    const fs = memoryFilesystem(),
        stage = new OwnedGatewayStage(fs.fs, '/project', 'late-closure');
    await stage.initialize();
    const plan = stage.plan('build', syntheticTools());
    let acknowledge!: (value: any) => void;
    const task = stage.execute(
        plan,
        () =>
            new Promise((resolve) => {
                acknowledge = resolve;
            }),
    );
    await tickUntil(() => !!acknowledge);
    const primary = Error('latched before acknowledgement');
    stage.fail(primary);
    acknowledge({ ...plan, command: [...plan.command], lifecycle: await observedLifecycle() });
    await assert.rejects(task, (error) => error === primary);
    assert.equal(stage.snapshot().failed, true);
    assert.equal(stage.snapshot().command, null);
    assert.throws(() => stage.plan('lock', syntheticTools()));
    assert.throws(() => stage.assertQuiescent());
});

test('file-IO lease blocks command and inventory admission until close is acknowledged', async () => {
    const fs = memoryFilesystem(),
        stage = new OwnedGatewayStage(fs.fs, '/project', 'file-lease');
    await stage.initialize();
    let release!: () => void;
    fs.hooks.close = (file: string) =>
        file.endsWith('/held')
            ? new Promise<void>((resolve) => {
                  release = resolve;
              })
            : undefined;
    const task = stage.putPayload(new Map([['held', Buffer.from('bytes')]]));
    await tickUntil(() => !!release);
    assert.ok(stage.snapshot().fileAction);
    assert.throws(() => stage.plan('build', syntheticTools()));
    await assert.rejects(stage.collect(['held']));
    await assert.rejects(stage.publish('archive', Buffer.from('bytes')));
    release();
    await task;
    assert.equal(stage.snapshot().fileAction, null);
    assert.equal(stage.snapshot().pendingFiles.length, 0);
});

test('malformed closure without a valid PID cannot retire its command owner', async () => {
    for (const pid of [null, 0, '123']) {
        const fs = memoryFilesystem(),
            stage = new OwnedGatewayStage(fs.fs, '/project', 'invalid-pid');
        await stage.initialize();
        const plan = stage.plan('build', syntheticTools());
        await assert.rejects(
            stage.execute(plan, async () => ({
                ...plan,
                command: [...plan.command],
                lifecycle: { ...(await observedLifecycle()), pid },
            })),
        );
        assert.equal(stage.snapshot().failed, true);
        assert.equal(stage.snapshot().command?.id, plan.id);
        assert.throws(() => stage.assertQuiescent());
    }
});

test('native, mismatched and unsupported esbuild entry observations fail before staging or dispatch', async () => {
    for (const kind of ['native', 'changed-bytes', 'unknown-header', 'wrong-format', 'oversized']) {
        const f = pipelineFixture(),
            tools: any = syntheticTools();
        if (kind === 'oversized') {
            tools.esbuildEntryBytes = Buffer.alloc(65537, 0x20);
            Buffer.from('#!/usr/bin/env node\n').copy(tools.esbuildEntryBytes);
        }
        if (kind === 'native')
            tools.esbuildEntryBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]);
        if (kind === 'unknown-header')
            tools.esbuildEntryBytes = Buffer.from('#!/bin/sh\necho synthetic\n');
        if (kind === 'changed-bytes')
            tools.esbuildEntryBytes = Buffer.concat([
                tools.esbuildEntryBytes,
                Buffer.from('changed'),
            ]);
        else tools.esbuildEntrySHA256 = sourceDigest(tools.esbuildEntryBytes);
        if (kind === 'wrong-format') tools.esbuildEntryFormat = 'native-executable';
        f.io.observeToolchain = async () => tools;
        await assert.rejects(produceGatewayArchive(f.context, f.options, f.io));
        assert.equal(f.plans.length, 0);
        assert.equal(f.filesystem.records.has('/project/validation/gateway-test'), false);
    }
});
