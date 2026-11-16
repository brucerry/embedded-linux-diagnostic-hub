import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    MAC_NODE_CACHE_VERSIONS,
    macNodeCacheLayout,
    resolveMacNodeCache,
} from './macos-node-cache.mjs';

const fields = ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const codes = new Set([
    'context',
    'path',
    'unsafe',
    'incomplete',
    'architecture',
    'changed',
    'read-failed',
    'scope',
    'budget',
    'dependency',
    'short-read',
    'closure-unknown',
    'stopped',
]);
class MetadataFailure extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const fail = (code) => {
    throw new MetadataFailure(code);
};
const codeOf = (error) =>
    error instanceof MetadataFailure && codes.has(error.code) ? error.code : 'read-failed';
const nativeIO = Object.freeze({
    constants: fs.constants,
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync.native,
    accessSync: fs.accessSync,
    openSync: fs.openSync,
    fstatSync: fs.fstatSync,
    readSync: fs.readSync,
    closeSync: fs.closeSync,
});
// Process-local custody only; no finalizer, release API or retry. A caller must
// preserve unknown-custody reports across process/job boundaries itself.
const nativeHeldReaders = new Set();
function metadata(stat) {
    if (!stat) return null;
    const result = {
        kind: stat.isSymbolicLink()
            ? 'link'
            : stat.isDirectory()
              ? 'directory'
              : stat.isFile()
                ? 'file'
                : 'special',
    };
    for (const field of fields) {
        if (typeof stat[field] !== 'bigint') fail('unsafe');
        result[field] = stat[field];
    }
    return result;
}
const same = (a, b) => a?.kind === b?.kind && fields.every((field) => a?.[field] === b?.[field]);

/** A bounded read mechanism, not an identity or qualification issuer. Explicit
 * identity/IO inputs support inert tests; only inspectMacCacheMetadata binds real
 * host inputs. No method accepts paths outside this exact derived layout.
 * Path snapshots are not atomic dirfd traversal or a hard wall-clock deadline.
 * Unknown close custody stays private, freezes IO and is never retried/finalized.
 * Low-level callers own this returned reader and must retain it on unknown close. */
