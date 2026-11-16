// Authored memory-only children, HTTP owners and clock. No native I/O or package code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
    startGatewayHealthOnlySmoke,
    startDiagnosticGatewayRuntime,
} from '../scripts/lib/diagnostic-gateway-runtime.mjs';

const input = () => ({
    root: '/memory/install',
    nodePath: '/memory/tools/bin/node',
    token: 'ab'.repeat(32),
    version: '0.6.0',
});
const pulse = async () => {
    for (let i = 0; i < 1000; i++) await Promise.resolve();
};
function deferred() {
    let resolve;
    const promise = new Promise((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
function fixture() {
    const child = new EventEmitter(),
        completion = deferred(),
        joined = deferred();
    Object.assign(child, {
        pid: 777,
        stdin: null,
        exitCode: null,
        signalCode: null,
        spawnfile: input().nodePath,
        spawnargs: [input().nodePath, input().root + '/dist-gateway/main.cjs'],
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
    });
    const controls = {},
        calls = [],
        http = [],
        timers = [];
    let signals = 0;
    function closeHttp(h) {
        if (h.closed) return;
        h.closed = true;
        h.response.emit('aborted');
        h.response.emit('close');
        h.request.emit('close');
        h.socket.emit('close');
    }
    function closeChild() {
        for (const h of http) closeHttp(h);
        child.stdout.emit('close');
        if (!controls.holdEOF) child.stderr.emit('close');
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        completion.resolve({ sha256: 'b'.repeat(64), record: { installation: { files: [] } } });
        joined.resolve();
    }
    child.kill = (signal) => {
        signals++;
        assert.equal(signal, 'SIGTERM');
        if (controls.signalFalse) return false;
        if (!controls.holdClose) queueMicrotask(closeChild);
        return true;
    };
    const ports = {
        launch(file, args, options) {
            calls.push({ file, args, options });
            return child;
        },
        observer: {
            observeChild(value) {
                assert.equal(value, child);
                return { completion: completion.promise, joined: joined.promise };
            },
        },
        now: () => 0,
        setTimer(callback, ms) {
            const timer = { callback, ms, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer) {
            if (controls.clearFailure) throw undefined;
            timer.cleared = true;
        },
        request(options, cb) {
            const request = new EventEmitter(),
                response = new EventEmitter(),
                socket = new EventEmitter();
            const role = http.length,
                h = { request, response, socket, closed: false };
            http.push(h);
            assert.equal(options.hostname, '127.0.0.1');
            assert.equal(options.family, 4);
            assert.equal(options.agent, false);
            assert.equal(options.method, 'GET');
            assert.equal(options.path, '/api/health');
            Object.assign(socket, {
                connecting: true,
                remoteAddress: '127.0.0.1',
                localAddress: '127.0.0.1',
                remotePort: 58731,
            });
            Object.assign(response, {
                statusCode: controls.badStatus ? 500 : [200, 401, 403][role],
                complete: true,
                headers: {
                    'content-type': 'application/json',
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                    ...(role === 2 ? {} : { 'access-control-allow-origin': 'http://127.0.0.1' }),
                },
            });
            request.end = () => {
                queueMicrotask(() => {
                    request.emit('socket', socket);
                    socket.emit('connect');
                    request.emit('finish');
                    cb(response);
                    if (controls.holdHttp) return;
                    response.emit(
                        'data',
                        Buffer.from(
                            role === 0
                                ? JSON.stringify({
                                      version: '0.6.0',
                                      activeSessions: 0,
                                      connectionCancellation: true,
                                  })
                                : '{}',
                        ),
                    );
                    response.emit('end');
                    response.emit('close');
                    request.emit('close');
                    socket.emit('close');
                    h.closed = true;
                });
                return request;
            };
            return request;
        },
    };
    const spawn = () => child.emit('spawn');
    const ready = () => {
        spawn();
        const text = Buffer.from(
            'Diagnostic Hub gateway listening on 127.0.0.1:58731. Place behind HTTPS for website use.\n',
        );
        child.stdout.emit('data', text.subarray(0, 30));
        child.stdout.emit('data', text.subarray(30));
    };
    return {
        child,
        controls,
        calls,
        http,
        timers,
        ports,
        spawn,
        ready,
        closeChild,
        get signals() {
            return signals;
        },
    };
}

test('separate health smoke fixes configuration and never accepts an SSH fixture or secrets from inherited environment', async () => {
    const f = fixture(),
        owner = startGatewayHealthOnlySmoke(input(), f.ports);
    assert.equal(f.http.length, 0);
    const options = f.calls[0].options;
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.env.HUB_GATEWAY_HOST, '127.0.0.1');
    assert.deepEqual(JSON.parse(options.env.HUB_TARGETS_JSON), [
        { host: '127.0.0.1', port: 58732, fingerprint: 'SHA256:' + 'A'.repeat(43) },
    ]);
    for (const key of ['HOME', 'NODE_OPTIONS', 'NODE_PATH', 'SSH_AUTH_SOCK', 'HTTPS_PROXY'])
        assert.equal(options.env[key], undefined);
    f.ready();
    const result = await owner.result;
    await owner.closed;
    assert.deepEqual(
        result.receipt.checks.map((row) => row.status),
        [200, 401, 403],
    );
    assert.equal(result.receipt.configuredTargetAuthenticated, false);
    assert.equal(result.receipt.sshBehaviorObserved, false);
    assert.equal(result.receipt.releaseAcceptance, false);
    assert.equal(f.signals, 1);
    assert.equal(owner.snapshot().retired, true);
    assert.ok(!JSON.stringify(result).includes(input().token));
    assert.equal(owner.snapshot().listeners, 0);
    assert.ok(f.timers.every((timer) => timer.cleared));
});
test('caller cannot inject a target, port or session into the health-only contract', () => {
    for (const extra of [{ target: {} }, { port: 9999 }, { session: {} }]) {
        const f = fixture();
        assert.throws(() => startGatewayHealthOnlySmoke({ ...input(), ...extra }, f.ports));
        assert.equal(f.calls.length, 0);
    }
});
test('original owned-target contract still refuses absent or malformed target before launch', () => {
    for (const target of [
        undefined,
        {},
        { host: 'outside.invalid', port: 60001, fingerprint: 'SHA256:' + 'B'.repeat(43) },
    ]) {
        const f = fixture();
        assert.throws(() =>
            startDiagnosticGatewayRuntime(
                { ...input(), port: 58731, ...(target === undefined ? {} : { target }) },
                f.ports,
            ),
        );
        assert.equal(f.calls.length, 0);
    }
});
test('delayed readiness cannot issue an HTTP request early', async () => {
    const f = fixture(),
        owner = startGatewayHealthOnlySmoke(input(), f.ports);
    await pulse();
    assert.equal(f.http.length, 0);
    assert.equal(f.signals, 0);
    f.ready();
    await owner.result;
    await owner.closed;
    assert.equal(f.http.length, 3);
    assert.equal(f.signals, 1);
});
test('health failure remains failed after normal close without relaunch', async () => {
    const f = fixture();
    f.controls.badStatus = true;
    const owner = startGatewayHealthOnlySmoke(input(), f.ports);
    f.ready();
    await assert.rejects(owner.result);
    await owner.closed;
    assert.equal(f.calls.length, 1);
    assert.equal(f.signals, 1);
    assert.equal(owner.snapshot().failed, true);
});
test('startup deadline makes no HTTP request and closes only the owned child', async () => {
    const f = fixture(),
        owner = startGatewayHealthOnlySmoke(input(), f.ports);
    f.spawn();
    f.timers.find((timer) => timer.ms === 10000).callback();
    await assert.rejects(owner.result);
    await owner.closed;
    assert.equal(f.http.length, 0);
    assert.equal(f.signals, 1);
});
test('child error cannot become a successful smoke after late close', async () => {
    const f = fixture(),
        owner = startGatewayHealthOnlySmoke(input(), f.ports);
    f.spawn();
    f.child.emit('error', Error('authored bind failure'));
    await assert.rejects(owner.result);
    await owner.closed;
    assert.equal(f.http.length, 0);
    assert.equal(f.signals, 1);
    assert.equal(owner.snapshot().failed, true);
});
test('output overflow fails closed without exposing or continuing HTTP', async () => {
    const f = fixture(),
        owner = startGatewayHealthOnlySmoke(input(), f.ports);
    f.spawn();
    f.child.stderr.emit('data', Buffer.alloc(65537));
    await assert.rejects(owner.result);
    await owner.closed;
    assert.equal(f.http.length, 0);
    assert.equal(f.signals, 1);
});
test('HTTP timeout retains failure while request and child close are joined', async () => {
    const f = fixture();
    f.controls.holdHttp = true;
    const owner = startGatewayHealthOnlySmoke(input(), f.ports);
    f.ready();
    await pulse();
    f.timers.find((timer) => timer.ms === 2000).callback();
    await assert.rejects(owner.result);
    await owner.closed;
    assert.equal(f.signals, 1);
    assert.equal(owner.snapshot().requestOwners, 0);
    assert.equal(owner.snapshot().failed, true);
});
test('shutdown deadline never retries a signal and late exit never changes failure', async () => {
    const f = fixture();
    f.controls.holdClose = true;
    const owner = startGatewayHealthOnlySmoke(input(), f.ports);
    f.ready();
    await pulse();
    f.timers
        .filter((timer) => timer.ms === 10000)
        .at(-1)
        .callback();
    await assert.rejects(owner.result);
    assert.equal(owner.snapshot().retired, false);
    assert.equal(f.signals, 1);
    f.closeChild();
    await owner.closed;
    await assert.rejects(owner.result);
    assert.equal(f.signals, 1);
});
test('unacknowledged SIGTERM remains uncertain after a later observed exit', async () => {
    const f = fixture();
    f.controls.signalFalse = true;
    const owner = startGatewayHealthOnlySmoke(input(), f.ports);
    f.ready();
    await assert.rejects(owner.result);
    assert.equal(f.signals, 1);
    f.closeChild();
    await owner.closed;
    await assert.rejects(owner.result);
});
test('missing EOF retains custody; eventual EOF cannot erase the deadline failure', async () => {
    const f = fixture();
    f.controls.holdEOF = true;
    const owner = startGatewayHealthOnlySmoke(input(), f.ports);
    f.ready();
    await pulse();
    assert.equal(owner.snapshot().retired, false);
    f.timers.find((timer) => timer.ms === 45000).callback();
    await assert.rejects(owner.result);
    assert.equal(f.signals, 1);
    f.child.stderr.emit('close');
    await owner.closed;
    await assert.rejects(owner.result);
});
test('listener/timer retirement error is retained rather than reported as clean close', async () => {
    const f = fixture();
    f.controls.clearFailure = true;
    const owner = startGatewayHealthOnlySmoke(input(), f.ports);
    f.ready();
    await assert.rejects(owner.result);
    await pulse();
    assert.equal(owner.snapshot().retired, false);
    assert.equal(owner.snapshot().failed, true);
    assert.ok(f.timers.some((timer) => !timer.cleared));
});
