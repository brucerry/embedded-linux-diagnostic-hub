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
    return operation(cap, 'process', (record) =>
        record.native.observeProcess(record.raw, pid, creation),
    );
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
