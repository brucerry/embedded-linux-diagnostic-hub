import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dlopen } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../tests/native/windows-installer-authority',
);
const binary = path.join(directory, 'build/Release/windows_installer_authority.node');
const loadNative = dlopen; // Capture the trusted Node builtin; bypass require.cache/extensions.
const capabilities = new WeakMap();
const retained = new Set();
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
    const wrapper =
        error instanceof Error &&
        Object.isExtensible(error) &&
        (!existing || existing.value === record)
            ? error
            : new Error('WINDOWS_NATIVE_PREPARATION_RETAINED', { cause: error });
    Object.defineProperty(wrapper, 'nativeAuthorityCustody', { value: record, enumerable: false });
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
            'sampleOwnedProcess',
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
            record.pending.size === 0,
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
    }
    return retainedError(record, error);
}
function saveOwnedObservation(record, output) {
    const observation = ownedObservation(output);
    record.launch.latest = observation;
    const bytes = Buffer.from(
        JSON.stringify({
            schemaVersion: 1,
            kind: 'windows-native-created-process/v1',
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
 * An independent live host/caller lifetime must precede this call and continue
 * through terminal observation and HANDLE-release ACK. Retained JS/native objects,
 * raw HANDLEs and pending promises do not themselves keep Node's event loop alive. */
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
    };
    const task = Promise.resolve().then(() => {
        // Cancellation between reservation and submission grants no new effect.
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
/** Release only our HANDLEs, once, after a genuine native terminal sample or a
 * confirmed non-creation. Stdio, all app owners and descendants remain unknown. */
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
            ]);
            assert.equal(typeof value.ownedHandlesClosed, 'boolean');
            assert.equal(value.retainedUnknown, !value.ownedHandlesClosed);
            for (const key of ['closedCount', 'totalCount'])
                assert.ok(Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 64);
            assert.ok(value.closedCount <= value.totalCount);
            for (const key of [
                'processOwnership',
                'physicalDescendantClosure',
                'releaseAcceptance',
            ])
                assert.equal(value[key], false);
            if (value.ownedHandlesClosed) {
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
