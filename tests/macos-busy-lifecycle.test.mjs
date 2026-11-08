// Authored in-memory controls only; none of these fixtures is native evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
    produceMacBusyLifecycle,
    MAC_BUSY_RECORD_LIMITS,
} from '../scripts/lib/macos-busy-lifecycle.mjs';
import {
    consumeInstallerLifecycleEvidence,
    inspectInstallerCaseObservation,
    validateInstallerReferences,
} from '../scripts/lib/installer-lifecycle-evidence.mjs';
import { macPayloadIdentity } from '../scripts/lib/macos-payload-identity.mjs';
import { projectMacHelperChild } from '../scripts/lib/macos-installer-child.mjs';
import { installerMemoryFixture } from './fixtures/installer-lifecycle-memory.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const id = 'macos-bundle:busy-refusal';
const early = 'Diagnostic Hub: Quit Diagnostic Hub before installing or updating.\n';
const late = 'Diagnostic Hub: Quit Diagnostic Hub before updating.\n';
function fixture(lane = 'darwin-arm64') {
    const base = installerMemoryFixture(lane),
        expected = base.expected;
    const archive = expected.artifacts.find(
        (row) => row.name === 'Diagnostic-Hub-macos-' + lane.slice(7) + '.zip',
    );
    const payload = macPayloadIdentity([
        { path: 'Contents', kind: 'directory', mode: 0o755 },
        { path: 'Contents/MacOS', kind: 'directory', mode: 0o755 },
        { path: 'Contents/Resources', kind: 'directory', mode: 0o755 },
        ...[
            'Contents/Info.plist',
            'Contents/Resources/app.asar',
            'Contents/MacOS/Diagnostic Hub',
        ].map((path) => ({ path, kind: 'file', mode: 0o755, bytes: 1, sha256: hash(path) })),
    ]);
    const nonce = '1'.repeat(32),
        runRoot = '/synthetic/task/diagnostic-hub-v060-macos-native-run-' + nonce;
    const root = runRoot + '/busy-refusal',
        target = root + '/Applications/Diagnostic Hub.app';
    const operation = (ordinal) => ({
        operationId: nonce + ':' + id + ':helper:' + ordinal,
        caseId: id,
        observerSource: { commit: expected.sourceCommit, tree: expected.sourceTree },
        package: { ...archive, version: expected.version, sourceCommit: expected.sourceCommit },
        fixtureRoot: root,
        helper: runRoot + '/bin/download-run-macos.sh',
    });
    const command = [
        '/bin/bash',
        runRoot + '/bin/download-run-macos.sh',
        '--version',
        'v' + expected.version,
        '--directory',
        root + '/Applications',
        '--no-launch',
    ];
    const files = new Map(),
        records = {},
        values = {};
    const paths = {
        actionCase: 'evidence/busy-only-case.json',
        installHelperChild: 'evidence/child-3.json',
        busyHelperChild: 'evidence/child-7.json',
        installedPayloadBefore: 'busy-refusal/evidence/installed-payload-1.json',
        installedPayloadAfter: 'busy-refusal/evidence/installed-payload-2.json',
        shippingBuildInfo: 'evidence/current-shipping-build-info.json',
        appPrequit: 'busy-refusal/evidence/app-1-prequit.json',
        appClosure: 'busy-refusal/evidence/app-1-closure.json',
    };
    function child(index, ordinal, stdout, stderr, exitCode) {
        const streams = {};
        for (const [name, bytes] of [
            ['stdout', stdout],
            ['stderr', stderr],
        ]) {
            files.set('evidence/child-' + index + '.' + name, bytes);
            streams[name] = {
                path: 'child-' + index + '.' + name,
                bytes: bytes.length,
                sha256: hash(bytes),
            };
        }
        return projectMacHelperChild(
            {
                request: {
                    executable: command[0],
                    args: command.slice(1),
                    operation: operation(ordinal),
                },
                error: 'none',
                exitObserved: true,
                closeObserved: true,
                exitCode,
                signal: null,
                stdoutEOF: true,
                stderrEOF: true,
            },
            index,
            streams,
        );
    }
    values.installHelperChild = child(
        3,
        1,
        Buffer.from('synthetic install complete\n'),
        Buffer.alloc(0),
        0,
    );
    values.busyHelperChild = child(7, 2, Buffer.alloc(0), Buffer.from(early), 1);
    const owner = nonce + ':' + id + ':1:42';
    const absent = {
        exists: false,
        version: null,
        asarSHA256: null,
        profileFiles: [],
        reportFiles: [],
    };
    const installed = {
        ...absent,
        exists: true,
        version: expected.version,
        asarSHA256: payload.asarSHA256,
    };
    const beforeBusy = {
        ...installed,
        profileFiles: [
            { path: 'profile/preferences.json', bytes: 1, sha256: hash('synthetic profile') },
        ],
    };
    values.actionCase = {
        id,
        status: 'verified',
        actions: [
            { method: 'prepare', returned: true, facts: { id, root, target, fresh: true } },
            { method: 'snapshot', returned: true, facts: structuredClone(absent) },
            {
                method: 'install',
                returned: true,
                facts: {
                    command: [...command],
                    exitObserved: true,
                    exitCode: 0,
                    signal: null,
                    error: 'none',
                },
            },
            { method: 'snapshot', returned: true, facts: structuredClone(installed) },
            {
                method: 'launchOwned',
                returned: true,
                facts: { id: owner, ready: true, offlineLaunchVerified: true },
            },
            { method: 'snapshot', returned: true, facts: structuredClone(beforeBusy) },
            {
                method: 'install',
                returned: true,
                facts: {
                    command: [...command],
                    exitObserved: true,
                    exitCode: 1,
                    signal: null,
                    error: 'none',
                    busyRefusalVerified: true,
                },
            },
            { method: 'snapshot', returned: true, facts: structuredClone(beforeBusy) },
            {
                method: 'quitOwned',
                returned: true,
                facts: {
                    ownerId: owner,
                    exitObserved: true,
                    exitCode: 0,
                    signal: null,
                    error: 'none',
                    closeObserved: true,
                    stdoutEOF: true,
                    stderrEOF: true,
                },
            },
        ],
    };
    const sample = {
        schemaVersion: 1,
        kind: 'macos-installed-payload-sample',
        caseId: id,
        version: expected.version,
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
        archive: { ...archive },
        payloadIdentity: { ...payload },
        qualification: false,
    };
    values.installedPayloadBefore = {
        kind: 'macos-busy-payload-sample/v1',
        phase: 'installed-before-busy',
        operationId: operation(1).operationId,
        sample: structuredClone(sample),
    };
    values.installedPayloadAfter = {
        kind: 'macos-busy-payload-sample/v1',
        phase: 'unchanged-after-busy',
        operationId: operation(2).operationId,
        sample: structuredClone(sample),
    };
    values.shippingBuildInfo = {
        platform: 'darwin',
        arch: lane.slice(7),
        version: expected.version,
        commit: expected.sourceCommit,
        source: expected.sourceCommit,
        packagedSourceMatches: true,
        distribution: true,
        asset: archive.name,
        sha256: archive.sha256,
        asarSHA256: payload.asarSHA256,
        payloadIdentity: { ...payload },
        bundleIdentifier: 'dev.diagnostichub.desktop',
        minimumMacOSVersion: '13.0.0',
        signature: 'ad-hoc',
        adHocIntegrityVerified: true,
        notarized: false,
        gatekeeperDownloadedAppQualified: false,
    };
    const launch = {
        executable: target + '/Contents/MacOS/Diagnostic Hub',
        args: [
            '--inspect-brk=127.0.0.1:0',
            '--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=0',
            '--user-data-dir=' + root + '/profile',
        ],
        cwd: '/synthetic/source',
        profile: root + '/profile',
        artifactsDir: root + '/evidence',
        environmentNames: [],
        shell: false,
        detached: false,
        phaseDeadline: 1000,
    };
    const closure = (terminal) => ({
        pid: 42,
        reason: null,
        exitObserved: terminal,
        closeObserved: terminal,
        exitCode: terminal ? 0 : null,
        signal: null,
        attachStarted: true,
        attachReturned: true,
        nodeEndpointObserved: true,
        browserEndpointObserved: true,
        quitIntent: terminal,
        quitScheduledAck: terminal,
        quitComplete: terminal,
        streams: {
            stdoutEOF: terminal,
            stderrEOF: terminal,
            stdoutComplete: terminal,
            stderrComplete: terminal,
            stdoutBytes: 0,
            stderrBytes: 0,
            capExceeded: false,
        },
        genericPending: 0,
        shutdownPending: 0,
        mainPendingCount: 0,
        publicationFDCount: 0,
        mainPending: 0,
        rejectedOwnedCalls: 0,
        mainTransportClosed: terminal,
        rendererTransportClosed: terminal,
        shutdown: {
            mode: terminal ? 'CLOSING' : 'INACTIVE',
            complete: terminal,
            incident: null,
            terminal: null,
            repeated: false,
        },
        frameworkOwnsProcess: false,
        frameworkTemporaryDirectoryAllocated: false,
        physicalDescendantClosure: false,
        launch: structuredClone(launch),
    });
    values.appPrequit = {
        ownerId: owner,
        identity: {
            ready: true,
            pid: 42,
            packaged: true,
            version: expected.version,
            asar: target + '/Contents/Resources/app.asar',
            profile: root + '/profile',
            windowID: 1,
            offline: true,
        },
        scope: 'installer-case',
        closure: closure(false),
    };
    values.appClosure = { ownerId: owner, closure: closure(true) };
    const update = (role) => {
        const bytes = json(values[role]);
        files.set(paths[role], bytes);
        records[role] = { path: paths[role], bytes: bytes.length, sha256: hash(bytes) };
    };
    for (const role of Object.keys(values)) update(role);
    const stream = (role, name, bytes) => {
        const row = values[role],
            file = 'evidence/child-' + row.index + '.' + name;
        files.set(file, bytes);
        row.streams[name] = {
            path: 'child-' + row.index + '.' + name,
            bytes: bytes.length,
            sha256: hash(bytes),
        };
        update(role);
    };
    const reads = [];
    const read = async (file, maximum) => {
        reads.push(file);
        assert.ok(files.has(file));
        const bytes = files.get(file);
        assert.ok(bytes.length <= maximum);
        return Buffer.from(bytes);
    };
    const bind = (result) => {
        const item = base.receipt.cases.find((row) => row.id === id);
        item.lifecycleEvidence = { ...result.lifecycleEvidence };
        item.evidence = structuredClone(result.evidence);
        base.files.set(result.lifecycleEvidence.path, result.bytes);
        for (const [file, bytes] of files) base.files.set(file, bytes);
        return item;
    };
    return { base, expected, values, records, files, reads, read, update, stream, bind };
}

