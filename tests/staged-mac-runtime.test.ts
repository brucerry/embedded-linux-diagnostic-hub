import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import {
    runStagedMacRuntime,
    macRuntimeFailureDiagnostic,
    formatMacRuntimeFailure,
    emitMacRuntimeFailure,
    type MacRuntimeInput,
    type MacRuntimePorts,
} from './fixtures/staged-mac-runtime.ts';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
class Retained extends Error {
    readonly context: any;
    constructor(context: any) {
        super('retained');
        this.context = context;
    }
}
type Options = {
    identity?: Record<string, unknown>;
    fail?: string;
    late?: string;
    freezeBefore?: boolean;
    windowCount?: number;
};
function fixture(options: Options = {}) {
    const input: MacRuntimeInput = {
        executable: '/source/release/mac-arm64/Diagnostic Hub.app/Contents/MacOS/Diagnostic Hub',
        destination: '/evidence/runtime.json',
        buildInfo: '/source/release/macos-build-info-arm64.json',
        root: '/owned/runtime',
        sourceCommit: '1'.repeat(40),
        asset: 'Diagnostic-Hub-macos-arm64.zip',
        arch: 'arm64',
        cwd: '/source',
        environment: { HTTPS_PROXY: 'test-proxy', RUNNER_SECRET: 'not-child-env' },
    };
    const asar = '/source/release/mac-arm64/Diagnostic Hub.app/Contents/Resources/app.asar';
    const executableBytes = Buffer.from('real fake-control executable bytes');
    const asarBytes = Buffer.from('real fake-control asar bytes');
    const files = new Map<string, Buffer>([
        [input.executable, executableBytes],
        [asar, asarBytes],
    ]);
    const put = (file: string, value: unknown) =>
        files.set(file, Buffer.from(JSON.stringify(value)));
    put('/source/package.json', { version: '0.6.0', devDependencies: { electron: '44.5.1' } });
    put('/source/package-lock.json', {
        version: '0.6.0',
        packages: { '': { version: '0.6.0' }, 'node_modules/electron': { version: '44.5.1' } },
    });
    put(input.buildInfo, {
        platform: 'darwin',
        arch: 'arm64',
        version: '0.6.0',
        commit: input.sourceCommit,
        source: input.sourceCommit,
        asset: input.asset,
        sha256: '2'.repeat(64),
        asarSHA256: digest(asarBytes),
        bundleIdentifier: 'dev.diagnostichub.desktop',
        minimumMacOSVersion: '13.0.0',
        signature: 'ad-hoc',
        adHocIntegrityVerified: true,
        packagedSourceMatches: true,
        distribution: true,
        notarized: false,
        gatekeeperDownloadedAppQualified: false,
        payloadIdentity: {
            schemaVersion: 1,
            inventorySHA256: '3'.repeat(64),
            entries: 6,
            files: 3,
            bytes: 100,
            executableSHA256: digest(executableBytes),
            asarSHA256: digest(asarBytes),
        },
    });
    const events: string[] = [],
        dirs = new Set<string>(),
        descriptors = new Map<number, any>();
    let nextFD = 20,
        nextWait = 0,
        resolveLate!: () => void,
        lateUsed = false;
    const late = new Promise<void>((resolve) => {
        resolveLate = resolve;
    });
    const primary = Error('specific fake IO failure');
    const gate = async (name: string) => {
        events.push(name);
        if (options.fail === name) throw primary;
        if (!lateUsed && options.late === name) {
            lateUsed = true;
            await late;
        }
    };
    const owner: any = {
        reason: null,
        publicationFDs: new Set<number>(),
        pendingWaits: new Map(),
        streams: {
            stdoutComplete: false,
            stderrComplete: false,
            stdoutEOF: false,
            stderrEOF: false,
        },
        preQuitReceiptVerified: false,
        quitComplete: false,
        exitObserved: false,
        closeObserved: false,
        exitCode: null,
        signal: null,
        active() {
            if (this.reason) throw Error('owner frozen');
        },
        freeze(reason: string) {
            this.reason ??= reason;
        },
        wait(promise: Promise<any>, phase: string) {
            this.active();
            const id = ++nextWait,
                record: any = { phase, returned: false, value: undefined };
            this.pendingWaits.set(id, record);
            const task = promise.then(
                (value) => {
                    record.returned = true;
                    record.value = value;
                    return value;
                },
                (error) => {
                    record.error = error;
                    throw error;
                },
            );
            record.task = task;
            void task.catch(() => {});
            if (options.freezeBefore && phase === 'runtime-root') {
                this.freeze('phase-deadline');
                return Promise.reject(primary);
            }
            if (
                options.late &&
                ((options.late.startsWith('open:') && phase === 'file-open') ||
                    (options.late.startsWith('mkdir:') && phase === 'runtime-root')) &&
                !lateUsed
            ) {
                return new Promise((_resolve, reject) =>
                    queueMicrotask(() => {
                        this.freeze('phase-deadline');
                        reject(primary);
                    }),
                );
            }
            return task.then((value) => {
                this.pendingWaits.delete(id);
                return value;
            });
        },
    };
    const snapshot = () => ({
        reason: owner.reason,
        physicalDescendantClosure: false,
        exitObserved: owner.exitObserved,
        closeObserved: owner.closeObserved,
        exitCode: owner.exitCode,
        signal: owner.signal,
        quitComplete: owner.quitComplete,
        mainTransportClosed: owner.quitComplete,
        rendererTransportClosed: owner.quitComplete,
        streams: { ...owner.streams },
        genericPending: owner.pendingWaits.size,
        publicationFDCount: owner.publicationFDs.size,
    });
    const mainWorld: Record<string, unknown> = {},
        isolatedWorld: Record<string, unknown> = {};
    const desktop: any = {
        owner,
        options: undefined,
        launch() {
            owner.active();
            owner.child = { kind: 'fake-owned-child' };
            events.push('launch');
        },
        process() {
            return { pid: 1001 };
        },
        async attach() {
            owner.attachReturned = true;
            events.push('attach');
        },
        async firstWindow() {
            return {
                waitForURL: async (url: string) => {
                    assert.equal(url, 'app://bundle/index.html');
                    events.push('url');
                },
            };
        },
        async evaluate(fn: Function, marker: string) {
            events.push('evaluate-real-callback');
            const contents = {
                async executeJavaScriptInIsolatedWorld(
                    _world: number,
                    scripts: { code: string }[],
                ) {
                    for (const script of scripts) vm.runInNewContext(script.code, isolatedWorld);
                },
                async executeJavaScript(code: string) {
                    return vm.runInNewContext(code, mainWorld);
                },
                getOSProcessId() {
                    return 42;
                },
            };
            const electron = {
                app: {
                    isPackaged: true,
                    getVersion: () => '0.6.0',
                    getAppPath: () => asar,
                    getPath: () => input.root + '/profile',
                    getAppMetrics: () => [{ pid: 42, sandboxed: true }],
                },
                BrowserWindow: {
                    getAllWindows: () =>
                        Array.from({ length: options.windowCount ?? 1 }, () => ({
                            webContents: contents,
                            isVisible: () => true,
                        })),
                },
            };
            // Execute the ACTUAL serialized callback with only the bindings MainInspector
            // provides. No module assert/closure bindings are supplied.
            const observed = await vm.runInNewContext('(' + fn.toString() + ')(electron, marker)', {
                electron,
                marker,
                __name: (value: unknown) => value,
                process: {
                    env: { HUB_STAGED_ASSET: input.asset },
                    platform: 'darwin',
                    arch: 'arm64',
                    execPath: input.executable,
                    versions: { node: '22.17.0', electron: '44.5.1', chrome: '144.0.0.0' },
                    argv: [],
                    pid: 1001,
                    cwd: () => input.cwd,
                },
            });
            return Object.assign(observed, options.identity);
        },
        async normalQuit() {
            owner.quitIntent = true;
            events.push('quit');
            assert.equal(owner.preQuitReceiptVerified, true);
            assert.equal(owner.publicationFDs.size, 0);
            assert.equal(owner.pendingWaits.size, 0);
            Object.assign(owner, {
                quitComplete: true,
                exitObserved: true,
                closeObserved: true,
                exitCode: 0,
                signal: null,
            });
            Object.assign(owner.streams, {
                stdoutComplete: true,
                stderrComplete: true,
                stdoutEOF: true,
                stderrEOF: true,
            });
        },
        snapshot,
    };
    const stat = (file: string) => {
        assert.ok(files.has(file), 'Missing fake file: ' + file);
        return {
            dev: 1n,
            ino: BigInt([...files.keys()].indexOf(file) + 1),
            mode: 0o100600n,
            nlink: 1n,
            size: BigInt(files.get(file)!.length),
            mtimeNs: 1n,
            ctimeNs: 1n,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
        };
    };
    const ports: MacRuntimePorts = {
        desktop(options) {
            events.push('owner-created');
            desktop.options = options;
            return desktop;
        },
        now: () => 1,
        async realpath(file) {
            await gate('realpath:' + file);
            return file;
        },
        async mkdir(file) {
            await gate('mkdir:' + file);
            assert.ok(!dirs.has(file));
            dirs.add(file);
        },
        async lstat(file) {
            await gate('lstat:' + file);
            return stat(file) as any;
        },
        async open(file, mode) {
            await gate('open:' + file);
            if (mode === 'create') {
                assert.ok(!files.has(file));
                files.set(file, Buffer.alloc(0));
            } else assert.ok(files.has(file));
            const handle: any = {
                fd: nextFD++,
                async stat() {
                    await gate('stat:' + file);
                    return stat(file);
                },
                async read(buffer: Buffer, offset: number, length: number, position: number) {
                    await gate('read:' + file);
                    const source = files.get(file)!;
                    const n = source.copy(
                        buffer,
                        offset,
                        position,
                        Math.min(source.length, position + length),
                    );
                    return { bytesRead: n };
                },
                async writeFile(bytes: Buffer) {
                    await gate('write:' + file);
                    files.set(file, Buffer.from(bytes));
                },
                async sync() {
                    await gate('sync:' + file);
                },
                async close() {
                    await gate('close:' + file);
                    descriptors.delete(handle.fd);
                    handle.fd = -1;
                },
            };
            descriptors.set(handle.fd, handle);
            return handle;
        },
        async overview() {
            events.push('overview');
        },
        async retain(context) {
            throw new Retained(context);
        },
        reportFailure() {
            events.push('report-failure');
        },
    };
    return {
        input,
        ports,
        owner,
        desktop,
        files,
        dirs,
        descriptors,
        events,
        primary,
        resolveLate,
        isolatedWorld,
        mainWorld,
    };
}

