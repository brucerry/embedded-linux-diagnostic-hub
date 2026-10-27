import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import type { Server } from 'node:net';
import { createHash } from 'node:crypto';
import {
    createLinuxNativeBackend,
    linuxProcIdentity,
    type LinuxNativeOps,
} from '../electron/linux-native-backend.ts';
import {
    LinuxTransactionModel,
    linuxModelReviewSHA256,
    type LinuxModelPlan,
    type LinuxModelView,
    type LinuxMemoryEffects,
} from '../electron/linux-transaction-model.ts';
import { INSTALLATION_PRODUCT, validateInstallationManifest } from '../shared/installation.ts';
import { SETUP_PAYLOAD, SETUP_OWNER } from '../electron/installation-maintenance.ts';
import { desiredLinuxMenu } from '../electron/linux-menu-ownership.ts';
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const installationId = '11111111-1111-4111-8111-111111111111',
    transactionId = '22222222-2222-4222-8222-222222222222',
    token = '33333333-3333-4333-8333-333333333333';
const procStat = (pid = 777, ticks = '9999', state = 'S', comm = 'worker') =>
    `${pid} (${comm}) ${state} ${Array(18).fill('0').join(' ')} ${ticks}\n`;
interface FakeNode {
    path: string;
    kind: 'file' | 'directory' | 'link';
    ino: number;
    uid: number;
    mode: number;
    bytes: Buffer;
    target?: string;
    proc?: boolean;
    mtime: number;
    nlink: number;
}
class FakeServer extends EventEmitter {
    listening = false;
    endpoint = '';
    unavailable = false;
    closed = 0;
    listenCalls = 0;
    hang = false;
    listen(options: { path: string }) {
        this.listenCalls++;
        this.endpoint = options.path;
        if (!this.hang)
            queueMicrotask(() => {
                if (this.unavailable)
                    this.emit('error', Object.assign(Error('inert'), { code: 'EADDRINUSE' }));
                else {
                    this.listening = true;
                    this.emit('listening');
                }
            });
        return this;
    }
    address() {
        return this.listening ? this.endpoint : null;
    }
    close(done: (error?: Error) => void) {
        this.closed++;
        this.listening = false;
        queueMicrotask(() => done());
        return this;
    }
}
function fixture(atomicMove = true) {
    const nodes = new Map<string, FakeNode>(),
        fds = new Map<number, FakeNode>(),
        calls: string[] = [],
        timers = new Map<object, () => void>();
    let inode = 1,
        fdCounter = 3,
        now = 0;
    let hook: (name: string, file?: string) => void = () => {};
    const error = (code: string): never => {
        throw Object.assign(Error('private-inert-canary'), { code });
    };
    const parent = (file: string) => file.slice(0, file.lastIndexOf('/')) || '/';
    const directory = (
        file: string,
        uid = file.startsWith('/home/test') || file.startsWith('/proc/777') ? 1000 : 0,
        mode = 0o700,
    ) => {
        if (nodes.has(file)) return nodes.get(file)!;
        if (file !== '/') directory(parent(file));
        const node: FakeNode = {
            path: file,
            kind: 'directory',
            ino: inode++,
            uid,
            mode: 0o40000 | mode,
            bytes: Buffer.alloc(0),
            mtime: 1,
            nlink: 1,
        };
        nodes.set(file, node);
        return node;
    };
    const file = (name: string, text: string, mode = 0o600, uid = 1000) => {
        directory(parent(name));
        const node: FakeNode = {
            path: name,
            kind: 'file',
            ino: inode++,
            uid,
            mode: 0o100000 | mode,
            bytes: Buffer.from(text),
            mtime: 1,
            nlink: 1,
        };
        nodes.set(name, node);
        return node;
    };
    const resolve = (name: string) => {
        const match = /^\/proc\/self\/fd\/(\d+)(.*)$/.exec(name);
        if (!match) return name;
        const node = fds.get(Number(match[1]));
        if (!node) return error('EBADF');
        return (node.path + match[2]).replace(/\/+/g, '/');
    };
    const node = (name: string) => {
        const result = nodes.get(resolve(name));
        if (!result) return error('ENOENT');
        return result;
    };
    const stats = (value: FakeNode) => ({
        dev: 1,
        ino: value.ino,
        uid: value.uid,
        mode: value.mode,
        nlink: value.nlink,
        size: value.proc ? 0 : value.bytes.length,
        mtimeMs: value.mtime,
        ctimeMs: value.mtime,
        isFile: () => value.kind === 'file',
        isDirectory: () => value.kind === 'directory',
        isSymbolicLink: () => value.kind === 'link',
    });
    const call = (name: string, path?: string) => {
        calls.push(name);
        hook(name, path);
    };
    const fakeFS = {
        constants,
        lstatSync(name: string) {
            call('lstat', name);
            return stats(node(name));
        },
        fstatSync(fd: number) {
            call('fstat');
            const item = fds.get(fd);
            if (!item) return error('EBADF');
            return stats(item);
        },
        realpathSync(name: string) {
            call('realpath', name);
            return node(name).path;
        },
        readlinkSync(name: string) {
            call('readlink', name);
            const item = node(name);
            if (item.kind !== 'link') return error('EINVAL');
            return item.target!;
        },
        openSync(name: string, flags: number, mode = 0o600) {
            call('open', name);
            const canonical = resolve(name);
            let value = nodes.get(canonical);
            if ((flags & constants.O_CREAT) !== 0) {
                if (value && (flags & constants.O_EXCL) !== 0) return error('EEXIST');
                if (!value) value = file(canonical, '', mode);
            }
            if (!value) return error('ENOENT');
            if (value.kind === 'link' && (flags & constants.O_NOFOLLOW) !== 0)
                return error('ELOOP');
            if ((flags & constants.O_DIRECTORY) !== 0 && value.kind !== 'directory')
                return error('ENOTDIR');
            const fd = fdCounter++;
            fds.set(fd, value);
            return fd;
        },
        closeSync(fd: number) {
            call('close');
            if (!fds.delete(fd)) return error('EBADF');
        },
        readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
            call('read');
            const item = fds.get(fd);
            if (!item) return error('EBADF');
            const size = Math.max(0, Math.min(3, length, item.bytes.length - position));
            item.bytes.copy(buffer, offset, position, position + size);
            return size;
        },
        writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
            call('write');
            const item = fds.get(fd);
            if (!item) return error('EBADF');
            const size = Math.min(3, length),
                result = Buffer.alloc(Math.max(item.bytes.length, position + size));
            item.bytes.copy(result);
            buffer.copy(result, position, offset, offset + size);
            item.bytes = result;
            item.mtime++;
            return size;
        },
        ftruncateSync(fd: number, size: number) {
            call('truncate');
            const item = fds.get(fd);
            if (!item) return error('EBADF');
            item.bytes = Buffer.from(item.bytes.subarray(0, size));
            item.mtime++;
        },
        statfsSync() {
            call('statfs');
            return { bavail: 1024 * 1024, bsize: 4096 };
        },
        fsyncSync() {
            call('sync');
        },
        mkdirSync(name: string, options: { mode: number }) {
            call('mkdir', name);
            const canonical = resolve(name);
            if (nodes.has(canonical)) return error('EEXIST');
            directory(canonical, 1000, options.mode);
        },
        opendirSync(name: string) {
            call('opendir', name);
            const item = node(name);
            if (item.kind !== 'directory') return error('ENOTDIR');
            const entries = [...nodes.keys()]
                .filter((entry) => entry !== item.path && parent(entry) === item.path)
                .map((entry) => entry.slice(entry.lastIndexOf('/') + 1));
            let at = 0;
            return {
                readSync() {
                    call('readdir');
                    return at < entries.length ? { name: entries[at++] } : null;
                },
                closeSync() {
                    call('closedir');
                },
            };
        },
    } as unknown as LinuxNativeOps['fs'];
    const host = {
        platform: 'linux',
        arch: 'x64',
        uid: 1000,
        euid: 1000,
        home: '/home/test',
        appData: '/home/test/data',
        sourceRoot: '/home/test/source',
        version: '0.6.0',
    };
    directory(host.home);
    directory(host.appData);
    directory(host.sourceRoot);
    directory(host.sourceRoot + '/app');
    const manifest = validateInstallationManifest({
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        layout: 'linux-folder',
        platform: 'linux',
        arch: 'x64',
        version: '0.6.0',
        sourceCommit: 'a'.repeat(40),
        entryPoint: 'app/diagnostic-hub',
        files: [{ kind: 'file', path: 'app/diagnostic-hub', bytes: 7, sha256: hash('fixture') }],
    });
    file(host.sourceRoot + '/' + SETUP_PAYLOAD, JSON.stringify(manifest));
    file(host.sourceRoot + '/app/diagnostic-hub', 'fixture', 0o755);
    const proc = file('/proc/777/stat', procStat(), 0o444);
    proc.proc = true;
    const exe = file('/proc/777/exe', '', 0o777);
    exe.kind = 'link';
    exe.target = host.sourceRoot + '/app/diagnostic-hub';
    const root = '/home/test/installed';
    const review: LinuxModelView = {
        activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' },
        parents: ['/', '/home', '/home/test', '/home/test/data', '/home/test/source'].map(
            (name) => {
                const item = node(name);
                return { path: name, uid: item.uid, dev: 1, ino: item.ino, mode: item.mode };
            },
        ),
        source: {
            identity: { uid: 1000, dev: 1, ino: node(host.sourceRoot).ino },
            manifest,
            verifiedManifestSHA256: hash(JSON.stringify(manifest)),
        },
        root: null,
        stage: null,
        previous: null,
        journal: null,
    };
    const plan: LinuxModelPlan = {
        host,
        root,
        action: 'install',
        transactionId,
        installationId,
        owner: {
            pid: 777,
            startTicks: '9999',
            executable: host.sourceRoot + '/app/diagnostic-hub',
        },
        consent: true,
        review,
        reviewSHA256: linuxModelReviewSHA256(review),
    };
    const server = new FakeServer();
    const ops: LinuxNativeOps = {
        platform: 'linux',
        arch: 'x64',
        uid: () => 1000,
        euid: () => 1000,
        pid: 777,
        executable: plan.owner.executable,
        now: () => now,
        uuid: () => token,
        fs: fakeFS,
        server: () => server as unknown as Server,
        later(callback) {
            const timer = {};
            timers.set(timer, callback);
            return timer as ReturnType<typeof setTimeout>;
        },
        cancel(timer) {
            timers.delete(timer);
        },
        moveNoReplace: !atomicMove
            ? null
            : (sourceFD, sourceName, targetFD, targetName) => {
                  call('move-noreplace');
                  const source = fds.get(sourceFD)!.path + '/' + sourceName,
                      target = fds.get(targetFD)!.path + '/' + targetName;
                  if (nodes.has(target)) return error('EEXIST');
                  if (!nodes.has(source)) return error('ENOENT');
                  const entries = [...nodes.entries()].filter(
                      ([name]) => name === source || name.startsWith(source + '/'),
                  );
                  for (const [name] of entries) nodes.delete(name);
                  for (const [name, value] of entries) {
                      value.path = target + name.slice(source.length);
                      nodes.set(value.path, value);
                  }
              },
    };
    const backend = () => createLinuxNativeBackend(plan, { startedMs: 0, deadlineMs: 120000 }, ops);
    return {
        plan,
        ops,
        backend,
        nodes,
        fds,
        calls,
        server,
        timers,
        file,
        directory,
        node,
        setHook(fn: typeof hook) {
            hook = fn;
        },
        advance(value: number) {
            now = value;
        },
    };
}
async function acquire(
    f: ReturnType<typeof fixture>,
    backend: ReturnType<typeof createLinuxNativeBackend>,
) {
    return backend.kernel.acquire({
        root: f.plan.root,
        uid: 1000,
        key: backend.scope.key,
        owner: clone(f.plan.owner),
    });
}
test('native backend refuses unsupported platform and invalid window without any OS-facade call', () => {
    const f = fixture();
    assert.throws(
        () =>
            createLinuxNativeBackend(
                f.plan,
                { startedMs: 0, deadlineMs: 120000 },
                { ...f.ops, platform: 'darwin' },
            ),
        /UNSUPPORTED_PLATFORM/,
    );
    assert.throws(
        () => createLinuxNativeBackend(f.plan, { startedMs: 0, deadlineMs: 120001 }, f.ops),
        /NATIVE_WINDOW/,
    );
    assert.deepEqual(f.calls, []);
});
test('Linux stat parser handles parenthesized comm and refuses malformed/oversized identity', () => {
    assert.deepEqual(linuxProcIdentity(procStat(777, '123', 'S', 'a) b (c)'), 777), {
        state: 'S',
        startTicks: '123',
    });
    for (const text of ['', procStat(778), 'x'.repeat(8193), procStat(777, '0')])
        assert.throws(() => linuxProcIdentity(text, 777));
});
test('concrete reservation implementation binds exact abstract endpoint and closes only its own server', async () => {
    const f = fixture(),
        b = f.backend(),
        held = await acquire(f, b);
    assert.ok(held);
    assert.equal(f.server.endpoint, '\0' + b.scope.key);
    assert.equal(f.server.listenCalls, 1);
    assert.equal(f.server.listening, true);
    assert.deepEqual(await b.kernel.current(held.handle), held.identity);
    assert.equal(await b.kernel.release(held.handle, held.identity), true);
    assert.equal(f.server.closed, 1);
    assert.equal(b.diagnostics().retainedServers, 0);
    assert.equal(f.fds.size, 0);
});
test('EADDRINUSE is exact unavailable, never a stale-owner unlink or alternate bind', async () => {
    const f = fixture();
    f.server.unavailable = true;
    const b = f.backend();
    assert.equal(await acquire(f, b), null);
    assert.equal(f.server.listenCalls, 1);
    await assert.rejects(acquire(f, b), /CONSUMED/);
    assert.equal(f.server.listenCalls, 1);
    assert.equal(f.server.closed, 0);
});
test('native mutation default is unavailable without no-replace primitive, with zero OS writes/calls', async () => {
    const f = fixture(false),
        b = f.backend();
    assert.equal(b.capabilities.directoryMoveNoReplace, false);
    await assert.rejects(
        b.effects.journal(b.scope, f.plan.review, {} as never),
        /ATOMIC_MOVE_UNAVAILABLE/,
    );
    assert.deepEqual(f.calls, []);
    assert.equal(f.server.listenCalls, 0);
});
test('real observer code verifies bytes/ownership/activity through fake FDs, never invokes native OS', async () => {
    const f = fixture(),
        b = f.backend();
    const view = await b.effects.observe(b.scope);
    assert.equal(linuxModelReviewSHA256(view), f.plan.reviewSHA256);
    assert.equal(f.fds.size, 0);
    assert.equal(b.diagnostics().retainedFDs, 0);
});
test('concrete filesystem implementation completes fresh install using memory-only syscall facade', async () => {
    const f = fixture(),
        b = f.backend();
    // Test-only bridge. Production code never converts native-unqualified to a model driver capability.
    const effects = {
        ...b.effects,
        kind: 'injected-memory-effects' as const,
    } satisfies LinuxMemoryEffects;
    const result = await new LinuxTransactionModel(b.kernel, effects).run(f.plan);
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(result.reservation, 'released');
    assert.equal(f.node(f.plan.root + '/app/diagnostic-hub').bytes.toString(), 'fixture');
    assert.equal(f.node(f.plan.root + '/app/diagnostic-hub').mode & 0o777, 0o755);
    assert.equal(f.fds.size, 0);
    assert.equal(f.server.closed, 1);
    assert.equal(b.diagnostics().failed, false);
    assert.ok(f.calls.includes('move-noreplace'));
    assert.equal(
        f.calls.some((call) => /unlink|delete|signal|spawn/.test(call)),
        false,
    );
});
test('production model refuses native tag before reservation even with complete fake native facade', async () => {
    const f = fixture(),
        b = f.backend();
    const summary = await new LinuxTransactionModel(
        b.kernel,
        b.effects as unknown as LinuxMemoryEffects,
    ).run(f.plan);
    assert.equal(summary.verdict, 'REFUSED');
    assert.deepEqual(f.calls, []);
    assert.equal(f.server.listenCalls, 0);
});
test('read corruption and foreign maintenance content stop without mutations or private-error exposure', async () => {
    for (const problem of ['checksum', 'foreign-work', 'symlink', 'shared-write'] as const) {
        const f = fixture(),
            b = f.backend();
        if (problem === 'checksum')
            f.node(f.plan.host.sourceRoot + '/app/diagnostic-hub').bytes = Buffer.from('changed');
        if (problem === 'foreign-work')
            f.directory(b.scope.stage.slice(0, b.scope.stage.lastIndexOf('/')));
        if (problem === 'symlink') f.node(f.plan.host.sourceRoot + '/app').kind = 'link';
        if (problem === 'shared-write') f.node(f.plan.host.home).mode |= 0o022;
        await assert.rejects(b.effects.observe(b.scope), /NATIVE_/);
        assert.equal(b.diagnostics().failed, true);
        assert.equal(
            f.calls.some((call) => ['write', 'mkdir', 'move-noreplace'].includes(call)),
            false,
        );
        assert.doesNotMatch(JSON.stringify(b.diagnostics()), /private-inert-canary|\/home|fixture/);
    }
});
test('open return is retained before deadline check and no close/read is performed after expiry', async () => {
    const f = fixture(),
        b = f.backend();
    f.setHook((name) => {
        if (name === 'open') f.advance(120000);
    });
    await assert.rejects(b.effects.observe(b.scope), /DEADLINE/);
    assert.equal(f.fds.size, 1);
    assert.equal(b.diagnostics().retainedFDs, 1);
    assert.equal(f.calls.at(-1), 'open');
    assert.equal(f.calls.includes('read'), false);
    assert.equal(f.calls.includes('close'), false);
});
test('activity implementation marks owned active executable or inaccessible process unknown', async () => {
    for (const inaccessible of [false, true]) {
        const f = fixture(),
            b = f.backend();
        f.file('/proc/888/stat', procStat(888), 0o444).proc = true;
        f.node('/proc/888').uid = 1000;
        const executable = f.file('/proc/888/exe', '', 0o777);
        executable.kind = 'link';
        executable.target = f.plan.root + '/app/diagnostic-hub';
        if (inaccessible)
            f.setHook((name, file) => {
                if (name === 'readlink' && file === '/proc/888/exe')
                    throw Object.assign(Error('private'), { code: 'EACCES' });
            });
        const result = await b.effects.observe(b.scope);
        assert.equal(result.activity.root, inaccessible ? 'unknown' : 'active');
        assert.equal(result.activity.stage, inaccessible ? 'unknown' : 'inactive');
    }
});
test('kernel deadline retains server and late event cannot fabricate a lease or trigger cleanup', async () => {
    const f = fixture(),
        b = f.backend();
    f.server.hang = true;
    const pending = acquire(f, b);
    // Only fake microtasks run; no real timer or socket is used.
    assert.equal(f.timers.size, 1);
    f.advance(120000);
    [...f.timers.values()][0]();
    await assert.rejects(pending, /DEADLINE/);
    assert.equal(b.diagnostics().retainedServers, 1);
    assert.equal(f.server.closed, 0);
    f.server.listening = true;
    f.server.emit('listening');
    assert.equal(b.diagnostics().lateEvents, 1);
    assert.equal(b.diagnostics().failed, true);
    assert.equal(f.server.listenCalls, 1);
});

