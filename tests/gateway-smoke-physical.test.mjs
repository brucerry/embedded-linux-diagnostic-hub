// Native-boundary controls over authored maps/handles only. No real files, child, HTTP or timer.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createGatewaySmokePhysicalAdapter } from '../scripts/lib/gateway-smoke-physical.mjs';

const sourceFiles = [
    'scripts/ci/prepare-gateway-runtime-inputs.py',
    'scripts/ci/gateway-runtime-native.py',
    'scripts/ci/prepare-gateway-runtime-child.py',
    'scripts/ci/gateway-runtime-inputs.json',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
function fixture() {
    const records = new Map(),
        handles = new Set(),
        calls = [],
        controls = {},
        timers = [];
    let serial = 0;
    function directory(file) {
        if (records.has(file)) return;
        const parent = path.posix.dirname(file);
        if (parent !== file) directory(parent);
        records.set(file, {
            kind: 'directory',
            bytes: Buffer.alloc(0),
            ino: ++serial,
            mode: 0o40755,
            uid: 1000,
        });
    }
    function write(file, bytes) {
        directory(path.posix.dirname(file));
        const existing = records.get(file);
        records.set(file, {
            kind: 'file',
            bytes: Buffer.from(bytes),
            ino: existing?.ino ?? ++serial,
            mode: existing?.mode ?? 0o100600,
            uid: 1000,
        });
    }
    function stat(file, entry) {
        if (!entry) throw Object.assign(Error('authored absent'), { code: 'ENOENT' });
        return {
            dev: 1,
            ino: entry.ino,
            uid: entry.uid,
            gid: 1000,
            mode: entry.mode,
            nlink: entry.nlink ?? 1,
            size: entry.bytes.length,
            mtimeMs: 1,
            ctimeMs: 1,
            isDirectory: () => entry.kind === 'directory',
            isFile: () => entry.kind === 'file',
            isSymbolicLink: () => entry.kind === 'link',
            ...(controls.statOverrides?.[file] ?? {}),
        };
    }
    directory('/project');
    directory('/job-temp');
    directory('/usr/bin');
    directory('/tools');
    write('/job-temp/original.txt', Buffer.from('abcdefgh'));
    const selection = {
        sourceRoot: '/project',
        temporaryRoot: '/job-temp',
        uid: 1000,
        nodePath: '/tools/node',
        pythonPath: '/usr/bin/python3.12',
        pythonSHA256: hash(Buffer.from('Python data')),
        sourceFiles: Object.fromEntries(sourceFiles.map((file) => [file, hash(Buffer.from(file))])),
    };
    write(selection.pythonPath, Buffer.from('Python data'));
    records.get(selection.pythonPath).mode = 0o100700;
    records.get(selection.pythonPath).uid = 0;
    records.set('/usr/bin/python3', {
        kind: 'link',
        bytes: Buffer.alloc(0),
        ino: ++serial,
        mode: 0o120777,
        uid: 0,
    });
    controls.alias = { '/usr/bin/python3': selection.pythonPath };
    const native = {
        identity: () => ({
            platform: 'linux',
            arch: 'x64',
            uid: 1000,
            executablePath: '/tools/node',
            node: 'v24.22.2',
            ...(controls.identity ?? {}),
        }),
        inherited: (key) => controls.inherited?.[key],
        filesystem: {
            async lstat(file) {
                calls.push({ method: 'lstat', file });
                return stat(file, records.get(file));
            },
            async realpath(file) {
                calls.push({ method: 'realpath', file });
                stat(file, records.get(file));
                return controls.alias?.[file] ?? file;
            },
            async mkdir(file, options) {
                calls.push({ method: 'mkdir', file, options });
                assert.deepEqual(options, { mode: 0o700, recursive: false });
                if (records.has(file))
                    throw Object.assign(Error('authored existing'), { code: 'EEXIST' });
                assert.equal(records.get(path.posix.dirname(file))?.kind, 'directory');
                directory(file);
                records.get(file).mode = 0o40700;
            },
            open(file, flags, mode) {
                calls.push({ method: 'open', file, flags, mode });
                if (controls.syncOpen) return {};
                return Promise.resolve().then(() => {
                    if (flags & constants.O_CREAT) {
                        assert.equal(flags, writeFlags);
                        assert.equal(mode, 0o600);
                        if (records.has(file))
                            throw Object.assign(Error('authored existing'), { code: 'EEXIST' });
                        write(file, Buffer.alloc(0));
                    }
                    const entry = records.get(file);
                    stat(file, entry);
                    let offset = 0;
                    const handle = {
                        async stat() {
                            calls.push({ method: 'stat', file });
                            return stat(file, entry);
                        },
                        async read(buffer, at, length) {
                            calls.push({ method: 'read', file });
                            if (controls.readFailure) throw undefined;
                            const n = Math.min(
                                length,
                                controls.partialRead ?? length,
                                entry.bytes.length - offset,
                            );
                            entry.bytes.copy(buffer, at, offset, offset + n);
                            offset += n;
                            return { bytesRead: n };
                        },
                        async write(buffer, at, length, position) {
                            calls.push({ method: 'write', file });
                            if (controls.writeFailure) throw undefined;
                            const n = Math.min(length, controls.partialWrite ?? length);
                            if (entry.bytes.length < position + n) {
                                const bytes = Buffer.alloc(position + n);
                                entry.bytes.copy(bytes);
                                entry.bytes = bytes;
                            }
                            buffer.copy(entry.bytes, position, at, at + n);
                            return { bytesWritten: n };
                        },
                        async sync() {
                            calls.push({ method: 'sync', file });
                            if (controls.syncFailure) throw undefined;
                        },
                        close() {
                            calls.push({ method: 'close', file });
                            if (controls.syncClose) return undefined;
                            if (controls.closeFailure) return Promise.reject(undefined);
                            if (controls.closeValue) return Promise.resolve({ unsupported: true });
                            handles.delete(handle);
                            return Promise.resolve();
                        },
                    };
                    handles.add(handle);
                    return handle;
                });
            },
            async opendir(file) {
                calls.push({ method: 'opendir', file });
                const entry = records.get(file);
                assert.equal(entry?.kind, 'directory');
                const rows = [...records]
                    .filter(([name]) => path.posix.dirname(name) === file && name !== file)
                    .map(([name, row]) => ({
                        name: path.posix.basename(name),
                        isDirectory: () => row.kind === 'directory',
                        isFile: () => row.kind === 'file',
                        isSymbolicLink: () => row.kind === 'link',
                    }));
                let at = 0;
                const handle = {
                    async read() {
                        calls.push({ method: 'dir-read', file });
                        return rows[at++] ?? null;
                    },
                    async close() {
                        calls.push({ method: 'dir-close', file });
                        if (controls.dirCloseFailure) throw undefined;
                        handles.delete(handle);
                    },
                };
                handles.add(handle);
                return handle;
            },
        },
        launch(file, args) {
            calls.push({ method: 'launch' });
            if (controls.promiseChild) return Promise.resolve({});
            if (controls.memoryChild) {
                const child = new EventEmitter();
                Object.assign(child, {
                    pid: 777,
                    exitCode: null,
                    signalCode: null,
                    spawnfile: file,
                    spawnargs: [file, ...args],
                    stdin: new EventEmitter(),
                    stdout: new EventEmitter(),
                    stderr: new EventEmitter(),
                });
                child.stdin.end = (_bytes, callback) => {
                    child.acknowledgeInput = callback;
                    return child.stdin;
                };
                controls.acquiredChild = child;
                controls.onChildAcquired?.(child);
                return child;
            }
            throw Error('No actual child port in this fixture');
        },
        request() {
            calls.push({ method: 'request' });
            throw Error('No actual request port in this fixture');
        },
        randomBytes(length) {
            calls.push({ method: 'randomBytes', length });
            return Buffer.alloc(length, 0xab);
        },
        setTimer(callback, ms) {
            const timer = { callback, ms };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer) {
            timer.cleared = true;
        },
        now: () => 0,
        requireFrom(parent) {
            calls.push({ method: 'requireFrom', parent });
            const resolver = () =>
                assert.fail('A resolution-only adapter must not import package code');
            resolver.resolve = (specifier) => {
                calls.push({ method: 'resolve', specifier });
                return '/memory/resolution';
            };
            resolver.resolve.paths = () => [];
            return resolver;
        },
    };
    return {
        records,
        handles,
        calls,
        controls,
        timers,
        native,
        selection,
        directory,
        write,
        create: () => createGatewaySmokePhysicalAdapter(selection, native),
    };
}

test('constructor admits only the exact runtime identity and performs no filesystem or child operation', () => {
    const f = fixture(),
        adapter = f.create();
    assert.deepEqual(f.calls, []);
    assert.equal(adapter.owner.snapshot().wholeGroupRetirement, null);
    assert.equal(adapter.owner.snapshot().releaseAcceptance, false);
    adapter.ports.assertSettled();
});
for (const identity of [
    { platform: 'darwin' },
    { arch: 'arm64' },
    { uid: 0 },
    { executablePath: '/different/node' },
    { node: 'v24.22.0' },
])
    test('constructor rejects identity ' + Object.keys(identity)[0] + ' before I/O', () => {
        const f = fixture();
        f.controls.identity = identity;
        assert.throws(() => f.create());
        assert.deepEqual(f.calls, []);
    });
for (const key of [
    'HTTPS_PROXY',
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'PYTHONPATH',
    'SSL_CERT_FILE',
])
    test('constructor rejects inherited ' + key + ' without inspecting its value', () => {
        const f = fixture();
        f.controls.inherited = { [key]: 'authored conflict' };
        assert.throws(() => f.create());
        assert.deepEqual(f.calls, []);
    });
test('mkdir uses an exclusive ordinary 0700 directory operation and does not adopt an existing slot', async () => {
    const f = fixture(),
        adapter = f.create();
    await adapter.ports.filesystem.mkdir('/job-temp/new');
    assert.equal(f.records.get('/job-temp/new').mode, 0o40700);
    await assert.rejects(adapter.ports.filesystem.mkdir('/job-temp/new'));
    assert.equal(f.calls.filter((row) => row.method === 'mkdir').length, 2);
    assert.ok(
        f.calls
            .filter((row) => row.method === 'mkdir')
            .every((row) => row.options.mode === 0o700 && row.options.recursive === false),
    );
});
test('exclusive partial writes use 0600/no-follow creation and sync both file and directory before closure', async () => {
    const f = fixture();
    f.controls.partialWrite = 2;
    const adapter = f.create();
    await adapter.ports.writeExclusive('/job-temp/new.txt', Buffer.from('abcdefgh'));
    assert.equal(f.records.get('/job-temp/new.txt').bytes.toString(), 'abcdefgh');
    const opens = f.calls.filter((row) => row.method === 'open');
    assert.equal(opens[0].flags, writeFlags);
    assert.equal(opens[0].mode, 0o600);
    assert.equal(
        opens[1].flags,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    assert.equal(f.calls.filter((row) => row.method === 'write').length, 4);
    assert.deepEqual(
        f.calls.filter((row) => row.method === 'sync').map((row) => row.file),
        ['/job-temp/new.txt', '/job-temp'],
    );
    assert.equal(f.handles.size, 0);
    adapter.ports.assertSettled();
});
test('an acknowledged publication cannot be silently rewritten through the same owner', async () => {
    const f = fixture(),
        adapter = f.create();
    await adapter.ports.writeExclusive('/job-temp/new.txt', Buffer.from('first'));
    const opens = f.calls.filter((row) => row.method === 'open').length;
    await assert.rejects(adapter.ports.writeExclusive('/job-temp/new.txt', Buffer.from('second')));
    assert.equal(f.records.get('/job-temp/new.txt').bytes.toString(), 'first');
    assert.equal(f.calls.filter((row) => row.method === 'open').length, opens);
});
test('read facade preserves exact no-follow/nonblocking flags and acknowledges partial reads and one close', async () => {
    const f = fixture();
    f.controls.partialRead = 2;
    const adapter = f.create(),
        handle = await adapter.ports.filesystem.open('/job-temp/original.txt', readFlags);
    const out = Buffer.alloc(8);
    let at = 0;
    while (at < out.length) {
        const result = await handle.read(out, at, out.length - at, at);
        at += result.bytesRead;
    }
    assert.equal(out.toString(), 'abcdefgh');
    await handle.close();
    await handle.close();
    assert.equal(f.calls.find((row) => row.method === 'open').flags, readFlags);
    assert.equal(f.calls.filter((row) => row.method === 'read').length, 4);
    assert.equal(f.calls.filter((row) => row.method === 'close').length, 1);
    adapter.ports.assertSettled();
});
test('Dir enumeration stays memory-only and closes its native handle', async () => {
    const f = fixture(),
        adapter = f.create();
    const rows = await adapter.ports.filesystem.readdir('/job-temp', { withFileTypes: true });
    assert.deepEqual(
        rows.map((row) => row.name),
        ['original.txt'],
    );
    assert.equal(f.calls.filter((row) => row.method === 'opendir').length, 1);
    assert.equal(f.calls.filter((row) => row.method === 'dir-close').length, 1);
    adapter.ports.assertSettled();
});
test('raw undefined Dir close failure retains the native and facade leases', async () => {
    const f = fixture();
    f.controls.dirCloseFailure = true;
    const adapter = f.create();
    await assert.rejects(adapter.ports.filesystem.readdir('/job-temp', { withFileTypes: true }));
    assert.equal(adapter.owner.snapshot().nativeHandles, 1);
    assert.equal(adapter.owner.snapshot().files.handles, 1);
    assert.equal(f.calls.filter((row) => row.method === 'dir-close').length, 1);
    assert.throws(() => adapter.ports.assertSettled());
});
test('raw undefined read and close failures remain wrapped, retained and never retried', async () => {
    const f = fixture();
    f.controls.readFailure = true;
    f.controls.closeFailure = true;
    const adapter = f.create(),
        handle = await adapter.ports.filesystem.open('/job-temp/original.txt', readFlags);
    const readError = await handle.read(Buffer.alloc(1), 0, 1, 0).catch((error) => error);
    assert.ok(readError instanceof Error);
    assert.ok(readError.cause instanceof Error);
    assert.equal(readError.cause.cause, undefined);
    await assert.rejects(handle.close());
    await assert.rejects(handle.close());
    assert.equal(adapter.owner.snapshot().failed, true);
    assert.equal(adapter.owner.diagnostics().first, undefined);
    assert.equal(adapter.owner.snapshot().nativeHandles, 1);
    assert.equal(f.calls.filter((row) => row.method === 'close').length, 1);
    assert.throws(() => adapter.ports.assertSettled());
});
test('raw undefined write and close failures retain the uncertain publication and original cause', async () => {
    const f = fixture();
    f.controls.writeFailure = true;
    f.controls.closeFailure = true;
    const adapter = f.create();
    const error = await adapter.ports
        .writeExclusive('/job-temp/new.txt', Buffer.from('authored bytes'))
        .catch((value) => value);
    assert.ok(error instanceof Error);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.cause, undefined);
    const snapshot = adapter.owner.snapshot();
    assert.equal(snapshot.failed, true);
    assert.equal(snapshot.files.uncertainPublications, 1);
    assert.equal(snapshot.nativeHandles, 1);
    assert.throws(() => adapter.ports.assertSettled());
});
test('synchronous filesystem acquisition is refused and its unknown return stays owned', async () => {
    const f = fixture();
    f.controls.syncOpen = true;
    const adapter = f.create();
    await assert.rejects(adapter.ports.filesystem.open('/job-temp/original.txt', readFlags));
    assert.equal(adapter.owner.snapshot().unknownReturns, 1);
    assert.throws(() => adapter.ports.assertSettled());
});
for (const which of ['syncClose', 'closeValue'])
    test('unsupported ' + which + ' cannot acknowledge native handle retirement', async () => {
        const f = fixture();
        f.controls[which] = true;
        const adapter = f.create(),
            handle = await adapter.ports.filesystem.open('/job-temp/original.txt', readFlags);
        await assert.rejects(handle.close());
        assert.equal(adapter.owner.snapshot().nativeHandles, 1);
        assert.throws(() => adapter.ports.assertSettled());
    });
for (const which of ['mode', 'uid', 'inode', 'kind', 'alias'])
    test('unsafe parent ' + which + ' refuses the operation before native open', async () => {
        const f = fixture();
        if (which === 'mode') f.records.get('/job-temp').mode = 0o40777;
        if (which === 'uid') f.records.get('/job-temp').uid = 9999;
        if (which === 'inode') f.controls.statOverrides = { '/job-temp': { ino: 2 ** 53 } };
        if (which === 'kind') f.records.get('/job-temp').kind = 'link';
        if (which === 'alias') f.controls.alias = { '/job-temp': '/elsewhere' };
        const adapter = f.create();
        await assert.rejects(adapter.ports.filesystem.open('/job-temp/original.txt', readFlags));
        assert.equal(f.calls.filter((row) => row.method === 'open').length, 0);
    });
test('read flag widening is rejected before filesystem acquisition', async () => {
    const f = fixture(),
        adapter = f.create();
    assert.throws(() =>
        adapter.ports.filesystem.open('/job-temp/original.txt', constants.O_RDONLY),
    );
    assert.deepEqual(f.calls, []);
});
test('process and HTTP ports cannot activate before owned runtime input preparation', () => {
    const f = fixture(),
        adapter = f.create();
    assert.throws(() => adapter.ports.launch('/tools/node', ['/unrelated'], { shell: false }));
    assert.throws(() => adapter.ports.request({ hostname: '127.0.0.1' }, () => {}));
    assert.equal(
        f.calls.filter((row) => row.method === 'launch' || row.method === 'request').length,
        0,
    );
});
test('a Promise child acquisition is retained as unknown and never retried', async () => {
    const f = fixture();
    f.controls.promiseChild = true;
    for (const file of sourceFiles) f.write('/project/' + file, Buffer.from(file));
    const adapter = f.create(),
        installRoot = '/job-temp/isolated/validation/gateway-runtime/install';
    f.directory(installRoot);
    const request = {
        sourceLockBytes: Buffer.from('authored lock data'),
        installRoot,
        archivesRoot: path.posix.dirname(installRoot) + '/inputs/runtime-archives',
    };
    await assert.rejects(adapter.ports.installRuntimeInputs(request));
    assert.equal(f.calls.filter((row) => row.method === 'launch').length, 1);
    assert.equal(adapter.owner.snapshot().unknownReturns, 1);
    assert.equal(adapter.owner.snapshot().children.length, 0);
    await assert.rejects(adapter.ports.installRuntimeInputs(request));
    assert.equal(f.calls.filter((row) => row.method === 'launch').length, 1);
    assert.throws(() => adapter.ports.assertSettled());
});
test('native child pipe close alone cannot settle the owner without actual EOF observations', async () => {
    const f = fixture();
    f.controls.memoryChild = true;
    for (const file of sourceFiles) f.write('/project/' + file, Buffer.from(file));
    const adapter = f.create(),
        installRoot = '/job-temp/isolated/validation/gateway-runtime/install';
    f.directory(installRoot);
    const childReady = new Promise((resolve) => {
        f.controls.onChildAcquired = resolve;
    });
    const operation = adapter.ports
        .installRuntimeInputs({
            sourceLockBytes: Buffer.from('authored lock data'),
            installRoot,
            archivesRoot: path.posix.dirname(installRoot) + '/inputs/runtime-archives',
        })
        .catch((error) => error);
    const child = await Promise.race([
        childReady,
        operation.then((error) => {
            throw error;
        }),
    ]);
    assert.ok(child, 'Reach the explicit memory child acquisition.');
    child.emit('spawn');
    child.acknowledgeInput();
    child.stdin.emit('finish');
    child.stdin.emit('close');
    child.stdout.emit('close');
    child.stderr.emit('close');
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const failure = await operation;
    assert.ok(failure instanceof Error);
    const row = adapter.owner.snapshot().children[0];
    assert.equal(row.stdout, true);
    assert.equal(row.stderr, true);
    assert.equal(row.stdoutEnd, false);
    assert.equal(row.stderrEnd, false);
    assert.throws(() => adapter.ports.assertSettled());
    child.stdout.emit('end');
    child.stderr.emit('end');
    assert.throws(() => adapter.ports.assertSettled());
    assert.equal(f.calls.filter((item) => item.method === 'launch').length, 1);
});
test('module resolution has no fallback import and unknown parent/specifier pairs are refused', async () => {
    const f = fixture(),
        adapter = f.create();
    await assert.rejects(adapter.ports.resolveModule('/unrelated/package.json', 'ssh2'));
    await assert.rejects(
        adapter.ports.resolveModule('/job-temp/install/package.json', 'unexpected'),
    );
    assert.equal(f.calls.filter((row) => row.method === 'requireFrom').length, 0);
});
test('run reaches the actual core readback guard once and never retries malformed producer input', async () => {
    const f = fixture(),
        adapter = f.create();
    const input = {
        sourceRoot: '/project',
        temporaryRoot: '/job-temp',
        uid: 1000,
        builder: { runtime: { executablePath: '/tools/node' } },
        readback: Object.fromEntries(
            [
                'recordBytes',
                'archiveBytes',
                'checksumBytes',
                'sourcePackageBytes',
                'sourceLockBytes',
                'compiledBytes',
            ].map((name) => [name, Buffer.from('not a canonical record')]),
        ),
        expected: { context: {}, buildRecord: {}, artifacts: [] },
    };
    const first = await adapter.run(input).catch((error) => error);
    assert.ok(first instanceof Error);
    assert.ok(first.cause instanceof Error);
    assert.equal(first.owner, adapter.owner);
    assert.deepEqual(f.calls, []);
    await assert.rejects(adapter.run(input));
    assert.deepEqual(f.calls, []);
});
