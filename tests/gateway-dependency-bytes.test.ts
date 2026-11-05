import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { inspectLockedDependencyBytes } from '../scripts/lib/gateway-dependency-bytes.mjs';
import { createFinalGatewayObserver } from '../scripts/lib/final-gateway-runtime.mjs';
import { produceGatewayArchive } from '../scripts/lib/gateway-archive-producer.mjs';
import { pipelineFixture, sourceFixture } from './fixtures/gateway-producer-memory';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const integrity = (b: Buffer) => 'sha512-' + createHash('sha512').update(b).digest('base64');
type Member = {
    name: string;
    bytes?: Buffer;
    type?: number;
    mode?: number;
    prefix?: string;
    mutate?: (h: Buffer) => void;
};
// Independent authored USTAR fixture. No tar process, npm package or payload code is executed.
function tar(members: Member[], tail: Buffer = Buffer.alloc(1024)) {
    const chunks: Buffer[] = [];
    for (const m of members) {
        const head = Buffer.alloc(512),
            bytes = m.bytes ?? Buffer.alloc(0);
        head.write(m.name, 0, 100, 'utf8');
        const octal = (at: number, n: number, width: number) =>
            head.write(n.toString(8).padStart(width - 1, '0') + '\0', at, width, 'ascii');
        octal(100, m.mode ?? 0o644, 8);
        octal(108, 1000, 8);
        octal(116, 1000, 8);
        octal(124, bytes.length, 12);
        octal(136, 123456, 12);
        head[156] = m.type ?? 48;
        head.write('ustar\0' + '00', 257, 8, 'ascii');
        if (m.prefix) head.write(m.prefix, 345, 155, 'utf8');
        m.mutate?.(head);
        head.fill(32, 148, 156);
        const sum = head.reduce((a, b) => a + b, 0);
        head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
        chunks.push(head, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    }
    return gzipSync(Buffer.concat([...chunks, tail]));
}
const members = (name = 'ssh2', version = '1.17.0'): Member[] => [
    {
        name: 'package/package.json',
        bytes: Buffer.from(JSON.stringify({ name, version, main: 'lib/index.js' })),
    },
    {
        name: 'package/lib/index.js',
        bytes: Buffer.from('// authored synthetic bytes, never loaded\nπ\n'),
    },
    { name: 'package/LICENSE', bytes: Buffer.from('synthetic license') },
];
function low(raw: Buffer = tar(members()), name = 'ssh2', version = '1.17.0') {
    const path = 'node_modules/' + name;
    return {
        lock: { packages: { '': {}, [path]: { version, integrity: integrity(raw) } } },
        archives: [{ path, bytes: raw }],
    };
}
test('retained SRI bytes derive exact file hashes with implicit directories and UTF8 content', () => {
    const f = low(),
        result = inspectLockedDependencyBytes(f.lock, f.archives);
    assert.equal(result.packages[0].archiveSHA256, hash(f.archives[0].bytes));
    assert.equal(
        result.files.find((r: any) => r.path.endsWith('/lib/index.js'))?.sha256,
        hash(members()[1].bytes!),
    );
    assert.equal(result.files.length, 3);
    assert.equal('loadedCodeObserved' in result, false);
});
for (const which of ['bytes', 'sri', 'algorithm', 'padding', 'missing', 'extra', 'duplicate'])
    test('locked archive refuses ' + which, () => {
        const f: any = low();
        if (which === 'bytes') f.archives[0].bytes[15] ^= 1;
        if (which === 'sri')
            f.lock.packages['node_modules/ssh2'].integrity =
                'sha512-' + Buffer.alloc(64).toString('base64');
        if (which === 'algorithm')
            f.lock.packages['node_modules/ssh2'].integrity =
                'sha1-' + Buffer.alloc(20).toString('base64');
        if (which === 'padding')
            f.lock.packages['node_modules/ssh2'].integrity = f.lock.packages[
                'node_modules/ssh2'
            ].integrity.replace(/==$/, 'AA');
        if (which === 'missing') f.archives = [];
        if (which === 'extra')
            f.archives.push({ path: 'node_modules/other', bytes: tar(members()) });
        if (which === 'duplicate') {
            f.lock.packages['node_modules/dep'] = f.lock.packages['node_modules/ssh2'];
            f.archives.push(f.archives[0]);
        }
        assert.throws(() => inspectLockedDependencyBytes(f.lock, f.archives));
    });
for (const [label, bad] of [
    ['escape', { name: 'package/../escape.js' }],
    ['absolute', { name: '/package/escape.js' }],
    ['backslash', { name: 'package/lib\\escape.js' }],
    ['wrong root', { name: 'other/file.js' }],
    ['case alias', { name: 'package/LICENSE' }],
    ['file parent', { name: 'package/lib' }],
    ['symlink', { name: 'package/link', type: 50 }],
    ['hardlink', { name: 'package/link', type: 49 }],
    ['PAX', { name: 'package/pax', type: 120 }],
    ['native', { name: 'package/addon.node' }],
    ['bundled', { name: 'package/node_modules/evil/index.js' }],
    ['writable', { name: 'package/write.js', mode: 0o666 }],
    [
        'high-bit number',
        {
            name: 'package/n.js',
            mutate: (h: Buffer) => {
                h[124] = 0xb0;
            },
        },
    ],
] as [string, Member][])
    test('authenticated but unsupported tar rejects ' + label, () => {
        const list = members();
        if (label === 'case alias') bad.name = 'package/license';
        const f = low(tar([...list, { bytes: Buffer.from('not executed'), ...bad }]));
        assert.throws(() => inspectLockedDependencyBytes(f.lock, f.archives));
    });
for (const mismatch of ['name', 'version', 'manifest', 'terminator', 'gzip-concatenation'])
    test('authenticated byte controls reject ' + mismatch, () => {
        const list = members();
        let raw: Buffer;
        if (mismatch === 'name') list[0].bytes = Buffer.from('{"name":"other","version":"1.17.0"}');
        if (mismatch === 'version')
            list[0].bytes = Buffer.from('{"name":"ssh2","version":"99.0.0"}');
        if (mismatch === 'manifest') list.shift();
        raw = tar(list, mismatch === 'terminator' ? Buffer.alloc(512) : Buffer.alloc(1024));
        if (mismatch === 'gzip-concatenation') raw = Buffer.concat([raw, raw]);
        const f = low(raw);
        assert.throws(() => inspectLockedDependencyBytes(f.lock, f.archives));
    });
test('scoped/nested required roots map separately; optional archive cannot substitute for required', () => {
    const raw = tar(members('@scope/dep', '1.0.0'));
    const path = 'node_modules/ssh2/node_modules/@scope/dep';
    const lock = {
        packages: {
            [path]: { version: '1.0.0', integrity: integrity(raw) },
            'node_modules/opt': { optional: true },
        },
    };
    assert.equal(
        inspectLockedDependencyBytes(lock, [{ path, bytes: raw }]).files[0].path,
        path + '/LICENSE',
    );
    assert.throws(() =>
        inspectLockedDependencyBytes(lock, [{ path: 'node_modules/opt', bytes: raw }]),
    );
});
test('explicit directories and USTAR prefix names preserve one exact package namespace', () => {
    const list = members();
    list[0] = { ...list[0], name: 'package.json', prefix: 'package' };
    const raw = tar([
        { name: 'package/', type: 53, mode: 0o755 },
        { name: 'package/lib/', type: 53, mode: 0o755 },
        ...list,
    ]);
    const f = low(raw);
    assert.equal(inspectLockedDependencyBytes(f.lock, f.archives).files.length, 3);
});
for (const control of [
    'gzip-flags',
    'crc',
    'isize-short',
    'isize-long',
    'expanded-bound',
    'compressed-bound',
    'entry-bound',
])
    test('bounded codec refuses ' + control + ' without any external IO', () => {
        let raw = tar(members());
        if (control === 'gzip-flags') raw[3] = 8;
        if (control === 'crc') raw[raw.length - 8] ^= 1;
        if (control === 'isize-short')
            raw.writeUInt32LE(raw.readUInt32LE(raw.length - 4) - 512, raw.length - 4);
        if (control === 'isize-long')
            raw.writeUInt32LE(raw.readUInt32LE(raw.length - 4) + 512, raw.length - 4);
        if (control === 'expanded-bound') raw.writeUInt32LE(64 * 1024 ** 2 + 512, raw.length - 4);
        if (control === 'compressed-bound') raw = Buffer.alloc(16 * 1024 ** 2 + 1);
        if (control === 'entry-bound')
            raw = tar([
                ...members(),
                ...Array.from({ length: 4096 }, (_, n) => ({ name: 'package/empty-' + n })),
            ]);
        const f = low(raw);
        assert.throws(() => inspectLockedDependencyBytes(f.lock, f.archives));
    });
async function fixture(changeInstalled?: (path: string, bytes: Buffer) => Buffer | null) {
    const source = sourceFixture(),
        bundles = ['ssh2', 'dep'].map((name) => ({
            path: 'node_modules/' + name,
            list: members(name, name === 'ssh2' ? '1.17.0' : '1.0.0'),
        }));
    const archives = bundles.map((b) => ({ path: b.path, bytes: tar(b.list) }));
    const lock: any = structuredClone(source.lock);
    for (const row of archives) lock.packages[row.path].integrity = integrity(row.bytes);
    const f = pipelineFixture(new Map([['package-lock.json', Buffer.from(JSON.stringify(lock))]]));
    const { record } = await produceGatewayArchive(f.context, f.options, f.io);
    const root = '/installed/gateway',
        nodePath = '/runtime/node',
        nodeBytes = Buffer.from('synthetic node bytes, never executed');
    for (const row of record.payload)
        f.filesystem.write(
            root + '/' + row.path,
            f.filesystem.bytes(record.lockPreparation.cwd + '/' + row.path),
        );
    for (const b of bundles)
        for (const m of b.list) {
            const file = b.path + '/' + m.name.slice('package/'.length);
            const bytes = changeInstalled ? changeInstalled(file, m.bytes!) : m.bytes!;
            if (bytes) f.filesystem.write(root + '/' + file, bytes);
        }
    f.filesystem.write(nodePath, nodeBytes);
    const adjust = (s: any, p: string) => ({
        ...s,
        uid: 1000,
        mode: p === nodePath ? 0o100755 : s.mode,
    });
    const filesystem = {
        ...f.filesystem.fs,
        lstat: async (p: string) => adjust(await f.filesystem.fs.lstat(p), p),
        open: async (p: string, flags: number) => {
            assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const h = await f.filesystem.fs.open(p, 'r');
            return { ...h, stat: async () => adjust(await h.stat(), p) };
        },
    };
    const raw = f.filesystem.bytes(
        record.lockPreparation.cwd.replace(/\/stage$/, '') + '/artifacts/' + record.archive.name,
    );
    const owner = createFinalGatewayObserver(
        raw,
        Buffer.from(JSON.stringify(record) + '\n'),
        f.context,
        f.files.get('package-lock.json')!,
        { root, node: { path: nodePath, sha256: hash(nodeBytes) }, uid: 1000 },
        filesystem,
    );
    const child: any = new EventEmitter();
    child.pid = 4242;
    child.spawnfile = nodePath;
    child.spawnargs = [nodePath, root + '/dist-gateway/main.cjs'];
    child.stdin = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const normal = () => {
        child.emit('spawn');
        child.stdout.emit('close');
        child.stderr.emit('close');
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
    };
    return { ...f, owner, archives, record, root, child, normal };
}
test('only internal independently read census can bind retained npm bytes and emit source/artifact identity', async () => {
    const f = await fixture();
    assert.throws(() => f.owner.observeDependencyOrigin(f.archives));
    const baseline = await f.owner.observeInstallation();
    baseline.files[0].sha256 = 'f'.repeat(64); // Caller cannot replace the internally held census.
    const origin = f.owner.observeDependencyOrigin(f.archives);
    assert.equal(origin.selectedSource.sourceCommit, f.context.sourceCommit);
    assert.equal(origin.gatewayArchiveSHA256, f.record.archive.sha256);
    assert.equal(origin.preparedLockSHA256, f.record.preparedLockSHA256);
    assert.equal(origin.loadedCodeObserved, false);
    assert.equal(origin.files.length, 6);
    origin.packages[0].archiveSHA256 = 'f'.repeat(64);
    f.archives[0].bytes.fill(0);
    const observation = f.owner.observeChild(f.child);
    f.normal();
    const out = await observation.completion;
    await observation.joined;
    assert.notEqual(out.record.dependencyOrigin.packages[0].archiveSHA256, 'f'.repeat(64));
    assert.equal(out.record.loadedDependencyMapping, null);
    assert.equal(out.record.kernelExecutableMapping, null);
    assert.equal(out.record.releaseAcceptance, false);
    assert.throws(() => f.owner.observeDependencyOrigin([]));
});
for (const mode of ['changed', 'missing', 'extra', 'bad-sri'])
    test(
        'origin binding fails closed on ' +
            mode +
            ' while preserving owner and preventing child observation',
        async () => {
            const f = await fixture((p, b) =>
                p.endsWith('/LICENSE')
                    ? mode === 'changed'
                        ? Buffer.from('substituted')
                        : mode === 'missing'
                          ? null
                          : b
                    : b,
            );
            if (mode === 'extra')
                f.filesystem.write(f.root + '/node_modules/dep/extra.js', Buffer.from('extra'));
            await f.owner.observeInstallation();
            if (mode === 'bad-sri') f.archives[0].bytes[15] ^= 1;
            assert.throws(
                () => f.owner.observeDependencyOrigin(f.archives),
                (e: any) => e.owner === f.owner,
            );
            assert.equal(f.owner.snapshot().phase, 'failed');
            assert.equal(f.owner.snapshot().descriptors, 0);
            assert.throws(() => f.owner.observeChild(f.child));
        },
    );
test('post-origin file replacement still rejects final evidence after normal direct child close', async () => {
    const f = await fixture();
    await f.owner.observeInstallation();
    f.owner.observeDependencyOrigin(f.archives);
    const observation = f.owner.observeChild(f.child);
    f.filesystem.write(
        f.root + '/node_modules/dep/lib/index.js',
        Buffer.from('changed after binding'),
    );
    f.normal();
    await assert.rejects(observation.completion);
    await observation.joined;
    assert.equal(f.owner.snapshot().phase, 'failed');
});