test('owned Mac runtime executes the actual callback and publishes only after durable prequit and normal closure', async () => {
    const f = fixture();
    const identity = await runStagedMacRuntime(f.input, f.ports);
    assert.equal(f.events[0], 'owner-created');
    assert.equal(identity.versions.node, '22.17.0'); // Embedded Node is not driver Node.
    assert.equal(identity.diskIdentityOnly, true);
    assert.equal(identity.physicalLoadedBytesVerified, false);
    assert.equal(identity.physicalDescendantClosure, false);
    assert.equal(identity.fixtureNetworkMode, 'default');
    assert.equal(f.desktop.options.env.HOME, '/owned/runtime/home');
    assert.equal(f.desktop.options.env.TMPDIR, '/owned/runtime/temp');
    assert.equal(f.desktop.options.env.HTTPS_PROXY, 'test-proxy');
    assert.equal(f.desktop.options.env.RUNNER_SECRET, undefined);
    assert.ok(f.events.indexOf('sync:/owned/runtime/prequit.json') < f.events.indexOf('quit'));
    assert.equal(f.owner.publicationFDs.size, 0);
    assert.equal(f.descriptors.size, 0);
    assert.deepEqual(Object.keys(f.isolatedWorld), []);
    const output = JSON.parse(f.files.get(f.input.destination)!.toString());
    assert.equal(output.releaseAcceptance, false);
    assert.equal(output.closure.mainTransportClosed, true);
    assert.equal(output.closure.streams.stdoutEOF, true);
});

