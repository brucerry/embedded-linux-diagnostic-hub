// @ts-nocheck
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    observationDigest,
    assertObservationAuthority,
    observationPorts,
    remoteObservationAuthority,
} from './windows-observation-approval.mjs';
import { productClock } from '../../tests/fixtures/memory-product-owner.ts';
const kind = 'windows-observation-custody-v1';
const proofKeys = [
    'admissionCertain',
    'directParentsClosed',
    'evidenceClosed',
    'inputsUnchanged',
    'leafReceiptsClosed',
    'resultClosed',
];
function proof(value) {
    assert.deepEqual(Object.keys(value).sort(), proofKeys);
    assert(Object.values(value).every((v) => v === true));
}
/** Parent keeps the marker until independently observed collector close and outer durability. */
export class ObservationHandoff {
    constructor(authority, manifest, { verify, record, check, admit = check, hold, accounting }) {
        this.authority = authority;
        this.manifest = manifest;
        this.ports = { verify, record, check, admit, hold, accounting };
        this.tail = Promise.resolve();
        this.pending = 0;
        this.next = 0;
        this.intent = null;
        this.finalEvidence = null;
        this.failure = null;
    }
    bind(child, nonce, cohort) {
        assert(!this.child);
        this.child = child;
        this.nonce = nonce;
        this.cohort = cohort;
        this.receive = (message) => {
            if (this.failure) return;
            if (message?.kind !== kind) {
                this.fail(Error('Unexpected collector protocol message'));
                return;
            }
            this.pending++;
            this.tail = this.tail
                .then(async () => {
                    assert(Buffer.byteLength(JSON.stringify(message)) <= 8192);
                    assert.equal(message.nonce, nonce);
                    const extra =
                        message.action === 'connect'
                            ? ['parentPID', 'pid']
                            : message.action === 'release-intent'
                              ? ['proof']
                              : message.action === 'evidence-closed'
                                ? ['completion', 'outcome']
                                : ['job-start', 'job-end'].includes(message.action)
                                  ? ['ordinal']
                                  : [];
                    assert.deepEqual(
                        Object.keys(message).sort(),
                        ['kind', 'nonce', 'sequence', 'manifestSHA256', 'action', ...extra].sort(),
                    );
                    assert.equal(message.sequence, this.next++);
                    assert(this.next <= 64);
                    assert.equal(message.manifestSHA256, observationDigest(this.manifest));
                    this.ports.check();
                    assertObservationAuthority(this.authority, this.manifest);
                    let value;
                    if (message.action === 'connect') {
                        assert(!this.connected);
                        assert.equal(message.parentPID, process.pid);
                        assert.equal(message.pid, child.pid);
                        this.connected = true;
                        observationPorts(this.authority, this.manifest).lease.acquire();
                        this.ports.record('collector-authority-bound.json', {
                            nonce,
                            cohort,
                            parentPID: process.pid,
                            collectorPID: child.pid,
                            manifestSHA256: observationDigest(this.manifest),
                            sourceSHA256: this.manifest.sourceSHA256,
                        });
                        value = {
                            parentPID: process.pid,
                            collectorPID: child.pid,
                            cohort,
                            manifestSHA256: observationDigest(this.manifest),
                        };
                    } else {
                        assert(this.connected && !this.finalEvidence);
                        if (message.action === 'evidence-closed') {
                            assert(this.intent, 'Provisional release intent required');
                            assert.deepEqual(Object.keys(message.completion).sort(), [
                                'bytes',
                                'name',
                                'sha256',
                            ]);
                            assert.equal(message.completion.name, 'completion.json');
                            assert(
                                Number.isSafeInteger(message.completion.bytes) &&
                                    message.completion.bytes > 0 &&
                                    message.completion.bytes <= 262144,
                            );
                            assert(/^[a-f0-9]{64}$/.test(message.completion.sha256));
                            assert.deepEqual(Object.keys(message.outcome).sort(), [
                                'memoryQualified',
                                'status',
                            ]);
                            assert.equal(message.outcome.memoryQualified, false);
                            assert(
                                [
                                    'COMPLETE_RAW_OBSERVATION',
                                    'INCOMPLETE_UNQUALIFIED_OBSERVATION',
                                    'PRODUCT_OWNERSHIP_INTEGRITY_FAILURE',
                                ].includes(message.outcome.status),
                            );
                            this.finalEvidence = structuredClone({
                                completion: message.completion,
                                outcome: message.outcome,
                            });
                            this.ports.record('collector-evidence-closed.json', {
                                nonce,
                                cohort,
                                ...this.finalEvidence,
                            });
                            value = { evidenceClosed: true, sha256: message.completion.sha256 };
                        } else if (message.action === 'verify') {
                            assert(!this.intent);
                            value = await this.ports.verify();
                        } else if (message.action === 'release-intent') {
                            assert(!this.intent);
                            proof(message.proof);
                            this.intent = structuredClone(message.proof);
                            this.ports.record('collector-release-intent.json', {
                                nonce,
                                cohort,
                                proof: this.intent,
                            });
                            value = { deferred: true };
                        } else if (message.action === 'job-start') {
                            assert(!this.intent);
                            this.ports.admit();
                            this.ports.accounting.start(message.ordinal);
                            value = { accepted: true };
                        } else if (message.action === 'job-end') {
                            assert(!this.intent);
                            this.ports.accounting.end(message.ordinal);
                            value = { accepted: true };
                        } else throw Error('Unknown custody action');
                    }
                    this.ports.check();
                    await new Promise((resolve, reject) =>
                        child.send(
                            { kind, nonce, sequence: message.sequence, ok: true, value },
                            (e) => (e ? reject(e) : resolve()),
                        ),
                    );
                })
                .catch((error) => this.fail(error))
                .finally(() => this.pending--);
        };
        child.on('message', this.receive);
    }
    fail(error) {
        if (this.failure) return;
        this.failure = error;
        this.ports.hold(error);
        if (this.child?.connected)
            this.child.send(
                {
                    kind: 'cancel-product-collection',
                    nonce: this.nonce,
                    reason: String(error).slice(0, 1024),
                },
                () => {},
            );
    }
    async finish({
        observed,
        closure,
        evidenceComplete,
        completion,
        completionEvidence,
        record,
        publishOutcome = () => {},
    }) {
        await this.tail;
        assert(!this.failure && this.pending === 0);
        assert(this.intent);
        assert(this.finalEvidence, 'Final child evidence-closed acknowledgment missing');
        assert.deepEqual(
            completionEvidence,
            this.finalEvidence.completion,
            'Final completion bytes/digest changed',
        );
        assert.deepEqual(
            completion.observation,
            this.finalEvidence.outcome,
            'Final outcome changed',
        );
        proof(this.intent);
        assert(observed.spawnObserved && observed.exitObserved && observed.closeObserved);
        assert(
            [0, 1].includes(observed.code) &&
                observed.code === observed.closeCode &&
                observed.signal === null &&
                observed.closeSignal === null,
        );
        assert.equal(
            observed.code,
            this.finalEvidence.outcome.status === 'COMPLETE_RAW_OBSERVATION' ? 0 : 1,
            'Collector exit does not match final acknowledged outcome',
        );
        assert(
            !observed.timedOut &&
                observed.errors.length === 0 &&
                closure.complete &&
                evidenceComplete,
        );
        assert(
            completion.leaseReleaseDelegated === true &&
                completion.preparedClosure.complete &&
                completion.journalClosed,
        );
        assert.equal(completion.manifestSHA256, observationDigest(this.manifest));
        await this.ports.verify();
        this.ports.check();
        this.ports.accounting.scan();
        publishOutcome(this.finalEvidence.outcome);
        record('outer-release-proof.json', {
            proof: this.intent,
            collectorActuallyClosed: true,
            outerLogsClosed: true,
            completion,
            physical: this.ports.accounting.snapshot(),
        });
        observationPorts(this.authority, this.manifest).lease.release(this.intent);
        this.child.off('message', this.receive);
        return {
            markerReleased: true,
            independentOuterClosed: true,
            observation: structuredClone(this.finalEvidence.outcome),
        };
    }
}
/** Separate message routing leaves the existing cancellation/disconnect guards intact. */
export async function connectObservationCollector(
    manifest,
    nonce,
    cohort,
    { ownerCheck, check = () => {}, events = process } = {},
) {
    assert.equal(events.connected, true, 'Inherited live outer IPC required');
    let sequence = 0,
        waiting = null,
        failed = null,
        enrolled = false,
        delegated = false,
        finalized = false,
        acquired = false;
    const filtered = new EventEmitter();
    Object.defineProperty(filtered, 'connected', { get: () => events.connected });
    const timer = setTimeout(
        () => {
            failed ??= Error('Immutable collector cohort deadline');
            waiting?.reject(failed);
            filtered.emit('disconnect');
        },
        Math.max(0, cohort.deadlineMs - productClock.now()),
    );
    Object.defineProperty(filtered, 'exitCode', {
        get: () => events.exitCode,
        set: (value) => (events.exitCode = value),
    });
    filtered.disconnect = () => events.disconnect();
    const relay = [];
    for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) {
        const fn = () => {
            if (event === 'disconnect') clearTimeout(timer);
            failed ??= Error('Collector ' + event);
            waiting?.reject(failed);
            filtered.emit(event);
        };
        events.on(event, fn);
        relay.push([event, fn]);
    }
    const receive = (message) => {
        if (message?.kind !== kind) {
            if (
                !enrolled ||
                message?.kind !== 'cancel-product-collection' ||
                message.nonce !== nonce
            ) {
                failed ??= Error('Cancelled or invalid authority before admission');
                waiting?.reject(failed);
            }
            filtered.emit('message', message);
            return;
        }
        try {
            assert(waiting);
            assert.equal(message.nonce, nonce);
            assert.equal(message.sequence, waiting.sequence);
            assert.equal(message.ok, true);
            const current = waiting;
            waiting = null;
            current.resolve(message.value);
        } catch (e) {
            failed = e;
            waiting?.reject(e);
            filtered.emit('message', {});
        }
    };
    events.on('message', receive);
    const live = () => {
        assert.equal(events.connected, true);
        assert(!failed);
        check();
    };
    const rpc = (action, extra = {}) =>
        new Promise((resolve, reject) => {
            live();
            assert(!waiting, 'Custody RPCs are serialized');
            assert(sequence < 64);
            const id = sequence++;
            waiting = { resolve, reject, sequence: id };
            events.send(
                {
                    kind,
                    nonce,
                    sequence: id,
                    manifestSHA256: observationDigest(manifest),
                    action,
                    ...extra,
                },
                (error) => {
                    if (error) {
                        failed = error;
                        waiting?.reject(error);
                        filtered.emit('message', {});
                    }
                },
            );
        });
    const welcome = await rpc('connect', { parentPID: process.ppid, pid: process.pid });
    assert(!failed);
    enrolled = true;
    assert.equal(welcome.parentPID, process.ppid);
    assert.equal(welcome.collectorPID, process.pid);
    assert.deepEqual(welcome.cohort, cohort);
    const ports = {
        check: live,
        ownerCheck,
        verify: () => rpc('verify'),
        jobStart: (ordinal) => rpc('job-start', { ordinal }),
        jobEnd: (ordinal) => rpc('job-end', { ordinal }),
        lease: {
            deferredRelease: true,
            check: live,
            acquire() {
                live();
                assert(!acquired);
                acquired = true;
            },
            state: () => ({
                created: true,
                retained: true,
                identityConfirmed: true,
                released: false,
                releaseDelegated: delegated,
            }),
            async release(value) {
                proof(value);
                await rpc('release-intent', { proof: value });
                delegated = true;
                return { deferred: true };
            },
        },
        async finalEvidenceClosed(completion, outcome) {
            assert(delegated && !finalized);
            const reply = await rpc('evidence-closed', { completion, outcome });
            assert.equal(reply.evidenceClosed, true);
            assert.equal(reply.sha256, completion.sha256);
            finalized = true;
        },
        dispose() {
            assert(finalized);
            clearTimeout(timer);
            events.off('message', receive);
            for (const [e, fn] of relay) events.off(e, fn);
        },
    };
    return {
        authority: remoteObservationAuthority(manifest, process.ppid, ports),
        ports,
        events: filtered,
    };
}
