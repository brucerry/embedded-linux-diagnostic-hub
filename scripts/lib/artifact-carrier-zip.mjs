import assert from 'node:assert/strict';
import { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';

// Transport container only. Inner shipping ZIP/tar remains a separate inspection boundary.
export const CARRIER_LIMIT = WEB_ARCHIVE_LIMITS.archive + 16 * 1024 ** 2 + 1024 ** 2;
export function carrierCRC32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function extras(raw) {
    for (let at = 0; at < raw.length;) {
        assert.ok(at + 4 <= raw.length);
        const kind = raw.readUInt16LE(at),
            size = raw.readUInt16LE(at + 2);
        at += 4;
        assert.ok([0x5455, 0x000a, 0x7875].includes(kind), 'Unsupported ZIP extra field.');
        assert.ok(at + size <= raw.length);
        at += size;
    }
}
function storedDeflate(bytes, size) {
    // Two passes, no span table: malformed tiny blocks cannot amplify an advertised size
    // into a large allocation before all stored-block metadata and final length are proved.
    const scan = (output) => {
        let at = 0,
            used = 0,
            final = false;
        while (!final) {
            assert.ok(at + 5 <= bytes.length);
            const control = bytes[at++];
            final = !!(control & 1);
            assert.equal((control >>> 1) & 3, 0, 'Compressed DEFLATE carrier is unsupported.');
            const count = bytes.readUInt16LE(at),
                inverse = bytes.readUInt16LE(at + 2);
            at += 4;
            assert.equal(count ^ inverse, 0xffff);
            assert.ok(at + count <= bytes.length && used + count <= size);
            if (output) bytes.copy(output, used, at, at + count);
            used += count;
            at += count;
        }
        assert.equal(at, bytes.length);
        assert.equal(used, size);
    };
    scan(null);
    const output = Buffer.alloc(size);
    scan(output);
    return output;
}
/** Strict bounded ZIP/level-zero DEFLATE readback of exactly the three selected carrier files. No extraction. */
export function inspectArtifactCarrier(raw, expected) {
    assert.ok(Buffer.isBuffer(raw) && raw.length >= 22 && raw.length <= CARRIER_LIMIT);
    assert.ok(expected instanceof Map && expected.size === 3);
    for (const [name, cap] of expected) {
        assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
        assert.ok(Number.isSafeInteger(cap) && cap > 0 && cap <= WEB_ARCHIVE_LIMITS.archive);
    }
    const end = raw.length - 22;
    assert.equal(raw.readUInt32LE(end), 0x06054b50);
    assert.equal(raw.readUInt16LE(end + 4), 0);
    assert.equal(raw.readUInt16LE(end + 6), 0);
    assert.equal(raw.readUInt16LE(end + 8), 3);
    assert.equal(raw.readUInt16LE(end + 10), 3);
    assert.equal(raw.readUInt16LE(end + 20), 0, 'Carrier comments/trailing bytes unsupported.');
    const centralBytes = raw.readUInt32LE(end + 12),
        central = raw.readUInt32LE(end + 16);
    assert.equal(central + centralBytes, end);
    const rows = [],
        names = new Set();
    let at = central,
        total = 0;
    for (let i = 0; i < 3; i++) {
        assert.ok(at + 46 <= end);
        assert.equal(raw.readUInt32LE(at), 0x02014b50);
        const flags = raw.readUInt16LE(at + 8),
            method = raw.readUInt16LE(at + 10),
            crc = raw.readUInt32LE(at + 16),
            compressed = raw.readUInt32LE(at + 20),
            size = raw.readUInt32LE(at + 24),
            length = raw.readUInt16LE(at + 28),
            extra = raw.readUInt16LE(at + 30),
            comment = raw.readUInt16LE(at + 32),
            offset = raw.readUInt32LE(at + 42),
            mode = raw.readUInt32LE(at + 38) >>> 16;
        assert.ok(!(flags & ~0x808) && [0, 8].includes(method));
        assert.equal(raw.readUInt16LE(at + 34), 0);
        assert.equal(comment, 0);
        assert.ok(at + 46 + length + extra <= end && length > 0 && length <= 200 && extra <= 16384);
        const nameBytes = raw.subarray(at + 46, at + 46 + length),
            name = nameBytes.toString('utf8');
        assert.ok(
            Buffer.from(name, 'utf8').equals(nameBytes) && expected.has(name) && !names.has(name),
        );
        names.add(name);
        assert.ok(
            (mode & 0o170000) === 0 || (mode & 0o170000) === 0o100000,
            'Carrier link/special file refused.',
        );
        assert.ok(
            !(raw.readUInt32LE(at + 38) & (0x10 | 0x400)),
            'Carrier directory/reparse point refused.',
        );
        assert.ok(size <= expected.get(name) && compressed <= CARRIER_LIMIT);
        if (method === 0)
            assert.equal(compressed, size, 'Stored carrier length differs before copying.');
        total += size;
        assert.ok(total <= CARRIER_LIMIT);
        extras(raw.subarray(at + 46 + length, at + 46 + length + extra));
        rows.push({ name, nameBytes, flags, method, crc, compressed, size, offset });
        at += 46 + length + extra;
    }
    assert.equal(at, end);
    assert.deepEqual([...names].sort(), [...expected.keys()].sort());
    rows.sort((a, b) => a.offset - b.offset);
    let next = 0;
    const files = new Map();
    for (const row of rows) {
        at = row.offset;
        assert.equal(at, next, 'Carrier gap/overlap/preamble refused.');
        assert.ok(at + 30 <= central);
        assert.equal(raw.readUInt32LE(at), 0x04034b50);
        assert.equal(raw.readUInt16LE(at + 6), row.flags);
        assert.equal(raw.readUInt16LE(at + 8), row.method);
        const length = raw.readUInt16LE(at + 26),
            extra = raw.readUInt16LE(at + 28);
        assert.equal(length, row.nameBytes.length);
        assert.ok(extra <= 16384 && at + 30 + length + extra <= central);
        assert.ok(raw.subarray(at + 30, at + 30 + length).equals(row.nameBytes));
        extras(raw.subarray(at + 30 + length, at + 30 + length + extra));
        for (const [field, value] of [
            [14, row.crc],
            [18, row.compressed],
            [22, row.size],
        ]) {
            const local = raw.readUInt32LE(at + field);
            assert.ok(local === value || (row.flags & 8 && local === 0));
        }
        const start = at + 30 + length + extra;
        next = start + row.compressed;
        assert.ok(next <= central);
        const data = raw.subarray(start, next),
            bytes = row.method === 0 ? Buffer.from(data) : storedDeflate(data, row.size);
        assert.equal(bytes.length, row.size);
        assert.equal(carrierCRC32(bytes), row.crc);
        if (row.flags & 8) {
            assert.ok(next + 12 <= central);
            if (raw.readUInt32LE(next) === 0x08074b50) next += 4;
            assert.ok(next + 12 <= central);
            assert.equal(raw.readUInt32LE(next), row.crc);
            assert.equal(raw.readUInt32LE(next + 4), row.compressed);
            assert.equal(raw.readUInt32LE(next + 8), row.size);
            next += 12;
        }
        files.set(row.name, bytes);
    }
    assert.equal(next, central);
    return files;
}
