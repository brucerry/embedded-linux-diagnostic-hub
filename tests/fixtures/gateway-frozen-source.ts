import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { RAW_CLI_REFERENCE } from '../../scripts/lib/instrumented-gateway-source.mjs';
import { gitObjectID, sourceDigest } from '../../scripts/lib/committed-source-bridge.mjs';

// Original private wrapper from 4a88f528657e023e852b41847a80f471c053530b.
// Preserve its admitted byte shape independently of formatting the maintained source.
export function frozenGatewayPreimportTarget(): Buffer {
    const bytes = readFileSync(new URL('./gateway-preimport-target.frozen', import.meta.url));
    assert.equal(bytes.length, 253);
    assert.equal(
        sourceDigest(bytes),
        '79fc20fc3aea62e89012ceddc050c19b09d6a8ae2cacfba1e95486842f1cb518',
    );
    assert.equal(gitObjectID('blob', bytes), '0bf0a46a10017e92c8ea835c9bca2cb5c63283ba');
    return bytes;
}

// Data only: concatenated original Git blobs in the unchanged inventory order.
// Bundling these bytes keeps shallow checkouts independent of old Git objects/network access.
export function frozenGatewaySources(
    archive = readFileSync(new URL('./gateway-ownership-production.blobs.gz', import.meta.url)),
): Map<string, Buffer> {
    const reference = JSON.parse(
        readFileSync(new URL('./gateway-ownership-production.json', import.meta.url), 'utf8'),
    );
    assert.equal(reference.sourceCommit, RAW_CLI_REFERENCE.sourceCommit);
    assert.equal(reference.sourceTree, RAW_CLI_REFERENCE.sourceTree);
    assert.equal(reference.inventorySHA256, RAW_CLI_REFERENCE.productionInventorySHA256);
    assert.equal(reference.inventory.length, RAW_CLI_REFERENCE.productionFiles);
    assert.equal(sourceDigest(JSON.stringify(reference.inventory)), reference.inventorySHA256);
    const total = reference.inventory.reduce(
        (sum: number, row: { bytes: number }) => sum + row.bytes,
        0,
    );
    assert.ok(archive.length > 0 && archive.length <= 4 * 1024 ** 2);
    assert.ok(Number.isSafeInteger(total) && total > 0 && total <= 4 * 1024 ** 2);
    const bytes = gunzipSync(archive, { maxOutputLength: total });
    assert.equal(bytes.length, total, 'Incomplete frozen Gateway blob inventory.');
    const files = new Map<string, Buffer>();
    let offset = 0;
    for (const row of reference.inventory) {
        const blob = bytes.subarray(offset, offset + row.bytes);
        assert.equal(sourceDigest(blob), row.sha256, 'Frozen Gateway bytes differ: ' + row.path);
        assert.equal(
            gitObjectID('blob', blob),
            row.blob,
            'Frozen Gateway object differs: ' + row.path,
        );
        assert.ok(!files.has(row.path));
        files.set(row.path, Buffer.from(blob));
        offset += row.bytes;
    }
    return files;
}
