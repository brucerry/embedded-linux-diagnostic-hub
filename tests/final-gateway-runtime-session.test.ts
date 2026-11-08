import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { startDiagnosticGatewayRuntime } from '../scripts/lib/diagnostic-gateway-runtime.mjs';
import { input, fixture } from './fixtures/final-gateway-session-memory.ts';
function runtime() {
    const f = fixture(),
        child: any = new EventEmitter();
    const selected = {
        root: '/owned/gateway/install',
        nodePath: '/owned/node/bin/node',
        port: input().port,
        token: input().token,
        version: input().version,
    };
    const session = {
        attemptId: input().attemptId,
        target: input().target,
        expectedProbes: input().expectedProbes,
    };
    Object.assign(child, {
        pid: 77,
        spawnfile: selected.nodePath,
        spawnargs: [selected.nodePath, selected.root + '/dist-gateway/main.cjs'],
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        exitCode: null,
        signalCode: null,
    });
    let complete: Function = () => {},
        joined: Function = () => {},
        signals = 0;
    const completion = new Promise<any>((yes) => {
            complete = yes;
        }),
        join = new Promise<any>((yes) => {
            joined = yes;
        });
    const launches: any[] = [];
    const ports = {
        ...f.ports,
        launch(file: string, args: string[], options: any) {
            launches.push({ file, args, options });
            return child;
        },
        observer: {
            observeChild(value: any) {
                assert.equal(value, child);
                return { completion, joined: join };
            },
        },
    };
    child.kill = (signal: string) => {
        signals++;
        assert.equal(signal, 'SIGTERM');
        queueMicrotask(() => {
            child.stdout.emit('close');
            child.stderr.emit('close');
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
            complete({
                sha256: 'd'.repeat(64),
                record: { installation: { files: [{ path: 'explicit-fake-census' }] } },
            });
            joined();
        });
        return true;
    };
    const ready = () => {
        child.emit('spawn');
        child.stdout.emit(
            'data',
            Buffer.from(
                'Diagnostic Hub gateway listening on 127.0.0.1:' +
                    selected.port +
                    '. Place behind HTTPS for website use.\n',
            ),
        );
    };
    return { ...f, ports, selected, session, launches, child, ready, signals: () => signals };
}
test('shipping CLI owner runs health/auth then public collection before its one normal shutdown request', async () => {
    const f = runtime(),
        owner = startDiagnosticGatewayRuntime(f.selected, f.ports, f.session);
    assert.equal(f.requests.length, 0);
    f.ready();
    const result = await owner.result;
    await owner.closed;
    assert.equal(f.signals(), 1);
    assert.equal(f.requests.length, 10);
    assert.deepEqual(
        result.receipt.checks.map((r: any) => r.status),
        [200, 401, 403],
    );
    assert.equal(result.receipt.publicSession.probeRows, 1);
    assert.equal(result.receipt.observationSHA256, 'd'.repeat(64));
    assert.equal(result.receipt.publicSession.authenticatedProducerProvenance, null);
    assert.equal(result.receipt.releaseAcceptance, false);
    assert.equal(result.receipt.wholeGroupRetirement, null);
    assert.equal(owner.snapshot().retired, true);
    assert.equal(owner.snapshot().sessionWorkload.requestOwners, 0);
    assert.deepEqual(JSON.parse(f.launches[0].options.env.HUB_TARGETS_JSON), [
        { host: '127.0.0.1', port: input().target.port, fingerprint: input().target.fingerprint },
    ]);
    assert.ok(!JSON.stringify(f.launches[0].options.env).includes(input().target.password));
    assert.ok(!JSON.stringify(result.receipt).includes(input().target.password));
});
test('unsupported session target refuses before any child, timer or request is acquired', () => {
    const f = runtime();
    f.session.target.host = 'not-loopback';
    assert.throws(() => startDiagnosticGatewayRuntime(f.selected, f.ports, f.session));
    assert.equal(f.launches.length, 0);
    assert.equal(f.timers.length, 0);
    assert.equal(f.requests.length, 0);
});
test('failed collection cancels once and keeps a failed outcome after normal CLI closure', async () => {
    const f = runtime();
    f.controls.mutate = (role: string, value: any) => {
        if (role === 'snapshot') value.results[0].stdout = 'wrong';
    };
    const owner = startDiagnosticGatewayRuntime(f.selected, f.ports, f.session);
    f.ready();
    await assert.rejects(owner.result);
    await owner.closed;
    assert.equal(f.signals(), 1);
    assert.equal(f.requests.filter((r) => r.role === 'cancel').length, 1);
    assert.equal(owner.snapshot().failed, true);
    assert.equal(owner.snapshot().retired, true);
});
test('closed direct child cannot retire the outer owner while workload HTTP closure remains pending', async () => {
    const f = runtime();
    f.controls.holdRole = 'cancel';
    f.controls.mutate = (role: string, value: any) => {
        if (role === 'snapshot') value.results[0].truncated = true;
    };
    const owner = startDiagnosticGatewayRuntime(f.selected, f.ports, f.session);
    f.ready();
    await assert.rejects(owner.result);
    await f.pulse();
    assert.equal(f.signals(), 1);
    assert.equal(owner.snapshot().childClosed, true);
    assert.equal(owner.snapshot().retired, false);
    f.close(f.requests.find((r) => r.role === 'cancel'));
    await owner.closed;
    assert.equal(owner.snapshot().failed, true);
    assert.equal(owner.snapshot().retired, true);
});
