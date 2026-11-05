import assert from 'node:assert/strict';
import test from 'node:test';
import { startManagedDockerObservation, DOCKER_OBSERVATION_BOUNDS, retainedDockerObservationCount } from '../scripts/lib/managed-docker-observer.mjs';

const id = 'a'.repeat(64), image = 'sha256:' + 'b'.repeat(64);
const created = '2026-11-05T00:00:00Z', started = '2026-11-05T00:00:01Z';
const registration = () => ({ containerId: id, imageId: image, createdAt: created, labels: { 'test.owner': 'owned-synthetic-282' } });
const inspection = () => ({ Id: id, Image: image, Created: created, RestartCount: 0,
    Config: { Labels: { 'test.owner': 'owned-synthetic-282' }, Env: ['SECRET=never-record'] },
    State: { Status: 'running', Running: true, Paused: false, Restarting: false, OOMKilled: false,
        Dead: false, Pid: 123, ExitCode: 0, Error: '', StartedAt: started, FinishedAt: '0001-01-01T00:00:00Z' } });
const stats = () => ({ id, pids_stats: { current: 3, limit: 128 }, name: 'do-not-record' });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function fixture(values = [inspection(), stats(), inspection()], hooks = {}) {
    const calls = [], timers = new Map(); let time = 100, cleared = 0;
    const ports = {
        now: () => time,
        setTimer: (fn, ms) => { assert.equal(ms, 30_000); timers.set(1, fn); return 1; },
        clearTimer: (token) => { assert.equal(token, 1); cleared++; timers.delete(token); },
        beginRequest: (request) => {
            calls.push(request);
            const token = request.requestToken;
            const response = { requestToken: token, statusCode: 200, body: new TextEncoder().encode(JSON.stringify(values[calls.length - 1])) };
            const ack = { requestToken: token, requestClosed: true, responseClosed: true };
            return hooks.begin ? hooks.begin(request, response, ack, calls.length) : { result: Promise.resolve(response), retirement: Promise.resolve(ack) };
        },
    };
    return { ports, calls, timers, cleared: () => cleared, time: (v) => { time = v; },
        expire: () => { time += 30_000; const fn = timers.get(1); timers.delete(1); fn(); } };
}
async function rejected(owner, code) {
    const error = await owner.result.then(() => assert.fail('Expected failure'), (e) => e);
    assert.equal(error.code, code); assert.equal(error.owner, owner); return error;
}

test('three exact GETs bind service identity and retain non-atomic PID observations without qualifying retirement', async () => {
    const f = fixture(), owner = startManagedDockerObservation(registration(), f.ports);
    const r = await owner.result; await owner.waitForRpcRetirement();
    assert.deepEqual(f.calls.map(({ method, path }) => [method, path]), [
        ['GET', '/v1.51/containers/' + id + '/json'],
        ['GET', '/v1.51/containers/' + id + '/stats?stream=false&one-shot=true'],
        ['GET', '/v1.51/containers/' + id + '/json'],
    ]);
    assert.deepEqual(f.calls.map((r) => r.maxResponseBytes), [65536, 262144, 65536]);
    assert.equal(new Set(f.calls.map((r) => r.requestToken)).size, 3);
    assert.equal(r.sampling, 'inspect-stats-inspect-non-atomic'); assert.equal(r.registrationMatched, true);
    assert.equal(r.creationOwnershipProved, false); assert.equal(r.normalRetirementProved, false);
    assert.equal(r.wholeGroupRetirement, null); assert.equal(r.releaseQualified, false);
    assert.deepEqual(r.pids, { current: 3, limit: 128 });
    assert.equal(JSON.stringify(r).includes('never-record'), false); assert.equal(JSON.stringify(r).includes('do-not-record'), false);
    assert.equal(f.cleared(), 1); assert.equal(owner.snapshot().rpcRetired, true);
});

test('terminal zero-PID and zero exit code remain observations, never a normal group-retirement proof', async () => {
    const v = inspection(); Object.assign(v.State, { Status: 'exited', Running: false, Pid: 0, FinishedAt: '2026-11-05T00:00:02Z' });
    const f = fixture([v, { id, pids_stats: { current: 0, limit: 0 } }, v]);
    const r = await startManagedDockerObservation(registration(), f.ports).result;
    assert.equal(r.pids.current, 0); assert.equal(r.normalRetirementProved, false); assert.equal(r.releaseQualified, false);
});

