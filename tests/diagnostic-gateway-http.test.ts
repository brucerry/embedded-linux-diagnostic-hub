import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { startDiagnosticGatewayHealth, GATEWAY_HTTP_BOUNDS } from '../scripts/lib/diagnostic-gateway-http.mjs';

const input = (role = 'healthy') => ({ role, port: 58731, token: 'a'.repeat(64), version: '0.6.0' });
function fixture(role = 'healthy') {
    const request: any = new EventEmitter(), response: any = new EventEmitter(), socket: any = new EventEmitter();
    const calls: any[] = []; let callback: Function = () => {}, timer: Function = () => {}, time = 0;
    request.end = () => request; request.destroy = () => assert.fail('No implicit request destruction');
    Object.assign(socket, { connecting: true, remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', remotePort: input().port });
    Object.assign(response, { statusCode: { healthy: 200, 'no-token': 401, 'bad-origin': 403 }[role], complete: true,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
            ...(role === 'bad-origin' ? {} : { 'access-control-allow-origin': 'http://127.0.0.1' }) } });
    const ports: any = {
        request(options: any, cb: Function) { calls.push(options); callback = cb; return request; },
        setTimer(fn: Function, ms: number) { assert.equal(ms, GATEWAY_HTTP_BOUNDS.deadlineMs); timer = fn; return 1; },
        clearTimer() {}, now: () => time,
    };
    const connect = () => { request.emit('socket', socket); socket.emit('connect'); request.emit('finish'); callback(response); };
    const close = () => { response.emit('end'); response.emit('close'); request.emit('close'); socket.emit('close'); };
    const body = () => response.emit('data', Buffer.from(JSON.stringify({ version: '0.6.0', activeSessions: 0, connectionCancellation: true })));
    return { request, response, socket, calls, ports, connect, close, body, expire: () => { time = 2001; timer(); } };
}
for (const role of ['healthy', 'no-token', 'bad-origin']) test('bounded actual HTTP callback contract for ' + role, async () => {
    const f = fixture(role), o = startDiagnosticGatewayHealth(input(role), f.ports); f.connect();
    if (role === 'healthy') f.body(); else f.response.emit('data', Buffer.from('{"message":"synthetic policy error"}'));
    f.close(); const result = await o.result; await o.closed;
    assert.equal(result.status, { healthy: 200, 'no-token': 401, 'bad-origin': 403 }[role]);
    assert.equal(result.releaseAcceptance, false); assert.equal(result.wholeGroupRetirement, null);
    assert.equal(o.snapshot().retired, true); assert.equal(o.snapshot().listeners, 0);
    assert.equal(JSON.stringify(result).includes(input().token), false);
    const options = f.calls[0]; assert.equal(options.hostname, '127.0.0.1'); assert.equal(options.family, 4);
    assert.equal(options.path, '/api/health'); assert.equal(options.method, 'GET'); assert.equal(options.agent, false);
    assert.equal(options.headers.Connection, 'close'); assert.equal(options.maxHeaderSize, 8192);
    assert.equal(options.headers.Authorization, role === 'no-token' ? undefined : 'Bearer ' + input().token);
});
test('HTTP response end cannot retire an open request or socket', async () => {
    const f = fixture(), o = startDiagnosticGatewayHealth(input(), f.ports); f.connect(); f.body();
    f.response.emit('end'); f.response.emit('close'); assert.equal(o.snapshot().retired, false);
    f.request.emit('close'); assert.equal(o.snapshot().retired, false); f.socket.emit('close'); await o.result;
});
test('late timeout cannot mutate a fully retired successful request', async () => {
    const f = fixture(), o = startDiagnosticGatewayHealth(input(), f.ports); f.connect(); f.body(); f.close();
    await o.result; const before = o.snapshot(); f.expire(); assert.deepEqual(o.snapshot(), before);
});
test('deadline fails promptly and late closures cannot turn it into a pass', async () => {
    const f = fixture(), o = startDiagnosticGatewayHealth(input(), f.ports); f.connect(); f.expire();
    await assert.rejects(o.result); assert.equal(o.snapshot().retired, false);
    f.body(); f.close(); await o.closed; await assert.rejects(o.result); assert.equal(f.calls.length, 1);
});
for (const kind of ['wrong-status', 'wrong-version', 'extra-health-field', 'missing-health-field', 'invalid-utf8', 'wrong-header', 'incomplete-body', 'nonloopback-peer'])
    test('unmodified CLI health requirement rejects ' + kind, async () => {
        const f = fixture(), o = startDiagnosticGatewayHealth(input(), f.ports);
        if (kind === 'wrong-status') f.response.statusCode = 500;
        if (kind === 'wrong-header') f.response.headers['cache-control'] = 'public';
        if (kind === 'incomplete-body') f.response.complete = false;
        if (kind === 'nonloopback-peer') f.socket.remoteAddress = '192.0.2.1';
        f.connect();
        const value: any = { version: '0.6.0', activeSessions: 0, connectionCancellation: true };
        if (kind === 'wrong-version') value.version = '9.9.9';
        if (kind === 'extra-health-field') value.secret = 'synthetic';
        if (kind === 'missing-health-field') delete value.connectionCancellation;
        f.response.emit('data', kind === 'invalid-utf8' ? Buffer.from([0xff]) : Buffer.from(JSON.stringify(value)));
        f.close(); await assert.rejects(o.result); await o.closed;
        assert.equal(o.snapshot().retired, true); assert.equal(f.calls.length, 1);
    });
test('body limits retain no overflow and preserve failure despite normal resource closure', async () => {
    const f = fixture(), o = startDiagnosticGatewayHealth(input(), f.ports); f.connect();
    f.response.emit('data', Buffer.alloc(4097)); await assert.rejects(o.result);
    f.response.emit('data', Buffer.alloc(4096)); assert.equal(o.snapshot().responseBytes, 0);
    f.close(); await o.closed; await assert.rejects(o.result);
});
test('async timer is refused before HTTP dispatch and remains unresolved custody', async () => {
    const f = fixture(); f.ports.setTimer = () => Promise.resolve(1);
    const o = startDiagnosticGatewayHealth(input(), f.ports); await assert.rejects(o.result);
    assert.equal(f.calls.length, 0); assert.equal(o.snapshot().retired, false);
});
test('observer removal failure is not request retirement or a pass', async () => {
    const f = fixture(), o = startDiagnosticGatewayHealth(input(), f.ports); f.connect(); f.body();
    f.socket.off = () => Promise.resolve(f.socket); f.close(); await assert.rejects(o.result);
    assert.equal(o.snapshot().retired, false); assert.ok(o.snapshot().listeners > 0);
});
test('uncertain request acquisition has no retry and no invented socket closure', async () => {
    const f = fixture(); f.ports.request = () => { throw Error('synthetic uncertain acquisition'); };
    const o = startDiagnosticGatewayHealth(input(), f.ports); await assert.rejects(o.result);
    assert.equal(o.snapshot().requestAcquired, false); assert.equal(o.snapshot().retired, false);
});
test('no-response connection error can retire acknowledged local resources while preserving sanitized failure', async () => {
    const f = fixture(), o = startDiagnosticGatewayHealth(input(), f.ports);
    f.request.emit('socket', f.socket);
    f.request.emit('error', Error('native synthetic error with secret=' + input().token));
    await assert.rejects(o.result, (error: any) => !String(error.cause).includes(input().token));
    assert.equal(o.snapshot().retired, false); f.request.emit('close'); assert.equal(o.snapshot().retired, false);
    f.socket.emit('close'); await o.closed; await assert.rejects(o.result);
    assert.equal(o.snapshot().retired, true); assert.equal(o.snapshot().responseAcquired, false);
    assert.equal(o.snapshot().listeners, 0); assert.equal(f.calls.length, 1);
});
test('source input cannot select a nonloopback URL, path, method or privileged/invalid port', () => {
    for (const change of [{ hostname: 'example.com' }, { path: '/api/sessions' }, { method: 'POST' }, { port: 0 }, { port: 80 }, { port: 65536 }]) {
        const f = fixture(); assert.throws(() => startDiagnosticGatewayHealth({ ...input(), ...change }, f.ports)); assert.equal(f.calls.length, 0);
    }
});