test('owned Mac runtime refuses failed packaged isolation sandbox visibility paths and runtime identities', async () => {
    for (const identity of [
        { packaged: false },
        { contextsSeparated: false },
        { pageNodeAbsent: false },
        { osSandboxed: false },
        { nativeVisible: false },
        { version: '0.5.2' },
        { platform: 'linux' },
        { arch: 'x64' },
        { executable: '/other/exe' },
        { asar: '/other/app.asar' },
        { profile: '/other/profile' },
        { cwd: '/other' },
        { versions: { node: '22.17.0', electron: 'wrong', chrome: '144' } },
        { versions: { node: '', electron: '44.5.1', chrome: '144' } },
        { versions: { node: '22.17.0', electron: '44.5.1', chrome: '' } },
    ]) {
        const f = fixture({ identity });
        await assert.rejects(runStagedMacRuntime(f.input, f.ports), Retained);
        assert.ok(!f.events.includes('quit'));
        assert.ok(!f.files.has(f.input.destination));
    }
    for (const windowCount of [0, 2]) {
        const f = fixture({ windowCount });
        await assert.rejects(runStagedMacRuntime(f.input, f.ports), (error: unknown) => {
            assert.ok(error instanceof Retained);
            assert.equal(error.context.error.message, 'Expected one packaged application window.');
            return true;
        });
        assert.ok(!f.events.includes('quit'));
        assert.ok(!f.files.has(f.input.destination));
    }
});

