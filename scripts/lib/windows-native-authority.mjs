import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dlopen } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as nativeTypes } from 'node:util';

const directory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../tests/native/windows-installer-authority',
);
const binary = path.join(directory, 'build/Release/windows_installer_authority.node');
const loadNative = dlopen; // Capture the trusted Node builtin; bypass require.cache/extensions.
// Definition-only captures: no socket or timer is constructed at import time.
const OwnedWebSocket = globalThis.WebSocket;
const startOwnedTimer = globalThis.setTimeout;
const stopOwnedTimer = globalThis.clearTimeout;
const observeNativePromise = Promise.prototype.then;
const capabilities = new WeakMap();
const retained = new Set();
const custodyErrors = new WeakMap();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fields(value, keys) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)));
    const descriptors = Object.getOwnPropertyDescriptors(value);
    assert.deepEqual(Object.keys(descriptors).sort(), [...keys].sort());
    for (const key of keys)
        assert.ok(Object.hasOwn(descriptors[key], 'value'), 'Data properties only.');
}
function frozen(value) {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) frozen(item);
        Object.freeze(value);
    }
    return value;
}
/** Selected labels only. This pure validator does not authenticate a run or issue authority. */
export function validateWindowsNativeRequest(value) {
    fields(value, [
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
    for (const key of ['sourceCommit', 'sourceTree']) assert.match(value[key], /^[a-f0-9]{40}$/);
    for (const key of ['runId', 'runAttempt']) assert.match(value[key], /^[1-9][0-9]{0,31}$/);
    assert.equal(value.lane, 'win32-x64');
    assert.equal(value.caseId, 'windows-nsis:offline-launch');
    fields(value.package, ['name', 'bytes', 'sha256']);
    assert.equal(value.package.name, 'Diagnostic-Hub-Windows-x64-Setup.exe');
    assert.ok(
        Number.isSafeInteger(value.package.bytes) &&
            value.package.bytes > 0 &&
            value.package.bytes <= 2 * 1024 * 1024 * 1024 &&
            sha(value.package.sha256),
    );
    const root = value.root;
    assert.ok(
        typeof root === 'string' &&
            root.length <= 220 &&
            /^[A-Za-z]:\\/.test(root) &&
            root.endsWith('\\') === false &&
            path.win32.normalize(root) === root,
    );
    assert.ok(!/[\x00-\x1f\x7f/<>"|?*]/.test(root));
    const parts = root.slice(3).split('\\');
    assert.ok(parts.length > 0 && parts.length <= 32);
    for (const part of parts)
        assert.ok(
            part &&
                part !== '.' &&
                part !== '..' &&
                !/[.: ]$/.test(part) &&
                !part.includes(':') &&
                !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(
                    part,
                ),
        );
    assert.ok(Array.isArray(value.expectedFiles) && value.expectedFiles.length === 2);
    assert.equal(Object.getPrototypeOf(value.expectedFiles), Array.prototype);
    const fileDescriptors = Object.getOwnPropertyDescriptors(value.expectedFiles);
    assert.deepEqual(Object.keys(fileDescriptors).sort(), ['0', '1', 'length']);
    for (const key of ['0', '1'])
        assert.ok(Object.hasOwn(fileDescriptors[key], 'value'), 'File expectations must be data.');
    const files = value.expectedFiles.map((file, index) => {
        fields(file, ['relativePath', 'size', 'sha256']);
        assert.equal(file.relativePath, index ? 'resources/app.asar' : 'Diagnostic Hub.exe');
        assert.ok(
            Number.isSafeInteger(file.size) &&
                file.size > 0 &&
                file.size <= 512 * 1024 * 1024 &&
                sha(file.sha256),
        );
        return { relativePath: file.relativePath, size: file.size, sha256: file.sha256 };
    });
    return frozen({
        sourceCommit: value.sourceCommit,
        sourceTree: value.sourceTree,
        runId: value.runId,
        runAttempt: value.runAttempt,
        lane: value.lane,
        caseId: value.caseId,
        package: { ...value.package },
        root,
        expectedFiles: files,
    });
}
/** Build identity is explicit configuration, not a source/build/run authenticator. */
export function validateWindowsNativeBuild(value) {
    fields(value, [
        'binarySHA256',
        'sourceSHA256',
        'bindingSHA256',
        'nodeApi',
        'arch',
        'nodeVersion',
    ]);
    for (const name of ['binarySHA256', 'sourceSHA256', 'bindingSHA256'])
        assert.ok(sha(value[name]));
    assert.equal(value.nodeApi, 8);
    assert.equal(value.arch, 'x64');
    assert.equal(value.nodeVersion, '24.22.0');
    return Object.freeze({ ...value });
}
function retainedError(record, primary, close, combined = false) {
    const error = !combined
        ? primary
        : new AggregateError([primary, close], 'WINDOWS_NATIVE_READ_CLOSE_UNCONFIRMED', {
              cause: primary,
          });
    const existing =
        error instanceof Error
            ? Object.getOwnPropertyDescriptor(error, 'nativeAuthorityCustody')
            : undefined;
    if (error instanceof Error && existing && custodyErrors.get(error) === record.custodyToken)
        return error;
    const wrapper =
        error instanceof Error && Object.isExtensible(error) && !existing
            ? error
            : new Error('WINDOWS_NATIVE_PREPARATION_RETAINED', { cause: error });
    // Nonenumerability is not privacy. Never expose the mutable record, ports,
    // branded cap, native wrapper, buffers, handles, maps, or a graph back to them.
    const snapshot = Object.freeze({
        retainedAtCapture: retained.has(record),
        failedAtCapture: record.failed,
        cancelledAtCapture: record.cancelled,
        pendingOperationsAtCapture: record.pending.size,
        readCustodiesAtCapture: record.reads.size,
        launchReservedAtCapture: Boolean(record.launch),
    });
    Object.defineProperty(wrapper, 'nativeAuthorityCustody', {
        value: snapshot,
        enumerable: false,
    });
    custodyErrors.set(wrapper, record.custodyToken);
    return wrapper;
}
const same = (a, b) =>
    ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every((key) => a[key] === b[key]);
async function readBounded(record, file, maximum) {
    const custody = {
        file,
        handle: null,
        submitted: true,
        closeRequested: false,
        closeObserved: false,
    };
    record.reads.add(custody); // Retain acquisition before its promise can complete late.
    let primary,
        failed = false,
        closeFailed = false,
        close;
    try {
        assert.equal(await realpath(file), file);
        const before = await lstat(file, { bigint: true });
        assert.ok(
            before.isFile() &&
                !before.isSymbolicLink() &&
                before.nlink === 1n &&
                before.size > 0n &&
                before.size <= BigInt(maximum),
        );
        custody.handle = await open(file, constants.O_RDONLY);
        assert.ok(same(before, await custody.handle.stat({ bigint: true })));
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let at = 0;
        for (;;) {
            const result = await custody.handle.read(buffer, at, buffer.length - at, at);
            if (!result.bytesRead) break;
            at += result.bytesRead;
            assert.ok(at <= Number(before.size));
        }
        assert.equal(at, Number(before.size));
        assert.ok(
            same(before, await custody.handle.stat({ bigint: true })) &&
                same(before, await lstat(file, { bigint: true })),
        );
        return buffer.subarray(0, at);
    } catch (error) {
        failed = true;
        primary = error;
        throw error;
    } finally {
        if (custody.handle) {
            custody.closeRequested = true;
            try {
                await custody.handle.close();
                custody.closeObserved = true;
            } catch (error) {
                closeFailed = true;
                close = error;
            }
        }
        if (!closeFailed) record.reads.delete(custody);
        if (closeFailed)
            throw failed
                ? retainedError(record, primary, close, true)
                : retainedError(record, close);
    }
}
function state(cap) {
    const value = capabilities.get(cap);
    assert.ok(value, 'WINDOWS_NATIVE_CAPABILITY_UNISSUED');
    return value;
}
/** Importing this module has no filesystem, native loader, token or process effects.
 * Missing/incorrect native build inputs refuse. No controlled-test native issuer exists. */
export async function prepareWindowsNativeAuthority(request, expectedBuild) {
    const binding = validateWindowsNativeRequest(request),
        build = validateWindowsNativeBuild(expectedBuild);
    assert.equal(process.platform, 'win32', 'WINDOWS_NATIVE_HOST_REQUIRED');
    assert.equal(process.arch, build.arch);
    assert.equal(process.versions.node, build.nodeVersion);
    assert.ok(retained.size < 32, 'WINDOWS_NATIVE_OWNER_LIMIT');
    const cap = Object.freeze({});
    const record = {
        cap,
        custodyToken: Object.freeze({}),
        binding,
        build,
        native: null,
        raw: null,
        rows: new Map(),
        reads: new Set(),
        pending: new Set(),
        failed: false,
        cancelled: false,
        release: null,
        invalidated: false,
        launch: null,
    };
    capabilities.set(cap, record);
    retained.add(record); // Owner exists before the first IO/load.
    try {
        assert.equal(
            hash(await readBounded(record, path.join(directory, 'authority.cc'), 1024 * 1024)),
            build.sourceSHA256,
        );
        assert.equal(
            hash(await readBounded(record, path.join(directory, 'binding.gyp'), 65536)),
            build.bindingSHA256,
        );
        const moduleBytes = await readBounded(record, binary, 32 * 1024 * 1024);
        assert.equal(hash(moduleBytes), build.binarySHA256);
        // These path samples do not prove physical loaded-DLL bytes or compiler provenance.
        // A real invocation also needs a trusted immutable build/stage supplied externally.
        const nativeModule = { exports: {} };
        record.module = nativeModule; // Retain partial initialization too.
        loadNative(nativeModule, binary);
        const native = nativeModule.exports;
        for (const name of [
            'prepare',
            'assertCapability',
            'pinFiles',
            'observeProcess',
            'cancel',
            'release',
            'refuseNormalClose',
            'launchPinnedProcess',
            'acquireLaunchLifetime',
            'sampleOwnedProcess',
            'drainOwnedStdio',
            'releaseOwnedProcessHandles',
        ])
            assert.equal(typeof native[name], 'function');
        record.native = native;
        record.raw = native.prepare({ root: binding.root, expectedFiles: binding.expectedFiles });
        assert.equal(native.assertCapability(record.raw), true);
        assert.equal(hash(await readBounded(record, binary, 32 * 1024 * 1024)), build.binarySHA256);
        return cap;
    } catch (error) {
        record.failed = true;
        throw retainedError(record, error);
    }
}
export function assertWindowsNativeCapability(cap, expectedTuple) {
    const record = state(cap);
    assert.deepEqual(record.binding, validateWindowsNativeRequest(expectedTuple));
    assert.ok(
        record.native &&
            record.raw &&
            !record.failed &&
            !record.cancelled &&
            !record.invalidated &&
            record.pending.size === 0 &&
            !record.launch?.normalQuit?.inFlight,
        'WINDOWS_NATIVE_CAPABILITY_NOT_ACTIVE',
    );
    assert.equal(record.native.assertCapability(record.raw), true);
    return true;
}
function active(cap) {
    const record = state(cap);
    assertWindowsNativeCapability(cap, record.binding);
    return record;
}
async function operation(cap, role, invoke) {
    const record = active(cap);
    assert.ok(!record.rows.has(role), 'WINDOWS_NATIVE_OPERATION_ALREADY_SUBMITTED');
    const task = Promise.resolve().then(() => invoke(record));
    record.pending.add(task);
    try {
        const output = await task;
        assert.ok(typeof output === 'string' && Buffer.byteLength(output) <= 65536);
        assert.ok(!record.cancelled && !record.invalidated, 'WINDOWS_NATIVE_OPERATION_RETAINED');
        assert.equal(record.native.assertCapability(record.raw), true);
        const observation = JSON.parse(output);
        const value = {
            schemaVersion: 1,
            kind:
                role === 'file-pins' ? 'windows-native-file-pins/v1' : 'windows-native-process/v1',
            binding: record.binding,
            observation,
        };
        const bytes = Buffer.from(JSON.stringify(value) + '\n');
        assert.ok(bytes.length <= 65536);
        record.rows.set(role, bytes);
        return Buffer.from(bytes);
    } catch (error) {
        record.failed = true;
        throw retainedError(record, error);
    } finally {
        record.pending.delete(task);
    }
}
export function pinWindowsNativeFiles(cap) {
    return operation(cap, 'file-pins', (record) => record.native.pinFiles(record.raw));
}
export function observeWindowsNativeProcess(cap, process) {
    fields(process, ['pid', 'creationTime100ns']);
    assert.ok(Number.isInteger(process.pid) && process.pid > 0 && process.pid <= 0xffffffff);
    assert.ok(
        typeof process.creationTime100ns === 'string' &&
            /^[1-9][0-9]{0,19}$/.test(process.creationTime100ns) &&
            BigInt(process.creationTime100ns) <= 0xffffffffffffffffn,
    );
    const pid = process.pid,
        creation = process.creationTime100ns;
    return operation(cap, 'process', (record) => {
        assert.ok(!record.launch, 'WINDOWS_NATIVE_OWNED_PROCESS_ALREADY_RESERVED');
        return record.native.observeProcess(record.raw, pid, creation);
    });
}
export function readWindowsNativeObservation(cap, role) {
    const record = active(cap);
    assert.ok(role === 'file-pins' || role === 'process');
    const bytes = record.rows.get(role);
    assert.ok(bytes, 'WINDOWS_NATIVE_OBSERVATION_MISSING');
    return Buffer.from(bytes);
}
export function cancelWindowsNativeAuthority(cap) {
    const record = state(cap);
    record.cancelled = true;
    record.launch?.normalQuit?.onCancel();
    if (record.raw) record.native.cancel(record.raw);
}
/** Release only our new read/query handles. This never closes or retires the app. */
export function releaseWindowsNativeAuthority(cap) {
    const record = state(cap);
    assert.ok(!record.launch, 'WINDOWS_NATIVE_OWNED_RELEASE_REQUIRED');
    if (record.release) return record.release;
    assert.ok(record.raw && record.pending.size === 0, 'WINDOWS_NATIVE_RELEASE_PENDING');
    record.invalidated = true;
    record.release = Promise.resolve()
        .then(() => record.native.release(record.raw))
        .then((output) => {
            assert.ok(typeof output === 'string' && Buffer.byteLength(output) <= 4096);
            const value = JSON.parse(output);
            fields(value, [
                'readHandlesClosed',
                'retainedUnknown',
                'closedCount',
                'totalCount',
                'processOwnership',
                'physicalDescendantClosure',
                'releaseAcceptance',
            ]);
            assert.equal(typeof value.readHandlesClosed, 'boolean');
            assert.equal(typeof value.retainedUnknown, 'boolean');
            assert.equal(value.retainedUnknown, !value.readHandlesClosed);
            for (const key of ['closedCount', 'totalCount'])
                assert.ok(Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 64);
            assert.ok(value.closedCount <= value.totalCount);
            for (const key of [
                'processOwnership',
                'physicalDescendantClosure',
                'releaseAcceptance',
            ])
                assert.equal(value[key], false);
            if (value.readHandlesClosed) {
                assert.equal(value.closedCount, value.totalCount);
                retained.delete(record);
            }
            return Object.freeze(value);
        });
    void record.release.catch(() => {});
    return record.release;
}
export function refuseWindowsNativeNormalClose(cap) {
    const record = state(cap);
    if (record.raw) return record.native.refuseNormalClose(record.raw);
    throw Error('WINDOWS_ATOMIC_NORMAL_CLOSE_UNAVAILABLE');
}

/** Explicit requested inputs only. Neither this data nor an empty directory
 * establishes fresh/exclusive staging, authorization, or native launch admission. */
export function validateWindowsNativeLaunch(value, selected) {
    const binding = validateWindowsNativeRequest(selected);
    fields(value, ['action', 'profile']);
    assert.equal(value.action, 'launch-pinned-installed');
    assert.equal(value.profile, binding.root + '\\native-launch-profile');
    return Object.freeze({ action: value.action, profile: value.profile });
}
function launchRecord(cap) {
    const record = state(cap);
    assert.ok(record.launch && record.native && record.raw && !record.invalidated);
    assert.equal(record.pending.size, 0, 'WINDOWS_NATIVE_LAUNCH_OPERATION_PENDING');
    assert.ok(!record.launch.normalQuit?.inFlight, 'WINDOWS_NATIVE_QUIT_OPERATION_PENDING');
    return record;
}
function ownedObservation(output) {
    assert.ok(typeof output === 'string' && Buffer.byteLength(output) <= 65536);
    const value = JSON.parse(output);
    const flags = [
        'creationAttempted',
        'creationReturned',
        'createdByThisOwner',
        'processHandleRetained',
        'threadHandleRetained',
        'unconfirmedHandleOutput',
        'processExitObserved',
        'profileEmptyAtPreflight',
        'hostEventLoopReferenceAcknowledged',
        'stdioObserved',
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'releaseAcceptance',
    ];
    fields(value, [...flags, 'pid', 'threadId', 'creationTime100ns', 'exitCode']);
    for (const key of flags) assert.equal(typeof value[key], 'boolean');
    for (const key of [
        'stdioObserved',
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'releaseAcceptance',
    ])
        assert.equal(value[key], false);
    assert.ok(!value.creationReturned || value.creationAttempted);
    if (value.createdByThisOwner) {
        assert.equal(value.hostEventLoopReferenceAcknowledged, true);
        assert.ok(
            value.creationAttempted && value.creationReturned && value.profileEmptyAtPreflight,
        );
        assert.ok(
            value.processHandleRetained &&
                value.threadHandleRetained &&
                !value.unconfirmedHandleOutput,
        );
        for (const key of ['pid', 'threadId'])
            assert.ok(Number.isInteger(value[key]) && value[key] > 0 && value[key] <= 0xffffffff);
        assert.ok(
            typeof value.creationTime100ns === 'string' &&
                /^[1-9][0-9]{0,19}$/.test(value.creationTime100ns),
        );
        assert.ok(BigInt(value.creationTime100ns) <= 0xffffffffffffffffn);
    } else {
        assert.equal(value.pid, null);
        assert.equal(value.threadId, null);
        assert.equal(value.creationTime100ns, null);
        assert.equal(value.processExitObserved, false);
        assert.equal(value.processHandleRetained, false);
        assert.equal(value.threadHandleRetained, false);
    }
    if (value.processExitObserved)
        assert.ok(
            Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 0xffffffff,
        );
    else assert.equal(value.exitCode, null);
    return Object.freeze(value);
}
function retainLaunchFailure(record, error) {
    record.failed = true;
    if (!record.launch.firstFailureSet) {
        record.launch.firstFailureSet = true;
        record.launch.firstFailure = error;
        return retainedError(record, error);
    }
    // Keep the first object (including thrown undefined) as the primary cause.
    // Later observation/release failures remain reviewable without publishing
    // the private launch state merely to inspect its first-failure bookkeeping.
    return retainedError(
        record,
        new AggregateError(
            [record.launch.firstFailure, error],
            'WINDOWS_NATIVE_LAUNCH_FAILURE_RETAINED',
            { cause: record.launch.firstFailure },
        ),
    );
}
function saveOwnedObservation(record, output) {
    const observation = ownedObservation(output);
    record.launch.latest = observation;
    const bytes = Buffer.from(
        JSON.stringify({
            schemaVersion: 1,
            kind: 'windows-native-created-process/v2',
            binding: record.binding,
            requestedLaunch: record.launch.request,
            observation,
        }) + '\n',
    );
    assert.ok(bytes.length <= 65536);
    record.launch.bytes = bytes;
    return Buffer.from(bytes);
}
/** One explicit future native creation, never activated by import or a read-only
 * lifecycle caller. The owner and one-use reservation precede the submitted task.
 * A referenced native TSFN is acquired before creation and joined after own-HANDLE
 * closure. It prevents normal loop drain, not forced exit or unknown finalizer
 * bookkeeping. Those cases still require an independent host/caller custodian. */
export function launchWindowsNativePinnedProcess(cap, input) {
    const record = active(cap),
        request = validateWindowsNativeLaunch(input, record.binding);
    assert.ok(
        record.rows.has('file-pins') && !record.rows.has('process'),
        'WINDOWS_NATIVE_FILE_PINS_REQUIRED',
    );
    assert.ok(!record.launch, 'WINDOWS_NATIVE_LAUNCH_ALREADY_RESERVED');
    record.launch = {
        request,
        firstFailureSet: false,
        firstFailure: undefined,
        latest: null,
        bytes: null,
        release: null,
        lifetimeAcquisitionSubmitted: false,
        lifetimeAcquisitionAcknowledged: false,
        stdio: null,
        stdioObservationUnknown: false,
        stderrParsedBytes: 0,
        mainInspectorEndpoint: null,
    };
    const task = Promise.resolve().then(async () => {
        // Cancellation between reservation and submission grants no new effect.
        assert.ok(
            !record.cancelled && !record.invalidated,
            'WINDOWS_NATIVE_LAUNCH_CANCELLED_RETAINED',
        );
        record.launch.lifetimeAcquisitionSubmitted = true;
        const acquisition = record.native.acquireLaunchLifetime(record.raw);
        record.launch.lifetimeAcquisition = acquisition; // Adopt before observing a late result.
        const output = await acquisition;
        record.launch.lifetimeAcquisitionResult = output;
        assert.ok(typeof output === 'string' && Buffer.byteLength(output) <= 4096);
        const ack = JSON.parse(output);
        fields(ack, ['created', 'referenced', 'cleanupMarkerRegistered']);
        for (const key of ['created', 'referenced', 'cleanupMarkerRegistered'])
            assert.equal(ack[key], true);
        record.launch.lifetimeAcquisitionAcknowledged = true;
        assert.ok(
            !record.cancelled && !record.invalidated,
            'WINDOWS_NATIVE_LAUNCH_CANCELLED_RETAINED',
        );
        return record.native.launchPinnedProcess(record.raw, request.profile);
    });
    record.pending.add(task);
    return task
        .then((output) => {
            record.launch.returned = output; // Adopt before validation or a late cancellation.
            const bytes = saveOwnedObservation(record, output);
            assert.ok(
                !record.cancelled && !record.invalidated,
                'WINDOWS_NATIVE_LAUNCH_CANCELLED_RETAINED',
            );
            return bytes;
        })
        .catch((error) => {
            throw retainLaunchFailure(record, error);
        })
        .finally(() => record.pending.delete(task));
}
/** Terminal observation is available after cancellation/primary failure. It only
 * samples the native owner's returned HANDLE and cannot acquire or launch a PID. */
export function sampleWindowsNativeOwnedProcess(cap) {
    const record = launchRecord(cap);
    return sampleOwnedRecord(record);
}
function sampleOwnedRecord(record) {
    assert.equal(record.pending.size, 0, 'WINDOWS_NATIVE_LAUNCH_OPERATION_PENDING');
    const task = Promise.resolve().then(() => record.native.sampleOwnedProcess(record.raw));
    record.pending.add(task);
    return task
        .then((output) => saveOwnedObservation(record, output))
        .catch((error) => {
            throw retainLaunchFailure(record, error);
        })
        .finally(() => record.pending.delete(task));
}
export function readWindowsNativeOwnedProcess(cap) {
    const record = launchRecord(cap);
    assert.ok(record.launch.bytes, 'WINDOWS_NATIVE_OWNED_OBSERVATION_MISSING');
    return Buffer.from(record.launch.bytes);
}
const streamLimit = 65536;
const stdioResultLimit = 2 * 4 * Math.ceil(streamLimit / 3) + 4096;
function stdioFields(value, keys) {
    assert.ok(
        value && typeof value === 'object' && !Array.isArray(value),
        'WINDOWS_NATIVE_STDIO_SHAPE',
    );
    const own = Object.keys(value).sort();
    assert.ok(
        own.length === keys.length && own.every((key, index) => key === [...keys].sort()[index]),
        'WINDOWS_NATIVE_STDIO_SHAPE',
    );
}
function captureStream(value, previous) {
    stdioFields(value, ['base64', 'eof', 'overflow']);
    assert.ok(
        typeof value.eof === 'boolean' && typeof value.overflow === 'boolean',
        'WINDOWS_NATIVE_STDIO_SHAPE',
    );
    assert.ok(
        typeof value.base64 === 'string' && value.base64.length <= 4 * Math.ceil(streamLimit / 3),
        'WINDOWS_NATIVE_STDIO_BOUND',
    );
    assert.ok(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64),
        'WINDOWS_NATIVE_STDIO_ENCODING',
    );
    const padding = value.base64.endsWith('==') ? 2 : value.base64.endsWith('=') ? 1 : 0;
    assert.ok((value.base64.length / 4) * 3 - padding <= streamLimit, 'WINDOWS_NATIVE_STDIO_BOUND');
    const bytes = Buffer.from(value.base64, 'base64');
    assert.ok(
        bytes.length <= streamLimit && bytes.toString('base64') === value.base64,
        'WINDOWS_NATIVE_STDIO_ENCODING',
    );
    if (previous) {
        assert.ok(
            bytes.length >= previous.bytes.length &&
                bytes.subarray(0, previous.bytes.length).equals(previous.bytes),
            'WINDOWS_NATIVE_STDIO_PREFIX_CHANGED',
        );
        assert.ok(
            !previous.eof || (value.eof && bytes.length === previous.bytes.length),
            'WINDOWS_NATIVE_STDIO_EOF_CHANGED',
        );
        assert.ok(!previous.overflow || value.overflow, 'WINDOWS_NATIVE_STDIO_OVERFLOW_CHANGED');
    }
    assert.ok(
        !value.overflow || bytes.length === streamLimit,
        'WINDOWS_NATIVE_STDIO_OVERFLOW_SHAPE',
    );
    return { bytes, eof: value.eof, overflow: value.overflow };
}
function parseInspectorLines(record) {
    const capture = record.launch.stdio.stderr;
    let at = record.launch.stderrParsedBytes;
    while (at < capture.bytes.length) {
        const newline = capture.bytes.indexOf(10, at);
        if (newline < 0 && !capture.eof) break;
        const end = newline < 0 ? capture.bytes.length : newline;
        const line = capture.bytes.subarray(at, end).toString('utf8').replace(/\r$/, '');
        at = newline < 0 ? end : end + 1;
        record.launch.stderrParsedBytes = at;
        if (!line.startsWith('Debugger listening on ')) continue;
        const raw = line.slice('Debugger listening on '.length);
        const match =
            /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.exec(
                raw,
            );
        assert.ok(match && Number(match[1]) <= 65535, 'WINDOWS_NATIVE_INSPECTOR_ENDPOINT_INVALID');
        assert.ok(
            record.launch.mainInspectorEndpoint === null,
            'WINDOWS_NATIVE_INSPECTOR_ENDPOINT_DUPLICATE',
        );
        record.launch.mainInspectorEndpoint = raw;
    }
}
function captureStdio(record, output) {
    assert.ok(
        typeof output === 'string' && Buffer.byteLength(output) <= stdioResultLimit,
        'WINDOWS_NATIVE_STDIO_RESULT_BOUND',
    );
    let value;
    try {
        value = JSON.parse(output);
    } catch {
        throw Error('WINDOWS_NATIVE_STDIO_JSON');
    }
    stdioFields(value, [
        'configured',
        'parentChildCopiesClosed',
        'acquisitionUnknown',
        'stdout',
        'stderr',
    ]);
    for (const key of ['configured', 'parentChildCopiesClosed', 'acquisitionUnknown'])
        assert.ok(typeof value[key] === 'boolean', 'WINDOWS_NATIVE_STDIO_SHAPE');
    const previous = record.launch.stdio;
    if (previous) {
        assert.ok(
            !previous.configured || value.configured,
            'WINDOWS_NATIVE_STDIO_CONFIGURATION_CHANGED',
        );
        assert.ok(
            !previous.parentChildCopiesClosed || value.parentChildCopiesClosed,
            'WINDOWS_NATIVE_STDIO_CHILD_COPY_CHANGED',
        );
        assert.ok(
            !previous.acquisitionUnknown || value.acquisitionUnknown,
            'WINDOWS_NATIVE_STDIO_UNKNOWN_CHANGED',
        );
    }
    const stdout = captureStream(value.stdout, previous?.stdout),
        stderr = captureStream(value.stderr, previous?.stderr);
    assert.ok(
        !value.parentChildCopiesClosed || value.configured,
        'WINDOWS_NATIVE_STDIO_CONFIGURATION',
    );
    if (!value.configured)
        assert.ok(
            !value.parentChildCopiesClosed &&
                !stdout.bytes.length &&
                !stderr.bytes.length &&
                !stdout.eof &&
                !stderr.eof &&
                !stdout.overflow &&
                !stderr.overflow,
            'WINDOWS_NATIVE_STDIO_CONFIGURATION',
        );
    if (record.launch.latest?.createdByThisOwner)
        assert.ok(
            value.configured && value.parentChildCopiesClosed,
            'WINDOWS_NATIVE_STDIO_CHILD_COPY_UNKNOWN',
        );
    record.launch.stdio = {
        configured: value.configured,
        parentChildCopiesClosed: value.parentChildCopiesClosed,
        acquisitionUnknown: value.acquisitionUnknown,
        stdout,
        stderr,
    };
    assert.ok(!value.acquisitionUnknown, 'WINDOWS_NATIVE_STDIO_ACQUISITION_UNKNOWN');
    record.launch.stdioObservationUnknown = false;
    assert.ok(!stdout.overflow && !stderr.overflow, 'WINDOWS_NATIVE_STDIO_CAPTURE_OVERFLOW');
    parseInspectorLines(record);
    return frozen({
        configured: value.configured,
        parentChildCopiesClosed: value.parentChildCopiesClosed,
        acquisitionUnknown: value.acquisitionUnknown,
        stdout: { bytesRetained: stdout.bytes.length, eof: stdout.eof, overflow: stdout.overflow },
        stderr: { bytesRetained: stderr.bytes.length, eof: stderr.eof, overflow: stderr.overflow },
        mainInspectorEndpointObserved: record.launch.mainInspectorEndpoint !== null,
    });
}
/** Explicit bounded reads of this owner's private pipes, also after cancellation
 * or a primary error. No polling, socket connection, or normal-close command. */
export function drainWindowsNativeOwnedStdio(cap) {
    const record = launchRecord(cap);
    return drainOwnedRecord(record);
}
function drainOwnedRecord(record) {
    assert.equal(record.pending.size, 0, 'WINDOWS_NATIVE_LAUNCH_OPERATION_PENDING');
    record.launch.stdioObservationUnknown = true;
    const task = Promise.resolve().then(() => record.native.drainOwnedStdio(record.raw));
    record.pending.add(task);
    return task
        .then((output) => {
            record.launch.stdioReturned = output; // Retain even a malformed/late native result.
            return captureStdio(record, output);
        })
        .catch((error) => {
            throw retainLaunchFailure(record, error);
        })
        .finally(() => record.pending.delete(task));
}
/** Private owned-stderr provenance only. An inherited writer can be used by a
 * descendant; this is not kernel socket-owner or physical loaded-image proof. */
export function readWindowsNativeMainInspectorEndpoint(cap) {
    const record = active(cap);
    assert.ok(record.launch?.mainInspectorEndpoint, 'WINDOWS_NATIVE_INSPECTOR_ENDPOINT_MISSING');
    return record.launch.mainInspectorEndpoint;
}
function quitDeferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
function quitOwner(record) {
    const q = {
        inFlight: true,
        task: null,
        socket: null,
        constructorSubmitted: false,
        constructorReturned: false,
        closeSubmitted: false,
        closeReturned: false,
        closeObserved: false,
        transportClosedAcknowledged: false,
        opened: quitDeferred(),
        contextReady: quitDeferred(),
        closed: quitDeferred(),
        failureGate: quitDeferred(),
        failure: null,
        rawExceptions: [],
        listeners: [],
        timers: new Set(),
        timerUnknown: false,
        responseWaits: new Map(),
        closedUnacknowledgedReplies: 0,
        sequence: 0,
        receivedBytes: 0,
        operationUnknown: false,
        unexpectedReturns: [],
        registrationComplete: false,
        transportFinalizing: false,
        socketUsable: false,
        protocolCallsPending: 0,
        requests: [],
        context: null,
        contextInvalidated: false,
        identityReplyObserved: false,
        quitSendSubmitted: false,
        quitSchedulingReplyObserved: false,
    };
    q.fail = function (code, raw) {
        if (q.rawExceptions.length < 8 && arguments.length > 1) q.rawExceptions.push(raw);
        if (!q.failure) {
            q.failure = Error('WINDOWS_NATIVE_QUIT_' + code);
            q.failureGate.reject(q.failure);
        }
    };
    q.onCancel = () => {
        if (q.inFlight) q.fail('CANCELLED');
    };
    q.active = () => {
        if (record.cancelled || record.invalidated) q.fail('CANCELLED');
        if (q.failure) throw q.failure;
    };
    q.wait = (promise) => Promise.race([promise, q.failureGate.promise]);
    return q;
}
function unknownQuitReturn(q, value, code) {
    if (value === undefined) return false;
    q.operationUnknown = true;
    const retained = { value, settled: false };
    q.unexpectedReturns.push(retained); // One per already bounded operation, before observation.
    if (nativeTypes.isPromise(value)) {
        try {
            observeNativePromise.call(
                value,
                (result) => {
                    retained.settled = true;
                    retained.result = result;
                },
                (error) => {
                    retained.settled = true;
                    retained.error = error;
                },
            );
        } catch (error) {
            retained.observationError = error;
        }
    }
    q.fail(code);
    return true;
}
function timeoutHandle(value) {
    if (
        !value ||
        typeof value !== 'object' ||
        nativeTypes.isPromise(value) ||
        nativeTypes.isProxy(value)
    )
        return false;
    for (const key of ['ref', 'unref', 'hasRef', 'refresh', Symbol.toPrimitive]) {
        let object = value,
            found = false;
        for (let depth = 0; object && depth < 4; depth++, object = Object.getPrototypeOf(object)) {
            if (nativeTypes.isProxy(object)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            if (!descriptor) continue;
            if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function')
                return false;
            found = true;
            break;
        }
        if (!found) return false;
    }
    return true;
}
function quitTimer(q, delay, action) {
    q.active();
    const timer = {
        handle: undefined,
        returned: false,
        valid: false,
        fired: false,
        clearSubmitted: false,
        clearReturned: false,
    };
    assert.ok(q.timers.size < 2, 'WINDOWS_NATIVE_QUIT_TIMER_BOUND');
    q.timers.add(timer); // Adopt acquisition before the builtin can return/throw.
    try {
        timer.handle = startOwnedTimer(() => {
            if (!timer.returned) {
                q.timerUnknown = true;
                q.fail('TIMER_REENTRANT');
            }
            timer.fired = true;
            q.timers.delete(timer);
            action();
        }, delay);
        timer.returned = true;
        if (!timeoutHandle(timer.handle)) {
            q.timerUnknown = true;
            unknownQuitReturn(q, timer.handle, 'TIMER_RESULT_UNKNOWN');
            q.fail('TIMER_RESULT_UNKNOWN');
        } else timer.valid = true;
    } catch (error) {
        q.timerUnknown = true;
        q.fail('TIMER_ACQUISITION_UNKNOWN', error);
    }
    return timer;
}
function clearQuitTimers(q) {
    for (const timer of q.timers) {
        if (!timer.returned || !timer.valid || timer.clearSubmitted) {
            q.timerUnknown = true;
            continue;
        }
        timer.clearSubmitted = true;
        try {
            const returned = stopOwnedTimer(timer.handle);
            if (unknownQuitReturn(q, returned, 'TIMER_CLEAR_UNKNOWN')) {
                q.timerUnknown = true;
                continue;
            }
            timer.clearReturned = true;
            q.timers.delete(timer);
        } catch (error) {
            q.timerUnknown = true;
            q.fail('TIMER_CLEAR_UNKNOWN', error);
        }
    }
}
function closeQuitSocket(q) {
    if (q.closeSubmitted || q.closeObserved || !q.socketUsable) return;
    q.closeSubmitted = true;
    q.protocolCallsPending++;
    try {
        if (unknownQuitReturn(q, q.socket.close(), 'TRANSPORT_CLOSE_UNKNOWN')) return;
        q.closeReturned = true;
    } catch (error) {
        q.operationUnknown = true;
        q.fail('TRANSPORT_CLOSE_UNKNOWN', error);
    } finally {
        q.protocolCallsPending--;
        if (q.closeObserved) finishQuitTransport(q);
    }
}
function finishQuitTransport(q) {
    q.closeObserved = true;
    if (
        !q.registrationComplete ||
        q.protocolCallsPending ||
        q.transportFinalizing ||
        q.transportClosedAcknowledged
    )
        return;
    q.transportFinalizing = true;
    try {
        assert.ok(q.socket.readyState === 3, 'WINDOWS_NATIVE_QUIT_TRANSPORT_STATE');
        for (const [id, wait] of q.responseWaits) {
            q.closedUnacknowledgedReplies++;
            wait.reject(Error('WINDOWS_NATIVE_QUIT_REPLY_CLOSED_UNACKNOWLEDGED'));
            q.responseWaits.delete(id);
        }
        for (const listener of q.listeners) {
            if (listener.removeSubmitted) {
                assert.ok(listener.removeReturned, 'WINDOWS_NATIVE_QUIT_LISTENER_UNKNOWN');
                continue;
            }
            listener.removeSubmitted = true;
            const returned = q.socket.removeEventListener(listener.type, listener.callback);
            if (unknownQuitReturn(q, returned, 'LISTENER_REMOVE_UNKNOWN'))
                throw Error('listener return');
            listener.removeReturned = true;
        }
        assert.ok(!q.operationUnknown, 'WINDOWS_NATIVE_QUIT_OPERATION_UNKNOWN');
        q.transportClosedAcknowledged = true;
        q.closed.resolve(
            Object.freeze({
                transportConstructionSubmitted: true,
                ownedInspectorCloseObserved: true,
                closedUnacknowledgedReplies: q.closedUnacknowledgedReplies,
            }),
        );
    } catch (error) {
        q.operationUnknown = true;
        q.fail('TRANSPORT_BOOKKEEPING_UNKNOWN', error);
    }
    q.transportFinalizing = false;
    if (!q.quitSchedulingReplyObserved) q.fail('TRANSPORT_CLOSED_BEFORE_QUIT_ACK');
}
function quitMessage(q, event) {
    if (q.closeObserved) return;
    try {
        assert.ok(typeof event.data === 'string' && Buffer.byteLength(event.data) <= 65536);
        q.receivedBytes += Buffer.byteLength(event.data);
        assert.ok(q.receivedBytes <= 1024 * 1024);
        q.lastFrame = event.data; // Private bounded retention, never an error/notice.
        const message = JSON.parse(event.data);
        assert.ok(message && typeof message === 'object' && !Array.isArray(message));
        if (Object.hasOwn(message, 'id')) {
            assert.ok(Number.isInteger(message.id) && message.id > 0 && message.id <= q.sequence);
            const wait = q.responseWaits.get(message.id);
            if (!wait) return; // Late/duplicate reply cannot create another request.
            wait.replyObserved = true;
            wait.reply = message;
            q.responseWaits.delete(message.id);
            if (message.error || !Object.hasOwn(message, 'result')) {
                wait.reject(Error('WINDOWS_NATIVE_QUIT_PROTOCOL_REPLY_ERROR'));
                q.fail('PROTOCOL_REPLY_ERROR');
            } else {
                if (wait.phase === 'quit') {
                    try {
                        const scheduled = quitValue(message.result);
                        assert.ok(
                            Object.keys(scheduled).length === 1 && scheduled.scheduled === true,
                        );
                        q.quitSchedulingReplyObserved = true; // Latch wire order before another event/await continuation.
                    } catch {
                        wait.reject(Error('WINDOWS_NATIVE_QUIT_SCHEDULE_NOT_ACKNOWLEDGED'));
                        q.fail('SCHEDULE_NOT_ACKNOWLEDGED');
                        return;
                    }
                }
                wait.resolve(message.result);
            }
            return;
        }
        assert.ok(typeof message.method === 'string' && message.method.length <= 200);
        if (
            message.method === 'Runtime.executionContextCreated' &&
            message.params?.context?.auxData?.isDefault === true
        ) {
            const context = message.params.context;
            assert.ok(Number.isInteger(context.id) && context.id > 0 && context.id <= 0x7fffffff);
            assert.ok(
                typeof context.uniqueId === 'string' &&
                    context.uniqueId.length > 0 &&
                    context.uniqueId.length <= 256 &&
                    !context.uniqueId.includes('\0'),
            );
            if (
                q.context &&
                (q.context.id !== context.id || q.context.uniqueId !== context.uniqueId)
            ) {
                q.contextInvalidated = true;
                if (!q.quitSchedulingReplyObserved) q.fail('CONTEXT_CHANGED');
            } else {
                q.context = { id: context.id, uniqueId: context.uniqueId };
                q.contextReady.resolve(q.context);
            }
        }
        if (
            message.method === 'Runtime.executionContextsCleared' ||
            (q.context &&
                message.method === 'Runtime.executionContextDestroyed' &&
                (message.params?.executionContextId === q.context?.id ||
                    message.params?.executionContextUniqueId === q.context?.uniqueId))
        ) {
            q.contextInvalidated = true;
            if (!q.quitSchedulingReplyObserved) q.fail('CONTEXT_LOST');
        }
    } catch (error) {
        q.fail('PROTOCOL_INVALID', error);
    }
}
function openQuitSocket(q, endpoint) {
    q.active();
    q.constructorSubmitted = true;
    try {
        q.socket = new OwnedWebSocket(endpoint); // Owner exists before connection effect.
        q.constructorReturned = true; // Adopt before methods/listeners can throw.
        let prototype = q.socket,
            matched = false;
        for (let depth = 0; prototype && depth < 8; depth++) {
            if (nativeTypes.isProxy(prototype)) break;
            if (prototype === OwnedWebSocket.prototype) {
                matched = true;
                break;
            }
            prototype = Object.getPrototypeOf(prototype);
        }
        if (!matched) {
            unknownQuitReturn(q, q.socket, 'TRANSPORT_ACQUISITION_UNKNOWN');
            return;
        }
        q.socketUsable = true;
        for (const [type, callback] of [
            ['open', () => q.opened.resolve()],
            ['error', () => q.fail('TRANSPORT_ERROR')],
            ['close', () => finishQuitTransport(q)],
            ['message', (event) => quitMessage(q, event)],
        ]) {
            if (q.closeObserved || q.failure) break;
            if (q.socket.readyState !== 0 && q.socket.readyState !== 1) {
                q.fail('TRANSPORT_PREMATURE_STATE');
                break;
            }
            const listener = {
                type,
                callback,
                addReturned: false,
                removeSubmitted: false,
                removeReturned: false,
            };
            q.listeners.push(listener);
            const returned = q.socket.addEventListener(type, callback);
            listener.addReturned = true;
            if (unknownQuitReturn(q, returned, 'LISTENER_ADD_UNKNOWN')) break;
        }
        q.registrationComplete = true;
        if (q.closeObserved) {
            finishQuitTransport(q);
            return;
        }
        if (q.socket.readyState === 1) q.opened.resolve();
        else assert.ok(q.socket.readyState === 0);
    } catch (error) {
        q.operationUnknown = true;
        q.fail('TRANSPORT_ACQUISITION_UNKNOWN', error);
    } finally {
        q.registrationComplete = true;
        if (q.closeObserved) finishQuitTransport(q);
    }
}
function quitRpc(q, phase) {
    q.active();
    assert.ok(
        q.socket?.readyState === 1 && !q.closeSubmitted && !q.contextInvalidated,
        'WINDOWS_NATIVE_QUIT_CHANNEL_NOT_ACTIVE',
    );
    assert.ok(q.responseWaits.size < 4 && q.sequence < 3, 'WINDOWS_NATIVE_QUIT_REQUEST_BOUND');
    let method, params;
    if (phase === 'enable') {
        method = 'Runtime.enable';
        params = {};
    } else {
        assert.ok(q.context, 'WINDOWS_NATIVE_QUIT_CONTEXT_MISSING');
        method = 'Runtime.evaluate';
        if (phase === 'quit') {
            assert.ok(!q.quitSendSubmitted, 'WINDOWS_NATIVE_QUIT_ALREADY_SUBMITTED');
            q.quitSendSubmitted = true;
        } else assert.ok(phase === 'identity');
        params = {
            uniqueContextId: q.context.uniqueId,
            expression:
                phase === 'identity'
                    ? '(()=>({pid:process.pid,type:process.type}))()'
                    : '(()=>{const{app}=require("electron");setImmediate(()=>app.quit());return{scheduled:true};})()',
            includeCommandLineAPI: true,
            awaitPromise: true,
            returnByValue: true,
        };
    }
    const id = ++q.sequence,
        wait = quitDeferred();
    wait.phase = phase;
    wait.replyObserved = false;
    q.requests.push(wait);
    q.responseWaits.set(id, wait); // Own response/uncertain send before socket.send.
    q.protocolCallsPending++;
    try {
        unknownQuitReturn(
            q,
            q.socket.send(JSON.stringify({ id, method, params })),
            'SEND_UNCONFIRMED',
        );
    } catch (error) {
        q.operationUnknown = true;
        q.fail('SEND_UNCONFIRMED', error);
    } finally {
        q.protocolCallsPending--;
        if (q.closeObserved) finishQuitTransport(q);
    }
    return q.wait(wait.promise);
}
function quitValue(reply) {
    assert.ok(
        reply &&
            typeof reply === 'object' &&
            !Object.hasOwn(reply, 'exceptionDetails') &&
            reply.result?.type === 'object',
        'WINDOWS_NATIVE_QUIT_EVALUATE_INVALID',
    );
    const value = reply.result.value;
    assert.ok(
        value && typeof value === 'object' && !Array.isArray(value),
        'WINDOWS_NATIVE_QUIT_EVALUATE_INVALID',
    );
    return value;
}
async function runNormalQuit(record, q) {
    q.active();
    assert.ok(
        typeof OwnedWebSocket === 'function' &&
            !nativeTypes.isProxy(OwnedWebSocket) &&
            typeof startOwnedTimer === 'function' &&
            typeof stopOwnedTimer === 'function',
        'WINDOWS_NATIVE_QUIT_HOST_PRIMITIVES_UNAVAILABLE',
    );
    quitTimer(q, 15000, () => q.fail('DEADLINE'));
    q.active();
    await q.wait(sampleOwnedRecord(record));
    const pid = record.launch.latest.pid;
    assert.ok(
        record.launch.latest.createdByThisOwner && !record.launch.latest.processExitObserved,
        'WINDOWS_NATIVE_QUIT_ROOT_NOT_LIVE',
    );
    openQuitSocket(q, record.launch.mainInspectorEndpoint);
    await q.wait(q.opened.promise);
    q.active();
    await quitRpc(q, 'enable');
    await q.wait(q.contextReady.promise);
    const identity = quitValue(await quitRpc(q, 'identity'));
    assert.ok(
        Object.keys(identity).length === 2 && identity.pid === pid && identity.type === 'browser',
        'WINDOWS_NATIVE_QUIT_IDENTITY_MISMATCH',
    );
    q.identityReplyObserved = true;
    q.active();
    await q.wait(sampleOwnedRecord(record));
    q.active();
    assert.ok(
        record.launch.latest.pid === pid && !record.launch.latest.processExitObserved,
        'WINDOWS_NATIVE_QUIT_ROOT_NOT_LIVE',
    );
    const scheduled = quitValue(await quitRpc(q, 'quit'));
    assert.ok(
        Object.keys(scheduled).length === 1 && scheduled.scheduled === true,
        'WINDOWS_NATIVE_QUIT_SCHEDULE_NOT_ACKNOWLEDGED',
    );
    q.quitSchedulingReplyObserved = true;
    closeQuitSocket(q); // Detach our debugger before asking the app to finish exit.
    for (let poll = 0; poll < 750; poll++) {
        q.active();
        await q.wait(sampleOwnedRecord(record));
        q.active();
        await q.wait(drainOwnedRecord(record));
        const root = record.launch.latest,
            streams = record.launch.stdio;
        if (root.processExitObserved && streams.stdout.eof && streams.stderr.eof) {
            assert.ok(root.exitCode === 0, 'WINDOWS_NATIVE_QUIT_ROOT_EXIT_NOT_ZERO');
            await q.wait(q.closed.promise);
            q.active();
            clearQuitTimers(q);
            q.active();
            assert.ok(
                q.responseWaits.size === 0 &&
                    q.closedUnacknowledgedReplies === 0 &&
                    !q.timerUnknown &&
                    q.timers.size === 0 &&
                    q.closeObserved &&
                    q.transportClosedAcknowledged &&
                    !q.operationUnknown,
                'WINDOWS_NATIVE_QUIT_BOOKKEEPING_UNKNOWN',
            );
            return Object.freeze({
                identityReplyObserved: true,
                quitSchedulingReplyObserved: true,
                rootExitObserved: true,
                rootExitCode: 0,
                stdoutEOF: true,
                stderrEOF: true,
                ownedInspectorCloseObserved: true,
                closedUnacknowledgedReplies: 0,
                physicalLoadedBytesVerified: false,
                physicalDescendantClosure: false,
                releaseAcceptance: false,
            });
        }
        const delay = quitDeferred();
        quitTimer(q, 20, () => delay.resolve());
        await q.wait(delay.promise);
    }
    throw Error('WINDOWS_NATIVE_QUIT_POLL_BUDGET');
}
/** Fixed cooperative main-inspector protocol only. No arbitrary expression, URL,
 * HWND dispatch or native/full lifecycle admission is exposed. */
export function requestWindowsNativeNormalQuit(cap) {
    const selected = state(cap);
    if (selected.launch?.normalQuit) return selected.launch.normalQuit.task;
    const record = active(cap);
    assert.ok(
        record.launch?.mainInspectorEndpoint && record.launch.latest?.createdByThisOwner,
        'WINDOWS_NATIVE_QUIT_CREATED_ENDPOINT_REQUIRED',
    );
    const q = quitOwner(record);
    record.launch.normalQuit = q; // Before every effect.
    q.task = Promise.resolve()
        .then(() => runNormalQuit(record, q))
        .catch((error) => {
            closeQuitSocket(q);
            // A native observation error already carries its original first cause.
            throw custodyErrors.has(error) ? error : retainLaunchFailure(record, error);
        })
        .finally(() => {
            clearQuitTimers(q);
            if (!q.constructorSubmitted) {
                q.transportClosedAcknowledged = true; // This operation never invoked the constructor.
                q.closed.resolve(
                    Object.freeze({
                        transportConstructionSubmitted: false,
                        ownedInspectorCloseObserved: false,
                        closedUnacknowledgedReplies: 0,
                    }),
                );
            }
            q.inFlight = false;
        });
    void q.task.catch(() => {});
    return q.task;
}
/** Observe only this already-issued transport, including after cancellation or
 * failure. It cannot reconnect, evaluate, close an app or manufacture reply ACKs. */
export function joinWindowsNativeNormalQuitTransport(cap) {
    const q = state(cap).launch?.normalQuit;
    assert.ok(q, 'WINDOWS_NATIVE_QUIT_NOT_REQUESTED');
    return q.closed.promise;
}
/** Join own-HANDLE closure and the native lifetime finalizer, once, after an actual
 * terminal/non-creation sample and created-child pipe EOF. This does not establish
 * closure of every app owner or descendant. */
export function releaseWindowsNativeOwnedProcessHandles(cap) {
    const record = state(cap);
    assert.ok(record.launch, 'WINDOWS_NATIVE_LAUNCH_NOT_RESERVED');
    if (record.launch.release) return record.launch.release;
    launchRecord(cap);
    const last = record.launch.latest;
    assert.ok(
        last &&
            !last.unconfirmedHandleOutput &&
            (last.createdByThisOwner
                ? last.processExitObserved
                : !last.creationAttempted || last.creationReturned),
        'WINDOWS_NATIVE_CREATED_PROCESS_LIVE_OR_UNKNOWN',
    );
    const stdio = record.launch.stdio;
    const quit = record.launch.normalQuit;
    assert.ok(
        !quit ||
            (quit.transportClosedAcknowledged &&
                quit.responseWaits.size === 0 &&
                quit.timers.size === 0 &&
                !quit.timerUnknown &&
                !quit.operationUnknown),
        'WINDOWS_NATIVE_QUIT_TRANSPORT_PENDING',
    );
    assert.ok(!record.launch.stdioObservationUnknown, 'WINDOWS_NATIVE_STDIO_OBSERVATION_UNKNOWN');
    assert.ok(!stdio?.acquisitionUnknown, 'WINDOWS_NATIVE_STDIO_ACQUISITION_UNKNOWN');
    if (last.createdByThisOwner)
        assert.ok(
            stdio?.configured &&
                stdio.parentChildCopiesClosed &&
                stdio.stdout.eof &&
                stdio.stderr.eof,
            'WINDOWS_NATIVE_STDIO_EOF_REQUIRED',
        );
    record.invalidated = true;
    record.launch.release = Promise.resolve()
        .then(() => record.native.releaseOwnedProcessHandles(record.raw))
        .then((output) => {
            assert.ok(typeof output === 'string' && Buffer.byteLength(output) <= 4096);
            const value = JSON.parse(output);
            fields(value, [
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
            assert.equal(typeof value.ownedHandlesClosed, 'boolean');
            for (const key of [
                'hostLifetimeAcquisitionSubmitted',
                'hostLifetimeReleaseAcknowledged',
                'hostLifetimeFinalizerObserved',
                'hostLifetimeFinalizerAcknowledged',
                'hostEnvironmentClosing',
            ])
                assert.equal(typeof value[key], 'boolean');
            assert.equal(
                value.hostLifetimeAcquisitionSubmitted,
                record.launch.lifetimeAcquisitionSubmitted,
            );
            if (!value.hostLifetimeAcquisitionSubmitted)
                for (const key of [
                    'hostLifetimeReleaseAcknowledged',
                    'hostLifetimeFinalizerObserved',
                    'hostLifetimeFinalizerAcknowledged',
                    'hostEnvironmentClosing',
                ])
                    assert.equal(value[key], false);
            if (value.hostLifetimeReleaseAcknowledged)
                assert.equal(value.hostLifetimeAcquisitionSubmitted, true);
            if (value.hostLifetimeFinalizerAcknowledged)
                assert.ok(
                    value.hostLifetimeAcquisitionSubmitted &&
                        value.hostLifetimeReleaseAcknowledged &&
                        value.hostLifetimeFinalizerObserved &&
                        !value.hostEnvironmentClosing,
                );
            const complete =
                value.ownedHandlesClosed &&
                (!value.hostLifetimeAcquisitionSubmitted ||
                    (value.hostLifetimeReleaseAcknowledged &&
                        value.hostLifetimeFinalizerObserved &&
                        value.hostLifetimeFinalizerAcknowledged &&
                        !value.hostEnvironmentClosing));
            assert.equal(value.retainedUnknown, !complete);
            for (const key of ['closedCount', 'totalCount'])
                assert.ok(Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 64);
            assert.ok(value.closedCount <= value.totalCount);
            for (const key of [
                'processOwnership',
                'physicalDescendantClosure',
                'releaseAcceptance',
            ])
                assert.equal(value[key], false);
            if (value.ownedHandlesClosed) assert.equal(value.closedCount, value.totalCount);
            if (complete) {
                assert.equal(value.closedCount, value.totalCount);
                retained.delete(record);
            }
            return Object.freeze(value);
        })
        .catch((error) => {
            throw retainLaunchFailure(record, error);
        });
    void record.launch.release.catch(() => {});
    return record.launch.release;
}
