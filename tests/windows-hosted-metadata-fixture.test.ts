// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {
    hostedMetadataFixturePolicy as policy,
    hostedFixtureContext,
    validateHostedFixtureDescriptors,
    runHostedMetadataFixture,
} from '../scripts/lib/hosted-ci-metadata-fixture.mjs';
import {
    metadataIdentity,
    ancestryIdentity,
    PreflightJournal,
    writeReport,
} from '../scripts/lib/windows-preflight.mjs';
import { directoryFactsScope } from '../scripts/lib/directory-security-facts.mjs';
import {
    inspectHostedFixtureDescriptors,
    runPreflightCommand,
    directoryFactsInput,
    recordJournalClosure,
} from '../scripts/memory-product-preflight.mts';
import { sourceFingerprint } from './fixtures/memory-resource-identity';
const recorded = JSON.parse(
    fs.readFileSync(
        new URL('./fixtures/windows-hosted-temp-descriptor.json', import.meta.url),
        'utf8',
    ),
);
const principal = recorded.principal,
    nonce = '4c1f673f-c734-48a2-9a47-a6210a478960';
const clone = (v) => JSON.parse(JSON.stringify(v));
const stable = (id) =>
    Object.fromEntries(['path', 'realpath', 'directory', 'dev', 'ino'].map((k) => [k, id[k]]));
function descriptorReport(paths) {
    const rows = paths.map((literal) => ({ ...clone(recorded.descriptor), path: literal }));
    return {
        ...directoryFactsScope,
        serializationContract: {
            schema: 1,
            suite: 'directory-input-serialization-v1',
            passed: 25,
            failed: 0,
            error: null,
        },
        complete: true,
        descriptorBytes: rows.reduce((n, r) => n + r.descriptorBytes, 0),
        descriptorUtf8Bytes: rows.reduce((n, r) => n + Buffer.byteLength(r.sddl), 0),
        rows,
        stoppedAt: null,
        error: null,
    };
}
function allow(sid, mask = 0x1f01ff, flags = 19, type = 0) {
    const numbers = sid.split('-').slice(2).map(BigInt),
        subs = numbers.slice(1),
        bytes = Buffer.alloc(16 + subs.length * 4);
    bytes[0] = type;
    bytes[1] = flags;
    bytes.writeUInt16LE(bytes.length, 2);
    bytes.writeUInt32LE(mask, 4);
    bytes[8] = 1;
    bytes[9] = subs.length;
    let authority = numbers[0];
    for (let i = 15; i >= 10; i--) {
        bytes[i] = Number(authority & 255n);
        authority >>= 8n;
    }
    subs.forEach((n, i) => bytes.writeUInt32LE(Number(n), 16 + i * 4));
    return { type, flags, binary: bytes.toString('base64') };
}
test('accepted hosted Temp evidence admits exact three-principal inheritance without owner-user equality', () => {
    const paths = [
            'C:\\Users\\runneradmin\\AppData\\Local\\Temp',
            'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\child',
        ],
        r = descriptorReport(paths);
    const admitted = validateHostedFixtureDescriptors(r, paths, principal);
    assert.equal(admitted.ownerSIDEqualityRequired, false);
    assert.equal(admitted.collectionApproval, false);
    assert.equal(r.rows[0].owner, 'S-1-5-32-544');
    r.rows[1].owner = principal;
    assert(validateHostedFixtureDescriptors(r, paths, principal));
});
for (const [name, mutate] of [
    ['unexpected owner', (r) => (r.rows[1].owner = 'S-1-5-32-545')],
    ['broad Users grant', (r) => (r.rows[1].aces[2] = allow('S-1-5-32-545'))],
    ['wrong runner SID', (r) => (r.rows[1].aces[2] = allow(principal.replace(/500$/, '501')))],
    ['duplicate trusted SID', (r) => (r.rows[1].aces[2] = clone(r.rows[1].aces[0]))],
    [
        'extra grant',
        (r) => {
            r.rows[1].aces.push(allow('S-1-1-0'));
            r.rows[1].aceCount++;
        },
    ],
    [
        'missing grant',
        (r) => {
            r.rows[1].aces.pop();
            r.rows[1].aceCount--;
        },
    ],
    ['different mask', (r) => (r.rows[1].aces[2] = allow(principal, 0x1200a9))],
    ['inherit-only', (r) => (r.rows[1].aces[2] = allow(principal, 0x1f01ff, 27))],
    ['not inherited', (r) => (r.rows[1].aces[2] = allow(principal, 0x1f01ff, 3))],
    ['deny', (r) => (r.rows[1].aces[2] = allow(principal, 0x1f01ff, 19, 1))],
    ['object ACE', (r) => (r.rows[1].aces[2] = allow(principal, 0x1f01ff, 19, 5))],
    ['callback ACE', (r) => (r.rows[1].aces[2] = allow(principal, 0x1f01ff, 19, 9))],
    ['unknown ACE', (r) => (r.rows[1].aces[2] = allow(principal, 0x1f01ff, 19, 127))],
    [
        'extra ACE bytes',
        (r) => {
            const a = r.rows[1].aces[2],
                b = Buffer.concat([Buffer.from(a.binary, 'base64'), Buffer.alloc(4)]);
            b.writeUInt16LE(b.length, 2);
            a.binary = b.toString('base64');
        },
    ],
    ['null DACL', (r) => (r.rows[1].daclNull = true)],
    ['absent DACL', (r) => (r.rows[1].daclPresent = false)],
    [
        'empty DACL',
        (r) => {
            r.rows[1].daclState = 'empty';
            r.rows[1].aceCount = 0;
            r.rows[1].aces = [];
        },
    ],
    ['unavailable row', (r) => (r.rows[1].availability = 'unavailable')],
    ['partial provider', (r) => (r.complete = false)],
    ['group drift', (r) => (r.rows[1].group = 'S-1-5-32-545')],
    ['alternate child', (r) => (r.rows[1].path = 'C:\\other')],
])
    test(`fixture policy refuses ${name} without repairing descriptors`, () => {
        const paths = ['parent', 'child'],
            r = descriptorReport(paths);
        mutate(r);
        assert.throws(() => validateHostedFixtureDescriptors(r, paths, principal));
    });