test('eight actual-record roles and both helpers streams produce only busy consistency on either Mac architecture', async () => {
    for (const lane of ['darwin-arm64', 'darwin-x64']) {
        const f = fixture(lane),
            result = await produceMacBusyLifecycle(f.expected, f.records, f.read);
        assert.equal(result.releaseAcceptance, false);
        assert.equal(result.caseId, id);
        assert.equal(result.busyRefusalStage, 'early');
        assert.equal(f.reads.length, 12);
        assert.ok(f.reads.includes('evidence/child-3.stderr'));
        assert.ok(f.reads.includes('evidence/child-7.stdout'));
        assert.deepEqual(
            f.values.installedPayloadBefore.sample,
            f.values.installedPayloadAfter.sample,
        );
        assert.notEqual(
            f.records.installedPayloadBefore.sha256,
            f.records.installedPayloadAfter.sha256,
        );
        const item = f.bind(result),
            envelope = JSON.parse(result.bytes);
        assert.equal(
            inspectInstallerCaseObservation(envelope, item, f.expected),
            'busy-refusal-payload-and-direct-child-consistent-unqualified',
        );
        assert.equal(envelope.observation.kind, 'macos-owned-busy-refusal/v1');
    }
});
test('real shared consumer rereads all originals without changing global anti-reuse or release refusal', async () => {
    const f = fixture(),
        result = await produceMacBusyLifecycle(f.expected, f.records, f.read);
    f.bind(result);
    for (let attempt = 0; attempt < 2; attempt++) {
        const reads = [];
        const outcome = await consumeInstallerLifecycleEvidence(
            f.base.receipt,
            f.expected,
            async (file, maximum) => {
                reads.push(file);
                const bytes = f.base.files.get(file);
                assert.ok(bytes && bytes.length <= maximum);
                return Buffer.from(bytes);
            },
        );
        assert.equal(reads.length, 21);
        assert.equal(outcome.status, 'installer-lifecycle-unqualified');
        assert.equal(outcome.releaseAcceptance, false);
        assert.equal(
            outcome.observations.find((row) => row.caseId === id).status,
            'busy-refusal-payload-and-direct-child-consistent-unqualified',
        );
    }
    f.base.receipt.cases[0].evidence.push({ ...f.records.installedPayloadBefore });
    assert.throws(() => validateInstallerReferences(f.base.receipt), /reuse/);
});
test('original helper stderr accepts either actual busy guard without an early-only acceptance rule', async () => {
    for (const [text, stage] of [
        [early, 'early'],
        [late, 'late'],
    ]) {
        const f = fixture();
        f.stream('busyHelperChild', 'stderr', Buffer.from(text));
        const result = await produceMacBusyLifecycle(f.expected, f.records, f.read);
        assert.equal(result.busyRefusalStage, stage);
        f.bind(result);
        assert.equal(
            (await consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read))
                .releaseAcceptance,
            false,
        );
    }
});
for (const [label, role, change] of [
    [
        'source',
        'busyHelperChild',
        (v) => {
            v.operation.observerSource.commit = 'd'.repeat(40);
        },
    ],
    [
        'helper ordinal',
        'busyHelperChild',
        (v) => {
            v.operation.operationId = v.operation.operationId.replace(/:2$/, ':3');
        },
    ],
    [
        'foreign nonce',
        'busyHelperChild',
        (v) => {
            v.operation.operationId = '2'.repeat(32) + v.operation.operationId.slice(32);
        },
    ],
    [
        'successful busy install',
        'busyHelperChild',
        (v) => {
            v.exitCode = 0;
        },
    ],
    [
        'timeout',
        'busyHelperChild',
        (v) => {
            v.error = 'timeout';
        },
    ],
    [
        'helper close',
        'busyHelperChild',
        (v) => {
            v.closeObserved = false;
        },
    ],
    [
        'helper EOF',
        'busyHelperChild',
        (v) => {
            v.stderrEOF = false;
        },
    ],
    [
        'command',
        'busyHelperChild',
        (v) => {
            v.command[v.command.length - 1] = '--launch';
        },
    ],
    [
        'capture phase',
        'installedPayloadAfter',
        (v) => {
            v.phase = 'installed-before-busy';
        },
    ],
    [
        'capture operation',
        'installedPayloadAfter',
        (v) => {
            v.operationId = v.operationId.replace(/:2$/, ':1');
        },
    ],
    [
        'payload mutation',
        'installedPayloadAfter',
        (v) => {
            v.sample.payloadIdentity.inventorySHA256 = 'd'.repeat(64);
        },
    ],
    [
        'payload source',
        'installedPayloadAfter',
        (v) => {
            v.sample.sourceCommit = 'd'.repeat(40);
        },
    ],
    [
        'payload qualified',
        'installedPayloadAfter',
        (v) => {
            v.sample.qualification = true;
        },
    ],
    [
        'producer source',
        'shippingBuildInfo',
        (v) => {
            v.packagedSourceMatches = false;
        },
    ],
    [
        'action success',
        'actionCase',
        (v) => {
            v.actions[6].facts.exitCode = 0;
        },
    ],
    [
        'action order',
        'actionCase',
        (v) => {
            [v.actions[5], v.actions[6]] = [v.actions[6], v.actions[5]];
        },
    ],
    [
        'action target data mutation',
        'actionCase',
        (v) => {
            v.actions[7].facts.profileFiles = [];
        },
    ],
    [
        'owner',
        'appPrequit',
        (v) => {
            v.ownerId = 'foreign';
        },
    ],
    [
        'PID',
        'appPrequit',
        (v) => {
            v.identity.pid++;
        },
    ],
    [
        'profile',
        'appPrequit',
        (v) => {
            v.identity.profile += '-foreign';
        },
    ],
    [
        'prequit intent',
        'appPrequit',
        (v) => {
            v.closure.quitIntent = true;
        },
    ],
    [
        'prequit exit code',
        'appPrequit',
        (v) => {
            v.closure.exitCode = 0;
        },
    ],
    [
        'prequit transport',
        'appPrequit',
        (v) => {
            v.closure.mainTransportClosed = true;
        },
    ],
    [
        'prequit shutdown',
        'appPrequit',
        (v) => {
            v.closure.shutdown.mode = 'CLOSING';
        },
    ],
    [
        'root exit',
        'appClosure',
        (v) => {
            v.closure.exitCode = 1;
        },
    ],
    [
        'root EOF',
        'appClosure',
        (v) => {
            v.closure.streams.stdoutEOF = false;
        },
    ],
    [
        'pending custody',
        'appClosure',
        (v) => {
            v.closure.mainPending = 1;
        },
    ],
    [
        'transport',
        'appClosure',
        (v) => {
            v.closure.rendererTransportClosed = false;
        },
    ],
    [
        'stream cap',
        'appClosure',
        (v) => {
            v.closure.streams.capExceeded = true;
        },
    ],
    [
        'stream byte bound',
        'appClosure',
        (v) => {
            v.closure.streams.stderrBytes = 65537;
        },
    ],
    [
        'retained shutdown',
        'appClosure',
        (v) => {
            v.closure.shutdown.mode = 'RETAINED_UNKNOWN';
        },
    ],
    [
        'shutdown terminal',
        'appClosure',
        (v) => {
            v.closure.shutdown.terminal = 'shutdown-deadline';
        },
    ],
    [
        'repeated incident',
        'appClosure',
        (v) => {
            v.closure.shutdown.repeated = true;
        },
    ],
    [
        'invented descendants',
        'appClosure',
        (v) => {
            v.closure.physicalDescendantClosure = true;
        },
    ],
    [
        'unrequested argv',
        'appClosure',
        (v) => {
            v.closure.launch.args.push('--no-sandbox');
        },
    ],
])
    test('honestly rehashed busy projection rejects ' + label, async () => {
        const f = fixture();
        // Tamper with decoded retained JSON, not the capture-time frozen projection.
        f.values[role] = JSON.parse(f.files.get(f.records[role].path).toString('utf8'));
        change(f.values[role]);
        f.update(role);
        await assert.rejects(produceMacBusyLifecycle(f.expected, f.records, f.read));
    });
