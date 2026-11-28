import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateNativeRuntimeIdentity } from './staged-artifact-gate.mjs';

const hash = /^[a-f0-9]{64}$/;
const MAX_RECEIPT = 32 * 1024;
const layoutAsset = Object.freeze({
    'linux-folder': ['Diagnostic-Hub-linux-x64.tar.gz', 'archive-runtime-identity'],
    'linux-appimage': ['Diagnostic-Hub-linux-x64.AppImage', 'appimage-runtime-identity'],
});

/** Join independently selected artifact, installed executable and runtime-record hashes.
 * This is readback consistency only. It cannot establish that a reporter observed exit,
 * that an installer was run, or that the selected inputs constitute an approved release.
 */
export function inspectLinuxPackageRuntimeReadback(selection, raw) {
    assert.ok(selection && Object.hasOwn(layoutAsset, selection.layout), 'Unknown Linux layout');
    const [asset, caseId] = layoutAsset[selection.layout];
    assert.equal(selection.asset, asset, 'Package selection does not match Linux layout');
    for (const key of ['assetSHA256', 'observationSHA256', 'executableSHA256', 'asarSHA256'])
        assert.ok(typeof selection[key] === 'string' && hash.test(selection[key]), 'Missing hash: ' + key);
    for (const key of ['sourceCommit', 'sourceTree'])
        assert.ok(typeof selection[key] === 'string' && /^[a-f0-9]{40}$/.test(selection[key]));
    for (const key of ['runId', 'runAttempt'])
        assert.ok(typeof selection[key] === 'string' && /^[1-9][0-9]{0,31}$/.test(selection[key]));
    assert.ok(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= MAX_RECEIPT);
    assert.equal(createHash('sha256').update(raw).digest('hex'), selection.observationSHA256,
        'Native observation differs from selected bytes');
    const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    assert.ok(record && typeof record === "object" && !Array.isArray(record));
    assert.deepEqual(Object.keys(record).sort(),
        ['kind', 'packageSHA256', 'runAttempt', 'runId', 'runtime', 'sourceCommit', 'sourceTree']);
    for (const key of ['sourceCommit', 'sourceTree', 'runId', 'runAttempt'])
        assert.equal(record[key], selection[key], 'Observation context differs: ' + key);
    assert.equal(record.kind, 'linux-package-runtime-readback/v1');
    assert.equal(record.packageSHA256, selection.assetSHA256, 'Observation belongs to a different package digest');
    const runtime = validateNativeRuntimeIdentity(record.runtime, {
        lane: 'linux-x64', caseId, version: selection.version,
    });
    assert.equal(runtime.executableSHA256, selection.executableSHA256, 'Different installed executable bytes');
    assert.equal(runtime.asarSHA256, selection.asarSHA256, 'Different installed app.asar bytes');
    return Object.freeze({ asset, caseId, status: 'readback-consistent', releaseAcceptance: false });
}
