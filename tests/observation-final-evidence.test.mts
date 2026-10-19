// Deterministic reviewer reproduction: virtual children only, temporary test marker.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { collectProductPreparation, limits } from '../scripts/lib/product-collector-controller.mjs';
import { RootGuard, ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { ObservationHandoff } from '../scripts/lib/observation-handoff.mjs';
import {
    observationPolicy,
    observationDigest,
    approvalName,
    pollObservationApproval,
    observationAuthority,
} from '../scripts/lib/windows-observation-approval.mjs';
import { productClock } from '../tests/fixtures/memory-product-owner.ts';
const require = createRequire(new URL('../package.json', import.meta.url));
const { zipSync, strToU8 } = require('fflate');
const sha = 'a'.repeat(64),
    commit = 'b'.repeat(40);
async function authority(root) {
    const manifest = {
            sourceSHA256: sha,
            collectorSHA256: sha,
            outputRoot: root,
            node: { path: process.execPath },
            tsx: { path: require.resolve('tsx') },
            sshProfile: { path: 'fixture-only' },
            jobs: [
                { ordinal: 0, observerMode: 'sampled', gcMode: 'normal', expectedParentCode: 0 },
                { ordinal: 1, observerMode: 'no-sampler', gcMode: 'normal', expectedParentCode: 0 },
            ],
        },
        nonce = '11111111-1111-4111-8111-111111111111',
        lease = new ProductLease(path.join(path.dirname(root), 'test-marker'), { nonce });
    lease.acquire();
    const started = productClock.now(),
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
            nonce,
            supervisorPID: process.pid,
            sourceSHA256: sha,
            policySHA256: observationDigest(observationPolicy),
            coverageSHA256: sha,
            manifestSHA256: observationDigest(manifest),
            platform: 'win32',
            arch: 'x64',
            createdUTC: '2026-10-19T12:00:00.000Z',
            runtime: {
                node: { path: 'node', sha256: sha, version: 'v24.22.0' },
                electron: { path: 'electron', sha256: sha, version: '44.5.1' },
            },
            preparationStartedAt: started,
            preparationDeadline: started + observationPolicy.preparationMs,
            policy: observationPolicy,
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
    const receipt = await pollObservationApproval(binding, 'dummy', {
        fetchPort: async (url) => {
            if (url.includes('?name='))
                return new Response(JSON.stringify({ artifacts: [artifact] }));
            if (url.endsWith('/runs/456')) return new Response(JSON.stringify(run));
            if (url.endsWith('/7/zip'))
                return new Response(null, {
                    status: 302,
                    headers: { location: 'https://test.invalid/zip' },
                });
            return new Response(zipSync({ 'approval.json': strToU8(JSON.stringify(decision)) }));
        },
    });
    return {
        manifest,
        nonce,
        lease,
        authority: observationAuthority(binding, manifest, receipt, {
            lease,
            check() {},
            ownerCheck: () => {},
            preparationClosed: true,
        }),
    };
}
class Clock {
    time = 0;
    serial = 0;
    timers = new Map();
    now = () => this.time;
    set = (fn, ms) => {
        const id = ++this.serial;
        this.timers.set(id, { fn, at: this.time + ms });
        return id;
    };
    clear = (id) => this.timers.delete(id);
    advance(ms) {
        const target = this.time + ms;
        for (;;) {
            const next = [...this.timers]
                .filter(([, v]) => v.at <= target)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!next) break;
            this.time = next[1].at;
            this.timers.delete(next[0]);
            next[1].fn();
        }
        this.time = target;
    }
}
class Child extends EventEmitter {
    pid = 123;
    connected = true;
    sends = [];
    kills = [];
    send(value, cb) {
        this.sends.push(value);
        if (this.sendThrows) throw Error('send throw');
        cb?.(this.sendError ?? null);
    }
    kill(sig) {
        this.kills.push(sig);
        throw Error('middle owner must never be killed');
    }
    finish(code = 0) {
        this.emit('exit', code, null);
        this.emit('close', code, null);
    }
}
const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};
const manifest = () => ({
    sourceSHA256: 'a'.repeat(64),
    collectorSHA256: 'b'.repeat(64),
    jobs: [0, 1].map((ordinal) => ({
        ordinal,
        observerMode: ordinal === 0 ? 'sampled' : 'no-sampler',
        gcMode: 'normal',
        expectedParentCode: 0,
    })),
});
function harness(options = {}) {
    const clock = new Clock(),
        events = new EventEmitter(),
        children = [],
        records = new Map(),
        order = [];
    let owned = false,
        released = false,
        closed = false,
        durable = true,
        summary = false;
    const ports = {
        owner: { fixtureOnly: true },
        manifestSHA256: 'c'.repeat(64),
        async verify(stage) {
            order.push(stage);
            if (options.verify) await options.verify(stage, { clock, events });
        },
        record(name, v) {
            order.push(name);
            if (options.recordFailure === name) {
                durable = false;
                throw Error('record failed');
            }
            assert(!records.has(name));
            records.set(name, structuredClone(v));
        },
        journal: {
            append(event, v) {
                order.push(event);
                if (options.journalFailure === event) {
                    durable = false;
                    throw Error('journal failure');
                }
            },
            close() {
                closed = true;
                if (options.journalCloseFailure) throw Error('journal close failure');
            },
            proof: () => closed && !options.journalCloseFailure,
        },
        evidenceComplete: () => durable,
        holdUnknown: async (value) => ({ ...value, modelHoldObserved: true }),
        lease: {
            acquire() {
                if (options.foreign) throw Error('foreign marker');
                owned = true;
            },
            check() {
                if (options.leaseDrift) throw Error('lease drift');
            },
            release(proof) {
                assert(Object.values(proof).every(Boolean));
                assert(closed);
                assert(records.has('result-before-release.json'));
                released = true;
                order.push('release');
            },
            state: () => ({
                created: owned,
                retained: owned && !released,
                identityConfirmed: owned,
            }),
        },
        begin(spec, admit, onFailure) {
            const job = admit(),
                child = new Child();
            child.pid += spec.ordinal;
            children.push(child);
            order.push('begin-' + spec.ordinal);
            queueMicrotask(() => {
                child.emit('spawn');
                if (options.start) options.start(child, spec, { clock, events, onFailure, ports });
                else child.finish(spec.expectedParentCode);
            });
            return {
                child,
                job,
                argv: ['fixture-only'],
                cwd: '/fixture-only',
                setup() {
                    if (options.setupFailure) throw Error('post-spawn setup failure');
                },
                cancel(reason) {
                    child.send({ kind: 'cancel-product-job', nonce: job.nonce, reason });
                },
                closeLogs: () => ({ complete: !options.logFailure }),
                async inspect(actualOutcome) {
                    if (options.inspect) return await options.inspect({ spec, job, actualOutcome });
                    return {
                        valid: !options.invalid,
                        ownershipComplete: !options.unknownLeaf,
                        error: options.invalid ? 'invalid fixture' : null,
                    };
                },
            };
        },
        summary() {
            summary = true;
            order.push('summary');
        },
    };
    return {
        clock,
        events,
        children,
        records,
        order,
        ports,
        state: () => ({ owned, released, summary }),
    };
}

