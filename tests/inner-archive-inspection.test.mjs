import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { inspectInnerArchive } from '../scripts/lib/inner-archive-inspection.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function crc(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value ^= byte;
        for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
}
const files = () =>
    new Map([
        ['assets/main.js', Buffer.from('synthetic bytes, never executed')],
        ['capture-download-frame.js', Buffer.alloc(0)],
        ['capture-download-sw.js', Buffer.from('synthetic service worker')],
        ['index.html', Buffer.from('<p>synthetic shipping-shaped index</p>')],
    ]);
const rows = (input) =>
    [...input]
        .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
const record = (raw, payload, tarInventory) => ({
    archive: { bytes: raw.length, sha256: sha(raw) },
    payload,
    ...(tarInventory ? { tarInventory } : {}),
});

function zip(input, { method = 8, suffix = false, truncated = false } = {}) {
    const local = [],
        central = [];
    let offset = 0;
    for (const [filename, bytes] of input) {
        const name = Buffer.from(filename),
            head = Buffer.alloc(30),
            directory = Buffer.alloc(46);
        let encoded = method === 8 ? deflateRawSync(bytes) : bytes;
        if (suffix) encoded = Buffer.concat([encoded, Buffer.from('hidden suffix')]);
        if (truncated) encoded = encoded.subarray(0, -1);
        head.writeUInt32LE(0x04034b50);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(0x800, 6);
        head.writeUInt16LE(method, 8);
        head.writeUInt32LE(crc(bytes), 14);
        head.writeUInt32LE(encoded.length, 18);
        head.writeUInt32LE(bytes.length, 22);
        head.writeUInt16LE(name.length, 26);
        directory.writeUInt32LE(0x02014b50);
        directory.writeUInt16LE(3 * 256 + 20, 4);
        directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(0x800, 8);
        directory.writeUInt16LE(method, 10);
        directory.writeUInt32LE(crc(bytes), 16);
        directory.writeUInt32LE(encoded.length, 20);
        directory.writeUInt32LE(bytes.length, 24);
        directory.writeUInt16LE(name.length, 28);
        directory.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
        directory.writeUInt32LE(offset, 42);
        local.push(head, name, encoded);
        central.push(directory, name);
        offset += head.length + name.length + encoded.length;
    }
    const dir = Buffer.concat(central),
        end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(input.size, 8);
    end.writeUInt16LE(input.size, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, dir, end]);
}
function tar(input) {
    const dirs = new Set();
    for (const key of input.keys()) {
        const parts = key.split('/');
        parts.pop();
        while (parts.length) {
            dirs.add(parts.join('/'));
            parts.pop();
        }
    }
    const entries = [
        ...rows(input).map((row) => ({ kind: 'file', ...row, mode: 0o644 })),
        ...[...dirs].map((path) => ({ kind: 'directory', path, mode: 0o755 })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    const parts = [];
    for (const row of entries) {
        const head = Buffer.alloc(512),
            directory = row.kind === 'directory';
        head.write(row.path + (directory ? '/' : ''));
        for (const [start, width, value] of [
            [100, 8, row.mode],
            [108, 8, 0],
            [116, 8, 0],
            [124, 12, row.bytes ?? 0],
            [136, 12, 0],
        ])
            head.write(value.toString(8).padStart(width - 1, '0') + '\0', start, width);
        head.fill(32, 148, 156);
        head[156] = directory ? 53 : 48;
        head.write('ustar\0' + '00', 257);
        const checksum = head.reduce((sum, b) => sum + b, 0);
        head.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
        parts.push(head);
        if (!directory)
            parts.push(input.get(row.path), Buffer.alloc((512 - (row.bytes % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024));
    const expanded = Buffer.concat(parts);
    return {
        expanded,
        census: {
            format: 'ustar',
            entries,
            files: input.size,
            directories: dirs.size,
            payloadBytes: [...input.values()].reduce((sum, b) => sum + b.length, 0),
            expandedBytes: expanded.length,
        },
    };
}
const gatewayFiles = () =>
    new Map([
        ['LICENSE', Buffer.from('synthetic license')],
        ['README.md', Buffer.from('synthetic readme')],
        ['dist-gateway/main.cjs', Buffer.from('synthetic entry, never executed')],
        ['docs/gateway.md', Buffer.from('synthetic docs')],
        ['gateway/Caddyfile', Buffer.from('synthetic caddy')],
        ['.env.example', Buffer.from('synthetic env')],
        ['package-lock.json', Buffer.from('{}')],
        ['package.json', Buffer.from('{"version":"0.6.0","main":"dist-gateway/main.cjs"}')],
    ]);

for (const method of [0, 8])
    test('independent ZIP inspection accepts actual method ' + method + ' bytes', () => {
        const input = files();
        input.set('assets/é.js', Buffer.from('unicode filename'));
        const raw = zip(input, { method }),
            r = record(raw, rows(input));
        const result = inspectInnerArchive(raw, r, 'web');
        assert.deepEqual(result.payload, r.payload);
        assert.equal(result.status, 'matches-producer-inventory-unqualified');
        assert.equal(result.sourceProvenance, 'not-established');
        assert.equal(result.releaseAcceptance, false);
    });
test('ZIP inventory mismatch rejects after every enclosing archive hash is recomputed', () => {
    const original = files(),
        changed = files();
    changed.set('assets/main.js', Buffer.from('different compiled bytes'));
    const raw = zip(changed);
    assert.throws(() => inspectInnerArchive(raw, record(raw, rows(original)), 'web'));
});
test('ZIP missing, extra and aliased members cannot match an inventory', () => {
    for (const mode of ['missing', 'extra', 'case', 'traversal', 'prefix']) {
        const input = files(),
            wanted = rows(input);
        if (mode === 'missing') input.delete('index.html');
        if (mode === 'extra') input.set('extra.js', Buffer.from('extra'));
        if (mode === 'case') input.set('INDEX.HTML', Buffer.from('alias'));
        if (mode === 'traversal') input.set('../index.html', Buffer.from('traversal'));
        if (mode === 'prefix') input.set('assets', Buffer.from('file replaces directory'));
        const raw = zip(input);
        assert.throws(() => inspectInnerArchive(raw, record(raw, wanted), 'web'));
    }
});
test('ZIP CRC, local-name mismatch, links, descriptors, gaps and trailing bytes reject', () => {
    for (const kind of ['crc', 'name', 'link', 'descriptor', 'gap', 'suffix']) {
        const input = files();
        let raw = zip(input, { method: 0 });
        const central = raw.readUInt32LE(raw.length - 6);
        if (kind === 'crc') raw[30 + raw.readUInt16LE(26)] ^= 1;
        if (kind === 'name') raw[30] ^= 1;
        if (kind === 'link') raw.writeUInt32LE((0o120777 * 65536) >>> 0, central + 38);
        if (kind === 'descriptor') raw.writeUInt16LE(0x808, central + 8);
        if (kind === 'gap') raw.writeUInt32LE(1, central + 42);
        if (kind === 'suffix') raw = Buffer.concat([raw, Buffer.from('suffix')]);
        assert.throws(() => inspectInnerArchive(raw, record(raw, rows(input)), 'web'), kind);
    }
});
test('ZIP DEFLATE suffix and truncation reject even with consistent ZIP metadata and CRC', () => {
    for (const options of [{ suffix: true }, { truncated: true }]) {
        const input = files(),
            raw = zip(input, options);
        assert.throws(() => inspectInnerArchive(raw, record(raw, rows(input)), 'web'));
    }
});
test('ZIP expansion beyond the declared member is rejected by a bounded decoder', () => {
    const input = new Map([['index.html', Buffer.alloc(32768, 65)]]),
        raw = zip(input);
    const central = raw.readUInt32LE(raw.length - 6);
    raw.writeUInt32LE(1, 22);
    raw.writeUInt32LE(1, central + 24);
    assert.throws(() =>
        inspectInnerArchive(
            raw,
            record(raw, [{ path: 'index.html', bytes: 1, sha256: sha(Buffer.from('A')) }]),
            'web',
        ),
    );
});
test('inventory resource and path preflight rejects before decoding', () => {
    const raw = zip(files());
    for (const payload of [
        [{ path: 'index.html', bytes: 64 * 1024 ** 2 + 1, sha256: 'a'.repeat(64) }],
        [{ path: 'con', bytes: 0, sha256: sha(Buffer.alloc(0)) }],
        [
            { path: 'a', bytes: 0, sha256: sha(Buffer.alloc(0)) },
            { path: 'a/b', bytes: 0, sha256: sha(Buffer.alloc(0)) },
        ],
    ])
        assert.throws(() => inspectInnerArchive(raw, record(raw, payload), 'web'));
});
test('independent gzip/USTAR inspection matches file hashes plus directory/mode census', () => {
    const input = gatewayFiles(),
        { expanded, census } = tar(input),
        raw = gzipSync(expanded);
    const result = inspectInnerArchive(raw, record(raw, rows(input), census), 'gateway');
    assert.deepEqual(result.tarInventory, census);
    assert.equal(result.releaseAcceptance, false);
});
test('Gateway actual payload mismatch is rejected with newly recomputed gzip/hash metadata', () => {
    const input = gatewayFiles(),
        wanted = rows(input);
    input.set('dist-gateway/main.cjs', Buffer.from('changed entry'));
    const { expanded, census } = tar(input),
        raw = gzipSync(expanded);
    assert.throws(() => inspectInnerArchive(raw, record(raw, wanted, census), 'gateway'));
});
test('Gateway gzip CRC/ISIZE, concatenation, compressed suffix and truncation reject', () => {
    const input = gatewayFiles(),
        { expanded, census } = tar(input);
    for (const kind of ['crc', 'size', 'concat', 'suffix', 'truncate', 'flags']) {
        let raw = gzipSync(expanded);
        if (kind === 'crc') raw[raw.length - 8] ^= 1;
        if (kind === 'size') raw[raw.length - 4] ^= 1;
        if (kind === 'concat') raw = Buffer.concat([raw, gzipSync(Buffer.alloc(0))]);
        if (kind === 'suffix')
            raw = Buffer.concat([raw.subarray(0, -8), Buffer.from('hidden'), raw.subarray(-8)]);
        if (kind === 'truncate') raw = Buffer.concat([raw.subarray(0, -9), raw.subarray(-8)]);
        if (kind === 'flags') raw[3] = 8;
        assert.throws(
            () => inspectInnerArchive(raw, record(raw, rows(input), census), 'gateway'),
            kind,
        );
    }
});
test('Gateway rejects forged tar checksum, padding, links, unknown directories and end marker', () => {
    const input = gatewayFiles(),
        original = tar(input);
    for (const kind of ['checksum', 'padding', 'link', 'directory', 'end']) {
        let expanded = Buffer.from(original.expanded),
            census = structuredClone(original.census);
        if (kind === 'checksum') expanded[0] ^= 1;
        if (kind === 'padding') expanded[512 + input.get('.env.example').length] = 1;
        if (kind === 'link') {
            expanded[156] = 50;
            expanded.fill(32, 148, 156);
            expanded.write(
                expanded
                    .subarray(0, 512)
                    .reduce((s, b) => s + b, 0)
                    .toString(8)
                    .padStart(6, '0') + '\0 ',
                148,
            );
        }
        if (kind === 'directory')
            census.entries = census.entries.filter((row) => row.path !== 'docs');
        if (kind === 'end') {
            expanded = expanded.subarray(0, -512);
            census.expandedBytes -= 512;
        }
        const raw = gzipSync(expanded);
        assert.throws(
            () => inspectInnerArchive(raw, record(raw, rows(input), census), 'gateway'),
            kind,
        );
    }
});
test('Gateway decompression must fit its declared complete tar length', () => {
    const input = gatewayFiles(),
        { expanded, census } = tar(input),
        raw = gzipSync(expanded);
    census.expandedBytes = 1024;
    assert.throws(() => inspectInnerArchive(raw, record(raw, rows(input), census), 'gateway'));
});

// Checksum bytes are excluded from the computed tar checksum; high bits must never be masked.
test('Gateway checksum field rejects high-bit digit and terminator aliases with valid enclosing hashes', () => {
    const input = gatewayFiles(),
        { expanded, census } = tar(input);
    for (const position of [148, 153, 154, 155]) {
        const changed = Buffer.from(expanded);
        changed[position] |= 0x80;
        const raw = gzipSync(changed);
        assert.throws(() => inspectInnerArchive(raw, record(raw, rows(input), census), 'gateway'));
    }
});
