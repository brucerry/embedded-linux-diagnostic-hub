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
function parsed(raw, role) {
    assert.ok(
        Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= WINDOWS_NATIVE_RECORD_LIMITS[role],
    );
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
