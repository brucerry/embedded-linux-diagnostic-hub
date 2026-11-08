import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
    invokeWindowsWindowQuery,
    type WindowQueryHost,
} from './fixtures/windows-installer-window-query-invoker';
import { WINDOWS_WINDOW_QUERY_SOURCE } from './fixtures/windows-installer-window-query';
import {
    prepareWindowQueryScratch,
    consumeWindowQueryScratch,
    type WindowQueryScratchHost,
} from './fixtures/windows-installer-window-query-scratch';

// Event doubles only: never start PowerShell, inspect a process/window or use native admission.
class Pipe extends EventEmitter {
    readableEnded = false;
    closed = false;
    destroyed = false;
    end() {
        this.readableEnded = true;
        this.emit('end');
    }
    close() {
        this.closed = true;
        this.emit('close');
    }
}
class Child extends EventEmitter {
    exitCode: number | null = null;
    signalCode: string | null = null;
    stdout = new Pipe();
    stderr = new Pipe();
    exit(code: number | null = 0, signal: string | null = null) {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit('exit', code, signal);
    }
    close(code: number | null = this.exitCode, signal: string | null = this.signalCode) {
        this.emit('close', code, signal);
    }
}
function scratchFixture() {
    const parent = 'C:\\owned-temp',
        directory = parent + '\\query-one';
    const directories = new Map([[parent, { realpath: parent, device: 1n, inode: 1n }]]);
    const calls: string[] = [];
    const host: WindowQueryScratchHost = {
        platform: 'win32',
        async inspectDirectory(name) {
            calls.push('inspect:' + name);
            const identity = directories.get(name);
            assert.ok(identity);
            return { ...identity };
        },
        async mkdir(name) {
            calls.push('mkdir:' + name);
            assert.equal(name, directory);
            assert.equal(directories.has(name), false);
            directories.set(name, { realpath: name, device: 1n, inode: 2n });
        },
        async openProbe(file) {
            calls.push('open:' + file);
            assert.equal(file, directory + '\\.window-query-write-probe');
            return {
                async writeFile(bytes) {
                    calls.push('write');
                    assert.equal(Buffer.from(bytes).toString(), 'window-query writable scratch\n');
                },
                async sync() {
                    calls.push('sync');
                },
                async close() {
                    calls.push('close');
                },
            };
        },
    };
    return { parent, directory, directories, calls, host };
}
async function fixture() {
    const child = new Child();
    const calls: Parameters<WindowQueryHost['spawn']>[] = [];
    const host: WindowQueryHost = {
        scope: 'controlled-memory',
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        spawn(...args) {
            calls.push(args);
            return child;
        },
    };
    const temp = scratchFixture();
    const scratch = await prepareWindowQueryScratch(temp.directory, temp.host);
    const start = () => invokeWindowsWindowQuery(234, scratch, host);
    const finish = () => {
        child.stdout.end();
        child.stderr.end();
        child.exit();
        child.stdout.close();
        child.stderr.close();
        child.close();
    };
    return { child, host, calls, start, finish, scratch };
}
const missing = Buffer.from('{"schemaVersion":1,"state":"missing","requestedPID":234}');

test('fixed read-only command admits one integer PID and no configurable script or security bypass', async () => {
    const f = await fixture();
    for (const pid of [0, -1, 1.5, NaN, Infinity, 2147483648, '234' as unknown as number])
        await assert.rejects(() => invokeWindowsWindowQuery(pid, f.scratch, f.host), /PID_INVALID/);
    for (const root of [
        undefined,
        '',
        'Windows',
        '\\\\host\\Windows',
        'C:\\Windows\\..',
        'C:/Windows',
        'C:\\Win%dir',
    ])
        await assert.rejects(
            () => invokeWindowsWindowQuery(234, f.scratch, { ...f.host, systemRoot: root }),
            /ROOT_INVALID/,
        );
    await assert.rejects(
        () => invokeWindowsWindowQuery(234, f.scratch, { ...f.host, platform: 'linux' }),
        /WINDOWS_REQUIRED/,
    );
    assert.equal(f.calls.length, 0);
    const attempt = await f.start();
    assert.equal(f.calls.length, 1);
    const [file, args, options] = f.calls[0];
    assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args.slice(0, -1), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
    ]);
    assert.equal(
        Buffer.from(args.at(-1)!, 'base64').toString('utf16le'),
        `& {\n${WINDOWS_WINDOW_QUERY_SOURCE}\n} -TargetProcessId 234`,
    );
    assert.deepEqual(options, {
        cwd: 'C:\\Windows',
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            SystemRoot: 'C:\\Windows',
            WINDIR: 'C:\\Windows',
            TEMP: f.scratch.directory,
            TMP: f.scratch.directory,
            USERPROFILE: f.scratch.directory,
        },
    });
    f.child.emit('spawn');
    f.child.stdout.emit('data', missing);
    f.finish();
    assert.equal((await attempt.decoded()).state, 'missing');
});

