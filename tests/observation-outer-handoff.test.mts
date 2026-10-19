// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { runOuter } from '../scripts/memory-product-collect.mts';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { ObservationHandoff } from '../scripts/lib/observation-handoff.mjs';
import {
    observationPolicy,
    observationDigest,
    approvalName,
    pollObservationApproval,
    observationAuthority,
} from '../scripts/lib/windows-observation-approval.mjs';
import { productClock } from './fixtures/memory-product-owner';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url),
    sha = 'a'.repeat(64),
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
for (const fault of [
    'wrong-pid',
    'replay',
    'foreign-nonce',
    'missing-close',
    'missing-exit',
    'deadline',
    'evidence',
    'receipt',
])
    test('single-use outer authority retains real test marker on ' + fault, async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-handoff-proof-'))),
            collection = path.join(root, 'collection');
        fs.mkdirSync(collection);
        const f = await authority(collection),
            cohort = {
                schema: 1,
                nonce: f.nonce,
                startedAt: 1,
                deadlineMs: 1 + observationPolicy.cohortMs,
            },
            holds = [];
        const child = Object.assign(new EventEmitter(), {
                pid: 333,
                connected: true,
                send(_m, done) {
                    done?.();
                },
            }),
            handoff = new ObservationHandoff(f.authority, f.manifest, {
                verify: async () => ({}),
                check() {},
                record() {},
                hold: (e) => holds.push(String(e)),
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
        try {
            handoff.bind(child, f.nonce, cohort);
            send(0, 'connect', { parentPID: process.pid, pid: fault === 'wrong-pid' ? 334 : 333 });
            await handoff.tail;
            if (fault === 'wrong-pid') {
                assert(holds.length);
                return;
            }
            if (fault === 'replay') {
                send(0, 'connect', { parentPID: process.pid, pid: 333 });
                await handoff.tail;
                assert(holds.length);
                return;
            }
            if (fault === 'foreign-nonce') {
                child.emit('message', { kind: 'windows-observation-custody-v1', nonce: 'foreign' });
                await handoff.tail;
                assert(holds.length);
                return;
            }
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
            };
            const body = Buffer.from(JSON.stringify(completion) + '\n'),
                completionEvidence = {
                    name: 'completion.json',
                    bytes: body.length,
                    sha256: observationDigest(completion),
                };
            send(2, 'evidence-closed', {
                completion: completionEvidence,
                outcome: completion.observation,
            });
            await handoff.tail;
            const observed = {
                spawnObserved: true,
                exitObserved: fault !== 'missing-exit',
                closeObserved: fault !== 'missing-close',
                code: 0,
                closeCode: 0,
                signal: null,
                closeSignal: null,
                timedOut: fault === 'deadline',
                errors: [],
            };
            await assert.rejects(
                handoff.finish({
                    observed,
                    closure: { complete: fault !== 'evidence' },
                    evidenceComplete: true,
                    completion: { ...completion, leaseReleaseDelegated: fault !== 'receipt' },
                    completionEvidence,
                    record() {},
                }),
            );
        } finally {
            assert(fs.existsSync(f.lease.file));
            fs.rmSync(root, { recursive: true });
        }
    });
for (const fault of ['none', 'product', 'outer-sync'])
    test(
        'actual independent outer and harmless IPC collector preserve marker custody: ' + fault,
        async () => {
            const root = fs.realpathSync(
                    fs.mkdtempSync(path.join(os.tmpdir(), 'hub-outer-handoff-')),
                ),
                collection = path.join(root, 'collection');
            fs.mkdirSync(collection);
            const f = await authority(collection),
                started = productClock.now(),
                cohort = {
                    schema: 1,
                    nonce: f.nonce,
                    startedAt: started,
                    deadlineMs: started + observationPolicy.cohortMs,
                },
                holds = [],
                records = [];
            let child,
                markerSeenBeforeClose = false,
                childError = '';
            const clock = { now: productClock.now, set: (fn, ms) => ({ fn, ms }), clear() {} };
            const exitCode = process.exitCode,
                overrides = Object.fromEntries(
                    Object.entries(process.env).filter(([key]) =>
                        /^(NODE_|TSX_|ESBUILD_|ELECTRON_|HUB_)/.test(key),
                    ),
                );
            for (const key of Object.keys(overrides)) delete process.env[key];
            const handoff = new ObservationHandoff(f.authority, f.manifest, {
                verify: async () => ({ modelOnly: true }),
                check() {},
                record: (name, value) => records.push({ name, value }),
                hold: (error) => holds.push(String(error)),
                accounting: {
                    start() {},
                    end() {},
                    scan() {},
                    snapshot() {
                        return { fixtureOnly: true };
                    },
                },
            });
            try {
                const result = await runOuter(
                    f.manifest,
                    observationDigest(f.manifest),
                    '/fixture/manifest',
                    {
                        nonce: f.nonce,
                        cohort,
                        clock,
                        authority: f.authority,
                        handoff,
                        verify: async () => ({ modelOnly: true }),
                        principalObserver: () => () => {},
                        ownershipHold: (state) => ({
                            outcome: Promise.resolve({ modelHoldObserved: true, state }),
                        }),
                        logIO:
                            fault === 'outer-sync'
                                ? {
                                      ...fs,
                                      fsyncSync() {
                                          throw Error('outer sync injected');
                                      },
                                  }
                                : fs,
                        spawnChild() {
                            child = spawn(
                                process.execPath,
                                [
                                    '--import',
                                    pathToFileURL(require.resolve('tsx')).href,
                                    new URL(
                                        './fixtures/observation-handoff-child.mts',
                                        import.meta.url,
                                    ).pathname,
                                    JSON.stringify({
                                        manifest: f.manifest,
                                        nonce: f.nonce,
                                        cohort,
                                        fault,
                                    }),
                                ],
                                { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
                            );
                            child.stderr.on('data', (b) => {
                                if (childError.length < 8192) childError += b.toString();
                            });
                            const timer = setInterval(() => {
                                if (
                                    fs.existsSync(
                                        path.join(collection, 'collector', 'completion.json'),
                                    )
                                ) {
                                    markerSeenBeforeClose = fs.existsSync(f.lease.file);
                                    clearInterval(timer);
                                }
                            }, 5);
                            child.once('close', () => clearInterval(timer));
                            return child;
                        },
                    },
                );
                assert(markerSeenBeforeClose, JSON.stringify({ result, holds, child: !!child }));
                assert.equal(holds.length, 0);
                const proofFile = path.join(collection, 'outer', 'outer-release-proof.json');
                if (fault === 'outer-sync') {
                    assert(result.modelHoldObserved);
                    assert(fs.existsSync(f.lease.file));
                    assert(!fs.existsSync(proofFile));
                } else {
                    assert.equal(result.markerReleased, true);
                    assert.equal(result.closeObserved, true);
                    assert.equal(result.code, fault === 'product' ? 1 : 0);
                    assert(!fs.existsSync(f.lease.file));
                    assert(fs.existsSync(proofFile));
                }
            } catch (error) {
                error.message += '; harmless child stderr: ' + childError;
                throw error;
            } finally {
                if (child?.connected) child.disconnect();
                process.exitCode = exitCode;
                Object.assign(process.env, overrides);
                fs.rmSync(root, { recursive: true });
            }
        },
    );
