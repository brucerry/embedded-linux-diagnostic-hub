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
    type LinuxModelJournal,
    type LinuxMemoryEffects,
} from '../electron/linux-transaction-model.ts';
import { INSTALLATION_PRODUCT, validateInstallationManifest } from '../shared/installation.ts';
import { SETUP_PAYLOAD, SETUP_OWNER } from '../electron/installation-maintenance.ts';
import { desiredLinuxMenu, prepareLinuxMenuJournal } from '../electron/linux-menu-ownership.ts';
import { createLinuxNativeDriver } from '../electron/linux-native-driver.ts';
import {
    createLinuxOwnedLaunch,
    createLinuxNativeLaunchProcessHost,
} from '../electron/linux-owned-launch.ts';
import type { ChildProcess } from 'node:child_process';
import { linuxReadbackPair } from './fixtures/linux-readback-port.ts';
import { createLinuxMainReadback } from '../electron/linux-setup-readback.ts';
import type { LinuxSetupReadiness } from '../shared/types.ts';
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
    const f = fixture(atomicMove),
        dataHome = '/home/test/xdg';
    f.plan.menu = { dataHome, selected };
    f.directory(dataHome);
    f.directory(dataHome + '/applications');
    f.plan.review.parents.push(
        ...[dataHome, dataHome + '/applications'].map((path) => {
            const node = f.node(path);
            return { path, uid: node.uid, dev: 1, ino: node.ino, mode: node.mode };
        }),
    );
    f.plan.review.parents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const desired = desiredLinuxMenu(f.plan);
    const oldText = desired.text.replace('Name=Diagnostic Hub', 'Name=Prior Diagnostic Hub');
    const oldRecord = {
        ...desired.record,
        bytes: Buffer.byteLength(oldText),
        sha256: hash(oldText),
    };
    f.plan.review.menu = { current: null, candidate: null, previous: null };
    if (installed) {
        const old = clone(f.plan.review.source.manifest);
        old.version = '0.5.2';
        const release = JSON.stringify(old),
            oldTransaction = '55555555-5555-4555-8555-555555555555';
        f.directory(f.plan.root);
        f.file(f.plan.root + '/app/diagnostic-hub', 'fixture', 0o755);
        f.file(f.plan.root + '/.diagnostic-hub-release.json', release);
        f.file(
            f.plan.root + '/.diagnostic-hub-installation.json',
            JSON.stringify({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                installationId,
                manifestSHA256: hash(release),
                profile: 'dedicated',
            }),
        );
        f.file(
            f.plan.root + '/' + SETUP_OWNER,
            JSON.stringify({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                root: f.plan.root,
                installationId,
                transactionId: oldTransaction,
                options: { startMenu: true, desktop: false, launch: false },
                integrations: [oldRecord],
            }),
        );
        const menu = f.file(desired.record.path, oldText, 0o644);
        f.plan.review.root = {
            identity: { dev: 1, ino: f.node(f.plan.root).ino, uid: 1000 },
            manifest: old,
            verifiedManifestSHA256: hash(release),
            root: f.plan.root,
            installationId,
            transactionId: oldTransaction,
            profile: f.plan.host.appData + '/DiagnosticHub/profiles/' + installationId,
            menu: oldRecord,
        };
        f.plan.review.menu.current = {
            identity: { dev: 1, ino: menu.ino, uid: 1000 },
            bytes: menu.bytes.length,
            sha256: hash(menu.bytes),
        };
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

test('native driver completes install without changing native effects to a memory tag', async () => {
    const f = fixture(),
        driver = createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops);
    assert.deepEqual(f.calls, []);
    assert.throws(
        () => (driver.run as (...args: unknown[]) => unknown)({ root: '/foreign' }),
        /DRIVER_ARGUMENTS/,
    );
    const result = await driver.run();
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(result.reservation, 'released');
    assert.equal(result.modelOnly, false);
    assert.equal(result.nativeQualified, false);
    assert.equal(result.productionDispatch, false);
    assert.equal(f.node(f.plan.root + '/app/diagnostic-hub').bytes.toString(), 'fixture');
    assert.equal(f.fds.size, 0);
    assert.equal(f.server.closed, 1);
    await assert.rejects(driver.run(), /consumed/);
});
test('native driver repairs a matching version while retaining previous payload and profile', async () => {
    const f = menuFixture(true, true),
        source = f.node(f.plan.host.sourceRoot + '/' + SETUP_PAYLOAD).bytes.toString();
    f.node(f.plan.root + '/.diagnostic-hub-release.json').bytes = Buffer.from(source);
    const installed = f.node(f.plan.root + '/.diagnostic-hub-installation.json'),
        record = JSON.parse(installed.bytes.toString());
    record.manifestSHA256 = hash(source);
    installed.bytes = Buffer.from(JSON.stringify(record));
    f.plan.review.root!.manifest = clone(f.plan.review.source.manifest);
    f.plan.review.root!.verifiedManifestSHA256 = hash(source);
    f.plan.action = 'repair';
    f.plan.reviewSHA256 = linuxModelReviewSHA256(f.plan.review);
    const driver = createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
        result = await driver.run();
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(result.reservation, 'released');
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    const observer = f.backend(),
        view = await observer.effects.observe(observer.scope);
    assert.equal(view.previous!.manifest.version, '0.6.0');
    assert.equal(f.fds.size, 0);
});
test('native driver performs update and explicit rollback with exact retained menu and profile preimages', async () => {
    const f = menuFixture(true, true),
        window = { startedMs: 0, deadlineMs: 120000 };
    const first = createLinuxNativeDriver(f.plan, window, f.ops);
    assert.equal((await first.run()).verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.desired.text);
    const observer = f.backend(),
        view = await observer.effects.observe(observer.scope);
    f.plan.action = 'rollback';
    f.plan.review = clone(view);
    f.plan.reviewSHA256 = linuxModelReviewSHA256(view);
    const recovery = createLinuxNativeDriver(f.plan, window, f.ops);
    assert.equal((await recovery.run()).verdict, 'ROLLED_BACK_RETAINED');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.oldText);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.equal(f.fds.size, 0);
});
async function preparedNativeResume(
    f: ReturnType<typeof fixture>,
    point: 'prepared' | 'retained-move' | 'old-retained' | 'activated-move',
) {
    const b = f.backend(),
        held = await acquire(f, b);
    assert.ok(held);
    let view = await b.effects.observe(b.scope);
    const journal: LinuxModelJournal = {
        schemaVersion: 1,
        root: f.plan.root,
        uid: f.plan.host.uid,
        transactionId: f.plan.transactionId,
        installationId: f.plan.installationId,
        profile: f.plan.host.appData + '/DiagnosticHub/profiles/' + f.plan.installationId,
        candidateSHA256: view.source.verifiedManifestSHA256,
        previousSHA256: view.root?.verifiedManifestSHA256 ?? null,
        owner: clone(f.plan.owner),
        phase: 'copying',
        ...(f.plan.menu
            ? { menu: prepareLinuxMenuJournal(f.plan, view.root?.menu ?? null, view.menu!.current) }
            : {}),
    };
    view = await b.effects.journal(b.scope, view, journal);
    view = await b.effects.stage(b.scope, view, {
        manifest: clone(view.source.manifest),
        verifiedManifestSHA256: journal.candidateSHA256,
        installationId: journal.installationId,
        transactionId: journal.transactionId,
        root: journal.root,
        profile: journal.profile,
        ...(journal.menu?.after ? { menu: clone(journal.menu.after) } : {}),
    });
    view = await b.effects.journal(b.scope, view, { ...journal, phase: 'prepared' });
    if (point !== 'prepared' && view.root)
        view = await b.effects.move(b.scope, view, 'root', 'previous');
    if (point === 'old-retained' || point === 'activated-move')
        view = await b.effects.journal(b.scope, view, { ...journal, phase: 'old-retained' });
    if (point === 'activated-move') view = await b.effects.move(b.scope, view, 'stage', 'root');
    // A controlled completed lifetime yields the reservation. This does not retire a failed real owner.
    assert.equal(await b.kernel.release(held.handle, held.identity), true);
    assert.equal(f.fds.size, 0);
    f.plan.action = 'resume';
    f.plan.review = clone(view);
    f.plan.reviewSHA256 = linuxModelReviewSHA256(view);
    return { before: clone(view), scope: b.scope };
}
test('native explicit resume uses real backend phases, no-replace moves and untouched menu preimages', async () => {
    for (const point of ['prepared', 'retained-move', 'old-retained', 'activated-move'] as const) {
        const f = menuFixture(true, true),
            seeded = await preparedNativeResume(f, point),
            prior = clone(seeded.before.previous ?? seeded.before.root),
            candidate = clone(seeded.before.stage ?? seeded.before.root);
        const result = await createLinuxNativeDriver(
            f.plan,
            { startedMs: 0, deadlineMs: 120000 },
            f.ops,
        ).run();
        assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED', point);
        assert.equal(result.reservation, 'released');
        assert.equal(result.nativeQualified, false);
        assert.equal(result.productionDispatch, false);
        const observer = f.backend(),
            view = await observer.effects.observe(observer.scope);
        assert.deepEqual(view.root, candidate);
        assert.deepEqual(view.previous, prior);
        assert.deepEqual(view.journal!.owner, seeded.before.journal!.owner);
        assert.equal(view.journal!.phase, 'candidate-active');
        assert.equal(view.journal!.menu!.phase, 'applied');
        assert.equal(view.stage, null);
        assert.equal(f.node(f.desired.record.path).bytes.toString(), f.desired.text);
        assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
        assert.equal(f.fds.size, 0);
        assert.equal(f.server.closed, 2);
    }
});
test('native resume of fresh prepared payload preserves absence of previous app and does not recopy', async () => {
    const f = fixture(),
        { before } = await preparedNativeResume(f, 'prepared'),
        stagedInode = before.stage!.identity.ino;
    const result = await createLinuxNativeDriver(
        f.plan,
        { startedMs: 0, deadlineMs: 120000 },
        f.ops,
    ).run();
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(f.node(f.plan.root).ino, stagedInode);
    const observer = f.backend(),
        view = await observer.effects.observe(observer.scope);
    assert.equal(view.previous, null);
    assert.equal(view.journal!.previousSHA256, null);
    assert.equal(f.fds.size, 0);
    assert.equal(f.server.closed, 2);
});
test('native resume refuses a live reservation without modifying reviewed files', async () => {
    const f = fixture();
    await preparedNativeResume(f, 'prepared');
    const before = [...f.nodes.values()].map((n) => ({ ...n, bytes: n.bytes.toString('hex') }));
    f.server.unavailable = true;
    const result = await createLinuxNativeDriver(
        f.plan,
        { startedMs: 0, deadlineMs: 120000 },
        f.ops,
    ).run();
    assert.equal(result.verdict, 'REFUSED');
    assert.equal(result.reason, 'RESERVATION_UNAVAILABLE');
    assert.deepEqual(
        [...f.nodes.values()].map((n) => ({ ...n, bytes: n.bytes.toString('hex') })),
        before,
    );
    assert.equal(f.server.closed, 1);
});
test('native resume rejects a staged payload checksum change after review and retains new custody', async () => {
    const f = fixture(),
        seeded = await preparedNativeResume(f, 'prepared');
    f.node(seeded.scope.stage + '/app/diagnostic-hub').bytes = Buffer.from('changed');
    const result = await createLinuxNativeDriver(
        f.plan,
        { startedMs: 0, deadlineMs: 120000 },
        f.ops,
    ).run();
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(result.reservation, 'held');
    assert.equal(f.nodes.has(f.plan.root), false);
    assert.equal(f.server.closed, 1);
    assert.equal(f.node(seeded.scope.stage + '/app/diagnostic-hub').bytes.toString(), 'changed');
});
test('native resume refuses an interrupted menu phase before any host action', async () => {
    const f = menuFixture(true, true);
    await preparedNativeResume(f, 'prepared');
    f.plan.review.journal!.menu!.phase = 'staged';
    f.plan.reviewSHA256 = linuxModelReviewSHA256(f.plan.review);
    const index = f.calls.length;
    assert.throws(
        () => createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
        /DRIVER_PLAN/,
    );
    assert.equal(f.calls.length, index);
    assert.equal(f.server.closed, 1);
});
test('native resume retains uncertain journal FD and reservation after moving old app, without retry', async () => {
    const f = menuFixture(true, true),
        seeded = await preparedNativeResume(f, 'prepared');
    f.setHook((name) => {
        if (name === 'write') throw Error('controlled recovery write failure');
    });
    const driver = createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
        result = await driver.run();
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(result.pending, 'journal');
    assert.equal(result.reservation, 'held');
    assert.ok(driver.diagnostics().retainedFDs > 0);
    assert.equal(f.nodes.has(f.plan.root), false);
    assert.equal(f.node(seeded.scope.previous).ino, seeded.before.root!.identity.ino);
    assert.equal(f.node(seeded.scope.stage).ino, seeded.before.stage!.identity.ino);
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.oldText);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.equal(f.server.closed, 1);
    const index = f.calls.length;
    await assert.rejects(driver.run(), /consumed/);
    assert.equal(f.calls.length, index);
    assert.equal(f.calls.at(-1), 'write');
});
async function launchFixture(enableReadback = false) {
    const f = fixture();
    assert.equal(
        (await createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops).run())
            .verdict,
        'ACTIVE_PREVIOUS_RETAINED',
    );
    const observer = f.backend();
    f.plan.review = await observer.effects.observe(observer.scope);
    f.plan.reviewSHA256 = linuxModelReviewSHA256(f.plan.review);
    f.plan.action = 'launch';
    const child = Object.assign(new EventEmitter(), {
        pid: 888,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
    });
    const pair = enableReadback ? linuxReadbackPair() : null;
    if (pair) Object.assign(child, { stdio: [null, child.stdout, child.stderr, pair.parent] });
    const requests: unknown[] = [];
    const host = {
        spawn(request: unknown) {
            requests.push(request);
            return child as unknown as ChildProcess;
        },
    };
    const desktop = { DISPLAY: ':99', XAUTHORITY: '/home/test/.Xauthority' };
    const controller = createLinuxOwnedLaunch(
        f.plan,
        { startedMs: 0, deadlineMs: 120000 },
        desktop,
        f.ops,
        host,
        enableReadback,
    );
    const addChild = () => {
        f.directory('/proc/888', 1000);
        f.file('/proc/888/stat', procStat(888, '10001').replace(' S 0 ', ' S 777 ')).proc = true;
        const link = f.file('/proc/888/exe', '');
        link.kind = 'link';
        link.target = f.plan.root + '/app/diagnostic-hub';
    };
    async function phase(name: string) {
        for (let i = 0; i < 1000; i++) {
            if (
                controller.summary().pending === name ||
                controller.summary().verdict === 'RETAINED_UNKNOWN'
            )
                break;
            await Promise.resolve();
        }
        if (controller.summary().pending !== name) {
            for (const expire of [...f.timers.values()]) expire();
            assert.equal(controller.summary().pending, name, JSON.stringify(controller.summary()));
        }
    }
    const close = () => {
        f.node('/proc/888/stat').bytes = Buffer.from(
            procStat(888, '10001', 'Z').replace(' Z 0 ', ' Z 777 '),
        );
        child.emit('exit', 0, null);
        for (const pipe of [child.stdout, child.stderr]) {
            pipe.emit('end');
            pipe.emit('close');
        }
        child.emit('close', 0, null);
    };
    return { ...f, child, host, requests, desktop, controller, addChild, phase, close, pair };
}
test('owned launch optionally reads its actual channel and rechecks child generation without granting successor authority', async () => {
    const f = await launchFixture(true),
        pending = f.controller.run();
    await f.phase('spawn-event');
    f.addChild();
    f.child.emit('spawn');
    await f.phase('setup-readback');
    const record: LinuxSetupReadiness = {
        schemaVersion: 1,
        source: 'linux-main-self-observation',
        root: f.plan.root,
        installationId: f.plan.installationId,
        transactionId: f.plan.transactionId,
        manifestSHA256: f.plan.review.source.verifiedManifestSHA256,
        version: f.plan.host.version,
        process: {
            pid: 888,
            uid: 1000,
            executable: f.plan.root + '/app/diagnostic-hub',
            creationTimeMs: 10000,
        },
        profile: { path: f.plan.review.root!.profile, lockOwned: true },
        window: {
            electronId: 1,
            nativeHandleHex: '0100000000000000',
            visible: true,
            minimized: false,
            mainFrameReady: true,
        },
        observedAtMs: Date.now(),
        payloadIntegrity: 'not-checked',
        independentProcessObservation: false,
        independentWindowObservation: false,
        descendantRetirement: false,
        finalizationAuthority: false,
    };
    const main = createLinuxMainReadback(f.pair!.child);
    main.offer(record, async () => ({ ...record, observedAtMs: Date.now() }));
    await f.pair!.pump(
        () =>
            f.controller.summary().pending === 'child-and-pipe-close' ||
            f.controller.summary().verdict === 'RETAINED_UNKNOWN',
    );
    assert.equal(f.controller.summary().pending, 'child-and-pipe-close');
    assert.equal(f.controller.readiness()!.transactionId, f.plan.transactionId);
    f.close();
    const result = await pending;
    assert.equal(result.verdict, 'DIRECT_CHILD_CLOSED_RETAINED');
    assert.equal(result.readback!.channelBoundFreshReadback, true);
    assert.equal(result.reservation, 'none');
    assert.equal(result.successorVerified, false);
    assert.equal(f.server.closed, 2);
    assert.equal(f.server.listening, false);
    assert.equal(f.controller.diagnostics().retainedServers, 0);
    assert.equal(f.controller.diagnostics().retainedSockets, 0);
    assert.equal(f.controller.diagnostics().retainedTimers, 0);
    assert.equal(f.pair!.parent.closed, true);
    await main.joinClosure();
    assert.equal((f.requests[0] as { readback?: boolean }).readback, true);
});
test('owned launch deadline aborts pending readback and preserves child, channel and reservation custody', async () => {
    const f = await launchFixture(true),
        pending = f.controller.run();
    await f.phase('spawn-event');
    f.addChild();
    f.child.emit('spawn');
    await f.phase('setup-readback');
    for (const expire of [...f.timers.values()]) expire();
    const result = await pending;
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(result.code, 'DEADLINE_RETAINED');
    assert.equal(result.reservation, 'held');
    assert.equal(result.readback!.retained, true);
    assert.equal(f.pair!.parent.ends, 0);
    assert.equal(f.server.closed, 1);
    assert.equal(f.controller.readiness(), null);
});
test('owned folder launch uses guarded exact executable, captured local environment and direct pipe closure', async () => {
    const f = await launchFixture(),
        expectedRoot = f.plan.root;
    const pending = f.controller.run();
    await f.phase('spawn-event');
    f.desktop.DISPLAY = ':100';
    f.plan.root = '/home/test/foreign';
    f.host.spawn = () => {
        throw Error('replacement must not run');
    };
    f.plan.root = expectedRoot;
    f.addChild();
    f.child.emit('spawn');
    await f.phase('child-and-pipe-close');
    f.child.stdout.emit('data', Buffer.from('private-output-canary'));
    assert.deepEqual(f.requests, [
        {
            executable: expectedRoot + '/app/diagnostic-hub',
            root: expectedRoot,
            environment: {
                HOME: '/home/test',
                XDG_CONFIG_HOME: '/home/test/data',
                PATH: '/usr/bin:/bin',
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                TZ: 'UTC',
                LD_LIBRARY_PATH: expectedRoot + '/app/usr/lib',
                DISPLAY: ':99',
                XAUTHORITY: '/home/test/.Xauthority',
            },
        },
    ]);
    f.close();
    const result = await pending;
    assert.equal(result.verdict, 'DIRECT_CHILD_CLOSED_RETAINED');
    assert.equal(result.identityObserved, true);
    assert.equal(result.childOwned, false);
    assert.equal(result.timerOwned, false);
    assert.equal(result.reservation, 'none');
    assert.equal(result.successorVerified, false);
    assert.equal(result.wholeGroupRetirement, false);
    assert.equal(result.nativeQualified, false);
    assert.equal(result.productionDispatch, false);
    assert.doesNotMatch(JSON.stringify(result), /private-output-canary|\/home/);
    assert.equal(f.controller.diagnostics().retainedServers, 0);
    assert.equal(f.controller.diagnostics().retainedSockets, 0);
    assert.equal(f.controller.diagnostics().retainedTimers, 0);
    assert.equal(f.server.closed, 2);
    assert.equal(f.server.listening, false);
    assert.equal(f.fds.size, 0);
    const count = f.calls.length;
    await assert.rejects(f.controller.run(), /consumed/);
    assert.equal(f.calls.length, count);
});
test('owned launch refuses a live reservation and changed reviewed payload without spawning', async () => {
    for (const kind of ['reservation', 'changed'] as const) {
        const f = await launchFixture();
        if (kind === 'reservation') f.server.unavailable = true;
        else f.node(f.plan.root + '/app/diagnostic-hub').bytes = Buffer.from('changed');
        const result = await f.controller.run();
        assert.equal(result.verdict, 'RETAINED_UNKNOWN');
        assert.equal(
            result.code,
            kind === 'reservation' ? 'RESERVATION_UNAVAILABLE' : 'GUARD_OR_HOST_UNCERTAIN',
        );
        assert.equal(f.requests.length, 0);
        assert.equal(f.server.closed, 1);
    }
});
test('owned launch rejects foreign parent, UID, executable and changing process-start identity', async () => {
    for (const kind of ['parent', 'uid', 'executable', 'start-ticks'] as const) {
        const f = await launchFixture(),
            pending = f.controller.run();
        await f.phase('spawn-event');
        f.addChild();
        if (kind === 'parent') f.node('/proc/888/stat').bytes = Buffer.from(procStat(888, '10001'));
        if (kind === 'uid') f.node('/proc/888').uid = 1001;
        if (kind === 'executable') f.node('/proc/888/exe').target = '/home/test/foreign';
        if (kind === 'start-ticks')
            f.setHook((name, file) => {
                if (name === 'readlink' && file === '/proc/888/exe')
                    f.node('/proc/888/stat').bytes = Buffer.from(
                        procStat(888, '10002').replace(' S 0 ', ' S 777 '),
                    );
            });
        f.child.emit('spawn');
        const result = await pending;
        assert.equal(result.verdict, 'RETAINED_UNKNOWN', kind);
        assert.equal(result.identityObserved, false);
        assert.equal(result.reservation, 'held');
        assert.equal(f.server.closed, 1);
    }
});
test('owned launch never treats exit alone or stream end alone as pipe retirement', async () => {
    const f = await launchFixture(),
        pending = f.controller.run();
    await f.phase('spawn-event');
    f.addChild();
    f.child.emit('spawn');
    await f.phase('child-and-pipe-close');
    f.child.emit('exit', 0, null);
    f.child.stdout.emit('end');
    f.child.stderr.emit('end');
    assert.equal(f.controller.summary().childOwned, true);
    assert.equal(f.controller.summary().exited, true);
    for (const expire of [...f.timers.values()]) expire();
    const result = await pending;
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(result.code, 'DEADLINE_RETAINED');
    assert.equal(result.reservation, 'held');
    f.close();
    assert.equal(f.controller.summary().verdict, 'RETAINED_UNKNOWN');
    assert.equal(f.controller.summary().code, 'DEADLINE_RETAINED');
    assert.equal(f.server.closed, 1);
});
test('owned launch retains custody on nonzero exit, signal, pipe error or excessive output', async () => {
    for (const kind of ['nonzero', 'signal', 'pipe-error', 'overflow'] as const) {
        const f = await launchFixture(),
            pending = f.controller.run();
        await f.phase('spawn-event');
        f.addChild();
        f.child.emit('spawn');
        await f.phase('child-and-pipe-close');
        if (kind === 'nonzero') f.child.emit('exit', 1, null);
        if (kind === 'signal') f.child.emit('exit', null, 'SIGTERM');
        if (kind === 'pipe-error') f.child.stderr.emit('error', Error('private-canary'));
        if (kind === 'overflow') f.child.stdout.emit('data', Buffer.alloc(65537));
        const result = await pending;
        assert.equal(result.verdict, 'RETAINED_UNKNOWN');
        assert.equal(result.reservation, 'held');
        assert.doesNotMatch(JSON.stringify(result), /private-canary|SIGTERM/);
        assert.equal(f.server.closed, 1);
        assert.equal(f.controller.diagnostics().retainedServers, 1);
    }
});
test('owned launch captures a returned child before listener failure and never attempts fallback cleanup', async () => {
    const f = await launchFixture();
    const broken = createLinuxOwnedLaunch(
        f.plan,
        { startedMs: 0, deadlineMs: 120000 },
        f.desktop,
        f.ops,
        {
            spawn: () =>
                ({
                    on() {
                        throw Error('private');
                    },
                }) as unknown as ChildProcess,
        },
    );
    const result = await broken.run();
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(result.childOwned, true);
    assert.equal(result.reservation, 'held');
    assert.equal(f.server.closed, 1);
});
test('owned launch deadline before spawn acknowledgement retains the child and fences late completion', async () => {
    const f = await launchFixture(),
        pending = f.controller.run();
    await f.phase('spawn-event');
    for (const expire of [...f.timers.values()]) expire();
    const result = await pending;
    assert.equal(result.code, 'DEADLINE_RETAINED');
    assert.equal(result.childOwned, true);
    assert.equal(result.timerOwned, false);
    f.addChild();
    f.child.emit('spawn');
    f.close();
    assert.equal(f.controller.summary().verdict, 'RETAINED_UNKNOWN');
    assert.equal(f.server.closed, 1);
});
test('owned launch refuses injected environment, getters and missing host before facade actions', async () => {
    const f = await launchFixture(),
        index = f.calls.length;
    for (const env of [
        { DISPLAY: 'remote:0' },
        { DISPLAY: ':99', NODE_OPTIONS: '--require=foreign' },
        { DISPLAY: ':99', XAUTHORITY: '/home/test/../foreign' },
        { WAYLAND_DISPLAY: '../socket', XDG_RUNTIME_DIR: '/run/user/1000' },
        { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/tmp/foreign' },
    ])
        assert.throws(
            () =>
                createLinuxOwnedLaunch(
                    f.plan,
                    { startedMs: 0, deadlineMs: 120000 },
                    env,
                    f.ops,
                    f.host,
                ),
            /ENVIRONMENT/,
        );
    let reads = 0;
    const host = Object.defineProperty({}, 'spawn', {
        get() {
            reads++;
            throw Error('private');
        },
    });
    assert.throws(
        () =>
            createLinuxOwnedLaunch(
                f.plan,
                { startedMs: 0, deadlineMs: 120000 },
                f.desktop,
                f.ops,
                host as never,
            ),
        /INPUT/,
    );
    assert.throws(
        () => createLinuxOwnedLaunch(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.desktop),
        /HOST_UNADMITTED/,
    );
    assert.equal(reads, 0);
    assert.equal(f.calls.length, index);
});
test('transaction runner cannot accidentally execute an admitted launch through the mutation algorithm', async () => {
    const f = await launchFixture(),
        backend = f.backend(),
        index = f.calls.length;
    const result = await new LinuxTransactionModel(backend.kernel, backend.effects as never).run(
        f.plan,
    );
    assert.equal(result.verdict, 'REFUSED');
    assert.equal(result.reason, 'ADMISSION_REFUSED');
    assert.equal(f.calls.length, index);
    assert.equal(
        typeof createLinuxNativeLaunchProcessHost().spawn,
        'function',
        'Constructing the native adapter is inert.',
    );
});
test('owned launch admission refuses incomplete journal, candidate mismatch and unknown activity before effects', async () => {
    for (const kind of ['journal', 'transaction', 'source', 'activity'] as const) {
        const f = await launchFixture(),
            index = f.calls.length;
        if (kind === 'journal') f.plan.review.journal!.phase = 'prepared';
        if (kind === 'transaction')
            f.plan.review.root!.transactionId = '55555555-5555-4555-8555-555555555555';
        if (kind === 'source') f.plan.review.root!.verifiedManifestSHA256 = 'f'.repeat(64);
        if (kind === 'activity') f.plan.review.activity.root = 'unknown';
        f.plan.reviewSHA256 = linuxModelReviewSHA256(f.plan.review);
        assert.throws(() =>
            createLinuxOwnedLaunch(
                f.plan,
                { startedMs: 0, deadlineMs: 120000 },
                f.desktop,
                f.ops,
                f.host,
            ),
        );
        assert.equal(f.calls.length, index);
        assert.equal(f.requests.length, 0);
    }
});
test('owned launch refuses missing pipe handles and async spawn error while retaining the returned child', async () => {
    for (const kind of ['pipe', 'error'] as const) {
        const f = await launchFixture();
        if (kind === 'pipe') (f.child as unknown as { stdout: null }).stdout = null;
        const pending = f.controller.run();
        if (kind === 'error') {
            await f.phase('spawn-event');
            f.child.emit('error', Error('private-spawn-canary'));
        }
        const result = await pending;
        assert.equal(result.verdict, 'RETAINED_UNKNOWN');
        assert.equal(result.childOwned, true);
        assert.equal(result.reservation, 'held');
        assert.equal(f.server.closed, 1);
        assert.doesNotMatch(JSON.stringify(result), /private-spawn-canary/);
        if (kind === 'pipe')
            assert.doesNotThrow(() => f.child.stderr.emit('error', Error('late-owned-pipe')));
    }
});
type MenuStop =
    | 'pending'
    | 'stage-written'
    | 'staged'
    | 'previous-moved'
    | 'retained'
    | 'candidate-moved'
    | 'applied';
async function interruptedNativeMenu(f: ReturnType<typeof menuFixture>, stop: MenuStop) {
    await preparedNativeResume(f, 'activated-move');
    const b = f.backend(),
        held = await acquire(f, b);
    assert.ok(held);
    let view = await b.effects.observe(b.scope);
    view = await b.effects.journal(b.scope, view, { ...view.journal!, phase: 'candidate-active' });
    const phase = async (next: 'staged' | 'retained' | 'applied') => {
        view = await b.effects.journal(b.scope, view, {
            ...view.journal!,
            menu: { ...view.journal!.menu!, phase: next },
        });
    };
    const action = view.journal!.menu!.action;
    prefix: {
        if (stop === 'pending') break prefix;
        if (action === 'create' || action === 'replace') {
            view = await b.effects.menuStage!(b.scope, view, f.desired.record, f.desired.text);
            if (stop === 'stage-written') break prefix;
            await phase('staged');
            if (stop === 'staged') break prefix;
        }
        if (action === 'replace' || action === 'deselect') {
            view = await b.effects.menuMove!(b.scope, view, 'current', 'previous');
            if (stop === 'previous-moved') break prefix;
            await phase('retained');
            if (stop === 'retained') break prefix;
        }
        if (action === 'create' || action === 'replace') {
            view = await b.effects.menuMove!(b.scope, view, 'candidate', 'current');
            if (stop === 'candidate-moved') break prefix;
        }
        assert.equal(stop, 'applied');
        await phase('applied');
    }
    // Every effect above returned a complete acknowledgement. This only models a quiescent old
    // lifetime; it does not release any failed real owner, child or held historical session.
    assert.equal(await b.kernel.release(held.handle, held.identity), true);
    f.plan.review = clone(view);
    f.plan.reviewSHA256 = linuxModelReviewSHA256(view);
    return {
        before: clone(view),
        paths: {
            candidate:
                b.scope.stage.slice(0, b.scope.stage.lastIndexOf('/')) + '/menu-candidate.desktop',
            previous:
                b.scope.previous.slice(0, b.scope.previous.lastIndexOf('/')) +
                '/menu-previous.desktop',
        },
    };
}
async function completeNativeMenu(f: ReturnType<typeof menuFixture>, before: LinuxModelView) {
    const driver = createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
        result = await driver.run();
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(result.reservation, 'released');
    assert.equal(result.nativeQualified, false);
    assert.equal(result.productionDispatch, false);
    const observer = f.backend(),
        view = await observer.effects.observe(observer.scope);
    assert.deepEqual(view.root, before.root);
    assert.deepEqual(view.previous, before.previous);
    assert.equal(view.stage, null);
    assert.deepEqual(view.journal!.owner, before.journal!.owner);
    assert.equal(view.journal!.menu!.phase, 'applied');
    assert.equal(view.menu!.candidate, null);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.equal(f.fds.size, 0);
    assert.equal(f.server.closed, 3);
    const index = f.calls.length;
    await assert.rejects(driver.run(), /consumed/);
    assert.equal(f.calls.length, index);
    return view;
}
test('explicit menu resume creates the exact file across every complete write and no-replace boundary', async () => {
    for (const stop of [
        'pending',
        'stage-written',
        'staged',
        'candidate-moved',
        'applied',
    ] as const) {
        const f = menuFixture(),
            { before } = await interruptedNativeMenu(f, stop),
            view = await completeNativeMenu(f, before);
        assert.equal(f.node(f.desired.record.path).bytes.toString(), f.desired.text);
        assert.equal(view.menu!.previous, null);
        if (before.menu!.candidate)
            assert.equal(view.menu!.current!.identity.ino, before.menu!.candidate.identity.ino);
    }
});
test('explicit menu resume replaces only verified preimages and retains the original inode across every boundary', async () => {
    for (const stop of [
        'pending',
        'stage-written',
        'staged',
        'previous-moved',
        'retained',
        'candidate-moved',
        'applied',
    ] as const) {
        const f = menuFixture(true, true),
            { before, paths } = await interruptedNativeMenu(f, stop),
            expectedPrevious = before.journal!.menu!.beforeFile!,
            view = await completeNativeMenu(f, before);
        assert.deepEqual(view.menu!.previous, expectedPrevious);
        assert.equal(f.node(paths.previous).bytes.toString(), f.oldText);
        assert.equal(f.node(f.desired.record.path).bytes.toString(), f.desired.text);
    }
});
test('menu resume handles deselection and absent integration without deleting retained files or profile', async () => {
    for (const stop of ['pending', 'previous-moved', 'retained', 'applied'] as const) {
        const f = menuFixture(false, true),
            { before, paths } = await interruptedNativeMenu(f, stop),
            view = await completeNativeMenu(f, before);
        assert.equal(f.nodes.has(f.desired.record.path), false);
        assert.deepEqual(view.menu!.previous, before.journal!.menu!.beforeFile);
        assert.equal(f.node(paths.previous).bytes.toString(), f.oldText);
    }
    for (const stop of ['pending', 'applied'] as const) {
        const f = menuFixture(false, false),
            { before } = await interruptedNativeMenu(f, stop),
            view = await completeNativeMenu(f, before);
        assert.equal(view.menu!.current, null);
        assert.equal(view.menu!.previous, null);
    }
});
test('recovered menu still permits the original explicit rollback with exact app and menu restoration', async () => {
    const f = menuFixture(true, true),
        { before } = await interruptedNativeMenu(f, 'previous-moved'),
        view = await completeNativeMenu(f, before);
    f.plan.action = 'rollback';
    f.plan.review = clone(view);
    f.plan.reviewSHA256 = linuxModelReviewSHA256(view);
    const result = await createLinuxNativeDriver(
        f.plan,
        { startedMs: 0, deadlineMs: 120000 },
        f.ops,
    ).run();
    assert.equal(result.verdict, 'ROLLED_BACK_RETAINED');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.oldText);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.equal(f.fds.size, 0);
});
test('fresh review of a partial or foreign menu file never grants forward recovery', async () => {
    for (const change of ['partial-candidate', 'edited-current', 'changed-prior-menu'] as const) {
        const f = menuFixture(true, true),
            { paths } = await interruptedNativeMenu(f, 'stage-written');
        if (change === 'partial-candidate') f.node(paths.candidate).bytes = Buffer.from('partial');
        if (change === 'edited-current')
            f.node(f.desired.record.path).bytes = Buffer.from('custom-user-content');
        const observer = f.backend(),
            view = await observer.effects.observe(observer.scope);
        if (change === 'changed-prior-menu') view.previous!.menu!.sha256 = 'e'.repeat(64);
        f.plan.review = view;
        f.plan.reviewSHA256 = linuxModelReviewSHA256(view);
        const index = f.calls.length,
            snapshots = [...f.nodes.values()].map((n) => ({
                ...n,
                bytes: n.bytes.toString('hex'),
            }));
        assert.throws(
            () => createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
            /DRIVER_PLAN/,
        );
        assert.equal(f.calls.length, index);
        assert.deepEqual(
            [...f.nodes.values()].map((n) => ({ ...n, bytes: n.bytes.toString('hex') })),
            snapshots,
        );
    }
});
test('menu resume refuses skipped journal transitions, foreign app and rollback phases before reservation', async () => {
    for (const change of [
        'pending-after-both-moves',
        'retained-create',
        'staged-deselect',
        'foreign-app',
        'rollback-phase',
    ] as const) {
        const f = menuFixture(change !== 'staged-deselect', change !== 'retained-create'),
            stop =
                change === 'pending-after-both-moves' || change === 'retained-create'
                    ? 'candidate-moved'
                    : 'previous-moved';
        await interruptedNativeMenu(
            f,
            change === 'foreign-app' || change === 'rollback-phase' ? 'staged' : stop,
        );
        const menu = f.plan.review.journal!.menu!;
        if (change === 'pending-after-both-moves') menu.phase = 'pending';
        if (change === 'retained-create') menu.phase = 'retained';
        if (change === 'staged-deselect') menu.phase = 'staged';
        if (change === 'foreign-app')
            f.plan.review.root!.transactionId = '55555555-5555-4555-8555-555555555555';
        if (change === 'rollback-phase') menu.phase = 'rollback-pending';
        f.plan.reviewSHA256 = linuxModelReviewSHA256(f.plan.review);
        const index = f.calls.length;
        assert.throws(
            () => createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
            /DRIVER_PLAN/,
        );
        assert.equal(f.calls.length, index);
    }
});
test('menu changed during reservation admission is retained without any recovery write', async () => {
    const f = menuFixture(true, true);
    await interruptedNativeMenu(f, 'staged');
    f.ops.server = () => {
        f.node(f.desired.record.path).bytes = Buffer.from('foreign-after-review');
        return f.server as unknown as Server;
    };
    const index = f.calls.length,
        result = await createLinuxNativeDriver(
            f.plan,
            { startedMs: 0, deadlineMs: 120000 },
            f.ops,
        ).run();
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(result.reservation, 'held');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), 'foreign-after-review');
    assert.equal(f.server.closed, 2);
    assert.equal(
        f.calls.slice(index).some((n) => n === 'write' || n === 'move-noreplace'),
        false,
    );
});
test('menu recovery preserves a destination-race winner and the retained preimage without retries', async () => {
    const f = menuFixture(true, true),
        { before, paths } = await interruptedNativeMenu(f, 'retained'),
        originalMove = f.ops.moveNoReplace!;
    f.ops.moveNoReplace = (a, b, c, d) => {
        assert.equal(b, 'menu-candidate.desktop');
        f.file(f.desired.record.path, 'foreign-race-winner', 0o644);
        originalMove(a, b, c, d);
    };
    const driver = createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
        result = await driver.run();
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(result.pending, 'menu-move');
    assert.equal(result.reservation, 'held');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), 'foreign-race-winner');
    assert.equal(f.node(paths.previous).ino, before.journal!.menu!.beforeFile!.identity.ino);
    assert.equal(f.node(paths.candidate).bytes.toString(), f.desired.text);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.ok(driver.diagnostics().retainedFDs > 0);
    assert.equal(f.server.closed, 2);
    const count = f.calls.length;
    await assert.rejects(driver.run(), /consumed/);
    assert.equal(f.calls.length, count);
});
test('uncertain recovery journal write keeps menu candidate, original file and reservation custody', async () => {
    const f = menuFixture(true, true),
        { paths } = await interruptedNativeMenu(f, 'stage-written');
    f.setHook((name) => {
        if (name === 'write') throw Error('controlled menu journal failure');
    });
    const driver = createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
        result = await driver.run();
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(result.pending, 'journal');
    assert.equal(result.reservation, 'held');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.oldText);
    assert.equal(f.node(paths.candidate).bytes.toString(), f.desired.text);
    assert.equal(f.nodes.has(paths.previous), false);
    assert.equal(f.server.closed, 2);
    assert.ok(driver.diagnostics().retainedFDs > 0);
    const count = f.calls.length;
    await assert.rejects(driver.run(), /consumed/);
    assert.equal(f.calls.length, count);
});
test('menu recovery refuses an unavailable root reservation without retiring another owner', async () => {
    const f = menuFixture(true, true);
    await interruptedNativeMenu(f, 'stage-written');
    f.server.unavailable = true;
    const before = [...f.nodes.values()].map((n) => ({ ...n, bytes: n.bytes.toString('hex') }));
    const result = await createLinuxNativeDriver(
        f.plan,
        { startedMs: 0, deadlineMs: 120000 },
        f.ops,
    ).run();
    assert.equal(result.verdict, 'REFUSED');
    assert.equal(result.reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(f.server.closed, 2);
    assert.deepEqual(
        [...f.nodes.values()].map((n) => ({ ...n, bytes: n.bytes.toString('hex') })),
        before,
    );
});
test('native driver captures plan and host functions before caller mutation', async () => {
    const f = fixture(),
        originalRoot = f.plan.root;
    const driver = createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops);
    f.plan.root = '/home/test/foreign';
    f.plan.review.source.manifest.version = '9.9.9';
    f.ops.moveNoReplace = () => {
        throw Error('mutated alias must not run');
    };
    f.ops.fs.openSync = (() => {
        throw Error('mutated fs alias must not run');
    }) as typeof f.ops.fs.openSync;
    const result = await driver.run();
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(f.node(originalRoot + '/app/diagnostic-hub').bytes.toString(), 'fixture');
    assert.equal(f.nodes.has('/home/test/foreign'), false);
});
test('native driver retains partial write custody and never retries or releases after uncertainty', async () => {
    const f = fixture();
    f.setHook((name) => {
        if (name === 'write') throw Error('private-write-canary');
    });
    const driver = createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
        result = await driver.run();
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(result.pending, 'journal');
    assert.equal(result.nativeQualified, false);
    assert.equal(f.server.closed, 0);
    assert.ok(driver.diagnostics().retainedFDs > 0);
    assert.equal(f.calls.at(-1), 'write');
    const count = f.calls.length;
    await assert.rejects(driver.run(), /consumed/);
    assert.equal(f.calls.length, count);
});
test('native driver preserves a destination created during the no-replace race', async () => {
    const f = fixture(),
        move = f.ops.moveNoReplace!;
    let inserted = 0;
    f.ops.moveNoReplace = (a, b, c, d) => {
        inserted = f.directory(f.plan.root).ino;
        move(a, b, c, d);
    };
    const result = await createLinuxNativeDriver(
        f.plan,
        { startedMs: 0, deadlineMs: 120000 },
        f.ops,
    ).run();
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(f.node(f.plan.root).ino, inserted);
    assert.equal(f.nodes.has(f.plan.root + '/app/diagnostic-hub'), false);
    assert.equal(f.server.closed, 0);
    assert.equal(f.calls.at(-1), 'move-noreplace');
});
test('native driver deadline cannot be reset by replacing the caller clock function', async () => {
    const f = fixture(),
        driver = createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops);
    f.advance(120000);
    f.ops.now = () => 0;
    const result = await driver.run();
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.deepEqual(f.calls, []);
    assert.equal(f.server.listenCalls, 0);
});
test('native driver refuses unavailable primitive and accessor host before any facade action', () => {
    const missing = fixture(false);
    assert.throws(
        () =>
            createLinuxNativeDriver(
                missing.plan,
                { startedMs: 0, deadlineMs: 120000 },
                missing.ops,
            ),
        /LOADER_UNADMITTED/,
    );
    assert.deepEqual(missing.calls, []);
    const f = fixture();
    let reads = 0;
    Object.defineProperty(f.ops, 'server', {
        get() {
            reads++;
            throw Error('private');
        },
    });
    assert.throws(
        () => createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops),
        /DRIVER_HOST/,
    );
    assert.equal(reads, 0);
    assert.deepEqual(f.calls, []);
});
test('native driver refuses substituted runtime and oversized window before effects', () => {
    const f = fixture();
    assert.throws(
        () =>
            createLinuxNativeDriver(
                f.plan,
                { startedMs: 0, deadlineMs: 120000 },
                { ...f.ops, pid: 999 },
            ),
        /DRIVER_RUNTIME/,
    );
    assert.throws(
        () => createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120001 }, f.ops),
        /NATIVE_WINDOW/,
    );
    assert.deepEqual(f.calls, []);
    assert.equal(f.server.listenCalls, 0);
});
test('MN1 concrete menu facade creates only declared exact bytes after journal and keeps profile', async () => {
    const f = menuFixture(),
        b = f.backend();
    const result = await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan);
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(result.reservation, 'released');
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.desired.text);
    const owner = JSON.parse(f.node(f.plan.root + '/' + SETUP_OWNER).bytes.toString());
    assert.deepEqual(owner.integrations, [f.desired.record]);
    assert.equal(owner.options.startMenu, true);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.equal(b.capabilities.productionDispatch, false);
    assert.equal(b.capabilities.nativeQualified, false);
    assert.equal(
        f.calls.some((x) => /unlink|delete|signal|spawn/.test(x)),
        false,
    );
});
test('MN2 concrete replacement and explicit rollback retain both menu versions and exact profile', async () => {
    const f = menuFixture(true, true),
        b = f.backend();
    assert.equal(
        (await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan)).verdict,
        'ACTIVE_PREVIOUS_RETAINED',
    );
    const observed = await b.effects.observe(b.scope);
    f.plan.action = 'rollback';
    f.plan.review = clone(observed);
    f.plan.reviewSHA256 = linuxModelReviewSHA256(observed);
    const recovery = f.backend();
    assert.equal(
        (await new LinuxTransactionModel(recovery.kernel, menuDriver(recovery)).run(f.plan))
            .verdict,
        'ROLLED_BACK_RETAINED',
    );
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.oldText);
    const rootOwner = JSON.parse(f.node(f.plan.root + '/' + SETUP_OWNER).bytes.toString());
    assert.deepEqual(rootOwner.integrations, [f.oldRecord]);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.ok(
        [...f.nodes.values()].some(
            (node) =>
                node.path.endsWith('/menu-candidate.desktop') &&
                node.bytes.toString() === f.desired.text,
        ),
    );
});
test('MN3 concrete deselection retains the menu preimage and explicit rollback restores it', async () => {
    const f = menuFixture(false, true),
        b = f.backend();
    assert.equal(
        (await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan)).verdict,
        'ACTIVE_PREVIOUS_RETAINED',
    );
    assert.equal(f.nodes.has(f.desired.record.path), false);
    assert.ok(
        [...f.nodes.values()].some(
            (node) =>
                node.path.endsWith('/menu-previous.desktop') && node.bytes.toString() === f.oldText,
        ),
    );
    const observed = await b.effects.observe(b.scope);
    f.plan.action = 'rollback';
    f.plan.review = clone(observed);
    f.plan.reviewSHA256 = linuxModelReviewSHA256(observed);
    const recovery = f.backend();
    assert.equal(
        (await new LinuxTransactionModel(recovery.kernel, menuDriver(recovery)).run(f.plan))
            .verdict,
        'ROLLED_BACK_RETAINED',
    );
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.oldText);
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
});
test('MN4 concrete factory refuses same-byte foreign menu before any syscall facade operation', () => {
    const f = menuFixture();
    const file = f.file(f.desired.record.path, f.desired.text, 0o644);
    f.plan.review.menu!.current = {
        identity: { dev: 1, ino: file.ino, uid: 1000 },
        bytes: file.bytes.length,
        sha256: hash(file.bytes),
    };
    f.plan.reviewSHA256 = linuxModelReviewSHA256(f.plan.review);
    assert.throws(() => f.backend(), /FOREIGN_OR_EDITED/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.node(f.desired.record.path).bytes.toString(), f.desired.text);
});
test('MN5 concrete menu write uncertainty keeps journal ownership and stops without cleanup or release', async () => {
    const f = menuFixture(),
        original = f.ops.fs.writeSync;
    f.ops.fs.writeSync = ((fd: number, ...args: unknown[]) => {
        if (f.fds.get(fd)?.path.endsWith('/menu-candidate.desktop')) {
            f.calls.push('refused-menu-write');
            throw Error('private-menu-write-canary');
        }
        return (original as (...args: unknown[]) => number)(fd, ...args);
    }) as typeof original;
    const b = f.backend(),
        result = await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan);
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(f.calls.at(-1), 'refused-menu-write');
    assert.equal(f.server.closed, 0);
    assert.ok(b.diagnostics().retainedFDs > 0);
    assert.deepEqual(
        JSON.parse(f.node(f.plan.root + '/' + SETUP_OWNER).bytes.toString()).integrations,
        [f.desired.record],
    );
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    assert.doesNotMatch(JSON.stringify(result), /canary/);
});
test('MN6 missing no-replace binding refuses menu mutation before any filesystem facade call', async () => {
    const f = menuFixture(true, false, false),
        b = f.backend();
    await assert.rejects(
        b.effects.menuStage!(b.scope, f.plan.review, f.desired.record, f.desired.text),
        /ATOMIC_MOVE_UNAVAILABLE/,
    );
    assert.deepEqual(f.calls, []);
    assert.equal(b.diagnostics().retainedFDs, 0);
});

