import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
    prepareFinalGatewaySession,
    GATEWAY_SESSION_BOUNDS,
} from '../scripts/lib/final-gateway-session.mjs';
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
import { input, fixture } from './fixtures/final-gateway-session-memory.ts';
test('one-use public session flow uses seven actual HTTP owner exchanges and emits no sensitive content', async () => {
    const f = fixture(),
        selected = input(),
        prepared = prepareFinalGatewaySession(selected, f.ports);
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.length, 0);
    selected.token = 'd'.repeat(64);
    selected.target.password = 'changed-password-canary';
    const o = prepared.start(),
        result = await o.result;
    await o.closed;
    assert.throws(() => prepared.start());
    assert.deepEqual(
        f.requests.map((r) => r.role),
        ['fingerprint', 'connect', 'heartbeat', 'snapshot', 'disconnect', 'gone', 'health'],
    );
    assert.equal(f.requests[0].body.password, undefined);
    assert.equal(f.requests[1].body.password, input().target.password);
    assert.equal(f.requests[1].body.expectedFingerprint, input().target.fingerprint);
    assert.equal(f.requests[1].body.attemptId, input().attemptId);
    assert.equal(result.probeRows, 1);
    assert.equal(result.releaseAcceptance, false);
    assert.equal(result.authenticatedProducerProvenance, null);
    assert.equal(result.wholeGroupRetirement, null);
    assert.equal(o.snapshot().requestOwners, 0);
    assert.equal(o.snapshot().terminal, true);
    assert.ok(f.timers.every((r) => r.cleared));
    const text = JSON.stringify(result);
    for (const secret of [
        input().token,
        input().target.password,
        input().attemptId,
        'c'.repeat(32),
        input().target.fingerprint,
        'synthetic-kernel',
    ])
        assert.ok(!text.includes(secret));
});
test('late callback from an acknowledged retired timer cannot rewrite terminal success', async () => {
    const f = fixture(),
        owner = prepareFinalGatewaySession(input(), f.ports).start();
    const result = await owner.result;
    await owner.closed;
    const before = owner.snapshot();
    const stale = f.timers.find((row) => row.ms === GATEWAY_SESSION_BOUNDS.totalMs);
    assert.equal(stale.cleared, true);
    stale.fn();
    assert.deepEqual(owner.snapshot(), before);
    assert.equal(owner.snapshot().failed, false);
    assert.equal(result.releaseAcceptance, false);
});
for (const [label, mutate] of [
    [
        'nonloopback',
        (x: any) => {
            x.target.host = 'device';
        },
    ],
    [
        'low target port',
        (x: any) => {
            x.target.port = 22;
        },
    ],
    [
        'same port',
        (x: any) => {
            x.target.port = x.port;
        },
    ],
    [
        'wrong fingerprint',
        (x: any) => {
            x.target.fingerprint = 'unknown';
        },
    ],
    [
        'weak password',
        (x: any) => {
            x.target.password = 'short';
        },
    ],
    [
        'bad attempt owner',
        (x: any) => {
            x.attemptId = 'short';
        },
    ],
    [
        'duplicate probe',
        (x: any) => {
            x.expectedProbes.push({ ...x.expectedProbes[0] });
        },
    ],
    [
        'unexpected option',
        (x: any) => {
            x.shell = true;
        },
    ],
] as const)
    test('preparation refuses ' + label + ' without requests or timers', () => {
        const f = fixture(),
            x = input();
        mutate(x);
        assert.throws(() => prepareFinalGatewaySession(x, f.ports));
        assert.equal(f.requests.length, 0);
        assert.equal(f.timers.length, 0);
    });
for (const [label, mutate] of [
    [
        'wrong fingerprint',
        (r: string, x: any) => {
            if (r === 'fingerprint') x.fingerprint = 'SHA256:' + 'B'.repeat(43);
        },
    ],
    [
        'lost session identity',
        (r: string, x: any) => {
            if (r === 'connect') delete x.sessionId;
        },
    ],
    [
        'invalid session identity',
        (r: string, x: any) => {
            if (r === 'connect') x.sessionId = '../escape';
        },
    ],
    [
        'missing probe',
        (r: string, x: any) => {
            if (r === 'snapshot') x.results = [];
        },
    ],
    [
        'wrong probe',
        (r: string, x: any) => {
            if (r === 'snapshot') x.results[0].id = 'wrong';
        },
    ],
    [
        'wrong stdout',
        (r: string, x: any) => {
            if (r === 'snapshot') x.results[0].stdout = 'wrong';
        },
    ],
    [
        'wrong status',
        (r: string, x: any) => {
            if (r === 'snapshot') x.results[0].status = 'error';
        },
    ],
    [
        'truncated',
        (r: string, x: any) => {
            if (r === 'snapshot') x.results[0].truncated = true;
        },
    ],
    [
        'password echo',
        (r: string, x: any) => {
            if (r === 'snapshot') x.results[0].stdout = input().target.password;
        },
    ],
    [
        'bad disconnect acknowledgement',
        (r: string, x: any) => {
            if (r === 'disconnect') x.disconnected = false;
        },
    ],
    [
        'nonzero public sessions',
        (r: string, x: any) => {
            if (r === 'health') x.activeSessions = 1;
        },
    ],
] as const)
    test('public behavior fails closed on ' + label + ' and never replays connection', async () => {
        const f = fixture();
        f.controls.mutate = mutate;
        const o = prepareFinalGatewaySession(input(), f.ports).start();
        await assert.rejects(o.result);
        await o.closed;
        assert.ok(f.requests.filter((r) => r.role === 'connect').length <= 1);
        const cleanupExpected = !['wrong fingerprint', 'nonzero public sessions'].includes(label);
        assert.equal(f.requests.filter((r) => r.role === 'cancel').length, cleanupExpected ? 1 : 0);
        if (cleanupExpected)
            assert.deepEqual(f.requests.find((r) => r.role === 'cancel').body, {
                attemptId: input().attemptId,
            });
        assert.equal(o.snapshot().failed, true);
        assert.equal(o.snapshot().requestOwners, 0);
    });
