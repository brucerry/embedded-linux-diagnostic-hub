import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const hash = (b) => createHash('sha256').update(b).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
// Unsupported thenables are observed for rejection but never treated as retired.
function retainUnknown(value, held, fail) {
    held.add(value);
    try {
        const then = value?.then;
        if (typeof then === 'function') {
            const watched = then.call(value, () => {}, fail);
            if (watched instanceof Promise) Promise.prototype.then.call(watched, undefined, fail);
        }
    } catch (error) {
        fail(error);
    }
}
function binding(value) {
    assert.deepEqual(Object.keys(value).sort(), [
        'artifactPath',
        'artifactSHA256',
        'observerSHA256',
        'sourceCommit',
        'sourceTree',
    ]);
    for (const p of ['sourceCommit', 'sourceTree']) assert.match(value[p], /^[a-f0-9]{40}$/);
    for (const p of ['artifactSHA256', 'observerSHA256']) assert.match(value[p], /^[a-f0-9]{64}$/);
    assert.ok(
        typeof value.artifactPath === 'string' &&
            value.artifactPath.startsWith('/') &&
            value.artifactPath.length <= 4096 &&
            path.posix.normalize(value.artifactPath) === value.artifactPath &&
            !/[\\\x00-\x1f\x7f]/.test(value.artifactPath),
    );
    return Object.freeze({ ...value });
}
export class InstrumentedGatewayFailure extends Error {
    constructor(cause, owner) {
        super('Instrumented Gateway observation failed; inspect retained custody.', { cause });
        this.owner = owner;
    }
}
/** Actual inspector callback collector, with no native/session/process defaults or TCP API.
 * Selection is an independently admitted input, not build/service provenance supplied by this module.
 */
