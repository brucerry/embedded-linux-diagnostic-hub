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
const renderer = process.argv[3] === '--renderer';
const desktop = process.argv[3] === '--desktop' || renderer;
assert.ok(process.argv.length === 3 || (process.argv.length === 4 && desktop));
if (desktop) allowed.push('semver', 'fflate', 'js-yaml', 'argparse', 'typescript');
if (renderer)
    allowed.push('@vitejs/plugin-react', 'react', 'react-dom', 'lucide-react', 'scheduler', '@xterm/xterm', '@xterm/addon-fit');
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
if (desktop) {
    const rootKey = 'node_modules/@electron/asar';
    const scope = new Set([
        '@electron/asar', 'commander', 'glob', '@electron/asar/node_modules/minimatch',
        'fs.realpath', 'inflight', 'inherits', 'glob/node_modules/minimatch', 'once',
        'path-is-absolute', '@electron/asar/node_modules/brace-expansion', 'wrappy',
        'glob/node_modules/brace-expansion', '@electron/asar/node_modules/balanced-match',
        'concat-map', 'glob/node_modules/balanced-match',
    ].map((name) => 'node_modules/' + name));
    const visited = new Set();
    const visit = (key) => {
        if (visited.has(key)) return;
        assert.ok(scope.has(key), 'Unreviewed ASAR dependency: ' + key);
        visited.add(key);
        const pin = lock.packages[key];
        assert.ok(pin && /^\d+\.\d+\.\d+$/.test(pin.version), 'Missing package pin: ' + key);
        assert.match(pin.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
        assert.equal(new URL(pin.resolved).origin, 'https://registry.npmjs.org');
        assert.ok(!pin.link && !pin.hasInstallScript);
        assert.deepEqual(Object.keys(pin.optionalDependencies ?? {}), []);
        assert.deepEqual(Object.keys(pin.peerDependencies ?? {}), []);
        for (const name of Object.keys(pin.dependencies ?? {})) {
            let prefix = key;
            while (prefix.includes('/node_modules/') && !lock.packages[prefix + '/node_modules/' + name]) {
                prefix = prefix.slice(0, prefix.lastIndexOf('/node_modules/'));
            }
            const nested = prefix + '/node_modules/' + name;
            visit(lock.packages[nested] ? nested : 'node_modules/' + name);
        }
        const { dev, devOptional, optional, ...entry } = pin;
        packages[key] = entry;
    };
    visit(rootKey);
    assert.equal(visited.size, scope.size);
    dependencies['@electron/asar'] = lock.packages[rootKey].version;
}
const root = { name: 'hub-capture-ci', version: '0.0.0', dependencies };
await mkdir(output, { mode: 0o700 });
for (const [name, content] of [
    ['package.json', { ...root, private: true }],
    ['package-lock.json', { ...root, lockfileVersion: 3, requires: true, packages: { '': root, ...packages } }],
]) {
    await writeFile(path.join(output, name), JSON.stringify(content, null, 2) + '\n', { flag: 'wx' });
}
