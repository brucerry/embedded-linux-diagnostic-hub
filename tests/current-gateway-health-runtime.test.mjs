// Closed-memory composition controls. No SSH2/Gateway load, listener, child, HTTP or real timer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(
    new URL('../scripts/lib/current-gateway-health-runtime.mjs', import.meta.url),
    'utf8',
);
const hash = (v) => createHash('sha256').update(v).digest('hex');
assert.equal(hash(source), 'd146d985732ba314178f7b87d74524a66d076662c8b9ba0866d1644237b5ac0a');
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
async function until(predicate) {
    for (let i = 0; i < 2000 && !predicate(); i++) await Promise.resolve();
    assert.ok(predicate(), 'Reach the explicit authored memory milestone.');
}
function fixture(options = {}) {
    const initialized = deferred(),
        runtimeResult = deferred(),
        runtimeClosed = deferred(),
        runtimeStarted = deferred(),
        timers = new Set(),
        calls = [],
        observed = {};
    let server,
        loadCalls = 0,
        keyCalls = 0;
    class Server extends EventEmitter {
        constructor(config) {
            super();
            server = this;
            calls.push('server');
            assert.equal(config.hostKeys[0], 'authored-private-key');
        }
        listen(port, host, callback) {
            calls.push('listen');
            assert.equal(port, 0);
            assert.equal(host, '127.0.0.1');
            this.listenCallback = callback;
            queueMicrotask(() => {
                callback();
                if (options.duplicateListen) callback();
            });
            return this;
        }
        address() {
            return { address: '127.0.0.1', port: 60001 };
        }
        getConnections(callback) {
            calls.push('query');
            this.queryCallback = callback;
            queueMicrotask(() => {
                callback(null, options.connections ?? 0);
                if (options.duplicateQuery) callback(null, 0);
            });
            return this;
        }
        close(callback) {
            calls.push('close');
            this.closeCallback = callback;
            if (!options.holdClose)
                queueMicrotask(() => {
                    if (options.ackBeforeEvent) {
                        callback();
                        this.emit('close');
                    } else {
                        this.emit('close');
                        callback();
                    }
                    if (options.duplicateCloseCallback) callback();
                    if (options.duplicateCloseEvent) this.emit('close');
                });
            return this;
        }
    }
    const loaded = {
        ssh2: {
            Server,
            utils: { parseKey: () => ({ getPublicSSH: () => Buffer.from('authored-public-key') }) },
        },
        initialization: initialized.promise,
    };
    if (options.noInitialization) loaded.initialization = undefined;
    const runtime = {
        result: runtimeResult.promise,
        closed: runtimeClosed.promise,
        snapshot: () => ({ authoredMemoryOnly: true }),
    };
    const ports = {
        loadSSH2() {
            loadCalls++;
            return options.loadReturn ?? loaded;
        },
        keyPair() {
            keyCalls++;
            return options.keyReturn ?? { privateKey: { export: () => 'authored-private-key' } };
        },
        randomBytes(n) {
            assert.equal(n, 32);
            return Buffer.alloc(n, 0xab);
        },
        launch() {
            throw Error('No real child port in memory controls');
        },
        request() {
            throw Error('No real HTTP port in memory controls');
        },
        now: () => 0,
        setTimer(callback, ms) {
            if (options.timerThrow) throw options.timerFailure;
            const timer = { callback, ms };
            timers.add(timer);
            return timer;
        },
        clearTimer(timer) {
            assert.ok(timers.delete(timer));
        },
    };
    const input = {
        root: '/authored/install',
        nodePath: '/authored/node/bin/node',
        version: '0.6.0',
        observer: observed,
    };
    observed.observeChild = () => {
        throw Error('Only the actual helper owns this observer when invoked');
    };
    const tree = ts.createSourceFile(
        'actual-runtime.mjs',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const text = tree.statements
        .filter((node) => !ts.isImportDeclaration(node))
        .map((node) => node.getText(tree))
        .join('\n');
    const context = vm.createContext(
        {
            assert,
            createHash,
            Buffer,
            Promise,
            Set,
            Error,
            module: { exports: {} },
            exports: {},
            startDiagnosticGatewayRuntime(selected, supplied) {
                calls.push('runtime');
                assert.equal(supplied.observer, observed);
                assert.equal(selected.root, '/authored/install');
                assert.equal(selected.nodePath, '/authored/node/bin/node');
                assert.equal(selected.version, '0.6.0');
                assert.equal(selected.target.host, '127.0.0.1');
                assert.equal(selected.target.port, 60001);
                assert.equal(
                    selected.target.fingerprint,
                    'SHA256:' +
                        createHash('sha256')
                            .update('authored-public-key')
                            .digest('base64')
                            .replace(/=+$/, ''),
                );
                assert.equal(selected.token, 'ab'.repeat(32));
                assert.equal(selected.port, 58731);
                runtimeStarted.resolve();
                return runtime;
            },
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
    context.exports = context.module.exports;
    const compiled = ts.transpileModule(text, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new vm.Script(compiled, { filename: 'actual-current-runtime.memory.cjs' }).runInContext(
        context,
    );
    const start = () => context.module.exports.startCurrentGatewayHealthRuntime(input, ports);
    const finish = () => {
        runtimeResult.resolve({
            receipt: { releaseAcceptance: false },
            observation: { record: { authoredMemoryOnly: true }, sha256: 'd'.repeat(64) },
        });
        runtimeClosed.resolve();
    };
    return {
        input,
        start,
        initialized,
        runtimeStarted,
        runtimeResult,
        runtimeClosed,
        finish,
        calls,
        timers,
        get server() {
            return server;
        },
        loadCalls: () => loadCalls,
        keyCalls: () => keyCalls,
    };
}

test('actual composition binds genuine-target inputs to the same observer and normally closes only its unused listener', async () => {
    for (const ackBeforeEvent of [false, true]) {
        const f = fixture({ ackBeforeEvent }),
            owner = f.start();
        f.initialized.resolve();
        await f.runtimeStarted.promise;
        f.finish();
        const result = await owner.result;
        await owner.closed;
        assert.deepEqual(f.calls, ['server', 'listen', 'runtime', 'query', 'close']);
        assert.equal(result.fixture.activeTCPConnectionsAtClose, 0);
        assert.equal(result.fixture.observedSSHConnections, 0);
        assert.equal(result.fixture.rawTCPAcceptsObserved, null);
        assert.equal(result.fixture.releaseAcceptance, false);
        assert.equal(owner.snapshot().retired, true);
        assert.equal(f.timers.size, 0);
        assert.equal(f.server.eventNames().length, 0);
        assert.ok(!JSON.stringify(result).includes('authored-private-key'));
        assert.ok(!JSON.stringify(result).includes('ab'.repeat(32)));
    }
});

test('undefined initialization and unsupported module or key acquisition stay failed without a child', async () => {
    const late = deferred();
    for (const options of [
        { noInitialization: true },
        { loadReturn: late.promise },
        { keyReturn: late.promise },
    ]) {
        const f = fixture(options),
            owner = f.start();
        f.initialized.resolve();
        await assert.rejects(owner.result);
        assert.equal(f.calls.includes('runtime'), false);
        assert.equal(owner.snapshot().retired, false);
        if (options.loadReturn || options.keyReturn)
            assert.ok(owner.snapshot().unknownOperations > 0);
    }
    late.resolve({ lateAuthoredValue: true });
});

test('issued initialization is retained before a throwing timer factory and late settlement never starts work', async () => {
    const f = fixture({ timerThrow: true, timerFailure: undefined }),
        owner = f.start();
    await assert.rejects(owner.result, (error) => {
        assert.equal(error.cause, undefined);
        return true;
    });
    assert.equal(owner.snapshot().pending, 1);
    f.initialized.resolve();
    await until(() => owner.snapshot().pending === 0);
    assert.equal(f.keyCalls(), 0);
    assert.equal(f.calls.length, 0);
    assert.equal(owner.snapshot().retired, false);
    assert.equal(owner.snapshot().timers, 1);
});

test('duplicate listen or query acknowledgement fails before another issued operation', async () => {
    const a = fixture({ duplicateListen: true }),
        first = a.start();
    a.initialized.resolve();
    await assert.rejects(first.result);
    assert.equal(a.calls.includes('runtime'), false);
    const b = fixture({ duplicateQuery: true }),
        second = b.start();
    b.initialized.resolve();
    await b.runtimeStarted.promise;
    b.finish();
    await assert.rejects(second.result);
    assert.equal(b.calls.filter((v) => v === 'query').length, 1);
    assert.equal(b.calls.includes('close'), false);
    assert.equal(second.snapshot().retired, false);
});

test('unexpected SSH connection or sampled active TCP connection retains custody without closing or retry', async () => {
    for (const mode of ['ssh', 'tcp']) {
        const f = fixture({ connections: mode === 'tcp' ? 1 : 0 }),
            owner = f.start();
        f.initialized.resolve();
        await f.runtimeStarted.promise;
        if (mode === 'ssh') {
            const client = new EventEmitter();
            f.server.emit('connection', client);
            client.emit('error', undefined);
        }
        f.finish();
        await assert.rejects(owner.result);
        await until(() => owner.snapshot().runtimeClosed);
        assert.equal(f.calls.includes('close'), false);
        assert.equal(owner.snapshot().retired, false);
    }
});

test('failed runtime remains failed after independently joined closure and the single normal unused-listener close', async () => {
    const f = fixture(),
        owner = f.start();
    f.initialized.resolve();
    await f.runtimeStarted.promise;
    f.runtimeResult.reject(undefined);
    await assert.rejects(owner.result, (error) => {
        assert.equal(error.cause, undefined);
        return true;
    });
    assert.equal(f.calls.includes('query'), false);
    f.runtimeClosed.resolve();
    await owner.closed;
    assert.equal(owner.snapshot().failed, true);
    assert.equal(owner.snapshot().retired, true);
    assert.equal(f.calls.filter((v) => v === 'query').length, 1);
    assert.equal(f.calls.filter((v) => v === 'close').length, 1);
});

test('close callback alone cannot release listener custody before its independent close event', async () => {
    const f = fixture({ holdClose: true }),
        owner = f.start();
    f.initialized.resolve();
    await f.runtimeStarted.promise;
    f.finish();
    await until(() => Boolean(f.server.closeCallback));
    f.server.closeCallback();
    await Promise.resolve();
    assert.equal(owner.snapshot().retired, false);
    assert.equal(owner.snapshot().closeEvent, false);
    f.server.emit('close');
    await owner.result;
    await owner.closed;
    assert.equal(owner.snapshot().retired, true);
});

test('selected root and observer are immutable across deferred installed-module initialization', async () => {
    const f = fixture(),
        owner = f.start();
    f.input.root = '/authored/changed';
    f.input.nodePath = '/authored/changed-node';
    f.input.version = '9.9.9';
    f.input.observer = {
        observeChild() {
            throw Error('Changed observer');
        },
    };
    f.initialized.resolve();
    await f.runtimeStarted.promise;
    f.finish();
    await owner.result;
    await owner.closed;
    assert.equal(owner.snapshot().retired, true);
});

test('duplicate close acknowledgements and events stay failed and retain the violated callback boundary', async () => {
    for (const options of [{ duplicateCloseCallback: true }, { duplicateCloseEvent: true }]) {
        const f = fixture(options),
            owner = f.start();
        f.initialized.resolve();
        await f.runtimeStarted.promise;
        f.finish();
        await assert.rejects(owner.result);
        assert.equal(owner.snapshot().retired, false);
        assert.ok(owner.snapshot().unknownOperations > 0);
        assert.equal(f.calls.filter((v) => v === 'close').length, 1);
    }
});
