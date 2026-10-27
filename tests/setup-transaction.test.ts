import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import {
    mkdtemp,
    mkdir,
    writeFile,
    readFile,
    access,
    unlink,
    symlink,
    readdir,
    rmdir,
    rename,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { SetupTransaction, type SetupContext } from '../electron/setup-transaction';
import {
    acknowledgeSetupBoot,
    SETUP_PAYLOAD,
    SETUP_OWNER,
    SETUP_UNINSTALLER,
    maintenancePaths,
} from '../electron/installation-maintenance';
import {
    INSTALLATION_MANIFEST,
    INSTALLATION_PRODUCT,
    INSTALLATION_RECORD,
} from '../shared/installation';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hub-setup-unit-'));
    const root = path.join(home, 'installed app'),
        appData = path.join(home, 'roaming');
    await writeFile(path.join(home, SETUP_UNINSTALLER), 'owned uninstaller');
    let busy = false,
        observed = false;
    const changes: { kind: string; version?: string }[] = [];
    const context = (version: string, sourceRoot: string): SetupContext => ({
        sourceRoot,
        home,
        appData,
        version,
        platform: 'win32',
        arch: 'x64',
        busy: async () => busy,
        ownerAlive: async (owner) => owner.pid === process.pid,
        processIdentity: async () => ({
            pid: process.pid,
            executable: process.execPath,
            createdAt: 'unit-owned-process',
        }),
        integrate: async (_root, _id, v, _choices, _previous, save) => {
            changes.push({ kind: 'integrate', version: v });
            await save([]);
            return [];
        },
        validateIntegrations: () => {},
        removeIntegrations: async () => {
            changes.push({ kind: 'remove-integrations' });
        },
        launch: async () => {
            changes.push({ kind: 'launch' });
        },
        successorObserved: async () => observed,
    });
    async function source(version: string) {
        const sourceRoot = path.join(home, 'source-' + version);
        await mkdir(sourceRoot);
        const bytes = Buffer.from('fixture app ' + version);
        await writeFile(path.join(sourceRoot, 'Diagnostic Hub.exe'), bytes);
        await writeFile(
            path.join(sourceRoot, SETUP_PAYLOAD),
            JSON.stringify({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                layout: 'windows-nsis',
                platform: 'win32',
                arch: 'x64',
                version,
                sourceCommit: 'a'.repeat(40),
                entryPoint: 'Diagnostic Hub.exe',
                files: [
                    {
                        kind: 'file',
                        path: 'Diagnostic Hub.exe',
                        bytes: bytes.length,
                        sha256: digest(bytes),
                    },
                ],
            }),
        );
        return context(version, sourceRoot);
    }
    const install = async (
        engine: SetupTransaction,
        action: 'install' | 'repair' | 'update' = 'install',
    ) => {
        const probe = await engine.probe(root);
        return engine.install(
            root,
            action,
            { startMenu: true, desktop: false, launch: false },
            probe.reviewToken,
            true,
            path.join(home, SETUP_UNINSTALLER),
        );
    };
    return {
        home,
        root,
        appData,
        source,
        install,
        changes,
        setBusy: (value: boolean) => (busy = value),
        setObserved: (value: boolean) => (observed = value),
    };
}
test('fresh confirmed install owns exact bytes; optional launch stays deliberate; removal retains profile/report data', async () => {
    const f = await fixture(),
        ctx = await f.source('0.6.0'),
        engine = new SetupTransaction(ctx);
    const before = await engine.probe(f.root);
    assert.deepEqual(before.actions, ['install']);
    await assert.rejects(
        engine.install(
            f.root,
            'install',
            { startMenu: true, desktop: false, launch: false },
            before.reviewToken,
            false,
            path.join(f.home, SETUP_UNINSTALLER),
        ),
        /confirm/,
    );
    await assert.rejects(access(f.root), { code: 'ENOENT' });
    const installed = await f.install(engine);
    assert.equal((await engine.probe(f.root)).state, 'owned');
    assert.equal(
        f.changes.some((c) => c.kind === 'launch'),
        false,
    );
    await mkdir(installed.profile, { recursive: true });
    await writeFile(path.join(installed.profile, 'report-marker.json'), 'preserve me');
    const probe = await engine.probe(f.root);
    await engine.remove(f.root, probe.reviewToken, true);
    await assert.rejects(access(f.root), { code: 'ENOENT' });
    assert.equal(
        await readFile(path.join(installed.profile, 'report-marker.json'), 'utf8'),
        'preserve me',
    );
});
test('unknown data, profile overlap, aliases, changed review state and busy targets refuse before activation', async () => {
    const f = await fixture(),
        ctx = await f.source('0.6.0'),
        engine = new SetupTransaction(ctx);
    await assert.rejects(
        engine.probe(path.join(f.appData, 'DiagnosticHub', 'profiles', 'bad')),
        /separate/,
    );
    await mkdir(f.root);
    await writeFile(path.join(f.root, 'operator.txt'), 'do not remove');
    await assert.rejects(
        engine.probe(f.root),
        /not a recognized Diagnostic Hub installation.*Choose an empty folder/,
    );
    assert.equal(await readFile(path.join(f.root, 'operator.txt'), 'utf8'), 'do not remove');
    await unlink(path.join(f.root, 'operator.txt'));
    const outside = path.join(f.home, 'operator directory');
    await mkdir(outside);
    const alias = path.join(f.home, 'aliased target');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(engine.probe(alias), /aliases/);
    const probe = await engine.probe(f.root);
    await writeFile(path.join(f.root, 'changed.txt'), 'new data');
    await assert.rejects(
        engine.install(
            f.root,
            'install',
            { startMenu: true, desktop: false, launch: false },
            probe.reviewToken,
            true,
            path.join(f.home, SETUP_UNINSTALLER),
        ),
    );
    await unlink(path.join(f.root, 'changed.txt'));
    f.setBusy(true);
    await assert.rejects(f.install(engine), /Close this installation/);
    await assert.rejects(access(path.join(f.root, INSTALLATION_RECORD)), { code: 'ENOENT' });
});
test('corrupted source or failed activation preserves previous runnable bytes and installation/profile ID', async () => {
    const f = await fixture(),
        old = new SetupTransaction(await f.source('0.5.2'));
    const installed = await f.install(old),
        oldBytes = await readFile(path.join(f.root, 'Diagnostic Hub.exe'));
    const next = await f.source('0.6.0');
    await writeFile(path.join(next.sourceRoot, 'Diagnostic Hub.exe'), 'corrupt');
    await assert.rejects(f.install(new SetupTransaction(next), 'update'), /verification/);
    assert.deepEqual(await readFile(path.join(f.root, 'Diagnostic Hub.exe')), oldBytes);
    const descriptor = JSON.parse(
        await readFile(path.join(next.sourceRoot, SETUP_PAYLOAD), 'utf8'),
    );
    await writeFile(path.join(next.sourceRoot, 'Diagnostic Hub.exe'), 'fixture app 0.6.0');
    assert.equal(
        digest(await readFile(path.join(next.sourceRoot, 'Diagnostic Hub.exe'))),
        descriptor.files[0].sha256,
    );
    next.onPhase = async (phase) => {
        if (phase === 'old-retained') throw Error('injected activation failure');
    };
    await assert.rejects(f.install(new SetupTransaction(next), 'update'), /injected/);
    assert.deepEqual(await readFile(path.join(f.root, 'Diagnostic Hub.exe')), oldBytes);
    assert.equal(
        JSON.parse(await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8')).installationId,
        installed.installationId,
    );
});
test('versioned filesystem transaction retains old payload until acknowledgement fixture; downgrade is unavailable', async () => {
    const f = await fixture(),
        oldContext = await f.source('0.5.2'),
        old = new SetupTransaction(oldContext),
        installed = await f.install(old);
    const nextContext = await f.source('0.6.0'),
        next = new SetupTransaction(nextContext);
    const updated = await f.install(next, 'update');
    assert.equal(updated.installationId, installed.installationId);
    assert.equal(updated.previousRetained, true);
    await assert.rejects(next.finalize(f.root));
    const record = JSON.parse(await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8'));
    await mkdir(updated.profile, { recursive: true });
    await acknowledgeSetupBoot({
        root: f.root,
        installationId: record.installationId,
        manifestSHA256: record.manifestSHA256,
        version: '0.6.0',
        profile: updated.profile,
        nativeExecutable: path.join(f.root, 'Diagnostic Hub.exe'),
        processCreationMs: Date.now(),
    });
    await assert.rejects(next.finalize(f.root), /native window/);
    f.setObserved(true);
    assert.equal((await next.finalize(f.root)).confirmed, true);
    assert.deepEqual((await old.probe(f.root)).actions, ['launch']);
    assert.equal(
        JSON.parse(await readFile(path.join(f.root, INSTALLATION_MANIFEST), 'utf8')).version,
        '0.6.0',
    );
});
test('newly active target and unowned additions keep recovery material and never remove operator files', async () => {
    const f = await fixture(),
        old = new SetupTransaction(await f.source('0.5.2'));
    await f.install(old);
    const ctx = await f.source('0.6.0');
    ctx.onPhase = async (phase) => {
        if (phase === 'prepared') f.setBusy(true);
    };
    const next = new SetupTransaction(ctx);
    await assert.rejects(f.install(next, 'update'), /became active/);
    assert.equal(
        JSON.parse(await readFile(path.join(f.root, INSTALLATION_MANIFEST), 'utf8')).version,
        '0.5.2',
    );
    f.setBusy(false);
    const pending = await next.probe(f.root);
    assert.equal(pending.state, 'recovery');
    await next.rollback(f.root, pending.reviewToken, true);
    await assert.rejects(access(maintenancePaths(f.root).journal), { code: 'ENOENT' });
    await writeFile(path.join(f.root, 'user-file.txt'), 'operator evidence');
    const probe = await next.probe(f.root);
    await assert.rejects(next.remove(f.root, probe.reviewToken, true), /unowned/);
    assert.equal(await readFile(path.join(f.root, 'user-file.txt'), 'utf8'), 'operator evidence');
});

test('same-byte Repair distinguishes transaction slots at each interrupted transition', async () => {
    for (const phase of ['copying', 'prepared', 'old-retained', 'candidate-active'] as const) {
        const f = await fixture(),
            ctx = await f.source('0.6.0'),
            engine = new SetupTransaction(ctx);
        const installed = await f.install(engine);
        const before = await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8');
        ctx.onPhase = async (current) => {
            if (current === phase) throw Error('interrupt identical repair ' + phase);
        };
        await assert.rejects(f.install(engine, 'repair'), /interrupt identical repair/);
        assert.equal(await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8'), before);
        assert.equal((await engine.probe(f.root)).state, 'owned');
        assert.equal(JSON.parse(before).installationId, installed.installationId);
        ctx.onPhase = undefined;
        await f.install(engine, 'repair');
        assert.equal(
            JSON.parse(await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8'))
                .installationId,
            installed.installationId,
        );
    }
});

test('successor acknowledgement refuses stale creation and foreign profile before releasing backup', async () => {
    const f = await fixture(),
        old = new SetupTransaction(await f.source('0.5.2'));
    await f.install(old);
    const ctx = await f.source('0.6.0'),
        engine = new SetupTransaction(ctx),
        result = await f.install(engine, 'update');
    f.setObserved(true);
    await mkdir(result.profile, { recursive: true });
    const record = JSON.parse(await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8'));
    const acknowledge = async (profile: string, created: number) =>
        acknowledgeSetupBoot({
            root: f.root,
            installationId: record.installationId,
            manifestSHA256: record.manifestSHA256,
            version: '0.6.0',
            profile,
            nativeExecutable: path.join(f.root, 'Diagnostic Hub.exe'),
            processCreationMs: created,
        });
    await acknowledge(result.profile, 0);
    await assert.rejects(engine.finalize(f.root), /creation.*profile/);
    const foreign = path.join(f.home, 'foreign-profile');
    await mkdir(foreign);
    await acknowledge(foreign, Date.now());
    await assert.rejects(engine.finalize(f.root), /creation.*profile/);
    assert.equal((await engine.probe(f.root)).state, 'recovery');
    let nativeChecks = 0;
    ctx.successorObserved = async (_root, expected) => {
        nativeChecks++;
        assert.equal(expected.profile, result.profile);
        assert.ok(expected.creationTimeMs > 0);
        return nativeChecks === 1;
    };
    await acknowledge(result.profile, Date.now());
    await assert.rejects(engine.finalize(f.root), /successor|native window/);
    assert.equal(nativeChecks, 2, 'native identity must remain valid inside maintenance lock');
    assert.equal((await engine.probe(f.root)).state, 'recovery');
});

test('partial integration failure restores previous version, integration and profile identity', async () => {
    const f = await fixture(),
        old = new SetupTransaction(await f.source('0.5.2')),
        installed = await f.install(old);
    const ctx = await f.source('0.6.0'),
        external = new Map<string, string>();
    external.set('registration', '0.5.2');
    ctx.integrate = async (_root, _id, version, _options, _prior, save) => {
        external.set('registration', version);
        await save([{ kind: 'registry', path: 'fixture-owned-key', values: { version } }]);
        if (version === '0.6.0') throw Error('integration fixture failure after mutation');
        return [{ kind: 'registry', path: 'fixture-owned-key', values: { version } }];
    };
    ctx.removeIntegrations = async () => {
        external.delete('registration');
    };
    await assert.rejects(
        f.install(new SetupTransaction(ctx), 'update'),
        /integration fixture failure/,
    );
    assert.equal(external.get('registration'), '0.5.2');
    assert.equal(
        await readFile(path.join(f.root, 'Diagnostic Hub.exe'), 'utf8'),
        'fixture app 0.5.2',
    );
    assert.equal(
        JSON.parse(await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8')).installationId,
        installed.installationId,
    );
});

test('interrupted removal resumes from external snapshot even after partial metadata deletion', async () => {
    for (const phase of [
        'remove-prepared',
        'remove-retained',
        'remove-payload',
        'remove-integrations',
        'remove-complete',
    ] as const) {
        const f = await fixture(),
            ctx = await f.source('0.6.0'),
            engine = new SetupTransaction(ctx),
            installed = await f.install(engine);
        await mkdir(installed.profile, { recursive: true });
        await writeFile(path.join(installed.profile, 'report.txt'), 'retained report');
        ctx.onPhase = async (current) => {
            if (current === phase) throw Error('interrupted removal ' + phase);
        };
        const before = await engine.probe(f.root);
        await assert.rejects(
            engine.remove(f.root, before.reviewToken, true),
            /interrupted removal/,
        );
        const pending = JSON.parse(await readFile(maintenancePaths(f.root).journal, 'utf8'));
        const previous = path.join(
            maintenancePaths(f.root).work,
            'previous-' + pending.transactionId,
        );
        if (phase === 'remove-integrations') await unlink(path.join(previous, INSTALLATION_RECORD));
        const recovery = await engine.probe(f.root);
        assert.deepEqual(recovery.actions, ['finishremove']);
        await assert.rejects(engine.remove(f.root, recovery.reviewToken, false), /Confirm removal/);
        await assert.rejects(
            engine.rollback(f.root, recovery.reviewToken, true),
            /Resume the confirmed removal/,
        );
        ctx.onPhase = undefined;
        assert.equal((await engine.remove(f.root, recovery.reviewToken, true)).removed, true);
        await assert.rejects(access(f.root), { code: 'ENOENT' });
        await assert.rejects(access(previous), { code: 'ENOENT' });
        assert.equal(
            await readFile(path.join(installed.profile, 'report.txt'), 'utf8'),
            'retained report',
        );
    }
});

test('resumed removal preserves unexpected files and refuses active retained payload', async () => {
    const f = await fixture(),
        ctx = await f.source('0.6.0'),
        engine = new SetupTransaction(ctx);
    await f.install(engine);
    ctx.onPhase = async (phase) => {
        if (phase === 'remove-retained') throw Error('pause removal');
    };
    const before = await engine.probe(f.root);
    await assert.rejects(engine.remove(f.root, before.reviewToken, true), /pause/);
    ctx.onPhase = undefined;
    const journal = JSON.parse(await readFile(maintenancePaths(f.root).journal, 'utf8'));
    const retained = path.join(maintenancePaths(f.root).work, 'previous-' + journal.transactionId),
        unexpected = path.join(retained, 'operator.txt');
    await writeFile(unexpected, 'operator evidence');
    let pending = await engine.probe(f.root);
    await assert.rejects(engine.remove(f.root, pending.reviewToken, true), /unowned/);
    assert.equal(await readFile(unexpected, 'utf8'), 'operator evidence');
    await unlink(unexpected);
    f.setBusy(true);
    pending = await engine.probe(f.root);
    await assert.rejects(engine.remove(f.root, pending.reviewToken, true), /Close the app/);
    assert.equal(
        await readFile(path.join(retained, 'Diagnostic Hub.exe'), 'utf8'),
        'fixture app 0.6.0',
    );
    f.setBusy(false);
    await engine.remove(f.root, pending.reviewToken, true);
});

test('abrupt child-process death leaves recoverable journal at install and removal transitions', async () => {
    for (const phase of [
        'copying',
        'prepared',
        'old-retained',
        'candidate-active',
        'remove-prepared',
        'remove-retained',
        'remove-payload',
        'remove-integrations',
        'remove-complete',
    ]) {
        const f = await fixture(),
            ctx = await f.source('0.6.0'),
            engine = new SetupTransaction(ctx),
            installed = await f.install(engine);
        await mkdir(installed.profile, { recursive: true });
        await writeFile(path.join(installed.profile, 'survivor.txt'), 'survives child death');
        const childCode = `
            import {SetupTransaction} from './electron/setup-transaction.ts';
            const config=JSON.parse(process.env.HUB_SETUP_CRASH_FIXTURE);
            const ctx={...config.context,busy:async()=>false,ownerAlive:async()=>false,processIdentity:async()=>({pid:process.pid,executable:process.execPath,createdAt:'crash-fixture'}),integrate:async(_r,_i,_v,_o,_p,save)=>{await save([]);return[];},validateIntegrations:()=>{},removeIntegrations:async()=>{},launch:async()=>{},successorObserved:async()=>false,onPhase:async(phase)=>{if(phase===config.phase)process.exit(87);}};
            const engine=new SetupTransaction(ctx),probe=await engine.probe(config.root);
            if(config.phase.startsWith('remove-'))await engine.remove(config.root,probe.reviewToken,true);
            else await engine.install(config.root,'repair',{startMenu:true,desktop:false,launch:false},probe.reviewToken,true,config.uninstaller);
            process.exit(88);
        `;
        const child = spawnSync(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', childCode],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HUB_SETUP_CRASH_FIXTURE: JSON.stringify({
                        context: ctx,
                        root: f.root,
                        phase,
                        uninstaller: path.join(f.home, SETUP_UNINSTALLER),
                    }),
                },
                encoding: 'utf8',
                timeout: 20000,
                windowsHide: true,
            },
        );
        assert.equal(child.status, 87, phase + ': ' + child.stderr);
        const pending = await engine.probe(f.root);
        assert.equal(pending.state, 'recovery', phase);
        if (phase.startsWith('remove-')) {
            await engine.remove(f.root, pending.reviewToken, true);
            await assert.rejects(access(f.root), { code: 'ENOENT' });
        } else {
            await engine.rollback(f.root, pending.reviewToken, true);
            assert.equal(
                await readFile(path.join(f.root, 'Diagnostic Hub.exe'), 'utf8'),
                'fixture app 0.6.0',
            );
        }
        assert.equal(
            await readFile(path.join(installed.profile, 'survivor.txt'), 'utf8'),
            'survives child death',
        );
        assert.equal((await readdir(maintenancePaths(f.root).work)).includes('lock.json'), false);
    }
});

test('install and removal reject a replaced ownership identity while acquiring maintenance', async () => {
    for (const action of ['repair', 'remove'] as const) {
        const f = await fixture(),
            ctx = await f.source('0.6.0'),
            engine = new SetupTransaction(ctx);
        await f.install(engine);
        const before = await engine.probe(f.root),
            recordFile = path.join(f.root, INSTALLATION_RECORD),
            ownerFile = path.join(f.root, '.diagnostic-hub-ownership.json'),
            changedId = randomUUID();
        let changed = false;
        ctx.busy = async () => {
            if (!changed) {
                changed = true;
                for (const file of [recordFile, ownerFile]) {
                    const value = JSON.parse(await readFile(file, 'utf8'));
                    value.installationId = changedId;
                    await writeFile(file, JSON.stringify(value));
                }
            }
            return false;
        };
        if (action === 'remove')
            await assert.rejects(
                engine.remove(f.root, before.reviewToken, true),
                /Reviewed removal changed/,
            );
        else await assert.rejects(f.install(engine, 'repair'), /Reviewed installation changed/);
        assert.equal(JSON.parse(await readFile(recordFile, 'utf8')).installationId, changedId);
        assert.equal(
            await readFile(path.join(f.root, 'Diagnostic Hub.exe'), 'utf8'),
            'fixture app 0.6.0',
        );
    }
});
test('changed candidate payload retains prior bytes despite an otherwise matching successor acknowledgement', async () => {
    const f = await fixture(),
        old = new SetupTransaction(await f.source('0.5.2'));
    await f.install(old);
    const ctx = await f.source('0.6.0'),
        engine = new SetupTransaction(ctx),
        result = await f.install(engine, 'update');
    await mkdir(result.profile, { recursive: true });
    const record = JSON.parse(await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8'));
    await acknowledgeSetupBoot({
        root: f.root,
        installationId: record.installationId,
        manifestSHA256: record.manifestSHA256,
        version: '0.6.0',
        profile: result.profile,
        nativeExecutable: path.join(f.root, 'Diagnostic Hub.exe'),
        processCreationMs: Date.now(),
    });
    f.setObserved(true);
    await writeFile(path.join(f.root, 'Diagnostic Hub.exe'), 'damaged candidate');
    await assert.rejects(engine.finalize(f.root), /verification/);
    const journal = JSON.parse(await readFile(maintenancePaths(f.root).journal, 'utf8'));
    assert.equal(
        await readFile(
            path.join(
                maintenancePaths(f.root).work,
                'previous-' + journal.transactionId,
                'Diagnostic Hub.exe',
            ),
            'utf8',
        ),
        'fixture app 0.5.2',
    );
});

test('invalid external integration ownership refuses before removal moves or deletes the app', async () => {
    const f = await fixture(),
        ctx = await f.source('0.6.0'),
        engine = new SetupTransaction(ctx);
    await f.install(engine);
    ctx.validateIntegrations = () => {
        throw Error('Invalid external integration ownership fixture');
    };
    const before = await engine.probe(f.root);
    await assert.rejects(
        engine.remove(f.root, before.reviewToken, true),
        /Invalid external integration ownership/,
    );
    assert.equal(
        await readFile(path.join(f.root, 'Diagnostic Hub.exe'), 'utf8'),
        'fixture app 0.6.0',
    );
    assert.equal((await engine.probe(f.root)).state, 'owned');
});

async function addNestedPayload(context: SetupContext) {
    const filename = path.join(context.sourceRoot, 'nested', 'owned.txt'),
        bytes = Buffer.from('nested owned ' + context.version);
    await mkdir(path.dirname(filename));
    await writeFile(filename, bytes);
    const manifestFile = path.join(context.sourceRoot, SETUP_PAYLOAD),
        manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.files.push({
        kind: 'file',
        path: 'nested/owned.txt',
        bytes: bytes.length,
        sha256: digest(bytes),
    });
    await writeFile(manifestFile, JSON.stringify(manifest));
}
async function slotFixture(deep = false) {
    const f = await fixture(),
        oldContext = await f.source('0.5.2');
    await addNestedPayload(oldContext);
    if (deep) await addDeepPayload(oldContext);
    const installed = await f.install(new SetupTransaction(oldContext)),
        ctx = await f.source('0.6.0');
    await addNestedPayload(ctx);
    if (deep) await addDeepPayload(ctx);
    const engine = new SetupTransaction(ctx),
        updated = await f.install(engine, 'update');
    await mkdir(updated.profile, { recursive: true });
    await writeFile(path.join(updated.profile, 'report-survivor.txt'), 'profile/report retained');
    const record = JSON.parse(await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8'));
    await acknowledgeSetupBoot({
        root: f.root,
        installationId: record.installationId,
        manifestSHA256: record.manifestSHA256,
        version: '0.6.0',
        profile: updated.profile,
        nativeExecutable: path.join(f.root, 'Diagnostic Hub.exe'),
        processCreationMs: Date.now(),
    });
    f.setObserved(true);
    const journal = JSON.parse(await readFile(maintenancePaths(f.root).journal, 'utf8')),
        work = maintenancePaths(f.root).work;
    return {
        ...f,
        ctx,
        engine,
        installed,
        updated,
        stage: path.join(work, 'stage-' + journal.transactionId),
        previous: path.join(work, 'previous-' + journal.transactionId),
        cleanup: path.join(work, 'cleanup-' + journal.transactionId + '.json'),
    };
}
test('abrupt death after every declared file and directory deletion resumes rollback/finalize from external ledger', async () => {
    const entries = [
        ['Diagnostic Hub.exe', 'file'],
        ['nested/owned.txt', 'file'],
        [SETUP_PAYLOAD, 'file'],
        [SETUP_UNINSTALLER, 'file'],
        [SETUP_OWNER, 'file'],
        [INSTALLATION_RECORD, 'file'],
        [INSTALLATION_MANIFEST, 'file'],
        ['nested', 'directory'],
        ['.', 'directory'],
    ] as const;
    for (const operation of ['rollback', 'finalize'] as const) {
        for (const [relativePath, kind] of entries) {
            const f = await slotFixture();
            const childCode = `
            import {SetupTransaction} from './electron/setup-transaction.ts';
            const config=JSON.parse(process.env.HUB_SLOT_DELETE_FIXTURE);
            const context={...config.context,busy:async()=>false,ownerAlive:async()=>false,processIdentity:async()=>({pid:process.pid,executable:process.execPath,createdAt:'slot-delete-child'}),integrate:async(_r,_i,_v,_o,_p,save)=>{await save([]);return[];},validateIntegrations:()=>{},removeIntegrations:async()=>{},launch:async()=>{},successorObserved:async()=>true,onDelete:async(event)=>{if(event.operation===config.operation&&event.relativePath===config.relativePath&&event.kind===config.kind)process.exit(87);}};
            const engine=new SetupTransaction(context);
            if(config.operation==='rollback'){const probe=await engine.probe(config.root);await engine.rollback(config.root,probe.reviewToken,true);}else await engine.finalize(config.root);
            process.exit(88);
        `;
            const child = spawnSync(
                process.execPath,
                ['--import', 'tsx', '--input-type=module', '-e', childCode],
                {
                    cwd: process.cwd(),
                    env: {
                        ...process.env,
                        HUB_SLOT_DELETE_FIXTURE: JSON.stringify({
                            context: f.ctx,
                            root: f.root,
                            operation,
                            relativePath,
                            kind,
                        }),
                    },
                    encoding: 'utf8',
                    timeout: 20000,
                    windowsHide: true,
                },
            );
            assert.equal(child.status, 87, operation + ' ' + relativePath + ': ' + child.stderr);
            const journal = JSON.parse(await readFile(maintenancePaths(f.root).journal, 'utf8'));
            const ledger = await readFile(f.cleanup);
            assert.equal(digest(ledger), journal.cleanupSHA256);
            assert.equal(
                journal.phase,
                operation === 'rollback' ? 'rolling-back' : 'candidate-confirmed',
            );
            const pending = await f.engine.probe(f.root);
            if (operation === 'rollback') {
                assert.deepEqual(pending.actions, ['rollback']);
                await f.engine.rollback(f.root, pending.reviewToken, true);
                assert.equal(
                    await readFile(path.join(f.root, 'Diagnostic Hub.exe'), 'utf8'),
                    'fixture app 0.5.2',
                );
            } else {
                assert.deepEqual(pending.actions, ['launch', 'finalize']);
                await assert.rejects(
                    f.engine.rollback(f.root, pending.reviewToken, true),
                    /committed/,
                );
                assert.equal((await f.engine.finalize(f.root)).confirmed, true);
                assert.equal(
                    await readFile(path.join(f.root, 'Diagnostic Hub.exe'), 'utf8'),
                    'fixture app 0.6.0',
                );
            }
            assert.equal(
                JSON.parse(await readFile(path.join(f.root, INSTALLATION_RECORD), 'utf8'))
                    .installationId,
                f.installed.installationId,
            );
            assert.equal(
                await readFile(path.join(f.updated.profile, 'report-survivor.txt'), 'utf8'),
                'profile/report retained',
            );
            await assert.rejects(access(operation === 'rollback' ? f.stage : f.previous), {
                code: 'ENOENT',
            });
            await assert.rejects(access(f.cleanup), { code: 'ENOENT' });
            await assert.rejects(access(maintenancePaths(f.root).journal), { code: 'ENOENT' });
        }
    }
});
test('retained-slot busy refusal precedes rollback moves and finalize commit/deletion', async () => {
    for (const operation of ['rollback', 'finalize'] as const) {
        const f = await slotFixture(),
            before = await readFile(maintenancePaths(f.root).journal),
            rootBytes = await readFile(path.join(f.root, 'Diagnostic Hub.exe')),
            previousBytes = await readFile(path.join(f.previous, 'Diagnostic Hub.exe'));
        f.ctx.busy = async (root) => root === f.previous;
        if (operation === 'rollback') {
            const probe = await f.engine.probe(f.root);
            await assert.rejects(
                f.engine.rollback(f.root, probe.reviewToken, true),
                /Close the app/,
            );
        } else await assert.rejects(f.engine.finalize(f.root), /Close the app/);
        assert.deepEqual(await readFile(maintenancePaths(f.root).journal), before);
        assert.deepEqual(await readFile(path.join(f.root, 'Diagnostic Hub.exe')), rootBytes);
        assert.deepEqual(
            await readFile(path.join(f.previous, 'Diagnostic Hub.exe')),
            previousBytes,
        );
        await assert.rejects(access(f.cleanup), { code: 'ENOENT' });
    }
});
test('staged-slot busy refusal preserves prepared stage, and new root activity refuses immediately before rename', async () => {
    const f = await fixture(),
        old = new SetupTransaction(await f.source('0.5.2'));
    await f.install(old);
    const ctx = await f.source('0.6.0'),
        engine = new SetupTransaction(ctx);
    let stageBusy = false;
    ctx.onPhase = async (phase) => {
        if (phase === 'prepared') {
            stageBusy = true;
            throw Error('prepared-stage pause');
        }
    };
    ctx.busy = async (root) => stageBusy && path.basename(root).startsWith('stage-');
    await assert.rejects(f.install(engine, 'update'), /prepared-stage pause/);
    ctx.onPhase = undefined;
    const pending = await engine.probe(f.root),
        journal = JSON.parse(await readFile(maintenancePaths(f.root).journal, 'utf8')),
        stage = path.join(maintenancePaths(f.root).work, 'stage-' + journal.transactionId);
    await assert.rejects(engine.rollback(f.root, pending.reviewToken, true), /Close the app/);
    assert.equal(
        await readFile(path.join(stage, 'Diagnostic Hub.exe'), 'utf8'),
        'fixture app 0.6.0',
    );
    assert.equal(
        await readFile(path.join(f.root, 'Diagnostic Hub.exe'), 'utf8'),
        'fixture app 0.5.2',
    );
    stageBusy = false;
    await engine.rollback(f.root, pending.reviewToken, true);
    const next = await slotFixture();
    let rootChecks = 0;
    next.ctx.busy = async (root) => root === next.root && ++rootChecks > 1;
    const probe = await next.engine.probe(next.root);
    await assert.rejects(next.engine.rollback(next.root, probe.reviewToken, true), /Close the app/);
    assert.equal(
        await readFile(path.join(next.root, 'Diagnostic Hub.exe'), 'utf8'),
        'fixture app 0.6.0',
    );
    assert.equal(
        await readFile(path.join(next.previous, 'Diagnostic Hub.exe'), 'utf8'),
        'fixture app 0.5.2',
    );
});
test('new slot activity between deletions refuses the next mutation and leaves a resumable ledger', async () => {
    for (const operation of ['rollback', 'finalize'] as const) {
        const f = await slotFixture();
        let active = false,
            deletions = 0;
        f.ctx.busy = async (root) =>
            active && root === (operation === 'rollback' ? f.stage : f.previous);
        f.ctx.onDelete = async (event) => {
            if (event.operation === operation) {
                deletions++;
                active = true;
            }
        };
        if (operation === 'rollback') {
            const probe = await f.engine.probe(f.root);
            await assert.rejects(
                f.engine.rollback(f.root, probe.reviewToken, true),
                /Close the app/,
            );
        } else await assert.rejects(f.engine.finalize(f.root), /Close the app/);
        assert.equal(deletions, 1);
        assert.equal(
            await readFile(
                path.join(operation === 'rollback' ? f.stage : f.previous, 'nested', 'owned.txt'),
                'utf8',
            ),
            'nested owned ' + (operation === 'rollback' ? '0.6.0' : '0.5.2'),
        );
        active = false;
        f.ctx.onDelete = undefined;
        if (operation === 'rollback') {
            const probe = await f.engine.probe(f.root);
            await f.engine.rollback(f.root, probe.reviewToken, true);
        } else await f.engine.finalize(f.root);
    }
});
test('cleanup never recurses into new empty/unowned directories and rejects changed ledgers or aliased slots', async () => {
    const f = await slotFixture();
    let added = false;
    f.ctx.onDelete = async (event) => {
        if (event.operation === 'finalize' && !added) {
            added = true;
            await mkdir(path.join(f.previous, 'operator-empty-dir'));
            await writeFile(path.join(f.previous, 'operator.txt'), 'retain operator evidence');
        }
    };
    await assert.rejects(f.engine.finalize(f.root), /ENOTEMPTY|not empty/);
    f.ctx.onDelete = undefined;
    await assert.rejects(f.engine.finalize(f.root), /unowned/);
    assert.equal(
        await readFile(path.join(f.previous, 'operator.txt'), 'utf8'),
        'retain operator evidence',
    );
    await unlink(path.join(f.previous, 'operator.txt'));
    await rmdir(path.join(f.previous, 'operator-empty-dir'));
    await f.engine.finalize(f.root);
    const alias = await slotFixture();
    alias.ctx.onDelete = async (event) => {
        if (event.operation === 'rollback') throw Error('slot deletion pause');
    };
    const probe = await alias.engine.probe(alias.root);
    await assert.rejects(
        alias.engine.rollback(alias.root, probe.reviewToken, true),
        /slot deletion pause/,
    );
    alias.ctx.onDelete = undefined;
    const retained = alias.stage + '-retained',
        outside = path.join(alias.home, 'operator-folder');
    await rename(alias.stage, retained);
    await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside survivor');
    await symlink(outside, alias.stage, process.platform === 'win32' ? 'junction' : 'dir');
    const recovery = await alias.engine.probe(alias.root);
    await assert.rejects(alias.engine.rollback(alias.root, recovery.reviewToken, true), /alias/);
    assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside survivor');
    const changed = await slotFixture();
    changed.ctx.onDelete = async () => {
        throw Error('cleanup ledger pause');
    };
    await assert.rejects(changed.engine.finalize(changed.root), /cleanup ledger pause/);
    changed.ctx.onDelete = undefined;
    const original = await readFile(changed.cleanup);
    await writeFile(changed.cleanup, Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(changed.engine.probe(changed.root), /ledger identity differs/);
});

async function addDeepPayload(ctx: SetupContext) {
    const manifestFile = path.join(ctx.sourceRoot, SETUP_PAYLOAD),
        manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    for (const name of ['tree/branch/owned.txt', 'tree/branch/second.txt']) {
        const bytes = Buffer.from('Deep owned ' + ctx.version + ' ' + name),
            filename = path.join(ctx.sourceRoot, ...name.split('/'));
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, bytes);
        manifest.files.push({
            kind: 'file',
            path: name,
            bytes: bytes.length,
            sha256: digest(bytes),
        });
    }
    await writeFile(manifestFile, JSON.stringify(manifest));
}
test('nested parent junction inserted after file deletion cannot redirect rollback/finalize directory removal', async () => {
    for (const operation of ['rollback', 'finalize'] as const) {
        const f = await slotFixture(true),
            slot = operation === 'rollback' ? f.stage : f.previous,
            outside = path.join(f.home, 'external-' + operation),
            branch = path.join(outside, 'branch');
        await mkdir(branch, { recursive: true });
        await writeFile(path.join(outside, 'sentinel.txt'), 'external directory survivor');
        let inserted = false;
        f.ctx.onDelete = async (event) => {
            if (
                event.operation === operation &&
                event.relativePath === 'tree/branch/second.txt' &&
                !inserted
            ) {
                inserted = true;
                await rename(path.join(slot, 'tree'), path.join(slot, 'tree-retained'));
                await symlink(
                    outside,
                    path.join(slot, 'tree'),
                    process.platform === 'win32' ? 'junction' : 'dir',
                );
            }
        };
        if (operation === 'rollback') {
            const probe = await f.engine.probe(f.root);
            await assert.rejects(
                f.engine.rollback(f.root, probe.reviewToken, true),
                /parent alias/,
            );
        } else await assert.rejects(f.engine.finalize(f.root), /parent alias/);
        assert.equal(inserted, true);
        await access(branch);
        assert.equal(
            await readFile(path.join(outside, 'sentinel.txt'), 'utf8'),
            'external directory survivor',
        );
        await access(f.cleanup);
        await access(maintenancePaths(f.root).journal);
        f.ctx.onDelete = undefined;
        await unlink(path.join(slot, 'tree'));
        await rename(path.join(slot, 'tree-retained'), path.join(slot, 'tree'));
        if (operation === 'rollback') {
            const probe = await f.engine.probe(f.root);
            await f.engine.rollback(f.root, probe.reviewToken, true);
        } else await f.engine.finalize(f.root);
        await access(branch);
    }
});
test('removal payload loop rejects nested ancestor alias inserted between deletions and preserves external files', async () => {
    const f = await fixture(),
        ctx = await f.source('0.6.0');
    await addDeepPayload(ctx);
    const engine = new SetupTransaction(ctx),
        installed = await f.install(engine),
        outside = path.join(f.home, 'external-removal'),
        branch = path.join(outside, 'branch');
    await mkdir(branch, { recursive: true });
    for (const name of ['owned.txt', 'second.txt'])
        await writeFile(path.join(branch, name), 'external ' + name);
    let slot = '',
        inserted = false;
    ctx.onDelete = async (event) => {
        if (
            event.operation === 'remove' &&
            event.relativePath === 'Diagnostic Hub.exe' &&
            !inserted
        ) {
            const journal = JSON.parse(await readFile(maintenancePaths(f.root).journal, 'utf8'));
            slot = path.join(maintenancePaths(f.root).work, 'previous-' + journal.transactionId);
            inserted = true;
            await rename(path.join(slot, 'tree'), path.join(slot, 'tree-retained'));
            await symlink(
                outside,
                path.join(slot, 'tree'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
        }
    };
    const before = await engine.probe(f.root);
    await assert.rejects(engine.remove(f.root, before.reviewToken, true), /parent alias/);
    assert.equal(inserted, true);
    for (const name of ['owned.txt', 'second.txt'])
        assert.equal(await readFile(path.join(branch, name), 'utf8'), 'external ' + name);
    ctx.onDelete = undefined;
    await unlink(path.join(slot, 'tree'));
    await rename(path.join(slot, 'tree-retained'), path.join(slot, 'tree'));
    const pending = await engine.probe(f.root);
    assert.equal((await engine.remove(f.root, pending.reviewToken, true)).removed, true);
    for (const name of ['owned.txt', 'second.txt'])
        assert.equal(await readFile(path.join(branch, name), 'utf8'), 'external ' + name);
    assert.equal(installed.profile.startsWith(f.appData), true);
});
test('a nested parent swapped during busy inspection is revalidated before the following unlink', async () => {
    const f = await slotFixture(true),
        outside = path.join(f.home, 'external-busy-parent'),
        branch = path.join(outside, 'branch');
    await mkdir(branch, { recursive: true });
    await writeFile(path.join(branch, 'owned.txt'), 'outside before unlink');
    let insertOnNextBusy = false,
        inserted = false;
    f.ctx.onDelete = async (event) => {
        if (event.operation === 'finalize' && event.relativePath === 'nested/owned.txt')
            insertOnNextBusy = true;
    };
    f.ctx.busy = async (root) => {
        if (root === f.previous && insertOnNextBusy && !inserted) {
            inserted = true;
            await rename(path.join(f.previous, 'tree'), path.join(f.previous, 'tree-retained'));
            await symlink(
                outside,
                path.join(f.previous, 'tree'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
        }
        return false;
    };
    await assert.rejects(f.engine.finalize(f.root), /parent alias/);
    assert.equal(inserted, true);
    assert.equal(await readFile(path.join(branch, 'owned.txt'), 'utf8'), 'outside before unlink');
});

test('incomplete setup identities get actionable refusal without changing files or setup state', async () => {
    const names = [INSTALLATION_RECORD, INSTALLATION_MANIFEST, SETUP_OWNER];
    for (const present of [[0], [1], [2], [0, 1], [0, 2], [1, 2]]) {
        const f = await fixture();
        const engine = new SetupTransaction(await f.source('0.6.0'));
        await mkdir(f.root);
        const expected = new Map<string, string>([['operator.txt', 'retain operator evidence']]);
        for (const index of present)
            expected.set(names[index], '{"partial":"retain these exact bytes"}');
        for (const [name, bytes] of expected) await writeFile(path.join(f.root, name), bytes);
        await assert.rejects(engine.probe(f.root), (error: Error) => {
            assert.match(error.message, /incomplete setup information/);
            assert.match(
                error.message,
                /Choose another empty folder or use the matching setup to recover/,
            );
            assert.match(error.message, /No files were changed/);
            assert.doesNotMatch(error.message, /ENOENT/);
            return true;
        });
        assert.deepEqual((await readdir(f.root)).sort(), [...expected.keys()].sort());
        for (const [name, bytes] of expected)
            assert.equal(await readFile(path.join(f.root, name), 'utf8'), bytes);
        assert.deepEqual(f.changes, []);
        await assert.rejects(access(maintenancePaths(f.root).work), { code: 'ENOENT' });
        await assert.rejects(access(f.appData), { code: 'ENOENT' });
    }
});
