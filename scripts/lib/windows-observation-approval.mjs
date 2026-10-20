import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import fs from 'node:fs';
import { observationSharedCredits } from './observation-accounting.mjs';
const executionFence = JSON.parse(
    fs.readFileSync(new URL('./observation-execution.json', import.meta.url), 'utf8'),
);
export const observationPolicy = Object.freeze({
    schema: 1,
    kind: 'windows-normal-raw-observation-pair-v1',
    executionEnabled: executionFence.enabled,
    preparationMs: 1200000,
    jobMs: 2400000,
    reserveMs: 60000,
    cohortMs: 4800000,
    workflowMinutes: 130,
    approvalPollMs: 10000,
    requestMs: 10000,
    approver: 'brucerry',
    approvalWorkflow: '.github/workflows/windows-portable.yml',
    warmupMs: 300000,
    measuredMs: 1500000,
    minimumCycles: 100,
    sampleTargetMs: 250,
    bodyBytes: 34603008,
    fragmentBytes: 16384,
    viewer: true,
    freshPtyRequired: true,
    sharedCredits: observationSharedCredits,
    memoryQualified: false,
    retries: 0,
});
export const observationDigest = (value) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipts = new WeakSet(),
    authorities = new WeakMap();
const digestPattern = /^[a-f0-9]{64}$/;
export function approvalName(binding) {
    return 'windows-observation-approval-' + binding.host.run + '-' + observationDigest(binding);
}
export function validateObservationBinding(b) {
    assert.equal(b.schema, 1);
    assert.equal(b.kind, observationPolicy.kind);
    assert.equal(b.host.repository, 'brucerry/embedded-linux-diagnostic-hub');
    assert.equal(b.host.attempt, '1');
    assert.equal(b.host.event, 'workflow_dispatch');
    assert.equal(b.host.environment, 'github-hosted');
    assert(/^[1-9]\d{0,19}$/.test(b.host.run));
    assert(/^[a-f0-9]{40}$/.test(b.host.commit));
    assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(b.nonce));
    assert(Number.isSafeInteger(b.supervisorPID) && b.supervisorPID > 0);
    for (const key of ['sourceSHA256', 'policySHA256', 'coverageSHA256', 'manifestSHA256'])
        assert(digestPattern.test(b[key]));
    assert.equal(b.policySHA256, observationDigest(observationPolicy));
    assert.equal(b.platform, 'win32');
    assert.equal(b.arch, 'x64');
    assert.equal(b.runtime.node.version, 'v24.22.0');
    assert.equal(b.runtime.electron.version, '44.5.1');
    for (const row of Object.values(b.runtime))
        assert(typeof row.path === 'string' && digestPattern.test(row.sha256));
    assert.equal(new Date(b.createdUTC).toISOString(), b.createdUTC);
    assert(
        Number.isSafeInteger(b.preparationStartedAt) && Number.isSafeInteger(b.preparationDeadline),
    );
    assert.equal(b.preparationDeadline - b.preparationStartedAt, observationPolicy.preparationMs);
    assert.deepEqual(b.policy, observationPolicy);
    return b;
}
export function validateObservationDecision(b, artifact, run, decision) {
    validateObservationBinding(b);
    assert.equal(artifact.name, approvalName(b));
    assert.equal(artifact.expired, false);
    assert(
        Number.isSafeInteger(artifact.size_in_bytes) &&
            artifact.size_in_bytes > 0 &&
            artifact.size_in_bytes <= 32768,
    );
    assert.equal(artifact.workflow_run.id, run.id);
    assert.equal(run.path, observationPolicy.approvalWorkflow);
    assert.equal(run.event, 'workflow_dispatch');
    assert.equal(run.run_attempt, 1);
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'success');
    assert.equal(run.actor.login, observationPolicy.approver);
    assert.equal(run.triggering_actor.login, observationPolicy.approver);
    assert.equal(run.head_sha, b.host.commit);
    assert.notEqual(String(run.id), b.host.run);
    assert.equal(run.repository.full_name, b.host.repository);
    assert(Date.parse(run.created_at) >= Date.parse(b.createdUTC));
    assert.deepEqual(decision, {
        schema: 1,
        decision: 'approve-one-normal-pair',
        parentRun: b.host.run,
        bindingSHA256: observationDigest(b),
        sourceSHA256: b.sourceSHA256,
        commit: b.host.commit,
    });
    return decision;
}
async function boundedResponse(response, limit) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > limit) throw Error('Approval response bound');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
/** Read-only API access. No tokens, signed download URLs or credentials enter evidence. */
export async function pollObservationApproval(
    binding,
    token,
    {
        fetchPort = fetch,
        check = () => {},
        record = () => {},
        guard = check,
        wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    } = {},
) {
    validateObservationBinding(binding);
    assert(typeof token === 'string' && token.length > 0);
    const base = 'https://api.github.com/repos/' + binding.host.repository;
    const api = async (relative, redirect = 'error') => {
        check();
        const response = await fetchPort(base + relative, {
            redirect,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(observationPolicy.requestMs),
        });
        check();
        return response;
    };
    for (
        let poll = 0;
        poll < observationPolicy.preparationMs / observationPolicy.approvalPollMs;
        poll++
    ) {
        check();
        const response = await api(
            '/actions/artifacts?name=' + encodeURIComponent(approvalName(binding)) + '&per_page=10',
        );
        assert.equal(response.status, 200);
        const listingBytes = await boundedResponse(response, 131072);
        guard();
        const listing = JSON.parse(listingBytes.toString());
        assert(Array.isArray(listing.artifacts) && listing.artifacts.length <= 10);
        for (const artifact of listing.artifacts) {
            assert.equal(artifact.name, approvalName(binding));
            const reply = await api('/actions/runs/' + artifact.workflow_run.id);
            assert.equal(reply.status, 200);
            const runBytes = await boundedResponse(reply, 131072);
            guard();
            const run = JSON.parse(runBytes.toString());
            if (run.status !== 'completed') continue;
            validateObservationDecision(binding, artifact, run, {
                schema: 1,
                decision: 'approve-one-normal-pair',
                parentRun: binding.host.run,
                bindingSHA256: observationDigest(binding),
                sourceSHA256: binding.sourceSHA256,
                commit: binding.host.commit,
            });
            const archive = await api('/actions/artifacts/' + artifact.id + '/zip', 'manual');
            assert.equal(archive.status, 302);
            const location = new URL(archive.headers.get('location'));
            assert.equal(location.protocol, 'https:');
            assert(!location.username && !location.password);
            // URL is supplied by the authenticated GitHub endpoint; credentials are omitted on the download.
            guard();
            const download = await fetchPort(location.href, {
                redirect: 'error',
                signal: AbortSignal.timeout(observationPolicy.requestMs),
            });
            guard();
            assert.equal(download.status, 200);
            const zip = await boundedResponse(download, 32768);
            guard();
            let files = 0;
            const extracted = unzipSync(zip, {
                filter: (entry) => {
                    assert(
                        ++files === 1 &&
                            entry.name === 'approval.json' &&
                            entry.originalSize <= 8192,
                    );
                    return true;
                },
            });
            assert.equal(files, 1);
            assert(extracted['approval.json']?.length <= 8192);
            const decision = JSON.parse(Buffer.from(extracted['approval.json']).toString());
            validateObservationDecision(binding, artifact, run, decision);
            check();
            const receipt = Object.freeze({
                artifactID: artifact.id,
                approvalRunID: run.id,
                decision,
                bindingSHA256: observationDigest(binding),
                actor: run.actor.login,
            });
            receipts.add(receipt);
            record('same-host-human-approval', receipt);
            return receipt;
        }
        await wait(observationPolicy.approvalPollMs);
        guard();
    }
    throw Error('Same-host approval preparation deadline');
}
/** One live owner and one in-memory capability. A JSON manifest is never an approval capability. */
export function observationAuthority(binding, manifest, receipt, ports) {
    assert(receipts.has(receipt), 'Authenticated manual approval receipt required.');
    assert.equal(receipt.bindingSHA256, observationDigest(binding));
    assert.equal(observationDigest(manifest), binding.manifestSHA256);
    assert.equal(ports.preparationClosed, true);
    const frozen = structuredClone(manifest),
        authority = Object.freeze({}),
        manifestHash = observationDigest(frozen);
    const freeze = (value) => {
        if (value && typeof value === 'object') {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
        }
        return value;
    };
    const state = {
        binding: freeze(structuredClone(binding)),
        manifestHash,
        ports,
        acquired: false,
        released: false,
    };
    authorities.set(authority, state);
    return authority;
}
export function assertObservationAuthority(authority, manifest) {
    const state = authorities.get(authority);
    assert(state, 'Live same-host approval/custody capability required.');
    assert(!state.released);
    assert.equal(observationDigest(manifest), state.manifestHash);
    assert.equal(
        state.remote ? process.ppid : process.pid,
        state.binding.supervisorPID,
        'Approval cannot move to another owner process.',
    );
    state.ports.check();
    state.ports.lease.check();
    return state;
}
export function observationPorts(authority, manifest) {
    const state = assertObservationAuthority(authority, manifest);
    if (state.remote) return state.ports;
    return {
        ownerCheck: state.ports.ownerCheck,
        lease: {
            acquire() {
                assertObservationAuthority(authority, manifest);
                assert(!state.acquired);
                state.acquired = true;
            },
            check() {
                assertObservationAuthority(authority, manifest);
            },
            state() {
                return state.ports.lease.state();
            },
            release(proof) {
                assertObservationAuthority(authority, manifest);
                assert(state.acquired);
                state.ports.lease.release(proof);
                state.released = true;
            },
        },
    };
}
/** Only the inherited live IPC receiver constructs this proxy; no manifest/CLI field mints it. */
export function remoteObservationAuthority(manifest, parentPID, ports) {
    assert.equal(parentPID, process.ppid);
    assert.equal(process.connected, true);
    const authority = Object.freeze({});
    authorities.set(authority, {
        remote: true,
        binding: { supervisorPID: parentPID },
        manifestHash: observationDigest(manifest),
        ports,
        released: false,
    });
    return authority;
}