test('owned Mac runtime refuses changed same-job executable and ASAR bytes before launch', async () => {
    for (const changed of ['executable', 'asar']) {
        const f = fixture();
        const file =
            changed === 'executable'
                ? f.input.executable
                : '/source/release/mac-arm64/Diagnostic Hub.app/Contents/Resources/app.asar';
        f.files.set(file, Buffer.from('changed bytes'));
        await assert.rejects(runStagedMacRuntime(f.input, f.ports), Retained);
        assert.ok(!f.events.includes('launch'));
    }
});

test('owned Mac runtime retains read and prequit handles on failed close sync or write without quitting', async () => {
    for (const fail of [
        'close:/source/package.json',
        'write:/owned/runtime/prequit.json',
        'sync:/owned/runtime/prequit.json',
        'close:/owned/runtime/prequit.json',
    ]) {
        const f = fixture({ fail });
        await assert.rejects(runStagedMacRuntime(f.input, f.ports), (error: unknown) => {
            assert.ok(error instanceof Retained);
            assert.equal(error.context.error, f.primary);
            assert.ok(error.context.handles.size > 0);
            return true;
        });
        assert.ok(!f.events.includes('quit'));
        assert.ok(f.owner.publicationFDs.size > 0);
    }
});

test('owned Mac runtime retains late read opens and mkdir results after an owner deadline', async () => {
    for (const late of ['open:/source/package.json', 'mkdir:/owned/runtime']) {
        const f = fixture({ late });
        let retained: any;
        await assert.rejects(runStagedMacRuntime(f.input, f.ports), (error: unknown) => {
            assert.ok(error instanceof Retained);
            retained = error.context;
            return true;
        });
        f.resolveLate();
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(f.owner.pendingWaits.size > 0);
        assert.ok([...f.owner.pendingWaits.values()].some((record: any) => record.returned));
        assert.ok(!f.events.includes('launch'));
        if (late.startsWith('open:')) {
            assert.equal(retained.handles.size, 1);
            assert.equal(f.owner.publicationFDs.size, 1);
            assert.ok(!f.events.includes('stat:/source/package.json'));
            assert.ok(!f.events.includes('close:/source/package.json'));
        }
    }
});

