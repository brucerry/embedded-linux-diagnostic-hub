import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WINDOWS_SETUP_ASSET } from './windows-setup-release.mjs';
import {
    prepareWindowsNativeAuthority,
    assertWindowsNativeCapability,
    pinWindowsNativeFiles,
    observeWindowsNativeProcess,
    readWindowsNativeObservation,
    releaseWindowsNativeAuthority,
    launchWindowsNativePinnedProcess,
    readWindowsNativeOwnedProcess,
    requestWindowsNativeNormalQuit,
    readWindowsNativeNormalQuit,
    releaseWindowsNativeOwnedProcessHandles,
    readWindowsNativeOwnedRelease,
    validateWindowsNativeLaunch,
} from './windows-native-authority.mjs';

export const WINDOWS_NATIVE_RECORD_LIMITS = Object.freeze({
    'file-pins': 16384,
    process: 32768,
});
const caseId = 'windows-nsis:offline-launch';
const kinds = Object.freeze({
    'file-pins': 'windows-native-file-pins/v1',
    process: 'windows-native-process/v1',
});
const roles = Object.keys(WINDOWS_NATIVE_RECORD_LIMITS);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const retainedAuthorities = new Set();
const failureAuthorities = new WeakMap();
let admissionPending = false;
function keys(value, fields) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
}
function uint32(value) {
    assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff);
}
function decimal(value) {
    assert.ok(typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value));
    assert.ok(BigInt(value) <= 18446744073709551615n);
}
function identifier(value, length) {
    assert.ok(typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value));
}
function selectedRoot(root) {
    assert.ok(
        typeof root === 'string' &&
            root.length <= 220 &&
            /^[A-Za-z]:\\/.test(root) &&
            path.win32.normalize(root) === root &&
            !root.endsWith('\\') &&
            !/[\/\x00-\x1f\x7f<>"|?*]/.test(root),
    );
    assert.ok(root.slice(3).split('\\').length <= 32);
    assert.ok(
        root
            .slice(3)
            .split('\\')
            .every(
                (part) =>
                    part &&
                    part !== '.' &&
                    part !== '..' &&
                    !/[ .:]$/.test(part) &&
                    !part.includes(':') &&
                    !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(
                        part,
                    ),
            ),
    );
}
/** Selected labels and exact named-file expectations, not service, installer or build authentication. */
export function validateWindowsNativeBinding(raw) {
    const value = structuredClone(raw);
    keys(value, [
        'sourceCommit',
        'sourceTree',
        'runId',
        'runAttempt',
        'lane',
        'caseId',
        'package',
        'root',
        'expectedFiles',
    ]);
    for (const field of ['sourceCommit', 'sourceTree']) assert.match(value[field], commit);
    for (const field of ['runId', 'runAttempt']) {
        assert.ok(typeof value[field] === 'string' && /^[1-9][0-9]{0,31}$/.test(value[field]));
    }
    assert.equal(value.lane, 'win32-x64');
    assert.equal(value.caseId, caseId);
    keys(value.package, ['name', 'bytes', 'sha256']);
    assert.equal(value.package.name, WINDOWS_SETUP_ASSET);
    assert.ok(
        Number.isSafeInteger(value.package.bytes) &&
            value.package.bytes > 0 &&
            value.package.bytes <= 2 * 1024 ** 3,
    );
    assert.match(value.package.sha256, sha256);
    selectedRoot(value.root);
    assert.ok(Array.isArray(value.expectedFiles) && value.expectedFiles.length === 2);
    const names = ['Diagnostic Hub.exe', 'resources/app.asar'];
    for (let i = 0; i < names.length; i++) {
        const file = value.expectedFiles[i];
        keys(file, ['relativePath', 'size', 'sha256']);
        assert.equal(file.relativePath, names[i]);
        assert.ok(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 512 * 1024 ** 2);
        assert.match(file.sha256, sha256);
    }
    return value;
}
function selected(expected, binding) {
    for (const field of ['sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'lane']) {
        assert.equal(binding[field], expected[field]);
    }
    assert.ok(
        typeof expected.version === 'string' &&
            /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(expected.version),
    );
    assert.ok(Array.isArray(expected.artifacts));
    const matches = expected.artifacts.filter((row) => row.name === WINDOWS_SETUP_ASSET);
    assert.equal(matches.length, 1);
    assert.deepEqual(binding.package, matches[0]);
}
function parsed(raw, role, limits = WINDOWS_NATIVE_RECORD_LIMITS) {
    assert.ok(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= limits[role]);
    const bytes = Buffer.from(raw);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    assert.equal(
        JSON.stringify(value) + '\n',
        text,
        'Require complete canonical original Windows record.',
    );
    return { bytes, value };
}
function inspectPinnedFiles(fileRow, binding) {
    const f = fileRow.observation;
    keys(f, [
        'host',
        'files',
        'leaseScope',
        'fileLeasesRetained',
        'physicalLoadedBytesVerified',
        'releaseAcceptance',
    ]);
    keys(f.host, ['adminMember', 'elevated', 'integrityRid']);
    assert.equal(f.host.adminMember, false);
    assert.equal(f.host.elevated, false);
    assert.equal(f.host.integrityRid, 8192);
    assert.equal(f.leaseScope, 'named-executable-and-asar');
    assert.equal(f.fileLeasesRetained, true);
    assert.equal(f.physicalLoadedBytesVerified, false);
    assert.equal(f.releaseAcceptance, false);
    assert.ok(Array.isArray(f.files) && f.files.length === 2);
    for (let i = 0; i < f.files.length; i++) {
        const row = f.files[i];
        keys(row, ['relativePath', 'size', 'sha256', 'fileId', 'volumeSerial']);
        for (const field of ['relativePath', 'size', 'sha256'])
            assert.equal(row[field], binding.expectedFiles[i][field]);
        identifier(row.fileId, 32);
        identifier(row.volumeSerial, 16);
    }
    assert.notEqual(
        f.files[0].volumeSerial + ':' + f.files[0].fileId,
        f.files[1].volumeSerial + ':' + f.files[1].fileId,
    );
}
/** Strict consistency checks for genuine backend record shapes. Serialized records alone
 * never authenticate their origin, launch ownership, an installer, or a completed case.
 * fileLeasesRetained/processHandleRetained describe their original capture only:
 * old or released serialized rows do not authenticate current HANDLE custody. */
export function inspectWindowsNativeRows(rawFiles, rawProcess, rawBinding) {
    const binding = validateWindowsNativeBinding(rawBinding);
    const fileRow = structuredClone(rawFiles),
        processRow = structuredClone(rawProcess);
    for (const [role, row] of [
        ['file-pins', fileRow],
        ['process', processRow],
    ]) {
        keys(row, ['schemaVersion', 'kind', 'binding', 'observation']);
        assert.equal(row.schemaVersion, 1);
        assert.equal(row.kind, kinds[role]);
        assert.deepEqual(row.binding, binding);
    }
    inspectPinnedFiles(fileRow, binding);
    const p = processRow.observation;
    keys(p, [
        'pid',
        'creationTime100ns',
        'imagePathMatchesPinnedName',
        'openedImagePathFileIdMatchesPin',
        'processHandleRetained',
        'windows',
        'processOwnership',
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'releaseAcceptance',
    ]);
    uint32(p.pid);
    decimal(p.creationTime100ns);
    for (const field of [
        'imagePathMatchesPinnedName',
        'openedImagePathFileIdMatchesPin',
        'processHandleRetained',
    ])
        assert.equal(p[field], true);
    for (const field of [
        'processOwnership',
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'releaseAcceptance',
    ])
        assert.equal(p[field], false);
    assert.ok(Array.isArray(p.windows) && p.windows.length <= 128);
    const handles = new Set();
    for (const window of p.windows) {
        keys(window, ['handle', 'pid', 'threadId', 'visible']);
        decimal(window.handle);
        assert.ok(!handles.has(window.handle));
        handles.add(window.handle);
        assert.equal(window.pid, p.pid);
        uint32(window.threadId);
        assert.equal(typeof window.visible, 'boolean');
    }
    return { binding, filePins: fileRow, process: processRow };
}
function references(records) {
    keys(records, roles);
    for (const role of roles) {
        const ref = records[role];
        keys(ref, ['path', 'bytes', 'sha256']);
        assert.equal(ref.path, 'windows-native/offline-launch/' + role + '.json');
        assert.ok(
            Number.isSafeInteger(ref.bytes) &&
                ref.bytes > 0 &&
                ref.bytes <= WINDOWS_NATIVE_RECORD_LIMITS[role],
        );
        assert.match(ref.sha256, sha256);
    }
    assert.notEqual(records['file-pins'].sha256, records.process.sha256);
}
export function inspectWindowsNativeLifecycle(observation, item, expected) {
    keys(observation, ['kind', 'binding', 'filePins', 'process', 'records']);
    assert.equal(observation.kind, 'windows-native-readonly-consistency/v1');
    assert.equal(item.id, caseId);
    const binding = validateWindowsNativeBinding(observation.binding);
    selected(expected, binding);
    references(observation.records);
    for (const ref of Object.values(observation.records)) {
        assert.equal(
            item.evidence.filter(
                (row) =>
                    row.path === ref.path && row.bytes === ref.bytes && row.sha256 === ref.sha256,
            ).length,
            1,
        );
    }
    inspectWindowsNativeRows(observation.filePins, observation.process, binding);
    return 'selected-named-files-and-process-consistent-unqualified';
}
/** Re-read and compare both exact original issued byte rows. This adds readback
 * consistency, not persistent native or service authentication after serialization. */
export async function readWindowsNativeRecords(rawObservation, readBytes) {
    const observation = structuredClone(rawObservation);
    references(observation.records);
    for (const [role, field] of [
        ['file-pins', 'filePins'],
        ['process', 'process'],
    ]) {
        const ref = observation.records[role];
        const returned = await readBytes(ref.path, WINDOWS_NATIVE_RECORD_LIMITS[role]);
        const { bytes, value } = parsed(returned, role);
        assert.equal(bytes.length, ref.bytes);
        assert.equal(hash(bytes), ref.sha256, 'Original Windows native record changed.');
        assert.deepEqual(
            value,
            observation[field],
            'Windows projection differs from original native row.',
        );
    }
}
export const WINDOWS_OWNED_RECORD_LIMITS = Object.freeze({
    'file-pins': 16384,
    'created-process': 16384,
    'normal-quit': 16384,
    'owned-release': 8192,
});
const ownedFields = Object.freeze({
    'file-pins': 'filePins',
    'created-process': 'createdProcess',
    'normal-quit': 'normalQuit',
    'owned-release': 'ownedRelease',
});
const ownedKinds = Object.freeze({
    'file-pins': 'windows-native-file-pins/v1',
    'created-process': 'windows-native-created-process/v2',
    'normal-quit': 'windows-native-normal-quit/v1',
    'owned-release': 'windows-native-owned-release/v1',
});
const ownedRoles = Object.keys(WINDOWS_OWNED_RECORD_LIMITS);
function ownedReferences(records) {
    keys(records, ownedRoles);
    const hashes = new Set();
    for (const role of ownedRoles) {
        const ref = records[role];
        keys(ref, ['path', 'bytes', 'sha256']);
        assert.equal(ref.path, 'windows-native/owned-runtime/' + role + '.json');
        assert.ok(
            Number.isSafeInteger(ref.bytes) &&
                ref.bytes > 0 &&
                ref.bytes <= WINDOWS_OWNED_RECORD_LIMITS[role],
        );
        assert.match(ref.sha256, sha256);
        assert.ok(!hashes.has(ref.sha256));
        hashes.add(ref.sha256);
    }
}
/** Historical operation consistency, not installation, offline/UI, loaded-code,
 * current HANDLE custody or service/run authentication after serialization. */
function inspectOwnedBeforeRelease(rawFiles, rawCreated, rawQuit, rawBinding) {
    const binding = validateWindowsNativeBinding(rawBinding);
    const rows = {
        'file-pins': structuredClone(rawFiles),
        'created-process': structuredClone(rawCreated),
        'normal-quit': structuredClone(rawQuit),
    };
    const requested = validateWindowsNativeLaunch(
        { action: 'launch-pinned-installed', profile: binding.root + '\\native-launch-profile' },
        binding,
    );
    for (const role of ownedRoles.slice(0, 3)) {
        const row = rows[role];
        keys(
            row,
            role === 'file-pins'
                ? ['schemaVersion', 'kind', 'binding', 'observation']
                : role === 'created-process'
                  ? ['schemaVersion', 'kind', 'binding', 'requestedLaunch', 'observation']
                  : role === 'normal-quit'
                    ? [
                          'schemaVersion',
                          'kind',
                          'binding',
                          'requestedLaunch',
                          'createdProcess',
                          'identity',
                          'observation',
                      ]
                    : [
                          'schemaVersion',
                          'kind',
                          'binding',
                          'requestedLaunch',
                          'createdProcess',
                          'observation',
                      ],
        );
        assert.equal(row.schemaVersion, 1);
        assert.equal(row.kind, ownedKinds[role]);
        assert.deepEqual(row.binding, binding);
        if (role !== 'file-pins') assert.deepEqual(row.requestedLaunch, requested);
    }
    inspectPinnedFiles(rows['file-pins'], binding);
    const created = rows['created-process'].observation;
    keys(created, [
        'creationAttempted',
        'creationReturned',
        'createdByThisOwner',
        'processHandleRetained',
        'threadHandleRetained',
        'unconfirmedHandleOutput',
        'pid',
        'threadId',
        'creationTime100ns',
        'processExitObserved',
        'exitCode',
        'profileEmptyAtPreflight',
        'hostEventLoopReferenceAcknowledged',
        'stdioObserved',
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'releaseAcceptance',
    ]);
    for (const field of [
        'creationAttempted',
        'creationReturned',
        'createdByThisOwner',
        'processHandleRetained',
        'threadHandleRetained',
        'processExitObserved',
        'profileEmptyAtPreflight',
        'hostEventLoopReferenceAcknowledged',
    ])
        assert.equal(created[field], true);
    for (const field of [
        'unconfirmedHandleOutput',
        'stdioObserved',
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'releaseAcceptance',
    ])
        assert.equal(created[field], false);
    uint32(created.pid);
    uint32(created.threadId);
    decimal(created.creationTime100ns);
    assert.equal(created.exitCode, 0);
    const tuple = {
        pid: created.pid,
        threadId: created.threadId,
        creationTime100ns: created.creationTime100ns,
    };
    assert.deepEqual(rows['normal-quit'].createdProcess, tuple);
    assert.deepEqual(rows['normal-quit'].identity, { pid: created.pid, type: 'browser' });
    const quit = rows['normal-quit'].observation;
    keys(quit, [
        'identityReplyObserved',
        'quitSchedulingReplyObserved',
        'rootExitObserved',
        'rootExitCode',
        'stdoutEOF',
        'stderrEOF',
        'ownedInspectorCloseObserved',
        'closedUnacknowledgedReplies',
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'releaseAcceptance',
    ]);
    for (const field of [
        'identityReplyObserved',
        'quitSchedulingReplyObserved',
        'rootExitObserved',
        'stdoutEOF',
        'stderrEOF',
        'ownedInspectorCloseObserved',
    ])
        assert.equal(quit[field], true);
    assert.equal(quit.rootExitCode, 0);
    assert.equal(quit.closedUnacknowledgedReplies, 0);
    for (const field of [
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'releaseAcceptance',
    ])
        assert.equal(quit[field], false);
    return {
        binding,
        filePins: rows['file-pins'],
        createdProcess: rows['created-process'],
        normalQuit: rows['normal-quit'],
        tuple,
        requested,
    };
}
export function inspectWindowsNativeOwnedRows(
    rawFiles,
    rawCreated,
    rawQuit,
    rawRelease,
    rawBinding,
) {
    const before = inspectOwnedBeforeRelease(rawFiles, rawCreated, rawQuit, rawBinding);
    const releaseRow = structuredClone(rawRelease);
    keys(releaseRow, [
        'schemaVersion',
        'kind',
        'binding',
        'requestedLaunch',
        'createdProcess',
        'observation',
    ]);
    assert.equal(releaseRow.schemaVersion, 1);
    assert.equal(releaseRow.kind, ownedKinds['owned-release']);
    assert.deepEqual(releaseRow.binding, before.binding);
    assert.deepEqual(releaseRow.requestedLaunch, before.requested);
    assert.deepEqual(releaseRow.createdProcess, before.tuple);
    const released = releaseRow.observation;
    keys(released, [
        'ownedHandlesClosed',
        'retainedUnknown',
        'closedCount',
        'totalCount',
        'processOwnership',
        'physicalDescendantClosure',
        'releaseAcceptance',
        'hostLifetimeAcquisitionSubmitted',
        'hostLifetimeReleaseAcknowledged',
        'hostLifetimeFinalizerObserved',
        'hostLifetimeFinalizerAcknowledged',
        'hostEnvironmentClosing',
    ]);
    for (const field of [
        'ownedHandlesClosed',
        'hostLifetimeAcquisitionSubmitted',
        'hostLifetimeReleaseAcknowledged',
        'hostLifetimeFinalizerObserved',
        'hostLifetimeFinalizerAcknowledged',
    ])
        assert.equal(released[field], true);
    for (const field of [
        'retainedUnknown',
        'processOwnership',
        'physicalDescendantClosure',
        'releaseAcceptance',
        'hostEnvironmentClosing',
    ])
        assert.equal(released[field], false);
    assert.ok(
        Number.isInteger(released.totalCount) &&
            released.totalCount > 0 &&
            released.totalCount <= 64,
    );
    assert.equal(released.closedCount, released.totalCount);
    return {
        binding: before.binding,
        filePins: before.filePins,
        createdProcess: before.createdProcess,
        normalQuit: before.normalQuit,
        ownedRelease: releaseRow,
    };
}
export function inspectWindowsNativeOwnedLifecycle(observation, item, expected) {
    keys(observation, [
        'kind',
        'binding',
        'filePins',
        'createdProcess',
        'normalQuit',
        'ownedRelease',
        'records',
    ]);
    assert.equal(observation.kind, 'windows-native-owned-runtime/v1');
    assert.equal(item.id, caseId);
    const binding = validateWindowsNativeBinding(observation.binding);
    selected(expected, binding);
    ownedReferences(observation.records);
    for (const ref of Object.values(observation.records))
        assert.equal(
            item.evidence.filter(
                (row) =>
                    row.path === ref.path && row.bytes === ref.bytes && row.sha256 === ref.sha256,
            ).length,
            1,
        );
    inspectWindowsNativeOwnedRows(
        observation.filePins,
        observation.createdProcess,
        observation.normalQuit,
        observation.ownedRelease,
        binding,
    );
    return 'selected-pinned-runtime-and-component-closure-consistent-unqualified';
}
export async function readWindowsNativeOwnedRecords(rawObservation, readBytes) {
    const observation = structuredClone(rawObservation);
    ownedReferences(observation.records);
    inspectWindowsNativeOwnedRows(
        observation.filePins,
        observation.createdProcess,
        observation.normalQuit,
        observation.ownedRelease,
        observation.binding,
    );
    for (const role of ownedRoles) {
        const ref = observation.records[role];
        const returned = await readBytes(ref.path, WINDOWS_OWNED_RECORD_LIMITS[role]);
        const { bytes, value } = parsed(returned, role, WINDOWS_OWNED_RECORD_LIMITS);
        assert.equal(bytes.length, ref.bytes);
        assert.equal(hash(bytes), ref.sha256, 'Original Windows owned-operation record changed.');
        assert.deepEqual(
            value,
            observation[ownedFields[role]],
            'Windows projection differs from original owned-operation row.',
        );
    }
}
/** A real same-cap producer: capture originals before invalidation, then explicitly
 * join native component release and compare its original ACK. No transcript input. */
export async function produceWindowsNativeOwnedRuntime(rawExpected, rawBinding, capability) {
    const expected = structuredClone(rawExpected),
        binding = validateWindowsNativeBinding(rawBinding);
    selected(expected, binding);
    await assertWindowsNativeCapability(capability, binding);
    assert.ok(
        (!admissionPending && retainedAuthorities.size === 0) ||
            retainedAuthorities.has(capability),
        'WINDOWS_NATIVE_READBACK_SCOPE_UNAVAILABLE',
    );
    retainedAuthorities.add(capability);
    const buffers = {
        'file-pins': readWindowsNativeObservation(capability, 'file-pins'),
        'created-process': readWindowsNativeOwnedProcess(capability),
        'normal-quit': readWindowsNativeNormalQuit(capability),
    };
    const values = {},
        records = {};
    // Validate and compare the three immutable originals BEFORE release invalidates
    // active readers. Never perform component cleanup on a fabricated Promise row.
    for (const role of ownedRoles.slice(0, 3)) {
        const original = parsed(buffers[role], role, WINDOWS_OWNED_RECORD_LIMITS);
        buffers[role] = original.bytes;
        values[role] = original.value;
    }
    inspectOwnedBeforeRelease(
        values['file-pins'],
        values['created-process'],
        values['normal-quit'],
        binding,
    );
    const returnedRelease = await releaseWindowsNativeOwnedProcessHandles(capability);
    buffers['owned-release'] = readWindowsNativeOwnedRelease(capability);
    for (const role of ownedRoles) {
        const original = parsed(buffers[role], role, WINDOWS_OWNED_RECORD_LIMITS);
        buffers[role] = original.bytes;
        values[role] = original.value;
        records[role] = {
            path: 'windows-native/owned-runtime/' + role + '.json',
            bytes: original.bytes.length,
            sha256: hash(original.bytes),
        };
    }
    assert.deepEqual(
        returnedRelease,
        values['owned-release'].observation,
        'Release Promise differs from private original ACK.',
    );
    inspectWindowsNativeOwnedRows(
        values['file-pins'],
        values['created-process'],
        values['normal-quit'],
        values['owned-release'],
        binding,
    );
    retainedAuthorities.delete(capability); // Only after actual complete component ACK plus original-row checks.
    const observation = {
        kind: 'windows-native-owned-runtime/v1',
        binding,
        filePins: values['file-pins'],
        createdProcess: values['created-process'],
        normalQuit: values['normal-quit'],
        ownedRelease: values['owned-release'],
        records,
    };
    const evidence = Object.values(records).map((row) => ({ ...row }));
    const status = inspectWindowsNativeOwnedLifecycle(
        observation,
        { id: caseId, evidence },
        expected,
    );
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
        package: binding.package,
        observation,
    };
    const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
    assert.ok(bytes.length <= 128 * 1024);
    const lifecycleEvidence = {
        path: 'cases/windows-nsis/offline-launch.json',
        bytes: bytes.length,
        sha256: hash(bytes),
    };
    return {
        status,
        bytes,
        lifecycleEvidence,
        evidence: [lifecycleEvidence, ...evidence],
        originalRecords: buffers,
        componentHandlesAndLifetimeAcknowledged: true,
        installationObserved: false,
        offlineObserved: false,
        uiObserved: false,
        physicalLoadedBytesVerified: false,
        physicalDescendantClosure: false,
        installerCaseComplete: false,
        releaseAcceptance: false,
    };
}
/** Separated default-network pinned-runtime operation. The existing offline CLI
 * and its outside-installation-profile policy are deliberately not this caller. */
export async function observeWindowsNativeOwnedRuntime(rawExpected, rawBinding, rawBuild) {
    const expected = structuredClone(rawExpected),
        binding = validateWindowsNativeBinding(rawBinding),
        build = structuredClone(rawBuild);
    selected(expected, binding);
    assert.ok(
        !admissionPending && retainedAuthorities.size === 0,
        'WINDOWS_NATIVE_READBACK_SCOPE_UNAVAILABLE',
    );
    admissionPending = true;
    let authority;
    try {
        authority = await prepareWindowsNativeAuthority(binding, build);
        retainedAuthorities.add(authority);
        admissionPending = false;
        await assertWindowsNativeCapability(authority, binding);
        await pinWindowsNativeFiles(authority);
        const launched = await launchWindowsNativePinnedProcess(authority, {
            action: 'launch-pinned-installed',
            profile: binding.root + '\\native-launch-profile',
        });
        assert.deepEqual(
            launched,
            readWindowsNativeOwnedProcess(authority),
            'Launch Promise differs from original native row.',
        );
        const quit = await requestWindowsNativeNormalQuit(authority);
        const originalQuit = parsed(
            readWindowsNativeNormalQuit(authority),
            'normal-quit',
            WINDOWS_OWNED_RECORD_LIMITS,
        ).value;
        assert.deepEqual(
            quit,
            originalQuit.observation,
            'Quit Promise differs from private original protocol result.',
        );
        return await produceWindowsNativeOwnedRuntime(expected, binding, authority);
    } catch (error) {
        if (
            authority &&
            error !== null &&
            (typeof error === 'object' || typeof error === 'function')
        )
            failureAuthorities.set(error, authority);
        throw error; // Cap/reservation retained; no implicit release, kill or retry.
    }
}
/** Actual producer: only backend-issued private native capabilities can supply rows.
 * No factory, injected native port, mode flag or serialized transcript is accepted.
 * Query leases are retained with the returned capability; this does not close a process. */
export async function produceWindowsNativeLifecycle(rawExpected, rawBinding, capability) {
    const expected = structuredClone(rawExpected),
        binding = validateWindowsNativeBinding(rawBinding);
    selected(expected, binding);
    await assertWindowsNativeCapability(capability, binding);
    assert.ok(
        (!admissionPending && retainedAuthorities.size === 0) ||
            retainedAuthorities.has(capability),
        'WINDOWS_NATIVE_READBACK_SCOPE_UNAVAILABLE',
    );
    retainedAuthorities.add(capability);
    const buffers = {},
        values = {},
        records = {};
    for (const role of roles) {
        const returned = await readWindowsNativeObservation(capability, role);
        const { bytes, value } = parsed(returned, role);
        buffers[role] = bytes;
        values[role] = value;
        records[role] = {
            path: 'windows-native/offline-launch/' + role + '.json',
            bytes: bytes.length,
            sha256: hash(bytes),
        };
    }
    inspectWindowsNativeRows(values['file-pins'], values.process, binding);
    const observation = {
        kind: 'windows-native-readonly-consistency/v1',
        binding,
        filePins: values['file-pins'],
        process: values.process,
        records,
    };
    const evidence = Object.values(records).map((row) => ({ ...row }));
    inspectWindowsNativeLifecycle(observation, { id: caseId, evidence }, expected);
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
        package: binding.package,
        observation,
    };
    const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
    assert.ok(bytes.length <= 128 * 1024);
    const lifecycleEvidence = {
        path: 'cases/windows-nsis/offline-launch.json',
        bytes: bytes.length,
        sha256: hash(bytes),
    };
    return {
        status: 'selected-named-files-and-process-consistent-unqualified',
        bytes,
        lifecycleEvidence,
        evidence: [lifecycleEvidence, ...evidence],
        originalRecords: buffers,
        retainedAuthority: capability,
        queryHandlesRetainedAtReadback: true,
        processOwnership: false,
        physicalLoadedBytesVerified: false,
        physicalDescendantClosure: false,
        installerCaseComplete: false,
        releaseAcceptance: false,
    };
}
/** Functional read-only native admission/composition; never a full offline launch.
 * Owner is adopted before pin/process calls. A failure retains its actual capability
 * privately and rethrows the original error without a retry or inferred closure.
 * A prepare failure before a capability returns leaves this composition unavailable
 * in-process. That conservative reservation does not prove a native HANDLE exists. */
