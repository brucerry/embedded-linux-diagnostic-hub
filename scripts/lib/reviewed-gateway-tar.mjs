import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeGatewayTar, inspectOwnedGatewayTar } from './gateway-tar.mjs';
import { LinuxTarCensus } from './linux-archive-members.mjs';
import { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';

const MAIN = 'dist-gateway/main.cjs';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const valid = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Compiler review only. The caller selects receipt and bundle separately.
 * Entry hash is not complete source identity. No trust or release verdict.
 */
export function encodeReviewedGatewayTar(files, receiptBytes, selection) {
    assert.ok(valid(selection.receiptSHA256) && valid(selection.bundleSHA256));
    assert.ok(Buffer.isBuffer(receiptBytes) && receiptBytes.length > 0 && receiptBytes.length <= 4096);
    assert.equal(digest(receiptBytes), selection.receiptSHA256, 'Different selected compiler receipt');
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes));
    assert.ok(record && typeof record === 'object' && !Array.isArray(record));
    assert.ok(record.kind === 'isolated-gateway-compiler-readback' && record.schemaVersion === 1
        && record.runtimeExecuted === false && record.releaseAdmission === false);
    assert.equal(record.bundleSHA256, selection.bundleSHA256, 'Receipt belongs to a different bundle');
    const main = files.get(MAIN);
    assert.ok(Buffer.isBuffer(main) && main.length > 0 && main.length <= WEB_ARCHIVE_LIMITS.member);
    assert.equal(digest(main), selection.bundleSHA256, 'Stale or substituted Gateway member bytes');
    // Check the identical map consumed by the encoder, not a path opened a second time.
    const tar = encodeGatewayTar(files);
    inspectOwnedGatewayTar(tar, files);
    verifyReviewedGatewayTarMember(tar, selection.bundleSHA256);
    return tar;
}

/** Separate raw archive readback with no filesystem extraction and no staging-map oracle. */
export function verifyReviewedGatewayTarMember(rawTar, expectedBundleSHA256) {
    assert.ok(valid(expectedBundleSHA256) && Buffer.isBuffer(rawTar) && rawTar.length > 0
        && rawTar.length <= WEB_ARCHIVE_LIMITS.expanded + 4096 * 1024 + 1024);
    const census = new LinuxTarCensus();
    for (let i = 0; i < rawTar.length; i += 65536) census.push(rawTar.subarray(i, i + 65536));
    const matches = census.finish().entries.filter((row) => row.path === MAIN && row.kind === 'file');
    assert.equal(matches.length, 1, 'Missing or duplicate Gateway bundle in tar');
    assert.equal(matches[0].sha256, expectedBundleSHA256, 'Archive member hash differs from selected bundle');
    return Object.freeze({ bundleSHA256: matches[0].sha256, releaseAdmission: false });
}
