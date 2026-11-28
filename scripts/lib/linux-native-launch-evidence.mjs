import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectLinuxPackageRuntimeReadback } from './linux-native-package-readback.mjs';

/** Independently bound direct-exit evidence; not a native qualification or cleanup decision. */
export function inspectLinuxNativeLaunchEvidence(selection, runtimeBytes, closureBytes) {
    const readback = inspectLinuxPackageRuntimeReadback(selection, runtimeBytes);
    assert.ok(Number.isSafeInteger(selection.launcherPID) && selection.launcherPID > 0,
        'Expected an independently observed launcher PID');
    assert.ok(Buffer.isBuffer(closureBytes) && closureBytes.length > 0 && closureBytes.length <= 4096);
    const selected = selection.closureSHA256;
    assert.ok(typeof selected === 'string' && /^[a-f0-9]{64}$/.test(selected));
    assert.notEqual(selected, selection.observationSHA256, 'Runtime bytes cannot also be exit evidence');
    assert.equal(createHash('sha256').update(closureBytes).digest('hex'), selected,
        'Exit observation differs from selected bytes');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(closureBytes));
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [
        'code', 'kind', 'pid', 'processTreeRetired', 'releaseAcceptance', 'stderrEOF', 'stdoutEOF',
    ]);
    assert.equal(value.kind, 'linux-owned-direct-child-observation/v1');
    assert.equal(value.pid, selection.launcherPID, 'Exit belongs to a different owned launcher');
    assert.equal(value.code, 0);
    assert.equal(value.stderrEOF, true);
    assert.equal(value.stdoutEOF, true);
    assert.equal(value.processTreeRetired, 'not-verified');
    assert.equal(value.releaseAcceptance, false);
    return Object.freeze({
        ...readback,
        directExit: 'consistent',
        processTreeRetired: 'not-verified',
        cleanupAuthorized: false,
    });
}
