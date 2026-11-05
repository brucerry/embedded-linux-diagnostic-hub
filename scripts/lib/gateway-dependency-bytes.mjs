import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

// Observer admission bounds, not install quotas or a shipping resource policy.
export const DEPENDENCY_BYTE_LIMITS = Object.freeze({
    archives: 128,
    compressed: 16 * 1024 ** 2,
    compressedTotal: 128 * 1024 ** 2,
    expanded: 64 * 1024 ** 2,
    expandedTotal: 256 * 1024 ** 2,
    entries: 4096,
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const zero = (bytes) => bytes.every((byte) => byte === 0);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function text(bytes) {
    const end = bytes.indexOf(0);
    if (end < 0) return decoder.decode(bytes);
    assert.ok(zero(bytes.subarray(end)), 'Noncanonical tar text padding.');
    return decoder.decode(bytes.subarray(0, end));
}
function octal(bytes, blank = false) {
    assert.ok(
        bytes.every((byte) => byte < 128),
        'Non-ASCII tar number.',
    );
    const value = bytes.toString('latin1');
    if (blank && /^[ \0]*$/.test(value)) return 0;
    assert.match(value, /^ *[0-7]+[ \0]*$/);
    const number = Number.parseInt(value.replace(/\0.*$/, '').trim(), 8);
    assert.ok(Number.isSafeInteger(number) && number >= 0);
    return number;
}
function canonical(value) {
    assert.ok(value && Buffer.byteLength(value) <= 1024 && value === value.normalize('NFC'));
    assert.ok(!/[\\:\x00-\x1f\x7f]/.test(value));
    assert.ok(
        value
            .split('/')
            .every((part) => part && !['.', '..'].includes(part) && !/[ .]$/.test(part)),
    );
    return value;
}
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function packageBytes(raw, integrity) {
    const L = DEPENDENCY_BYTE_LIMITS;
    assert.ok(Buffer.isBuffer(raw) && raw.length >= 18 && raw.length <= L.compressed);
    // The frozen Gateway closure uses SHA512. Other SRI algorithms/multi-digests require review.
    assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    const encoded = integrity.slice(7),
        wanted = Buffer.from(encoded, 'base64');
    assert.equal(wanted.length, 64);
    assert.equal(wanted.toString('base64'), encoded);
    raw = Buffer.from(raw);
    assert.ok(
        createHash('sha512').update(raw).digest().equals(wanted),
        'Locked npm archive integrity differs.',
    );
    assert.ok(
        raw.subarray(0, 4).equals(Buffer.from([31, 139, 8, 0])),
        'Unsupported npm gzip header.',
    );
    const size = raw.readUInt32LE(raw.length - 4);
    assert.ok(size >= 1024 && size <= L.expanded && size % 512 === 0);
    const compressed = raw.subarray(10, -8);
    const inflated = inflateRawSync(compressed, { maxOutputLength: size + 1, info: true });
    assert.equal(inflated.engine.bytesWritten, compressed.length, 'Trailing compressed content.');
    const tar = inflated.buffer;
    assert.equal(tar.length, size);
    assert.equal(crc32(tar), raw.readUInt32LE(raw.length - 8));
    const files = [],
        seen = new Map(),
        parents = new Set();
    let at = 0,
        count = 0,
        manifest;
    while (at + 512 <= tar.length && !zero(tar.subarray(at, at + 512))) {
        assert.ok(++count <= L.entries);
        const head = tar.subarray(at, at + 512);
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : head[i];
        assert.equal(octal(head.subarray(148, 156)), checksum);
        assert.ok(
            head.subarray(257, 265).equals(Buffer.from('ustar\0' + '00')) &&
                zero(head.subarray(500)),
            'Unsupported npm tar format.',
        );
        assert.ok(
            [0, 48, 53].includes(head[156]) && zero(head.subarray(157, 257)),
            'Links, PAX, GNU and special members unsupported.',
        );
        const directory = head[156] === 53,
            prefix = text(head.subarray(345, 500));
        let name = (prefix ? prefix + '/' : '') + text(head.subarray(0, 100));
        if (directory && name.endsWith('/')) name = name.slice(0, -1);
        canonical(name);
        assert.ok(
            (name === 'package' && directory) || name.startsWith('package/'),
            'Non-package npm namespace.',
        );
        const key = name.toLowerCase();
        assert.ok(
            !seen.has(key) && (directory || !parents.has(key)),
            'Duplicate or aliased npm path.',
        );
        const parts = key.split('/');
        parts.pop();
        while (parts.length) {
            const parent = parts.join('/');
            assert.notEqual(seen.get(parent), 'file', 'File aliases a parent directory.');
            parents.add(parent);
            parts.pop();
        }
        seen.set(key, directory ? 'directory' : 'file');
        const mode = octal(head.subarray(100, 108)),
            length = octal(head.subarray(124, 136));
        assert.ok(mode <= 0o777 && !(mode & 0o022) && mode & 0o400);
        if (directory) assert.ok(mode & 0o100 && length === 0);
        octal(head.subarray(108, 116), true);
        octal(head.subarray(116, 124), true);
        octal(head.subarray(136, 148), true);
        text(head.subarray(265, 297));
        text(head.subarray(297, 329));
        assert.equal(octal(head.subarray(329, 337), true), 0);
        assert.equal(octal(head.subarray(337, 345), true), 0);
        const start = at + 512,
            finish = start + length,
            next = start + Math.ceil(length / 512) * 512;
        assert.ok(length <= L.expanded && next <= tar.length && zero(tar.subarray(finish, next)));
        if (!directory) {
            const relative = name.slice('package/'.length);
            assert.ok(
                relative &&
                    !relative.split('/').includes('node_modules') &&
                    !relative.endsWith('.node'),
                'Bundled or native dependencies unsupported.',
            );
            const content = tar.subarray(start, finish);
            files.push({ path: relative, bytes: length, sha256: hash(content) });
            if (relative === 'package.json') {
                assert.ok(length > 0 && length <= 1024 ** 2);
                manifest = JSON.parse(decoder.decode(content));
            }
        }
        at = next;
    }
    assert.ok(
        tar.length - at >= 1024 && tar.length - at <= 10240 && zero(tar.subarray(at)),
        'Invalid tar terminator or trailing content.',
    );
    assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
        files,
        manifest,
        compressedBytes: raw.length,
        expandedBytes: size,
        sha256: hash(raw),
        integrity,
    };
}
/** Pure retained-byte derivation only. lock must already be validated against frozen source.
 * No supplied inventory, filesystem, loader report, fetch, extraction or execution is accepted.
 */
export function inspectLockedDependencyBytes(lock, archives) {
    const L = DEPENDENCY_BYTE_LIMITS;
    const required = Object.keys(lock.packages)
        .filter((p) => p && !lock.packages[p].optional)
        .sort();
    assert.ok(
        required.length > 0 &&
            required.length <= L.archives &&
            Array.isArray(archives) &&
            archives.length === required.length,
    );
    const provided = new Map();
    let compressed = 0;
    for (const row of archives) {
        assert.deepEqual(Object.keys(row).sort(), ['bytes', 'path']);
        assert.ok(required.includes(row.path) && !provided.has(row.path));
        assert.ok(Buffer.isBuffer(row.bytes) && row.bytes.length <= L.compressed);
        compressed += row.bytes.length;
        assert.ok(compressed <= L.compressedTotal);
        provided.set(row.path, row.bytes);
    }
    const packages = [],
        files = [];
    let expanded = 0;
    for (const path of required) {
        const value = lock.packages[path],
            observed = packageBytes(provided.get(path), value.integrity);
        expanded += observed.expandedBytes;
        assert.ok(expanded <= L.expandedTotal);
        assert.equal(observed.manifest.name, path.split('node_modules/').at(-1));
        assert.equal(observed.manifest.version, value.version);
        assert.ok(
            files.length + observed.files.length <= L.entries,
            'Aggregate dependency file bound exceeded.',
        );
        for (const row of observed.files) files.push({ ...row, path: path + '/' + row.path });
        packages.push({
            path,
            version: value.version,
            archiveSHA256: observed.sha256,
            integrity: observed.integrity,
            compressedBytes: observed.compressedBytes,
            expandedBytes: observed.expandedBytes,
            files: observed.files.length,
        });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    assert.ok(files.length <= L.entries);
    return { packages, files, compressedBytes: compressed, expandedBytes: expanded };
}
