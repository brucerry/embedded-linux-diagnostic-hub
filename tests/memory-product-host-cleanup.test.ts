import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { loadCleanupFixture } from './fixtures/memory-product-cleanup-vm';
import { runNativeCleanup } from './fixtures/memory-product-native-cleanup';
import { createProductParentClosureWitness } from './fixtures/memory-product-parent-closure';
import { productStartup } from './fixtures/memory-product-startup';
import { prepareNativeBuild } from './fixtures/memory-product-native-preparation';

type Control = {
    holdBuild?: Promise<void>;
    holdListen?: Promise<void>;
    holdLaunch?: Promise<void>;
    listenError?: boolean;
    launchError?: boolean;
    connectError?: boolean;
    closeError?: boolean;
    surviving?: boolean;
    unsafeArg?: boolean;
    sourceVerificationError?: 'host' | 'main';
};
function host(file: string, control: Control = {}) {
    const calls: string[] = [];
    const receipts: any[] = [];
    let listening = false,
        connected = true;
    const launchedProcess = {
        pid: 1234,
        spawnargs: control.unsafeArg ? ['--no-sandbox'] : ['owned-browser'],
    };
    class Server extends EventEmitter {
        listen(_port: number, _address: string, callback: () => void) {
            calls.push('listen');
            if (control.listenError) this.emit('error', Error('synthetic listen failure'));
            else {
                listening = true;
                if (control.holdListen) void control.holdListen.then(callback);
                else callback();
            }
        }
        address() {
            return { port: 12345 };
        }
        close(callback: (error?: Error) => void) {
            calls.push('server-close');
            listening = false;
            callback();
        }
        closeAllConnections() {
            calls.push('close-connections');
            if (control.closeError) throw Error('synthetic server cleanup failure');
        }
    }
    const page = { on() {}, workers: () => [], async goto() {}, async waitForFunction() {} };
    const protocol = {
        async detach() {
            calls.push('protocol-detach');
        },
    };
    const browser = {
        async close() {
            calls.push('browser-close');
            connected = false;
        },
        isConnected: () => connected,
        version: () => 'mock-browser',
        contexts: () => [],
        async newContext() {
            return {
                on() {},
                async newPage() {
                    return page;
                },
                async newCDPSession() {
                    return protocol;
                },
                async close() {
                    calls.push('context-close');
                },
            };
        },
        async newBrowserCDPSession() {
            return protocol;
        },
    };
    const type = {
        async launchServer(options: any) {
            calls.push('launch');
            assert.equal(options.chromiumSandbox, true);
            if (control.launchError) throw Error('synthetic SDK launch rejection');
            await control.holdLaunch;
            return {
                process: () => launchedProcess,
                wsEndpoint: () => 'mock-endpoint',
                async close() {
                    calls.push('root-close');
                },
            };
        },
        async connect() {
            calls.push('connect');
            if (control.connectError) throw Error('synthetic connect failure');
            return browser;
        },
    };
    const types = { chromium: type, firefox: {}, webkit: {}, _electron: {} };
    class Sampler {
        async sample() {
            calls.push('sample-history');
            return [];
        }
        async assertExited() {
            calls.push('assert-descendants');
            if (control.surviving) throw Error('synthetic surviving descendant');
        }
    }
    const forbidden = (name: string) => () => {
        throw Error('Cleanup model forbids ' + name);
    };
    const resolver = Object.assign(forbidden('native module resolution'), {
        resolve(name: string) {
            assert.equal(name, 'vite/package.json');
            return '/fixture/vite/package.json';
        },
    });
    const io = {
        async mkdir() {
            calls.push('mkdir');
        },
        async readFile() {
            throw Error('Unexpected fixture read.');
        },
    };
    const observer = {
        async verifyProductHostSources(root: string, realm: string) {
            calls.push('verify-host');
            assert.ok(path.isAbsolute(root));
            assert.equal(realm, 'native');
            if (control.sourceVerificationError === 'host')
                throw Error('synthetic source verification failure');
            return { syntheticCleanupModelOnly: true };
        },
        async verifyNativeMainSources(root: string) {
            calls.push('verify-main');
            assert.ok(path.isAbsolute(root));
            if (control.sourceVerificationError === 'main')
                throw Error('synthetic source verification failure');
        },
        nativeObserverBuildPlugin: forbidden('native build plugin'),
        assertProductNativeShutdown: forbidden('actual native shutdown observation'),
    };
    const imports: Record<string, unknown> = {
        'node:assert/strict': assert,
        'node:fs/promises': io,
        'node:path': path,
        'node:crypto': { createHash, randomUUID },
        'node:http': {
            createServer: () => {
                calls.push('server-create');
                return new Server();
            },
            request: forbidden('HTTP request'),
        },
        'node:child_process': {
            execFile(
                _exe: string,
                _args: string[],
                _opts: unknown,
                callback: (error: unknown, stdout: string, stderr: string) => void,
            ) {
                calls.push('build');
                if (control.holdBuild) void control.holdBuild.then(() => callback(null, '', ''));
                else callback(null, '', '');
            },
        },
        'node:module': { createRequire: () => resolver },
        '@playwright/test': {
            ...types,
            _electron: { launch: forbidden('Electron launch') },
            expect: forbidden('Playwright assertion'),
        },
        './memory-product-startup': { productStartup },
        './memory-resource-processes': { ProcessSampler: Sampler },
        './memory-product-native-cleanup': { runNativeCleanup },
        './memory-product-parent-closure': { createProductParentClosureWitness },
        // Cleanup ordering model only: this does not admit the current native source/profile.
        './memory-product-current-observer': observer,
        './memory-resource-ssh-profile': {
            async sshQualificationProfile() {
                calls.push('ssh-profile');
                return { sshEntry: '/fixture/ssh2/lib/index.js' };
            },
        },
        './memory-product-native-preparation': { prepareNativeBuild },
        './memory-product-inspection-host': {
            createBrowserInspectionHost: forbidden('browser inspection'),
        },
        esbuild: { build: forbidden('native main compilation') },
    };
    const downloads = loadCleanupFixture('memory-product-browser-downloads.ts', imports);
    imports['./memory-product-browser-downloads'] = {
        BrowserDownloadEvents: downloads.api.BrowserDownloadEvents,
        createBrowserDownloads: forbidden('browser download transport'),
    };
    const loaded = loadCleanupFixture(file, imports);
    return {
        api: loaded.api,
        calls,
        receipts,
        listening: () => listening,
        emit: async (stage: string, data: unknown) => {
            receipts.push({ stage, data });
        },
    };
}

