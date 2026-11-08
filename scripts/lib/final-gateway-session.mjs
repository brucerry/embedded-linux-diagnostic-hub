import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const GATEWAY_SESSION_BOUNDS = Object.freeze({
    totalMs: 25000,
    cleanupMs: 5000,
    snapshotMs: 15000,
    requestMs: 5000,
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sessionID = (id) => assert.match(id, /^[A-Za-z0-9_-]{32}$/);
const closedKeys = (value, keys) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
function requestPlan(input, role, id) {
    let method = 'POST',
        route,
        body,
        status = 200;
    const base = {
        host: '127.0.0.1',
        port: input.target.port,
        username: input.target.username,
        auth: 'password',
    };
    if (role === 'fingerprint') {
        route = '/api/fingerprint';
        body = base;
    } else if (role === 'connect') {
        route = '/api/sessions';
        status = 201;
        body = {
            ...base,
            password: input.target.password,
            expectedFingerprint: input.target.fingerprint,
            attemptId: input.attemptId,
        };
    } else if (role === 'cancel') {
        route = '/api/connection-attempts/cancel';
        body = { attemptId: input.attemptId };
    } else if (role === 'health') {
        route = '/api/health';
        method = 'GET';
    } else {
        sessionID(id);
        route = '/api/sessions/' + id;
        if (role === 'heartbeat') route += '/heartbeat';
        else if (role === 'snapshot' || role === 'gone') {
            route += '/snapshot';
            if (role === 'gone') status = 404;
        } else {
            assert.equal(role, 'disconnect');
            method = 'DELETE';
        }
    }
    return {
        method,
        path: route,
        status,
        body: body ? Buffer.from(JSON.stringify(body)) : undefined,
        maxBytes: role === 'snapshot' ? 2 * 1024 ** 2 : 4096,
        deadlineMs:
            role === 'snapshot'
                ? GATEWAY_SESSION_BOUNDS.snapshotMs
                : GATEWAY_SESSION_BOUNDS.requestMs,
    };
}

/** Prepare only; no socket, process, fixture factory or timer default. This exact public-API
 * workload is for an independently owned synthetic loopback target and unchanged shipping CLI.
 * The surrounding final-byte observer, service provenance and process custody remain mandatory. */
export function prepareFinalGatewaySession(raw, ports) {
    const input = structuredClone(raw);
    closedKeys(input, ['port', 'token', 'version', 'attemptId', 'target', 'expectedProbes']);
    assert.ok(Number.isInteger(input.port) && input.port >= 1024 && input.port <= 65535);
    assert.match(input.token, /^[a-f0-9]{64}$/);
    assert.match(input.version, /^\d+\.\d+\.\d+$/);
    assert.match(input.attemptId, /^[a-f0-9]{32}$/);
    closedKeys(input.target, ['host', 'port', 'fingerprint', 'username', 'password']);
    assert.equal(input.target.host, '127.0.0.1');
    assert.ok(
        Number.isInteger(input.target.port) &&
            input.target.port >= 1024 &&
            input.target.port <= 65535 &&
            input.target.port !== input.port,
    );
    assert.match(input.target.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.match(input.target.username, /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/);
    assert.ok(
        typeof input.target.password === 'string' &&
            input.target.password.length >= 16 &&
            input.target.password.length <= 128 &&
            !/[\x00-\x1f\x7f]/.test(input.target.password),
    );
    assert.ok(
        Array.isArray(input.expectedProbes) &&
            input.expectedProbes.length > 0 &&
            input.expectedProbes.length <= 128,
    );
    const ids = new Set();
    for (const row of input.expectedProbes) {
        closedKeys(row, ['id', 'status', 'exitCode', 'stdoutSHA256', 'stderrSHA256']);
        assert.match(row.id, /^[a-z][a-z0-9-]{0,63}$/);
        assert.ok(!ids.has(row.id));
        ids.add(row.id);
        assert.ok(['collected', 'unavailable', 'error'].includes(row.status));
        assert.ok(Number.isInteger(row.exitCode) && row.exitCode >= 0 && row.exitCode <= 255);
        for (const key of ['stdoutSHA256', 'stderrSHA256'])
            assert.match(row[key], /^[a-f0-9]{64}$/);
    }
    const selectedPorts = {};
    for (const key of ['request', 'setTimer', 'clearTimer', 'now']) {
        assert.equal(typeof ports[key], 'function');
        selectedPorts[key] = ports[key].bind(ports);
    }
    let used = false;
    return Object.freeze({
        target: Object.freeze({
            host: '127.0.0.1',
            port: input.target.port,
            fingerprint: input.target.fingerprint,
        }),
        start() {
            assert.equal(used, false, 'Gateway session workload is one-use.');
            used = true;
            return startSession(input, Object.freeze(selectedPorts));
        },
    });
}

const workloads = new Set();
function startSession(input, ports) {
    const result = deferred(),
        closed = deferred(),
        exchanges = new Set(),
        checks = [];
    const started = ports.now();
    assert.ok(Number.isFinite(started) && started >= 0);
    let timer,
        timerUnknown = false,
        failed = false,
        cancelRequested = false,
        createSubmitted = false,
        session,
        disconnected = false,
        terminal = false,
        protocolFailure = null,
        observedProjectionSHA256;
    const snapshot = () =>
        Object.freeze({
            failed,
            terminal,
            createSubmitted,
            cancelRequested,
            disconnected,
            requestOwners: exchanges.size,
            timerUnknown,
            checks: checks.length,
            gatewayInternalRetirement: null,
            wholeGroupRetirement: null,
            releaseAcceptance: false,
        });
    const owner = Object.freeze({ result: result.promise, closed: closed.promise, snapshot });
    workloads.add(owner);
    const fail = (reason) => {
        if (terminal) return; // All owners and the timer were acknowledged retired; ignore stale callbacks.
        failed = true;
        protocolFailure ??= Error(reason);
        result.reject(
            Object.assign(
                Error('Gateway session workload failed; custody retained.', {
                    cause: protocolFailure,
                }),
                { owner },
            ),
        );
    };
    function budget() {
        const now = ports.now();
        assert.ok(
            Number.isFinite(now) &&
                now >= started &&
                now - started < GATEWAY_SESSION_BOUNDS.totalMs,
            'Gateway session deadline exceeded.',
        );
        assert.equal(failed, false);
    }
    async function exchange(role, id, cleanup = false) {
        if (!cleanup) budget();
        const lease = { owner: null };
        exchanges.add(lease);
        lease.owner = startExchange(input, ports, role, id);
        const value = await lease.owner.result;
        await lease.owner.closed;
        exchanges.delete(lease);
        const { value: body, ...summary } = value;
        checks.push(summary);
        if (!cleanup) budget();
        return body;
    }
    async function run() {
        try {
            timerUnknown = true; // Capture possible allocation before a thrown/unknown return.
            timer = ports.setTimer(
                () => fail('Gateway session deadline exceeded.'),
                GATEWAY_SESSION_BOUNDS.totalMs,
            );
            if (timer == null || typeof timer?.then === 'function') {
                timerUnknown = true;
                if (typeof timer?.then === 'function') Promise.resolve(timer).catch(() => {});
                throw Error();
            }
            timerUnknown = false;
            const key = await exchange('fingerprint');
            assert.deepEqual(key, { fingerprint: input.target.fingerprint });
            createSubmitted = true; // Before dispatch: a missing reply cannot prove no remote session.
            const created = await exchange('connect');
            closedKeys(created, ['sessionId']);
            sessionID(created.sessionId);
            session = created.sessionId;
            assert.deepEqual(await exchange('heartbeat', session), { connected: true });
            const collected = await exchange('snapshot', session);
            assert.equal(collected.schemaVersion, 1);
            assert.equal(collected.mode, 'ssh');
            assert.ok(
                Array.isArray(collected.results) &&
                    collected.results.length === input.expectedProbes.length,
            );
            const rows = collected.results.map((row) => {
                assert.ok(
                    row &&
                        typeof row.id === 'string' &&
                        typeof row.stdout === 'string' &&
                        typeof row.stderr === 'string',
                );
                assert.equal(row.truncated, false);
                return {
                    id: row.id,
                    status: row.status,
                    exitCode: row.exitCode,
                    stdoutSHA256: hash(row.stdout),
                    stderrSHA256: hash(row.stderr),
                };
            });
            assert.deepEqual(
                rows,
                input.expectedProbes,
                'Shipping Gateway probe results differ from authored expectations.',
            );
            observedProjectionSHA256 = hash(JSON.stringify(rows) + '\n');
            assert.deepEqual(await exchange('disconnect', session), { disconnected: true });
            disconnected = true;
            await exchange('gone', session);
            assert.deepEqual(await exchange('health'), {
                version: input.version,
                activeSessions: 0,
                connectionCancellation: true,
            });
        } catch {
            fail('Gateway public session/collection check failed.');
        } finally {
            if (createSubmitted && !disconnected) {
                cancelRequested = true; // Exactly once, using the public attempt owner even if session ID was lost.
                try {
                    assert.deepEqual(await exchange('cancel', undefined, true), {
                        cancelled: true,
                    });
                } catch {
                    fail('Gateway attempt cancellation unacknowledged.');
                }
            }
            try {
                for (const lease of exchanges) {
                    assert.ok(lease.owner);
                    await lease.owner.closed;
                    exchanges.delete(lease);
                }
                assert.equal(timerUnknown, false);
                timerUnknown = true; // A thrown clear cannot acknowledge timer retirement.
                const cleared = ports.clearTimer(timer);
                if (cleared !== undefined) {
                    timerUnknown = true;
                    if (typeof cleared?.then === 'function')
                        Promise.resolve(cleared).catch(() => {});
                    throw Error('Gateway workload timer retirement unacknowledged.');
                }
                timerUnknown = false;
                const elapsedMs = ports.now() - started;
                assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);
                if (elapsedMs >= GATEWAY_SESSION_BOUNDS.totalMs)
                    fail('Gateway session deadline exceeded.');
                terminal = true;
                workloads.delete(owner);
                closed.resolve(snapshot());
                if (!failed) {
                    const receipt = {
                        kind: 'shipping-gateway-public-session-observation/v1',
                        checks,
                        probeRows: input.expectedProbes.length,
                        expectedProbeProjectionSHA256: hash(
                            JSON.stringify(input.expectedProbes) + '\n',
                        ),
                        observedProbeProjectionSHA256: observedProjectionSHA256,
                        elapsedMs,
                        disconnected: true,
                        sessionGone: true,
                        activeSessionsAfter: 0,
                        requestOwnersRetired: true,
                        wholeGroupRetirement: null,
                        gatewayInternalRetirement: null,
                        authenticatedProducerProvenance: null,
                        releaseAcceptance: false,
                    };
                    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 16384);
                    result.resolve(receipt);
                }
            } catch {
                fail('Gateway session observer retirement unacknowledged.');
            }
        }
    }
    void run();
    return owner;
}

const GATEWAY_HTTP_BOUNDS = Object.freeze({
    deadlineMs: 2000,
    bytes: 2 * 1024 ** 2,
    chunks: 1024,
    headerBytes: 8192,
});
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
const allowedOrigin = 'http://127.0.0.1';

/** One real Node HTTP request through explicit ports. No implicit request/socket/timer, redirects,
 * retries, signals or destruction. The caller owns the exact CLI child and readiness/endpoint trust.
 * On timeout/failure, unresolved request/response/socket custody is retained for caller retirement.
 */
function startExchange(input, ports, role, sessionId) {
    const plan = requestPlan(input, role, sessionId);
    ports = Object.freeze({ ...ports });
    const selected = { ...input, role },
        result = deferred(),
        closed = deferred(),
        listeners = [],
        unknown = new Set();
    const expected = plan.status;
    const started = ports.now();
    assert.ok(Number.isFinite(started) && started >= 0);
    let request,
        response,
        socket,
        timer,
        failure,
        retired = false,
        requestError = false;
    let requestFinished = false,
        requestClosed = false,
        responseEnded = false,
        responseClosed = false,
        socketClosed = false,
        connected = false;
    let responseBytes = 0,
        responseChunks = 0,
        status = null,
        value;
    const chunks = [];
    const snapshot = () =>
        Object.freeze({
            role: selected.role,
            requestAcquired: Boolean(request),
            responseAcquired: Boolean(response),
            socketAcquired: Boolean(socket),
            requestFinished,
            requestClosed,
            responseEnded,
            responseClosed,
            socketClosed,
            connected,
            responseBytes,
            responseChunks,
            listeners: listeners.length,
            unknownOperations: unknown.size,
            failed: Boolean(failure),
            retired,
            wholeGroupRetirement: null,
        });
    const owner = Object.freeze({ result: result.promise, closed: closed.promise, snapshot });
    retained.add(owner);
    function fail(reason) {
        if (retired) return;
        failure ??= new Error(reason); // Fixed diagnostics only; no token, body, URL or native error text.
        result.reject(
            Object.assign(
                new Error('Gateway workload exchange failed; uncertain custody retained.', {
                    cause: failure,
                }),
                { owner },
            ),
        );
    }
    function sync(value, wanted) {
        if (value === wanted) return;
        unknown.add(value);
        try {
            if (typeof value?.then === 'function') Promise.resolve(value).catch(() => {});
        } catch {}
        throw Error('Unsupported asynchronous HTTP port.');
    }
    function on(target, event, callback) {
        listeners.push({ target, event, callback }); // Before registration; an uncertain return stays held.
        sync(target.on(event, callback), target);
    }
    function finish() {
        if (
            retired ||
            !requestClosed ||
            !socketClosed ||
            (response ? !responseClosed : !requestError)
        )
            return;
        if (unknown.size) {
            fail('Unacknowledged HTTP port operation.');
            return;
        }
        let elapsedMs = 0;
        try {
            elapsedMs = ports.now() - started;
            assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);
            if (elapsedMs > plan.deadlineMs) fail('HTTP observation deadline exceeded.');
            if (!failure) {
                assert.ok(
                    connected && requestFinished && responseEnded && response.complete === true,
                );
                assert.equal(status, expected);
                assert.equal(response.headers['content-type'], 'application/json');
                assert.equal(response.headers['cache-control'], 'no-store');
                assert.equal(response.headers['x-content-type-options'], 'nosniff');
                assert.equal(response.headers['access-control-allow-origin'], allowedOrigin);
                const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                    Buffer.concat(chunks),
                );
                value = JSON.parse(text);
                assert.equal(JSON.stringify(value), text, 'Noncanonical Gateway response.');
                assert.ok(value && typeof value === 'object' && !Array.isArray(value));
                assert.ok(
                    !text.includes(selected.token) && !text.includes(selected.target.password),
                    'Secret echoed by Gateway.',
                );
            }
        } catch {
            fail('HTTP response validation failed.');
        }
        try {
            sync(ports.clearTimer(timer), undefined);
            while (listeners.length) {
                const row = listeners.at(-1);
                sync(row.target.off(row.event, row.callback), row.target);
                listeners.pop();
            }
            retired = true;
            chunks.length = 0;
            retained.delete(owner);
            closed.resolve(snapshot());
            if (!failure)
                result.resolve(
                    Object.freeze({
                        value,
                        role: selected.role,
                        status,
                        responseBytes,
                        elapsedMs,
                        requestRetired: true,
                        responseRetired: true,
                        socketRetired: true,
                        wholeGroupRetirement: null,
                        releaseAcceptance: false,
                    }),
                );
        } catch {
            fail('HTTP observer retirement failed.');
        }
    }
    function observeResponse(value) {
        try {
            if (response) {
                unknown.add(value);
                throw Error('Duplicate response ownership.');
            }
            response = value;
            assert.ok(request && value && typeof value.on === 'function');
            status = response.statusCode;
            if (status !== expected) fail('Unexpected HTTP status.');
            on(response, 'error', () => fail('HTTP response error.'));
            on(response, 'aborted', () => fail('HTTP response aborted.'));
            on(response, 'data', (bytes) => {
                if (
                    !Buffer.isBuffer(bytes) ||
                    responseEnded ||
                    responseClosed ||
                    bytes.length === 0
                ) {
                    fail('Unsupported HTTP body event.');
                    return;
                }
                if (failure) return; // Continue draining, never retain unbounded or error response bodies.
                if (
                    bytes.length > plan.maxBytes - responseBytes ||
                    responseChunks >= GATEWAY_HTTP_BOUNDS.chunks
                ) {
                    fail('HTTP body bound exceeded.');
                    return;
                }
                responseBytes += bytes.length;
                responseChunks++;
                chunks.push(Buffer.from(bytes));
            });
            on(response, 'end', () => {
                if (responseEnded) fail('Duplicate HTTP response end.');
                responseEnded = true;
            });
            on(response, 'close', () => {
                if (responseClosed) fail('Duplicate HTTP response close.');
                responseClosed = true;
                finish();
            });
        } catch {
            fail('HTTP response acquisition unacknowledged.');
        }
    }
    try {
        timer = ports.setTimer(() => fail('HTTP observation deadline exceeded.'), plan.deadlineMs);
        if (timer == null || typeof timer?.then === 'function') {
            unknown.add(timer);
            if (typeof timer?.then === 'function') Promise.resolve(timer).catch(() => {});
            throw Error('Unsupported timer registration.');
        }
        assert.equal(failure, undefined);
        const headers = {
            Origin: allowedOrigin,
            Connection: 'close',
            Authorization: 'Bearer ' + selected.token,
            ...(plan.body
                ? { 'Content-Type': 'application/json', 'Content-Length': plan.body.length }
                : {}),
        };
        request = ports.request(
            {
                protocol: 'http:',
                hostname: '127.0.0.1',
                port: selected.port,
                family: 4,
                method: plan.method,
                path: plan.path,
                agent: false,
                maxHeaderSize: GATEWAY_HTTP_BOUNDS.headerBytes,
                headers,
            },
            observeResponse,
        );
        if (typeof request?.then === 'function') {
            unknown.add(request);
            Promise.resolve(request).catch(() => {});
            throw Error('Unsupported asynchronous HTTP acquisition.');
        }
        assert.ok(request && typeof request.on === 'function' && typeof request.end === 'function');
        on(request, 'error', () => {
            requestError = true;
            fail('HTTP request error.');
            finish();
        });
        on(request, 'finish', () => {
            if (requestFinished) fail('Duplicate HTTP request finish.');
            requestFinished = true;
        });
        on(request, 'close', () => {
            if (requestClosed) fail('Duplicate HTTP request close.');
            requestClosed = true;
            finish();
        });
        on(request, 'socket', (value) => {
            try {
                if (socket) {
                    unknown.add(value);
                    throw Error('Duplicate socket ownership.');
                }
                socket = value;
                assert.ok(value && typeof value.on === 'function');
                const connection = () => {
                    assert.equal(socket.remoteAddress, '127.0.0.1');
                    assert.equal(socket.localAddress, '127.0.0.1');
                    assert.equal(socket.remotePort, selected.port);
                    connected = true;
                };
                on(socket, 'error', () => fail('HTTP socket error.'));
                on(socket, 'connect', () => {
                    try {
                        connection();
                    } catch {
                        fail('Unexpected HTTP socket peer.');
                    }
                });
                on(socket, 'close', () => {
                    if (socketClosed) fail('Duplicate HTTP socket close.');
                    socketClosed = true;
                    finish();
                });
                if (!socket.connecting) connection();
            } catch {
                fail('HTTP socket acquisition unacknowledged.');
            }
        });
        sync(request.end(plan.body), request);
    } catch {
        fail('HTTP dispatch or observer registration unacknowledged.');
    }
    return owner;
}
