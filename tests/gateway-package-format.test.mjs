import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { encodeGatewayTar, inspectOwnedGatewayTar } from '../scripts/lib/gateway-tar.mjs';
import { GATEWAY_PAYLOAD_FILES } from '../scripts/lib/gateway-lock-plan.mjs';
import { inspectInnerArchive } from '../scripts/lib/inner-archive-inspection.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const payload = () =>
    new Map(
        GATEWAY_PAYLOAD_FILES.map((name) => [name, Buffer.from('authored payload for ' + name)]),
    );
function fixture() {
    const files = payload(),
        raw = encodeGatewayTar(files),
        tarInventory = inspectOwnedGatewayTar(raw, files);
    const rows = [...files]
        .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, raw, tarInventory, rows };
}
function read(raw, f) {
    const gzip = gzipSync(raw);
    return inspectInnerArchive(
        gzip,
        {
            archive: { bytes: gzip.length, sha256: hash(gzip) },
            payload: f.rows,
            tarInventory: { ...f.tarInventory, expandedBytes: raw.length },
        },
        'gateway',
    );
}
function checksum(raw) {
    raw.fill(32, 148, 156);
    const sum = raw
        .subarray(0, 512)
        .reduce((n, v) => n + v, 0)
        .toString(8);
    raw.write(sum.padStart(6, '0') + '\0 ', 148, 8, 'ascii');
}
test('shared canonical writer reaches the unchanged strict reader and is independent of Map order', () => {
    const f = fixture();
    assert.ok(encodeGatewayTar(new Map([...f.files].reverse())).equals(f.raw));
    const result = read(f.raw, f);
    assert.equal(result.status, 'matches-producer-inventory-unqualified');
    assert.equal(result.releaseAcceptance, false);
    assert.equal(result.tarInventory.directories, 3);
    assert.equal(result.tarInventory.files, 8);
    assert.ok(f.raw.subarray(-1024).equals(Buffer.alloc(1024)));
});
for (const kind of ['gnu-header', 'dot-prefix', 'uid', 'mtime', 'record-padding', 'payload'])
    test('strict reader still rejects ' + kind, () => {
        const f = fixture();
        let raw = Buffer.from(f.raw);
        if (kind === 'gnu-header') {
            raw.write('ustar ', 257, 6, 'ascii');
            raw.write(' \0', 263, 2, 'ascii');
            checksum(raw);
        }
        if (kind === 'dot-prefix') {
            const end = raw.indexOf(0);
            const name = raw.subarray(0, end).toString();
            raw.fill(0, 0, 100);
            raw.write('./' + name, 0, 100, 'utf8');
            checksum(raw);
        }
        if (kind === 'uid') {
            raw.write('0000001\0', 108, 8, 'ascii');
            checksum(raw);
        }
        if (kind === 'mtime') {
            raw.write('00000000001\0', 136, 12, 'ascii');
            checksum(raw);
        }
        if (kind === 'record-padding') raw = Buffer.concat([raw, Buffer.alloc(512)]);
        if (kind === 'payload') raw[512] ^= 1;
        assert.throws(() => read(raw, f));
    });
test('writer refuses missing/extra payload identities before encoding', () => {
    const missing = payload();
    missing.delete('LICENSE');
    assert.throws(() => encodeGatewayTar(missing));
    const extra = payload();
    extra.set('../escape', Buffer.from('x'));
    assert.throws(() => encodeGatewayTar(extra));
});

test('aggregate verification explicitly selects only the Gateway format cohort', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(
        manifest.scripts['test:gateway-format'],
        'node --test tests/gateway-package-format.test.mjs',
    );
    const phases = manifest.scripts.verify.split('&&').map((value) => value.trim());
    assert.equal(phases.filter((value) => value === 'npm run test:gateway-format').length, 1);
    assert.ok(phases.includes('npm run test:catalog-boundary'));
    assert.ok(!manifest.scripts['test:gateway-format'].includes('*.test.mjs'));
});
