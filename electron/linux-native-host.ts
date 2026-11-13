import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { constants as osConstants } from 'node:os';
import { types } from 'node:util';
import type { Stats } from 'node:fs';
import { physicalFS } from './physical-fs.ts';
import { checkedLinuxRenameBinding, checkedLinuxUnlinkBinding } from './linux-rename-noreplace.ts';
import { linuxProcIdentity, type LinuxNativeOps } from './linux-native-backend.ts';
import type { LinuxModelOwner } from './linux-transaction-model.ts';
import {
    MAX_INSTALLATION_FILES,
    validateInstallationManifest,
    type InstallationManifest,
} from '../shared/installation.ts';

const artifact = 'app/resources/diagnostic_hub_rename_noreplace.node';
const limit = 32 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const nativeLoad = process.dlopen.bind(process);
const uid = process.getuid?.bind(process),
    euid = process.geteuid?.bind(process);
const monotonic = performance.now.bind(performance);
const later = setTimeout,
    cancel = clearTimeout;
const fs = Object.freeze({
    constants: Object.freeze({ ...physicalFS.constants }),
    openSync: physicalFS.openSync.bind(physicalFS),
    fstatSync: physicalFS.fstatSync.bind(physicalFS),
    lstatSync: physicalFS.lstatSync.bind(physicalFS),
    readSync: physicalFS.readSync.bind(physicalFS),
    writeSync: physicalFS.writeSync.bind(physicalFS),
    closeSync: physicalFS.closeSync.bind(physicalFS),
    ftruncateSync: physicalFS.ftruncateSync.bind(physicalFS),
    fsyncSync: physicalFS.fsyncSync.bind(physicalFS),
    mkdirSync: physicalFS.mkdirSync.bind(physicalFS),
    readlinkSync: physicalFS.readlinkSync.bind(physicalFS),
    realpathSync: physicalFS.realpathSync.bind(physicalFS),
    opendirSync: physicalFS.opendirSync.bind(physicalFS),
    statfsSync: physicalFS.statfsSync.bind(physicalFS),
});
interface Custody {
    fds: Set<number>;
    module: { exports: unknown } | null;
    original: Buffer | null;
    loadAttempted: boolean;
    loaded: boolean;
    failed: boolean;
    firstFailureSet: boolean;
    firstFailure: unknown;
    stage: string;
}
const retained = new Set<Custody>();
const failures = new WeakMap<object, Readonly<{ diagnostics: () => LinuxNativeHostDiagnostics }>>();
export interface LinuxNativeHostDiagnostics {
    stage: string;
    failed: boolean;
    loadAttempted: boolean;
    loaded: boolean;
    retainedFDs: number;
    retainedModule: boolean;
    retainedOriginalBytes: number;
    firstFailureRetained: boolean;
}
function normal(value: string) {
    return (
        typeof value === 'string' &&
        value.length > 1 &&
        value.length <= 4096 &&
        value.startsWith('/') &&
        path.posix.normalize(value) === value &&
        !/[\\\x00-\x1f\x7f]/.test(value)
    );
}
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value))
        throw Error('ERR_DH_LINUX_HOST_INPUT');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
        Reflect.ownKeys(value).length !== names.length ||
        names.some((name) => !descriptors[name] || !Object.hasOwn(descriptors[name], 'value'))
    )
        throw Error('ERR_DH_LINUX_HOST_INPUT');
    return Object.fromEntries(names.map((name) => [name, descriptors[name].value]));
}
function manifestSnapshot(value: InstallationManifest) {
    const record = fields(value, [
        'schemaVersion',
        'product',
        'layout',
        'platform',
        'arch',
        'version',
        'sourceCommit',
        'entryPoint',
        'files',
    ]);
    const source = record.files;
    if (types.isProxy(source) || !Array.isArray(source)) throw Error('ERR_DH_LINUX_HOST_INPUT');
    const length = Object.getOwnPropertyDescriptor(source, 'length')?.value as unknown;
    if (
        !Number.isSafeInteger(length) ||
        (length as number) < 1 ||
        (length as number) > MAX_INSTALLATION_FILES ||
        Reflect.ownKeys(source).length !== (length as number) + 1
    )
        throw Error('ERR_DH_LINUX_HOST_INPUT');
    const files = [];
    for (let i = 0; i < (length as number); ++i) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
            throw Error('ERR_DH_LINUX_HOST_INPUT');
        const item = descriptor.value as unknown;
        if (!item || typeof item !== 'object' || types.isProxy(item))
            throw Error('ERR_DH_LINUX_HOST_INPUT');
        const kind = Object.getOwnPropertyDescriptor(item, 'kind');
        if (!kind || !Object.hasOwn(kind, 'value')) throw Error('ERR_DH_LINUX_HOST_INPUT');
        files.push(
            fields(
                item,
                kind.value === 'file'
                    ? ['kind', 'path', 'bytes', 'sha256']
                    : ['kind', 'path', 'target'],
            ),
        );
    }
    return validateInstallationManifest({ ...record, files });
}
const same = (a: Stats, b: Stats) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink;
const stable = (a: Stats, b: Stats) =>
    same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Explicit load only. Selected bytes and process observations are not authenticated provenance. */