function hostedModel(changes = {}) {
    const env = {
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Windows',
        RUNNER_ARCH: 'X64',
        GITHUB_REPOSITORY: policy.repository,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_RUN_ATTEMPT: '1',
        HUB_WINDOWS_PREFLIGHT_ONLY: '1',
        GITHUB_RUN_ID: '39107781069',
        GITHUB_SHA: 'b'.repeat(40),
        USERPROFILE: 'C:\\Users\\runneradmin',
        LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local',
        TEMP: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp',
        TMP: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp',
        ...changes,
    };
    const identity = (p) => ({
        path: p,
        realpath: p,
        directory: true,
        file: false,
        dev: p.startsWith('C:') ? 'C' : 'D',
        ino: p.endsWith('Temp') ? '42' : p.endsWith('Local') ? '41' : '40',
    });
    return {
        env,
        ops: {
            platform: 'win32',
            realpath: (p) => p,
            identity,
            ancestry: (p) => [stable(identity(p))],
        },
    };
}
test('hosted context binds profile/local/canonical aliases physically without changing TEMP or TMP', () => {
    const { env, ops } = hostedModel(),
        saved = { ...env },
        c = hostedFixtureContext(env.TEMP, env, ops);
    assert.equal(c.parent, 'C:\\Users\\runneradmin\\AppData\\Local\\Temp');
    assert.deepEqual(env, saved);
    env.TEMP = 'D:\\else';
    assert.throws(() => c.checkEnvironment());
});
for (const changes of [
    { GITHUB_ACTIONS: 'false' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { RUNNER_OS: 'Linux' },
    { RUNNER_ARCH: 'ARM64' },
    { GITHUB_REPOSITORY: 'other/repo' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { HUB_WINDOWS_PREFLIGHT_ONLY: '0' },
    { GITHUB_RUN_ID: 'bad' },
    { GITHUB_SHA: 'bad' },
    { USERPROFILE: 'D:\\a' },
    { USERPROFILE: 'C:\\Users\\runneradmin\\other' },
    { LOCALAPPDATA: 'D:\\a\\Local' },
])
    test('CI-only parent gate refuses ' + JSON.stringify(changes), () => {
        const { env, ops } = hostedModel(changes);
        assert.throws(() => hostedFixtureContext(env.TEMP, env, ops));
    });
test('user-machine platform, alternate canonical Temp and physical alias failure refuse fixture context', () => {
    let { env, ops } = hostedModel();
    assert.throws(() => hostedFixtureContext(env.TEMP, env, { ...ops, platform: 'darwin' }));
    assert.throws(() => hostedFixtureContext('D:\\a\\Temp', env, ops));
    assert.throws(() =>
        hostedFixtureContext(env.TEMP, env, {
            ...ops,
            identity: () => {
                throw Error('Reparse refused');
            },
        }),
    );
});

// Actual controller and metadataFileProbe on real disposable files/journal.
// The Windows descriptor command is injected; these tests do not qualify WinPS or Windows ACL inheritance.
async function exercise(options = {}) {
    const temp = fs.mkdtempSync(
            path.join(fs.realpathSync(os.tmpdir()), 'hub-hosted-fixture-control-'),
        ),
        parent = path.join(temp, 'profile/AppData/Local/Temp'),
        reportRoot = path.join(temp, 'report'),
        root = path.join(temp, 'source'),
        marker = path.join(temp, 'marker');
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(reportRoot);
    fs.mkdirSync(root);
    const source = path.join(root, directoryFactsInput.path);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.copyFileSync(new URL('../scripts/lib/windows-directory-facts.ps1', import.meta.url), source);
    const powershell = path.join(temp, 'powershell.exe'),
        pe = Buffer.alloc(128);
    pe.write('MZ');
    pe.writeUInt32LE(64, 60);
    pe.writeUInt32LE(0x4550, 64);
    pe.writeUInt16LE(34404, 68);
    fs.writeFileSync(powershell, pe);
    const sha = await sourceFingerprint(root),
        journal = new PreflightJournal(reportRoot),
        report = { status: null, failures: [], observations: [] },
        events = [],
        opened = new Set();
    let cancelled = false,
        expired = false,
        environmentChanged = false,
        child = null;
    const context = {
        policy: policy.name,
        parent,
        parentIdentity: stable(metadataIdentity(parent)),
        ancestry: ancestryIdentity(parent),
        host: { repository: policy.repository, run: 'model', attempt: '1', commit: 'b'.repeat(40) },
        preservedEnvironment: { TEMP: 'unchanged', TMP: 'unchanged' },
        checkEnvironment: () => assert(!environmentChanged, 'Model environment drift'),
    };
    const observe = (name, data) => {
        report.observations.push({ name, data: clone(data) });
        journal.append(name, data);
        events.push(name);
        return data;
    };
    const admit = () => {
        assert(!cancelled, 'Model cancellation');
        assert(!expired, 'Model deadline');
    };
    const step = async (name, work) => {
        admit();
        try {
            return observe(name, await work());
        } catch (e) {
            observe(name, { status: 'blocked-or-unavailable', error: String(e) });
            report.failures.push(String(e));
            return null;
        }
    };
    const cleanupCheck = () => assert(!fs.existsSync(marker), 'Model marker appeared');
    const command = (exe, script, extra, { onResult } = {}) =>
        runPreflightCommand(exe, script, extra, {
            windowsPowerShell: true,
            onResult,
            spawn(_exe, _args, settings) {
                const paths = JSON.parse(settings.env.HUB_PREFLIGHT_DIRECTORY_PATHS);
                child = paths[1];
                assert.equal(paths[0], parent);
                assert.deepEqual(
                    fs.readdirSync(child),
                    [],
                    'No payload before descriptor/identity verification',
                );
                const r = descriptorReport(paths);
                options.mutate?.(r);
                options.during?.({
                    parent,
                    child,
                    source,
                    marker,
                    context,
                    setCancelled: () => (cancelled = true),
                    setExpired: () => (expired = true),
                    setEnvironmentChanged: () => (environmentChanged = true),
                });
                return { status: 0, signal: null, stdout: JSON.stringify(r), stderr: '' };
            },
        });
    const close = fs.closeSync,
        rmdir = fs.rmdirSync;
    const io = {
        ...fs,
        openSync(file, ...args) {
            assert(
                events.includes('metadata-fixture-admission'),
                'Payload I/O before descriptor admission',
            );
            assert.equal(path.dirname(file), child);
            const fd = fs.openSync(file, ...args);
            opened.add(fd);
            return fd;
        },
        writeFileSync(fd, bytes, ...args) {
            const v = fs.writeFileSync(fd, bytes, ...args);
            if (options.cancelAfterWrite) cancelled = true;
            if (options.expireAfterWrite) expired = true;
            return v;
        },
        readSync(...args) {
            if (options.readFailure) throw Error('Injected payload read failure');
            return fs.readSync(...args);
        },
        closeSync(fd) {
            if (options.unknownClose) throw Error('Injected unknown close');
            return fs.closeSync(fd);
        },
    };
    if (options.unknownClose)
        fs.closeSync = (fd) => {
            if (opened.has(fd)) throw Error('Injected unknown final close');
            return close(fd);
        };
    if (options.rmdirFailure)
        fs.rmdirSync = (p, ...args) => {
            if (path.dirname(p) === parent) throw Error('Injected fixture rmdir failure');
            return rmdir(p, ...args);
        };
    if (options.collision) {
        const existing = path.join(parent, 'diagnostic-hub-ci-metadata-' + nonce);
        fs.mkdirSync(existing);
        fs.writeFileSync(path.join(existing, 'unrelated.txt'), 'retain');
    }
    let result;
    try {
        result = await runHostedMetadataFixture({
            context,
            principal,
            inspect: (paths) =>
                inspectHostedFixtureDescriptors({
                    root,
                    powershell,
                    sourceSHA256: sha,
                    paths,
                    command,
                    observe,
                    step,
                    admit,
                }),
            admit,
            cleanupCheck,
            observe,
            io,
            nonce: () => nonce,
        });
    } finally {
        fs.closeSync = close;
        fs.rmdirSync = rmdir;
        recordJournalClosure(report, journal.close());
    }
    report.status = result?.controlPassed ? 'MODEL_CONTINUATION' : 'BLOCKED_PREFLIGHT';
    writeReport(reportRoot, report);
    const lines = fs.readFileSync(journal.file, 'utf8'),
        saved = JSON.parse(fs.readFileSync(path.join(reportRoot, 'preflight.json'), 'utf8')),
        fixtureExists = fs.existsSync(result.child),
        fixtureEntries = fixtureExists ? fs.readdirSync(result.child) : null,
        markerUnchanged = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
    const stillOpen = [...opened].filter((fd) => {
        try {
            fs.fstatSync(fd);
            return true;
        } catch (e) {
            assert.equal(e.code, 'EBADF');
            return false;
        }
    });
    for (const fd of stillOpen) close(fd); // Test teardown only; controller correctly reports its unresolved hold.
    fs.rmSync(temp, { recursive: true });
    return {
        result,
        saved,
        lines,
        events,
        opened: opened.size,
        stillOpen: stillOpen.length,
        fixtureExists,
        fixtureEntries,
        markerUnchanged,
    };
}
test('exclusive fixture validates descriptor/identity before all three real I/O controls and joins removal', async () => {
    const r = await exercise();
    assert(r.result.controlPassed);
    assert.equal(r.result.probes.length, 3);
    assert.deepEqual(
        r.result.probes.map((p) => p.fault),
        [null, 'sync', 'close'],
    );
    assert(
        r.result.probes.every(
            (p) => p.controlPassed && p.actualCleanupComplete && p.handles.every((h) => h.closed),
        ),
    );
    assert(!r.fixtureExists);
    assert.equal(r.stillOpen, 0);
    assert.equal(r.result.cleanup.removed, true);
    assert.equal(r.saved.journalClosure.closed, true);
    assert(
        r.events.indexOf('metadata-fixture-admission') < r.events.indexOf('metadata-io-nominal'),
    );
});
test('unexpected inherited grant refuses payload and removes only its still-bound empty child', async () => {
    const r = await exercise({ mutate: (r) => (r.rows[1].aces[2] = allow('S-1-5-32-545')) });
    assert.equal(r.opened, 0);
    assert.equal(r.result.controlPassed, false);
    assert.equal(r.result.descriptorAccepted, false);
    assert.equal(r.result.cleanup.removed, true);
    assert.match(r.lines, /Unexpected inherited grants/);
});
for (const option of ['cancelAfterWrite', 'expireAfterWrite', 'readFailure'])
    test(
        option + ' closes/unlinks the actual payload and removes its fixture using cleanup reserve',
        async () => {
            const r = await exercise({ [option]: true });
            assert.equal(r.result.controlPassed, false);
            assert.equal(r.result.probes.length, 1);
            assert(r.result.probes[0].actualCleanupComplete);
            assert(r.result.probes[0].handles.every((h) => h.closed));
            assert.equal(r.stillOpen, 0);
            assert(r.result.cleanup.removed);
        },
    );
test('unconfirmed actual descriptor close retains fixture and owned file; no later control admission', async () => {
    const r = await exercise({ unknownClose: true });
    assert.equal(r.result.controlPassed, false);
    assert.equal(r.result.probes.length, 1);
    assert.equal(r.result.cleanup.allProbeHandlesClosed, false);
    assert(r.result.cleanup.retained && r.fixtureExists);
    assert(r.stillOpen > 0);
    assert(r.fixtureEntries.some((n) => n.startsWith('metadata-')));
});
test('directory cleanup failure cannot claim closure/removal despite closed payload handles', async () => {
    const r = await exercise({ rmdirFailure: true });
    assert.equal(r.result.controlPassed, false);
    assert(r.result.cleanup.allProbeHandlesClosed);
    assert(r.result.cleanup.retained);
    assert.deepEqual(r.fixtureEntries, []);
    assert.equal(r.stillOpen, 0);
});
test('nonce collision never adopts/deletes existing fixture or opens payload', async () => {
    const r = await exercise({ collision: true });
    assert.equal(r.result.created, false);
    assert.equal(r.opened, 0);
    assert(r.fixtureExists);
    assert.deepEqual(r.fixtureEntries, ['unrelated.txt']);
});
test('child identity replacement blocks payload and retains replacement untouched', async () => {
    const r = await exercise({
        during: ({ child }) => {
            fs.renameSync(child, child + '-old');
            fs.mkdirSync(child);
            fs.writeFileSync(path.join(child, 'unrelated.txt'), 'retain');
        },
    });
    assert.equal(r.opened, 0);
    assert(r.result.cleanup.retained);
    assert.deepEqual(r.fixtureEntries, ['unrelated.txt']);
});
for (const flag of ['setCancelled', 'setExpired'])
    test(
        flag + ' after descriptors prevents payload but joins owned empty child cleanup',
        async () => {
            const r = await exercise({ during: (c) => c[flag]() });
            assert.equal(r.opened, 0);
            assert.equal(r.result.controlPassed, false);
            assert(r.result.cleanup.removed);
        },
    );
test('marker appearance is never cleared; fixture remains held on lost cleanup admission', async () => {
    const r = await exercise({ during: ({ marker }) => fs.writeFileSync(marker, 'retain-marker') });
    assert.equal(r.opened, 0);
    assert(r.result.cleanup.retained);
    assert.equal(r.markerUnchanged, 'retain-marker');
});
test('source change after descriptor response blocks payload without a repair', async () => {
    const r = await exercise({ during: ({ source }) => fs.appendFileSync(source, '#drift') });
    assert.equal(r.opened, 0);
    assert(r.result.cleanup.removed);
    assert.match(r.lines, /Source changed after fixture/);
});
test('production uses narrow fixture path rather than broad inventory or owner equality and preserves security boundary', () => {
    const source = fs.readFileSync(
            new URL('../scripts/memory-product-preflight.mts', import.meta.url),
            'utf8',
        ),
        helper = fs.readFileSync(
            new URL('../scripts/lib/hosted-ci-metadata-fixture.mjs', import.meta.url),
            'utf8',
        );
    assert.doesNotMatch(source, /await observeDirectoryFacts\(/);
    assert.match(source, /await runHostedMetadataFixture/);
    assert.doesNotMatch(source, /if \(ownerConfirmed\)/);
    assert.match(helper, /fs.mkdirSync\(child\)/);
    assert.match(helper, /fs.rmdirSync\(child\)/);
    assert.doesNotMatch(
        helper,
        /Set-Acl|SetOwner|chmod|chown|AdjustToken|process\.env\.[A-Z]+\s*=/,
    );
    assert.equal(policy.userMachineQualification, false);
    assert.equal(policy.collectionApproval, false);
});

test('parent replacement after descriptor read refuses payload and does not clean a substituted tree', async () => {
    const r = await exercise({
        during: ({ parent }) => {
            fs.renameSync(parent, parent + '-old');
            fs.mkdirSync(parent);
            fs.writeFileSync(path.join(parent, 'unrelated.txt'), 'retain');
        },
    });
    assert.equal(r.opened, 0);
    assert.equal(r.result.controlPassed, false);
    assert(r.result.cleanup.retained);
    assert.match(r.lines, /identity|ENOENT|ancestry/i);
});
test('environment drift blocks payload and holds the fixture without changing TEMP or TMP itself', async () => {
    const r = await exercise({ during: ({ setEnvironmentChanged }) => setEnvironmentChanged() });
    assert.equal(r.opened, 0);
    assert.equal(r.result.controlPassed, false);
    assert(r.result.cleanup.retained);
    assert.match(r.lines, /environment drift/);
});
test('created receipt remains immutable in actual journal before final cleanup outcomes', async () => {
    const r = await exercise();
    const rows = r.lines
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line)),
        created = rows.find((row) => row.stage === 'metadata-fixture-created').data,
        cleanup = rows.find((row) => row.stage === 'metadata-fixture-cleanup').data;
    assert.equal(created.created, true);
    assert.equal(Object.hasOwn(created, 'cleanup'), false);
    assert.equal(cleanup.cleanup.removed, true);
    assert.equal(cleanup.controlPassed, true);
    assert(rows.every((row) => Buffer.byteLength(JSON.stringify(row) + '\n') <= 65536));
});

test('unexpected fixture contents before admission refuse payload and retain the unrelated entry', async () => {
    const r = await exercise({
        during: ({ child }) => fs.writeFileSync(path.join(child, 'unrelated.txt'), 'retain'),
    });
    assert.equal(r.opened, 0);
    assert.equal(r.result.controlPassed, false);
    assert(r.result.cleanup.retained);
    assert.deepEqual(r.fixtureEntries, ['unrelated.txt']);
    assert.match(r.lines, /Fresh fixture must be empty/);
});