test('unsupported browser lanes reject before build, server or SDK allocation', async () => {
    for (const input of [
        { engine: 'invalid', gcMode: 'normal' },
        { engine: 'toString', gcMode: 'normal' },
        { engine: 'firefox', gcMode: 'forced' },
        { engine: 'webkit', gcMode: 'forced' },
        { engine: 'chromium', gcMode: 'invalid' },
    ]) {
        const fake = host('memory-product-browser-host.ts');
        await assert.rejects(
            fake.api.createProductBrowser({
                profile: path.resolve('/fixture/profile'),
                ...input,
                emit: fake.emit,
            }),
            /Unsupported|cannot force GC/,
        );
        assert.deepEqual(fake.calls, [], 'Rejected preflight allocated resources.');
    }
});
test('empty/relative browser and native profiles and invalid native GC allocate nothing', async () => {
    for (const [file, method] of [
        ['memory-product-browser-host.ts', 'createProductBrowser'],
        ['memory-product-native-host.ts', 'createProductNative'],
    ])
        for (const input of [
            { profile: '', gcMode: 'normal' },
            { profile: 'relative-profile', gcMode: 'normal' },
            { profile: path.resolve('/fixture/profile'), gcMode: 'invalid' },
        ]) {
            const fake = host(file);
            await assert.rejects(
                fake.api[method]({ ...input, emit: fake.emit }),
                /profile|GC mode/,
            );
            assert.deepEqual(fake.calls, []);
        }
});
test('listen failure acknowledges server cleanup without launching a browser', async () => {
    const fake = host('memory-product-browser-host.ts', { listenError: true });
    await assert.rejects(
        fake.api.createProductBrowser({
            profile: path.resolve('/fixture/profile'),
            gcMode: 'normal',
            emit: fake.emit,
        }),
        /synthetic listen failure/,
    );
    assert.ok(fake.calls.includes('server-close'));
    assert.equal(fake.calls.includes('launch'), false);
    assert.equal(fake.listening(), false);
});
test('post-launch connect failure closes root, server and observed descendants', async () => {
    const fake = host('memory-product-browser-host.ts', { connectError: true });
    await assert.rejects(
        fake.api.createProductBrowser({
            profile: path.resolve('/fixture/profile'),
            gcMode: 'normal',
            emit: fake.emit,
        }),
        /synthetic connect failure/,
    );
    for (const name of ['root-close', 'server-close', 'assert-descendants'])
        assert.ok(fake.calls.includes(name), name);
    assert.equal(fake.listening(), false);
});
test('SDK launch rejection and failed teardown remain unverified while later disposers run', async () => {
    for (const control of [
        { launchError: true },
        { connectError: true, closeError: true, surviving: true },
    ]) {
        const fake = host('memory-product-browser-host.ts', control);
        await assert.rejects(
            fake.api.createProductBrowser({
                profile: path.resolve('/fixture/profile'),
                gcMode: 'normal',
                emit: fake.emit,
            }),
            AggregateError,
        );
        assert.ok(fake.calls.includes('server-close'));
        if (!control.launchError) assert.ok(fake.calls.includes('assert-descendants'));
        assert.ok(fake.receipts.some((row) => row.data.verified === false));
    }
});
test('normal close attempts descendants even when server cleanup fails and cannot publish closed', async () => {
    const fake = host('memory-product-browser-host.ts', { closeError: true });
    const value = await fake.api.createProductBrowser({
        profile: path.resolve('/fixture/profile'),
        gcMode: 'normal',
        emit: fake.emit,
    });
    await assert.rejects(value.close(), AggregateError);
    assert.ok(fake.calls.includes('root-close'));
    assert.ok(fake.calls.includes('assert-descendants'));
    await assert.rejects(value.assertExited(), /not verified/);
});
test('raw sandbox-disable arguments reject inside the protected teardown path', async () => {
    const fake = host('memory-product-browser-host.ts', { unsafeArg: true });
    await assert.rejects(
        fake.api.createProductBrowser({
            profile: path.resolve('/fixture/profile'),
            gcMode: 'normal',
            emit: fake.emit,
        }),
        /disabled the OS sandbox/,
    );
    assert.ok(fake.calls.includes('root-close'));
    assert.ok(fake.calls.includes('server-close'));
    assert.ok(fake.calls.includes('assert-descendants'));
});

