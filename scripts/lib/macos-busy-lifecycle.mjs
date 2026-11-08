import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateMacManifest } from './macos-release.mjs';
import { validateMacInstalledPayloadSample } from './macos-payload-identity.mjs';
import {
    captureMacHelperOperation,
    projectMacHelperChild,
    macHelperRecordPath,
} from './macos-installer-child.mjs';
import { validateMacBusyOnlyAction } from './macos-installer-actions.mjs';

export const MAC_BUSY_RECORD_LIMITS = Object.freeze({
    actionCase: 65536,
    installHelperChild: 65536,
    busyHelperChild: 65536,
    installedPayloadBefore: 8192,
    installedPayloadAfter: 8192,
    shippingBuildInfo: 65536,
    appPrequit: 8192,
    appClosure: 8192,
});
const roles = Object.keys(MAC_BUSY_RECORD_LIMITS);
const caseId = 'macos-bundle:busy-refusal';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keys = (value, fields) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
};
const fixedPaths = Object.freeze({
    actionCase: 'evidence/busy-only-case.json',
    installedPayloadBefore: 'busy-refusal/evidence/installed-payload-1.json',
    installedPayloadAfter: 'busy-refusal/evidence/installed-payload-2.json',
    shippingBuildInfo: 'evidence/current-shipping-build-info.json',
    appPrequit: 'busy-refusal/evidence/app-1-prequit.json',
    appClosure: 'busy-refusal/evidence/app-1-closure.json',
});
function references(records) {
    keys(records, roles);
    const paths = new Set(),
        hashes = new Set();
    for (const role of roles) {
        const ref = records[role];
        keys(ref, ['path', 'bytes', 'sha256']);
        assert.ok(typeof ref.path === 'string' && Buffer.byteLength(ref.path) <= 1024);
        assert.ok(!path.posix.isAbsolute(ref.path) && !/[\\\x00-\x1f\x7f]/.test(ref.path));
        assert.equal(path.posix.normalize(ref.path), ref.path);
        assert.ok(ref.path.split('/').every((part) => part && part !== '.' && part !== '..'));
        assert.ok(
            Number.isSafeInteger(ref.bytes) &&
                ref.bytes > 0 &&
                ref.bytes <= MAC_BUSY_RECORD_LIMITS[role],
        );
        assert.match(ref.sha256, /^[a-f0-9]{64}$/);
        assert.ok(
            !paths.has(ref.path) && !hashes.has(ref.sha256),
            'Busy case originals must be distinct captures.',
        );
        paths.add(ref.path);
        hashes.add(ref.sha256);
        if (role in fixedPaths) assert.equal(ref.path, fixedPaths[role]);
        else assert.match(ref.path, /^evidence\/child-(?:[0-9]|[12][0-9]|3[01])\.json$/);
    }
}
function parsed(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    assert.ok(
        [
            JSON.stringify(value),
            JSON.stringify(value) + '\n',
            JSON.stringify(value, null, 2) + '\n',
        ].includes(text),
        'Require complete canonical Mac busy records.',
    );
    return value;
}
async function exactBytes(ref, maximum, readBytes) {
    const returned = await readBytes(ref.path, maximum);
    assert.ok(
        Buffer.isBuffer(returned) && returned.length === ref.bytes && returned.length <= maximum,
    );
    const bytes = Buffer.from(returned);
    assert.equal(hash(bytes), ref.sha256, 'Original Mac busy record changed.');
    return bytes;
}
function refusalStage(stderr) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stderr);
    const lines = text.split(/\r?\n/);
    const early = lines.includes(
        'Diagnostic Hub: Quit Diagnostic Hub before installing or updating.',
    );
    const late = lines.includes('Diagnostic Hub: Quit Diagnostic Hub before updating.');
    assert.notEqual(
        early,
        late,
        'Original helper stderr does not identify one source busy refusal.',
    );
    // Either real guard is accepted. Unknown/ambiguous diagnostics are nonpassing,
    // not promoted through the action transcript's busyRefusalVerified boolean.
    return early ? 'early' : 'late';
}
async function readRecords(records, readBytes) {
    assert.equal(typeof readBytes, 'function');
    references(records);
    const values = {};
    for (const role of roles)
        values[role] = parsed(
            await exactBytes(records[role], MAC_BUSY_RECORD_LIMITS[role], readBytes),
        );
    let busyRefusalStage;
    for (const role of ['installHelperChild', 'busyHelperChild']) {
        const child = values[role];
        assert.equal(records[role].path, macHelperRecordPath(child.index));
        keys(child.streams, ['stdout', 'stderr']);
        for (const name of ['stdout', 'stderr']) {
            const ref = child.streams[name];
            keys(ref, ['path', 'bytes', 'sha256']);
            assert.equal(ref.path, 'child-' + child.index + '.' + name);
            assert.ok(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= 65536);
            assert.match(ref.sha256, /^[a-f0-9]{64}$/);
            const bytes = await exactBytes(
                { ...ref, path: 'evidence/' + ref.path },
                65536,
                readBytes,
            );
            if (role === 'busyHelperChild' && name === 'stderr')
                busyRefusalStage = refusalStage(bytes);
        }
    }
    return { values, busyRefusalStage };
}
function selected(rawExpected) {
    const expected = structuredClone(rawExpected);
    assert.ok(['darwin-arm64', 'darwin-x64'].includes(expected.lane));
    assert.ok(
        typeof expected.version === 'string' &&
            /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(expected.version),
    );
    for (const field of ['sourceCommit', 'sourceTree'])
        assert.match(expected[field], /^[a-f0-9]{40}$/);
    for (const field of ['runId', 'runAttempt'])
        assert.ok(
            typeof expected[field] === 'string' && /^[1-9][0-9]{0,31}$/.test(expected[field]),
        );
    assert.ok(Array.isArray(expected.artifacts));
    const matches = expected.artifacts.filter(
        (row) => row.name === 'Diagnostic-Hub-macos-' + expected.lane.slice(7) + '.zip',
    );
    assert.equal(matches.length, 1);
    const archive = matches[0];
    keys(archive, ['name', 'bytes', 'sha256']);
    assert.ok(Number.isSafeInteger(archive.bytes) && archive.bytes > 0);
    assert.match(archive.sha256, /^[a-f0-9]{64}$/);
    return { expected, archive };
}
function helper(row, ordinal, expected, archive) {
    keys(row, [
        'kind',
        'index',
        'command',
        'operation',
        'error',
        'exitObserved',
        'closeObserved',
        'exitCode',
        'signal',
        'stdoutEOF',
        'stderrEOF',
        'streams',
    ]);
    assert.equal(row.kind, 'fixed-child');
    const operation = captureMacHelperOperation(row.operation);
    const match = /^([a-f0-9]{32}):macos-bundle:busy-refusal:helper:([12])$/.exec(
        operation.operationId,
    );
    assert.ok(match);
    assert.equal(match[2], String(ordinal));
    assert.equal(operation.caseId, caseId);
    assert.deepEqual(operation.observerSource, {
        commit: expected.sourceCommit,
        tree: expected.sourceTree,
    });
    assert.deepEqual(operation.package, {
        ...archive,
        version: expected.version,
        sourceCommit: expected.sourceCommit,
    });
    assert.deepEqual(row.command, [
        '/bin/bash',
        operation.helper,
        '--version',
        'v' + expected.version,
        '--directory',
        path.posix.join(operation.fixtureRoot, 'Applications'),
        '--no-launch',
    ]);
    assert.deepEqual(
        projectMacHelperChild(
            {
                ...row,
                request: { executable: row.command[0], args: row.command.slice(1), operation },
            },
            row.index,
            row.streams,
        ),
        row,
    );
    for (const key of ['exitObserved', 'closeObserved', 'stdoutEOF', 'stderrEOF'])
        assert.equal(row[key], true, 'Missing busy helper closure: ' + key);
    assert.equal(row.signal, null);
    assert.equal(row.error, 'none');
    if (ordinal === 1) assert.equal(row.exitCode, 0);
    else assert.ok(Number.isSafeInteger(row.exitCode) && row.exitCode > 0 && row.exitCode <= 255);
    return operation;
}
function payloadCapture(value, phase, operation, expected, archive, payloadIdentity) {
    keys(value, ['kind', 'phase', 'operationId', 'sample']);
    assert.equal(value.kind, 'macos-busy-payload-sample/v1');
    assert.equal(value.phase, phase);
    assert.equal(value.operationId, operation.operationId);
    validateMacInstalledPayloadSample(value.sample, {
        caseId,
        version: expected.version,
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
        archive,
        payloadIdentity,
    });
}
function app(before, after, operation, expected, launchFact, quitFact) {
    keys(before, ['ownerId', 'identity', 'scope', 'closure']);
    keys(after, ['ownerId', 'closure']);
    const nonce = operation.operationId.slice(0, 32),
        identity = before.identity,
        held = before.closure,
        closed = after.closure;
    keys(identity, [
        'ready',
        'pid',
        'packaged',
        'version',
        'asar',
        'profile',
        'windowID',
        'offline',
    ]);
    assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
    assert.ok(Number.isSafeInteger(identity.windowID) && identity.windowID > 0);
    assert.equal(before.ownerId, nonce + ':' + caseId + ':1:' + identity.pid);
    assert.equal(after.ownerId, before.ownerId);
    assert.equal(before.scope, 'installer-case');
    assert.equal(launchFact.id, before.ownerId);
    assert.equal(quitFact.ownerId, before.ownerId);
    assert.equal(identity.version, expected.version);
    for (const key of ['ready', 'packaged', 'offline']) assert.equal(identity[key], true);
    // offline is the existing renderer fixture flag, not an independent offline case.
    const target = operation.fixtureRoot + '/Applications/Diagnostic Hub.app';
    assert.equal(identity.asar, target + '/Contents/Resources/app.asar');
    assert.equal(identity.profile, operation.fixtureRoot + '/profile');
    for (const state of [held, closed]) {
        assert.equal(state.pid, identity.pid);
        assert.equal(state.reason, null);
        assert.equal(state.attachStarted, true);
        assert.equal(state.attachReturned, true);
        assert.equal(state.nodeEndpointObserved, true);
        assert.equal(state.browserEndpointObserved, true);
        assert.equal(state.frameworkOwnsProcess, false);
        assert.equal(state.frameworkTemporaryDirectoryAllocated, false);
        assert.equal(state.launch.executable, target + '/Contents/MacOS/Diagnostic Hub');
        assert.equal(state.launch.profile, identity.profile);
        assert.equal(state.launch.artifactsDir, operation.fixtureRoot + '/evidence');
        assert.equal(state.launch.shell, false);
        assert.equal(state.launch.detached, false);
        assert.deepEqual(state.launch.args, [
            '--inspect-brk=127.0.0.1:0',
            '--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=0',
            '--user-data-dir=' + identity.profile,
        ]);
        for (const key of [
            'genericPending',
            'shutdownPending',
            'mainPendingCount',
            'publicationFDCount',
            'mainPending',
            'rejectedOwnedCalls',
        ])
            assert.equal(state[key], 0, 'Busy app has pending ownership: ' + key);
        assert.equal(state.streams.capExceeded, false);
        for (const key of ['stdoutBytes', 'stderrBytes'])
            assert.ok(
                Number.isSafeInteger(state.streams[key]) &&
                    state.streams[key] >= 0 &&
                    state.streams[key] <= 65536,
            );
        assert.equal(state.shutdown.terminal, null);
        assert.equal(state.shutdown.repeated, false);
        assert.equal(state.shutdown.incident, null);
        assert.equal(state.physicalDescendantClosure, false);
    }
    assert.deepEqual(closed.launch, held.launch);
    for (const key of [
        'exitObserved',
        'closeObserved',
        'quitIntent',
        'quitScheduledAck',
        'quitComplete',
    ]) {
        assert.equal(held[key], false, 'Busy prequit record is already terminal: ' + key);
        assert.equal(closed[key], true, 'Missing normal busy app closure: ' + key);
    }
    assert.equal(held.exitCode, null);
    assert.equal(held.signal, null);
    assert.equal(held.mainTransportClosed, false);
    assert.equal(held.rendererTransportClosed, false);
    assert.equal(held.shutdown.mode, 'INACTIVE');
    assert.equal(held.shutdown.complete, false);
    assert.equal(closed.exitCode, 0);
    assert.equal(closed.signal, null);
    for (const key of ['stdoutEOF', 'stderrEOF', 'stdoutComplete', 'stderrComplete'])
        assert.equal(closed.streams[key], true);
    assert.equal(closed.mainTransportClosed, true);
    assert.equal(closed.rendererTransportClosed, true);
    assert.equal(closed.shutdown.mode, 'CLOSING');
    assert.equal(closed.shutdown.complete, true);
}