test('concrete write failure retains partial namespace/FD/server and does not cleanup or continue', async () => {
    const f = fixture(),
        b = f.backend();
    f.setHook((name) => {
        if (name === 'write') throw Error('private-write-canary');
    });
    const summary = await new LinuxTransactionModel(b.kernel, {
        ...b.effects,
        kind: 'injected-memory-effects',
    }).run(f.plan);
    assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
    assert.equal(f.calls.at(-1), 'write');
    assert.ok(b.diagnostics().retainedFDs > 0);
    assert.ok(b.diagnostics().allocations > 0);
    assert.equal(f.server.closed, 0);
    assert.equal(f.nodes.has(f.plan.root), false);
    assert.equal(
        f.node(f.plan.host.sourceRoot + '/app/diagnostic-hub').bytes.toString(),
        'fixture',
    );
    assert.doesNotMatch(JSON.stringify(b.diagnostics()), /canary|\/home/);
});
test('late successful mkdir is registered before post-return refusal with no readback/cleanup', async () => {
    const f = fixture(),
        b = f.backend();
    f.setHook((name) => {
        if (name === 'mkdir') f.advance(120000);
    });
    const summary = await new LinuxTransactionModel(b.kernel, {
        ...b.effects,
        kind: 'injected-memory-effects',
    }).run(f.plan);
    assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
    assert.equal(f.calls.at(-1), 'mkdir');
    assert.equal(b.diagnostics().allocations, 1);
    assert.ok(b.diagnostics().retainedFDs > 0);
    assert.equal(f.server.closed, 0);
    assert.equal(f.nodes.has(f.plan.root), false);
});
test('atomic no-replace provider preserves a destination inserted after the absence check', async () => {
    const f = fixture(),
        original = f.ops.moveNoReplace!;
    let foreignInode = 0;
    f.ops.moveNoReplace = (sourceFD, sourceName, targetFD, targetName) => {
        foreignInode = f.directory(f.plan.root).ino;
        original(sourceFD, sourceName, targetFD, targetName); // fake atomic primitive rejects EEXIST
    };
    const b = f.backend(),
        summary = await new LinuxTransactionModel(b.kernel, {
            ...b.effects,
            kind: 'injected-memory-effects',
        }).run(f.plan);
    assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
    assert.equal(f.node(f.plan.root).ino, foreignInode);
    assert.equal(f.nodes.has(f.plan.root + '/app/diagnostic-hub'), false);
    assert.equal(f.node(b.scope.stage + '/app/diagnostic-hub').bytes.toString(), 'fixture');
    assert.equal(f.server.closed, 0);
    assert.equal(f.calls.at(-1), 'move-noreplace');
});
test('wrong current uid refuses before filesystem/process metadata and does not bind', async () => {
    const f = fixture();
    f.ops.uid = () => 0;
    const b = f.backend();
    await assert.rejects(acquire(f, b), /HOST_IDENTITY/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.server.listenCalls, 0);
});
test('late timer creation cannot admit listen and retains its returned timer/server', async () => {
    const f = fixture(),
        original = f.ops.later;
    f.ops.later = (callback, milliseconds) => {
        const value = original(callback, milliseconds);
        f.advance(120000);
        return value;
    };
    const b = f.backend();
    await assert.rejects(acquire(f, b), /DEADLINE/);
    assert.equal(f.server.listenCalls, 0);
    assert.equal(b.diagnostics().retainedTimers, 1);
    assert.equal(b.diagnostics().retainedServers, 1);
});
test('post-bind kernel error makes later operations refuse without additional IO', async () => {
    const f = fixture(),
        b = f.backend(),
        lease = await acquire(f, b);
    assert.ok(lease);
    f.server.emit('error', Error('private-socket-canary'));
    const count = f.calls.length;
    await assert.rejects(b.kernel.current(lease.handle), /NATIVE_/);
    assert.equal(f.calls.length, count);
    assert.equal(f.server.closed, 0);
    assert.doesNotMatch(JSON.stringify(b.diagnostics()), /canary/);
});
test('proc enumeration bound returns unknown rather than claiming inactivity', async () => {
    const f = fixture();
    for (let count = 0; count < 4096; count++) f.directory('/proc/' + (10000 + count), 0, 0o555);
    const b = f.backend(),
        view = await b.effects.observe(b.scope);
    assert.deepEqual(view.activity, { root: 'unknown', stage: 'unknown', previous: 'unknown' });
    assert.equal(f.calls.filter((call) => call === 'readlink').length, 1); // only current backend owner
});
test('only newly accepted reservation sockets are rejected; no data or process action occurs', async () => {
    const f = fixture(),
        b = f.backend();
    await acquire(f, b);
    const socket = new EventEmitter() as EventEmitter & { destroy(): void };
    let rejected = 0;
    socket.destroy = () => {
        rejected++;
        socket.emit('close');
    };
    f.server.emit('connection', socket);
    assert.equal(rejected, 1);
    assert.equal(b.diagnostics().retainedSockets, 0);
    assert.equal(f.server.listening, true);
    assert.equal(f.server.closed, 0);
});