test('owned Mac runtime retains a normally closed root if final publication fails', async () => {
    const f = fixture({ fail: 'open:/evidence/runtime.json' });
    await assert.rejects(runStagedMacRuntime(f.input, f.ports), (error: unknown) => {
        assert.ok(error instanceof Retained);
        assert.equal(error.context.error, f.primary);
        return true;
    });
    assert.equal(f.events.filter((event) => event === 'quit').length, 1);
    assert.equal(f.owner.quitComplete, true);
    assert.ok(!f.files.has(f.input.destination));
});

test('owned Mac runtime starts no new IO when custody freezes before the operation microtask', async () => {
    const f = fixture({ freezeBefore: true });
    await assert.rejects(runStagedMacRuntime(f.input, f.ports), Retained);
    assert.ok(!f.events.includes('mkdir:/owned/runtime'));
    assert.ok(!f.events.includes('launch'));
    assert.equal(f.descriptors.size, 0);
});

test('owned Mac runtime rejects SDK Node and connection overrides before owner or IO acquisition', async () => {
    for (const name of [
        'NODE_OPTIONS',
        'NODE_PATH',
        'ELECTRON_RUN_AS_NODE',
        'PWDEBUG',
        'PW_INSTRUMENT_MODULES',
        'PLAYWRIGHT_DRIVER_URL',
        'PW_TEST_CONNECT_WS_ENDPOINT',
        'PW_TEST_OTHER',
        'SELENIUM_REMOTE_URL',
        'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
    ]) {
        const f = fixture();
        f.input.environment[name] = 'blocked';
        await assert.rejects(runStagedMacRuntime(f.input, f.ports), /override is not admitted/);
        assert.deepEqual(f.events, []);
    }
});

test('owned Mac runtime snapshots caller destinations and environment before pending IO', async () => {
    const f = fixture();
    const destination = f.input.destination;
    const realpath = f.ports.realpath;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    let first = true;
    f.ports.realpath = async (file) => {
        if (first) {
            first = false;
            await waiting;
        }
        return realpath(file);
    };
    const run = runStagedMacRuntime(f.input, f.ports);
    await new Promise((resolve) => setImmediate(resolve));
    f.input.destination = '/foreign/mutated.json';
    f.input.environment.HTTPS_PROXY = 'mutated-proxy';
    release();
    await run;
    assert.ok(f.files.has(destination));
    assert.ok(!f.files.has('/foreign/mutated.json'));
    assert.equal(f.desktop.options.env.HTTPS_PROXY, 'test-proxy');
});

test('owned Mac retained diagnostic exposes only finite data without getters proxies or exception strings', () => {
    let touched = 0;
    const owner = {
        reason: 'main-evaluate-exception',
        pendingWaits: new Map([[1, { phase: 'main-response', error: 'private exception' }]]),
        shutdownPending: new Map(),
        mainPendingCount: 1000,
        child: {},
        attachReturned: true,
        quitIntent: false,
        exitObserved: false,
        closeObserved: false,
        streams: { stdoutEOF: false, stderrEOF: false },
        get error() {
            touched++;
            throw Error('secret');
        },
    };
    const diagnostic = macRuntimeFailureDiagnostic('runtime-identity', owner, 1000);
    assert.equal(diagnostic.reason, 'main-evaluation');
    assert.equal(diagnostic.waitingStage, 'main-response');
    assert.equal(diagnostic.pendingMain, 17);
    assert.equal(diagnostic.openFiles, 33);
    const candidate = {
        ...diagnostic,
        secret: 'private path /Users/private/token',
        toJSON() {
            touched++;
            return 'secret';
        },
    };
    const text = formatMacRuntimeFailure(candidate);
    assert.ok(Buffer.byteLength(text) <= 2048);
    assert.ok(!/secret|private|Users|token/.test(text));
    assert.equal(touched, 0);
    const getter = Object.defineProperty({}, 'reason', {
        get() {
            touched++;
            return 'secret';
        },
    });
    assert.equal(macRuntimeFailureDiagnostic('not-a-stage', getter, 0).reason, 'operation');
    const proxy = new Proxy(
        {},
        {
            getOwnPropertyDescriptor() {
                touched++;
                throw Error('secret');
            },
        },
    );
    assert.equal(macRuntimeFailureDiagnostic('prepare', proxy, 0).childObserved, false);
    assert.equal(touched, 0);
    assert.equal(
        macRuntimeFailureDiagnostic('prepare', { reason: 'secret arbitrary error' }, 0).reason,
        'other',
    );
    const shutdown = macRuntimeFailureDiagnostic(
        'normal-quit',
        {
            reason: 'shutdown-deadline',
            pendingWaits: new Map(),
            shutdownPending: new Map([[1, { phase: 'transport-close' }]]),
        },
        0,
    );
    assert.equal(shutdown.reason, 'deadline');
    assert.equal(shutdown.waitingStage, 'transport-close');
    assert.equal(shutdown.pendingShutdown, 1);
});

