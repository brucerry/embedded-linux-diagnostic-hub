import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

export const MAC_PAYLOAD_LIMITS = Object.freeze({
    entries: 16384,
    fileBytes: 512 * 1024 ** 2,
    archiveBytes: 1024 ** 3,
    totalBytes: 2 * 1024 ** 3,
    chunkBytes: 65536,
    pathBytes: 1024,
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keys = (value, fields) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
};
function relative(value) {
    assert.ok(
        typeof value === 'string' &&
            value &&
            Buffer.byteLength(value) <= MAC_PAYLOAD_LIMITS.pathBytes,
    );
    assert.ok(!/[\\\x00-\x1f\x7f]/.test(value));
    assert.equal(path.posix.normalize(value), value);
    assert.ok(
        !path.posix.isAbsolute(value) &&
            value.split('/').every((p) => p && p !== '.' && p !== '..'),
    );
    return value;
}
/** Canonical file data, permissions and link targets. Excludes xattrs/resource forks,
 * ACLs, signatures, filesystem race protection, runtime identity and qualification. */
export function macPayloadIdentity(input) {
    const rows = structuredClone(input);
    assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= MAC_PAYLOAD_LIMITS.entries);
    const byPath = new Map(),
        folded = new Set();
    let bytes = 0,
        files = 0;
    for (const item of rows) {
        relative(item.path);
        const key = item.path.normalize('NFC').toLowerCase();
        assert.ok(!folded.has(key), 'Ambiguous Mac payload path.');
        folded.add(key);
        let row = { path: item.path, kind: item.kind };
        if (item.kind === 'file') {
            keys(item, ['path', 'kind', 'mode', 'bytes', 'sha256']);
            assert.ok(
                Number.isSafeInteger(item.bytes) &&
                    item.bytes >= 0 &&
                    item.bytes <= MAC_PAYLOAD_LIMITS.fileBytes,
            );
            assert.match(item.sha256, /^[a-f0-9]{64}$/);
            Object.assign(row, { bytes: item.bytes, sha256: item.sha256, mode: item.mode });
            files++;
            bytes += item.bytes;
            assert.ok(bytes <= MAC_PAYLOAD_LIMITS.totalBytes);
        } else if (item.kind === 'directory') {
            keys(item, ['path', 'kind', 'mode']);
            row.mode = item.mode;
        } else {
            assert.equal(item.kind, 'symlink');
            keys(item, ['path', 'kind', 'target']);
            assert.ok(
                typeof item.target === 'string' &&
                    item.target &&
                    Buffer.byteLength(item.target) <= MAC_PAYLOAD_LIMITS.pathBytes &&
                    !path.posix.isAbsolute(item.target) &&
                    !/[\\\x00-\x1f\x7f]/.test(item.target),
            );
            const to = path.posix.normalize(
                path.posix.join(path.posix.dirname(item.path), item.target),
            );
            assert.ok(to !== '..' && !to.startsWith('../'));
            row.target = item.target;
        }
        if (item.kind !== 'symlink')
            assert.ok(Number.isInteger(item.mode) && item.mode >= 0 && item.mode <= 0o777);
        byPath.set(item.path, row);
    }
    for (const name of byPath.keys()) {
        let parent = path.posix.dirname(name);
        while (parent !== '.') {
            assert.equal(
                byPath.get(parent)?.kind,
                'directory',
                'Complete explicit directory inventory required.',
            );
            parent = path.posix.dirname(parent);
        }
    }
    for (const name of [
        'Contents/Info.plist',
        'Contents/Resources/app.asar',
        'Contents/MacOS/Diagnostic Hub',
    ])
        assert.equal(byPath.get(name)?.kind, 'file');
    assert.ok((byPath.get('Contents/MacOS/Diagnostic Hub').mode & 0o100) !== 0);
    const canonical = [...byPath.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    return Object.freeze({
        schemaVersion: 1,
        inventorySHA256: hash(JSON.stringify(canonical) + '\n'),
        entries: canonical.length,
        files,
        bytes,
        executableSHA256: byPath.get('Contents/MacOS/Diagnostic Hub').sha256,
        asarSHA256: byPath.get('Contents/Resources/app.asar').sha256,
    });
}
export function validateMacPayloadIdentity(actual, expected) {
    keys(actual, [
        'schemaVersion',
        'inventorySHA256',
        'entries',
        'files',
        'bytes',
        'executableSHA256',
        'asarSHA256',
    ]);
    assert.equal(actual.schemaVersion, 1);
    for (const key of ['inventorySHA256', 'executableSHA256', 'asarSHA256'])
        assert.match(actual[key], /^[a-f0-9]{64}$/);
    assert.ok(
        Number.isSafeInteger(actual.entries) &&
            actual.entries >= 6 &&
            actual.entries <= MAC_PAYLOAD_LIMITS.entries,
    );
    assert.ok(
        Number.isSafeInteger(actual.files) && actual.files >= 3 && actual.files <= actual.entries,
    );
    assert.ok(
        Number.isSafeInteger(actual.bytes) &&
            actual.bytes >= 0 &&
            actual.bytes <= MAC_PAYLOAD_LIMITS.totalBytes,
    );
    if (expected !== undefined)
        assert.deepEqual(actual, expected, 'Mac payload differs from shipping build inventory.');
    return actual;
}

const nativeIO = {
    lstat: (file) => lstat(file, { bigint: true }),
    realpath,
    readlink,
    async *names(file) {
        const directory = await opendir(file);
        for await (const entry of directory) yield entry.name;
    },
    open: (file) => open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
};
function same(a, b) {
    for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
        assert.equal(b[key], a[key], 'Mac payload changed during observation: ' + key);
    assert.equal(b.isSymbolicLink(), a.isSymbolicLink());
    assert.equal(b.isFile(), a.isFile());
    assert.equal(b.isDirectory(), a.isDirectory());
}
async function readIdentity(file, stat, io) {
    const size = Number(stat.size),
        handle = await io.open(file);
    let failure,
        failed = false,
        sha256;
    try {
        same(stat, await handle.stat({ bigint: true }));
        const digest = createHash('sha256'),
            buffer = Buffer.alloc(MAC_PAYLOAD_LIMITS.chunkBytes);
        let at = 0;
        for (;;) {
            const length = Math.min(buffer.length, size - at + 1),
                { bytesRead: n } = await handle.read(buffer, 0, length, at);
            assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= length);
            if (!n) break;
            at += n;
            assert.ok(at <= size);
            digest.update(buffer.subarray(0, n));
        }
        assert.equal(at, size);
        same(stat, await handle.stat({ bigint: true }));
        same(stat, await io.lstat(file));
        sha256 = digest.digest('hex');
    } catch (error) {
        failed = true;
        failure = error;
    }
    try {
        await handle.close();
    } catch (error) {
        throw failed
            ? new AggregateError([failure, error], 'Payload read and close both failed.')
            : error;
    }
    if (failed) throw failure;
    return { bytes: size, sha256 };
}
export async function sampleMacArchive(file, io = nativeIO) {
    assert.ok(path.isAbsolute(file));
    assert.equal(await io.realpath(file), file);
    const stat = await io.lstat(file);
    assert.ok(
        stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.nlink === 1n &&
            stat.size > 0n &&
            stat.size <= BigInt(MAC_PAYLOAD_LIMITS.archiveBytes),
    );
    return readIdentity(file, stat, io);
}
/** Read-only. No extraction, permissions, cleanup, child or native application action.
 * Readable file handles are joined even on failure; no result is issued on unknown close. */