for (const mode of ['duplicate-key', 'invalid-UTF8', 'oversize'])
    test('bounded response parsing rejects ' + mode + ' without promoting late close', async () => {
        const f = fixture();
        f.controls.rawRole = 'connect';
        f.controls.raw =
            mode === 'duplicate-key'
                ? Buffer.from('{"sessionId":"wrong","sessionId":"' + 'c'.repeat(32) + '"}')
                : mode === 'invalid-UTF8'
                  ? Buffer.from([0xff])
                  : Buffer.alloc(4097, 0x20);
        const o = prepareFinalGatewaySession(input(), f.ports).start();
        await assert.rejects(o.result);
        await o.closed;
        assert.equal(o.snapshot().failed, true);
        assert.equal(f.requests.filter((r) => r.role === 'cancel').length, 1);
    });
test('a failed creation reply still cancels the known attempt exactly once', async () => {
    const f = fixture();
    f.controls.statusWrong = 'connect';
    const o = prepareFinalGatewaySession(input(), f.ports).start();
    await assert.rejects(o.result);
    await o.closed;
    assert.equal(f.requests.filter((r) => r.role === 'cancel').length, 1);
    assert.equal(f.requests.filter((r) => r.role === 'connect').length, 1);
});
test('deadline retains a pending request until actual response, request and socket closure', async () => {
    const f = fixture();
    f.controls.holdRole = 'connect';
    const o = prepareFinalGatewaySession(input(), f.ports).start();
    await f.pulse();
    f.expire();
    await assert.rejects(o.result);
    await f.pulse();
    assert.equal(o.snapshot().terminal, false);
    assert.ok(o.snapshot().requestOwners > 0);
    f.close(f.requests.find((r) => r.role === 'connect'));
    await o.closed;
    assert.equal(o.snapshot().failed, true);
    assert.equal(o.snapshot().terminal, true);
});
test('unacknowledged timer retirement retains custody despite successful HTTP behavior', async () => {
    const f = fixture();
    const original = f.ports.clearTimer;
    f.ports.clearTimer = (t: any) => {
        if (t.ms === GATEWAY_SESSION_BOUNDS.totalMs) return Promise.resolve();
        return original(t);
    };
    const o = prepareFinalGatewaySession(input(), f.ports).start();
    await assert.rejects(o.result);
    await f.pulse();
    assert.equal(o.snapshot().terminal, false);
    assert.equal(o.snapshot().timerUnknown, true);
});
for (const phase of ['acquire', 'retire'])
    test('throwing timer ' + phase + ' cannot discharge uncertain custody', async () => {
        const f = fixture();
        if (phase === 'acquire')
            f.ports.setTimer = () => {
                throw Error('inert allocation uncertainty');
            };
        else {
            const clear = f.ports.clearTimer;
            f.ports.clearTimer = (t: any) => {
                if (t.ms === GATEWAY_SESSION_BOUNDS.totalMs) throw Error('inert clear uncertainty');
                return clear(t);
            };
        }
        const o = prepareFinalGatewaySession(input(), f.ports).start();
        await assert.rejects(o.result);
        await f.pulse();
        assert.equal(o.snapshot().terminal, false);
        assert.equal(o.snapshot().timerUnknown, true);
    });

test('public route and default-collection source contract is bound to the reviewed shipping bytes', () => {
    const pins = {
        'gateway/main.ts': 'b0ca00d35e5630b1dd1bf7e30476d391916224c809ef538f5e7044aee2d3e8d4',
        'gateway/server.ts': '5b3eac41a69a6e33c0761453618bf31dcb46d2a92294295f46026efecffd3fba',
        'backend/ssh/session.ts':
            '8cae1798cf782af8e6afe95c111d8dd177f69d525bacdd09df70c62b9460520f',
        'shared/diagnostics/probes.ts':
            '45ee9fc12d98bcde7f2a4cedb3b64921399e71928f02eb6ce9331bac6cce156b',
    };
    for (const [file, pin] of Object.entries(pins))
        assert.equal(hash(readFileSync(file)), pin, file);
    const server = readFileSync('gateway/server.ts', 'utf8');
    for (const text of [
        "url.pathname === '/api/fingerprint'",
        "url.pathname === '/api/sessions'",
        "url.pathname === '/api/connection-attempts/cancel'",
        'send(res, 201, { sessionId: id })',
        'send(res, 200, { disconnected: true })',
        'send(res, 200, await active.ssh.collect(options))',
    ])
        assert.ok(server.includes(text));
});