test('success waits for actual child and both pipe closes, independently of exit and EOF', async () => {
    const f = await fixture(),
        a = await f.start();
    let done = false;
    void a.completed.then(() => {
        done = true;
    });
    const unrelated = () => {};
    f.child.on('unrelated', unrelated);
    f.child.emit('spawn');
    f.child.stdout.emit('data', missing);
    f.child.exit();
    f.child.stdout.end();
    f.child.stderr.end();
    f.child.close();
    await Promise.resolve();
    assert.equal(done, false);
    f.child.stdout.close();
    await Promise.resolve();
    assert.equal(done, false);
    assert.equal(a.snapshot().capture.failure, 'pending');
    f.child.stderr.close();
    const raw = await a.completed;
    assert.equal(raw.failure, 'none');
    assert.equal(raw.stdoutEOF, true);
    assert.equal(raw.stderrEOF, true);
    assert.equal(a.custody.listenersDetached, true);
    assert.equal(f.child.listenerCount('unrelated'), 1);
    for (const source of [f.child, f.child.stdout, f.child.stderr])
        for (const event of ['error', 'spawn', 'exit', 'close', 'data', 'end'])
            assert.equal(source.listenerCount(event), 0);
});

test('bounded capture copies chunks, drains overflow and cannot decode a successful retained prefix', async () => {
    for (const side of ['stdout', 'stderr'] as const) {
        const f = await fixture(),
            a = await f.start();
        f.child.emit('spawn');
        const bytes = Buffer.from(missing);
        f.child.stdout.emit('data', bytes);
        bytes.fill(0);
        assert.deepEqual(a.snapshot().capture.stdout, missing);
        a.snapshot().capture.stdout.fill(0);
        assert.deepEqual(a.snapshot().capture.stdout, missing);
        const cap = side === 'stdout' ? 8192 : 4096;
        for (let i = 0; i < 3; i++) f.child[side].emit('data', Buffer.alloc(cap));
        assert.equal(a.snapshot()[(side + 'Overflow') as 'stdoutOverflow'], true);
        assert.equal(a.snapshot().capture[side].byteLength, cap);
        f.finish();
        assert.equal((await a.completed).failure, 'capture-error');
        assert.equal((await a.decoded()).state, 'query-unconfirmed');
        assert.equal(
            a.snapshot()[(side + 'Bytes') as 'stdoutBytes'],
            cap * 3 + (side === 'stdout' ? missing.length : 0),
        );
    }
});

test('spawn failure and close without EOF preserve actual outcomes and never manufacture success', async () => {
    const f = await fixture(),
        a = await f.start();
    f.child.emit('error', Error('controlled spawn failure'));
    f.child.stdout.close();
    f.child.stderr.close();
    f.child.close(null, null);
    const raw = await a.completed;
    assert.equal(raw.failure, 'spawn-error');
    assert.equal(raw.exitCode, null);
    assert.equal(raw.stdoutEOF, false);
    assert.equal(raw.stderrEOF, false);
    assert.equal((await a.decoded()).state, 'query-unconfirmed');
});

test('nonzero, signal, mismatched close, pipe errors and premature close fail closed', async () => {
    for (const mode of [
        'nonzero',
        'signal',
        'mismatch',
        'pipe-error',
        'no-eof',
        'no-spawn',
    ] as const) {
        const f = await fixture(),
            a = await f.start();
        if (mode !== 'no-spawn') f.child.emit('spawn');
        f.child.stdout.emit('data', missing);
        if (mode === 'pipe-error') f.child.stdout.emit('error', Error('controlled pipe failure'));
        if (mode !== 'no-eof') f.child.stdout.end();
        f.child.stderr.end();
        f.child.exit(
            mode === 'nonzero' ? 1 : mode === 'signal' ? null : 0,
            mode === 'signal' ? 'SIGTERM' : null,
        );
        f.child.stdout.close();
        f.child.stderr.close();
        f.child.close(mode === 'mismatch' ? 1 : f.child.exitCode);
        const raw = await a.completed;
        assert.notEqual(raw.failure, 'none', mode);
        assert.equal((await a.decoded()).state, 'query-unconfirmed', mode);
    }
});

