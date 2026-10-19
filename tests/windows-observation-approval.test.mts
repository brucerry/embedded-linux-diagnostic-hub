// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import {
    observationPolicy,
    observationDigest,
    approvalName,
    validateObservationDecision,
    pollObservationApproval,
    observationAuthority,
    assertObservationAuthority,
    observationPorts,
} from '../scripts/lib/windows-observation-approval.mjs';
import { observationOutcome } from '../scripts/lib/observation-outcome.mjs';
const sha = 'a'.repeat(64),
    commit = 'b'.repeat(40);
test('activation proposal declares the fence without invoking host context', () => {
    assert.equal(observationPolicy.executionEnabled, true);
    assert.equal(Object.isFrozen(observationPolicy), true);
});
function fixture() {
    const manifest = { sourceSHA256: sha },
        binding = {
            schema: 1,
            kind: observationPolicy.kind,
            host: {
                repository: 'brucerry/embedded-linux-diagnostic-hub',
                run: '123',
                attempt: '1',
                commit,
                event: 'workflow_dispatch',
                environment: 'github-hosted',
            },
            nonce: '11111111-1111-4111-8111-111111111111',
            supervisorPID: process.pid,
            sourceSHA256: sha,
            policySHA256: observationDigest(observationPolicy),
            coverageSHA256: sha,
            manifestSHA256: observationDigest(manifest),
            platform: 'win32',
            arch: 'x64',
            createdUTC: '2026-10-19T12:00:00.000Z',
            runtime: {
                node: { version: 'v24.22.0', path: 'node', sha256: sha },
                electron: { version: '44.5.1', path: 'electron', sha256: sha },
            },
            preparationStartedAt: 1,
            preparationDeadline: 1 + observationPolicy.preparationMs,
            policy: structuredClone(observationPolicy),
        };
    const artifact = {
            id: 7,
            name: approvalName(binding),
            expired: false,
            size_in_bytes: 1024,
            workflow_run: { id: 456 },
        },
        run = {
            id: 456,
            path: observationPolicy.approvalWorkflow,
            event: 'workflow_dispatch',
            run_attempt: 1,
            status: 'completed',
            conclusion: 'success',
            actor: { login: 'brucerry' },
            triggering_actor: { login: 'brucerry' },
            head_sha: commit,
            repository: { full_name: binding.host.repository },
            created_at: '2026-10-19T12:01:00Z',
        },
        decision = {
            schema: 1,
            decision: 'approve-one-normal-pair',
            parentRun: '123',
            bindingSHA256: observationDigest(binding),
            sourceSHA256: sha,
            commit,
        };
    return { manifest, binding, artifact, run, decision };
}
const mutations = [
    (f) => (f.decision.parentRun = '124'),
    (f) => (f.decision.bindingSHA256 = 'c'.repeat(64)),
    (f) => (f.decision.sourceSHA256 = 'c'.repeat(64)),
    (f) => (f.decision.commit = 'c'.repeat(40)),
    (f) => (f.decision.extra = true),
    (f) => (f.run.actor.login = 'another'),
    (f) => (f.run.triggering_actor.login = 'another'),
    (f) => (f.run.event = 'push'),
    (f) => (f.run.path = 'other.yml'),
    (f) => (f.run.run_attempt = 2),
    (f) => (f.run.head_sha = 'c'.repeat(40)),
    (f) => (f.run.repository.full_name = 'another/repo'),
    (f) => (f.run.created_at = '2026-10-19T11:59:00Z'),
    (f) => (f.artifact.expired = true),
    (f) => (f.artifact.name = 'unbound'),
    (f) => (f.artifact.workflow_run.id = 789),
    (f) => (f.run.conclusion = 'failure'),
    (f) => (f.artifact.size_in_bytes = 32769),
];
for (const [ordinal, mutate] of mutations.entries())
    test('approval rejects replay/context mutation ' + ordinal, () => {
        const f = fixture();
        mutate(f);
        assert.throws(() => validateObservationDecision(f.binding, f.artifact, f.run, f.decision));
    });
