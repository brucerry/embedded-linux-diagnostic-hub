import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { startDiagnosticGatewayCommand } from '../scripts/lib/diagnostic-gateway-command.mjs';
import {
    gatewayInstallPlan,
    startDiagnosticGatewayRuntime,
} from '../scripts/lib/diagnostic-gateway-runtime.mjs';
import { prepareDiagnosticGatewayInstall } from '../scripts/lib/diagnostic-gateway-install.mjs';
import {
    createDiagnosticGatewayExecution,
    createDiagnosticGatewayRuntimeBuildExecution,
    DIAGNOSTIC_GATEWAY_RUNTIME_BRANCH,
} from '../scripts/lib/diagnostic-gateway-execution.mjs';
import { readbackFixture } from './fixtures/archive-readback-memory';
import { memoryFilesystem } from './fixtures/gateway-producer-memory';

const pulse = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
};
const deferred = () => {
    let resolve!: (v?: any) => void, reject!: (v?: any) => void;
    const promise = new Promise<any>((a, b) => {
        resolve = a;
        reject = b;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
const input = () => ({
    root: '/project/validation/gateway-runtime/install',
    nodePath: '/tools/bin/node',
    port: 58731,
    token: 'a'.repeat(64),
    version: '0.6.0',
    // Authored memory-only target, never a trusted physical device configuration.
    target: { host: '127.0.0.1', port: 60001, fingerprint: 'SHA256:' + 'B'.repeat(43) },
});
function fixture() {
    const child: any = new EventEmitter(),
        complete = deferred(),
        joined = deferred();
    Object.assign(child, {
        pid: 777,
        spawnfile: input().nodePath,
        spawnargs: [input().nodePath, input().root + '/dist-gateway/main.cjs'],
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        exitCode: null,
        signalCode: null,
    });
    const timers: any[] = [],
        calls: any[] = [],
        http: any[] = [],
        controls: any = {};
    let signals = 0;
    const closeHttp = (h: any) => {
        if (h.closed) return;
        h.closed = true;
        h.response.emit('aborted');
        h.response.emit('close');
        h.request.emit('close');
        h.socket.emit('close');
    };
    const closeChild = (code = 0, signal: any = null) => {
        for (const h of http) if (!h.closed) closeHttp(h);
        child.stdout.emit('close');
        child.stderr.emit('close');
        child.emit('exit', code, signal);
        child.emit('close', code, signal);
        const observation = {
            sha256: 'b'.repeat(64),
            record: { installation: { files: [{ path: 'synthetic-file' }] } },
        };
        complete.resolve(observation);
        joined.resolve();
    };
    child.kill = (signal: string) => {
        signals++;
        assert.equal(signal, 'SIGTERM');
        if (controls.signalFalse) return false;
        if (!controls.holdChildClose) Promise.resolve().then(() => closeChild());
        return true;
    };
    const ports: any = {
        launch(file: string, args: string[], options: any) {
            calls.push({ file, args, options });
            return child;
        },
        observer: {
            observeChild(c: any) {
                assert.equal(c, child);
                return { completion: complete.promise, joined: joined.promise };
            },
        },
        setTimer(callback: Function, ms: number) {
            const t = { callback, ms, cleared: false };
            timers.push(t);
            return t;
        },
        clearTimer(t: any) {
            t.cleared = true;
        },
        now: () => 0,
        request(options: any, cb: Function) {
            const request: any = new EventEmitter(),
                response: any = new EventEmitter(),
                socket: any = new EventEmitter();
            const role = http.length;
            const h = { request, response, socket, closed: false };
            http.push(h);
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
                Promise.resolve().then(() => {
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
            assert.equal(options.hostname, '127.0.0.1');
            assert.equal(options.path, '/api/health');
            return request;
        },
    };
    const ready = () => {
        child.emit('spawn');
        const b = Buffer.from(
            'Diagnostic Hub gateway listening on 127.0.0.1:58731. Place behind HTTPS for website use.\n',
        );
        child.stdout.emit('data', b.subarray(0, 35));
        child.stdout.emit('data', b.subarray(35));
    };
    return {
        child,
        controls,
        ports,
        calls,
        http,
        timers,
        ready,
        closeChild,
        get signals() {
            return signals;
        },
    };
}
test('unmodified CLI orchestration requires three actual HTTP owner results then exactly one normal signal and closure', async () => {
    const f = fixture(),
        o = startDiagnosticGatewayRuntime(input(), f.ports);
    assert.equal(f.http.length, 0);
    f.ready();
    const r = await o.result;
    await o.closed;
    assert.deepEqual(
        r.receipt.checks.map((v: any) => v.status),
        [200, 401, 403],
    );
    assert.equal(f.signals, 1);
    assert.equal(o.snapshot().retired, true);
    assert.equal(o.snapshot().listeners, 0);
    assert.ok(f.timers.every((t) => t.cleared));
    assert.equal(r.receipt.wholeGroupRetirement, null);
    assert.equal(r.receipt.releaseAcceptance, false);
    assert.equal(JSON.stringify(r.receipt).includes(input().token), false);
    const call = f.calls[0];
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.HUB_GATEWAY_HOST, '127.0.0.1');
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.equal(call.options.env.HOME, undefined);
});
test('health failure remains failed after normal close, without another launch or signal', async () => {
    const f = fixture();
    f.controls.badStatus = true;
    const o = startDiagnosticGatewayRuntime(input(), f.ports);
    f.ready();
    await assert.rejects(o.result);
    await o.closed;
    assert.equal(f.signals, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(o.snapshot().failed, true);
});
test('held HTTP timeout keeps custody until server-close acknowledgements and cannot become success', async () => {
    const f = fixture();
    f.controls.holdHttp = true;
    const o = startDiagnosticGatewayRuntime(input(), f.ports);
    f.ready();
    await pulse();
    f.timers.find((t) => t.ms === 2000).callback();
    await assert.rejects(o.result);
    await o.closed;
    assert.equal(f.signals, 1);
    assert.equal(o.snapshot().requestOwners, 0);
    assert.equal(o.snapshot().failed, true);
});
test('held child shutdown fails on deadline without escalation or signal retry', async () => {
    const f = fixture();
    f.controls.holdChildClose = true;
    const o = startDiagnosticGatewayRuntime(input(), f.ports);
    f.ready();
    await pulse();
    assert.equal(f.signals, 1);
    assert.equal(o.snapshot().retired, false);
    const closeTimer = f.timers.filter((t) => t.ms === 10000).at(-1);
    closeTimer.callback();
    await assert.rejects(o.result);
    assert.equal(f.signals, 1);
    f.closeChild();
    await o.closed;
    await assert.rejects(o.result);
});
test('false signal acknowledgement stays failed even after a late normal direct close', async () => {
    const f = fixture();
    f.controls.signalFalse = true;
    const o = startDiagnosticGatewayRuntime(input(), f.ports);
    f.ready();
    await assert.rejects(o.result);
    assert.equal(f.signals, 1);
    f.closeChild();
    await o.closed;
    await assert.rejects(o.result);
});
test('bind/startup failure sends no HTTP probe and preserves failure through owned normal close', async () => {
    const f = fixture(),
        o = startDiagnosticGatewayRuntime(input(), f.ports);
    f.child.emit('spawn');
    f.timers.find((t) => t.ms === 10000).callback();
    await assert.rejects(o.result);
    await o.closed;
    assert.equal(f.http.length, 0);
    assert.equal(f.signals, 1);
});
test('unknown spawn identity cannot authorize a shutdown signal to a different command', async () => {
    const f = fixture();
    f.child.spawnargs = ['/tools/bin/node', '/unrelated'];
    const o = startDiagnosticGatewayRuntime(input(), f.ports);
    f.ready();
    await assert.rejects(o.result);
    await pulse();
    assert.equal(f.signals, 0);
    assert.equal(o.snapshot().retired, false);
    assert.equal(f.http.length, 0);
});
test('asynchronous timer registration prevents process dispatch', async () => {
    const f = fixture();
    f.ports.setTimer = () => Promise.resolve(1);
    const o = startDiagnosticGatewayRuntime(input(), f.ports);
    await assert.rejects(o.result);
    assert.equal(f.calls.length, 0);
});
test('runtime installation plan is one exact online required-only lock installation with owned config/cache', () => {
    const p = gatewayInstallPlan(
        '/tools/bin/node',
        '/tools/lib/node_modules/npm/bin/npm-cli.js',
        '/project/validation/gateway-runtime',
        'c'.repeat(32),
    );
    assert.equal(p.role, 'install');
    assert.ok(
        p.command.includes('ci') &&
            p.command.includes('--omit=optional') &&
            p.command.includes('--ignore-scripts'),
    );
    assert.ok(
        p.command.includes('--fetch-retries=0') &&
            p.command.includes('--registry=https://registry.npmjs.org'),
    );
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.command));
    assert.ok(!p.command.includes('--offline'));
});
test('online installer command needs direct exit and both pipe closures, with its separate three-minute budget', async () => {
    const f = fixture(),
        p = gatewayInstallPlan(
            '/tools/bin/node',
            '/tools/lib/node_modules/npm/bin/npm-cli.js',
            '/project/validation/gateway-runtime',
            'c'.repeat(32),
        );
    const o = startDiagnosticGatewayCommand(p, { PATH: '/tools/bin:/usr/bin:/bin' }, f.ports);
    assert.equal(f.timers[0].ms, 180000);
    f.child.emit('spawn');
    f.child.emit('exit', 0, null);
    f.child.emit('close', 0, null);
    f.child.stdout.emit('close');
    assert.equal(o.snapshot().directRetired, false);
    f.child.stderr.emit('close');
    const r = await o.result;
    await o.closed;
    assert.equal(r.role, 'install');
    assert.equal(o.snapshot().directRetired, true);
    assert.equal(f.signals, 0);
});
test('runtime branch admission remains separate from the prior build-only capability', () => {
    const context = {
        repository: 'brucerry/embedded-linux-diagnostic-hub',
        private: false,
        ref: 'refs/heads/' + DIAGNOSTIC_GATEWAY_RUNTIME_BRANCH,
        event: 'push',
        attempt: '1',
        runner: 'github-hosted',
        system: 'Linux',
        arch: 'X64',
        sha: 'a'.repeat(40),
        run: '12345',
        policy: 'github-hosted-diagnostic-teardown-unproved-group-v1',
    };
    const s = {
        context,
        root: '/project',
        gitPath: '/usr/bin/git',
        gitSHA256: 'b'.repeat(64),
        nodePath: '/tools/bin/node',
        esbuildPath: '/project/node_modules/esbuild/bin/esbuild',
        npmPath: '/tools/lib/node_modules/npm/bin/npm-cli.js',
        environment: {
            PATH: '/tools/bin:/usr/bin:/bin',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            TZ: 'UTC',
        },
    };
    const deny = () => assert.fail('No native IO admitted'),
        ports = {
            filesystem: Object.fromEntries(
                ['realpath', 'lstat', 'open', 'opendir', 'mkdir'].map((k) => [k, deny]),
            ),
            launch: deny,
            setTimer: deny,
            clearTimer: deny,
            now: deny,
        };
    assert.throws(() => createDiagnosticGatewayExecution(s, ports));
    assert.equal(createDiagnosticGatewayRuntimeBuildExecution(s, ports).context.ref, context.ref);
});
test('strict tar snapshots copy only eight exact payload files to a fresh namespace', async () => {
    const f = await readbackFixture('gateway'),
        record = f.files.get('gateway-build.json')!,
        parsed = JSON.parse(record.toString()),
        fs = memoryFilesystem(),
        writes: string[] = [];
    const writer = async (file: string, b: Buffer) => {
        writes.push(file);
        const h = await fs.fs.open(file, 'wx');
        await h.writeFile(b);
        await h.sync();
        await h.close();
    };
    const prepared = await prepareDiagnosticGatewayInstall(
        f.files.get(parsed.archive.name),
        record,
        parsed.context,
        '/project/validation/gateway-runtime',
        fs.fs,
        writer,
    );
    assert.equal(prepared.files, 8);
    assert.equal(writes.length, 10);
    for (const row of parsed.payload)
        assert.equal(fs.bytes(prepared.installRoot + '/' + row.path).length, row.bytes);
    await assert.rejects(
        prepareDiagnosticGatewayInstall(
            f.files.get(parsed.archive.name),
            record,
            parsed.context,
            '/project/validation/gateway-runtime',
            fs.fs,
            writer,
        ),
    );
    assert.equal(writes.length, 10);
});
test('wrong archive bytes fail before directory creation or writes', async () => {
    const f = await readbackFixture('gateway'),
        record = f.files.get('gateway-build.json')!,
        parsed = JSON.parse(record.toString()),
        fs = memoryFilesystem();
    const changed = Buffer.from(f.files.get(parsed.archive.name)!);
    changed[0] ^= 1;
    await assert.rejects(
        prepareDiagnosticGatewayInstall(
            changed,
            record,
            parsed.context,
            '/project/validation/gateway-runtime',
            fs.fs,
            async () => assert.fail('No writes'),
        ),
    );
    assert.equal(fs.records.has('/project/validation/gateway-runtime'), false);
});

test('health-only runtime requires an explicit loopback fixture target before any acquisition', () => {
    for (const mode of ['missing', 'host', 'port', 'fingerprint']) {
        const selected: any = input(),
            f = fixture();
        if (mode === 'missing') delete selected.target;
        if (mode === 'host') selected.target.host = 'untrusted-target';
        if (mode === 'port') selected.target.port = 1;
        if (mode === 'fingerprint') selected.target.fingerprint = 'placeholder';
        assert.throws(() => startDiagnosticGatewayRuntime(selected, f.ports));
        assert.equal(f.calls.length, 0);
        assert.equal(f.timers.length, 0);
    }
});