/** Original-record consistency for one busy-refusal operation. This is neither a
 * native-origin issuer nor proof of loaded code, offline readiness or descendants. */
export function inspectMacBusyPayload(observation, item, rawExpected) {
    keys(observation, ['kind', ...roles, 'records', 'busyRefusalStage']);
    assert.equal(observation.kind, 'macos-owned-busy-refusal/v1');
    assert.equal(item.id, caseId);
    const { expected, archive } = selected(rawExpected);
    references(observation.records);
    assert.ok(['early', 'late'].includes(observation.busyRefusalStage));
    for (const ref of Object.values(observation.records))
        assert.equal(
            item.evidence.filter(
                (entry) =>
                    entry.path === ref.path &&
                    entry.bytes === ref.bytes &&
                    entry.sha256 === ref.sha256,
            ).length,
            1,
        );
    const info = observation.shippingBuildInfo;
    validateMacManifest(info, {
        arch: expected.lane.slice(7),
        version: expected.version,
        commit: expected.sourceCommit,
        sha256: archive.sha256,
    });
    assert.equal(info.source, expected.sourceCommit);
    assert.equal(info.packagedSourceMatches, true);
    assert.equal(info.distribution, true);
    assert.ok(info.payloadIdentity);
    const installed = helper(observation.installHelperChild, 1, expected, archive),
        busy = helper(observation.busyHelperChild, 2, expected, archive);
    assert.equal(
        observation.records.installHelperChild.path,
        macHelperRecordPath(observation.installHelperChild.index),
    );
    assert.equal(
        observation.records.busyHelperChild.path,
        macHelperRecordPath(observation.busyHelperChild.index),
    );
    assert.equal(installed.fixtureRoot, busy.fixtureRoot);
    assert.equal(installed.helper, busy.helper);
    assert.equal(installed.operationId.slice(0, 32), busy.operationId.slice(0, 32));
    payloadCapture(
        observation.installedPayloadBefore,
        'installed-before-busy',
        installed,
        expected,
        archive,
        info.payloadIdentity,
    );
    payloadCapture(
        observation.installedPayloadAfter,
        'unchanged-after-busy',
        busy,
        expected,
        archive,
        info.payloadIdentity,
    );
    assert.deepEqual(
        observation.installedPayloadBefore.sample,
        observation.installedPayloadAfter.sample,
        'Installed payload changed during busy refusal.',
    );
    validateMacBusyOnlyAction(observation.actionCase, {
        version: expected.version,
        sourceCommit: expected.sourceCommit,
        zipSHA256: archive.sha256,
        asarSHA256: info.asarSHA256,
    });
    const actions = observation.actionCase.actions;
    assert.equal(actions[0].facts.root, installed.fixtureRoot);
    assert.equal(
        actions[0].facts.target,
        installed.fixtureRoot + '/Applications/Diagnostic Hub.app',
    );
    assert.deepEqual(actions[2].facts.command, observation.installHelperChild.command);
    assert.deepEqual(actions[6].facts.command, observation.busyHelperChild.command);
    assert.equal(actions[2].facts.exitCode, observation.installHelperChild.exitCode);
    assert.equal(actions[6].facts.exitCode, observation.busyHelperChild.exitCode);
    app(
        observation.appPrequit,
        observation.appClosure,
        installed,
        expected,
        actions[4].facts,
        actions[8].facts,
    );
    return 'busy-refusal-payload-and-direct-child-consistent-unqualified';
}