test('normal state progress preserves both windows instead of attaching a sampled count to final state', async () => {
    const end = inspection(); Object.assign(end.State, { Status: 'exited', Running: false, Pid: 0, ExitCode: 7,
        Error: 'private daemon detail', OOMKilled: true, FinishedAt: '2026-11-05T00:00:02Z' });
    const f = fixture([inspection(), stats(), end]), r = await startManagedDockerObservation(registration(), f.ports).result;
    assert.equal(r.before.status, 'running'); assert.equal(r.after.status, 'exited'); assert.equal(r.after.exitCode, 7);
    assert.equal(r.after.oomKilled, true); assert.equal(r.after.daemonErrorPresent, true);
    assert.equal(JSON.stringify(r).includes('private daemon detail'), false); assert.equal(r.releaseQualified, false);
});

for (const [name, change] of [
    ['short ID', (r) => { r.containerId = 'aaaa'; }], ['path selector', (r) => { r.containerId = '../other'; }],
    ['image tag', (r) => { r.imageId = 'node:latest'; }], ['empty labels', (r) => { r.labels = {}; }],
    ['extra action field', (r) => { r.create = true; }],
]) test('registration rejects ' + name + ' before request acquisition', () => {
    const r = registration(), f = fixture(); change(r); assert.throws(() => startManagedDockerObservation(r, f.ports)); assert.equal(f.calls.length, 0);
});

for (const [name, change] of [
    ['different container', (r) => { r.Id = 'c'.repeat(64); }], ['different image', (r) => { r.Image = 'sha256:' + 'c'.repeat(64); }],
    ['different creation', (r) => { r.Created += 'x'; }], ['missing owner label', (r) => { r.Config.Labels = {}; }],
    ['restarted execution', (r) => { r.RestartCount = 1; }], ['malformed state boolean', (r) => { r.State.Running = 'true'; }],
    ['unsupported restart', (r) => { r.State.Status = 'restarting'; r.State.Restarting = true; }],
]) test('inspect fails closed on ' + name, async () => {
    const v = inspection(); change(v); const f = fixture([v]); const owner = startManagedDockerObservation(registration(), f.ports);
    await rejected(owner, 'observation'); await owner.waitForRpcRetirement(); assert.equal(f.calls.length, 1);
});

for (const [name, change] of [
    ['other stats ID', (r) => { r.id = 'd'.repeat(64); }], ['absent counter', (r) => { delete r.pids_stats.current; }],
    ['unsafe integer', (r) => { r.pids_stats.current = 2 ** 53; }], ['negative count', (r) => { r.pids_stats.current = -1; }],
    ['fractional limit', (r) => { r.pids_stats.limit = 1.5; }],
]) test('PID sample rejects ' + name, async () => {
    const v = stats(); change(v); const f = fixture([inspection(), v]); const owner = startManagedDockerObservation(registration(), f.ports);
    await rejected(owner, 'observation'); await owner.waitForRpcRetirement(); assert.equal(f.calls.length, 2);
});

test('restart between samples fails without using a stale count for a replacement execution', async () => {
    const v = inspection(); v.State.StartedAt = '2026-11-05T00:00:03Z';
    const f = fixture([inspection(), stats(), v]); const owner = startManagedDockerObservation(registration(), f.ports);
    await rejected(owner, 'observation'); await owner.waitForRpcRetirement(); assert.equal(f.calls.length, 3);
});

for (const [name, change] of [
    ['HTTP failure', (r) => { r.statusCode = 404; }], ['wrong request token', (r) => { r.requestToken = Symbol('stale'); }],
    ['oversize', (r) => { r.body = new Uint8Array(65537); }], ['bad UTF8', (r) => { r.body = new Uint8Array([0xff]); }],
    ['invalid JSON', (r) => { r.body = new TextEncoder().encode('{'); }],
]) test('response rejects ' + name + ' and still waits for RPC close', async () => {
    const held = deferred(); const f = fixture(undefined, { begin: (q, r, a) => { change(r); held.ack = a; return { result: Promise.resolve(r), retirement: held.promise }; } });
    const owner = startManagedDockerObservation(registration(), f.ports); await rejected(owner, 'response-validation');
    assert.equal(owner.snapshot().rpcRetired, false); held.resolve(held.ack); await owner.waitForRpcRetirement(); assert.equal(f.calls.length, 1);
});

