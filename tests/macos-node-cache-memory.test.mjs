import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMacNodeCache } from '../.github/scripts/macos-node-cache.mjs';

// Authored metadata only: no filesystem adapter, source script, cache binary or process runs.
function fixture(arch = 'arm64') {
    const version = arch === 'x64' ? '24.19.0' : '24.22.2',
        config = {
            arch,
            home: '/Users/fixture',
            cacheRoot: '/Users/fixture/hostedtoolcache',
            agentRoot: '/Users/fixture/hostedtoolcache',
        },
        file = config.cacheRoot + '/node/' + version + '/' + arch + '/bin/node',
        marker = config.cacheRoot + '/node/' + version + '/' + arch + '.complete',
        identity = { platform: 'darwin', arch, uid: 501, euid: 501 },
        metadata = new Map(),
        calls = [],
        header = new Uint8Array(32),
        view = new DataView(header.buffer);
    view.setUint32(0, 0xfeedfacf, true);
    view.setUint32(4, arch === 'x64' ? 0x01000007 : 0x0100000c, true);
    view.setUint32(12, 2, true);
    const parts = file.slice(1).split('/');
    for (let i = 0; i <= parts.length; i++) {
        const name = i ? '/' + parts.slice(0, i).join('/') : '/';
        metadata.set(name, {
            kind: i === parts.length ? 'file' : 'directory',
            dev: 1n,
            ino: BigInt(i + 1),
            mode: 0o755n,
            uid: name === '/' || name === '/Users' ? 0n : 501n,
            nlink: i === parts.length ? 1n : 2n,
            size: 4096n,
            mtimeNs: 1n,
            ctimeNs: 1n,
        });
    }
    metadata.set(marker, { ...metadata.get(file), ino: 100n, mode: 0o644n, size: 0n });
    const ports = {
        identity: () => identity,
        lstat: (name) => {
            calls.push(['lstat', name]);
            return metadata.get(name) ?? null;
        },
        realpath: (name) => {
            calls.push(['realpath', name]);
            return name;
        },
        executable: (name) => {
            calls.push(['executable', name]);
            return name === file;
        },
        readHeader: (name, limit) => {
            calls.push(['header', name, limit]);
            assert.equal(name, file);
            assert.equal(limit, 32);
            return header;
        },
    };
    return { arch, version, config, file, marker, identity, metadata, calls, header, ports };
}
const resolve = (f) => resolveMacNodeCache(f.config, f.ports);
for (const arch of ['x64', 'arm64'])
    test(
        arch + ' exact documented cache layout yields only an unqualified private candidate',
        () => {
            const f = fixture(arch),
                result = resolve(f);
            assert.deepEqual(result, {
                status: 'CACHE_METADATA_CANDIDATE',
                candidate: f.file,
                expectedVersion: f.version,
                expectedArchitecture: arch,
                actualRuntimeVersion: 'unverified',
                nativeQualification: false,
                releaseAcceptance: false,
            });
            assert.equal(f.calls.filter(([kind]) => kind === 'header').length, 1);
            assert.equal(f.calls.filter(([kind]) => kind === 'executable').length, 1);
        },
    );

for (const [name, mutate, reason] of [
    ['root process', (f) => (f.identity.uid = f.identity.euid = 0), 'context'],
    ['different effective identity', (f) => (f.identity.euid = 502), 'context'],
    ['wrong process architecture', (f) => (f.identity.arch = 'x64'), 'context'],
    ['unsupported lane', (f) => (f.config.arch = 'other'), 'context'],
    ['noncanonical home', (f) => (f.config.home += '/'), 'path'],
    ['cache root mismatch', (f) => (f.config.cacheRoot = '/other/cache'), 'path'],
    ['cache variables disagree', (f) => (f.config.agentRoot += '-other'), 'path'],
    [
        'constructed path exceeds the bound',
        (f) => {
            f.config.home = '/' + 'h'.repeat(4060);
            f.config.cacheRoot = f.config.home + '/hostedtoolcache';
            f.config.agentRoot = f.config.cacheRoot;
        },
        'path',
    ],
    ['missing exact version', (f) => f.metadata.delete(f.file), 'incomplete'],
    ['missing completion marker', (f) => f.metadata.delete(f.marker), 'incomplete'],
    ['nonempty marker', (f) => (f.metadata.get(f.marker).size = 1n), 'incomplete'],
    ['linked marker', (f) => (f.metadata.get(f.marker).kind = 'link'), 'unsafe'],
    ['other owner', (f) => (f.metadata.get(f.file).uid = 502n), 'unsafe'],
    ['writable cache root', (f) => (f.metadata.get(f.config.cacheRoot).mode = 0o777n), 'unsafe'],
    ['linked executable', (f) => (f.metadata.get(f.file).kind = 'link'), 'unsafe'],
    ['multiple executable links', (f) => (f.metadata.get(f.file).nlink = 2n), 'unsafe'],
    ['unavailable X_OK', (f) => (f.ports.executable = () => false), 'unsafe'],
    [
        'wrong CPU header',
        (f) => new DataView(f.header.buffer).setUint32(4, 0x01000007, true),
        'architecture',
    ],
    ['unsupported binary format', (f) => f.header.fill(0), 'architecture'],
    ['truncated header', (f) => (f.ports.readHeader = () => new Uint8Array(16)), 'architecture'],
])
    test('refuses ' + name + ' without selecting another tool or promoting evidence', () => {
        const f = fixture();
        mutate(f);
        assert.deepEqual(resolve(f), {
            status: 'REFUSED',
            reason,
            nativeQualification: false,
            releaseAcceptance: false,
        });
        assert.ok(f.calls.every((call) => !call.includes('/other/cache')));
    });

test('unsafe parent stops before following it or reading descendants', () => {
    const f = fixture();
    f.metadata.get('/Users').kind = 'link';
    assert.equal(resolve(f).reason, 'unsafe');
    assert.deepEqual(f.calls, [
        ['lstat', '/'],
        ['realpath', '/'],
        ['lstat', '/Users'],
    ]);
});
test('identity change during header read refuses instead of using mutated snapshot references', () => {
    const f = fixture(),
        read = f.ports.readHeader;
    f.ports.readHeader = (...args) => {
        f.metadata.get(f.file).ctimeNs = 2n;
        return read(...args);
    };
    assert.equal(resolve(f).reason, 'changed');
});
test('read failures remain bounded and private; no candidate is returned', () => {
    const f = fixture();
    f.ports.readHeader = () => {
        throw Error('PRIVATE_VALUE');
    };
    const result = resolve(f);
    assert.equal(result.reason, 'read-failed');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));
    assert.ok(!Object.hasOwn(result, 'candidate'));
});