export function createCompiledSourceObserver(input, scripts, sessionFactory) {
    const selected = binding(input),
        expected = new Map();
    assert.ok(scripts instanceof Map && scripts.size > 0 && scripts.size <= 512);
    let expectedBytes = 0;
    for (const [filename, content] of scripts) {
        assert.ok(
            typeof filename === 'string' &&
                filename.startsWith('/') &&
                filename.length <= 4096 &&
                path.posix.normalize(filename) === filename &&
                !/[\\\x00-\x1f\x7f]/.test(filename),
        );
        const url = pathToFileURL(filename).href;
        assert.equal(
            new URL(url).pathname.split('/').some((p) => p === '.' || p === '..'),
            false,
        );
        assert.ok(Buffer.isBuffer(content) && content.length <= 32 * 1024 ** 2);
        expectedBytes += content.length;
        assert.ok(expectedBytes <= 64 * 1024 ** 2);
        const bytes = Buffer.from(content),
            text = decoder.decode(bytes);
        assert.ok(Buffer.from(text).equals(bytes));
        expected.set(url, { path: filename, bytes: bytes.length, text, sha256: hash(bytes) });
    }
    assert.equal(
        expected.get(pathToFileURL(selected.artifactPath).href)?.sha256,
        selected.artifactSHA256,
    );
    assert.equal(typeof sessionFactory, 'function');
    let session,
        acquisition = false,
        connected = false,
        registration = false,
        started,
        finishing,
        sealed = false,
        retired = false,
        primary,
        events = 0,
        builtinScripts = 0,
        unknownOperations = 0;
    const pending = new Set(),
        waiters = [],
        ids = new Set(),
        observed = [],
        retirement = deferred(),
        diagnostics = [],
        unknownReturns = new Set();
    const fail = (error) => {
        if (primary && error !== primary && !diagnostics.includes(error) && diagnostics.length < 16)
            diagnostics.push(error);
        primary ??= error;
    };
    const sync = (actual, expected, operation) => {
        if (actual !== expected) {
            unknownOperations++;
            retainUnknown(actual, unknownReturns, fail);
            throw Error('Unsupported inspector ' + operation + ' lifetime.');
        }
    };
    const snapshot = () =>
        Object.freeze({
            acquisitionHeld: acquisition,
            connected,
            listenerHeld: registration,
            pendingCallbacks: pending.size,
            compiledScripts: observed.length,
            primaryFailure: Boolean(primary),
            observerRetired: retired,
            cleanupDiagnostics: diagnostics.length,
            unknownOperations,
            processGroupRetirement: null,
        });
    const drain = () =>
        pending.size ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve();
    function post(method, params) {
        assert.ok(pending.size < 16, 'Inspector pending-callback bound exceeded.');
        const lease = {},
            result = deferred();
        pending.add(lease);
        const done = (error, value) => {
            if (!pending.has(lease)) {
                if (!retired) fail(Error('Duplicate inspector callback.'));
                return;
            }
            pending.delete(lease);
            if (error) {
                fail(error);
                result.reject(error);
            } else result.resolve(value);
            if (!pending.size) for (const resolve of waiters.splice(0)) resolve();
        };
        try {
            sync(session.post(method, params, done), undefined, 'dispatch');
        } catch (error) {
            fail(error);
            result.reject(error);
            // Throw after dispatch is not acknowledgement. Keep the lease unless callback acknowledged it.
        }
        return result.promise;
    }
    function parsed(message) {
        if (retired) return; // A stale callback cannot mutate a later session or completed receipt.
        try {
            assert.ok(!sealed && ++events <= 2048, 'Late/overflow inspector observation.');
            const p = message?.params;
            assert.ok(
                p &&
                    typeof p.url === 'string' &&
                    p.url.length <= 8192 &&
                    !p.isLiveEdit &&
                    !p.hasSourceURL,
            );
            assert.ok(
                typeof p.scriptId === 'string' &&
                    p.scriptId.length > 0 &&
                    p.scriptId.length <= 64 &&
                    !ids.has(p.scriptId),
            );
            ids.add(p.scriptId);
            if (p.url.startsWith('node:')) {
                builtinScripts++;
                return;
            }
            const wanted = expected.get(p.url);
            assert.ok(wanted, 'Unadmitted compiled script.');
            if (p.length !== undefined) assert.equal(p.length, wanted.text.length);
            void post('Debugger.getScriptSource', { scriptId: p.scriptId })
                .then((result) => {
                    assert.ok(result && typeof result.scriptSource === 'string');
                    assert.ok(
                        result.scriptSource === wanted.text,
                        'Actual compiled source differs from admitted bytes.',
                    );
                    observed.push({
                        path: wanted.path,
                        bytes: wanted.bytes,
                        sha256: wanted.sha256,
                    });
                })
                .catch(fail);
        } catch (error) {
            fail(error);
        }
    }
    const owner = Object.freeze({
        snapshot,
        failure: () => primary,
        diagnostics: () => Object.freeze([...diagnostics]),
        retirement: retirement.promise,
        start() {
            assert.ok(!sealed && !finishing && !retired, 'Observer admission is closed.');
            if (started) return started;
            started = (async () => {
                acquisition = true;
                session = sessionFactory();
                if (
                    !session ||
                    !['connect', 'disconnect', 'post', 'on', 'off'].every(
                        (k) => typeof session[k] === 'function',
                    )
                ) {
                    unknownOperations++;
                    retainUnknown(session, unknownReturns, fail);
                    throw Error('Unsupported inspector factory result.');
                }
                registration = true;
                sync(session.on('Debugger.scriptParsed', parsed), session, 'registration');
                sync(session.connect(), undefined, 'connect');
                connected = true;
                await post('Debugger.enable', {});
                await drain();
                assert.ok(
                    observed.some((r) => r.path === selected.artifactPath),
                    'Instrumented entry was not observed compiled.',
                );
                if (primary) throw primary;
            })().catch((error) => {
                fail(error);
                throw new InstrumentedGatewayFailure(primary, owner);
            });
            started.catch(() => {});
            return started;
        },
        finish() {
            if (finishing) return finishing;
            sealed = true;
            finishing = (async () => {
                if (started) await started.catch(() => {});
                await drain();
                assert.equal(unknownOperations, 0, 'Unknown inspector operation remains held.');
                // Disable is acknowledged before removing the owned listener or disconnecting.
                if (session && connected) await post('Debugger.disable', {});
                if (registration) {
                    sync(session.off('Debugger.scriptParsed', parsed), session, 'removal');
                    registration = false;
                }
                if (session) {
                    sync(session.disconnect(), undefined, 'disconnect');
                    connected = false;
                    acquisition = false;
                }
                assert.ok(!acquisition && !registration && !pending.size);
                if (!observed.some((r) => r.path === selected.artifactPath))
                    fail(Error('Instrumented entry was not observed compiled.'));
                expected.clear();
                retired = true;
                retirement.resolve(snapshot());
                if (primary) throw primary;
                return {
                    selected: { ...selected },
                    compiledScripts: observed.map((r) => ({ ...r })),
                    builtinScripts,
                    observation: 'inspector-returned-exact-script-source',
                    builtinIdentityVerified: false,
                    executedWorkloadCoverage: null,
                    kernelExecutableMapping: null,
                    observerRetired: true,
                };
            })().catch((error) => {
                fail(error);
                throw new InstrumentedGatewayFailure(primary, owner);
            });
            finishing.catch(() => {});
            return finishing;
        },
    });
    return owner;
}
const counters = [
    'cleanupTimers',
    'requestTasks',
    'httpSockets',
    'httpResponses',
    'httpBodyReaders',
    'pendingConnections',
    'sessions',
    'inFlight',
    'ownedSessions',
    'retiringSessions',
    'connectionAttempts',
    'cancelledAttemptCache',
];
function productSnapshot(gateway, closed = false) {
    const actual = gateway.ownershipSnapshot;
    assert.ok(
        actual &&
            typeof actual.stopping === 'boolean' &&
            typeof actual.serverListening === 'boolean',
    );
    /** @type {Record<string, boolean | number>} */
    const result = { stopping: actual.stopping, serverListening: actual.serverListening };
    for (const key of counters) {
        assert.ok(Number.isSafeInteger(actual[key]) && actual[key] >= 0);
        result[key] = actual[key];
    }
    for (const key of ['sessionOwners', 'allSessionOwners']) {
        assert.ok(Array.isArray(actual[key]));
        result[key] = actual[key].length;
    }
    if (closed) {
        assert.equal(result.stopping, true);
        assert.equal(result.serverListening, false);
        for (const key of [...counters, 'sessionOwners', 'allSessionOwners'])
            assert.equal(result[key], 0, 'Product cleanup remains owned: ' + key);
    }
    return result;
}
/** Non-shipping bootstrap for actual createGateway, with no server/process defaults.
 * It does not replace or qualify the shipped CLI, and never proves OS process retirement.
 */