test('MN7 M1 owned0600 and0644 menu modes survive replacement deselection and exact rollback', async () => {
    for (const selected of [true, false])
        for (const mode of [0o600, 0o644]) {
            const f = menuFixture(selected, true),
                original = f.node(f.desired.record.path);
            original.mode = 0o100000 | mode;
            const originalInode = original.ino,
                b = f.backend();
            assert.equal(
                (await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan)).verdict,
                'ACTIVE_PREVIOUS_RETAINED',
            );
            const work = b.scope.stage.slice(0, b.scope.stage.lastIndexOf('/'));
            assert.equal(f.node(work + '/menu-previous.desktop').mode & 0o777, mode);
            assert.equal(f.node(work + '/menu-previous.desktop').ino, originalInode);
            const observed = await b.effects.observe(b.scope);
            f.plan.action = 'rollback';
            f.plan.review = clone(observed);
            f.plan.reviewSHA256 = linuxModelReviewSHA256(observed);
            const recovery = f.backend();
            assert.equal(
                (await new LinuxTransactionModel(recovery.kernel, menuDriver(recovery)).run(f.plan))
                    .verdict,
                'ROLLED_BACK_RETAINED',
            );
            const restored = f.node(f.desired.record.path);
            assert.equal(restored.mode & 0o777, mode);
            assert.equal(restored.ino, originalInode);
            assert.equal(restored.bytes.toString(), f.oldText);
            assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
        }
});
test('MN8 M1 foreign UID link and shared-write menu preimages refuse before namespace mutation', async () => {
    for (const problem of ['foreign-uid', 'link', 'shared-write'] as const) {
        const f = menuFixture(true, true),
            menu = f.node(f.desired.record.path);
        if (problem === 'foreign-uid') menu.uid = 2000;
        if (problem === 'link') {
            menu.kind = 'link';
            menu.target = '/unrelated-private-canary';
        }
        if (problem === 'shared-write') menu.mode = 0o100666;
        const b = f.backend();
        const result = await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan);
        assert.equal(result.verdict, 'RETAINED_UNKNOWN');
        assert.equal(
            f.calls.some((name) => /^(write|truncate|mkdir|move-noreplace)$/.test(name)),
            false,
        );
        assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
    }
});
test('MN9 M1 journal metadata remains private even though retained desktop files admit0644', async () => {
    const f = menuFixture(),
        b = f.backend();
    assert.equal(
        (await new LinuxTransactionModel(b.kernel, menuDriver(b)).run(f.plan)).verdict,
        'ACTIVE_PREVIOUS_RETAINED',
    );
    const work = b.scope.stage.slice(0, b.scope.stage.lastIndexOf('/'));
    const journalPath = work + '/journal.json',
        journal = f.node(journalPath);
    const original = {
        ino: journal.ino,
        uid: journal.uid,
        nlink: journal.nlink,
        kind: journal.kind,
        mtime: journal.mtime,
        bytes: Buffer.from(journal.bytes),
    };
    assert.equal(journal.mode, 0o100600);
    assert.equal(journal.kind, 'file');
    assert.equal(journal.uid, 1000);
    assert.equal(journal.nlink, 1);
    assert.ok(journal.ino > 0 && journal.bytes.length > 0 && journal.bytes.length <= 8192);
    assert.doesNotThrow(() => JSON.parse(journal.bytes.toString('utf8')));
    journal.mode = 0o100644; // Change ONLY the private-file mode counterexample, not JSON content/identity.
    assert.equal(journal.mode & 0o7022, 0);
    assert.notEqual(journal.mode & 0o077, 0);
    let targetLstats = 0,
        targetOpens = 0,
        lastWasTargetLstat = false;
    const isJournal = (file?: string) => {
        if (file === undefined) return false;
        const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(file);
        const resolved = match
            ? (f.fds.get(Number(match[1]))?.path ?? '') + (match[2] ?? '')
            : file;
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
    await assert.rejects(
        b.effects.observe(b.scope),
        (error: unknown) => error instanceof Error && error.message === 'NATIVE_METADATA',
    );
    assert.ok(targetLstats > 0);
    assert.equal(targetOpens, 0);
    assert.equal(f.calls.at(-1), 'lstat');
    assert.equal(lastWasTargetLstat, true);
    // No IO after this exact target's pre-open regular/private check.
    assert.equal(b.diagnostics().failed, true);
    assert.equal(b.diagnostics().code, 'NATIVE_METADATA');
    assert.equal(
        f.calls.slice(count).some((name) => /^(write|truncate|mkdir|move-noreplace)$/.test(name)),
        false,
    );
    assert.equal(journal.mode, 0o100644);
    assert.deepEqual(
        {
            ino: journal.ino,
            uid: journal.uid,
            nlink: journal.nlink,
            kind: journal.kind,
            mtime: journal.mtime,
            bytes: journal.bytes,
        },
        original,
    );
    assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
});