export async function observeWindowsNativeLifecycle(rawExpected, rawBinding, rawBuild, rawProcess) {
    const expected = structuredClone(rawExpected),
        binding = validateWindowsNativeBinding(rawBinding);
    const build = structuredClone(rawBuild),
        processIdentity = structuredClone(rawProcess);
    selected(expected, binding);
    keys(processIdentity, ['pid', 'creationTime100ns']);
    uint32(processIdentity.pid);
    decimal(processIdentity.creationTime100ns);
    assert.ok(
        !admissionPending && retainedAuthorities.size === 0,
        'WINDOWS_NATIVE_READBACK_SCOPE_UNAVAILABLE',
    );
    admissionPending = true; // Reserve before asynchronous native-owner preparation.
    let authority;
    try {
        authority = await prepareWindowsNativeAuthority(binding, build);
        retainedAuthorities.add(authority);
        admissionPending = false; // Adopt before validations and subsequent native calls.
        await assertWindowsNativeCapability(authority, binding);
        await pinWindowsNativeFiles(authority);
        await observeWindowsNativeProcess(authority, processIdentity);
        const result = await produceWindowsNativeLifecycle(expected, binding, authority);
        const observed = parsed(result.originalRecords.process, 'process').value.observation;
        assert.equal(observed.pid, processIdentity.pid);
        assert.equal(observed.creationTime100ns, processIdentity.creationTime100ns);
        return result;
    } catch (error) {
        if (
            authority &&
            (typeof error === 'object' || typeof error === 'function') &&
            error !== null
        )
            failureAuthorities.set(error, authority);
        throw error;
    }
}
export function windowsNativeLifecycleFailureAuthority(error) {
    return error && (typeof error === 'object' || typeof error === 'function')
        ? failureAuthorities.get(error)
        : undefined;
}