test('existing staging reserve is checked before mkdir/write and low space retains unchanged roots', async () => {
    const f = fixture();
    f.ops.fs.statfsSync = (() => ({
        bavail: 0,
        bsize: 4096,
    })) as unknown as LinuxNativeOps['fs']['statfsSync'];
    const b = f.backend(),
        summary = await new LinuxTransactionModel(b.kernel, {
            ...b.effects,
            kind: 'injected-memory-effects',
        }).run(f.plan);
    assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
    assert.equal(b.diagnostics().code, 'NATIVE_SPACE');
    assert.equal(f.calls.includes('mkdir'), false);
    assert.equal(f.calls.includes('write'), false);
    assert.equal(f.nodes.has(f.plan.root), false);
});

test('a close callback without observed server closure cannot retire reservation custody', async () => {
    const f = fixture(),
        b = f.backend(),
        lease = await acquire(f, b);
    assert.ok(lease);
    f.server.close = (done) => {
        queueMicrotask(() => done());
        return f.server;
    };
    await assert.rejects(b.kernel.release(lease.handle, lease.identity), /RELEASE_UNCERTAIN/);
    assert.equal(f.server.listening, true);
    assert.equal(b.diagnostics().retainedServers, 1);
    assert.equal(b.diagnostics().failed, true);
});

