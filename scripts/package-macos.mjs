import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { macAsset, macManifest, validateMacManifest } from './lib/macos-release.mjs';

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
const bytes = await readFile(destination);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = {
    ...verified,
    commit,
    asset,
    sha256,
    signature: 'ad-hoc',
    notarized: false,
    distribution: true,
};
validateMacManifest(manifest, { arch, version: verified.version, commit, sha256 });
const roundtrip = await mkdtemp(path.resolve('release', 'macos-roundtrip-' + arch + '-'));
execFileSync('/usr/bin/ditto', ['-x', '-k', destination, roundtrip]);
const reopened = verify(path.join(roundtrip, 'Diagnostic Hub.app'));
assert.equal(reopened.asarSHA256, verified.asarSHA256);
assert.equal(reopened.version, verified.version);
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