/** Data validation only, not a native release issuer or process-retirement proof. */
export function inspectWindowsNativeQueryRelease(raw) {
    const value = structuredClone(raw);
    keys(value, [
        'readHandlesClosed',
        'retainedUnknown',
        'closedCount',
        'totalCount',
        'processOwnership',
        'physicalDescendantClosure',
        'releaseAcceptance',
    ]);
    for (const field of ['readHandlesClosed', 'retainedUnknown'])
        assert.equal(typeof value[field], 'boolean');
    for (const field of ['closedCount', 'totalCount'])
        assert.ok(Number.isSafeInteger(value[field]) && value[field] >= 0 && value[field] <= 64);
    assert.ok(value.closedCount <= value.totalCount);
    for (const field of ['processOwnership', 'physicalDescendantClosure', 'releaseAcceptance'])
        assert.equal(value[field], false);
    if (value.readHandlesClosed) {
        assert.equal(value.retainedUnknown, false);
        assert.equal(value.closedCount, value.totalCount);
    } else assert.equal(value.retainedUnknown, true);
    return value;
}
/** Explicit caller-requested release of ONLY the native backend's own read/query
 * handles. Unknown or rejected release retains custody and propagates the original
 * error. Backend release is once-only; no normal-close signal or process cleanup. */
export async function releaseWindowsNativeLifecycleQueries(authority) {
    assert.ok(retainedAuthorities.has(authority), 'WINDOWS_NATIVE_QUERY_AUTHORITY_NOT_RETAINED');
    const acknowledgement = inspectWindowsNativeQueryRelease(
        await releaseWindowsNativeAuthority(authority),
    );
    if (
        acknowledgement.readHandlesClosed &&
        !acknowledgement.retainedUnknown &&
        acknowledgement.closedCount === acknowledgement.totalCount
    )
        retainedAuthorities.delete(authority);
    return acknowledgement;
}