test('response settlement alone cannot dispatch the next request before acknowledged RPC closure', async () => {
    const held = deferred(); const f = fixture(undefined, { begin: (q, r, a, n) => {
        if (n === 1) held.ack = a;
        return { result: Promise.resolve(r), retirement: n === 1 ? held.promise : Promise.resolve(a) };
    } });
    const owner = startManagedDockerObservation(registration(), f.ports); await tick();
    assert.equal(f.calls.length, 1); assert.equal(owner.snapshot().pendingRetirement, 1);
    held.resolve(held.ack); await owner.result; await owner.waitForRpcRetirement(); assert.equal(f.calls.length, 3);
});

test('timeout does not cancel, retry, dispatch again or retire pending IO; late close preserves failure', async () => {
    const result = deferred(), retirement = deferred(); let response, ack;
    const f = fixture(undefined, { begin: (q, r, a) => { response = r; ack = a; return { result: result.promise, retirement: retirement.promise }; } });
    const owner = startManagedDockerObservation(registration(), f.ports); f.expire(); await rejected(owner, 'deadline');
    assert.equal(owner.snapshot().rpcRetired, false); assert.equal(f.calls.length, 1);
    result.resolve(response); retirement.resolve(ack); await owner.waitForRpcRetirement();
    assert.equal(owner.snapshot().failure, 'deadline'); assert.equal(f.calls.length, 1);
});

test('request rejection preserves original error while cleanup rejection retains custody', async () => {
    const primary = new Error('primary port failure'), retirement = deferred();
    const f = fixture(undefined, { begin: () => ({ result: Promise.reject(primary), retirement: retirement.promise }) });
    const owner = startManagedDockerObservation(registration(), f.ports); const error = await rejected(owner, 'request-result');
    assert.equal(error.cause, primary); retirement.reject(new Error('secondary close failure')); await tick();
    assert.equal(owner.snapshot().failure, 'request-result'); assert.equal(owner.snapshot().pendingRetirement, 1); assert.equal(owner.snapshot().rpcRetired, false);
    assert.ok(owner.snapshot().failureCodes.includes('request-retirement'));
});

test('stale acknowledgement cannot release another owner', async () => {
    const held = deferred(); let oldAck;
    const a = fixture(undefined, { begin: (q, r, ack, n) => { if (n === 1) oldAck = ack; return { result: Promise.resolve(r), retirement: n === 1 ? held.promise : Promise.resolve(ack) }; } });
    const first = startManagedDockerObservation(registration(), a.ports); await tick();
    const b = fixture(undefined, { begin: (q, r) => ({ result: Promise.resolve(r), retirement: Promise.resolve(oldAck) }) });
    const second = startManagedDockerObservation(registration(), b.ports); await rejected(second, 'request-retirement'); await tick();
    assert.equal(second.snapshot().rpcRetired, false); assert.equal(first.snapshot().pendingRetirement, 1);
    held.resolve(oldAck); await first.result; await first.waitForRpcRetirement(); assert.equal(second.snapshot().rpcRetired, false);
});

test('uncertain dispatch remains held and no follow-up request is attempted', async () => {
    const before = retainedDockerObservationCount(); const f = fixture(); f.ports.beginRequest = () => { throw new Error('unknown dispatch outcome'); };
    const owner = startManagedDockerObservation(registration(), f.ports); await rejected(owner, 'request-acquisition');
    assert.equal(owner.snapshot().uncertainDispatch, true); assert.equal(owner.snapshot().rpcRetired, false);
    assert.equal(retainedDockerObservationCount(), before + 1);
});

test('mutable registration and ports cannot redirect an admitted pending observation', async () => {
    const held = deferred(); const f = fixture(undefined, { begin: (q, r, a, n) => {
        if (n === 1) held.ack = a; return { result: Promise.resolve(r), retirement: n === 1 ? held.promise : Promise.resolve(a) };
    } });
    const reg = registration(), owner = startManagedDockerObservation(reg, f.ports);
    reg.containerId = 'c'.repeat(64); reg.labels['test.owner'] = 'changed'; f.ports.beginRequest = () => { throw new Error('replacement port'); };
    held.resolve(held.ack); const r = await owner.result; assert.equal(r.containerId, id); assert.equal(f.calls.length, 3);
});

test('timer close uncertainty remains held rather than claiming RPC retirement', async () => {
    const f = fixture(); let attempts = 0; f.ports.clearTimer = () => { attempts++; throw new Error('timer clear uncertain'); };
    const owner = startManagedDockerObservation(registration(), f.ports); await rejected(owner, 'deadline-retirement');
    assert.equal(owner.snapshot().rpcRetired, false); assert.equal(attempts, 1); f.expire(); await owner.waitForRpcRetirement();
    assert.equal(owner.snapshot().failure, 'deadline-retirement');
});