export function createInstrumentedGatewayBootstrap(input, scripts, sessionFactory, createGateway) {
    const selected = binding(input),
        loader = createCompiledSourceObserver(selected, scripts, sessionFactory);
    assert.equal(typeof createGateway, 'function');
    let startTask,
        closeTask,
        gateway,
        factoryHeld = false,
        admissionClosed = false,
        primary,
        phase = 'prepared',
        listenTask,
        listenerHeld = false,
        afterClose,
        unknownServerOperations = 0;
    const retirement = deferred(),
        diagnostics = [],
        unknownReturns = new Set();
    const fail = (error) => {
        if (primary && error !== primary && !diagnostics.includes(error) && diagnostics.length < 16)
            diagnostics.push(error);
        primary ??= error;
        phase = 'failed';
    };
    const sync = (actual, expected, operation) => {
        if (actual !== expected) {
            unknownServerOperations++;
            retainUnknown(actual, unknownReturns, fail);
            throw Error('Unsupported server ' + operation + ' lifetime.');
        }
    };
    const snapshot = () =>
        Object.freeze({
            phase,
            factoryHeld,
            productHeld: Boolean(gateway),
            serverListenerHeld: listenerHeld,
            loader: loader.snapshot(),
            primaryFailure: Boolean(primary),
            localRetirementAcknowledged: Boolean(afterClose),
            cleanupDiagnostics: diagnostics.length,
            unknownServerOperations,
            processGroupRetirement: null,
            releaseAcceptance: false,
        });
    let onError, onListening;
    function detach() {
        if (!listenerHeld) return;
        sync(gateway.server.off('error', onError), gateway.server, 'removal');
        sync(gateway.server.off('listening', onListening), gateway.server, 'removal');
        listenerHeld = false;
    }
    const owner = Object.freeze({
        snapshot,
        diagnostics: () => Object.freeze([...diagnostics]),
        retirement: retirement.promise,
        start(config) {
            assert.ok(!admissionClosed);
            if (startTask) return startTask;
            const configSnapshot = structuredClone(config);
            phase = 'starting';
            startTask = (async () => {
                await loader.start();
                assert.ok(!admissionClosed, 'Bootstrap closed before product acquisition.');
                factoryHeld = true;
                gateway = createGateway(configSnapshot);
                if (!gateway || typeof gateway.close !== 'function' || !gateway.server) {
                    retainUnknown(gateway, unknownReturns, fail);
                    throw Error('Unsupported product factory result.');
                }
                factoryHeld = false;
                productSnapshot(gateway);
                phase = 'active';
                return owner;
            })().catch((error) => {
                fail(error);
                throw new InstrumentedGatewayFailure(primary, owner);
            });
            startTask.catch(() => {});
            return startTask;
        },
        listen(port = 0) {
            assert.ok(gateway && phase === 'active' && !admissionClosed && !listenTask);
            assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535);
            const result = deferred();
            listenTask = result.promise;
            listenerHeld = true;
            onError = (error) => {
                if (afterClose) return;
                fail(error);
                result.reject(new InstrumentedGatewayFailure(primary, owner));
            };
            onListening = () => {
                if (afterClose) return;
                try {
                    const address = gateway.server.address();
                    assert.ok(
                        address &&
                            address.address === '127.0.0.1' &&
                            Number.isInteger(address.port) &&
                            address.port > 0 &&
                            address.port <= 65535,
                    );
                    result.resolve({ host: '127.0.0.1', port: address.port });
                } catch (error) {
                    onError(error);
                }
            };
            try {
                for (const [event, callback] of [
                    ['error', onError],
                    ['listening', onListening],
                ]) {
                    sync(gateway.server.on(event, callback), gateway.server, 'registration');
                }
                sync(gateway.server.listen(port, '127.0.0.1'), gateway.server, 'bind');
            } catch (error) {
                onError(error);
            }
            return listenTask;
        },
        sample() {
            assert.ok(gateway && !admissionClosed);
            try {
                return productSnapshot(gateway);
            } catch (error) {
                fail(error);
                throw new InstrumentedGatewayFailure(primary, owner);
            }
        },
        close() {
            if (closeTask) return closeTask;
            admissionClosed = true;
            closeTask = (async () => {
                if (startTask) await startTask.catch(() => {});
                if (listenTask) await listenTask.catch(() => {});
                assert.equal(unknownServerOperations, 0, 'Unknown server operation remains held.');
                assert.ok(!factoryHeld, 'Unknown product factory acquisition remains held.');
                let product;
                if (gateway) {
                    await gateway.close();
                    product = productSnapshot(gateway, true);
                    detach();
                    gateway = undefined;
                }
                let compiled;
                try {
                    compiled = await loader.finish();
                } catch (error) {
                    fail(error);
                    if (!loader.snapshot().observerRetired) throw error;
                }
                afterClose = { product, observerRetired: loader.snapshot().observerRetired };
                if (!primary && !loader.failure()) phase = 'local-owners-closed';
                retirement.resolve(snapshot());
                if (primary || loader.failure()) throw primary ?? loader.failure();
                const record = {
                    schemaVersion: 1,
                    kind: 'instrumented-gateway-ownership-observation',
                    instrumented: true,
                    sourceSelection: { ...selected },
                    compiled,
                    buildProvenanceVerified: false,
                    productCloseAcknowledged: Boolean(product),
                    productCountersAfterClose: product ?? null,
                    localObserverRetirementAcknowledged: true,
                    processGroupRetirement: null,
                    shippedCLIBehavior: null,
                    shippingPerformance: null,
                    shippingGC: null,
                    releaseAcceptance: false,
                };
                const bytes = Buffer.from(JSON.stringify(record) + '\n');
                assert.ok(bytes.length <= 4 * 1024 ** 2);
                return Object.freeze({ record, bytes, sha256: hash(bytes) });
            })().catch((error) => {
                fail(error);
                throw new InstrumentedGatewayFailure(primary, owner);
            });
            closeTask.catch(() => {});
            return closeTask;
        },
    });
    return owner;
}