import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { digest } from '../scripts/lib/product-collector-evidence.mjs';
const evidenceFaults = [
    'marker-release-write',
    'marker-release-sync',
    'marker-release-close',
    'completion-write',
    'completion-sync',
    'completion-close',
];
const protocolFaults = [
    'missing-ack',
    'replayed-ack',
    'foreign-ack',
    'ack-transport',
    'intent-transport',
    'digest-mismatch',
    'outcome-mismatch',
    'invalid-outcome',
    'receipt-zero',
    'receipt-over-limit',
];
for (const scenario of [
    'healthy',
    'known-incomplete',
    'known-product',
    ...evidenceFaults,
    ...protocolFaults,
])
    test('final evidence acknowledgment: ' + scenario, async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-final-evidence-'))),
            collection = path.join(root, 'collection');
        fs.mkdirSync(collection);
        const f = await authority(collection),
            h = harness(),
            held = [],
            parentHolds = [],
            open = new Map(),
            order = [];
        const recordRoot = path.join(root, 'child-evidence');
        fs.mkdirSync(recordRoot);
        let durable = true,
            sealed = false;
        const target = scenario.startsWith('marker-release-')
            ? 'marker-release.json'
            : scenario.startsWith('completion-')
              ? 'completion.json'
              : null;
        const fault = scenario.slice(scenario.lastIndexOf('-') + 1);
        const io = {
            ...fs,
            openSync(file, ...args) {
                const fd = fs.openSync(file, ...args);
                open.set(fd, path.basename(file));
                return fd;
            },
            writeSync(fd, ...args) {
                if (open.get(fd) === target && fault === 'write')
                    throw Error('late record write fault');
                return fs.writeSync(fd, ...args);
            },
            fsyncSync(fd) {
                if (open.get(fd) === target && fault === 'sync')
                    throw Error('late record sync fault');
                return fs.fsyncSync(fd);
            },
            closeSync(fd) {
                if (open.get(fd) === target && fault === 'close')
                    throw Error('late record close remains unknown');
                fs.closeSync(fd);
                open.delete(fd);
            },
        };
        const guard = new RootGuard(recordRoot, { io });
        h.ports.record = (name, value) => {
            order.push(name);
            assert(durable && !sealed, 'No evidence write after failure or final seal');
            const bytes = Buffer.from(JSON.stringify(value) + '\n');
            try {
                guard.write(name, bytes);
                h.records.set(name, structuredClone(value));
                return Object.freeze({ name, bytes: bytes.length, sha256: digest(bytes) });
            } catch (error) {
                durable = false;
                throw error;
            }
        };
        h.ports.evidenceComplete = () => durable;
        h.ports.holdUnknown = async (state) => {
            const owner = createOwnershipHold(state, h.ports.record, {
                interval: () => ({
                    ref() {
                        order.push('referenced-hold');
                    },
                }),
            });
            held.push({ ...state, hold: owner.snapshot() });
            return { ...state, modelHoldObserved: true };
        };
        const handoff = new ObservationHandoff(f.authority, f.manifest, {
            verify: async () => ({}),
            record() {},
            check() {},
            hold: (error) => parentHolds.push(String(error)),
            accounting: {
                scan() {},
                snapshot() {
                    return { fixtureOnly: true };
                },
            },
        });
        const child = Object.assign(new EventEmitter(), {
            pid: 333,
            connected: true,
            send(message, callback) {
                callback?.(
                    (scenario === 'ack-transport' && message.value?.evidenceClosed) ||
                        (scenario === 'intent-transport' && message.value?.deferred)
                        ? Error('ACK transport failed')
                        : null,
                );
            },
        });
        const send = (sequence, action, extra = {}) =>
            child.emit('message', {
                kind: 'windows-observation-custody-v1',
                nonce: f.nonce,
                sequence,
                manifestSHA256: observationDigest(f.manifest),
                action,
                ...extra,
            });
        const started = productClock.now(),
            cohort = {
                schema: 1,
                nonce: f.nonce,
                startedAt: started,
                deadlineMs: started + observationPolicy.cohortMs,
            };
        try {
            handoff.bind(child, f.nonce, cohort);
            send(0, 'connect', { parentPID: process.pid, pid: 333 });
            await handoff.tail;
            let delegated = false;
            h.ports.manifestSHA256 = observationDigest(f.manifest);
            let intentCalls = 0;
            h.ports.lease = {
                deferredRelease: true,
                acquire() {},
                check() {},
                state: () => ({
                    created: true,
                    retained: true,
                    identityConfirmed: true,
                    releaseDelegated: delegated,
                }),
                async release(proof) {
                    intentCalls++;
                    send(1, 'release-intent', { proof });
                    await handoff.tail;
                    if (handoff.failure) throw handoff.failure;
                    delegated = true;
                    return { deferred: true };
                },
            };
            h.ports.finalEvidenceClosed = async (receipt, outcome) => {
                sealed = true;
                order.push('final-ack');
                if (scenario === 'missing-ack') throw Error('Final ACK missing');
                let body = structuredClone(receipt);
                if (scenario === 'digest-mismatch') body.sha256 = 'e'.repeat(64);
                const selected =
                    scenario === 'outcome-mismatch'
                        ? { status: 'PRODUCT_OWNERSHIP_INTEGRITY_FAILURE', memoryQualified: false }
                        : scenario === 'invalid-outcome'
                          ? {
                                status: 'INVALID_UNKNOWN_CLOSURE_OR_DURABILITY',
                                memoryQualified: false,
                            }
                          : outcome;
                if (scenario === 'foreign-ack')
                    child.emit('message', {
                        kind: 'windows-observation-custody-v1',
                        nonce: 'foreign',
                        sequence: 2,
                        manifestSHA256: observationDigest(f.manifest),
                        action: 'evidence-closed',
                        completion: body,
                        outcome: selected,
                    });
                else send(2, 'evidence-closed', { completion: body, outcome: selected });
                await handoff.tail;
                if (scenario === 'replayed-ack') {
                    send(3, 'evidence-closed', { completion: body, outcome: selected });
                    await handoff.tail;
                }
                if (handoff.failure) throw handoff.failure;
            };
            if (scenario === 'receipt-zero' || scenario === 'receipt-over-limit') {
                const base = h.ports.record;
                h.ports.record = (name, value) => {
                    const r = base(name, value);
                    return name === 'completion.json'
                        ? { ...r, bytes: scenario === 'receipt-zero' ? 0 : 262145 }
                        : r;
                };
            }
            if (scenario === 'known-incomplete' || scenario === 'known-product')
                h.ports.begin = (() => {
                    const original = h.ports.begin;
                    return (...args) => {
                        const session = original(...args);
                        session.inspect = async () => ({
                            valid: false,
                            ownershipComplete: true,
                            error:
                                scenario === 'known-incomplete'
                                    ? 'Soak lifetime budget: physicalBytes'
                                    : 'CRC mismatch',
                            observation: {
                                status:
                                    scenario === 'known-incomplete'
                                        ? 'INCOMPLETE_UNQUALIFIED_OBSERVATION'
                                        : 'PRODUCT_OWNERSHIP_INTEGRITY_FAILURE',
                                memoryQualified: false,
                            },
                        });
                        return session;
                    };
                })();
            const returned = await collectProductPreparation(f.manifest, h.ports, {
                clock: h.clock,
                events: h.events,
                supervisorNonce: f.nonce,
            });
            const file = path.join(recordRoot, 'completion.json'),
                bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
            const completion = bytes?.length
                ? JSON.parse(bytes.toString())
                : {
                      leaseReleaseDelegated: true,
                      preparedClosure: { complete: true },
                      journalClosed: true,
                      manifestSHA256: observationDigest(f.manifest),
                      observation: { status: 'COMPLETE_RAW_OBSERVATION', memoryQualified: false },
                  };
            const completionEvidence = {
                name: 'completion.json',
                bytes: bytes?.length ?? 1,
                sha256: bytes ? digest(bytes) : 'a'.repeat(64),
            };
            const healthy = ['healthy', 'known-incomplete', 'known-product'].includes(scenario);
            let published = false;
            const finish = () =>
                handoff.finish({
                    observed: {
                        spawnObserved: true,
                        exitObserved: true,
                        closeObserved: true,
                        code: scenario === 'healthy' ? 0 : 1,
                        closeCode: scenario === 'healthy' ? 0 : 1,
                        signal: null,
                        closeSignal: null,
                        timedOut: false,
                        errors: [],
                    },
                    closure: { complete: true },
                    evidenceComplete: true,
                    completion,
                    completionEvidence,
                    record() {},
                    publishOutcome() {
                        published = true;
                    },
                });
            if (healthy) {
                assert.equal(returned.finalEvidenceAcknowledged, true);
                assert.equal(held.length, 0);
                assert(fs.existsSync(f.lease.file));
                assert.equal(
                    order.at(-1),
                    'final-ack',
                    'No child write follows final acknowledgment',
                );
                const result = await finish();
                assert.equal(result.markerReleased, true);
                assert(!fs.existsSync(f.lease.file));
                assert(published);
                assert.equal(result.observation.status, returned.observation.status);
                assert.equal(result.observation.memoryQualified, false);
            } else {
                await assert.rejects(
                    finish(),
                    scenario === 'digest-mismatch'
                        ? /bytes\/digest/
                        : scenario === 'outcome-mismatch'
                          ? /outcome changed/
                          : undefined,
                );
                assert(fs.existsSync(f.lease.file));
                assert(!published);
                if (!['digest-mismatch', 'outcome-mismatch'].includes(scenario)) {
                    assert(returned.modelHoldObserved);
                    assert.equal(
                        returned.observation.status,
                        'INVALID_UNKNOWN_CLOSURE_OR_DURABILITY',
                    );
                    assert(held[0].hold.referencedHandleCreated);
                }
                if (scenario === 'completion-sync' || scenario === 'completion-close') {
                    assert(bytes.length > 0);
                    assert.equal(completion.observation.status, 'COMPLETE_RAW_OBSERVATION');
                    assert(!handoff.finalEvidence);
                }
                if (scenario.endsWith('-close'))
                    assert(open.size > 0, 'Unknown close retains the actual test descriptor');
                if (scenario === 'intent-transport')
                    assert.equal(intentCalls, 1, 'A failed provisional release is never retried');
            }
        } finally {
            for (const fd of open.keys())
                try {
                    fs.closeSync(fd);
                } catch {}
            fs.rmSync(root, { recursive: true });
        }
    });
