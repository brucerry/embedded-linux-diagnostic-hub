import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { validateSourceBinding } from './product-supervisor-contract.mjs';

export const SOURCE_LIMITS = Object.freeze({
    files: 10000,
    entries: 20000,
    depth: 32,
    blob: 16 * 1024 ** 2,
    tree: 4 * 1024 ** 2,
    commit: 1024 ** 2,
    total: 128 * 1024 ** 2,
    metadata: 4 * 1024 ** 2,
});
export const SOURCE_EXCLUSIONS = Object.freeze([
    '.git',
    'node_modules',
    'validation',
    'dist',
    'dist-web',
    'dist-site',
    'dist-gateway',
    'dist-electron',
    'release',
    'test-results',
]);
const excluded = new Set(SOURCE_EXCLUSIONS),
    oidPattern = /^[a-f0-9]{40}$/,
    shaPattern = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const scalar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const sourceDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const gitObjectID = (type, bytes) =>
    createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
function keys(value, wanted) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(
        Object.keys(value).sort(),
        [...wanted].sort(),
        'Unknown or missing source bridge field.',
    );
}
function name(value) {
    assert.ok(
        typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 255,
        'Source name byte bound exceeded.',
    );
    assert.ok(
        value !== '.' && value !== '..' && !/[\\/\x00-\x1f\x7f]/.test(value),
        'Ambiguous source entry name.',
    );
}
function sourcePath(value) {
    assert.ok(typeof value === 'string' && Buffer.byteLength(value) <= 4096);
    const parts = value.split('/');
    assert.ok(parts.length <= SOURCE_LIMITS.depth, 'Source path depth bound exceeded.');
    parts.forEach(name);
    assert.ok(!parts.includes('.git'), 'Tracked Git metadata is unsupported.');
    return parts;
}
export function fingerprintedPath(value) {
    return !sourcePath(value).some((part) => excluded.has(part));
}
function trie(records) {
    const root = { children: new Map(), folded: new Map(), record: null };
    for (const record of records) {
        let node = root;
        for (const part of sourcePath(record.path)) {
            assert.equal(node.record, null, 'Source file/directory path conflict.');
            assert.ok(
                !node.folded.has(part.toLowerCase()) ||
                    node.folded.get(part.toLowerCase()) === part,
                'Case-aliased source directory.',
            );
            node.folded.set(part.toLowerCase(), part);
            if (!node.children.has(part))
                node.children.set(part, { children: new Map(), folded: new Map(), record: null });
            node = node.children.get(part);
        }
        assert.equal(node.record, null, 'Duplicate source path.');
        assert.equal(node.children.size, 0, 'Source file/directory path conflict.');
        node.record = record;
    }
    return root;
}
/** Mirrors sourceFingerprint's per-directory JS ordering and basename exclusions, not path sorting. */
export function sourceFingerprintInventory(records) {
    const hash = createHash('sha256'),
        root = trie(records);
    function visit(node, prefix) {
        for (const part of [...node.children.keys()].sort(scalar)) {
            if (excluded.has(part)) continue;
            const child = node.children.get(part),
                relative = prefix ? prefix + '/' + part : part;
            if (child.record) {
                assert.match(child.record.sha256, shaPattern);
                hash.update(relative);
                hash.update('\0');
                hash.update(child.record.sha256);
                hash.update('\n');
            } else visit(child, relative);
        }
    }
    visit(root, '');
    return hash.digest('hex');
}
function expectedIdentity(expected) {
    keys(expected, ['sourceCommit', 'sourceTree']);
    assert.match(expected.sourceCommit, oidPattern);
    assert.match(expected.sourceTree, oidPattern);
}
function canonicalInventory(records) {
    assert.ok(
        Array.isArray(records) && records.length <= SOURCE_LIMITS.files,
        'Source inventory file bound exceeded.',
    );
    const paths = new Set(),
        folded = new Set();
    let total = 0;
    for (const record of records) {
        keys(record, ['path', 'mode', 'blob', 'bytes', 'sha256', 'fingerprinted']);
        sourcePath(record.path);
        assert.ok(
            !paths.has(record.path) && !folded.has(record.path.toLowerCase()),
            'Duplicate or case-aliased source path.',
        );
        paths.add(record.path);
        folded.add(record.path.toLowerCase());
        assert.ok(['100644', '100755'].includes(record.mode), 'Unsupported source file mode.');
        assert.match(record.blob, oidPattern);
        assert.match(record.sha256, shaPattern);
        assert.ok(
            Number.isSafeInteger(record.bytes) &&
                record.bytes >= 0 &&
                record.bytes <= SOURCE_LIMITS.blob,
        );
        total += record.bytes;
        assert.ok(total <= SOURCE_LIMITS.total, 'Source tracked/closure byte bound exceeded.');
        assert.equal(record.fingerprinted, fingerprintedPath(record.path));
    }
    trie(records);
    return [...records].sort((a, b) => scalar(a.path, b.path));
}
function parseTree(bytes) {
    const result = [],
        names = new Set(),
        folded = new Set();
    let offset = 0,
        previous;
    while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset),
            zero = bytes.indexOf(0, space + 1);
        assert.ok(
            space > offset && zero > space + 1 && zero + 21 <= bytes.length,
            'Malformed or truncated Git tree.',
        );
        const mode = decoder.decode(bytes.subarray(offset, space));
        assert.ok(
            ['100644', '100755', '40000'].includes(mode),
            'Unsupported Git tree mode (links/submodules are not source files).',
        );
        const rawName = bytes.subarray(space + 1, zero),
            entryName = decoder.decode(rawName);
        assert.ok(Buffer.from(entryName).equals(rawName));
        name(entryName);
        assert.ok(
            !names.has(entryName) && !folded.has(entryName.toLowerCase()),
            'Duplicate or case-aliased Git entry.',
        );
        const order = Buffer.concat([rawName, Buffer.from(mode === '40000' ? '/' : '\0')]);
        if (previous)
            assert.ok(Buffer.compare(previous, order) < 0, 'Noncanonical Git tree order.');
        previous = order;
        names.add(entryName);
        folded.add(entryName.toLowerCase());
        result.push({
            name: entryName,
            mode,
            oid: bytes.subarray(zero + 1, zero + 21).toString('hex'),
        });
        assert.ok(result.length <= SOURCE_LIMITS.entries, 'Git tree entry bound exceeded.');
        offset = zero + 21;
    }
    return result;
}
async function gitInventory(provider, expected) {
    const cache = new Map();
    let total = 0;
    async function fetch(ids, type, limit) {
        const missing = [...new Set(ids)].filter((oid) => !cache.has(oid));
        for (let offset = 0; offset < missing.length; offset += 64) {
            const selected = missing.slice(offset, offset + 64),
                objects = await provider.objects(selected);
            assert.ok(
                Array.isArray(objects) && objects.length === selected.length,
                'Missing Git objects.',
            );
            for (let i = 0; i < selected.length; i++) {
                const object = objects[i];
                keys(object, ['oid', 'type', 'bytes']);
                assert.equal(object.oid, selected[i]);
                assert.equal(object.type, type);
                assert.ok(
                    object.bytes instanceof Uint8Array && object.bytes.length <= limit,
                    'Git object byte bound exceeded.',
                );
                const bytes = Buffer.from(object.bytes);
                assert.equal(gitObjectID(type, bytes), object.oid, 'Git object identity mismatch.');
                total += bytes.length;
                assert.ok(
                    total <= SOURCE_LIMITS.total,
                    'Source tracked/closure byte bound exceeded.',
                );
                cache.set(object.oid, { type, bytes });
                assert.ok(cache.size <= SOURCE_LIMITS.entries);
            }
        }
        return ids.map((oid) => {
            const object = cache.get(oid);
            assert.equal(object.type, type);
            return object.bytes;
        });
    }
    const [commit] = await fetch([expected.sourceCommit], 'commit', SOURCE_LIMITS.commit);
    const headerEnd = commit.indexOf(Buffer.from('\n\n'));
    assert.ok(
        headerEnd >= 0 && !commit.subarray(0, headerEnd).includes(0),
        'Malformed Git commit header.',
    );
    const header = decoder.decode(commit.subarray(0, headerEnd)).split('\n');
    const trees = header.filter((line) => line.startsWith('tree '));
    assert.equal(trees.length, 1);
    assert.equal(header[0], 'tree ' + expected.sourceTree);
    const files = [];
    let frontier = [{ oid: expected.sourceTree, prefix: '', depth: 0 }],
        visited = 0;
    while (frontier.length) {
        const bodies = await fetch(
                frontier.map((item) => item.oid),
                'tree',
                SOURCE_LIMITS.tree,
            ),
            next = [];
        for (let i = 0; i < frontier.length; i++) {
            const parent = frontier[i];
            assert.ok(parent.depth < SOURCE_LIMITS.depth, 'Git tree depth bound exceeded.');
            const entries = parseTree(bodies[i]);
            assert.ok(
                !parent.prefix || entries.length > 0,
                'Unmaterialized empty Git subtree is unsupported.',
            );
            for (const entry of entries) {
                assert.ok(
                    ++visited <= SOURCE_LIMITS.entries,
                    'Git closure expansion bound exceeded.',
                );
                const relative = parent.prefix ? parent.prefix + '/' + entry.name : entry.name;
                sourcePath(relative);
                if (entry.mode === '40000')
                    next.push({ oid: entry.oid, prefix: relative, depth: parent.depth + 1 });
                else {
                    files.push({ path: relative, mode: entry.mode, blob: entry.oid });
                    assert.ok(
                        files.length <= SOURCE_LIMITS.files,
                        'Git tracked file bound exceeded.',
                    );
                }
            }
        }
        frontier = next;
    }
    const blobs = await fetch(
        files.map((item) => item.blob),
        'blob',
        SOURCE_LIMITS.blob,
    );
    return canonicalInventory(
        files.map((item, i) => ({
            ...item,
            bytes: blobs[i].length,
            sha256: sourceDigest(blobs[i]),
            fingerprinted: fingerprintedPath(item.path),
        })),
    );
}
function stateMatches(state, expected, records) {
    keys(state, ['sourceCommit', 'sourceTree', 'index']);
    assert.equal(
        state.sourceCommit,
        expected.sourceCommit,
        'Checkout HEAD differs from frozen source.',
    );
    assert.equal(
        state.sourceTree,
        expected.sourceTree,
        'Checkout tree differs from frozen source.',
    );
    assert.ok(Array.isArray(state.index) && state.index.length === records.length);
    const index = [...state.index].sort((a, b) => scalar(a.path, b.path));
    for (let i = 0; i < index.length; i++) {
        const item = index[i],
            wanted = records[i];
        keys(item, ['path', 'mode', 'oid', 'stage']);
        assert.equal(item.stage, 0, 'Unmerged or sparse index is unsupported.');
        assert.equal(item.path, wanted.path);
        assert.equal(item.mode, wanted.mode);
        assert.equal(item.oid, wanted.blob, 'Index differs from frozen Git bytes.');
    }
}
async function worktreePass(provider, records) {
    const root = trie(records),
        seen = new Set();
    let entries = 0;
    async function visit(relative, node, alreadyExcluded) {
        const actual = await provider.entries(relative);
        assert.ok(Array.isArray(actual) && actual.length <= SOURCE_LIMITS.entries);
        const names = new Set(),
            folded = new Set();
        for (const item of actual) {
            keys(item, ['name', 'kind']);
            name(item.name);
            assert.ok(++entries <= SOURCE_LIMITS.entries);
            assert.ok(
                !names.has(item.name) && !folded.has(item.name.toLowerCase()),
                'Ambiguous worktree entry.',
            );
            names.add(item.name);
            folded.add(item.name.toLowerCase());
            const child = node.children.get(item.name),
                ignored = alreadyExcluded || excluded.has(item.name);
            if (!child && ignored) continue;
            assert.ok(
                child,
                'Extra nonexcluded worktree path: ' + (relative ? relative + '/' : '') + item.name,
            );
            const full = relative ? relative + '/' + item.name : item.name;
            if (child.record) {
                assert.equal(item.kind, 'file', 'Tracked source is missing, aliased or special.');
                const file = await provider.file(full);
                keys(file, ['mode', 'bytes']);
                assert.equal(
                    file.mode,
                    child.record.mode,
                    'Native executable mode differs from Git.',
                );
                assert.ok(
                    file.bytes instanceof Uint8Array && file.bytes.length <= SOURCE_LIMITS.blob,
                );
                assert.equal(file.bytes.length, child.record.bytes, 'Dirty source length.');
                assert.equal(sourceDigest(file.bytes), child.record.sha256, 'Dirty source bytes.');
                seen.add(full);
            } else {
                assert.equal(item.kind, 'directory', 'Source directory is aliased or special.');
                await visit(full, child, ignored);
            }
        }
    }
    await visit('', root, false);
    assert.equal(seen.size, records.length, 'Missing tracked source bytes.');
}
export async function observeSourceBridge(expected, provider) {
    expectedIdentity(expected);
    const before = await provider.state(),
        inventory = await gitInventory(provider, expected);
    stateMatches(before, expected, inventory);
    await worktreePass(provider, inventory);
    stateMatches(await provider.state(), expected, inventory);
    await worktreePass(provider, inventory);
    stateMatches(await provider.state(), expected, inventory);
    const record = {
        schemaVersion: 1,
        kind: 'committed-source-inventory',
        status: 'collected-non-qualifying-source-bridge',
        qualification: false,
        releaseAcceptance: false,
        ...expected,
        sourceFingerprint: sourceFingerprintInventory(inventory),
        inventorySHA256: sourceDigest(JSON.stringify(inventory)),
        fileCount: inventory.length,
        fingerprintedFileCount: inventory.filter((item) => item.fingerprinted).length,
        worktreePasses: 2,
        modeEvidence: 'git-owner-executable-bit',
        scope: 'Observed checkout/index/bytes mapped to supplied immutable Git identities; no artifact or release verdict.',
        inventory,
    };
    validateSourceBridge(record, expected);
    for (const item of inventory) Object.freeze(item);
    Object.freeze(inventory);
    return Object.freeze(record);
}
/** Structural self-consistency only. Semantic verification MUST re-read the independent provider. */
export function validateSourceBridge(value, expected) {
    expectedIdentity(expected);
    keys(value, [
        'schemaVersion',
        'kind',
        'status',
        'qualification',
        'releaseAcceptance',
        'sourceCommit',
        'sourceTree',
        'sourceFingerprint',
        'inventorySHA256',
        'fileCount',
        'fingerprintedFileCount',
        'worktreePasses',
        'modeEvidence',
        'scope',
        'inventory',
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, 'committed-source-inventory');
    assert.equal(value.status, 'collected-non-qualifying-source-bridge');
    assert.equal(value.qualification, false);
    assert.equal(value.releaseAcceptance, false);
    assert.equal(value.sourceCommit, expected.sourceCommit);
    assert.equal(value.sourceTree, expected.sourceTree);
    const inventory = canonicalInventory(value.inventory);
    assert.equal(
        JSON.stringify(value.inventory),
        JSON.stringify(inventory),
        'Noncanonical source inventory order.',
    );
    assert.equal(value.fileCount, inventory.length);
    assert.equal(
        value.fingerprintedFileCount,
        inventory.filter((item) => item.fingerprinted).length,
    );
    assert.equal(value.inventorySHA256, sourceDigest(JSON.stringify(inventory)));
    assert.equal(value.sourceFingerprint, sourceFingerprintInventory(inventory));
    assert.equal(value.worktreePasses, 2);
    assert.equal(value.modeEvidence, 'git-owner-executable-bit');
    assert.equal(
        value.scope,
        'Observed checkout/index/bytes mapped to supplied immutable Git identities; no artifact or release verdict.',
    );
    assert.ok(
        Buffer.byteLength(JSON.stringify(value)) <= SOURCE_LIMITS.metadata,
        'Source bridge metadata bound exceeded.',
    );
    return value;
}
export async function verifySourceBridge(value, expected, provider) {
    validateSourceBridge(value, expected);
    const actual = await observeSourceBridge(expected, provider);
    assert.equal(
        JSON.stringify(value),
        JSON.stringify(actual),
        'Source bridge differs from independently observed Git/worktree closure.',
    );
    return actual;
}
export async function verifyAndBindDiagnosticSource(value, binding, expected, provider) {
    const bridge = await verifySourceBridge(value, expected, provider);
    validateSourceBinding(binding);
    assert.equal(
        binding.sourceSHA256,
        bridge.sourceFingerprint,
        'Supervisor source differs from frozen inventory.',
    );
    return {
        schemaVersion: 1,
        kind: 'supervisor-committed-source-binding',
        qualification: false,
        releaseAcceptance: false,
        ...expected,
        sourceSHA256: bridge.sourceFingerprint,
        inventorySHA256: bridge.inventorySHA256,
        jobNonce: binding.jobNonce,
        observerSHA256: binding.observerSHA256,
    };
}
export function parseSourceBridge(bytes) {
    assert.ok(
        bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= SOURCE_LIMITS.metadata,
    );
    const text = decoder.decode(bytes),
        value = JSON.parse(text);
    assert.equal(text, JSON.stringify(value) + '\n', 'Noncanonical source bridge bytes.');
    return value;
}