export async function inventoryMacPayload(input, io = nativeIO) {
    const root = path.resolve(input);
    assert.equal(await io.realpath(root), root);
    const beforeRoot = await io.lstat(root);
    assert.ok(beforeRoot.isDirectory() && !beforeRoot.isSymbolicLink());
    const samples = new Map([[root, beforeRoot]]),
        rows = [];
    let total = 0;
    async function visit(directory, prefix) {
        for await (const name of io.names(directory)) {
            assert.ok(
                typeof name === 'string' &&
                    name !== '.' &&
                    name !== '..' &&
                    !name.includes('/') &&
                    !name.includes('\\'),
            );
            const rel = relative(prefix ? prefix + '/' + name : name),
                file = path.join(root, rel);
            assert.ok(rows.length < MAC_PAYLOAD_LIMITS.entries);
            const stat = await io.lstat(file),
                mode = Number(stat.mode & 0o777n);
            assert.ok((stat.mode & 0o7000n) === 0n, 'Special payload permission bits.');
            samples.set(file, stat);
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
                assert.equal(await io.realpath(file), file);
                rows.push({ path: rel, kind: 'directory', mode });
                await visit(file, rel);
            } else if (stat.isSymbolicLink()) {
                const target = await io.readlink(file),
                    actual = await io.realpath(file);
                assert.ok(
                    actual === root || actual.startsWith(root + path.sep),
                    'Payload link escapes bundle.',
                );
                rows.push({ path: rel, kind: 'symlink', target });
            } else {
                assert.ok(stat.isFile() && stat.nlink === 1n);
                assert.ok(stat.size >= 0n && stat.size <= BigInt(MAC_PAYLOAD_LIMITS.fileBytes));
                const size = Number(stat.size);
                total += size;
                assert.ok(total <= MAC_PAYLOAD_LIMITS.totalBytes);
                const { sha256 } = await readIdentity(file, stat, io);
                rows.push({ path: rel, kind: 'file', bytes: size, sha256, mode });
            }
        }
    }
    await visit(root, '');
    for (const [file, stat] of samples) same(stat, await io.lstat(file));
    rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    macPayloadIdentity(rows);
    return rows;
}
/** Convert actual tree() samples, not an input inventory, into the same identity. */
export function macIdentityFromTreeSamples(rows) {
    assert.ok(Array.isArray(rows) && rows[0]?.path === '.' && rows[0].kind === 'directory');
    return macPayloadIdentity(
        rows.slice(1).map((row) => {
            if (row.kind === 'file')
                return {
                    path: row.path,
                    kind: row.kind,
                    bytes: row.bytes,
                    sha256: row.sha256,
                    mode: row.mode,
                };
            if (row.kind === 'directory') return { path: row.path, kind: row.kind, mode: row.mode };
            return { path: row.path, kind: row.kind, target: row.target };
        }),
    );
}
/** Current package sample only; no assertion about subsequent execution, races or retirement. */
export function validateMacInstalledPayloadSample(value, expected) {
    keys(value, [
        'schemaVersion',
        'kind',
        'caseId',
        'version',
        'sourceCommit',
        'sourceTree',
        'archive',
        'payloadIdentity',
        'qualification',
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, 'macos-installed-payload-sample');
    for (const key of ['caseId', 'version', 'sourceCommit', 'sourceTree'])
        assert.equal(value[key], expected[key]);
    for (const key of ['sourceCommit', 'sourceTree']) assert.match(value[key], /^[a-f0-9]{40}$/);
    assert.deepEqual(value.archive, expected.archive);
    validateMacPayloadIdentity(value.payloadIdentity, expected.payloadIdentity);
    assert.equal(value.qualification, false);
    return value;
}