export async function createLinuxNativeHost(
    sourceRoot: string,
    input: InstallationManifest,
): Promise<{
    operations: LinuxNativeOps;
    owner: LinuxModelOwner;
    diagnostics: () => LinuxNativeHostDiagnostics;
}> {
    if (
        !normal(sourceRoot) ||
        process.platform !== 'linux' ||
        process.arch !== 'x64' ||
        !uid ||
        !euid
    )
        throw Error('ERR_DH_LINUX_HOST_RUNTIME');
    const manifest = manifestSnapshot(input);
    if (
        manifest.layout !== 'linux-folder' ||
        manifest.platform !== 'linux' ||
        manifest.arch !== 'x64'
    )
        throw Error('ERR_DH_LINUX_HOST_MANIFEST');
    const selected = manifest.files.find((file) => file.path === artifact);
    if (!selected || selected.kind !== 'file' || selected.bytes <= 0 || selected.bytes > limit)
        throw Error('ERR_DH_LINUX_HOST_ARTIFACT');
    const currentUID = uid(),
        currentEUID = euid(),
        pid = process.pid,
        executable = process.execPath;
    const napiVersion = Number(process.versions.napi);
    if (
        !Number.isSafeInteger(currentUID) ||
        currentUID <= 0 ||
        currentUID !== currentEUID ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        !normal(executable) ||
        !Number.isSafeInteger(napiVersion) ||
        napiVersion < 8
    )
        throw Error('ERR_DH_LINUX_HOST_RUNTIME');
    if (retained.size >= 32) throw Error('ERR_DH_LINUX_HOST_OWNER_LIMIT');
    const state: Custody = {
        fds: new Set(),
        module: null,
        original: null,
        loadAttempted: false,
        loaded: false,
        failed: false,
        firstFailureSet: false,
        firstFailure: undefined,
        stage: 'pin',
    };
    retained.add(state); // Adopt before the first open or native loader effect.
    const diagnostics = (): LinuxNativeHostDiagnostics =>
        Object.freeze({
            stage: state.stage,
            failed: state.failed,
            loadAttempted: state.loadAttempted,
            loaded: state.loaded,
            retainedFDs: state.fds.size,
            retainedModule: state.module !== null,
            retainedOriginalBytes: state.original?.length ?? 0,
            firstFailureRetained: state.firstFailureSet,
        });
    const custody = Object.freeze({ diagnostics });
    const C = fs.constants;
    const need = (yes: unknown, code: string) => {
        if (!yes) throw Error(code);
    };
    const open = (file: string, flags: number) => {
        const fd = fs.openSync(file, flags);
        state.fds.add(fd);
        return fd;
    };
    const close = (fd: number) => {
        fs.closeSync(fd);
        state.fds.delete(fd);
    };
    const read = (fd: number, maximum: number) => {
        const bytes = Buffer.alloc(maximum + 1);
        let used = 0;
        while (used < bytes.length) {
            const count = fs.readSync(fd, bytes, used, Math.min(65536, bytes.length - used), used);
            need(
                Number.isSafeInteger(count) &&
                    count >= 0 &&
                    count <= Math.min(65536, bytes.length - used),
                'ERR_DH_LINUX_HOST_READ',
            );
            if (!count) break;
            used += count;
        }
        need(used <= maximum, 'ERR_DH_LINUX_HOST_BOUND');
        return Buffer.from(bytes.subarray(0, used));
    };
    try {
        for (const name of ['O_NOFOLLOW', 'O_NONBLOCK', 'O_DIRECTORY'] as const)
            need(Number.isInteger(C[name]) && C[name] !== 0, 'ERR_DH_LINUX_HOST_FLAGS');
        const held: { fd: number; logical: string; stat: Stats }[] = [];
        let logical = '/',
            parent = open('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK);
        const add = (fd: number, filename: string) => {
            const stat = fs.fstatSync(fd);
            need(
                stat.isDirectory() &&
                    !stat.isSymbolicLink() &&
                    Number.isSafeInteger(stat.dev) &&
                    stat.dev >= 0 &&
                    Number.isSafeInteger(stat.ino) &&
                    stat.ino > 0 &&
                    (stat.uid === 0 || stat.uid === currentUID) &&
                    (stat.mode & 0o7022) === 0,
                'ERR_DH_LINUX_HOST_DIRECTORY',
            );
            held.push({ fd, logical: filename, stat });
        };
        add(parent, logical);
        for (const part of (sourceRoot + '/app/resources').split('/').filter(Boolean)) {
            logical = path.posix.join(logical, part);
            parent = open(
                '/proc/self/fd/' + parent + '/' + part,
                C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK,
            );
            add(parent, logical);
        }
        const checkParents = () => {
            for (const item of held)
                need(
                    same(item.stat, fs.lstatSync(item.logical)) &&
                        fs.realpathSync('/proc/self/fd/' + item.fd) === item.logical,
                    'ERR_DH_LINUX_HOST_PARENT_CHANGED',
                );
        };
        checkParents();
        const filename = sourceRoot + '/' + artifact;
        const fd = open(
            '/proc/self/fd/' + parent + '/diagnostic_hub_rename_noreplace.node',
            C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK,
        );
        const before = fs.fstatSync(fd);
        need(
            before.isFile() &&
                !before.isSymbolicLink() &&
                before.uid === currentUID &&
                before.nlink === 1 &&
                Number.isSafeInteger(before.dev) &&
                before.dev >= 0 &&
                Number.isSafeInteger(before.ino) &&
                before.ino > 0 &&
                (before.mode & 0o7022) === 0 &&
                before.size === selected.bytes,
            'ERR_DH_LINUX_HOST_FILE',
        );
        need(
            fs.realpathSync('/proc/self/fd/' + fd) === filename &&
                stable(before, fs.lstatSync(filename)),
            'ERR_DH_LINUX_HOST_FILE_CHANGED',
        );
        state.stage = 'hash';
        state.original = read(fd, selected.bytes);
        need(
            state.original.length === selected.bytes &&
                hash(state.original) === selected.sha256 &&
                stable(before, fs.fstatSync(fd)),
            'ERR_DH_LINUX_HOST_DIGEST',
        );
        state.stage = 'identity';
        const proc = open('/proc/self/stat', C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
        const identity = linuxProcIdentity(read(proc, 8192).toString('utf8'), pid);
        close(proc);
        need(
            identity.state !== 'Z' &&
                identity.state !== 'X' &&
                fs.readlinkSync('/proc/self/exe') === executable,
            'ERR_DH_LINUX_HOST_PROCESS',
        );
        const owner = Object.freeze({ pid, startTicks: identity.startTicks, executable });
        state.stage = 'load';
        checkParents();
        state.module = { exports: {} };
        state.loadAttempted = true;
        nativeLoad(
            state.module,
            '/proc/self/fd/' + fd,
            osConstants.dlopen.RTLD_NOW | osConstants.dlopen.RTLD_LOCAL,
        );
        state.loaded = true; // Retain the module before ABI or post-load checks.
        const moveNoReplace = checkedLinuxRenameBinding(state.module.exports, {
            platform: 'linux',
            arch: 'x64',
            napiVersion,
        });
        const unlinkOwned = checkedLinuxUnlinkBinding(state.module.exports, {
            platform: 'linux',
            arch: 'x64',
            napiVersion,
        });
        state.stage = 'readback';
        checkParents();
        need(
            stable(before, fs.fstatSync(fd)) &&
                stable(before, fs.lstatSync(filename)) &&
                fs.realpathSync('/proc/self/fd/' + fd) === filename &&
                hash(read(fd, selected.bytes)) === selected.sha256,
            'ERR_DH_LINUX_HOST_POSTLOAD_CHANGED',
        );
        // The binary FD and actual verified bytes stay owned with the loaded module.
        for (const item of held.reverse()) close(item.fd);
        const operations: LinuxNativeOps = Object.freeze({
            platform: 'linux',
            arch: 'x64',
            pid,
            executable,
            uid,
            euid,
            now: monotonic,
            uuid: randomUUID,
            fs,
            server: () => createServer({ pauseOnConnect: true, allowHalfOpen: false }),
            later: (callback: () => void, milliseconds: number) => later(callback, milliseconds),
            cancel,
            moveNoReplace,
            unlinkOwned,
        });
        state.stage = 'ready';
        return Object.freeze({ operations, owner, diagnostics });
    } catch (primary) {
        state.failed = true;
        if (!state.firstFailureSet) {
            state.firstFailureSet = true;
            state.firstFailure = primary;
        }
        const error = Error('ERR_DH_LINUX_NATIVE_HOST_RETAINED');
        failures.set(error, custody);
        throw error;
    }
}
/** Opaque retained custody only: no FD/module/native issuer, close, unload or retry method. */
export function linuxNativeHostFailureCustody(error: unknown) {
    return error && (typeof error === 'object' || typeof error === 'function')
        ? (failures.get(error) ?? null)
        : null;
}
