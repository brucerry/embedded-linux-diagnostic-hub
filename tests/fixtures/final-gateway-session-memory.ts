import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { GATEWAY_SESSION_BOUNDS } from '../../scripts/lib/final-gateway-session.mjs';
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export const input = () => ({
    port: 58731,
    token: 'a'.repeat(64),
    version: '0.6.0',
    attemptId: 'b'.repeat(32),
    target: {
        host: '127.0.0.1',
        port: 58732,
        fingerprint: 'SHA256:' + 'A'.repeat(43),
        username: 'engineer',
        password: 'synthetic-password-canary',
    },
    expectedProbes: [
        {
            id: 'identity',
            status: 'collected',
            exitCode: 0,
            stdoutSHA256: hash('synthetic-kernel\n'),
            stderrSHA256: hash(''),
        },
    ],
});
export function fixture() {
    const controls: any = {},
        requests: any[] = [],
        timers: any[] = [];
    let time = 0,
        connected = false;
    const makeSnapshot = () => ({
        schemaVersion: 1,
        mode: 'ssh',
        results: [
            {
                id: 'identity',
                status: 'collected',
                exitCode: 0,
                stdout: 'synthetic-kernel\n',
                stderr: '',
                truncated: false,
            },
        ],
    });
    const roleOf = (options: any) =>
        options.path === '/api/fingerprint'
            ? 'fingerprint'
            : options.path === '/api/sessions'
              ? 'connect'
              : options.path === '/api/connection-attempts/cancel'
                ? 'cancel'
                : options.path === '/api/health'
                  ? options.headers.Origin === 'http://127.0.0.2'
                      ? 'bad-origin'
                      : options.headers.Authorization
                        ? 'health'
                        : 'no-token'
                  : options.method === 'DELETE'
                    ? 'disconnect'
                    : options.path.endsWith('/heartbeat')
                      ? 'heartbeat'
                      : connected
                        ? 'snapshot'
                        : 'gone';
    const close = (row: any) => {
        assert.equal(row.closed, false);
        row.closed = true;
        row.response.emit('end');
        row.response.emit('close');
        row.request.emit('close');
        row.socket.emit('close');
    };
    const ports = {
        now: () => time,
        setTimer(fn: Function, ms: number) {
            const row = { fn, ms, cleared: false };
            timers.push(row);
            return row;
        },
        clearTimer(row: any) {
            row.cleared = true;
            if (controls.badClear) return Promise.resolve();
        },
        request(options: any, callback: Function) {
            assert.equal(options.hostname, '127.0.0.1');
            assert.equal(options.family, 4);
            assert.equal(options.agent, false);
            assert.equal(options.headers.Connection, 'close');
            const role = roleOf(options),
                request: any = new EventEmitter(),
                response: any = new EventEmitter(),
                socket: any = new EventEmitter();
            const row: any = { role, options, request, response, socket, closed: false };
            requests.push(row);
            Object.assign(socket, {
                connecting: true,
                remoteAddress: '127.0.0.1',
                localAddress: '127.0.0.1',
                remotePort: input().port,
            });
            Object.assign(response, {
                complete: true,
                statusCode:
                    role === 'connect'
                        ? 201
                        : role === 'gone'
                          ? 404
                          : role === 'no-token'
                            ? 401
                            : role === 'bad-origin'
                              ? 403
                              : 200,
                headers: {
                    'content-type': 'application/json',
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                    ...(role === 'bad-origin'
                        ? {}
                        : { 'access-control-allow-origin': 'http://127.0.0.1' }),
                },
            });
            request.destroy = () => assert.fail('No forced HTTP destruction');
            request.end = (body: any) => {
                row.body = body ? JSON.parse(body.toString()) : null;
                if (body) assert.equal(options.headers['Content-Length'], body.length);
                queueMicrotask(() => {
                    request.emit('socket', socket);
                    if (controls.peerWrong === role) socket.remoteAddress = '127.0.0.2';
                    socket.emit('connect');
                    request.emit('finish');
                    if (role === 'connect') connected = true;
                    if (role === 'disconnect' || role === 'cancel') connected = false;
                    const values: Record<string, any> = {
                        fingerprint: { fingerprint: input().target.fingerprint },
                        connect: { sessionId: 'c'.repeat(32) },
                        heartbeat: { connected: true },
                        snapshot: makeSnapshot(),
                        disconnect: { disconnected: true },
                        gone: { error: 'Session expired.' },
                        cancel: { cancelled: true },
                        health: {
                            version: '0.6.0',
                            activeSessions: 0,
                            connectionCancellation: true,
                        },
                        'bad-origin': {},
                        'no-token': {},
                    };
                    if (controls.mutate) controls.mutate(role, values[role]);
                    if (controls.statusWrong === role) response.statusCode = 503;
                    callback(response);
                    const bytes =
                        controls.rawRole === role
                            ? controls.raw
                            : Buffer.from(JSON.stringify(values[role]));
                    response.emit('data', bytes);
                    if (controls.holdRole !== role) close(row);
                });
                return controls.unknownEnd === role ? Promise.resolve(request) : request;
            };
            return request;
        },
    };
    const pulse = async () => {
        for (let i = 0; i < 100; i++) await Promise.resolve();
    };
    return {
        ports,
        controls,
        requests,
        timers,
        pulse,
        close,
        expire() {
            time = GATEWAY_SESSION_BOUNDS.totalMs;
            timers.find((r) => r.ms === GATEWAY_SESSION_BOUNDS.totalMs).fn();
        },
    };
}