export function createMacCacheMetadataPorts(config, identity, io = nativeIO) {
    const boundIdentity = {
        platform: identity.platform,
        arch: identity.arch,
        uid: identity.uid,
        euid: identity.euid,
    };
    if (!Number.isSafeInteger(boundIdentity.uid) || boundIdentity.uid < 0) fail('context');
    let layout;
    try {
        layout = macNodeCacheLayout(config);
    } catch {
        fail('path');
    }
    const allowed = new Set([...layout.directories, layout.marker, layout.executable]),
        first = new Map(),
        held = [],
        owner = BigInt(boundIdentity.uid),
        constants = io.constants;
    if (
        !Number.isInteger(constants?.O_RDONLY) ||
        !Number.isInteger(constants?.O_NOFOLLOW) ||
        constants.O_NOFOLLOW <= 0 ||
        !Number.isInteger(constants?.O_NONBLOCK) ||
        constants.O_NONBLOCK <= 0 ||
        !Number.isInteger(constants?.X_OK)
    )
        fail('dependency');
    const state = {
        filesystemCalls: 0,
        opened: 0,
        closed: 0,
        confirmedBytes: 0,
        retainedUnknown: 0,
        failureCode: null,
        failurePhase: null,
        closeFailed: false,
    };
    let stopped = false,
        requested = false,
        phase = 'metadata',
        privatePrimary;
    function call(name, ...args) {
        if (state.filesystemCalls >= 4096) fail('budget');
        state.filesystemCalls++;
        return io[name](...args);
    }
    function bounded(file) {
        if (typeof file !== 'string' || !allowed.has(file)) fail('scope');
    }
    function safe(value, kind) {
        if (!value) fail('incomplete');
        if (
            value.kind !== kind ||
            (value.uid !== 0n && value.uid !== owner) ||
            value.dev < 0n ||
            value.ino <= 0n ||
            value.mode < 0n ||
            (value.mode & 0o7022n) !== 0n ||
            value.nlink <= 0n ||
            value.size < 0n ||
            (kind === 'file' && value.nlink !== 1n)
        )
            fail('unsafe');
    }
    function stat(file) {
        bounded(file);
        const value = metadata(call('lstatSync', file, { bigint: true, throwIfNoEntry: false }));
        if (first.has(file) && !same(first.get(file), value)) fail('changed');
        if (value) first.set(file, { ...value });
        return value;
    }
    function parents(file) {
        bounded(file);
        for (const directory of layout.directories) {
            if (directory === file || !file.startsWith(directory === '/' ? '/' : directory + '/'))
                break;
            const value = stat(directory);
            safe(value, 'directory');
            if (directory === layout.home && value.uid !== owner) fail('unsafe');
            if (call('realpathSync', directory) !== directory) fail('path');
        }
    }
    function guard(file) {
        parents(file);
        const value = stat(file);
        safe(value, layout.directories.includes(file) ? 'directory' : 'file');
        if (file === layout.home && value.uid !== owner) fail('unsafe');
        if (call('realpathSync', file) !== file) fail('path');
        return value;
    }
    function run(action) {
        if (stopped) fail('stopped');
        try {
            return action();
        } catch (error) {
            stopped = true;
            if (state.failureCode === null) privatePrimary = error;
            state.failureCode ??= codeOf(error);
            state.failurePhase ??= phase;
            throw new MetadataFailure(state.failureCode);
        }
    }
    const ports = {
        identity: () => ({ ...boundIdentity }),
        lstat: (file) =>
            run(() => {
                phase = 'metadata';
                parents(file);
                return stat(file);
            }),
        realpath: (file) =>
            run(() => {
                phase = 'metadata';
                guard(file);
                return file;
            }),
        executable: (file) =>
            run(() => {
                phase = 'metadata';
                if (file !== layout.executable) fail('scope');
                guard(file);
                try {
                    call('accessSync', file, constants.X_OK);
                    return true;
                } catch (error) {
                    if (error instanceof MetadataFailure) throw error;
                    return false;
                }
            }),
        readHeader: (file, count) =>
            run(() => {
                if (file !== layout.executable || count !== 32 || requested) fail('scope');
                requested = true;
                phase = 'metadata';
                const before = guard(file);
                if (before.size < 32n) fail('short-read');
                let fd = null,
                    primaryThrown = false,
                    primary,
                    primaryPhase,
                    closeThrown = false,
                    closeError;
                const buffer = Buffer.alloc(32);
                try {
                    phase = 'open';
                    fd = call(
                        'openSync',
                        file,
                        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                    );
                    if (!Number.isSafeInteger(fd) || fd < 0) fail('dependency');
                    state.opened++;
                    phase = 'fstat';
                    if (!same(before, metadata(call('fstatSync', fd, { bigint: true }))))
                        fail('changed');
                    for (let offset = 0; offset < 32;) {
                        phase = 'read';
                        const size = call('readSync', fd, buffer, offset, 32 - offset, offset);
                        if (!Number.isInteger(size) || size <= 0 || size > 32 - offset)
                            fail('short-read');
                        offset += size;
                        state.confirmedBytes += size;
                    }
                    phase = 'fstat';
                    if (!same(before, metadata(call('fstatSync', fd, { bigint: true }))))
                        fail('changed');
                    phase = 'metadata';
                    if (!same(before, guard(file))) fail('changed');
                } catch (error) {
                    primaryThrown = true;
                    primary = error;
                    primaryPhase = phase;
                } finally {
                    if (fd !== null && Number.isSafeInteger(fd) && fd >= 0) {
                        try {
                            // An owned close is attempted once even after a read budget failure.
                            state.filesystemCalls++;
                            if (io.closeSync(fd) !== undefined) fail('closure-unknown');
                            state.closed++;
                        } catch (error) {
                            closeThrown = true;
                            closeError = error;
                            held.push({ fd, primaryThrown, primary, closeError });
                            state.retainedUnknown++;
                            state.closeFailed = true;
                            stopped = true;
                        }
                    }
                }
                if (primaryThrown || closeThrown) {
                    privatePrimary = primaryThrown ? primary : closeError;
                    state.failureCode = primaryThrown ? codeOf(primary) : 'closure-unknown';
                    state.failurePhase = primaryThrown ? primaryPhase : 'close';
                    throw new MetadataFailure(state.failureCode);
                }
                return buffer;
            }),
    };
    return { ports, observe: () => ({ ...state }) };
}