test('maximum final completion ACK cannot bypass the outer record envelope boundary', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-final-boundary-'))),
        collection = path.join(root, 'collection');
    fs.mkdirSync(collection);
    const f = await authority(collection),
        child = Object.assign(new EventEmitter(), {
            pid: 333,
            connected: true,
            send(_m, done) {
                done?.();
            },
        }),
        handoff = new ObservationHandoff(f.authority, f.manifest, {
            verify: async () => ({}),
            record() {},
            check() {},
            hold() {},
            accounting: {
                scan() {},
                snapshot() {
                    return {};
                },
            },
        });
    const send = (sequence, action, extra = {}) =>
        child.emit('message', {
            kind: 'windows-observation-custody-v1',
            nonce: f.nonce,
            sequence,
            manifestSHA256: observationDigest(f.manifest),
            action,
            ...extra,
        });
    const cohort = {
        schema: 1,
        nonce: f.nonce,
        startedAt: 1,
        deadlineMs: 1 + observationPolicy.cohortMs,
    };
    try {
        handoff.bind(child, f.nonce, cohort);
        send(0, 'connect', { parentPID: process.pid, pid: 333 });
        await handoff.tail;
        const proof = {
            admissionCertain: true,
            directParentsClosed: true,
            evidenceClosed: true,
            inputsUnchanged: true,
            leafReceiptsClosed: true,
            resultClosed: true,
        };
        send(1, 'release-intent', { proof });
        await handoff.tail;
        const completion = {
            leaseReleaseDelegated: true,
            preparedClosure: { complete: true },
            journalClosed: true,
            manifestSHA256: observationDigest(f.manifest),
            observation: { status: 'COMPLETE_RAW_OBSERVATION', memoryQualified: false },
            padding: '',
        };
        completion.padding = 'x'.repeat(
            262144 - Buffer.byteLength(JSON.stringify(completion) + '\n'),
        );
        const bytes = Buffer.from(JSON.stringify(completion) + '\n');
        assert.equal(bytes.length, 262144);
        const completionEvidence = {
            name: 'completion.json',
            bytes: bytes.length,
            sha256: digest(bytes),
        };
        send(2, 'evidence-closed', {
            completion: completionEvidence,
            outcome: completion.observation,
        });
        await handoff.tail;
        assert(handoff.finalEvidence);
        assert(!handoff.failure);
        await assert.rejects(
            handoff.finish({
                observed: {
                    spawnObserved: true,
                    exitObserved: true,
                    closeObserved: true,
                    code: 0,
                    closeCode: 0,
                    signal: null,
                    closeSignal: null,
                    errors: [],
                    timedOut: false,
                },
                closure: { complete: true },
                evidenceComplete: true,
                completion,
                completionEvidence,
                record(_name, value) {
                    assert(
                        Buffer.byteLength(JSON.stringify(value) + '\n') <= 262144,
                        'Outer record envelope cap',
                    );
                },
            }),
            /envelope cap/,
        );
        assert(fs.existsSync(f.lease.file));
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