test('owned Mac retained diagnostic reports the failing stage once before parking without new owner work', async () => {
    const f = fixture({ fail: 'close:/source/package.json' });
    const diagnostics: unknown[] = [];
    f.ports.reportFailure = (value) => {
        diagnostics.push(value);
        f.events.push('public-diagnostic');
    };
    f.ports.retain = async (context) => {
        f.events.push('retained');
        throw new Retained(context);
    };
    await assert.rejects(runStagedMacRuntime(f.input, f.ports), (error: unknown) => {
        assert.ok(error instanceof Retained);
        assert.equal(error.context.error, f.primary);
        return true;
    });
    assert.equal(diagnostics.length, 1);
    const diagnostic = diagnostics[0] as ReturnType<typeof macRuntimeFailureDiagnostic>;
    assert.equal(diagnostic.stage, 'file-close');
    assert.equal(diagnostic.openFiles, 1);
    assert.equal(diagnostic.retainedUnknown, true);
    assert.equal(diagnostic.releaseAcceptance, false);
    assert.ok(f.events.indexOf('public-diagnostic') < f.events.indexOf('retained'));
    assert.ok(!f.events.includes('quit'));
});

test('owned Mac retained diagnostic preserves timeout stage and late handle custody without a second report', async () => {
    const f = fixture({ late: 'open:/source/package.json' });
    const diagnostics: ReturnType<typeof macRuntimeFailureDiagnostic>[] = [];
    f.ports.reportFailure = (value) => {
        diagnostics.push(value);
    };
    await assert.rejects(runStagedMacRuntime(f.input, f.ports), Retained);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].reason, 'deadline');
    assert.equal(diagnostics[0].waitingStage, 'file-open');
    assert.equal(diagnostics[0].pendingOperations, 1);
    assert.equal(diagnostics[0].openFiles, 0);
    f.resolveLate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.owner.publicationFDs.size, 1);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].openFiles, 0); // Immutable facts at report time.
    assert.ok(!f.events.includes('stat:/source/package.json'));
    assert.ok(!f.events.includes('close:/source/package.json'));
});

test('owned Mac diagnostic uses one bounded write and preserves primary custody on short or failed writes', async () => {
    for (const mode of ['success', 'short', 'throw']) {
        const f = fixture({ fail: 'close:/source/package.json' });
        let writes = 0;
        f.ports.reportFailure = (diagnostic) =>
            emitMacRuntimeFailure(diagnostic, (line) => {
                writes++;
                assert.ok(line.startsWith('::error title=Mac retained runtime diagnostic::'));
                const message = line.slice(line.indexOf('::', 2) + 2, -1);
                assert.ok(Buffer.byteLength(message) <= 2048);
                assert.equal(JSON.parse(message).retainedUnknown, true);
                if (mode === 'throw') throw Error('reporter failure must remain secondary');
                return Buffer.byteLength(line) - (mode === 'short' ? 1 : 0);
            });
        await assert.rejects(runStagedMacRuntime(f.input, f.ports), (error: unknown) => {
            assert.ok(error instanceof Retained);
            assert.equal(error.context.error, f.primary);
            assert.equal(error.context.handles.size, 1);
            return true;
        });
        assert.equal(writes, 1);
        assert.ok(!f.events.includes('quit'));
        assert.equal(f.owner.publicationFDs.size, 1);
    }
});
