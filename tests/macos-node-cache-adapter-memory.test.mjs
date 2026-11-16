import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMacNodeCache } from '../.github/scripts/macos-node-cache.mjs';
import {
    createMacCacheMetadataPorts,
    summarizeMacCacheMetadata,
    inspectMacCacheMetadata,
} from '../.github/scripts/macos-node-cache-reader.mjs';

// Fake descriptors and authored data only. These controls never open a file or
// impersonate a real ordinary Mac user in the production wrapper.
const stats = (m) =>
    m && {
        ...m,
        isSymbolicLink: () => m.kind === 'link',
        isDirectory: () => m.kind === 'directory',
        isFile: () => m.kind === 'file',
    };
function fixture(arch = 'arm64') {
    const version = arch === 'x64' ? '24.19.0' : '24.22.2',
        config = {
            arch,
            home: '/Users/fixture',
            cacheRoot: '/Users/fixture/hostedtoolcache',
            agentRoot: '/Users/fixture/hostedtoolcache',
        },
        identity = { platform: 'darwin', arch, uid: 501, euid: 501 },
        executable = config.cacheRoot + '/node/' + version + '/' + arch + '/bin/node',
        marker = config.cacheRoot + '/node/' + version + '/' + arch + '.complete',
        rows = new Map(),
        events = [],
        header = Buffer.alloc(32),
        view = new DataView(header.buffer, header.byteOffset, 32);
    view.setUint32(0, 0xfeedfacf, true);
    view.setUint32(4, arch === 'x64' ? 0x01000007 : 0x0100000c, true);
    view.setUint32(12, 2, true);
    const parts = executable.slice(1).split('/');
    for (let i = 0; i <= parts.length; i++) {
        const name = i ? '/' + parts.slice(0, i).join('/') : '/';
        rows.set(name, {
            kind: i === parts.length ? 'file' : 'directory',
            dev: 1n,
            ino: BigInt(i + 1),
            mode: i === parts.length ? 0o100755n : 0o40755n,
            uid: name === '/' || name === '/Users' ? 0n : 501n,
            nlink: i === parts.length ? 1n : 2n,
            size: 4096n,
            mtimeNs: 1n,
            ctimeNs: 1n,
        });
    }
    rows.set(marker, { ...rows.get(executable), ino: 100n, mode: 0o100644n, size: 0n });
    const io = {
        constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2, X_OK: 1 },
        lstatSync: (file) => {
            events.push(['lstat', file]);
            return stats(rows.get(file));
        },
        realpathSync: (file) => {
            events.push(['realpath', file]);
            return file;
        },
        accessSync: (file) => {
            events.push(['access', file]);
        },
        openSync: (file, flags) => {
            events.push(['open', file, flags]);
            assert.equal(file, executable);
            assert.equal(flags, 3);
            return 0;
        },
        fstatSync: (fd) => {
            events.push(['fstat', fd]);
            return stats(rows.get(executable));
        },
        readSync: (fd, buffer, offset, length, position) => {
            events.push(['read', fd, length]);
            assert.equal(position, offset);
            header.copy(buffer, offset, position, position + length);
            return length;
        },
        closeSync: (fd) => {
            events.push(['close', fd]);
        },
    };
    return { config, identity, executable, rows, events, header, io };
}
function inspect(f) {
    const reader = createMacCacheMetadataPorts(f.config, f.identity, f.io),
        result = resolveMacNodeCache(f.config, reader.ports),
        custody = reader.observe(),
        summary = summarizeMacCacheMetadata(result, custody);
    return { reader, result, custody, summary };
}
for (const arch of ['x64', 'arm64'])
    test(arch + ' authored adapter roundtrip closes fd zero and exposes no private path', () => {
        const f = fixture(arch),
            r = inspect(f);
        assert.equal(r.result.status, 'CACHE_METADATA_CANDIDATE');
        assert.equal(r.summary.status, 'CACHE_METADATA_CANDIDATE');
        assert.deepEqual(
            f.events.filter(([kind]) => kind === 'close'),
            [['close', 0]],
        );
        assert.equal(r.custody.opened, 1);
        assert.equal(r.custody.closed, 1);
        assert.equal(r.custody.retainedUnknown, 0);
        assert.equal(r.custody.confirmedBytes, 32);
        assert.equal(r.summary.nativeQualification, false);
        assert.equal(r.summary.binaryAuthenticated, false);
        assert.equal(r.summary.hostedProvenance, 'unverified');
        assert.ok(!JSON.stringify(r.summary).includes('/Users'));
        assert.ok(!Object.hasOwn(r.summary, 'candidate'));
    });
