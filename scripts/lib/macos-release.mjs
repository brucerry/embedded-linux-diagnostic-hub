import assert from 'node:assert/strict';

export const MAC_ARCHES = ['x64', 'arm64'];
export const macAsset = (arch) => `Diagnostic-Hub-macos-${arch}.zip`;
export const macManifest = (arch) => `macos-build-info-${arch}.json`;

export function validateMacManifest(info, { arch, version, commit, sha256 }) {
    assert.ok(MAC_ARCHES.includes(arch), 'Unsupported Mac architecture.');
    assert.equal(info.platform, 'darwin');
    assert.equal(info.arch, arch);
    assert.equal(info.version, version);
    assert.match(info.commit, /^[a-f0-9]{40}$/);
    assert.equal(info.commit, commit);
    assert.equal(info.asset, macAsset(arch));
    assert.match(info.sha256, /^[a-f0-9]{64}$/);
    assert.equal(info.sha256, sha256);
    assert.match(info.asarSHA256, /^[a-f0-9]{64}$/);
    assert.equal(info.bundleIdentifier, 'dev.diagnostichub.desktop');
    assert.match(info.minimumMacOSVersion, /^\d+\.\d+(?:\.\d+)?$/);
    assert.equal(info.signature, 'ad-hoc');
    assert.equal(info.adHocIntegrityVerified, true);
    assert.equal(info.notarized, false);
    assert.equal(info.gatekeeperDownloadedAppQualified, false);
    return info;
}
