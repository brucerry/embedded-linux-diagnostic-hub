import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startOwnedGitRead, validateOwnedGitRequest } from '../scripts/lib/owned-git-read.mjs';
import { createOwnedWebFiles } from '../scripts/lib/owned-web-files.mjs';
import {
    createOwnedWebCapabilities,
    requireOwnedWebCapabilities,
    webChildEnvironments,
} from '../scripts/lib/owned-web-capabilities.mjs';
import {
    localSourceProvider,
    readStableSourceFile,
} from '../scripts/lib/committed-source-provider.mjs';
import { gitObjectID } from '../scripts/lib/committed-source-bridge.mjs';
import { memoryFilesystem } from './fixtures/gateway-producer-memory';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pulse = async () => {
    for (let i = 0; i < 32; i++) await Promise.resolve();
};
const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) await Promise.resolve();
    assert.ok(check(), 'Expected acknowledged fake operation');
};
const deferred = () => {
    let resolve!: (v?: any) => void, reject!: (v: any) => void;
    const promise = new Promise<any>((a, b) => {
        resolve = a;
        reject = b;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
const prefix = [
    '--no-replace-objects',
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.hooksPath=/dev/null',
];
const environment = { PATH: '/tools:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
function gitFixture(input?: string) {
    const child: any = new EventEmitter();
    child.pid = 1234;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = input === undefined ? null : new EventEmitter();
    const controls: any = {},
        events: string[] = [];
    let timer: Function = () => {},
        now = 0,
        launches = 0,
        callback: Function = () => {};
    if (child.stdin)
        child.stdin.end = (bytes: Buffer, cb: Function) => {
            assert.equal(bytes.toString(), input);
            callback = cb;
            if (!controls.holdInput) {
                child.stdin.emit('finish');
                cb(null);
                child.stdin.emit('close');
            }
            return child.stdin;
        };
    const ports = {
        launch(executable: string, args: string[], options: any) {
            launches++;
            events.push('launch');
            assert.equal(options.shell, false);
            assert.deepEqual(options.stdio, [
                input === undefined ? 'ignore' : 'pipe',
                'pipe',
                'pipe',
            ]);
            return child;
        },
        setTimer(fn: Function, ms: number) {
            assert.equal(ms, 30000);
            timer = fn;
            return 1;
        },
        clearTimer() {
            events.push('clearTimer');
        },
        now: () => now,
    };
    const plan = {
        executable: '/tools/git',
        args: [
            ...prefix,
            ...(input === undefined ? ['rev-parse', '--show-toplevel'] : ['cat-file', '--batch']),
        ],
        cwd: '/project',
        env: environment,
        input,
        maximum: 1024,
    };
    const close = (code = 0, signal: any = null) => {
        child.stdout.emit('close');
        child.stderr.emit('close');
        child.emit('exit', code, signal);
        child.emit('close', code, signal);
    };
    return {
        child,
        controls,
        ports,
        plan,
        events,
        close,
        spawn: () => child.emit('spawn'),
        expire: () => {
            now = 30001;
            timer();
        },
        inputAck: (error?: Error) => {
            callback(error ?? null);
        },
        get launches() {
            return launches;
        },
    };
}
test('Git normal success requires actual child and both output closures', async () => {
    const f = gitFixture(),
        o = startOwnedGitRead(f.plan, f.ports);
    f.spawn();
    f.child.stdout.emit('data', Buffer.from('/project\n'));
    f.close();
    const result = await o.result;
    await o.closed;
    assert.equal(result.stdout.toString(), '/project\n');
    assert.equal(result.directRetirement, true);
    assert.equal(result.processGroupRetirement, null);
    assert.equal(o.snapshot().listeners, 0);
});
test('Git batch input callback and input close are separate held acknowledgements', async () => {
    const f = gitFixture('a'.repeat(40) + '\n');
    f.controls.holdInput = true;
    const o = startOwnedGitRead(f.plan, f.ports);
    f.spawn();
    f.child.stdin.emit('finish');
    f.child.stdin.emit('close');
    f.close();
    await pulse();
    assert.equal(o.snapshot().directRetired, false);
    assert.equal(o.snapshot().inputAck, false);
    f.inputAck();
    await o.result;
    await o.closed;
    assert.equal(o.snapshot().directRetired, true);
});
test('failed Git input can retire known closed pipes while preserving original error', async () => {
    const f = gitFixture('a'.repeat(40) + '\n');
    f.controls.holdInput = true;
    const o = startOwnedGitRead(f.plan, f.ports),
        error = Error('authored write failure');
    f.spawn();
    f.inputAck(error);
    f.child.stdin.emit('close');
    f.close();
    await assert.rejects(o.result, (e: any) => e.cause === error);
    await o.closed;
    assert.equal(o.snapshot().directRetired, true);
});
for (const kind of ['deadline', 'overflow', 'signal', 'no-spawn', 'pipe-error'])
    test('Git ' + kind + ' failure cannot become success', async () => {
        const f = gitFixture(),
            o = startOwnedGitRead({ ...f.plan, maximum: 4 }, f.ports);
        if (kind !== 'no-spawn') f.spawn();
        if (kind === 'deadline') f.expire();
        if (kind === 'overflow') f.child.stdout.emit('data', Buffer.alloc(5));
        if (kind === 'pipe-error') f.child.stderr.emit('error', Error('authored pipe error'));
        f.close(0, kind === 'signal' ? 'SIGTERM' : null);
        await assert.rejects(o.result);
        await o.closed;
        assert.equal(o.snapshot().directRetired, true);
        assert.equal(o.snapshot().primaryFailure, true);
    });
test('Git timeout retains active child; later closure does not clear failed outcome', async () => {
    const f = gitFixture(),
        o = startOwnedGitRead(f.plan, f.ports);
    f.spawn();
    f.expire();
    await assert.rejects(o.result);
    assert.ok(o.snapshot().listeners > 0);
    assert.equal(o.snapshot().directRetired, false);
    f.close();
    await o.closed;
    assert.equal(o.snapshot().directRetired, true);
    await assert.rejects(o.result);
});
for (const args of [
    ['status'],
    ['config', '--global', 'x', 'y'],
    ['cat-file', '--filters', 'HEAD:file'],
])
    test('unadmitted Git argv ' + args[0] + ' refuses dispatch', () => {
        const f = gitFixture();
        assert.throws(() => startOwnedGitRead({ ...f.plan, args: [...prefix, ...args] }, f.ports));
        assert.equal(f.launches, 0);
    });
test('Git callback dispatch/cleanup unsupported returns cannot retire uncertainty', async () => {
    const f = gitFixture(),
        error = Error('authored unsupported return');
    (f.child as any).on = () => Promise.reject(error);
    const o = startOwnedGitRead(f.plan, f.ports);
    await assert.rejects(o.result);
    await pulse();
    assert.ok(o.snapshot().unknownOperations > 0);
    assert.equal(o.snapshot().directRetired, false);
    assert.ok(o.diagnostics().includes(error));
});
function filesFixture() {
    const f = memoryFilesystem(),
        controls: any = {},
        directories = new Set<any>(),
        events: string[] = [];
    f.write('/project/file', Buffer.from('abc'));
    f.write('/tools/git', Buffer.from('authored Git executable bytes, never run'));
    const native: any = {
        ...f.fs,
        async open(p: string, flags: number) {
            assert.ok(flags & constants.O_NOFOLLOW);
            if (controls.openHold) await controls.openHold.promise;
            if (controls.openError) throw controls.openError;
            if (flags & constants.O_DIRECTORY) {
                const h: any = {
                    async stat() {
                        return f.fs.lstat(p);
                    },
                    async sync() {
                        events.push('directory.sync');
                        if (controls.dirSyncError) throw controls.dirSyncError;
                    },
                    async close() {
                        events.push('directory.close');
                        if (controls.dirCloseError) throw controls.dirCloseError;
                        directories.delete(h);
                    },
                };
                directories.add(h);
                return h;
            }
            const h = await f.fs.open(p, flags & constants.O_EXCL ? 'wx' : 'r');
            return {
                ...h,
                async read(...a: [Buffer, number, number]) {
                    if (controls.readError) throw controls.readError;
                    return h.read(...a);
                },
                async write(buffer: Buffer, offset: number, length: number, position: number) {
                    if (controls.writeError) throw controls.writeError;
                    const n = controls.partial ? Math.min(length, controls.partial) : length;
                    const old = f.bytes(p),
                        next = Buffer.alloc(Math.max(old.length, position + n));
                    old.copy(next);
                    buffer.copy(next, position, offset, offset + n);
                    f.write(p, next);
                    return { bytesWritten: n };
                },
                async sync() {
                    events.push('file.sync');
                    if (controls.syncError) throw controls.syncError;
                },
                async close() {
                    events.push('file.close');
                    if (controls.closeHold) await controls.closeHold.promise;
                    if (controls.closeError) throw controls.closeError;
                    await h.close();
                },
            };
        },
        async opendir(p: string) {
            const rows = await f.fs.readdir(p);
            let at = 0;
            const h = {
                async read() {
                    if (controls.dirReadError) throw controls.dirReadError;
                    return rows[at++] ?? null;
                },
                async close() {
                    if (controls.dirCloseError) throw controls.dirCloseError;
                    directories.delete(h);
                },
            };
            directories.add(h);
            return h;
        },
    };
    return { ...f, controls, native, directories, events };
}
test('file read/close custody covers the actual stable reader and directory handles', async () => {
    const f = filesFixture(),
        { owner, filesystem } = createOwnedWebFiles(f.native);
    assert.equal(
        (await readStableSourceFile('/project', 'file', 100, filesystem)).bytes.toString(),
        'abc',
    );
    const rows = await filesystem.readdir('/project', { withFileTypes: true });
    assert.deepEqual(rows.map((r) => r.name).sort(), ['file', 'validation']);
    owner.assertSettled();
    assert.equal(f.handles.size, 0);
    assert.equal(f.directories.size, 0);
});
test('pending open is registered before acquisition and acknowledged close', async () => {
    const f = filesFixture();
    f.controls.openHold = deferred();
    const { owner, filesystem } = createOwnedWebFiles(f.native),
        opening = filesystem.open('/project/file', 'r');
    await pulse();
    assert.equal(owner.snapshot().handles, 1);
    assert.equal(owner.snapshot().pending, 1);
    f.controls.openHold.resolve();
    const h = await opening;
    await h.close();
    owner.assertSettled();
});
test('unknown rejected open remains owned', async () => {
    const f = filesFixture();
    f.controls.openError = Error('unknown acquired descriptor');
    const { owner, filesystem } = createOwnedWebFiles(f.native);
    await assert.rejects(filesystem.open('/project/file', 'r'));
    assert.equal(owner.snapshot().handles, 1);
    assert.throws(() => owner.assertSettled());
});
test('primary read error and separate close error remain visible without masking', async () => {
    const f = filesFixture(),
        first = Error('authored read error'),
        second = Error('authored close error');
    f.controls.readError = first;
    f.controls.closeError = second;
    const { owner, filesystem } = createOwnedWebFiles(f.native);
    await assert.rejects(
        readStableSourceFile('/project', 'file', 100, filesystem),
        (e: any) => e.cause?.cause === first || e.cause === first,
    );
    assert.ok(owner.diagnostics().includes(second));
    assert.equal(owner.snapshot().handles, 1);
    assert.throws(() => owner.assertSettled());
});
test('directory read rejection and rejected close retain the directory lease and both errors', async () => {
    const f = filesFixture(),
        first = Error('authored directory read error'),
        second = Error('authored directory close error');
    f.controls.dirReadError = first;
    f.controls.dirCloseError = second;
    const { owner, filesystem } = createOwnedWebFiles(f.native);
    await assert.rejects(
        filesystem.readdir('/project', { withFileTypes: true }),
        (e: any) => e.cause?.cause === first,
    );
    assert.equal(owner.snapshot().handles, 1);
    assert.ok(owner.diagnostics().includes(second));
});
test('exclusive partial writes join file sync/close then parent sync/close', async () => {
    const f = filesFixture();
    f.controls.partial = 1;
    const { owner, filesystem } = createOwnedWebFiles(f.native);
    await filesystem.writeFile('/project/new', Buffer.from('hello'), { flag: 'wx' });
    assert.equal(f.bytes('/project/new').toString(), 'hello');
    assert.deepEqual(f.events, ['file.sync', 'file.close', 'directory.sync', 'directory.close']);
    owner.assertSettled();
    assert.equal(owner.snapshot().acknowledgedPublications, 1);
});
test('existing destination is untouched on collision and namespace uncertainty is not retired', async () => {
    const f = filesFixture(),
        { owner, filesystem } = createOwnedWebFiles(f.native);
    await assert.rejects(
        filesystem.writeFile('/project/file', Buffer.from('replacement'), { flag: 'wx' }),
    );
    assert.equal(f.bytes('/project/file').toString(), 'abc');
    assert.equal(owner.snapshot().uncertainPublications, 1);
    assert.throws(() => owner.assertSettled());
});
for (const kind of ['write', 'mkdir'])
    test('static symlinked parent blocks ' + kind + ' before any mutation', async () => {
        const f = filesFixture();
        let opens = 0,
            creates = 0;
        const open = f.native.open;
        f.native.open = async (...a: any[]) => {
            opens++;
            return open(...a);
        };
        f.native.mkdir = async () => {
            creates++;
        };
        const realpath = f.native.realpath;
        f.native.realpath = async (p: string) => (p === '/project' ? '/outside' : realpath(p));
        const { filesystem } = createOwnedWebFiles(f.native);
        if (kind === 'write')
            await assert.rejects(
                filesystem.writeFile('/project/new', Buffer.from('content'), { flag: 'wx' }),
            );
        else await assert.rejects(filesystem.mkdir('/project/new'));
        assert.equal(opens, 0);
        assert.equal(creates, 0);
        assert.equal(f.records.has('/project/new'), false);
    });
for (const kind of ['write', 'sync', 'close', 'dirSync', 'dirClose'])
    test('publication ' + kind + ' rejection retains honest custody without deletion', async () => {
        const f = filesFixture();
        f.controls[kind + 'Error'] = Error('authored ' + kind + ' failure');
        const { owner, filesystem } = createOwnedWebFiles(f.native);
        await assert.rejects(
            filesystem.writeFile('/project/new', Buffer.from('content'), { flag: 'wx' }),
        );
        assert.equal(owner.snapshot().uncertainPublications, 1);
        assert.throws(() => owner.assertSettled());
        assert.ok(f.records.has('/project/new'));
        assert.equal(owner.snapshot().processGroupRetirement, null);
    });
test('pending publication close cannot produce early acknowledgement', async () => {
    const f = filesFixture();
    f.controls.closeHold = deferred();
    const { owner, filesystem } = createOwnedWebFiles(f.native),
        write = filesystem.writeFile('/project/new', Buffer.from('content'), { flag: 'wx' });
    await pulse();
    assert.equal(owner.snapshot().acknowledgedPublications, 0);
    assert.ok(owner.snapshot().handles > 0);
    f.controls.closeHold.resolve();
    await write;
    owner.assertSettled();
});
for (const key of ['HOME', 'TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'VITE_FAKE'])
    test('child environment refuses ambient/extra ' + key, () => {
        assert.throws(() =>
            webChildEnvironments({ ...environment, [key]: 'authored unwanted input' }),
        );
    });
for (const PATH of ['relative', '/usr/bin::/bin', '/a/../bin'])
    test('child PATH profile refuses ' + PATH, () => {
        assert.throws(() => webChildEnvironments({ ...environment, PATH }));
    });
test('complete environment profile is copied, frozen and order-canonical without HOME redirection', () => {
    const value = { ...environment },
        p = webChildEnvironments(value);
    value.PATH = '/changed';
    assert.equal(p.build.PATH, environment.PATH);
    assert.equal(p.git.GIT_TERMINAL_PROMPT, '0');
    assert.equal('HOME' in p.build, false);
    assert.equal(Object.keys(p.build).length, 6);
    assert.equal(
        p.sha256,
        webChildEnvironments({
            TZ: 'UTC',
            PATH: environment.PATH,
            LC_ALL: 'C.UTF-8',
            LANG: 'C.UTF-8',
        }).sha256,
    );
});
test('actual async provider startup/state/body paths await executor and use matching fixed config argv', async () => {
    const bytes = Buffer.from('abc'),
        id = gitObjectID('blob', bytes),
        calls: any[] = [];
    const execute = async (binary: string, args: string[], options: any) => {
        calls.push({ binary, args, options });
        validateOwnedGitRequest(args, options.input);
        assert.equal(options.timeout, undefined);
        const tail = args.slice(prefix.length);
        if (tail[0] === 'config') return Buffer.alloc(0);
        if (tail[0] === 'rev-parse') {
            if (tail[1] === '--show-toplevel') return Buffer.from('/project\n');
            if (tail[1] === '--show-prefix') return Buffer.alloc(0);
            if (tail[1] === '--show-object-format') return Buffer.from('sha1\n');
            return Buffer.from((tail.at(-1) === 'HEAD' ? 'a' : 'b').repeat(40) + '\n');
        }
        if (tail[0] === 'ls-files') return Buffer.from('100644 ' + id + ' 0\tfile\0');
        if (tail[1] === '--batch-check') return Buffer.from(id + ' blob 3\n');
        return Buffer.from(id + ' blob 3\nabc\n');
    };
    const provider = await localSourceProvider('/project', {
        execute,
        asynchronous: true,
        environment: {},
        platform: 'linux',
        filesystem: { realpath: async (p: string) => p } as any,
    });
    const state = await provider.state();
    assert.equal(state.sourceCommit, 'a'.repeat(40));
    assert.equal(state.index[0].oid, id);
    assert.equal((await provider.objects([id]))[0].bytes.toString(), 'abc');
    assert.ok(calls.some((c) => c.args.includes('config')));
});
test('capability verifies Git bytes and blocks overlapping acquisition before awaited file reads', async () => {
    const f = filesFixture(),
        g = gitFixture(),
        selection = { environment, gitPath: '/tools/git', gitSHA256: hash(f.bytes('/tools/git')) };
    f.controls.openHold = deferred();
    const cap = createOwnedWebCapabilities(selection, { ...g.ports, filesystem: f.native });
    const request = cap.executeGit('git', g.plan.args, {
        cwd: '/project',
        env: cap.gitEnvironment,
        maxBuffer: 1024,
    });
    await pulse();
    await assert.rejects(
        cap.executeGit('git', g.plan.args, {
            cwd: '/project',
            env: cap.gitEnvironment,
            maxBuffer: 1024,
        }),
    );
    assert.equal(g.launches, 0);
    f.controls.openHold.resolve();
    await until(() => g.launches === 1);
    g.spawn();
    g.child.stdout.emit('data', Buffer.from('/project\n'));
    g.close();
    assert.equal((await request).toString(), '/project\n');
    cap.assertSettled();
    assert.equal(cap.snapshot().processGroupRetirement, null);
});
test('no serialized object grants the held native CLI capability or reads environment', async () => {
    assert.throws(() => requireOwnedWebCapabilities({ filesystem: {} }));
    const source = readFileSync(
            new URL('../scripts/produce-web-archive.mjs', import.meta.url),
            'utf8',
        ),
        start = source.indexOf('export async function main('),
        end = source.indexOf('\nif (process.argv[1]', start);
    assert.ok(start >= 0 && end > start);
    const declaration = source
        .slice(start, end)
        .replace('export async function', 'async function')
        .replaceAll(
            'import.meta.url',
            JSON.stringify(new URL('../scripts/produce-web-archive.mjs', import.meta.url).href),
        );
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    let touched = 0;
    const run = new AsyncFunction(
        'requireOwnedWebCapabilities',
        'process',
        declaration + ';return main([],{});',
    );
    await assert.rejects(
        run(
            requireOwnedWebCapabilities,
            new Proxy(
                {},
                {
                    get() {
                        touched++;
                        throw Error('No ambient access');
                    },
                },
            ),
        ),
    );
    assert.equal(touched, 0);
});
test('only the fixed config query can admit normal code-one empty output as missing', async () => {
    const f = filesFixture(),
        g = gitFixture(),
        selection = { environment, gitPath: '/tools/git', gitSHA256: hash(f.bytes('/tools/git')) },
        cap = createOwnedWebCapabilities(selection, { ...g.ports, filesystem: f.native });
    await assert.rejects(
        cap.executeGit('git', g.plan.args, {
            cwd: '/project',
            env: cap.gitEnvironment,
            maxBuffer: 1024,
            missing: true,
        }),
    );
    assert.equal(g.launches, 0);
    const config = [
        ...prefix,
        'config',
        '--includes',
        '--name-only',
        '--get-regexp',
        '^(extensions\\.partialclone|remote\\..*\\.promisor)$',
    ];
    const task = cap.executeGit('git', config, {
        cwd: '/project',
        env: cap.gitEnvironment,
        maxBuffer: 1024,
        missing: true,
    });
    await until(() => g.launches === 1);
    g.spawn();
    g.close(1);
    assert.equal((await task).length, 0);
    cap.assertSettled();
});
test('a normal code-one rev-parse is a failed experiment even after local closure', async () => {
    const f = filesFixture(),
        g = gitFixture(),
        cap = createOwnedWebCapabilities(
            { environment, gitPath: '/tools/git', gitSHA256: hash(f.bytes('/tools/git')) },
            { ...g.ports, filesystem: f.native },
        );
    const task = cap.executeGit('git', g.plan.args, {
        cwd: '/project',
        env: cap.gitEnvironment,
        maxBuffer: 1024,
        missing: false,
    });
    await until(() => g.launches === 1);
    g.spawn();
    g.close(1);
    await assert.rejects(task);
    assert.equal(cap.snapshot().gitOwners, 0);
    assert.equal(cap.snapshot().primaryFailure, true);
    assert.throws(() => cap.assertSettled());
});
test('pre-dispatch Git hash mismatch refuses any launch', async () => {
    const f = filesFixture(),
        g = gitFixture(),
        cap = createOwnedWebCapabilities(
            { environment, gitPath: '/tools/git', gitSHA256: 'f'.repeat(64) },
            { ...g.ports, filesystem: f.native },
        );
    await assert.rejects(
        cap.executeGit('git', g.plan.args, {
            cwd: '/project',
            env: cap.gitEnvironment,
            maxBuffer: 1024,
        }),
    );
    assert.equal(g.launches, 0);
    assert.equal(cap.snapshot().primaryFailure, true);
    assert.throws(() => cap.assertSettled());
});
test('Git bytes changed after direct close cannot yield stdout success', async () => {
    const f = filesFixture(),
        g = gitFixture(),
        cap = createOwnedWebCapabilities(
            { environment, gitPath: '/tools/git', gitSHA256: hash(f.bytes('/tools/git')) },
            { ...g.ports, filesystem: f.native },
        );
    const task = cap.executeGit('git', g.plan.args, {
        cwd: '/project',
        env: cap.gitEnvironment,
        maxBuffer: 1024,
    });
    await until(() => g.launches === 1);
    g.spawn();
    g.child.stdout.emit('data', Buffer.from('/project\n'));
    g.close();
    f.write('/tools/git', Buffer.from('changed after direct close'));
    await assert.rejects(task);
    assert.equal(cap.snapshot().gitOwners, 0);
    assert.equal(cap.snapshot().primaryFailure, true);
    assert.throws(() => cap.assertSettled());
});
