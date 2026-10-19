import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ptyObservationMode } from './hosted-pilot-contract.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const ptyObservationPolicy = Object.freeze({
    schema: 1,
    kind: 'windows-hosted-pty-observation-policy-v1',
    mode: ptyObservationMode,
    stages: Object.freeze(['real-os-pty']),
    helpers: 1,
    nativeApplicationStages: 0,
    nativeElectronStoreCycles: 0,
    canaries: 0,
    warmup: false,
    attempts: 1,
    reruns: 0,
    collectionApproval: false,
});
export function parsePtyObservationScope(bytes, expectedSHA256, sourceSHA256, policySHA256) {
    assert(Buffer.isBuffer(bytes) && bytes.length <= 8192);
    for (const value of [expectedSHA256, sourceSHA256, policySHA256])
        assert(/^[a-f0-9]{64}$/.test(value));
    assert.equal(hash(bytes), expectedSHA256, 'Exact PTY scope bytes changed.');
    const scope = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(scope, {
        ...ptyObservationPolicy,
        kind: 'windows-hosted-pty-observation-scope-v1',
        reviewed: true,
        sourceSHA256,
        policySHA256,
    });
    return Object.freeze(scope);
}
export function parsePtyObservationPolicy(bytes, expectedSHA256) {
    assert(Buffer.isBuffer(bytes) && bytes.length <= 8192);
    assert.equal(hash(bytes), expectedSHA256);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), ptyObservationPolicy);
}
