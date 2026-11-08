import assert from 'node:assert/strict';

export const GATEWAY_HTTP_BOUNDS = Object.freeze({
    deadlineMs: 2000,
    bytes: 4096,
    chunks: 128,
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
export function startDiagnosticGatewayHealth(input, ports) {
    assert.deepEqual(Object.keys(input).sort(), ['port', 'role', 'token', 'version']);
    assert.ok(Number.isInteger(input.port) && input.port >= 1024 && input.port <= 65535);
    assert.ok(['healthy', 'no-token', 'bad-origin'].includes(input.role));
    assert.match(input.token, /^[a-f0-9]{64}$/);
    assert.match(input.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
    for (const name of ['request', 'setTimer', 'clearTimer', 'now'])
        assert.equal(typeof ports[name], 'function');
    ports = Object.freeze({ ...ports });
    const selected = { ...input },
        result = deferred(),
        closed = deferred(),
        listeners = [],
        unknown = new Set();
    const expected = { healthy: 200, 'no-token': 401, 'bad-origin': 403 }[selected.role];
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
        status = null;
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
                new Error('Gateway HTTP diagnostic failed; uncertain custody retained.', {
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
            if (elapsedMs > GATEWAY_HTTP_BOUNDS.deadlineMs)
                fail('HTTP observation deadline exceeded.');
            if (!failure) {
                assert.ok(
                    connected && requestFinished && responseEnded && response.complete === true,
                );
                assert.equal(status, expected);
                assert.equal(response.headers['content-type'], 'application/json');
                assert.equal(response.headers['cache-control'], 'no-store');
                assert.equal(response.headers['x-content-type-options'], 'nosniff');
                if (selected.role !== 'bad-origin')
                    assert.equal(response.headers['access-control-allow-origin'], allowedOrigin);
                else assert.equal(response.headers['access-control-allow-origin'], undefined);
                if (selected.role === 'healthy') {
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(
                        Buffer.concat(chunks),
                    );
                    assert.deepEqual(JSON.parse(text), {
                        version: selected.version,
                        activeSessions: 0,
                        connectionCancellation: true,
                    });
                }
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
            assert.ok(request && !response && value && typeof value.on === 'function');
            response = value;
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
                    bytes.length > GATEWAY_HTTP_BOUNDS.bytes - responseBytes ||
                    responseChunks >= GATEWAY_HTTP_BOUNDS.chunks
                ) {
                    fail('HTTP body bound exceeded.');
                    return;
                }
                responseBytes += bytes.length;
                responseChunks++;
                if (selected.role === 'healthy') chunks.push(Buffer.from(bytes));
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
        timer = ports.setTimer(
            () => fail('HTTP observation deadline exceeded.'),
            GATEWAY_HTTP_BOUNDS.deadlineMs,
        );
        if (timer === undefined || typeof timer?.then === 'function') {
            unknown.add(timer);
            if (typeof timer?.then === 'function') Promise.resolve(timer).catch(() => {});
            throw Error('Unsupported timer registration.');
        }
        assert.equal(failure, undefined);
        const headers = {
            Origin: selected.role === 'bad-origin' ? 'http://127.0.0.2' : allowedOrigin,
            Connection: 'close',
        };
        if (selected.role !== 'no-token') headers['Authorization'] = 'Bearer ' + selected.token;
        request = ports.request(
            {
                protocol: 'http:',
                hostname: '127.0.0.1',
                port: selected.port,
                family: 4,
                method: 'GET',
                path: '/api/health',
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
                assert.ok(!socket && value && typeof value.on === 'function');
                socket = value;
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
        sync(request.end(), request);
    } catch {
        fail('HTTP dispatch or observer registration unacknowledged.');
    }
    return owner;
}
