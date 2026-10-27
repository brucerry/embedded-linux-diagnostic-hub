import nativeFS from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateLinuxReviewCapability, assertLinuxReviewManifestEntry,
    LINUX_REVIEW_CAPABILITY } from './linux-review-package.mjs';
import { observeLinuxGzipTar, linuxObservationWindow } from './linux-archive-members.mjs';
import { validateLinuxObservationRecords, linuxObservationRecordPaths, assertLinuxObservedMembers, assertLinuxObservedDescriptor, normalizeLinuxPackagerCensus } from './linux-release-observation.ts';

const owners = new Set(); // Retain allocated paths/handles on uncertainty; no automatic cleanup.
const identityKeys = ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'];
/** Number Stats can establish identity only in the exactly representable integer domain. */
export function checkedLinuxEnvelopeIdentity(stat) {
    if (!stat || typeof stat !== 'object' || !Number.isSafeInteger(stat.dev) || stat.dev < 0 ||
        !Number.isSafeInteger(stat.ino) || stat.ino <= 0)
        throw Error('LINUX_ENVELOPE_IDENTITY');
    return stat;
}
export function sameLinuxEnvelopeFileIdentity(a, b) {
    checkedLinuxEnvelopeIdentity(a); checkedLinuxEnvelopeIdentity(b);
    return identityKeys.every(k => a[k] === b[k]);
}
export function sameLinuxEnvelopeDirectoryIdentity(a, b) {
    checkedLinuxEnvelopeIdentity(a); checkedLinuxEnvelopeIdentity(b);
    return ['dev', 'ino', 'uid', 'mode'].every(k => a[k] === b[k]);
}
export function cacheLinuxEnvelopeIdentity(cache, key, stat) {
    checkedLinuxEnvelopeIdentity(stat); // Refusal precedes even the cache.set submission.
    cache.set(key, stat);
}
const same = sameLinuxEnvelopeFileIdentity;
const dirSame = sameLinuxEnvelopeDirectoryIdentity;
const inside = (a, b) => a === b || b.startsWith(a + '/');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Concrete Node/Linux adapter. Construction has no filesystem/process-query/native-helper effects. */
export function createLinuxEnvelopeDisk() {
    const dirs = new Map(), sourceFiles = new Map(), handles = new Set(), allocated = new Set();
    const owner = { dirs, sourceFiles, handles, allocated, lastReturn: null, window: null };
    owners.add(owner);
    let identity = null, activeWindow = null;
    async function step(action, register = () => {}) {
        activeWindow?.check();
        try {
            const value = await action(); register(value);
            if (activeWindow) owner.lastReturn = value; // Private returned facts precede post-return gating.
            activeWindow?.check(); return value;
        } catch (error) { activeWindow?.stop(); throw error; }
    }
    function fileView(handle) {
        handles.add(handle);
        const view = {
            stat: () => step(() => handle.stat()),
            read: (...args) => step(() => handle.read(...args)),
            write: (...args) => step(() => handle.write(...args)),
            writeFile: (...args) => step(() => handle.writeFile(...args)),
            sync: () => step(() => handle.sync()), chmod: mode => step(() => handle.chmod(mode)),
            close: () => step(() => handle.close(), () => { handles.delete(handle); handles.delete(view); }),
        }; handles.add(view); return view;
    }
    function directoryView(handle) {
        handles.add(handle);
        const view = { read: () => step(() => handle.read()),
            close: () => step(() => handle.close(), () => { handles.delete(handle); handles.delete(view); }) };
        handles.add(view); return view;
    }
    const fs = {
        lstat: file => step(() => nativeFS.lstat(file)), realpath: file => step(() => nativeFS.realpath(file)),
        open: (...args) => step(async () => fileView(await nativeFS.open(...args))),
        opendir: file => step(async () => directoryView(await nativeFS.opendir(file))),
        mkdir: (file, options) => step(() => nativeFS.mkdir(file, options), () => allocated.add(file)),
    };
    const mode = stat => {
        checkedLinuxEnvelopeIdentity(stat);
        if (!Number.isSafeInteger(stat.mode) || stat.mode < 0 || stat.mode > 0o177777)
            throw Error('LINUX_ENVELOPE_MODE');
        return stat;
    };
    const snapshot = stat => {
        mode(stat);
        if (!Number.isSafeInteger(stat.uid) || stat.uid < 0 || !Number.isSafeInteger(stat.nlink) ||
            stat.nlink < 1 || !Number.isSafeInteger(stat.size) || stat.size < 0 ||
            !Number.isFinite(stat.mtimeMs) || !Number.isFinite(stat.ctimeMs)) throw Error('LINUX_ENVELOPE_STAT');
        const value = {};
        for (const key of identityKeys) value[key] = stat[key];
        return value;
    };
    function context(p) {
        if (activeWindow) throw Error('LINUX_ENVELOPE_OBSERVATION_BUSY');
        if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.electron ||
            !process.getuid || !process.geteuid || process.getuid() !== p.uid ||
            process.geteuid() !== p.uid || p.uid <= 0) throw Error('LINUX_ENVELOPE_RUNTIME');
        const current = JSON.stringify([p.uid, p.home, p.sourceRoot, p.outputRoot, p.archivePath,
            p.inventorySHA256, p.archive.bytes, p.archive.sha256, p.descriptorSHA256]);
        if (identity !== null && identity !== current) throw Error('LINUX_ENVELOPE_CONTEXT');
        identity = current;
    }
    async function node(file) {
        try { return checkedLinuxEnvelopeIdentity(await fs.lstat(file)); }
        catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    }
    async function ancestors(p, directory) {
        let cursor = '';
        for (const part of directory.split('/').filter(Boolean)) {
            cursor += '/' + part;
            const stat = mode(await fs.lstat(cursor));
            if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7022) ||
                (inside(p.home, cursor) ? stat.uid !== p.uid : stat.uid !== p.uid && stat.uid !== 0) ||
                await fs.realpath(cursor) !== cursor || dirs.has(cursor) && !dirSame(dirs.get(cursor), stat))
                throw Error('LINUX_ENVELOPE_DIRECTORY');
            cacheLinuxEnvelopeIdentity(dirs, cursor, stat);
        }
    }
    function regular(stat, expected, p) {
        mode(stat);
        if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== p.uid ||
            stat.nlink !== 1 || (stat.mode & 0o7022) || !Number.isSafeInteger(stat.size) ||
            stat.size !== expected.bytes || expected.mode !== undefined && (stat.mode & 0o7777) !== expected.mode)
            throw Error('LINUX_ENVELOPE_FILE');
    }
    async function opened(file, flags, mode) {
        const handle = await fs.open(file, flags, mode); handles.add(handle); return handle;
    }
    async function closed(handle) { await handle.close(); handles.delete(handle); }
    async function digest(p, file, expected, destination = null) {
        await ancestors(p, path.posix.dirname(file));
        const before = checkedLinuxEnvelopeIdentity(await fs.lstat(file)); regular(before, expected, p);
        if (sourceFiles.has(file) && !same(sourceFiles.get(file), before)) throw Error('LINUX_ENVELOPE_INPUT_CHANGED');
        const handle = await opened(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let output = null, observedSHA256 = null;
        try {
            if (!same(before, await handle.stat())) throw Error('LINUX_ENVELOPE_FILE_CHANGED');
            if (destination) {
                await ancestors(p, path.posix.dirname(destination));
                output = await opened(destination, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
                    constants.O_NOFOLLOW | constants.O_NONBLOCK, expected.mode);
                allocated.add(destination);
                await output.chmod(expected.mode); // Only the newly created owned file, never an input.
            }
            const buffer = Buffer.alloc(65536), checksum = createHash('sha256'); let total = 0;
            for (;;) {
                const { bytesRead } = await handle.read(buffer, 0,
                    Math.min(buffer.length, expected.bytes - total + 1), total);
                if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length)
                    throw Error('LINUX_ENVELOPE_READ');
                if (!bytesRead) break;
                if (total + bytesRead > expected.bytes) throw Error('LINUX_ENVELOPE_LENGTH');
                checksum.update(buffer.subarray(0, bytesRead));
                if (output) {
                    let count = 0;
                    while (count < bytesRead) {
                        const part = await output.write(buffer, count, bytesRead - count, total + count);
                        if (!Number.isSafeInteger(part.bytesWritten) || part.bytesWritten < 1 ||
                            part.bytesWritten > bytesRead - count) throw Error('LINUX_ENVELOPE_WRITE');
                        count += part.bytesWritten;
                    }
                }
                total += bytesRead;
            }
            observedSHA256 = checksum.digest('hex');
            if (total !== expected.bytes || observedSHA256 !== expected.sha256 ||
                !same(before, await handle.stat()) || !same(before, await fs.lstat(file)))
                throw Error('LINUX_ENVELOPE_INTEGRITY');
            await ancestors(p, path.posix.dirname(file));
            if (!inside(p.outputRoot, file)) cacheLinuxEnvelopeIdentity(sourceFiles, file, before);
            if (output) {
                await output.sync(); regular(await output.stat(), expected, p);
                if (!same(await output.stat(), await fs.lstat(destination))) throw Error('LINUX_ENVELOPE_OUTPUT_CHANGED');
            }
        } finally {
            if (output) await closed(output);
            await closed(handle);
        }
        if (destination) await digest(p, destination, expected);
        return { bytes: before.size, sha256: observedSHA256, mode: before.mode & 0o777, identity: snapshot(before) };
    }
    async function names(p, directory, expected) {
        await ancestors(p, directory);
        const dir = await fs.opendir(directory); handles.add(dir); const found = [];
        try {
            for (;;) {
                const next = await dir.read(); if (!next) break;
                found.push(next.name);
                if (found.length > expected.length) throw Error('LINUX_ENVELOPE_EXTRA_CONTENT');
            }
        } finally { await dir.close(); handles.delete(dir); }
        if (JSON.stringify(found.sort()) !== JSON.stringify([...expected].sort()))
            throw Error('LINUX_ENVELOPE_INVENTORY_CHANGED');
        await ancestors(p, directory);
    }
    async function tree(p, base) {
        const entries = [], identities = [];
        const children = new Map([['', new Set()]]);
        for (const file of p.files) {
            const parts = file.path.split('/'); let directory = '';
            for (let at = 0; at < parts.length; at++) {
                if (!children.has(directory)) children.set(directory, new Set());
                children.get(directory).add(parts[at]);
                if (at + 1 < parts.length) directory = directory ? directory + '/' + parts[at] : parts[at];
            }
        }
        for (const directory of ['', ...p.directories]) {
            const full = directory ? path.posix.join(base, directory) : base;
            await names(p, full, [...children.get(directory)]);
            const observed = mode(await fs.lstat(full)); identities.push({ path: full, identity: snapshot(observed) });
            if (directory) entries.push({ kind: 'directory', path: directory, mode: observed.mode & 0o777 });
        }
        for (const file of p.files) {
            const full = path.posix.join(base, file.path), observed = await digest(p, full, file);
            entries.push({ kind: 'file', path: file.path, bytes: observed.bytes, sha256: observed.sha256, mode: observed.mode });
            identities.push({ path: full, identity: observed.identity });
        }
        entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        return { entries, identities };
    }
    async function small(p, file, limit, mode = undefined) {
        await ancestors(p, path.posix.dirname(file)); const before = checkedLinuxEnvelopeIdentity(await fs.lstat(file));
        if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > limit)
            throw Error('LINUX_ENVELOPE_CONTROL_CAP');
        regular(before, { bytes: before.size, mode }, p);
        const handle = await opened(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            if (!same(before, await handle.stat())) throw Error('LINUX_ENVELOPE_CONTROL_CHANGED');
            const bytes = Buffer.alloc(before.size + 1); let count = 0;
            while (count < bytes.length) {
                const part = await handle.read(bytes, count, bytes.length - count, count);
                if (!part.bytesRead) break; count += part.bytesRead;
            }
            if (count !== before.size || !same(before, await handle.stat()) || !same(before, await fs.lstat(file)))
                throw Error('LINUX_ENVELOPE_CONTROL_CHANGED');
            return bytes.subarray(0, count);
        } finally { await closed(handle); }
    }
    async function payloadIdentity(p, base = p.sourceRoot) {
        const executable = path.posix.join(base, 'diagnostic-hub');
        const expected = p.files.find(f => f.path === 'diagnostic-hub');
        const before = checkedLinuxEnvelopeIdentity(await fs.lstat(executable)); regular(before, expected, p);
        const handle = await opened(executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const head = Buffer.alloc(20), { bytesRead } = await handle.read(head, 0, head.length, 0);
            if (bytesRead !== 20 || head.subarray(0, 4).toString() !== '\x7fELF' || head[4] !== 2 ||
                head[5] !== 1 || head.readUInt16LE(18) !== 62 ||
                !same(before, await handle.stat()) || !same(before, await fs.lstat(executable)))
                throw Error('LINUX_ENVELOPE_ELF');
        } finally { await closed(handle); }
        const asar = path.posix.join(base, 'resources/app.asar');
        const asarBefore = checkedLinuxEnvelopeIdentity(await fs.lstat(asar));
        const { extractFile } = await step(() => import('@electron/asar')); // Data-only; no app/binary invocation.
        const packageBytes = await step(() => extractFile(asar, 'package.json'));
        if (packageBytes.length > 65536) throw Error('LINUX_ENVELOPE_PACKAGE_CAP');
        const pkg = JSON.parse(packageBytes.toString('utf8'));
        if (pkg.name !== 'embedded-linux-diagnostic-hub' || pkg.version !== p.version ||
            !same(asarBefore, await fs.lstat(asar))) throw Error('LINUX_ENVELOPE_PRODUCT_VERSION');
        const capability = validateLinuxReviewCapability(JSON.parse((await small(p,
            path.posix.join(base, LINUX_REVIEW_CAPABILITY.slice(4)), 4096, 0o600)).toString('utf8')), p.version);
        assertLinuxReviewManifestEntry(p.manifest.files, capability);
    }
    return {
        async observeBinding(p, records, requestedWindow) {
            p = structuredClone(p); records = structuredClone(records);
            const window = linuxObservationWindow(requestedWindow); window.check(); context(p);
            activeWindow = window; owner.window = window;
            let stage = 'records';
            try {
                const selectedPaths = linuxObservationRecordPaths(records);
                const primaryPath = selectedPaths.primaryPath, buildPath = selectedPaths.buildPath;
                for (const file of [primaryPath, buildPath]) {
                    if (typeof file !== 'string' || file.length > 240 || path.posix.normalize(file) !== file ||
                        !file.startsWith(p.home + '/') || /[\\\x00-\x1f\x7f]/.test(file) ||
                        inside(p.sourceRoot, file) || inside(p.outputRoot, file) || file === p.archivePath)
                        throw Error('LINUX_OBSERVATION_RECORD_PATH');
                    await ancestors(p, path.posix.dirname(file));
                }
                if (primaryPath === buildPath) throw Error('LINUX_OBSERVATION_RECORD_PATH');
                const rb = mode(await fs.lstat(primaryPath)), bb = mode(await fs.lstat(buildPath));
                const releaseBytes = await small(p, primaryPath, 65536), buildBytes = await small(p, buildPath, 65536);
                if (!same(rb, await fs.lstat(primaryPath)) || !same(bb, await fs.lstat(buildPath)))
                    throw Error('LINUX_OBSERVATION_RECORD_CHANGED');
                const selected = validateLinuxObservationRecords(p, selectedPaths.selection, releaseBytes, buildBytes);
                stage = 'archive'; await ancestors(p, path.posix.dirname(p.archivePath));
                const before = mode(await fs.lstat(p.archivePath)); regular(before, p.archive, p);
                const handle = await opened(p.archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                if (!same(before, await handle.stat())) throw Error('LINUX_OBSERVATION_ARCHIVE_CHANGED');
                async function* chunks() {
                    const buffer = Buffer.alloc(65536); let position = 0;
                    for (;;) {
                        window.check();
                        const read = await handle.read(buffer, 0, Math.min(buffer.length, p.archive.bytes - position + 1), position);
                        if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead < 0 || read.bytesRead > buffer.length)
                            throw Error('LINUX_OBSERVATION_READ');
                        if (!read.bytesRead) return;
                        position += read.bytesRead; yield Buffer.from(buffer.subarray(0, read.bytesRead));
                    }
                }
                const census = await observeLinuxGzipTar(chunks(), p.archive, window);
                const after = mode(await handle.stat());
                if (!same(before, after) || !same(before, await fs.lstat(p.archivePath))) throw Error('LINUX_OBSERVATION_ARCHIVE_CHANGED');
                await closed(handle); // Success only; uncertain stream paths keep their registered handle.
                const mapped = normalizeLinuxPackagerCensus(census, p.archive.asset);
                assertLinuxObservedMembers(p, mapped.payloadEntries);
                stage = 'tree'; const base = path.posix.join(p.outputRoot, 'app');
                await ancestors(p, base); const treeBefore = mode(await fs.lstat(base));
                const observedTree = await tree(p, base), treeAfter = mode(await fs.lstat(base));
                if (!same(treeBefore, treeAfter)) throw Error('LINUX_OBSERVATION_TREE_CHANGED');
                assertLinuxObservedMembers(p, observedTree.entries);
                await payloadIdentity(p, base); // Actual prepared ELF/product/version/capability, never execution.
                stage = 'descriptor'; const descriptorPath = path.posix.join(p.outputRoot, 'diagnostic-hub-setup-payload.json');
                const descriptorBefore = mode(await fs.lstat(descriptorPath));
                const descriptor = await small(p, descriptorPath, 4 * 1024 * 1024, 0o600);
                const descriptorAfter = mode(await fs.lstat(descriptorPath));
                if (!same(descriptorBefore, descriptorAfter)) throw Error('LINUX_OBSERVATION_DESCRIPTOR_CHANGED');
                assertLinuxObservedDescriptor(p, descriptor);
                stage = 'recheck';
                for (const item of [...observedTree.identities, { path: p.archivePath, identity: snapshot(before) },
                    { path: descriptorPath, identity: snapshot(descriptorBefore) },
                    { path: primaryPath, identity: snapshot(rb) }, { path: buildPath, identity: snapshot(bb) }]) {
                    await ancestors(p, path.posix.dirname(item.path));
                    if (!same(item.identity, mode(await fs.lstat(item.path)))) throw Error('LINUX_OBSERVATION_LATE_CHANGE');
                }
                const observation = { schema: 1, requestId: window.requestId, observedMs: window.check(),
                    archive: { path: p.archivePath, bytes: census.compressedBytes, sha256: census.compressedSHA256,
                        before: snapshot(before), after: snapshot(after), entries: mapped.payloadEntries },
                    tree: { root: base, before: snapshot(treeBefore), after: snapshot(treeAfter), entries: observedTree.entries },
                    descriptor: { path: descriptorPath, text: descriptor.toString('utf8'),
                        before: snapshot(descriptorBefore), after: snapshot(descriptorAfter) } };
                const evidence = { observation, archiveMapping: mapped, selectedRecords: { ...selected,
                    [selectedPaths.primaryKind]: { path: primaryPath, identity: snapshot(rb) }, build: { path: buildPath, identity: snapshot(bb) } } };
                const serialized = Buffer.from(JSON.stringify(evidence));
                if (serialized.length > 4 * 1024 * 1024) throw Error('LINUX_OBSERVATION_CONTROL_CAP');
                const summary = { status: 'observed-members-unqualified', requestId: window.requestId,
                    observedMs: observation.observedMs, archiveSHA256: census.compressedSHA256,
                    archiveBytes: census.compressedBytes, expandedBytes: census.expandedBytes,
                    files: census.files, directories: census.directories, payloadDirectories: mapped.directories,
                    archiveRoot: mapped.rootName, actualEntriesSHA256: mapped.actualEntriesSHA256,
                    payloadEntriesSHA256: mapped.payloadEntriesSHA256, payloadBytes: census.payloadBytes,
                    descriptorSHA256: p.descriptorSHA256, evidenceSHA256: hash(serialized), evidenceBytes: serialized.length,
                    ...(selectedPaths.primaryKind === 'source' ? { sourceRecordSHA256: selected.sourceRecordSHA256 } :
                        { releaseRecordSHA256: selected.releaseRecordSHA256 }), buildRecordSHA256: selected.buildRecordSHA256,
                    handoffAllowed: false, qualification: 'unqualified', mutation: false, nativeBinding: false };
                if (Buffer.byteLength(JSON.stringify(summary)) > 8192) throw Error('LINUX_OBSERVATION_SUMMARY_CAP');
                window.check(); activeWindow = null; owner.window = null;
                return { summary, evidence };
            } catch {
                window.stop(); // Freeze this adapter; no further IO/close/retry/cleanup on an uncertain owner.
                return { summary: { status: 'unknown', stage, retained: true, handoffAllowed: false,
                    qualification: 'unqualified', mutation: false, nativeBinding: false } };
            }
        },
        async admit(p) {
            context(p); await ancestors(p, p.home); await ancestors(p, p.sourceRoot);
            await ancestors(p, path.posix.dirname(p.outputRoot));
            await ancestors(p, path.posix.dirname(p.archivePath));
            if (await node(p.outputRoot)) throw Error('LINUX_ENVELOPE_OUTPUT_EXISTS');
        },
        async verifyInput(p) {
            context(p); await digest(p, p.archivePath, p.archive); await tree(p, p.sourceRoot);
            await payloadIdentity(p);
        },
        async createRoot(p) {
            context(p); await ancestors(p, path.posix.dirname(p.outputRoot));
            await fs.mkdir(p.outputRoot, { mode: 0o700 }); allocated.add(p.outputRoot);
            await ancestors(p, p.outputRoot);
            for (const relative of ['app', ...p.directories.map(d => 'app/' + d)
                .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))]) {
                const directory = path.posix.join(p.outputRoot, relative);
                await ancestors(p, path.posix.dirname(directory));
                await fs.mkdir(directory, { mode: 0o700 }); allocated.add(directory);
                await ancestors(p, directory);
            }
        },
        async copyFile(p, file) {
            context(p); await digest(p, path.posix.join(p.sourceRoot, file.path), file,
                path.posix.join(p.outputRoot, 'app', file.path));
        },
        async writeDescriptor(p, bytes) {
            context(p); if (bytes.toString('utf8') !== p.descriptor || hash(bytes) !== p.descriptorSHA256)
                throw Error('LINUX_ENVELOPE_DESCRIPTOR');
            await ancestors(p, p.outputRoot);
            const file = path.posix.join(p.outputRoot, 'diagnostic-hub-setup-payload.json');
            const handle = await opened(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
                constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); allocated.add(file);
            try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); }
            finally { await closed(handle); }
            const observed = await small(p, file, 4 * 1024 * 1024, 0o600);
            if (!observed.equals(bytes)) throw Error('LINUX_ENVELOPE_DESCRIPTOR_READBACK');
            return { bytes: observed.length, sha256: hash(observed) };
        },
        async verifyOutput(p) {
            context(p); await names(p, p.outputRoot, ['app', 'diagnostic-hub-setup-payload.json']);
            await tree(p, path.posix.join(p.outputRoot, 'app'));
            const bytes = await small(p, path.posix.join(p.outputRoot, 'diagnostic-hub-setup-payload.json'), 4 * 1024 * 1024, 0o600);
            if (bytes.toString('utf8') !== p.descriptor || hash(bytes) !== p.descriptorSHA256)
                throw Error('LINUX_ENVELOPE_DESCRIPTOR_CHANGED');
        },
    };
}