// Safe observation only: paths, UID values, fd numbers, causes and candidate bytes
// are never serialized. This function does not authenticate caller-supplied data.
export function summarizeMacCacheMetadata(result, custody) {
    const clean = {
        filesystemCalls: custody?.filesystemCalls,
        opened: custody?.opened,
        closed: custody?.closed,
        confirmedBytes: custody?.confirmedBytes,
        retainedUnknown: custody?.retainedUnknown,
        closeFailed: custody?.closeFailed,
    };
    const valid =
        ['filesystemCalls', 'opened', 'closed', 'confirmedBytes', 'retainedUnknown'].every(
            (key) => Number.isSafeInteger(clean[key]) && clean[key] >= 0,
        ) &&
        clean.opened <= 1 &&
        clean.closed <= clean.opened &&
        clean.retainedUnknown === clean.opened - clean.closed &&
        clean.confirmedBytes <= 32 &&
        clean.filesystemCalls <= 4097 &&
        typeof clean.closeFailed === 'boolean';
    const base = {
        nativeQualification: false,
        releaseAcceptance: false,
        binaryAuthenticated: false,
        actualRuntimeVersion: 'unverified',
        hostedProvenance: 'unverified',
    };
    if (!valid) return { status: 'REFUSED', reason: 'read-failed', ...base };
    const failed = custody.failureCode !== null || clean.retainedUnknown > 0;
    const candidate =
        !failed &&
        clean.opened === 1 &&
        clean.closed === 1 &&
        clean.confirmedBytes === 32 &&
        !clean.closeFailed &&
        result?.status === 'CACHE_METADATA_CANDIDATE' &&
        ['x64', 'arm64'].includes(result.expectedArchitecture) &&
        result.expectedVersion === MAC_NODE_CACHE_VERSIONS[result.expectedArchitecture] &&
        result.actualRuntimeVersion === 'unverified' &&
        result.nativeQualification === false &&
        result.releaseAcceptance === false;
    const reason = failed
        ? codes.has(custody.failureCode)
            ? custody.failureCode
            : clean.retainedUnknown > 0
              ? 'closure-unknown'
              : 'read-failed'
        : result?.status === 'REFUSED' && codes.has(result.reason)
          ? result.reason
          : 'read-failed';
    return {
        status: candidate ? 'CACHE_METADATA_CANDIDATE' : 'REFUSED',
        reason: candidate ? 'none' : reason,
        resources: clean,
        ...base,
    };
}

// Explicit opt-in only. No CLI entry, settings write, action or child process.
export function inspectMacCacheMetadata(expectedArch) {
    const empty = {
        filesystemCalls: 0,
        opened: 0,
        closed: 0,
        confirmedBytes: 0,
        retainedUnknown: 0,
        failureCode: null,
        failurePhase: null,
        closeFailed: false,
    };
    let reader;
    function observation(result) {
        const custody = reader?.observe() ?? empty;
        if (custody.retainedUnknown > 0) nativeHeldReaders.add(reader);
        return summarizeMacCacheMetadata(result, custody);
    }
    try {
        if (nativeHeldReaders.size) {
            const held = nativeHeldReaders.values().next().value;
            return summarizeMacCacheMetadata(
                { status: 'REFUSED', reason: 'stopped' },
                held.observe(),
            );
        }
        const identity = {
            platform: process.platform,
            arch: process.arch,
            uid: process.getuid?.(),
            euid: process.geteuid?.(),
        };
        if (
            identity.platform !== 'darwin' ||
            !['x64', 'arm64'].includes(expectedArch) ||
            identity.arch !== expectedArch ||
            !Number.isSafeInteger(identity.uid) ||
            identity.uid <= 0 ||
            identity.euid !== identity.uid
        )
            fail('context');
        const account = os.userInfo(),
            home = account.homedir;
        if (account.uid !== identity.uid || process.env.HOME !== home) fail('context');
        const config = {
            arch: expectedArch,
            home,
            cacheRoot: process.env.RUNNER_TOOL_CACHE,
            agentRoot: process.env.AGENT_TOOLSDIRECTORY,
        };
        reader = createMacCacheMetadataPorts(config, identity);
        return observation(resolveMacNodeCache(config, reader.ports));
    } catch (error) {
        return observation({ status: 'REFUSED', reason: codeOf(error) });
    }
}
