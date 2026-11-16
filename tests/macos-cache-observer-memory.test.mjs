import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createCacheMetadataObserver,
    CACHE_OBSERVER_LIMITS,
} from '../.github/scripts/macos-cache-observer.mjs';
import {
    CACHE_BRANCH,
    CACHE_WORKFLOW,
    CACHE_REPOSITORY,
} from '../.github/scripts/macos-cache-observation.mjs';
const source = 'a'.repeat(40);
const binding = () => ({ sha: source, ref: CACHE_BRANCH, attempt: 1, startedAt: 1000 });
const run = () => ({
    total_count: 1,
    workflow_runs: [
        {
            id: 123,
            head_sha: source,
            head_branch: CACHE_BRANCH.slice(11),
            event: 'push',
            run_attempt: 1,
            path: CACHE_WORKFLOW,
            repository: { id: 1405501450, full_name: CACHE_REPOSITORY, private: false },
            status: 'in_progress',
        },
    ],
});
function job(
    arch,
    status = 'completed',
    kind = 'CACHE_METADATA_CANDIDATE',
    reason = 'none',
    custody = 'CLOSED',
) {
    const pass = kind === 'CACHE_METADATA_CANDIDATE';
    return {
        id: arch === 'x64' ? 10 : 11,
        run_id: 123,
        run_attempt: 1,
        head_sha: source,
        name: `Cache metadata (${arch})`,
        labels: [arch === 'x64' ? 'macos-15-intel' : 'macos-15'],
        status,
        conclusion: status === 'completed' ? (pass ? 'success' : 'failure') : null,
        steps: [
            { name: 'Observe fixed cache metadata', status: 'completed', conclusion: 'success' },
            {
                name: `Cache ${arch} — ${kind} / ${reason} / ${custody}`,
                status: 'completed',
                conclusion: pass ? 'success' : 'failure',
            },
        ],
    };
}
const jobs = (...items) => ({ total_count: items.length, jobs: items });
const response = (body) => ({ status: 200, body: JSON.stringify(body), requestComplete: true });
function setup(items) {
    let now = 1000;
    const requests = [];
    const observer = createCacheMetadataObserver(binding(), {
        now: () => now,
        readMetadata: async (request) => {
            requests.push(request);
            const item = items.shift();
            return typeof item === 'function' ? item(request) : item;
        },
    });
    return {
        observer,
        requests,
        setTime: (value) => {
            now = value;
        },
    };
}

test('exact two-lane candidate reports close after two bounded metadata requests', async () => {
    const s = setup([response(run()), response(jobs(job('x64'), job('arm64')))]);
    await s.observer.next();
    const state = await s.observer.next();
    assert.equal(state.reason, 'terminal-two-jobs');
    assert.equal(state.pending, false);
    assert.equal(state.requestCompletion, 'returned');
    assert.equal(state.requests, 2);
    assert.equal(state.jobs.length, 2);
    assert.equal(state.nativeQualification, false);
    assert.equal(state.resourceRetirement, 'unverified');
    await s.observer.next();
    assert.equal(s.requests.length, 2);
    assert.deepEqual(
        s.requests.map((r) => [r.kind, r.timeoutMs, r.maxBytes]),
        [
            ['runs', 10000, 131072],
            ['jobs', 10000, 131072],
        ],
    );
});
test('finite refusal is observed as nonpassing and does not prove resource retirement', async () => {
    const s = setup([
        response(run()),
        response(
            jobs(
                job('x64', 'completed', 'REFUSED', 'unsafe', 'NO_DESCRIPTOR'),
                job('arm64', 'completed', 'REFUSED', 'closure-unknown', 'RETAINED_UNKNOWN'),
            ),
        ),
    ]);
    await s.observer.next();
    const v = await s.observer.next();
    assert.equal(v.reason, 'terminal-two-jobs');
    assert.equal(v.jobs[1].classification.custody, 'RETAINED_UNKNOWN');
    assert.equal(v.releaseAcceptance, false);
});
test('optional third request is the fixed maximum, without resetting the window', async () => {
    const active = () => response(jobs(job('x64', 'in_progress'), job('arm64', 'in_progress')));
    const s = setup([response(run()), active(), active()]);
    await s.observer.next();
    await s.observer.next();
    const v = await s.observer.next();
    assert.equal(v.reason, 'request-limit');
    assert.equal(v.requests, 3);
    assert.equal(v.deadline, 361000);
    await s.observer.next();
    assert.equal(s.requests.length, 3);
});
for (const [name, mutate] of [
    ['wrong SHA', (r) => (r.workflow_runs[0].head_sha = 'b'.repeat(40))],
    ['wrong branch', (r) => (r.workflow_runs[0].head_branch = 'other')],
    ['wrong event', (r) => (r.workflow_runs[0].event = 'workflow_dispatch')],
    ['second attempt', (r) => (r.workflow_runs[0].run_attempt = 2)],
    ['private repository', (r) => (r.workflow_runs[0].repository.private = true)],
    ['wrong workflow', (r) => (r.workflow_runs[0].path = '.github/workflows/release.yml')],
    ['ambiguous run', (r) => (r.total_count = 2)],
])
    test(`${name} stops before any job request`, async () => {
        const r = run();
        mutate(r);
        const s = setup([response(r)]);
        assert.equal((await s.observer.next()).reason, 'metadata-uncertain');
        await s.observer.next();
        assert.equal(s.requests.length, 1);
    });
