import assert from 'node:assert/strict';
import { sourceDigest } from './committed-source-bridge.mjs';
import { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';
import { LinuxTarCensus } from './linux-archive-members.mjs';
import { GATEWAY_PAYLOAD_FILES } from './gateway-lock-plan.mjs';

function entries(files) {
    assert.ok(files instanceof Map);
    assert.deepEqual([...files.keys()].sort(), [...GATEWAY_PAYLOAD_FILES].sort());
    const values = [],
        directories = new Set();
    let total = 0;
    for (const [path, bytes] of files) {
        assert.ok(Buffer.isBuffer(bytes) && bytes.length <= WEB_ARCHIVE_LIMITS.member);
        total += bytes.length;
        assert.ok(total <= WEB_ARCHIVE_LIMITS.expanded);
        const parts = path.split('/');
        parts.pop();
        while (parts.length) {
            directories.add(parts.join('/'));
            parts.pop();
        }
        values.push({
            kind: 'file',
            path,
            mode: 0o644,
            bytes: bytes.length,
            sha256: sourceDigest(bytes),
        });
    }
    assert.ok(files.get('dist-gateway/main.cjs').length > 0);
    for (const path of directories) values.push({ kind: 'directory', path, mode: 0o755 });
    return values.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/** Canonical USTAR writer for this exact eight-file layout; never truncates a path or invokes tar. */
export function encodeGatewayTar(files) {
    const inventory = entries(files),
        chunks = [];
    const octal = (header, at, width, number) => {
        const value = number.toString(8);
        assert.ok(value.length <= width - 1);
        header.write(value.padStart(width - 1, '0') + '\0', at, width, 'ascii');
    };
    for (const entry of inventory) {
        const header = Buffer.alloc(512),
            name = entry.path + (entry.kind === 'directory' ? '/' : '');
        assert.ok(Buffer.byteLength(name) <= 100);
        header.write(name, 0, 100, 'utf8');
        octal(header, 100, 8, entry.mode);
        octal(header, 108, 8, 0);
        octal(header, 116, 8, 0);
        octal(header, 124, 12, entry.bytes ?? 0);
        octal(header, 136, 12, 0);
        header.fill(32, 148, 156);
        header[156] = entry.kind === 'directory' ? 53 : 48;
        Buffer.from('ustar\0').copy(header, 257);
        Buffer.from('00').copy(header, 263);
        const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8);
        assert.ok(checksum.length <= 6);
        header.write(checksum.padStart(6, '0') + '\0 ', 148, 8, 'ascii');
        chunks.push(header);
        if (entry.kind === 'file') {
            const bytes = files.get(entry.path);
            chunks.push(bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
        }
    }
    chunks.push(Buffer.alloc(1024));
    return Buffer.concat(chunks);
}
/** Strict owned-stage census plus byte-exact canonical header/padding check, without extraction. */
export function inspectOwnedGatewayTar(bytes, files) {
    assert.ok(
        Buffer.isBuffer(bytes) && bytes.length <= WEB_ARCHIVE_LIMITS.expanded + 4096 * 1024 + 1024,
    );
    const census = new LinuxTarCensus();
    for (let at = 0; at < bytes.length; at += 65536) census.push(bytes.subarray(at, at + 65536));
    const value = census.finish();
    assert.deepEqual(value.entries, entries(files));
    assert.ok(bytes.equals(encodeGatewayTar(files)), 'Noncanonical Gateway tar bytes.');
    return value;
}