for (const [name, mutate, reason, closed, unknown] of [
    [
        'read throws undefined',
        (f) => {
            f.io.readSync = () => {
                throw undefined;
            };
        },
        'read-failed',
        1,
        0,
    ],
    [
        'premature EOF',
        (f) => {
            f.io.readSync = () => 0;
        },
        'short-read',
        1,
        0,
    ],
    [
        'fstat throws undefined',
        (f) => {
            f.io.fstatSync = () => {
                throw undefined;
            };
        },
        'read-failed',
        1,
        0,
    ],
    [
        'different descriptor identity',
        (f) => {
            f.io.fstatSync = () => stats({ ...f.rows.get(f.executable), ino: 999n });
        },
        'changed',
        1,
        0,
    ],
    [
        'close throws undefined',
        (f) => {
            f.io.closeSync = () => {
                f.events.push(['close', 0]);
                throw undefined;
            };
        },
        'closure-unknown',
        0,
        1,
    ],
    [
        'unsupported close acknowledgement',
        (f) => {
            f.io.closeSync = () => {
                f.events.push(['close', 0]);
                return false;
            };
        },
        'closure-unknown',
        0,
        1,
    ],
])
    test(name + ' remains nonpassing with truthful custody', () => {
        const f = fixture();
        mutate(f);
        const r = inspect(f);
        assert.equal(r.summary.status, 'REFUSED');
        assert.equal(r.summary.reason, reason);
        assert.equal(r.custody.opened, 1);
        assert.equal(r.custody.closed, closed);
        assert.equal(r.custody.retainedUnknown, unknown);
        assert.equal(f.events.filter(([kind]) => kind === 'close').length, 1);
        if (name.includes('fstat') || name.includes('descriptor'))
            assert.equal(f.events.filter(([kind]) => kind === 'read').length, 0);
    });
test('positive partial reads stay within exactly 32 bytes and one owned close', () => {
    const f = fixture(),
        read = f.io.readSync;
    f.io.readSync = (fd, buffer, offset, length, position) =>
        read(fd, buffer, offset, Math.min(length, 7), position);
    const r = inspect(f);
    assert.equal(r.summary.status, 'CACHE_METADATA_CANDIDATE');
    assert.equal(r.custody.confirmedBytes, 32);
    assert.equal(f.events.filter(([kind]) => kind === 'read').length, 5);
    assert.equal(r.custody.closed, 1);
});
test('a falsey primary read failure survives uncertain close and freezes further IO', () => {
    const f = fixture();
    f.io.readSync = () => {
        throw undefined;
    };
    f.io.closeSync = () => {
        f.events.push(['close', 0]);
        throw Error('PRIVATE_VALUE');
    };
    const r = inspect(f),
        count = f.events.length;
    assert.equal(r.custody.failurePhase, 'read');
    assert.equal(r.summary.reason, 'read-failed');
    assert.equal(r.custody.closeFailed, true);
    assert.equal(r.custody.retainedUnknown, 1);
    assert.throws(() => r.reader.ports.lstat('/'), { code: 'stopped' });
    assert.equal(f.events.length, count);
    assert.ok(!JSON.stringify(r.summary).includes('PRIVATE_VALUE'));
});
test('out-of-scope path is rejected before any IO', () => {
    const f = fixture(),
        reader = createMacCacheMetadataPorts(f.config, f.identity, f.io);
    assert.throws(() => reader.ports.lstat('/unrelated'), { code: 'scope' });
    assert.equal(f.events.length, 0);
});
test('metadata call budget stops synthetic IO without retries', () => {
    const f = fixture(),
        reader = createMacCacheMetadataPorts(f.config, f.identity, f.io);
    for (let i = 0; i < 4096; i++) reader.ports.lstat('/');
    assert.throws(() => reader.ports.lstat('/'), { code: 'budget' });
    assert.equal(reader.observe().filesystemCalls, 4096);
    assert.equal(f.events.length, 4096);
    assert.throws(() => reader.ports.lstat('/'), { code: 'stopped' });
    assert.equal(f.events.length, 4096);
});
test('synthetic summaries cannot promote absent reads, retained custody or private inputs', () => {
    const result = {
            status: 'CACHE_METADATA_CANDIDATE',
            expectedArchitecture: 'arm64',
            expectedVersion: '24.22.2',
            actualRuntimeVersion: 'unverified',
            candidate: '/PRIVATE_VALUE',
            nativeQualification: false,
            releaseAcceptance: false,
        },
        zero = {
            filesystemCalls: 0,
            opened: 0,
            closed: 0,
            confirmedBytes: 0,
            retainedUnknown: 0,
            failureCode: null,
            closeFailed: false,
        };
    assert.equal(summarizeMacCacheMetadata(result, zero).status, 'REFUSED');
    const held = summarizeMacCacheMetadata(result, {
        ...zero,
        opened: 1,
        retainedUnknown: 1,
        failureCode: 'closure-unknown',
        closeFailed: true,
    });
    assert.equal(held.status, 'REFUSED');
    assert.equal(held.reason, 'closure-unknown');
    const malformed = summarizeMacCacheMetadata(result, { ...zero, opened: NaN });
    assert.equal(malformed.status, 'REFUSED');
    assert.ok(!JSON.stringify([held, malformed]).includes('PRIVATE_VALUE'));
});
test(
    'actual non-Darwin wrapper refuses before account/cache reads',
    { skip: process.platform === 'darwin' },
    () => {
        const result = inspectMacCacheMetadata(process.arch);
        assert.equal(result.status, 'REFUSED');
        assert.equal(result.reason, 'context');
        assert.equal(result.resources.filesystemCalls, 0);
        assert.equal(result.resources.opened, 0);
        assert.equal(result.nativeQualification, false);
    },
);