for (const failure of ['expired', 'prefailed'] as const)
    test(
        'B1 late accepted socket contains later errors before gate refusal: ' + failure,
        async () => {
            const f = fixture(),
                b = f.backend();
            await acquire(f, b);
            if (failure === 'expired') f.advance(120000);
            else f.server.emit('error', Error('private-prefailure-canary'));
            const calls = f.calls.length,
                closes = f.server.closed,
                timers = f.timers.size;
            const socket = new EventEmitter() as EventEmitter & { destroy(): void };
            let destroys = 0;
            socket.destroy = () => {
                destroys++;
            };
            assert.doesNotThrow(() => f.server.emit('connection', socket));
            assert.equal(socket.listenerCount('error'), 1);
            assert.equal(socket.listenerCount('close'), 0);
            assert.doesNotThrow(() => socket.emit('error', Error('private-peer-canary')));
            assert.doesNotThrow(() => socket.emit('error', { private: 'another-private-canary' }));
            assert.equal(b.diagnostics().retainedSockets, 1);
            assert.equal(b.diagnostics().failed, true);
            assert.equal(destroys, 0);
            assert.equal(f.server.closed, closes);
            assert.equal(f.calls.length, calls);
            assert.equal(f.timers.size, timers);
            assert.equal(f.server.listening, true);
            assert.doesNotMatch(JSON.stringify(b.diagnostics()), /canary|private|peer/);
        },
    );