/** Every original record and both helpers' streams are reread; no path or handle
 * ownership is supplied by this data-only module. The caller must provide it. */
export async function readMacBusyRecords(rawObservation, readBytes) {
    const observation = structuredClone(rawObservation);
    const { values, busyRefusalStage } = await readRecords(observation.records, readBytes);
    for (const role of roles)
        assert.deepEqual(
            values[role],
            observation[role],
            'Busy projection differs from original ' + role,
        );
    assert.equal(
        observation.busyRefusalStage,
        busyRefusalStage,
        'Busy stage differs from original helper stderr.',
    );
}

export async function produceMacBusyLifecycle(rawExpected, rawRecords, readBytes) {
    const { expected, archive } = selected(rawExpected),
        records = structuredClone(rawRecords);
    const { values, busyRefusalStage } = await readRecords(records, readBytes);
    const observation = {
        kind: 'macos-owned-busy-refusal/v1',
        ...values,
        records,
        busyRefusalStage,
    };
    const evidence = Object.values(records).map((ref) => ({ ...ref }));
    inspectMacBusyPayload(observation, { id: caseId, evidence }, expected);
    const envelope = {
        schemaVersion: 1,
        kind: 'installer-case-observation',
        version: expected.version,
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
        runId: expected.runId,
        runAttempt: expected.runAttempt,
        lane: expected.lane,
        caseId,
        package: archive,
        observation,
    };
    const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
    assert.ok(bytes.length <= 128 * 1024);
    const lifecycleEvidence = {
        path: 'cases/macos-bundle/busy-refusal.json',
        bytes: bytes.length,
        sha256: hash(bytes),
    };
    assert.ok(
        evidence.every(
            (ref) => ref.path !== lifecycleEvidence.path && ref.sha256 !== lifecycleEvidence.sha256,
        ),
    );
    return {
        caseId,
        bytes,
        lifecycleEvidence,
        evidence: [lifecycleEvidence, ...evidence],
        busyRefusalStage,
        releaseAcceptance: false,
    };
}
