import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

// Existing shipping admission bounds, not a resource qualification policy.
const limits = {
    archive: 128 * 1024 ** 2,
    member: 64 * 1024 ** 2,
    expanded: 256 * 1024 ** 2,
    entries: 4096,
    path: 1024,
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const zero = (bytes) => bytes.every((byte) => byte === 0);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function name(value) {
    assert.ok(typeof value === 'string' && value && Buffer.byteLength(value) <= limits.path);
    assert.equal(value.normalize('NFC'), value);
    assert.ok(!/[\\:\x00-\x1f\x7f]/.test(value));
    assert.ok(
        value
            .split('/')
            .every(
                (part) =>
                    part &&
                    part !== '.' &&
                    part !== '..' &&
                    !/[ .]$/.test(part) &&
                    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
            ),
    );
    return value;
}
function inventory(rows) {
    assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= limits.entries);
    const seen = new Set();
    let total = 0;
    for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), ['bytes', 'path', 'sha256']);
        const key = name(row.path).toLowerCase();
        assert.ok(!seen.has(key));
        for (const prior of seen)
            assert.ok(!key.startsWith(prior + '/') && !prior.startsWith(key + '/'));
        seen.add(key);
        assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= limits.member);
        assert.match(row.sha256, /^[a-f0-9]{64}$/);
        total += row.bytes;
        assert.ok(total <= limits.expanded);
    }
    assert.deepEqual(
        rows.map((row) => row.path),
        rows.map((row) => row.path).sort(),
    );
    return total;
}
function inflate(bytes, size) {
    // Synchronous Node codecs close their internal handle before returning/throwing.
    // maxOutputLength bounds malformed expansion; bytesWritten proves full compressed-span use.
    const result = inflateRawSync(bytes, { maxOutputLength: size + 1, info: true });
    assert.equal(result.engine.bytesWritten, bytes.length, 'Trailing compressed bytes.');
    assert.equal(result.buffer.length, size, 'Expanded length differs.');
    return result.buffer;
}
function inspectZip(raw, payload) {
    const end = raw.length - 22;
    assert.ok(end >= 0);
    assert.equal(raw.readUInt32LE(end), 0x06054b50);
    assert.equal(raw.readUInt16LE(end + 4), 0);
    assert.equal(raw.readUInt16LE(end + 6), 0);
    assert.equal(raw.readUInt16LE(end + 8), payload.length);
    assert.equal(raw.readUInt16LE(end + 10), payload.length);
    assert.equal(raw.readUInt16LE(end + 20), 0);
    const central = raw.readUInt32LE(end + 16);
    assert.equal(central + raw.readUInt32LE(end + 12), end);
    const expected = new Map(payload.map((row) => [row.path, row]));
    const observed = [],
        spans = [];
    let at = central;
    for (let i = 0; i < payload.length; i++) {
        assert.ok(at + 46 <= end);
        assert.equal(raw.readUInt32LE(at), 0x02014b50);
        const flags = raw.readUInt16LE(at + 8),
            method = raw.readUInt16LE(at + 10),
            crc = raw.readUInt32LE(at + 16),
            compressed = raw.readUInt32LE(at + 20),
            size = raw.readUInt32LE(at + 24),
            length = raw.readUInt16LE(at + 28),
            local = raw.readUInt32LE(at + 42),
            mode = raw.readUInt32LE(at + 38) >>> 16;
        assert.ok((flags & ~0x800) === 0 && [0, 8].includes(method));
        assert.ok(raw.readUInt16LE(at + 6) > 0 && raw.readUInt16LE(at + 6) <= 20);
        assert.equal(raw.readUInt16LE(at + 30), 0, 'ZIP extras unsupported.');
        assert.equal(raw.readUInt16LE(at + 32), 0);
        assert.equal(raw.readUInt16LE(at + 34), 0);
        assert.ok(length > 0 && length <= limits.path && at + 46 + length <= end);
        const nameBytes = raw.subarray(at + 46, at + 46 + length),
            filename = name(decoder.decode(nameBytes));
        if (!(flags & 0x800)) assert.ok(nameBytes.every((byte) => byte < 128));
        assert.ok((mode & 0o170000) === 0 || (mode & 0o170000) === 0o100000);
        assert.equal(mode & 0o7000, 0);
        assert.equal(raw.readUInt32LE(at + 38) & (0x10 | 0x400), 0);
        const wanted = expected.get(filename);
        assert.ok(wanted, 'Extra or duplicate ZIP member.');
        expected.delete(filename);
        assert.equal(size, wanted.bytes, 'ZIP member size differs from inventory.');
        assert.ok(compressed <= limits.archive && local + 30 <= central);
        assert.equal(raw.readUInt32LE(local), 0x04034b50);
        assert.equal(raw.readUInt16LE(local + 4), raw.readUInt16LE(at + 6));
        assert.equal(raw.readUInt16LE(local + 6), flags);
        assert.equal(raw.readUInt16LE(local + 8), method);
        assert.equal(raw.readUInt32LE(local + 10), raw.readUInt32LE(at + 12));
        assert.equal(raw.readUInt32LE(local + 14), crc);
        assert.equal(raw.readUInt32LE(local + 18), compressed);
        assert.equal(raw.readUInt32LE(local + 22), size);
        assert.equal(raw.readUInt16LE(local + 26), length);
        assert.equal(raw.readUInt16LE(local + 28), 0);
        const start = local + 30 + length,
            finish = start + compressed;
        assert.ok(finish <= central && raw.subarray(local + 30, start).equals(nameBytes));
        spans.push({
            start: local,
            finish,
            payloadStart: start,
            compressed,
            size,
            method,
            crc,
            filename,
        });
        at += 46 + length;
    }
    assert.equal(at, end);
    assert.equal(expected.size, 0);
    spans.sort((a, b) => a.start - b.start);
    let next = 0;
    for (const span of spans) {
        assert.equal(span.start, next, 'ZIP gap, overlap or preamble.');
        next = span.finish;
    }
    assert.equal(next, central);
    // Validate the entire directory and disjoint spans before any decompression.
    for (const row of spans) {
        const encoded = raw.subarray(row.payloadStart, row.finish);
        if (row.method === 0) assert.equal(row.compressed, row.size);
        const bytes = row.method === 0 ? encoded : inflate(encoded, row.size);
        assert.equal(crc32(bytes), row.crc, 'ZIP CRC differs.');
        observed.push({ path: row.filename, bytes: bytes.length, sha256: sha(bytes) });
    }
    return { payload: observed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}
function octal(bytes) {
    assert.ok(bytes.every((byte) => byte < 128));
    const text = bytes.toString('ascii');
    assert.match(text, /^[0-7]+\0$/);
    const value = Number.parseInt(text, 8);
    assert.ok(Number.isSafeInteger(value));
    return value;
}
function tarName(bytes) {
    const end = bytes.indexOf(0);
    assert.ok(end >= 0 && zero(bytes.subarray(end)));
    return decoder.decode(bytes.subarray(0, end));
}
function inspectGateway(raw, payload, expected) {
    assert.ok(
        expected &&
            Number.isSafeInteger(expected.expandedBytes) &&
            expected.expandedBytes >= 1024 &&
            expected.expandedBytes <= limits.expanded + limits.entries * 1024 + 1024,
    );
    assert.ok(raw.length >= 18);
    assert.ok(raw.subarray(0, 4).equals(Buffer.from([31, 139, 8, 0])), 'Unsupported gzip header.');
    const expanded = inflate(raw.subarray(10, -8), expected.expandedBytes);
    assert.equal(crc32(expanded), raw.readUInt32LE(raw.length - 8));
    assert.equal(expanded.length, raw.readUInt32LE(raw.length - 4));
    const wanted = new Map(payload.map((row) => [row.path, row]));
    const entries = [],
        actual = [],
        seen = new Set();
    let at = 0,
        directories = 0,
        payloadBytes = 0;
    while (at + 512 <= expanded.length && !zero(expanded.subarray(at, at + 512))) {
        assert.ok(entries.length < limits.entries);
        const head = expanded.subarray(at, at + 512);
        assert.ok(head.subarray(257, 265).equals(Buffer.from('ustar\0' + '00')));
        assert.ok(zero(head.subarray(157, 257)) && zero(head.subarray(265)));
        assert.ok([48, 53].includes(head[156]), 'Unsupported tar member.');
        const checksumField = head.subarray(148, 156);
        assert.ok(
            checksumField.every((byte) => byte < 128),
            'Non-ASCII tar checksum.',
        );
        const checksumText = checksumField.toString('latin1');
        assert.match(checksumText, /^[0-7]{6}\0 $/);
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : head[i];
        assert.equal(Number.parseInt(checksumText.slice(0, 6), 8), checksum);
        const directory = head[156] === 53,
            encodedName = tarName(head.subarray(0, 100));
        if (directory) assert.ok(encodedName.endsWith('/'));
        const filename = name(directory ? encodedName.slice(0, -1) : encodedName);
        assert.ok(!seen.has(filename.toLowerCase()), 'Duplicate tar member.');
        seen.add(filename.toLowerCase());
        const mode = octal(head.subarray(100, 108)),
            size = octal(head.subarray(124, 136));
        for (const [start, end] of [
            [108, 116],
            [116, 124],
            [136, 148],
        ])
            assert.equal(octal(head.subarray(start, end)), 0);
        assert.equal(mode, directory ? 0o755 : 0o644);
        assert.ok(size <= limits.member);
        const start = at + 512,
            finish = start + size,
            next = start + Math.ceil(size / 512) * 512;
        assert.ok(next <= expanded.length && zero(expanded.subarray(finish, next)));
        if (directory) {
            assert.equal(size, 0);
            directories++;
            entries.push({ kind: 'directory', path: filename, mode });
        } else {
            const expectedFile = wanted.get(filename);
            assert.ok(expectedFile, 'Extra or duplicate tar file.');
            wanted.delete(filename);
            assert.equal(size, expectedFile.bytes);
            const file = {
                path: filename,
                bytes: size,
                sha256: sha(expanded.subarray(start, finish)),
            };
            actual.push(file);
            entries.push({ kind: 'file', ...file, mode });
            payloadBytes += size;
            assert.ok(payloadBytes <= limits.expanded);
        }
        at = next;
    }
    assert.equal(expanded.length - at, 1024, 'Tar must end with exactly two zero blocks.');
    assert.ok(zero(expanded.subarray(at)));
    assert.equal(wanted.size, 0);
    const byName = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const census = {
        format: 'ustar',
        entries: entries.sort(byName),
        files: actual.length,
        directories,
        payloadBytes,
        expandedBytes: expanded.length,
    };
    assert.deepEqual(census, expected, 'Actual tar census differs from declared inventory.');
    return { payload: actual.sort(byName), tarInventory: census };
}
/** Byte consistency only. The caller must validate the producer record separately.
 * Does not authenticate producer declarations, extract files, execute payloads or authorize release. */
export function inspectInnerArchive(raw, record, scope) {
    assert.ok(['web', 'gateway'].includes(scope));
    assert.ok(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= limits.archive);
    inventory(record.payload);
    assert.equal(raw.length, record.archive.bytes);
    assert.equal(sha(raw), record.archive.sha256);
    const observed =
        scope === 'web'
            ? inspectZip(raw, record.payload)
            : inspectGateway(raw, record.payload, record.tarInventory);
    assert.deepEqual(
        observed.payload,
        record.payload,
        'Actual payload differs from producer inventory.',
    );
    return {
        kind: 'inner-archive-byte-inspection',
        status: 'matches-producer-inventory-unqualified',
        scope,
        archiveSHA256: sha(raw),
        payload: observed.payload,
        ...(observed.tarInventory ? { tarInventory: observed.tarInventory } : {}),
        sourceProvenance: 'not-established',
        releaseAcceptance: false,
    };
}
