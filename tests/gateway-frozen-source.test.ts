import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { frozenGatewaySources } from './fixtures/gateway-frozen-source';
import { gitObjectID, sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';

const reference = JSON.parse(
    readFileSync(new URL('./fixtures/gateway-ownership-production.json', import.meta.url), 'utf8'),
);
test('frozen Gateway fixture supplies every original blob independently of current checkout bytes', () => {
    const files = frozenGatewaySources();
    assert.equal(files.size, 213);
    for (const row of reference.inventory) {
        const bytes = files.get(row.path)!;
        assert.equal(bytes.length, row.bytes);
        assert.equal(sourceDigest(bytes), row.sha256);
        assert.equal(gitObjectID('blob', bytes), row.blob);
    }
});

test('valid gzip containing wrong frozen source bytes refuses before returning fixture sources', () => {
    const bytes = gunzipSync(
        readFileSync(new URL('./fixtures/gateway-ownership-production.blobs.gz', import.meta.url)),
    );
    const index = reference.inventory.findIndex(
        (row: { path: string }) => row.path === 'backend/ssh/session.ts',
    );
    assert.ok(index >= 0);
    const offset = reference.inventory
        .slice(0, index)
        .reduce((sum: number, row: { bytes: number }) => sum + row.bytes, 0);
    bytes[offset] ^= 1;
    assert.throws(
        () => frozenGatewaySources(gzipSync(bytes)),
        /Frozen Gateway bytes differ: backend\/ssh\/session\.ts/,
    );
});

test('caller mutation cannot change later frozen fixture loads', () => {
    const first = frozenGatewaySources();
    first.get('gateway/server.ts')!.fill(0);
    first.clear();
    const second = frozenGatewaySources();
    const row = reference.inventory.find(
        (row: { path: string }) => row.path === 'gateway/server.ts',
    );
    assert.equal(second.size, 213);
    assert.equal(sourceDigest(second.get(row.path)!), row.sha256);
});
