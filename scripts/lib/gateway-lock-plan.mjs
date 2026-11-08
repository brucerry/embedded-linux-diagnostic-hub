import assert from 'node:assert/strict';
import { valid, validRange, satisfies } from 'semver';
import { sourceDigest } from './committed-source-bridge.mjs';

export const GATEWAY_SOURCE_FILES = Object.freeze([
    'package.json',
    'package-lock.json',
    '.env.gateway.example',
    'LICENSE',
    'gateway/Caddyfile.example',
    'docs/gateway.md',
]);
export const GATEWAY_PAYLOAD_FILES = Object.freeze([
    '.env.gateway.example',
    'LICENSE',
    'README.md',
    'dist-gateway/main.cjs',
    'docs/gateway.md',
    'gateway/Caddyfile.example',
    'package-lock.json',
    'package.json',
]);
const classifications = new Set(['dev', 'devOptional', 'optional']);
const sorted = (value) => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sorted(value[key])]),
        );
    return value;
};
const metadata = (value) =>
    sorted(Object.fromEntries(Object.entries(value).filter(([key]) => !classifications.has(key))));
function packageName(value) {
    assert.ok(typeof value === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value));
    assert.ok(
        !value.split('/').some((part) => part === '.' || part === '..' || part === 'node_modules'),
    );
}
function packagePath(value) {
    assert.ok(typeof value === 'string' && value.length < 4096);
    const parts = value.split('/');
    for (let i = 0; i < parts.length;) {
        assert.equal(parts[i++], 'node_modules');
        let name = parts[i++];
        if (name?.startsWith('@')) name += '/' + parts[i++];
        packageName(name);
    }
}
function identity(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.ok(valid(value.version));
    assert.notEqual(value.link, true);
    let location;
    try {
        location = new URL(value.resolved);
    } catch {
        throw Error('Invalid locked package URL.');
    }
    assert.equal(location.protocol, 'https:');
    assert.equal(location.hostname, 'registry.npmjs.org');
    assert.ok(
        !location.port &&
            !location.username &&
            !location.password &&
            !location.search &&
            !location.hash,
        'Credentialed or noncanonical locked URL is unsupported.',
    );
    assert.match(value.integrity, /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/);
    for (const key of classifications)
        assert.ok(value[key] === undefined || typeof value[key] === 'boolean');
    assert.ok(
        !value.peerDependencies || Object.keys(value.peerDependencies).length === 0,
        'Peer resolution needs a reviewed separate contract.',
    );
    assert.ok(!value.devDependencies || Object.keys(value.devDependencies).length === 0);
    return JSON.stringify([value.version, value.resolved, value.integrity]);
}
function resolveDependency(packages, from, name) {
    packageName(name);
    let directory = from;
    for (;;) {
        if (!directory.endsWith('/node_modules') && directory !== 'node_modules') {
            const candidate = (directory ? directory + '/' : '') + 'node_modules/' + name;
            if (Object.hasOwn(packages, candidate)) return candidate;
        }
        if (!directory) break;
        const at = directory.lastIndexOf('/');
        directory = at < 0 ? '' : directory.slice(0, at);
    }
    throw Error('Missing locked Gateway dependency: ' + name);
}
function closure(packages, root, requiredOnly = false) {
    const visited = new Set(),
        queue = [{ path: '', value: root }];
    while (queue.length) {
        const current = queue.shift();
        const dependencies = requiredOnly
            ? Object.fromEntries(
                  Object.entries(current.value.dependencies || {}).filter(
                      ([name]) => !Object.hasOwn(current.value.optionalDependencies || {}, name),
                  ),
              )
            : { ...current.value.dependencies, ...current.value.optionalDependencies };
        for (const [name, range] of Object.entries(dependencies)) {
            assert.ok(
                typeof range === 'string' && validRange(range),
                'Non-semver package selector is unsupported.',
            );
            const selected = resolveDependency(packages, current.path, name),
                entry = packages[selected];
            packagePath(selected);
            identity(entry);
            assert.ok(
                satisfies(entry.version, range),
                'Locked version differs from dependency selector.',
            );
            if (!visited.has(selected)) {
                visited.add(selected);
                queue.push({ path: selected, value: entry });
            }
        }
    }
    return [...visited].sort();
}
function lockShape(lock) {
    assert.ok(
        lock && typeof lock === 'object' && lock.lockfileVersion === 3 && lock.requires === true,
    );
    assert.deepEqual(Object.keys(lock).sort(), [
        'lockfileVersion',
        'name',
        'packages',
        'requires',
        'version',
    ]);
    assert.ok(lock.packages && typeof lock.packages === 'object' && !Array.isArray(lock.packages));
    assert.ok(Object.keys(lock.packages).length <= 10000 && Object.hasOwn(lock.packages, ''));
}
export function gatewayManifest(source, sourceLock) {
    lockShape(sourceLock);
    assert.equal(sourceLock.name, source.name);
    assert.equal(sourceLock.version, source.version);
    assert.equal(sourceLock.packages[''].name, source.name);
    assert.equal(sourceLock.packages[''].version, source.version);
    assert.equal(source.license, 'MIT');
    assert.ok(valid(source.version));
    const ssh = sourceLock.packages['node_modules/ssh2'];
    identity(ssh);
    assert.ok(satisfies(ssh.version, source.dependencies.ssh2));
    return {
        name: source.name + '-gateway',
        version: source.version,
        private: true,
        license: 'MIT',
        main: 'dist-gateway/main.cjs',
        engines: { node: '>=24' },
        scripts: { start: 'node --env-file=.env.gateway dist-gateway/main.cjs' },
        dependencies: { ssh2: ssh.version },
    };
}
export function projectGatewayLock(source, sourceLock) {
    const manifest = gatewayManifest(source, sourceLock);
    const root = {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        dependencies: manifest.dependencies,
        engines: manifest.engines,
    };
    const selected = closure(sourceLock.packages, root),
        required = new Set(closure(sourceLock.packages, root, true));
    /** @type {Record<string, any>} */
    const packages = { '': root };
    // Preserve selected resolution paths; this is not a new solver or a version update.
    for (const name of selected) {
        const entry = structuredClone(sourceLock.packages[name]);
        for (const key of classifications) delete entry[key];
        if (!required.has(name)) entry.optional = true;
        packages[name] = entry;
    }
    return {
        manifest,
        lock: {
            name: manifest.name,
            version: manifest.version,
            lockfileVersion: 3,
            requires: true,
            packages,
        },
        selected,
    };
}
/** Require the actual acknowledged npm output to retain the pinned closure; no registry fallback. */
export function validatePreparedGatewayLock(value, manifest, sourceLock) {
    lockShape(value);
    assert.equal(value.name, manifest.name);
    assert.equal(value.version, manifest.version);
    assert.deepEqual(value.packages[''], {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        dependencies: manifest.dependencies,
        engines: manifest.engines,
    });
    const selected = closure(value.packages, value.packages['']);
    assert.deepEqual(
        Object.keys(value.packages)
            .filter((key) => key !== '')
            .sort(),
        selected,
        'Extraneous locked packages.',
    );
    const pinned = new Map(),
        sourceNames = closure(sourceLock.packages, { dependencies: manifest.dependencies });
    const nameAt = (path) =>
        path.slice(
            path.lastIndexOf('/node_modules/') >= 0
                ? path.lastIndexOf('/node_modules/') + 14
                : 'node_modules/'.length,
        );
    for (const path of sourceNames) {
        const entry = sourceLock.packages[path],
            key = nameAt(path) + ':' + identity(entry),
            bytes = JSON.stringify(metadata(entry));
        if (pinned.has(key))
            assert.equal(pinned.get(key), bytes, 'Ambiguous source package metadata.');
        pinned.set(key, bytes);
    }
    const required = new Set(closure(value.packages, value.packages[''], true));
    for (const name of selected) {
        const entry = value.packages[name],
            key = nameAt(name) + ':' + identity(entry);
        assert.notEqual(entry.dev, true);
        assert.notEqual(entry.devOptional, true);
        if (required.has(name)) assert.notEqual(entry.optional, true);
        else assert.equal(entry.optional, true);
        assert.ok(pinned.has(key), 'New or changed locked package identity.');
        assert.equal(
            JSON.stringify(metadata(entry)),
            pinned.get(key),
            'Locked package metadata changed.',
        );
    }
    return value;
}
export function gatewayReadme() {
    return '# Diagnostic Hub lab gateway\n\nSee docs/gateway.md for setup. Install Node.js 24, then run:\n\n```sh\nnpm ci --omit=optional --ignore-scripts\ncp .env.gateway.example .env.gateway\n# Set a random token, website origin, device addresses and verified host fingerprints.\nnpm start\n```\n\nExpose this service through a trusted HTTPS reverse proxy. The portable desktop application connects directly and does not require this gateway.\n';
}
export function gatewayStageFiles(sourceFiles, compiled) {
    const source = JSON.parse(sourceFiles.get('package.json').toString('utf8'));
    const sourceLock = JSON.parse(sourceFiles.get('package-lock.json').toString('utf8'));
    const projected = projectGatewayLock(source, sourceLock);
    assert.ok(Buffer.isBuffer(compiled) && compiled.length > 0);
    const files = new Map([
        ['package.json', Buffer.from(JSON.stringify(projected.manifest, null, 2) + '\n')],
        ['package-lock.json', Buffer.from(JSON.stringify(projected.lock, null, 2) + '\n')],
        ['dist-gateway/main.cjs', Buffer.from(compiled)],
        ['README.md', Buffer.from(gatewayReadme())],
        ...GATEWAY_SOURCE_FILES.filter((path) => !path.startsWith('package')).map((path) => [
            path,
            Buffer.from(sourceFiles.get(path)),
        ]),
    ]);
    return {
        files,
        ...projected,
        sourceLock,
        sourceLockSHA256: sourceDigest(sourceFiles.get('package-lock.json')),
    };
}