test('root ownership acknowledgement precedes connection and survives connect failure', async () => {
    const fake = host('memory-product-browser-host.ts', { connectError: true });
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const pending = fake.api.createProductBrowser({
        profile: path.resolve('/fixture/profile'),
        gcMode: 'normal',
        emit: fake.emit,
        async observeRoot(child: { pid: number }) {
            assert.equal(child.pid, 1234);
            fake.calls.push('root-owner-retained');
            enter();
            await gate;
        },
    });
    await entered;
    assert.equal(fake.calls.includes('connect'), false);
    release();
    await assert.rejects(pending, /synthetic connect failure/);
    assert.ok(fake.calls.indexOf('root-owner-retained') < fake.calls.indexOf('connect'));
    for (const name of ['root-close', 'server-close', 'assert-descendants'])
        assert.ok(fake.calls.includes(name));
});

test('root ownership callback rejection still joins every startup disposer', async () => {
    const fake = host('memory-product-browser-host.ts'),
        failure = Error('Root owner admission failed.');
    await assert.rejects(
        fake.api.createProductBrowser({
            profile: path.resolve('/fixture/profile'),
            gcMode: 'normal',
            emit: fake.emit,
            async observeRoot() {
                throw failure;
            },
        }),
        (error: unknown) => error === failure,
    );
    assert.equal(fake.calls.includes('connect'), false);
    for (const name of ['root-close', 'server-close', 'assert-descendants'])
        assert.ok(fake.calls.includes(name));
});