// New menu cases use ONLY the pre-existing injected memory syscall/server/timer facade.
function menuFixture(selected = true, installed = false, atomicMove = true) {
    const f = fixture(atomicMove), dataHome = '/home/test/xdg';
    f.plan.menu = { dataHome, selected };
    f.directory(dataHome); f.directory(dataHome + '/applications');
    f.plan.review.parents.push(...[dataHome, dataHome + '/applications'].map((path) => {
        const node = f.node(path); return { path, uid: node.uid, dev: 1, ino: node.ino, mode: node.mode };
    }));
    f.plan.review.parents.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const desired = desiredLinuxMenu(f.plan);
    const oldText = desired.text.replace('Name=Diagnostic Hub', 'Name=Prior Diagnostic Hub');
    const oldRecord = { ...desired.record, bytes: Buffer.byteLength(oldText), sha256: hash(oldText) };
    f.plan.review.menu = { current: null, candidate: null, previous: null };
    if (installed) {
        const old = clone(f.plan.review.source.manifest); old.version = '0.5.2';
        const release = JSON.stringify(old), oldTransaction = '55555555-5555-4555-8555-555555555555';
        f.directory(f.plan.root); f.file(f.plan.root + '/app/diagnostic-hub', 'fixture', 0o755);
        f.file(f.plan.root + '/.diagnostic-hub-release.json', release);
        f.file(f.plan.root + '/.diagnostic-hub-installation.json', JSON.stringify({ schemaVersion: 1,
            product: INSTALLATION_PRODUCT, installationId, manifestSHA256: hash(release), profile: 'dedicated' }));
        f.file(f.plan.root + '/' + SETUP_OWNER, JSON.stringify({ schemaVersion: 1, product: INSTALLATION_PRODUCT,
            root: f.plan.root, installationId, transactionId: oldTransaction,
            options: { startMenu: true, desktop: false, launch: false }, integrations: [oldRecord] }));
        const menu = f.file(desired.record.path, oldText, 0o644);
        f.plan.review.root = { identity: { dev: 1, ino: f.node(f.plan.root).ino, uid: 1000 },
            manifest: old, verifiedManifestSHA256: hash(release), root: f.plan.root, installationId,
            transactionId: oldTransaction, profile: f.plan.host.appData + '/DiagnosticHub/profiles/' + installationId,
            menu: oldRecord };
        f.plan.review.menu.current = { identity: { dev: 1, ino: menu.ino, uid: 1000 }, bytes: menu.bytes.length, sha256: hash(menu.bytes) };
        f.plan.action = 'update';
    }
    const marker = f.plan.host.appData + '/DiagnosticHub/profiles/' + installationId + '/marker';
    f.file(marker, 'retained-profile-marker');
    f.plan.reviewSHA256 = linuxModelReviewSHA256(f.plan.review);
    return { ...f, desired, oldRecord, oldText, marker };
}
function menuDriver(b: ReturnType<typeof createLinuxNativeBackend>): LinuxMemoryEffects {
    // Same explicit memory-only bridge as prior facade cases; never a production qualification.
    return { ...b.effects, kind: 'injected-memory-effects' };
}
test('MN1 concrete menu facade creates only declared exact bytes after journal and keeps profile', async () => {
    const f = menuFixture(), b = f.backend();
    const result = await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan);
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED'); assert.equal(result.reservation, 'released');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.desired.text);
    const owner = JSON.parse(f.node(f.plan.root + '/' + SETUP_OWNER).bytes.toString());
    assert.deepEqual(owner.integrations, [f.desired.record]); assert.equal(owner.options.startMenu, true);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.equal(b.capabilities.productionDispatch, false); assert.equal(b.capabilities.nativeQualified, false);
    assert.equal(f.calls.some((x) => /unlink|delete|signal|spawn/.test(x)), false);
});
test('MN2 concrete replacement and explicit rollback retain both menu versions and exact profile', async () => {
    const f = menuFixture(true, true), b = f.backend();
    assert.equal((await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan)).verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const observed = await b.effects.observe(b.scope);
    f.plan.action = 'rollback'; f.plan.review = clone(observed); f.plan.reviewSHA256 = linuxModelReviewSHA256(observed);
    const recovery = f.backend();
    assert.equal((await new LinuxTransactionModel(recovery.kernel, menuDriver(recovery)).run(f.plan)).verdict, 'ROLLED_BACK_RETAINED');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.oldText);
    const rootOwner = JSON.parse(f.node(f.plan.root + '/' + SETUP_OWNER).bytes.toString());
    assert.deepEqual(rootOwner.integrations, [f.oldRecord]);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.ok([...f.nodes.values()].some((node) => node.path.endsWith('/menu-candidate.desktop') && node.bytes.toString() === f.desired.text));
});
test('MN3 concrete deselection retains the menu preimage and explicit rollback restores it', async () => {
    const f = menuFixture(false, true), b = f.backend();
    assert.equal((await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan)).verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(f.nodes.has(f.desired.record.path), false);
    assert.ok([...f.nodes.values()].some((node) => node.path.endsWith('/menu-previous.desktop') && node.bytes.toString() === f.oldText));
    const observed = await b.effects.observe(b.scope); f.plan.action = 'rollback'; f.plan.review = clone(observed); f.plan.reviewSHA256 = linuxModelReviewSHA256(observed);
    const recovery = f.backend();
    assert.equal((await new LinuxTransactionModel(recovery.kernel, menuDriver(recovery)).run(f.plan)).verdict, 'ROLLED_BACK_RETAINED');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.oldText);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
});
test('MN4 concrete factory refuses same-byte foreign menu before any syscall facade operation', () => {
    const f = menuFixture(); const file = f.file(f.desired.record.path, f.desired.text, 0o644);
    f.plan.review.menu!.current = { identity: { dev: 1, ino: file.ino, uid: 1000 }, bytes: file.bytes.length, sha256: hash(file.bytes) };
    f.plan.reviewSHA256 = linuxModelReviewSHA256(f.plan.review);
    assert.throws(() => f.backend(), /FOREIGN_OR_EDITED/); assert.deepEqual(f.calls, []);
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.desired.text);
});
test('MN5 concrete menu write uncertainty keeps journal ownership and stops without cleanup or release', async () => {
    const f = menuFixture(), original = f.ops.fs.writeSync;
    f.ops.fs.writeSync = ((fd: number, ...args: unknown[]) => {
        if (f.fds.get(fd)?.path.endsWith('/menu-candidate.desktop')) {
            f.calls.push('refused-menu-write'); throw Error('private-menu-write-canary');
        }
        return (original as (...args: unknown[]) => number)(fd, ...args);
    }) as typeof original;
    const b = f.backend(), result = await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan);
    assert.equal(result.verdict, 'RETAINED_UNKNOWN'); assert.equal(f.calls.at(-1), 'refused-menu-write');
    assert.equal(f.server.closed, 0); assert.ok(b.diagnostics().retainedFDs > 0);
    assert.deepEqual(JSON.parse(f.node(f.plan.root + '/' + SETUP_OWNER).bytes.toString()).integrations, [f.desired.record]);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.doesNotMatch(JSON.stringify(result), /canary/);
});
test('MN6 missing no-replace binding refuses menu mutation before any filesystem facade call', async () => {
    const f = menuFixture(true, false, false), b = f.backend();
    await assert.rejects(b.effects.menuStage!(b.scope, f.plan.review, f.desired.record, f.desired.text), /ATOMIC_MOVE_UNAVAILABLE/);
    assert.deepEqual(f.calls, []); assert.equal(b.diagnostics().retainedFDs, 0);
});

