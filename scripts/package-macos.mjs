import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { macAsset, macManifest, validateMacManifest } from './lib/macos-release.mjs';
import {
    inventoryMacPayload,
    macPayloadIdentity,
    sampleMacArchive,
} from './lib/macos-payload-identity.mjs';

assert.equal(process.platform, 'darwin', 'Mac packaging must run on macOS.');
const [app, arch] = process.argv.slice(2);
assert.ok(
    app && ['x64', 'arm64'].includes(arch),
    'Usage: node scripts/package-macos.mjs app.app x64|arm64',
);
assert.equal(process.arch, arch, 'Package the native architecture.');
const commit =
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.match(commit, /^[a-f0-9]{40}$/);
const env = { ...process.env, GITHUB_SHA: commit };
function verify(bundle) {
    const output = execFileSync(
        process.execPath,
        ['scripts/verify-macos-package.mjs', bundle, arch],
        { encoding: 'utf8', env },
    );
    return JSON.parse(output.trim().split('\n').at(-1));
}
const verified = verify(app);
const originalPayload = macPayloadIdentity(await inventoryMacPayload(path.resolve(app)));
assert.equal(originalPayload.asarSHA256, verified.asarSHA256);
const asset = macAsset(arch);
const destination = path.resolve('release', asset);
await mkdir('release', { recursive: true });
execFileSync('/usr/bin/ditto', [
    '-c',
    '-k',
    '--sequesterRsrc',
    '--keepParent',
    path.resolve(app),
    destination,
]);
const archiveBefore = await sampleMacArchive(destination);
const sha256 = archiveBefore.sha256;
const manifest = {
    ...verified,
    commit,
    asset,
    sha256,
    signature: 'ad-hoc',
    notarized: false,
    distribution: true,
};
const roundtrip = await mkdtemp(path.resolve('release', 'macos-roundtrip-' + arch + '-'));
execFileSync('/usr/bin/ditto', ['-x', '-k', destination, roundtrip]);
const reopened = verify(path.join(roundtrip, 'Diagnostic Hub.app'));
assert.equal(reopened.asarSHA256, verified.asarSHA256);
assert.equal(reopened.version, verified.version);
const payloadIdentity = macPayloadIdentity(
    await inventoryMacPayload(path.join(roundtrip, 'Diagnostic Hub.app')),
);
assert.deepEqual(
    payloadIdentity,
    originalPayload,
    'Reopened shipping archive payload differs from verified input.',
);
assert.deepEqual(
    await sampleMacArchive(destination),
    archiveBefore,
    'Shipping archive changed during roundtrip inspection.',
);
manifest.payloadIdentity = payloadIdentity;
validateMacManifest(manifest, { arch, version: verified.version, commit, sha256 });
await writeFile(path.resolve('release', asset + '.sha256'), sha256 + '  ' + asset + '\n');
await writeFile(
    path.resolve('release', macManifest(arch)),
    JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
    JSON.stringify({
        asset,
        arch,
        version: manifest.version,
        commit,
        sha256,
        roundtripSourceMatches: true,
        notarized: false,
    }),
);
