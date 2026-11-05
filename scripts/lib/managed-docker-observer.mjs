import assert from 'node:assert/strict';

export const DOCKER_OBSERVATION_BOUNDS = Object.freeze({
    deadlineMs: 30_000,
    inspectBytes: 65_536,
    statsBytes: 262_144,
    requests: 3,
});
const retained = new Set();
export const retainedDockerObservationCount = () => retained.size;
const object = (v) => assert.ok(v && typeof v === 'object' && !Array.isArray(v));
const text = (v, max) => assert.ok(typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0'));
const wireNumbers = new WeakMap();
function wireInteger(value, signed = false) {
    const token = value && typeof value === 'object' ? wireNumbers.get(value) : undefined;
    assert.ok(typeof token === 'string' && (signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(token));
    const number = Number(token);
    assert.ok(Number.isSafeInteger(number));
    return number;
}
function unsupportedAsync(value) {
    if (value && typeof value.then === 'function') {
        Promise.resolve(value).catch(() => {}); // Observe only; unsupported settlement cannot retire custody.
        return true;
    }
    return false;
}

export class DockerObservationFailure extends Error {
    constructor(code, cause, owner) {
        super('Managed Docker observation failed or remains held: ' + code, { cause });
        this.code = code;
        this.owner = owner;
    }
}

/** Observation only. No transport defaults, creation, execution, teardown or release capability.
 * The registration belongs to an external custodian; matching it does not prove who created the
 * container. The injected transport must enforce the response bound while reading and bind each
 * local request token to its actual response/closure. RPC retirement never retires the container.
 */
export function startManagedDockerObservation(registration, ports) {
    object(registration);
    assert.deepEqual(Object.keys(registration).sort(), ['containerId', 'createdAt', 'imageId', 'labels']);
    assert.match(registration.containerId, /^[a-f0-9]{64}$/);
    assert.match(registration.imageId, /^sha256:[a-f0-9]{64}$/);
    text(registration.createdAt, 64);
    object(registration.labels);
    const labels = Object.entries(registration.labels);
    assert.ok(labels.length > 0 && labels.length <= 8);
    for (const [name, value] of labels) { text(name, 128); text(value, 256); }
    for (const name of ['beginRequest', 'now', 'setTimer', 'clearTimer']) assert.equal(typeof ports[name], 'function');
    ports = Object.freeze(Object.fromEntries(['beginRequest', 'now', 'setTimer', 'clearTimer'].map((name) => [name, ports[name]])));
    const selected = structuredClone(registration);
    const started = ports.now();
    assert.ok(Number.isFinite(started) && started >= 0);
    let failure, timer, timerState = 'unregistered', flowDone = false, resultDone = false;
    let resolveResult, rejectResult, resolveRetirement, retirementDone = false;
    const leases = [], failureCodes = [];
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    result.catch(() => {});
    const rpcRetirement = new Promise((resolve) => { resolveRetirement = resolve; });
    const snapshot = () => ({
        failure: failure?.code ?? null,
        failureCodes: [...failureCodes],
        requests: leases.length,
        pendingResults: leases.filter((r) => !r.resultSettled).length,
        pendingRetirement: leases.filter((r) => !r.retired).length,
        uncertainDispatch: leases.some((r) => r.uncertain),
        timerState,
        rpcRetired: retirementDone,
        containerOwnership: 'external-custodian-required',
        wholeGroupRetirement: null,
        releaseQualified: false,
    });
    const owner = Object.freeze({ result, snapshot, waitForRpcRetirement: () => rpcRetirement });
    retained.add(owner);
    function fail(code, cause) {
        if (!failureCodes.includes(code)) failureCodes.push(code); // Finite internal codes; no response content.
        failure ??= new DockerObservationFailure(code, cause, owner);
        if (!resultDone) { resultDone = true; rejectResult(failure); }
    }
    function finish() {
        if (!flowDone || timerState !== 'retired' || leases.some((r) => r.uncertain || !r.resultSettled || !r.retired)) return;
        if (!retirementDone) {
            retirementDone = true;
            for (const lease of leases) lease.handle = undefined;
            retained.delete(owner);
            resolveRetirement(Object.freeze({ scope: 'rpc-only', wholeGroupRetirement: null }));
        }
    }
    function clearDeadline() {
        if (timerState === 'retired') return;
        if (timerState !== 'active') return;
        try {
            const acknowledgement = ports.clearTimer(timer);
            assert.ok(!unsupportedAsync(acknowledgement) && acknowledgement === undefined, 'Synchronous void clear acknowledgement required');
            timerState = 'retired';
        }
        catch (error) { timerState = 'uncertain'; fail('deadline-retirement', error); }
    }
    function decode(response, lease, limit) {
        object(response);
        assert.equal(response.requestToken, lease.token);
        assert.equal(response.statusCode, 200);
        assert.ok(response.body instanceof Uint8Array);
        assert.ok(response.body.byteLength <= limit);
        // Modern reviver source context preserves the token before Number rounding. Unsupported
        // engines fail closed; ignored Docker numeric fields are never projected as measurements.
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body), (_key, value, context) => {
            if (typeof value !== 'number') return value;
            assert.equal(typeof context?.source, 'string', 'JSON numeric source context required');
            const marker = Object.freeze(Object.create(null));
            wireNumbers.set(marker, context.source);
            return marker;
        });
        object(parsed);
        return parsed;
    }
    async function read(path, limit) {
        if (failure) throw failure;
        assert.ok(leases.length < DOCKER_OBSERVATION_BOUNDS.requests);
        const lease = { token: Symbol('owned-docker-read'), resultSettled: false, retired: false, uncertain: true };
        leases.push(lease); // Register before acquisition/dispatch; a throw cannot release custody.
        let request;
        try {
            request = ports.beginRequest(Object.freeze({
                requestToken: lease.token, method: 'GET', path, maxResponseBytes: limit,
                deadlineMs: DOCKER_OBSERVATION_BOUNDS.deadlineMs,
            }));
            lease.handle = request; // Keep the transport's custody handle reachable on rejected/unknown closure.
            object(request);
            // Even a malformed partial handle may carry a rejecting promise. Observe it while
            // retaining uncertain acquisition; this does not manufacture a retirement ack.
            for (const name of ['result', 'retirement']) if (request[name] instanceof Promise) request[name].catch(() => {});
            assert.ok(request.result instanceof Promise && request.retirement instanceof Promise);
            lease.uncertain = false;
        } catch (error) {
            fail('request-acquisition', error);
            throw failure;
        }
        // Attach both handlers before awaiting either promise. Rejection is not retirement.
        const retirement = request.retirement.then((ack) => {
            try {
                object(ack);
                assert.equal(ack.requestToken, lease.token);
                assert.equal(ack.requestClosed, true);
                assert.equal(ack.responseClosed, true);
                lease.retired = true;
            } catch (error) { fail('request-retirement', error); }
            finish();
        }, (error) => { fail('request-retirement', error); finish(); });
        const response = request.result.then((value) => {
            lease.resultSettled = true;
            if (failure) throw failure;
            try { return decode(value, lease, limit); }
            catch { fail('response-validation', undefined); throw failure; }
        }, (error) => { lease.resultSettled = true; fail('request-result', error); throw failure; });
        try {
            const value = await response;
            await retirement;
            if (failure) throw failure;
            return value;
        } finally { finish(); }
    }
    function inspect(value) {
        assert.equal(value.Id, selected.containerId);
        assert.equal(value.Image, selected.imageId); // Docker image/config ID, not OCI manifest provenance.
        assert.equal(value.Created, selected.createdAt);
        const restartCount = wireInteger(value.RestartCount);
        assert.equal(restartCount, 0, 'Only the registered, unrestarted execution is supported');
        object(value.Config); object(value.Config.Labels);
        for (const [name, expected] of Object.entries(selected.labels)) assert.equal(value.Config.Labels[name], expected);
        const s = value.State; object(s);
        assert.ok(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(s.Status));
        assert.ok(!['restarting', 'removing'].includes(s.Status), 'Unsupported concurrent lifecycle action');
        for (const name of ['Running', 'Paused', 'Restarting', 'OOMKilled', 'Dead']) assert.equal(typeof s[name], 'boolean');
        const pid = wireInteger(s.Pid), exitCode = wireInteger(s.ExitCode, true);
        assert.equal(typeof s.Error, 'string');
        text(s.StartedAt, 64); text(s.FinishedAt, 64);
        assert.equal(s.Running, ['running', 'paused'].includes(s.Status));
        assert.equal(s.Paused, s.Status === 'paused');
        assert.equal(s.Restarting, s.Status === 'restarting');
        assert.equal(s.Dead, s.Status === 'dead');
        // State errors are represented without exposing raw daemon messages or user content.
        return Object.freeze({ status: s.Status, running: s.Running, paused: s.Paused,
            restarting: s.Restarting, oomKilled: s.OOMKilled, dead: s.Dead, pid,
            exitCode, daemonErrorPresent: s.Error.length > 0,
            startedAt: s.StartedAt, finishedAt: s.FinishedAt });
    }
    async function run() {
        try {
            timerState = 'uncertain';
            try {
                timer = ports.setTimer(() => {
                    timerState = 'retired';
                    fail('deadline', undefined); // Observation failure only; no cancel/kill or retry.
                    finish();
                }, DOCKER_OBSERVATION_BOUNDS.deadlineMs);
                assert.ok(!unsupportedAsync(timer) && (typeof timer === 'object' && timer !== null || Number.isSafeInteger(timer) && timer > 0), 'Synchronous timer handle required');
            } catch (error) { fail('deadline-acquisition', error); throw failure; }
            if (timerState === 'uncertain') timerState = 'active';
            if (failure) return;
            const base = '/v1.51/containers/' + selected.containerId;
            const before = inspect(await read(base + '/json', DOCKER_OBSERVATION_BOUNDS.inspectBytes));
            const stats = await read(base + '/stats?stream=false&one-shot=true', DOCKER_OBSERVATION_BOUNDS.statsBytes);
            assert.equal(stats.id, selected.containerId);
            object(stats.pids_stats);
            const current = wireInteger(stats.pids_stats.current), limit = wireInteger(stats.pids_stats.limit);
            const after = inspect(await read(base + '/json', DOCKER_OBSERVATION_BOUNDS.inspectBytes));
            assert.equal(after.startedAt, before.startedAt, 'Execution changed during sampling');
            const elapsedMs = ports.now() - started;
            assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= DOCKER_OBSERVATION_BOUNDS.deadlineMs);
            clearDeadline();
            if (failure) return;
            resultDone = true;
            resolveResult(Object.freeze({
                schema: 'managed-docker-observation-v1', sampling: 'inspect-stats-inspect-non-atomic',
                containerId: selected.containerId, imageId: selected.imageId, createdAt: selected.createdAt,
                before, after, pids: Object.freeze({ current, limit }),
                elapsedMs, registrationMatched: true, creationOwnershipProved: false,
                wholeGroupRetirement: null, normalRetirementProved: false, releaseQualified: false,
            }));
        } catch { if (!failure) fail('observation', undefined); } // Schema errors must not retain raw daemon values.
        finally { flowDone = true; clearDeadline(); finish(); }
    }
    // A handler is installed before the first request, including for synchronous acquisition errors.
    run().catch((error) => { fail('observer-internal', error); flowDone = true; clearDeadline(); finish(); });
    return owner;
}
