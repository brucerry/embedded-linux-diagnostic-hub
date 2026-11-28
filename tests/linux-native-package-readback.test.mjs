import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectLinuxPackageRuntimeReadback } from '../scripts/lib/linux-native-package-readback.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(layout = 'linux-folder') {
    const asset =
        'Diagnostic-Hub-linux-x64' + (layout === 'linux-folder' ? '.tar.gz' : '.AppImage');
    const context = { sourceCommit: '4'.repeat(40), sourceTree: '5'.repeat(40), runId: '200', runAttempt: '2' };
    return {
        selection: {
            ...context,
            layout, asset, version: '0.6.0', assetSHA256: '1'.repeat(64),
            executableSHA256: '2'.repeat(64), asarSHA256: '3'.repeat(64),
        },
        record: {
            ...context,
            kind: 'linux-package-runtime-readback/v1', packageSHA256: '1'.repeat(64),
            runtime: {
                asset, packaged: true, version: '0.6.0', platform: 'linux', arch: 'x64',
                executable: '/fixture/Diagnostic-Hub', asar: '/fixture/resources/app.asar',
                executableSHA256: '2'.repeat(64), asarSHA256: '3'.repeat(64), rendererPID: 123,
                contextsSeparated: true, pageNodeAbsent: true, osSandboxed: true, sandbox: true,
                versions: {electron: '44.5.1', node: '24.15.0', chrome: '146.0.0'},
            },
        },
    };
}
function bytes(f) {
    const raw = Buffer.from(JSON.stringify(f.record));
    f.selection.observationSHA256 = digest(raw);
    return raw;
}

test('Linux package readback retains separate native asset bindings, never acceptance', () => {
    for (const [layout, caseId] of [
        ['linux-folder', 'archive-runtime-identity'],
        ['linux-appimage', 'appimage-runtime-identity'],
    ]) {
        const f = fixture(layout);
        const result = inspectLinuxPackageRuntimeReadback(f.selection, bytes(f));
        assert.equal(result.caseId, caseId);
        assert.equal(result.releaseAcceptance, false);
    }
});
test('edited and honestly rehashed wrong payload/runtime records are refused', () => {
    const f = fixture(), raw = bytes(f);
    assert.throws(
        () => inspectLinuxPackageRuntimeReadback(f.selection, Buffer.concat([raw, Buffer.from(' ')])),
        /differs from selected bytes/,
    );
    for (const [change, expected] of [
        [(x) => { x.record.runAttempt = '1'; }, /context differs: runAttempt/],
        [(x) => { x.record.sourceTree = 'a'.repeat(40); }, /context differs: sourceTree/],
        [(x) => { x.record.packageSHA256 = 'a'.repeat(64); }, /different package/],
        [(x) => { x.record.runtime.executableSHA256 = 'a'.repeat(64); }, /installed executable/],
        [(x) => { x.record.runtime.asarSHA256 = 'a'.repeat(64); }, /installed app\.asar/],
        [(x) => { x.record.runtime.asset = 'Diagnostic-Hub-linux-x64.AppImage'; }, /different staged asset/],
        [(x) => { x.record.runtime.sandbox = false; }, /native observation: sandbox/],
    ]) {
        const x = fixture();
        change(x);
        assert.throws(() => inspectLinuxPackageRuntimeReadback(x.selection, bytes(x)), expected);
    }
});

test('Linux direct closure is independently selected and does not authorize cleanup', async () => {
    const { inspectLinuxNativeLaunchEvidence } =
        await import('../scripts/lib/linux-native-launch-evidence.mjs');
    const f = fixture(), raw = bytes(f), child = {
        code: 0, kind: 'linux-owned-direct-child-observation/v1', pid: 42, processTreeRetired: 'not-verified',
        releaseAcceptance: false, stderrEOF: true, stdoutEOF: true,
    };
    f.selection.launcherPID = child.pid;
    const inspect = (payload, updateDigest = true) => {
        const selected = Buffer.from(JSON.stringify(payload));
        if (updateDigest) f.selection.closureSHA256 = digest(selected);
        return inspectLinuxNativeLaunchEvidence(f.selection, raw, selected);
    };
    const result = inspect(child);
    assert.equal(result.directExit, 'consistent');
    assert.equal(result.cleanupAuthorized, false);
    assert.equal(result.releaseAcceptance, false);
    assert.throws(() => inspect({ ...child, pid: 43 }, false), /differs from selected bytes/);
    assert.throws(() => inspect({ ...child, pid: 43 }), /different owned launcher/);
    for (const patch of [{ code: 1 }, { stderrEOF: false }, { processTreeRetired: true }]) {
        assert.throws(() => inspect({ ...child, ...patch }));
    }
});