for (const [name, value] of [
    ['denied', { status: 403, body: 'not published', requestComplete: true }],
    ['malformed', { status: 200, body: '{', requestComplete: true }],
    ['oversized', { status: 200, body: ' '.repeat(131073), requestComplete: true }],
    ['missing closure', { status: 200, body: JSON.stringify(run()) }],
])
    test(`${name} response stops closed without raw response exposure`, async () => {
        const s = setup([value]);
        const v = await s.observer.next();
        assert.equal(v.reason, 'metadata-uncertain');
        assert.equal(s.requests.length, 1);
        assert.equal(JSON.stringify(v).includes('not published'), false);
    });
test('rejected metadata port preserves unknown request completion', async () => {
    const s = setup([
        () => {
            throw undefined;
        },
    ]);
    const v = await s.observer.next();
    assert.equal(v.pending, false);
    assert.equal(v.requestCompletion, 'unknown');
    assert.equal(v.closed, true);
});
test('request returned after timeout is not parsed even inside outer deadline', async () => {
    const s = setup([
        () => {
            s.setTime(16000);
            return response(run());
        },
    ]);
    const v = await s.observer.next();
    assert.equal(v.reason, 'request-timeout');
    assert.equal(v.requestCompletion, 'returned');
    assert.equal(v.runId, null);
    assert.equal(v.pending, false);
});
test('expired deadline or insufficient request time starts no request', async () => {
    for (const at of [361000, 355000]) {
        const s = setup([]);
        s.setTime(at);
        assert.equal((await s.observer.next()).reason, 'deadline');
        assert.equal(s.requests.length, 0);
    }
});
test('a late result after the hard deadline does not update observed identity', async () => {
    const s = setup([
        () => {
            s.setTime(361001);
            return response(run());
        },
    ]);
    const v = await s.observer.next();
    assert.equal(v.reason, 'deadline');
    assert.equal(v.runId, null);
    assert.equal(v.requestCompletion, 'returned');
});
test('pause during an outstanding request retains it until the port returns', async () => {
    let finish;
    const s = setup([
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    ]);
    const inFlight = s.observer.next();
    assert.equal(s.observer.state().pending, true);
    s.observer.pause();
    assert.equal(s.observer.state().pending, true);
    await s.observer.next();
    assert.equal(s.requests.length, 1);
    finish(response(run()));
    const v = await inFlight;
    assert.equal(v.reason, 'pause');
    assert.equal(v.pending, false);
    assert.equal(v.runId, null);
});
test('concurrent next cannot create a second outstanding request', async () => {
    let finish;
    const s = setup([
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    ]);
    const inFlight = s.observer.next();
    await s.observer.next();
    assert.equal(s.requests.length, 1);
    finish(response(run()));
    await inFlight;
});
test('backward clock stops instead of extending the budget', async () => {
    const s = setup([]);
    s.setTime(999);
    assert.equal((await s.observer.next()).reason, 'clock');
    assert.equal(s.requests.length, 0);
});
for (const [name, mutate] of [
    [
        'duplicate lane',
        (v) => {
            v.jobs[1] = structuredClone(v.jobs[0]);
        },
    ],
    ['wrong job attempt', (v) => (v.jobs[0].run_attempt = 2)],
    ['wrong job source', (v) => (v.jobs[0].head_sha = 'b'.repeat(40))],
    ['wrong lane label', (v) => (v.jobs[0].labels = ['unrelated'])],
    ['partial candidate output', (v) => (v.jobs[0].steps[0].conclusion = 'failure')],
    ['failed report', (v) => (v.jobs[0].steps[1].conclusion = 'failure')],
    ['malformed finite label', (v) => (v.jobs[0].steps[1].name = 'Cache x64 — invalid')],
])
    test(`${name} cannot become metadata pass`, async () => {
        const j = jobs(job('x64'), job('arm64'));
        mutate(j);
        const s = setup([response(run()), response(j)]);
        await s.observer.next();
        assert.equal((await s.observer.next()).reason, 'metadata-uncertain');
    });
test('cancelled job without a final report leaves operation/custody unobserved', async () => {
    const j = job('x64');
    j.conclusion = 'cancelled';
    j.steps = [];
    const s = setup([response(run()), response(jobs(j, job('arm64')))]);
    await s.observer.next();
    const v = await s.observer.next();
    assert.equal(v.jobs[0].classification.status, 'NOT_OBSERVED');
    assert.equal(v.jobs[0].classification.custody, 'NOT_OBSERVED');
});
test('returned snapshots cannot rewrite retained classifications', async () => {
    const s = setup([response(run()), response(jobs(job('x64'), job('arm64')))]);
    await s.observer.next();
    const v = await s.observer.next();
    v.jobs[0].classification.reason = 'changed';
    assert.equal(s.observer.state().jobs[0].classification.reason, 'none');
});
test('empty run and empty jobs stop rather than starting discovery loops', async () => {
    const empty = setup([response({ total_count: 0, workflow_runs: [] })]);
    assert.equal((await empty.observer.next()).reason, 'metadata-uncertain');
    const s = setup([response(run()), response(jobs())]);
    await s.observer.next();
    assert.equal((await s.observer.next()).reason, 'incomplete-jobs');
});
test('binding and limits cannot be enlarged by caller labels', () => {
    assert.throws(() =>
        createCacheMetadataObserver(
            { ...binding(), attempt: 2 },
            { now: () => 1000, readMetadata: () => {} },
        ),
    );
    assert.deepEqual(CACHE_OBSERVER_LIMITS, {
        requests: 3,
        durationMs: 360000,
        requestTimeoutMs: 10000,
        responseBytes: 131072,
    });
});
