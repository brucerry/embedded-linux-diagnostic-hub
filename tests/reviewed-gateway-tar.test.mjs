import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GATEWAY_PAYLOAD_FILES } from '../scripts/lib/gateway-lock-plan.mjs';
import { encodeGatewayTar } from '../scripts/lib/gateway-tar.mjs';
import {
    encodeReviewedGatewayTar, verifyReviewedGatewayTarMember,
} from '../scripts/lib/reviewed-gateway-tar.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const main = 'dist-gateway/main.cjs';
const files = () => new Map(GATEWAY_PAYLOAD_FILES.map((name) => [name, Buffer.from('fixture ' + name)]));

test('packaged bundle matches the separate compiler and archive readback', () => {
    const map = files();
    const bundleSHA256 = digest(map.get(main));
    const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1,
        kind: 'isolated-gateway-compiler-readback', bundleSHA256, runtimeExecuted: false, releaseAdmission: false }));
    const selection = { bundleSHA256, receiptSHA256: digest(receipt) };
    const raw = encodeReviewedGatewayTar(map, receipt, selection);
    assert.deepEqual(verifyReviewedGatewayTarMember(raw, bundleSHA256),
        { bundleSHA256, releaseAdmission: false });
    assert.throws(() => encodeReviewedGatewayTar(map, Buffer.concat([receipt, Buffer.from(' ')]), selection),
        /Different selected compiler receipt/);
    map.set(main, Buffer.from('previous conventional Gateway distribution'));
    assert.throws(() => encodeReviewedGatewayTar(map, receipt, selection), /Stale or substituted/);
    assert.throws(() => verifyReviewedGatewayTarMember(encodeGatewayTar(map), bundleSHA256),
        /Archive member hash differs/);
});
