import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = process.argv[2];
assert.ok(output && path.isAbsolute(output), 'Pass an absolute, unused output directory');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.ok(process.report.getReport().header.glibcVersionRuntime);

const lock = JSON.parse(await readFile(new URL('../../../package-lock.json', import.meta.url)));
const allowed = [
    '@oxc-project/types', '@rolldown/binding-linux-x64-gnu', '@rolldown/pluginutils',
    'detect-libc', 'fdir', 'lightningcss', 'lightningcss-linux-x64-gnu', 'nanoid',
    'picocolors', 'picomatch', 'postcss', 'rolldown', 'source-map-js', 'tinyglobby', 'vite',
];
const dependencies = {};
const plats = new Set(['@rolldown/binding-linux-x64-gnu', 'lightningcss-linux-x64-gnu']);
const packages = {};
for (const name of allowed) {
    const id = 'node_modules/' + name;
    const pin = lock.packages[id];
    assert.ok(pin && /^\d+\.\d+\.\d+$/.test(pin.version), 'Missing exact pin: ' + name);
    assert.match(pin.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(new URL(pin.resolved).origin, 'https://registry.npmjs.org');
    assert.ok(!pin.link && !pin.hasInstallScript);
    for (const dep of Object.keys(pin.dependencies ?? {})) {
        assert.ok(allowed.includes(dep), 'Unreviewed dependency: ' + dep);
        assert.ok(!lock.packages[id + '/node_modules/' + dep], 'Nested override: ' + dep);
    }
    for (const peer of Object.keys(pin.peerDependencies ?? {})) {
        assert.ok(allowed.includes(peer) || pin.peerDependenciesMeta?.[peer]?.optional);
    }
    const { dev, devOptional, optional, optionalDependencies, ...entry } = pin;
    const supported = Object.entries(optionalDependencies ?? {}).filter(([dep]) => plats.has(dep));
    if (supported.length) entry.optionalDependencies = Object.fromEntries(supported);
    packages[id] = entry;
    dependencies[name] = pin.version;
}
const root = { name: 'hub-capture-ci', version: '0.0.0', dependencies };
await mkdir(output, { mode: 0o700 });
for (const [name, content] of [
    ['package.json', { ...root, private: true }],
    ['package-lock.json', { ...root, lockfileVersion: 3, requires: true, packages: { '': root, ...packages } }],
]) {
    await writeFile(path.join(output, name), JSON.stringify(content, null, 2) + '\n', { flag: 'wx' });
}