function startupGate() {
    let resolve!: () => void;
    return {
        promise: new Promise<void>((done) => {
            resolve = done;
        }),
        release: () => resolve(),
    };
}
async function waitForStartupCall(calls: string[], name: string) {
    for (let i = 0; i < 100 && !calls.includes(name); i++) await Promise.resolve();
    assert.ok(calls.includes(name), 'Held startup stage not reached: ' + name);
}
for (const stage of ['build', 'listen', 'launch'] as const)
    test(
        'browser cancellation during held ' +
            stage +
            ' prevents further admissions and retains partial cleanup',
        async () => {
            const gate = startupGate(),
                controller = new AbortController();
            const fake = host('memory-product-browser-host.ts', {
                [stage === 'build'
                    ? 'holdBuild'
                    : stage === 'listen'
                      ? 'holdListen'
                      : 'holdLaunch']: gate.promise,
            });
            const pending = fake.api.createProductBrowser({
                profile: path.resolve('/fixture/profile'),
                gcMode: 'normal',
                signal: controller.signal,
                emit: fake.emit,
            });
            await waitForStartupCall(fake.calls, stage);
            controller.abort(Error('Product work deadline exhausted.'));
            gate.release();
            await assert.rejects(pending, /Product work deadline exhausted/);
            if (stage === 'build') assert.equal(fake.calls.includes('server-create'), false);
            if (stage === 'listen') {
                assert.equal(fake.calls.includes('launch'), false);
                assert.ok(fake.calls.includes('server-close'));
            }
            if (stage === 'launch') {
                assert.equal(fake.calls.includes('connect'), false);
                assert.ok(fake.calls.includes('root-close'));
                assert.ok(fake.calls.includes('assert-descendants'));
            }
        },
    );
test('native cancellation during held renderer build prevents later build and Electron admission', async () => {
    const gate = startupGate(),
        controller = new AbortController();
    const fake = host('memory-product-native-host.ts', { holdBuild: gate.promise });
    const pending = fake.api.createProductNative({
        profile: path.resolve('/fixture/profile'),
        gcMode: 'normal',
        signal: controller.signal,
        emit: fake.emit,
    });
    await waitForStartupCall(fake.calls, 'build');
    controller.abort(Error('Product work deadline exhausted.'));
    gate.release();
    await assert.rejects(pending, /Product work deadline exhausted/);
    assert.deepEqual(fake.calls, [
        'verify-host',
        'verify-main',
        'ssh-profile',
        'verify-host',
        'verify-main',
        'mkdir',
        'mkdir',
        'mkdir',
        'build',
    ]);
});

test('native cleanup model source refusal precedes every build or SDK effect', async () => {
    for (const sourceVerificationError of ['host', 'main'] as const) {
        const fake = host('memory-product-native-host.ts', { sourceVerificationError });
        await assert.rejects(
            fake.api.createProductNative({
                profile: path.resolve('/fixture/profile'),
                gcMode: 'normal',
                emit: fake.emit,
            }),
            /synthetic source verification failure/,
        );
        assert.deepEqual(
            fake.calls,
            sourceVerificationError === 'host' ? ['verify-host'] : ['verify-host', 'verify-main'],
        );
    }
});