async function receipt(f, extra = {}) {
    const calls = [];
    const zip = zipSync({ 'approval.json': strToU8(JSON.stringify(f.decision)) });
    const fetchPort = async (url, options) => {
        calls.push({ url, options });
        if (url.includes('/actions/artifacts?'))
            return new Response(JSON.stringify({ artifacts: [f.artifact] }));
        if (url.endsWith('/actions/runs/456')) return new Response(JSON.stringify(f.run));
        if (url.endsWith('/actions/artifacts/7/zip'))
            return new Response(null, {
                status: 302,
                headers: { location: 'https://approved-download.invalid/zip' },
            });
        assert.equal(options.headers, undefined);
        assert.equal(options.redirect, 'error');
        return new Response(extra.zip ?? zip);
    };
    return {
        approved: await pollObservationApproval(f.binding, 'never-log-this-token', {
            fetchPort,
            wait: () => {
                throw Error('Unexpected poll');
            },
        }),
        calls,
    };
}
test('read-only approval transport binds authenticated run metadata and never forwards API credentials to archive redirect', async () => {
    const f = fixture(),
        { approved, calls } = await receipt(f);
    assert.equal(approved.bindingSHA256, observationDigest(f.binding));
    assert.equal(calls.length, 4);
    assert(
        calls
            .slice(0, 3)
            .every((c) =>
                c.url.startsWith(
                    'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/',
                ),
            ),
    );
});
test('archive expansion and foreign entry controls refuse before returning an approval capability', async () => {
    for (const zip of [
        zipSync({ 'approval.json': new Uint8Array(8193) }),
        zipSync({ 'other.json': strToU8('{}') }),
        zipSync({ 'approval.json': strToU8('{}'), extra: strToU8('x') }),
    ])
        await assert.rejects(receipt(fixture(), { zip }));
});
test('one live authority rejects JSON replay, changed manifest, cancellation and repeated controller acquisition', async () => {
    const f = fixture(),
        { approved } = await receipt(f);
    let released = false,
        cancelled = false,
        checks = 0;
    const lease = {
        check() {
            checks++;
            assert(!released);
        },
        release(proof) {
            assert(Object.values(proof).every(Boolean));
            released = true;
        },
        state() {
            return { retained: !released, released };
        },
    };
    const authority = observationAuthority(f.binding, f.manifest, approved, {
        preparationClosed: true,
        lease,
        ownerCheck: () => {},
        check() {
            assert(!cancelled);
        },
    });
    assert.throws(() => assertObservationAuthority({}, f.manifest));
    assert.throws(() =>
        observationAuthority(f.binding, f.manifest, structuredClone(approved), {
            preparationClosed: true,
        }),
    );
    assert.throws(() => assertObservationAuthority(authority, { sourceSHA256: 'c'.repeat(64) }));
    const ports = observationPorts(authority, f.manifest);
    ports.lease.acquire();
    assert.throws(() => ports.lease.acquire());
    cancelled = true;
    assert.throws(() => ports.lease.check());
    cancelled = false;
    ports.lease.release({ closed: true });
    assert(released && checks > 0);
    assert.throws(() => assertObservationAuthority(authority, f.manifest));
});
test('manual approval deadline cancellation aborts polling before another request or capability', async () => {
    const f = fixture();
    let requests = 0,
        checks = 0;
    await assert.rejects(
        pollObservationApproval(f.binding, 'token', {
            check() {
                if (++checks === 3) throw Error('cancelled');
            },
            fetchPort: async () => {
                requests++;
                return new Response(JSON.stringify({ artifacts: [] }));
            },
            wait: async () => {},
        }),
        /cancelled/,
    );
    assert.equal(requests, 1);
});
test('observation outcomes keep raw completion, product failure, insufficient workload and unknown closure distinct', () => {
    const receipt = {
        status: 'collected-product-calibration-evidence',
        failure: null,
        achievedWarmupMs: 300000,
        achievedMeasuredMs: 1500000,
        cycles: 100,
        missing: [],
    };
    assert.equal(
        observationOutcome({ ownershipComplete: true, complete: true, receipt }).status,
        'COMPLETE_RAW_OBSERVATION',
    );
    assert.equal(
        observationOutcome({
            ownershipComplete: true,
            complete: false,
            receipt: { ...receipt, cycles: 99 },
        }).status,
        'INCOMPLETE_UNQUALIFIED_OBSERVATION',
    );
    assert.equal(
        observationOutcome({
            ownershipComplete: true,
            complete: false,
            receipt,
            failure: 'Soak lifetime budget: physicalBytes',
        }).status,
        'INCOMPLETE_UNQUALIFIED_OBSERVATION',
    );
    assert.equal(
        observationOutcome({
            ownershipComplete: true,
            complete: false,
            receipt,
            failure: 'Capture CRC mismatch',
        }).status,
        'PRODUCT_OWNERSHIP_INTEGRITY_FAILURE',
    );
    for (const x of [{ ownershipComplete: false }, { ownershipComplete: true, durable: false }])
        assert.equal(
            observationOutcome({ ...x, complete: true, receipt }).status,
            'INVALID_UNKNOWN_CLOSURE_OR_DURABILITY',
        );
    assert.equal(
        observationOutcome({ ownershipComplete: true, complete: true, receipt }).memoryQualified,
        false,
    );
});
