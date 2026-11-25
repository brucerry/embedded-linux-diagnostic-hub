import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [os, arch] = process.argv.slice(2);
assert.equal(process.platform, os);
assert.equal(process.arch, arch);
const commit = execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim();
if (process.env.GITHUB_ACTIONS === 'true') assert.equal(commit, process.env.GITHUB_SHA);
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const shared = json('package.json');
const sharedLock = json('package-lock.json').packages;
const linux = json('scripts/ci/linux-package-lane/package.json');
const linuxLock = json('scripts/ci/linux-package-lane/package-lock.json').packages;
for (const [pkg, lock] of [[shared, sharedLock], [linux, linuxLock]]) {
    assert.equal(pkg.version, '0.6.0');
    for (const field of ['dependencies', 'devDependencies']) assert.deepEqual(pkg[field], lock[''][field]);
}
assert.equal(shared.devDependencies.electron, '44.5.1');
assert.equal(sharedLock['node_modules/electron'].version, '44.5.1');
assert.equal(shared.build.electronDist, undefined);
assert.ok(Object.values(sharedLock).every(entry => !entry.resolved?.startsWith('file:')));
const variant = sharedLock['node_modules/@esbuild/' + os + '-' + arch];
assert.equal(variant.version, '0.28.2');
assert.match(variant.integrity, /^sha512-/);
const inputPins = Object.values(linuxLock).filter(entry => entry.resolved?.startsWith('file:vendor/'));
assert.equal(inputPins.length, 8);
assert.equal(new Set(inputPins.map(entry => entry.resolved)).size, 8);
assert.ok(inputPins.every(entry => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)));
assert.equal(linux.build.electronDist, '.linux-package-inputs/electron-v44.5.1-linux-x64');
console.log(JSON.stringify({ validation: 'dependency-plan-only', commit, os, arch, qualification: false }));