test('unobserved or uncertain custody stays pending without signals, timeout success or replayed closure', async () => {
    const f = await fixture();
    f.host.spawn = () => {
        throw Error('invocation uncertain');
    };
    const a = await f.start();
    let done = false;
    void a.completed.then(() => {
        done = true;
    });
    await Promise.resolve();
    assert.equal(done, false);
    assert.equal(a.snapshot().capture.failure, 'pending');
    assert.ok(a.custody.invocationError);
    assert.equal(a.custody.returned, false);
    const g = await fixture();
    g.child.stdout.closed = true;
    const b = await g.start();
    g.child.emit('spawn');
    g.child.exit();
    g.child.stderr.end();
    g.child.stderr.close();
    g.child.close();
    let second = false;
    void b.completed.then(() => {
        second = true;
    });
    await Promise.resolve();
    assert.equal(second, false);
    assert.equal(b.custody.historyUncertain, true);
});

test('missing pipes and failed observer registration retain pending custody', async () => {
    for (const mode of ['missing-pipe', 'registration-error'] as const) {
        const f = await fixture();
        if (mode === 'missing-pipe') {
            Object.defineProperty(f.child, 'stdout', { value: null });
        } else {
            const original = f.child.stdout.on;
            f.child.stdout.on = function (name, listener) {
                if (name === 'end') throw Error('controlled registration error');
                return original.call(this, name, listener);
            };
        }
        const a = await f.start();
        let done = false;
        void a.completed.then(() => {
            done = true;
        });
        f.child.emit('spawn');
        f.child.exit();
        f.child.stderr.end();
        f.child.stderr.close();
        if (f.child.stdout) {
            f.child.stdout.end();
            f.child.stdout.close();
        }
        f.child.close();
        await Promise.resolve();
        assert.equal(done, false);
        assert.equal(a.custody.observationUncertain, true);
        assert.equal(a.snapshot().capture.failure, 'pending');
    }
});

test('external snapshots and completed captures cannot rewrite retained decoder evidence', async () => {
    const f = await fixture(),
        a = await f.start();
    f.child.emit('spawn');
    f.child.stdout.emit('data', missing);
    f.finish();
    const raw = await a.completed;
    raw.stdout.fill(0);
    raw.failure = 'pending';
    const copy = a.custody;
    copy.childError = true;
    copy.settled = false;
    assert.equal((await a.decoded()).state, 'missing');
    assert.equal(a.custody.childError, false);
    assert.equal(a.custody.settled, true);
});

test('scratch requires canonical new physical storage and acknowledged write/sync/close before one use', async () => {
    const t = scratchFixture();
    const cap = await prepareWindowQueryScratch(t.directory, t.host);
    assert.equal(cap.directory, t.directory);
    assert.equal(Object.isFrozen(cap), true);
    assert.deepEqual(t.calls, [
        'inspect:' + t.parent,
        'mkdir:' + t.directory,
        'inspect:' + t.directory,
        'open:' + t.directory + '\\.window-query-write-probe',
        'write',
        'sync',
        'close',
        'inspect:' + t.directory,
        'inspect:' + t.parent,
    ]);
    const f = await fixture();
    await assert.rejects(
        () => invokeWindowsWindowQuery(234, { directory: t.directory }, f.host),
        /UNADMITTED/,
    );
    assert.equal(f.calls.length, 0);
    const a = await invokeWindowsWindowQuery(234, cap, f.host);
    await assert.rejects(() => invokeWindowsWindowQuery(234, cap, f.host), /UNADMITTED_OR_USED/);
    assert.equal(f.calls.length, 1);
    f.child.emit('spawn');
    f.child.stdout.emit('data', missing);
    f.finish();
    assert.equal((await a.decoded()).state, 'missing');
});

test('scratch refuses existing directories, aliases, changed identity and unacknowledged writes without cleanup', async () => {
    for (const mode of ['exists', 'alias', 'identity', 'write', 'sync', 'close'] as const) {
        const t = scratchFixture();
        if (mode === 'exists')
            t.host.mkdir = async () => {
                throw Error('EEXIST');
            };
        if (mode === 'alias')
            t.host.mkdir = async () => {
                t.directories.set(t.directory, { realpath: 'C:\\foreign', device: 1n, inode: 2n });
            };
        const open = t.host.openProbe;
        t.host.openProbe = async (file) => {
            const h = await open(file);
            if (mode === 'identity')
                t.directories.set(t.directory, { realpath: t.directory, device: 1n, inode: 3n });
            if (mode === 'write')
                h.writeFile = async () => {
                    throw Error('write denied');
                };
            if (mode === 'sync')
                h.sync = async () => {
                    throw Error('sync rejected');
                };
            if (mode === 'close')
                h.close = async () => {
                    throw Error('close uncertain');
                };
            return h;
        };
        await assert.rejects(prepareWindowQueryScratch(t.directory, t.host), (error: any) => {
            assert.equal(error.message, 'WINDOW_QUERY_SCRATCH_PREPARATION_FAILED');
            assert.equal(error.custody.directory, t.directory);
            if (mode === 'close') {
                assert.equal(error.custody.probeClosed, false);
                assert.ok(error.custody.handle);
            }
            return true;
        });
        if (mode === 'write' || mode === 'sync') assert.ok(t.calls.includes('close'));
        assert.equal(
            t.calls.some((call) => /unlink|remove|delete/.test(call)),
            false,
        );
    }
});

