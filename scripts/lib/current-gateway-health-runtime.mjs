import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startDiagnosticGatewayRuntime } from './diagnostic-gateway-runtime.mjs';

const retained = new Set();
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};

/** Same installed-byte observer, one actual CLI and an unused loopback SSH target.
 * The target key/token stay in RAM. No SSH client, authentication or session is started.
 * The caller supplies its physical ports only after canonical source/install admission.
 * Memory controls exercise these calls; they do not admit native or release evidence. */
export function startCurrentGatewayHealthRuntime(selection, supplied) {
    assert.deepEqual(Object.keys(selection).sort(), ['nodePath', 'observer', 'root', 'version']);
    const selected = Object.freeze({
        root: selection.root,
        nodePath: selection.nodePath,
        version: selection.version,
        observer: selection.observer,
    });
    assert.equal(typeof selected.observer.observeChild, 'function');
    assert.equal(selected.version, '0.6.0');
    for (const value of [selected.root, selected.nodePath])
        assert.ok(
            typeof value === 'string' && value.startsWith('/') && !/[\\\x00-\x20\x7f]/.test(value),
        );
    const ports = Object.freeze({ ...supplied });
    for (const name of [
        'loadSSH2',
        'keyPair',
        'randomBytes',
        'launch',
        'request',
        'now',
        'setTimer',
        'clearTimer',
    ])
        assert.equal(typeof ports[name], 'function');
    const result = deferred(),
        closed = deferred(),
        listeners = [],
        timers = new Set();
    const state = {
        phase: 'installed-module-load',
        failed: false,
        first: undefined,
        pending: 0,
        failures: 0,
        server: null,
        runtime: null,
        runtimeClosed: false,
        listening: false,
        closeSubmitted: false,
        closeAck: false,
        closeEvent: false,
        listenSubmitted: false,
        listenAck: false,
        querySubmitted: false,
        queryAck: false,
        connections: null,
        sshConnections: 0,
        unknown: [],
        retired: false,
    };
    const owner = Object.freeze({
        result: result.promise,
        closed: closed.promise,
        snapshot: () =>
            Object.freeze({
                phase: state.phase,
                failed: state.failed,
                pending: state.pending,
                runtime: state.runtime?.snapshot() ?? null,
                runtimeClosed: state.runtimeClosed,
                listening: state.listening,
                closeSubmitted: state.closeSubmitted,
                closeAck: state.closeAck,
                closeEvent: state.closeEvent,
                querySubmitted: state.querySubmitted,
                queryAck: state.queryAck,
                connections: state.connections,
                sshConnections: state.sshConnections,
                listeners: listeners.length,
                timers: timers.size,
                unknownOperations: state.unknown.length,
                retired: state.retired,
                loadedCodeIdentity: null,
                descendantRetirement: null,
                releaseAcceptance: false,
            }),
    });
    retained.add(owner); // Before key/module/server acquisition; raw falsey failures remain owned.
    function fail(value) {
        state.failures++;
        if (!state.failed) {
            state.failed = true;
            state.first = value;
        }
        result.reject(
            Object.assign(
                Error('Canonical Gateway runtime failed; uncertain custody retained.', {
                    cause: state.first,
                }),
                { owner },
            ),
        );
    }
    function gate() {
        if (state.failed) throw state.first;
    }
    function invalidCallback(reason) {
        state.unknown.push({ reason });
        fail(Error(reason));
    }
    function sync(value, expected) {
        if (value === expected) return;
        state.unknown.push(value);
        if (typeof value?.then === 'function') Promise.resolve(value).catch(() => {});
        throw Error('Unacknowledged synchronous target operation.');
    }
    function on(emitter, event, callback) {
        listeners.push({ emitter, event, callback });
        sync(emitter.on(event, callback), emitter);
    }
    async function wait(operation, maximum) {
        // Adopt an already-issued operation before even timer acquisition can fail.
        let settled = false;
        state.pending++;
        const original = Promise.resolve(operation).then(
            (value) => {
                settled = true;
                state.pending--;
                return value;
            },
            (error) => {
                settled = true;
                state.pending--;
                fail(error);
                throw error;
            },
        );
        original.catch(() => {});
        const limit = deferred(),
            lease = { handle: undefined };
        timers.add(lease);
        lease.handle = ports.setTimer(() => {
            const error = Error('Canonical runtime target deadline exceeded.');
            fail(error);
            limit.reject(error);
        }, maximum);
        if (lease.handle === undefined || typeof lease.handle?.then === 'function') {
            state.unknown.push(lease.handle);
            if (typeof lease.handle?.then === 'function')
                Promise.resolve(lease.handle).catch(() => {});
            throw Error('Unacknowledged target timer.');
        }
        try {
            return await Promise.race([original, limit.promise]);
        } finally {
            // Timeout never retires the still-pending original operation.
            if (settled) {
                sync(ports.clearTimer(lease.handle), undefined);
                timers.delete(lease);
            }
        }
    }
    const listenerStopped = deferred();
    async function normalTargetClose() {
        assert.ok(state.runtimeClosed && state.listening && !state.querySubmitted);
        assert.equal(state.sshConnections + state.unknown.length + state.pending, 0);
        const before = state.failures,
            server = state.server,
            queried = deferred();
        state.phase = 'unused-target-normal-close';
        state.querySubmitted = true; // One query and one normal close; never retry uncertain effects.
        sync(
            server.getConnections((error, count) => {
                if (!state.querySubmitted || state.queryAck) {
                    invalidCallback('Duplicate or unissued target query acknowledgement.');
                    return;
                }
                state.queryAck = true;
                state.connections = count;
                if (error) {
                    fail(error);
                    queried.reject(error);
                } else if (!Number.isSafeInteger(count) || count < 0) {
                    const value = Error('Unsupported target connection count.');
                    fail(value);
                    queried.reject(value);
                } else queried.resolve(count);
            }),
            server,
        );
        assert.equal(await wait(queried.promise, 5000), 0);
        assert.equal(state.failures, before);
        assert.equal(state.sshConnections, 0);
        state.closeSubmitted = true;
        sync(
            server.close((error) => {
                if (!state.closeSubmitted || state.closeAck) {
                    invalidCallback('Duplicate or unissued target close acknowledgement.');
                    return;
                }
                state.closeAck = true;
                if (error) {
                    fail(error);
                    listenerStopped.reject(error);
                } else if (state.closeEvent) listenerStopped.resolve();
            }),
            server,
        );
        await wait(listenerStopped.promise, 5000);
        assert.equal(state.failures, before);
        assert.ok(state.closeAck && state.closeEvent && !state.listening);
    }
    function retire() {
        assert.ok(state.runtimeClosed && state.closeAck && state.closeEvent && !state.listening);
        assert.equal(state.pending + state.unknown.length + timers.size, 0);
        for (const row of [...listeners]) {
            sync(row.emitter.off(row.event, row.callback), row.emitter);
            listeners.splice(listeners.indexOf(row), 1);
        }
        state.retired = true;
        state.phase = state.failed
            ? 'failed-direct-close-observed'
            : 'canonical-health-direct-close-observed';
        retained.delete(owner);
        closed.resolve(owner.snapshot());
    }
    void (async () => {
        try {
            const loaded = ports.loadSSH2();
            state.loaded = loaded;
            if (typeof loaded?.then === 'function') {
                state.unknown.push(loaded);
                void Promise.resolve(loaded).then(
                    (late) => state.unknown.push({ late }),
                    () => {},
                );
                throw Error('Unsupported asynchronous module acquisition.');
            }
            assert.ok(loaded);
            assert.equal(typeof loaded.ssh2?.Server, 'function');
            assert.equal(typeof loaded.ssh2?.utils?.parseKey, 'function');
            assert.equal(typeof loaded.initialization?.then, 'function');
            await wait(loaded.initialization, 10000);
            gate();
            state.phase = 'unused-target-key';
            const pair = ports.keyPair();
            state.keyPair = pair;
            if (typeof pair?.then === 'function') {
                state.unknown.push(pair);
                void Promise.resolve(pair).then(
                    (late) => state.unknown.push({ late }),
                    () => {},
                );
                throw Error('Unsupported asynchronous key acquisition.');
            }
            const key = pair.privateKey.export({ type: 'pkcs1', format: 'pem' });
            state.key = key;
            assert.ok(Buffer.isBuffer(key) || typeof key === 'string');
            const parsed = loaded.ssh2.utils.parseKey(key);
            assert.ok(parsed && !(parsed instanceof Error) && !Array.isArray(parsed));
            const fingerprint =
                'SHA256:' +
                createHash('sha256')
                    .update(parsed.getPublicSSH())
                    .digest('base64')
                    .replace(/=+$/, '');
            const tokenBytes = ports.randomBytes(32);
            assert.ok(Buffer.isBuffer(tokenBytes) && tokenBytes.length === 32);
            const token = tokenBytes.toString('hex');
            state.phase = 'unused-target-listen';
            // Capture before binding/listening. No credentials are configured or accepted.
            state.server = new loaded.ssh2.Server({ hostKeys: [key], readyTimeout: 1000 });
            const server = state.server;
            on(server, 'error', (error) => fail(error));
            on(server, 'connection', (client) => {
                state.sshConnections++;
                state.unknown.push(client); // Never destroy or silently discard an unexpected connection.
                fail(Error('No SSH connection is authorized by this health-only runtime.'));
                try {
                    on(client, 'error', (error) => fail(error));
                } catch (error) {
                    fail(error);
                }
            });
            on(server, 'close', () => {
                if (state.closeEvent) {
                    invalidCallback('Duplicate target close event.');
                    return;
                }
                state.closeEvent = true;
                state.listening = false;
                if (!state.closeSubmitted) invalidCallback('Unexpected target listener close.');
                else if (state.closeAck) listenerStopped.resolve();
            });
            const listening = deferred();
            state.listenSubmitted = true;
            sync(
                server.listen(0, '127.0.0.1', () => {
                    if (!state.listenSubmitted || state.listenAck) {
                        invalidCallback('Duplicate or unissued target listen acknowledgement.');
                        return;
                    }
                    state.listenAck = true;
                    state.listening = true;
                    try {
                        const address = server.address();
                        assert.ok(
                            address &&
                                address.address === '127.0.0.1' &&
                                Number.isInteger(address.port) &&
                                address.port > 0 &&
                                address.port <= 65535,
                        );
                        listening.resolve(address.port);
                    } catch (error) {
                        fail(error);
                        listening.reject(error);
                    }
                }),
                server,
            );
            const targetPort = await wait(listening.promise, 10000);
            gate();
            state.phase = 'canonical-cli-health';
            state.runtime = startDiagnosticGatewayRuntime(
                {
                    root: selected.root,
                    nodePath: selected.nodePath,
                    version: selected.version,
                    port: 58731,
                    token,
                    target: { host: '127.0.0.1', port: targetPort, fingerprint },
                },
                { ...ports, observer: selected.observer },
            );
            void state.runtime.closed.then(
                () => {
                    state.runtimeClosed = true;
                },
                (error) => fail(error),
            );
            const value = await state.runtime.result;
            await state.runtime.closed;
            gate();
            await normalTargetClose();
            gate();
            retire();
            result.resolve({
                ...value,
                fixture: Object.freeze({
                    activeTCPConnectionsAtClose: state.connections,
                    observedSSHConnections: 0,
                    rawTCPAcceptsObserved: null,
                    normalListenerCloseAcknowledged: state.closeAck && state.closeEvent,
                    privateKeyPersisted: false,
                    tokenPersisted: false,
                    ssh2InternalRetirement: null,
                    descendantRetirement: null,
                    releaseAcceptance: false,
                }),
            });
        } catch (error) {
            fail(error);
            // A failed result stays failed. Only an independently joined existing runtime
            // permits the same unused listener's single normal close; no process cleanup.
            try {
                if (state.runtime) await state.runtime.closed;
                if (
                    state.runtimeClosed &&
                    state.listening &&
                    !state.querySubmitted &&
                    state.sshConnections + state.unknown.length + state.pending + timers.size === 0
                )
                    await normalTargetClose();
                if (
                    state.runtimeClosed &&
                    state.closeAck &&
                    state.closeEvent &&
                    state.pending + state.unknown.length + timers.size === 0
                )
                    retire();
            } catch (secondary) {
                fail(secondary);
            }
        }
    })();
    return owner;
}