test('MN7 M1 owned0600 and0644 menu modes survive replacement deselection and exact rollback', async () => {
    for (const selected of [true, false]) for (const mode of [0o600, 0o644]) {
        const f = menuFixture(selected, true), original = f.node(f.desired.record.path);
        original.mode = 0o100000 | mode;
        const originalInode = original.ino, b = f.backend();
        assert.equal((await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan)).verdict, 'ACTIVE_PREVIOUS_RETAINED');
        const work = b.scope.stage.slice(0, b.scope.stage.lastIndexOf('/'));
        assert.equal(f.node(work + '/menu-previous.desktop').mode & 0o777, mode);
        assert.equal(f.node(work + '/menu-previous.desktop').ino, originalInode);
        const observed = await b.effects.observe(b.scope);
        f.plan.action = 'rollback'; f.plan.review = clone(observed); f.plan.reviewSHA256 = linuxModelReviewSHA256(observed);
        const recovery = f.backend();
        assert.equal((await new LinuxTransactionModel(recovery.kernel, menuDriver(recovery)).run(f.plan)).verdict, 'ROLLED_BACK_RETAINED');
        const restored = f.node(f.desired.record.path);
        assert.equal(restored.mode & 0o777, mode); assert.equal(restored.ino, originalInode);
        assert.equal(restored.bytes.toString(), f.oldText);
        assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    }
});
test('MN8 M1 foreign UID link and shared-write menu preimages refuse before namespace mutation', async () => {
    for (const problem of ['foreign-uid', 'link', 'shared-write'] as const) {
        const f = menuFixture(true, true), menu = f.node(f.desired.record.path);
        if (problem === 'foreign-uid') menu.uid = 2000;
        if (problem === 'link') { menu.kind = 'link'; menu.target = '/unrelated-private-canary'; }
        if (problem === 'shared-write') menu.mode = 0o100666;
        const b = f.backend();
        const result = await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan);
        assert.equal(result.verdict, 'RETAINED_UNKNOWN');
        assert.equal(f.calls.some((name) => /^(write|truncate|mkdir|move-noreplace)$/.test(name)), false);
        assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    }
});
test('MN9 M1 journal metadata remains private even though retained desktop files admit0644', async () => {
    const f = menuFixture(), b = f.backend();
    assert.equal((await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan)).verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const work = b.scope.stage.slice(0, b.scope.stage.lastIndexOf('/'));
    const journalPath = work + '/journal.json', journal = f.node(journalPath);
    const original = { ino: journal.ino, uid: journal.uid, nlink: journal.nlink,
        kind: journal.kind, mtime: journal.mtime, bytes: Buffer.from(journal.bytes) };
    assert.equal(journal.mode, 0o100600);
    assert.equal(journal.kind, 'file'); assert.equal(journal.uid, 1000); assert.equal(journal.nlink, 1);
    assert.ok(journal.ino > 0 && journal.bytes.length > 0 && journal.bytes.length <= 8192);
    assert.doesNotThrow(() => JSON.parse(journal.bytes.toString('utf8')));
    journal.mode = 0o100644; // Change ONLY the private-file mode counterexample, not JSON content/identity.
    assert.equal(journal.mode & 0o7022, 0); assert.notEqual(journal.mode & 0o077, 0);
    let targetLstats = 0, targetOpens = 0, lastWasTargetLstat = false;
    const isJournal = (file?: string) => {
        if (file === undefined) return false;
        const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(file);
        const resolved = match ? (f.fds.get(Number(match[1]))?.path ?? '') + (match[2] ?? '') : file;
        return resolved.replace(/\/+/g, '/') === journalPath;
    };
    f.setHook((name, file) => {
        const target = isJournal(file);
        lastWasTargetLstat = name === 'lstat' && target;
        if (target) {
            if (name === 'lstat') targetLstats++;
            if (name === 'open') targetOpens++;
        }
    });
    const count = f.calls.length;
    // json() deliberately maps the inner private-file refusal to its exact public metadata code.
    await assert.rejects(b.effects.observe(b.scope), (error: unknown) =>
        error instanceof Error && error.message === 'NATIVE_METADATA');
    assert.ok(targetLstats > 0); assert.equal(targetOpens, 0);
    assert.equal(f.calls.at(-1), 'lstat'); assert.equal(lastWasTargetLstat, true);
    // No IO after this exact target's pre-open regular/private check.
    assert.equal(b.diagnostics().failed, true); assert.equal(b.diagnostics().code, 'NATIVE_METADATA');
    assert.equal(f.calls.slice(count).some((name) => /^(write|truncate|mkdir|move-noreplace)$/.test(name)), false);
    assert.equal(journal.mode, 0o100644);
    assert.deepEqual({ ino: journal.ino, uid: journal.uid, nlink: journal.nlink,
        kind: journal.kind, mtime: journal.mtime, bytes: journal.bytes }, original);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
});