test('invalid scratch paths and unsupported platform fail before any filesystem call', async () => {
    const t = scratchFixture();
    for (const name of [
        'C:\\',
        'relative',
        '\\\\host\\temp',
        'C:\\temp\\..\\x',
        'C:/temp/x',
        'C:\\temp%X\\x',
    ])
        await assert.rejects(prepareWindowQueryScratch(name, t.host), /PATH_INVALID/);
    await assert.rejects(
        prepareWindowQueryScratch(t.directory, { ...t.host, platform: 'linux' }),
        /WINDOWS_REQUIRED/,
    );
    assert.deepEqual(t.calls, []);
});

test('scratch replacement or redirection after preparation refuses use before query spawn', async () => {
    for (const mode of [
        'directory-replaced',
        'parent-replaced',
        'directory-redirected',
        'parent-redirected',
    ] as const) {
        const t = scratchFixture();
        const cap = await prepareWindowQueryScratch(t.directory, t.host);
        const name = mode.startsWith('parent') ? t.parent : t.directory;
        const previous = t.directories.get(name)!;
        t.directories.set(
            name,
            mode.endsWith('redirected')
                ? { ...previous, realpath: 'C:\\foreign' }
                : { ...previous, inode: 99n },
        );
        const f = await fixture();
        await assert.rejects(
            invokeWindowsWindowQuery(234, cap, f.host),
            /SCRATCH_IDENTITY_(INVALID|CHANGED_AT_USE)/,
        );
        assert.equal(f.calls.length, 0);
        await assert.rejects(
            invokeWindowsWindowQuery(234, cap, f.host),
            /SCRATCH_UNADMITTED_OR_USED/,
        );
        assert.equal(f.calls.length, 0);
    }
});

test('pending at-use verification admits neither a query nor a second consumer', async () => {
    const t = scratchFixture();
    const inspect = t.host.inspectDirectory;
    let checking = false;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    t.host.inspectDirectory = async (name) => {
        if (checking && name === t.directory) {
            entered();
            await held;
        }
        return inspect(name);
    };
    const cap = await prepareWindowQueryScratch(t.directory, t.host);
    checking = true;
    const f = await fixture();
    const pending = invokeWindowsWindowQuery(234, cap, f.host);
    await started;
    try {
        assert.equal(f.calls.length, 0);
        await assert.rejects(
            invokeWindowsWindowQuery(234, cap, f.host),
            /SCRATCH_UNADMITTED_OR_USED/,
        );
    } finally {
        release();
    }
    const a = await pending;
    assert.equal(f.calls.length, 1);
    f.child.emit('spawn');
    f.child.stdout.emit('data', missing);
    f.finish();
    assert.equal((await a.decoded()).state, 'missing');
});

test('injected preparation cannot become native provenance or reach the blocked native invocation', async () => {
    const t = scratchFixture();
    Object.assign(t.host, { provenance: 'native-filesystem' }); // A claim cannot change private adapter identity.
    const cap = await prepareWindowQueryScratch(t.directory, t.host);
    const checked = t.calls.length;
    await assert.rejects(
        consumeWindowQueryScratch(cap, 'native-filesystem'),
        /PROVENANCE_MISMATCH/,
    );
    assert.equal(t.calls.length, checked);
    await assert.rejects(invokeWindowsWindowQuery(234, cap), /NATIVE_PATH_CUSTODY_UNAVAILABLE/);
    const f = await fixture();
    await assert.rejects(
        invokeWindowsWindowQuery(234, cap, { ...f.host, scope: 'native' as any }),
        /NATIVE_PATH_CUSTODY_UNAVAILABLE/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(t.calls.length, checked);
    const a = await invokeWindowsWindowQuery(234, cap, f.host);
    f.child.emit('spawn');
    f.child.stdout.emit('data', missing);
    f.finish();
    assert.equal((await a.decoded()).state, 'missing');
});
