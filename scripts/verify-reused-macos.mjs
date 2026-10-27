import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { macAsset, macManifest } from './lib/macos-release.mjs';
import { SOURCE_SHA, REUSED_MAC_ASSETS, validateReusedMacFiles } from './lib/release-recovery.mjs';
assert.equal(process.platform, 'darwin');
const arch = process.arch;
const files = {};
for (const name of [macAsset(arch), macAsset(arch) + '.sha256', macManifest(arch)]) {
    const bytes = await readFile(path.join('release', name));
    const expected = REUSED_MAC_ASSETS.find((asset) => asset.name === name);
    assert.equal(bytes.length, expected.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
    files[name] = bytes;
}
const manifest = validateReusedMacFiles(files, arch);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), SOURCE_SHA);
const extracted = await mkdtemp(path.resolve('release', 'verified-existing-' + arch + '-'));
execFileSync('/usr/bin/ditto', ['-x', '-k', path.resolve('release', macAsset(arch)), extracted]);
const verified = JSON.parse(
    execFileSync(
        process.execPath,
        ['scripts/verify-macos-package.mjs', path.join(extracted, 'Diagnostic Hub.app'), arch],
        { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: SOURCE_SHA } },
    )
        .trim()
        .split('\n')
        .at(-1),
);
assert.equal(verified.asarSHA256, manifest.asarSHA256);
assert.equal(verified.packagedSourceMatches, true);
assert.equal(verified.minimumMacOSVersion, manifest.minimumMacOSVersion);
console.log(
    JSON.stringify({
        existingArchive: macAsset(arch),
        sha256: manifest.sha256,
        source: SOURCE_SHA,
        nativeBundleReverified: true,
        repackaged: false,
        ...verified,
    }),
);