test('nonbusy original stderr cannot be made a refusal by a summary boolean', async () => {
    for (const text of [
        'Some different installation failure.\n',
        'Diagnostic Hub: Quit Diagnostic Hub (unclassified diagnostic).\n',
        early + late,
    ]) {
        const f = fixture();
        f.stream('busyHelperChild', 'stderr', Buffer.from(text));
        await assert.rejects(
            produceMacBusyLifecycle(f.expected, f.records, f.read),
            /busy refusal/,
        );
    }
});
test('downstream readback checks each original record and both helpers streams', async () => {
    const seed = fixture();
    for (const file of [
        ...Object.values(seed.records).map((ref) => ref.path),
        'evidence/child-3.stdout',
        'evidence/child-3.stderr',
        'evidence/child-7.stdout',
        'evidence/child-7.stderr',
    ]) {
        const f = fixture(),
            result = await produceMacBusyLifecycle(f.expected, f.records, f.read);
        f.bind(result);
        f.base.files.set(file, Buffer.from('changed'));
        await assert.rejects(
            consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
        );
    }
});
test('honestly rehashed original cannot differ from the embedded projection', async () => {
    const f = fixture(),
        result = await produceMacBusyLifecycle(f.expected, f.records, f.read),
        envelope = JSON.parse(result.bytes);
    f.values.appClosure.closure.mainPending = 1;
    f.update('appClosure');
    envelope.observation.records.appClosure = { ...f.records.appClosure };
    const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
    result.bytes = bytes;
    result.lifecycleEvidence.bytes = bytes.length;
    result.lifecycleEvidence.sha256 = hash(bytes);
    result.evidence[0] = { ...result.lifecycleEvidence };
    result.evidence[result.evidence.findIndex((ref) => ref.path === f.records.appClosure.path)] = {
        ...f.records.appClosure,
    };
    f.bind(result);
    await assert.rejects(
        consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
        /projection differs/,
    );
});
test('stage projection is checked against the original hashed stderr', async () => {
    const f = fixture(),
        result = await produceMacBusyLifecycle(f.expected, f.records, f.read),
        envelope = JSON.parse(result.bytes);
    envelope.observation.busyRefusalStage = 'late';
    result.bytes = Buffer.from(JSON.stringify(envelope) + '\n');
    result.lifecycleEvidence.bytes = result.bytes.length;
    result.lifecycleEvidence.sha256 = hash(result.bytes);
    result.evidence[0] = { ...result.lifecycleEvidence };
    f.bind(result);
    await assert.rejects(
        consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
        /stage differs/,
    );
});
test('record intake rejects missing escaping reused oversized and noncanonical references', async () => {
    for (const mode of [
        'missing',
        'escape',
        'reuse',
        'oversize',
        'hash',
        'UTF8',
        'duplicate-key',
    ]) {
        const f = fixture(),
            ref = f.records.appPrequit;
        if (mode === 'missing') delete f.records.appClosure;
        if (mode === 'escape') ref.path = '../outside';
        if (mode === 'reuse') f.records.appClosure = { ...ref };
        if (mode === 'oversize') ref.bytes = MAC_BUSY_RECORD_LIMITS.appPrequit + 1;
        if (mode === 'hash') ref.sha256 = 'd'.repeat(64);
        if (mode === 'UTF8' || mode === 'duplicate-key') {
            const bytes =
                mode === 'UTF8' ? Buffer.from([0xff]) : Buffer.from('{"ownerId":1,"ownerId":2}');
            f.files.set(ref.path, bytes);
            ref.bytes = bytes.length;
            ref.sha256 = hash(bytes);
        }
        await assert.rejects(produceMacBusyLifecycle(f.expected, f.records, f.read));
    }
});
test('selected context and original references are frozen before awaited reads', async () => {
    const f = fixture();
    const result = await produceMacBusyLifecycle(f.expected, f.records, async (file, maximum) => {
        f.expected.runId = '999';
        f.records.appClosure.sha256 = 'd'.repeat(64);
        return f.read(file, maximum);
    });
    assert.equal(JSON.parse(result.bytes).runId, '123');
    for (const field of ['runId', 'runAttempt', 'lane', 'artifacts']) {
        const bad = fixture();
        bad.expected[field] = field === 'artifacts' ? [] : '';
        await assert.rejects(produceMacBusyLifecycle(bad.expected, bad.records, bad.read));
        assert.equal(bad.reads.length, 0);
    }
});