test('bounds are fixed and immutable', () => {
    assert.equal(Object.isFrozen(DOCKER_OBSERVATION_BOUNDS), true); assert.equal(DOCKER_OBSERVATION_BOUNDS.requests, 3);
});

for (const token of ['9007199254740991.1', '1.00000000000000001', '3e0', '-0', '1e309']) {
    test('PID wire token is never rounded/coerced into a supported count: ' + token, async () => {
        const f = fixture(undefined, { begin: (q, r, a, n) => {
            if (n === 2) r.body = new TextEncoder().encode('{"id":"' + id + '","pids_stats":{"current":' + token + ',"limit":128}}');
            return { result: Promise.resolve(r), retirement: Promise.resolve(a) };
        } });
        const owner = startManagedDockerObservation(registration(), f.ports); await rejected(owner, 'observation');
        await owner.waitForRpcRetirement(); assert.equal(f.calls.length, 2);
    });
}

for (const [field, from, to] of [['RestartCount', '0', '0.00000000000000001'], ['Pid', '123', '123.00000000000000001'], ['ExitCode', '0', '0.00000000000000001']]) {
    test('selected inspect wire integer rejects fractional token for ' + field, async () => {
        const f = fixture(undefined, { begin: (q, r, a) => {
            const raw = new TextDecoder().decode(r.body); assert.ok(raw.includes('"' + field + '":' + from));
            r.body = new TextEncoder().encode(raw.replace('"' + field + '":' + from, '"' + field + '":' + to));
            return { result: Promise.resolve(r), retirement: Promise.resolve(a) };
        } });
        const owner = startManagedDockerObservation(registration(), f.ports); await rejected(owner, 'observation');
        await owner.waitForRpcRetirement(); assert.equal(f.calls.length, 1);
    });
}

for (const mode of ['held', 'rejected']) test('unsupported asynchronous timer acquisition stays held: ' + mode, async () => {
    const f = fixture(), pending = deferred();
    f.ports.setTimer = () => mode === 'held' ? pending.promise : Promise.reject(new Error('async timer rejected'));
    const owner = startManagedDockerObservation(registration(), f.ports); await rejected(owner, 'deadline-acquisition'); await tick();
    assert.equal(f.calls.length, 0); assert.equal(owner.snapshot().timerState, 'uncertain'); assert.equal(owner.snapshot().rpcRetired, false);
    if (mode === 'held') { pending.resolve(1); await tick(); assert.equal(owner.snapshot().rpcRetired, false); }
});

for (const mode of ['held', 'rejected']) test('unsupported asynchronous timer clear never acknowledges retirement: ' + mode, async () => {
    const f = fixture(), pending = deferred(); let attempts = 0;
    f.ports.clearTimer = () => { attempts++; return mode === 'held' ? pending.promise : Promise.reject(new Error('async clear rejected')); };
    const owner = startManagedDockerObservation(registration(), f.ports); await rejected(owner, 'deadline-retirement'); await tick();
    assert.equal(attempts, 1); assert.equal(owner.snapshot().rpcRetired, false);
    if (mode === 'held') { pending.resolve(); await tick(); assert.equal(owner.snapshot().rpcRetired, false); }
    f.expire(); await owner.waitForRpcRetirement(); assert.equal(owner.snapshot().failure, 'deadline-retirement');
});

for (const mode of ['syntax', 'label']) test('schema/parser failure cannot leak daemon content via error cause: ' + mode, async () => {
    const marker = 'PRIVATE_DAEMON_282_MARKER'; const v = inspection(); v.Config.Labels['test.owner'] = marker;
    const f = fixture([v], { begin: (q, r, a) => {
        if (mode === 'syntax') r.body = new TextEncoder().encode('{"secret":"' + marker + '", invalid}');
        return { result: Promise.resolve(r), retirement: Promise.resolve(a) };
    } });
    const owner = startManagedDockerObservation(registration(), f.ports);
    const error = await rejected(owner, mode === 'syntax' ? 'response-validation' : 'observation');
    await owner.waitForRpcRetirement(); assert.equal(error.cause, undefined);
    assert.equal(String(error.stack).includes(marker), false); assert.equal(JSON.stringify(error).includes(marker), false);
});
