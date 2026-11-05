import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import ts from 'typescript';
import {
    createCompiledSourceObserver,
    createInstrumentedGatewayBootstrap,
} from '../scripts/lib/instrumented-gateway-observer.mjs';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pulse = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};
const deferred = () => {
    let resolve!: (value?: any) => void, reject!: (value: any) => void;
    const promise = new Promise<any>((a, b) => {
        resolve = a;
        reject = b;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
function setup() {
    const path = '/instrumented/gateway.cjs',
        bytes = Buffer.from('// authored instrumented script; never executed\nπ\n');
    const selected = {
        artifactPath: path,
        artifactSHA256: hash(bytes),
        observerSHA256: 'c'.repeat(64),
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
    };
    const scripts = new Map([[path, bytes]]),
        controls: any = {},
        events: string[] = [],
        callbacks = new Map<string, Function[]>();
    class Session extends EventEmitter {
        connect() {
            events.push('connect');
            if (controls.connectError) throw controls.connectError;
        }
        disconnect() {
            events.push('disconnect');
            if (controls.disconnectError) throw controls.disconnectError;
        }
        off(event: string, callback: (...args: any[]) => void) {
            events.push('off:' + event);
            if (controls.offError) throw controls.offError;
            return super.off(event, callback);
        }
        post(method: string, params: any, callback: Function) {
            events.push(method);
            const list = callbacks.get(method) ?? [];
            list.push(callback);
            callbacks.set(method, list);
            if (controls.throwMethod === method) throw controls.failure;
            if (method === 'Debugger.enable') {
                if (!controls.missing)
                    this.emit('Debugger.scriptParsed', {
                        params: {
                            scriptId: '1',
                            url: pathToFileURL(path).href,
                            length: bytes.toString().length,
                            ...controls.parsed,
                        },
                    });
                if (!controls.holdEnable) callback(controls.enableError ?? null, {});
            } else if (method === 'Debugger.getScriptSource') {
                if (!controls.holdSource)
                    callback(controls.sourceError ?? null, {
                        scriptSource: controls.source ?? bytes.toString(),
                    });
            } else {
                assert.equal(method, 'Debugger.disable');
                if (!controls.holdDisable) callback(controls.disableError ?? null, {});
            }
        }
    }
    const session = new Session();
    let acquired = 0,
        products = 0,
        closes = 0;
    const close = deferred();
    controls.closeImmediate = true;
    const product: any = {
        stopping: false,
        serverListening: false,
        cleanupTimers: 1,
        requestTasks: 0,
        httpSockets: 0,
        httpResponses: 0,
        httpBodyReaders: 0,
        pendingConnections: 0,
        sessions: 0,
        inFlight: 0,
        ownedSessions: 0,
        retiringSessions: 0,
        connectionAttempts: 0,
        cancelledAttemptCache: 0,
        sessionOwners: [],
        allSessionOwners: [],
    };
    const server: any = new EventEmitter();
    server.listen = (port: number, host: string) => {
        events.push('listen');
        assert.equal(host, '127.0.0.1');
        assert.ok(port >= 0);
        if (!controls.holdListen) {
            product.serverListening = true;
            server.emit('listening');
        }
        return server;
    };
    server.address = () => ({ address: controls.host ?? '127.0.0.1', port: 12345 });
    const off = server.off.bind(server);
    server.off = (...a: any[]) => {
        if (controls.serverOffError) throw controls.serverOffError;
        return off(...a);
    };
    let accepted: any;
    const factory = (config: any) => {
        events.push('factory');
        products++;
        accepted = config;
        if (controls.factoryError) throw controls.factoryError;
        return {
            server,
            get ownershipSnapshot() {
                if (controls.snapshotError) throw controls.snapshotError;
                return product;
            },
            async close() {
                closes++;
                events.push('product.close');
                if (!controls.closeImmediate) await close.promise;
                if (controls.closeError) throw controls.closeError;
                product.stopping = true;
                product.serverListening = false;
                product.cleanupTimers = 0;
                if (controls.nonzero) product.httpSockets = 1;
            },
        };
    };
    const sessionFactory = () => {
        acquired++;
        return session;
    };
    return {
        path,
        bytes,
        selected,
        scripts,
        controls,
        events,
        session,
        callbacks,
        sessionFactory,
        factory,
        product,
        server,
        close,
        get acquired() {
            return acquired;
        },
        get products() {
            return products;
        },
        get closes() {
            return closes;
        },
        get accepted() {
            return accepted;
        },
    };
}
test('exact inspector-returned source is observed without treating selection or URLs as source evidence', async () => {
    const f = setup(),
        o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
    await o.start();
    f.session.emit('Debugger.scriptParsed', {
        params: { scriptId: '2', url: 'node:internal/module' },
    });
    const result = await o.finish();
    await o.retirement;
    assert.equal(result.compiledScripts[0].sha256, f.selected.artifactSHA256);
    assert.equal(result.builtinScripts, 1);
    assert.equal(result.executedWorkloadCoverage, null);
    assert.equal(result.kernelExecutableMapping, null);
    assert.equal(o.snapshot().observerRetired, true);
    assert.deepEqual(f.events, [
        'connect',
        'Debugger.enable',
        'Debugger.getScriptSource',
        'Debugger.disable',
        'off:Debugger.scriptParsed',
        'disconnect',
    ]);
});
for (const kind of ['hash', 'path', 'traversal', 'invalid-UTF8'])
    test('selection refuses ' + kind + ' before any session acquisition', () => {
        const f = setup();
        if (kind === 'hash') f.selected.artifactSHA256 = 'f'.repeat(64);
        if (kind === 'path') f.selected.artifactPath = 'relative';
        if (kind === 'traversal') f.selected.artifactPath = '/instrumented/a/../gateway.cjs';
        if (kind === 'invalid-UTF8') f.scripts.set(f.path, Buffer.from([255]));
        assert.throws(() => createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory));
        assert.equal(f.acquired, 0);
    });
for (const kind of [
    'source',
    'wrapper',
    'unknown-url',
    'live-edit',
    'source-url',
    'length',
    'missing',
    'source-error',
])
    test('unproved compiled identity rejects ' + kind, async () => {
        const f = setup();
        if (kind === 'source') f.controls.source = 'changed';
        if (kind === 'wrapper') f.controls.source = '(function(){' + f.bytes.toString() + '})';
        if (kind === 'unknown-url') f.controls.parsed = { url: 'file:///other/unadmitted.js' };
        if (kind === 'live-edit') f.controls.parsed = { isLiveEdit: true };
        if (kind === 'source-url') f.controls.parsed = { hasSourceURL: true };
        if (kind === 'length') f.controls.parsed = { length: 1 };
        if (kind === 'missing') f.controls.missing = true;
        if (kind === 'source-error')
            f.controls.sourceError = Error('authored source callback failure');
        const o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
        await assert.rejects(o.start());
        await assert.rejects(o.finish());
        assert.equal(o.snapshot().observerRetired, true);
        assert.equal(o.snapshot().primaryFailure, true);
    });
test('a source mismatch failure does not retain source strings or render a secret marker', async () => {
    const f = setup(),
        marker = 'AUTHORED_PRIVATE_SOURCE_MARKER_NOT_A_REAL_SECRET';
    f.controls.source = '// ' + marker;
    const o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
    await assert.rejects(o.start(), (e: any) => {
        assert.equal(inspect(e, { depth: 8, showHidden: true }).includes(marker), false);
        return true;
    });
    assert.equal(inspect(o.failure(), { depth: 8, showHidden: true }).includes(marker), false);
    await assert.rejects(o.finish());
});
test('source acquisition remains held until callback acknowledges; late response cannot retire a different observer', async () => {
    const f = setup();
    f.controls.holdSource = true;
    const o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory),
        start = o.start();
    await pulse();
    assert.equal(o.snapshot().pendingCallbacks, 1);
    const finish = o.finish();
    await pulse();
    assert.equal(f.events.includes('disconnect'), false);
    f.callbacks.get('Debugger.getScriptSource')![0](null, { scriptSource: f.bytes.toString() });
    await start;
    await finish;
    const replacement = setup(),
        newOwner = createCompiledSourceObserver(
            replacement.selected,
            replacement.scripts,
            replacement.sessionFactory,
        );
    await newOwner.start();
    f.callbacks.get('Debugger.getScriptSource')![0](Error('stale duplicate'));
    assert.equal(newOwner.snapshot().primaryFailure, false);
    await newOwner.finish();
});
test('disable acknowledgement precedes observer retirement and disconnection', async () => {
    const f = setup();
    f.controls.holdDisable = true;
    const o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
    await o.start();
    const close = o.finish();
    await pulse();
    assert.equal(o.snapshot().observerRetired, false);
    assert.equal(f.events.includes('disconnect'), false);
    f.callbacks.get('Debugger.disable')![0](null, {});
    await close;
    assert.equal(o.snapshot().observerRetired, true);
});
test('post throw retains uncertain callback custody rather than disconnecting it away', async () => {
    const f = setup();
    f.controls.throwMethod = 'Debugger.enable';
    f.controls.failure = Error('uncertain dispatch');
    const o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
    await assert.rejects(o.start());
    void o.finish();
    await pulse();
    assert.equal(o.snapshot().pendingCallbacks, 1);
    assert.equal(o.snapshot().acquisitionHeld, true);
    assert.equal(f.events.includes('disconnect'), false);
});
for (const kind of ['connect', 'registration', 'dispatch'])
    test('unsupported asynchronous inspector ' + kind + ' remains held', async () => {
        const f = setup(),
            held = deferred();
        if (kind === 'connect') (f.session as any).connect = () => held.promise;
        if (kind === 'registration') (f.session as any).on = () => held.promise;
        if (kind === 'dispatch') {
            const post = f.session.post.bind(f.session);
            (f.session as any).post = (...args: [string, any, Function]) => {
                post(...args);
                return held.promise;
            };
        }
        const o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
        await assert.rejects(o.start());
        await assert.rejects(o.finish());
        assert.ok(o.snapshot().unknownOperations > 0);
        assert.equal(o.snapshot().acquisitionHeld, true);
        assert.equal(o.snapshot().observerRetired, false);
        assert.equal(f.events.includes('disconnect'), false);
    });
for (const kind of ['off', 'disconnect'])
    test('unacknowledged ' + kind + ' remains owned', async () => {
        const f = setup();
        f.controls[kind + 'Error'] = Error('authored cleanup failure');
        const o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
        await o.start();
        await assert.rejects(o.finish());
        assert.equal(o.snapshot().observerRetired, false);
        assert.equal(o.snapshot().acquisitionHeld, true);
    });
test('primary source error survives a separate disable cleanup error', async () => {
    const f = setup(),
        first = Error('authored primary'),
        second = Error('authored cleanup');
    f.controls.sourceError = first;
    f.controls.disableError = second;
    const o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
    await assert.rejects(o.start());
    await assert.rejects(o.finish(), (e: any) => e.cause === first);
    assert.ok(o.diagnostics().includes(second));
    assert.equal(o.snapshot().observerRetired, false);
});
test('duplicate script identity and late live edit invalidate collection', async () => {
    const f = setup(),
        o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
    await o.start();
    f.session.emit('Debugger.scriptParsed', {
        params: { scriptId: '1', url: pathToFileURL(f.path).href },
    });
    await assert.rejects(o.finish());
    assert.equal(o.snapshot().primaryFailure, true);
});
for (const when of ['pending-finish', 'retired'])
    test('observer finish fences ' + when + ' start before any acquisition', async () => {
        const f = setup(),
            o = createCompiledSourceObserver(f.selected, f.scripts, f.sessionFactory);
        const close = o.finish();
        if (when === 'retired') await assert.rejects(close);
        assert.throws(() => o.start());
        assert.equal(f.acquired, 0);
        if (when === 'pending-finish') await assert.rejects(close);
        assert.equal(o.snapshot().acquisitionHeld, false);
        assert.equal(f.events.length, 0);
    });
test('bootstrap closes actual supplied owner then retires observer, while OS and shipping gates stay unproved', async () => {
    const f = setup(),
        o = createInstrumentedGatewayBootstrap(f.selected, f.scripts, f.sessionFactory, f.factory);
    const config = { token: 'synthetic-only', nested: { value: 1 } };
    const start = o.start(config);
    config.nested.value = 2;
    await start;
    assert.equal(f.accepted.nested.value, 1);
    assert.equal(f.products, 1);
    assert.equal((await o.listen()).host, '127.0.0.1');
    assert.equal(o.sample().cleanupTimers, 1);
    const out = await o.close();
    assert.equal((await o.retirement).phase, 'local-owners-closed');
    assert.equal(out.sha256, hash(out.bytes));
    assert.deepEqual(JSON.parse(out.bytes.toString()), out.record);
    assert.equal(out.record.instrumented, true);
    assert.equal(out.record.productCloseAcknowledged, true);
    assert.equal(out.record.productCountersAfterClose.cleanupTimers, 0);
    assert.equal(out.record.processGroupRetirement, null);
    assert.equal(out.record.shippedCLIBehavior, null);
    assert.equal(out.record.shippingPerformance, null);
    assert.equal(out.record.shippingGC, null);
    assert.equal(out.record.releaseAcceptance, false);
    assert.equal(out.record.buildProvenanceVerified, false);
    assert.equal(f.closes, 1);
    assert.equal(o.close(), o.close());
    assert.ok(f.events.indexOf('product.close') < f.events.indexOf('Debugger.disable'));
    assert.throws(() => o.start({}));
});
test('pending product close preserves custody and does not disconnect its observer early', async () => {
    const f = setup();
    f.controls.closeImmediate = false;
    const o = createInstrumentedGatewayBootstrap(
        f.selected,
        f.scripts,
        f.sessionFactory,
        f.factory,
    );
    await o.start({});
    const close = o.close();
    await pulse();
    assert.equal(o.snapshot().productHeld, true);
    assert.equal(f.events.includes('Debugger.disable'), false);
    f.close.resolve();
    await close;
    assert.equal(o.snapshot().localRetirementAcknowledged, true);
});
for (const kind of ['reject', 'nonzero', 'snapshot'])
    test('product ' + kind + ' cannot yield a closed ownership record', async () => {
        const f = setup();
        const failure = Error('authored product close failure');
        const o = createInstrumentedGatewayBootstrap(
            f.selected,
            f.scripts,
            f.sessionFactory,
            f.factory,
        );
        await o.start({});
        if (kind === 'reject') f.controls.closeError = failure;
        if (kind === 'nonzero') f.controls.nonzero = true;
        if (kind === 'snapshot') f.controls.snapshotError = failure;
        await assert.rejects(o.close());
        assert.equal(o.snapshot().productHeld, true);
        assert.equal(o.snapshot().localRetirementAcknowledged, false);
        assert.equal(f.events.includes('disconnect'), false);
    });
test('unknown factory rejection retains acquisition custody and prevents retirement', async () => {
    const f = setup();
    f.controls.factoryError = Error('factory acquired unknown resource then failed');
    const o = createInstrumentedGatewayBootstrap(
        f.selected,
        f.scripts,
        f.sessionFactory,
        f.factory,
    );
    await assert.rejects(o.start({}));
    await assert.rejects(o.close());
    assert.equal(o.snapshot().factoryHeld, true);
    assert.equal(o.snapshot().localRetirementAcknowledged, false);
});
test('close during observer pre-arm fences later product creation', async () => {
    const f = setup();
    f.controls.holdEnable = true;
    const o = createInstrumentedGatewayBootstrap(
        f.selected,
        f.scripts,
        f.sessionFactory,
        f.factory,
    );
    const start = o.start({});
    const close = o.close();
    await pulse();
    f.callbacks.get('Debugger.enable')![0](null, {});
    await assert.rejects(start);
    await assert.rejects(close);
    assert.equal(f.products, 0);
    assert.equal(o.snapshot().loader.observerRetired, true);
    assert.equal(o.snapshot().localRetirementAcknowledged, true);
});
test('close joins in-flight bind acknowledgement before asking product to close', async () => {
    const f = setup();
    f.controls.holdListen = true;
    const o = createInstrumentedGatewayBootstrap(
        f.selected,
        f.scripts,
        f.sessionFactory,
        f.factory,
    );
    await o.start({});
    const listen = o.listen();
    const close = o.close();
    await pulse();
    assert.equal(f.closes, 0);
    f.product.serverListening = true;
    f.server.emit('listening');
    await listen;
    await close;
    assert.equal(f.closes, 1);
    assert.equal(o.snapshot().localRetirementAcknowledged, true);
});
test('bind error is preserved and known product/observer cleanup can still acknowledge retirement', async () => {
    const f = setup();
    f.controls.holdListen = true;
    const o = createInstrumentedGatewayBootstrap(
        f.selected,
        f.scripts,
        f.sessionFactory,
        f.factory,
    );
    await o.start({});
    const listen = o.listen();
    const error = Error('authored bind failure');
    f.server.emit('error', error);
    await assert.rejects(listen);
    await assert.rejects(o.close(), (e: any) => e.cause === error);
    assert.equal(o.snapshot().localRetirementAcknowledged, true);
    assert.equal(o.snapshot().primaryFailure, true);
});
test('server listener removal failure remains owned after product close', async () => {
    const f = setup(),
        o = createInstrumentedGatewayBootstrap(f.selected, f.scripts, f.sessionFactory, f.factory);
    await o.start({});
    await o.listen();
    f.controls.serverOffError = Error('authored off failure');
    await assert.rejects(o.close());
    assert.equal(o.snapshot().serverListenerHeld, true);
    assert.equal(o.snapshot().localRetirementAcknowledged, false);
});
for (const kind of ['registration', 'bind'])
    test('unsupported asynchronous server ' + kind + ' cannot retire known owners', async () => {
        const f = setup(),
            held = deferred();
        const o = createInstrumentedGatewayBootstrap(
            f.selected,
            f.scripts,
            f.sessionFactory,
            f.factory,
        );
        await o.start({});
        if (kind === 'registration') f.server.on = () => held.promise;
        else f.server.listen = () => held.promise;
        const listen = o.listen();
        await assert.rejects(listen);
        if (kind === 'bind') {
            f.product.serverListening = true;
            f.server.emit('listening');
        }
        await assert.rejects(o.close());
        assert.ok(o.snapshot().unknownServerOperations > 0);
        assert.equal(o.snapshot().localRetirementAcknowledged, false);
        assert.equal(o.snapshot().productHeld, true);
        assert.equal(f.closes, 0);
    });
test('actual non-shipping entry has no top-level execution and exposes only owned in-process inspector startup', async () => {
    const f = setup();
    let constructed = 0,
        external = false;
    const source = readFileSync(
        new URL('./fixtures/instrumented-gateway-entry.ts', import.meta.url),
        'utf8',
    );
    const code = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: any = {};
    const module = { exports };
    const req = (name: string) => {
        if (name === 'node:inspector')
            return {
                url: () => (external ? 'forbidden-external-endpoint' : undefined),
                Session: class {
                    constructor() {
                        constructed++;
                        return f.session;
                    }
                },
            };
        if (name === '../../gateway/server') return { createGateway: f.factory };
        if (name === '../../scripts/lib/instrumented-gateway-observer.mjs')
            return { createInstrumentedGatewayBootstrap };
        assert.fail('Unadmitted entry import');
    };
    new Function('require', 'module', 'exports', code)(req, module, exports);
    assert.equal(constructed, 0);
    assert.equal(f.products, 0);
    const owner = module.exports.prepareInstrumentedGateway(f.selected, f.scripts);
    assert.equal(constructed, 0);
    await owner.start({});
    await owner.close();
    assert.equal(constructed, 1);
    external = true;
    const blocked = module.exports.prepareInstrumentedGateway(f.selected, f.scripts);
    await assert.rejects(blocked.start({}));
    assert.equal(constructed, 1);
    assert.equal(blocked.snapshot().loader.acquisitionHeld, true);
});
for (const kind of ['factory', 'connect', 'registration', 'dispatch', 'off', 'disconnect'])
    test(
        'unsupported rejected inspector ' + kind + ' is observed without retiring custody',
        async () => {
            const f = setup(),
                error = Error('authored unsupported async rejection');
            const factory = kind === 'factory' ? () => Promise.reject(error) : f.sessionFactory;
            const o = createCompiledSourceObserver(f.selected, f.scripts, factory);
            const replace = () => {
                if (kind === 'connect') (f.session as any).connect = () => Promise.reject(error);
                if (kind === 'registration') (f.session as any).on = () => Promise.reject(error);
                if (kind === 'dispatch') {
                    const post = f.session.post.bind(f.session);
                    (f.session as any).post = (...a: [string, any, Function]) => {
                        post(...a);
                        return Promise.reject(error);
                    };
                }
                if (kind === 'off') (f.session as any).off = () => Promise.reject(error);
                if (kind === 'disconnect')
                    (f.session as any).disconnect = () => Promise.reject(error);
            };
            if (kind === 'off' || kind === 'disconnect') {
                await o.start();
                replace();
            } else {
                replace();
                await assert.rejects(o.start());
            }
            await assert.rejects(o.finish());
            await pulse();
            assert.ok(o.failure() === error || o.diagnostics().includes(error));
            assert.equal(o.snapshot().observerRetired, false);
            assert.equal(o.snapshot().acquisitionHeld, true);
        },
    );
for (const kind of ['factory', 'registration', 'bind', 'off'])
    test(
        'unsupported rejected product/server ' + kind + ' is contained and stays owned',
        async () => {
            const f = setup(),
                error = Error('authored unsupported product async rejection');
            const factory = kind === 'factory' ? () => Promise.reject(error) : f.factory;
            const o = createInstrumentedGatewayBootstrap(
                f.selected,
                f.scripts,
                f.sessionFactory,
                factory,
            );
            let failure: any;
            if (kind === 'factory') {
                await assert.rejects(o.start({}));
            } else {
                await o.start({});
                if (kind === 'registration') f.server.on = () => Promise.reject(error);
                if (kind === 'bind') f.server.listen = () => Promise.reject(error);
                if (kind === 'off') {
                    await o.listen();
                    f.server.off = () => Promise.reject(error);
                } else await assert.rejects(o.listen());
            }
            try {
                await o.close();
                assert.fail('Must remain held');
            } catch (e) {
                failure = e;
            }
            await pulse();
            assert.ok(failure.cause === error || o.diagnostics().includes(error));
            assert.equal(o.snapshot().localRetirementAcknowledged, false);
            assert.equal(o.snapshot().productHeld || o.snapshot().factoryHeld, true);
        },
    );

test('a missing replayed entry reports the exact fixed predicate while still failing admission',async()=>{
    const f=setup();f.controls.missing=true;const o=createCompiledSourceObserver(f.selected,f.scripts,()=>f.session);
    await assert.rejects(o.start());await assert.rejects(o.finish());await o.retirement;
    assert.equal(o.snapshot().failureCode,'entry-missing');assert.equal(o.snapshot().observerRetired,true);
});

test('pending callback overflow has its own fixed code rather than a script-length attribution',async()=>{
    const f=setup();f.controls.holdSource=true;const o=createCompiledSourceObserver(f.selected,f.scripts,()=>f.session),task=o.start(),rejected=assert.rejects(task);await pulse();
    for(let i=2;i<18;i++)f.session.emit('Debugger.scriptParsed',{params:{scriptId:String(i),url:pathToFileURL(f.selected.artifactPath).href,length:f.bytes.toString().length}});
    assert.equal(o.snapshot().failureCode,'inspector-pending-bound');assert.equal(o.snapshot().pendingCallbacks,16);
    for(const cb of f.callbacks.get('Debugger.getScriptSource')??[])cb(null,{scriptSource:f.bytes.toString()});await rejected;await assert.rejects(o.finish());await o.retirement;
    assert.equal(o.snapshot().observerRetired,true);assert.equal(o.snapshot().failureCode,'inspector-pending-bound');
});
