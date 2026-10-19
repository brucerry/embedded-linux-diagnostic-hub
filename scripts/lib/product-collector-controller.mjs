// @ts-nocheck
import assert from 'node:assert/strict';
import {
    productJob,
    observeProductOwner,
    productClock,
} from '../../tests/fixtures/memory-product-owner.ts';
import { requireObservedClosure } from './owned-child.mjs';
import { randomUUID } from 'node:crypto';
import { observationOutcome } from './observation-outcome.mjs';

export const limits = Object.freeze({
    parents: 2,
    jobMs: 2400000,
    reserveMs: 60000,
    cohortMs: 4800000,
    streamBytes: 1048576,
    jobBytes: 268435456,
    cohortBytes: 536870912,
});
/** All effects use explicit ports; import is inert and tests never spawn a resource parent. */
export async function collectProductPreparation(
    manifest,
    ports,
    {
        clock = productClock,
        events = process,
        supervisorNonce = null,
        startedAt = clock.now(),
        entry: custody = null,
    } = {},
) {
    assert.equal(manifest.jobs.length, 2);
    manifest.jobs.forEach((v, i) => {
        assert.deepEqual(v, {
            ordinal: i,
            observerMode: i === 0 ? 'sampled' : 'no-sampler',
            gcMode: 'normal',
            expectedParentCode: 0,
        });
    });
    const started = custody?.cohort.startedAt ?? startedAt,
        cohortDeadline = started + limits.cohortMs;
    const records = [],
        preparedDescriptors = [];
    let preparedClosureUnknown = false;
    const rememberPrepared = (logs) => {
        for (const entry of logs ?? [])
            if (!preparedDescriptors.includes(entry)) preparedDescriptors.push(entry);
    };
    let failure = null,
        active = null,
        leaseOwned = false,
        journalClosed = false,
        released = false,
        releaseDelegated = false,
        admissionUncertain = false,
        pinsUnchanged = false,
        recordsClosed = true,
        releaseProtocolFailed = false,
        completionReceipt = null;
    const fail = (error) => {
        failure ??= String(error).slice(0, 4096);
        if (active) {
            try {
                if (active.watch) active.watch.abort(failure);
                else active.session.cancel(failure);
            } catch {
                admissionUncertain = true;
            }
        }
    };
    const record = (name, value) => {
        try {
            const receipt = ports.record(name, value);
            if (name === 'completion.json') completionReceipt = receipt;
            return true;
        } catch (e) {
            recordsClosed = false;
            fail(e);
            return false;
        }
    };
    const append = (event, value) => {
        try {
            ports.journal.append(event, value);
            return true;
        } catch (e) {
            fail(e);
            return false;
        }
    };
    const interrupt = () => fail('Collector interrupted; no future admission.');
    const message = (value) => {
        if (
            value?.kind === 'cancel-product-collection' &&
            supervisorNonce &&
            value.nonce === supervisorNonce
        )
            fail(value.reason ?? 'Supervisor cancellation.');
        else fail('Invalid supervisor cancellation identity.');
    };
    const stopEntry = custody?.onCancel(fail);
    for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) events.on(event, interrupt);
    events.on('message', message);
    const ownerClock = {
        now: clock.now,
        set: (fn, ms) =>
            clock.set(() => {
                try {
                    fn();
                } catch (error) {
                    fail(error);
                }
            }, ms),
        clear: (id) => {
            try {
                clock.clear(id);
            } catch (error) {
                fail(error);
            }
        },
    };
    let overall;
    try {
        overall = ownerClock.set(
            () => fail('Collector cohort observation deadline.'),
            Math.max(0, cohortDeadline - clock.now()),
        );
    } catch (error) {
        fail(error);
    }
    try {
        if (failure) throw Error(failure);
        custody?.assertAdmissible();
        await ports.verify('preflight');
        if (failure) throw Error(failure);
        custody?.assertAdmissible();
        ports.lease.acquire();
        leaseOwned = true;
        record('owner.json', ports.owner);
        append('collector-admitted', {
            owner: ports.owner,
            manifestSHA256: ports.manifestSHA256,
            cohortDeadline,
        });
        for (const spec of manifest.jobs) {
            if (failure) break;
            ports.lease.check();
            await ports.verify('before-parent-' + spec.ordinal);
            if (failure) break;
            record(`parent-${spec.ordinal}-attempt.json`, {
                ordinal: spec.ordinal,
                observerMode: spec.observerMode,
                control: spec.control,
            });
            if (failure) break;
            let session;
            try {
                let jobIdentity;
                const allocateJob = () => {
                    if (jobIdentity) return jobIdentity;
                    assert.equal(failure, null, 'Admission cancelled before job allocation.');
                    custody?.assertAdmissible();
                    const deadlineMs = Math.min(clock.now() + limits.jobMs, cohortDeadline);
                    assert.ok(
                        deadlineMs - clock.now() >= 1860000,
                        'Insufficient unchanged 30-minute workload plus cleanup reserve.',
                    );
                    const job = productJob(
                        JSON.stringify({
                            schema: 1,
                            nonce: randomUUID(),
                            budgetMs: limits.jobMs,
                            reserveMs: limits.reserveMs,
                            deadlineMs,
                        }),
                        clock,
                    );
                    jobIdentity = job;
                    return job;
                };
                const finalAdmission = (job) => {
                    assert.equal(failure, null, 'Admission cancelled before actual spawn.');
                    custody?.assertAdmissible(job);
                    assert(
                        clock.now() < job.deadlineMs - job.reserveMs &&
                            clock.now() < cohortDeadline,
                        'Existing job/cohort deadline expired before actual spawn.',
                    );
                };
                const prepared = ports.prepare
                    ? await ports.prepare(spec, allocateJob, (error) => fail(error), finalAdmission)
                    : undefined;
                rememberPrepared(prepared?.logs);
                session = ports.begin(
                    spec,
                    allocateJob,
                    (error) => fail(error),
                    finalAdmission,
                    prepared,
                );
            } catch (error) {
                rememberPrepared(error.preparedLogs);
                if (
                    error.noChildStarted &&
                    error.fdClosure?.complete === true &&
                    ports.admissionRefused
                )
                    try {
                        await ports.admissionRefused(spec);
                    } catch (closeError) {
                        preparedClosureUnknown = true;
                        fail(closeError);
                    }
                // noChildStarted proves only admission, never descriptor durability/closure.
                if (error.fdClosure?.complete !== true) preparedClosureUnknown = true;
                admissionUncertain ||= !error.noChildStarted;
                fail(error);
                break;
            }
            const job = session.job,
                entry = {
                    ordinal: spec.ordinal,
                    observerMode: spec.observerMode,
                    control: spec.control,
                    job,
                };
            let actualClosed = false;
            const close = new Promise((resolve) =>
                session.child.once('close', () => {
                    actualClosed = true;
                    resolve();
                }),
            );
            const raw = {
                pid: session.child.pid ?? null,
                spawnObserved: false,
                exitObserved: false,
                closeObserved: false,
                code: null,
                signal: null,
                closeCode: null,
                closeSignal: null,
                error: null,
                timedOut: false,
            };
            session.child.once('spawn', () => {
                raw.spawnObserved = true;
                record(`parent-${spec.ordinal}-spawn.json`, {
                    ...entry,
                    pid: session.child.pid,
                    spawnObserved: true,
                });
            });
            session.child.on('error', (error) => {
                raw.error = String(error);
            });
            session.child.once('exit', (code, signal) =>
                Object.assign(raw, { exitObserved: true, code, signal }),
            );
            session.child.once('close', (code, signal) =>
                Object.assign(raw, { closeObserved: true, closeCode: code, closeSignal: signal }),
            );
            active = { watch: null, session, close };
            let watch;
            try {
                watch = observeProductOwner(session.child, job, ownerClock);
                active.watch = watch;
            } catch (error) {
                raw.error = String(error);
                fail(error);
            }
            try {
                session.setup?.();
            } catch (error) {
                fail(error);
            }
            if (failure) fail(failure);
            record(`parent-${spec.ordinal}-admission.json`, {
                ...entry,
                pid: session.child.pid,
                argv: session.argv,
                cwd: session.cwd,
            });
            append('parent-admitted', { ...entry, pid: session.child.pid });
            const deadlineOutcome = watch
                ? await watch.outcome
                : (await close, { ...raw, error: raw.error ?? 'Owner observer setup failed.' });
            if (!deadlineOutcome.closeObserved) {
                fail('Parent actual close unknown at immutable deadline.');
                record(`parent-${spec.ordinal}-deadline.json`, {
                    ...entry,
                    status: 'INVALID_COLLECTION',
                    lifecycle: deadlineOutcome,
                });
            }
            // A missing close never triggers a middle-owner kill, detach or release. Keep this owner attached.
            if (!actualClosed) await close;
            let streams = { complete: false, errors: ['stream closure not confirmed'] },
                inspection = null;
            try {
                streams = session.closeLogs();
            } catch (e) {
                fail(e);
            }
            const actualOutcome = watch ? watch.snapshot() : { ...raw };
            try {
                inspection = await session.inspect(actualOutcome);
            } catch (e) {
                fail(e);
            }
            const row = { ...entry, deadlineOutcome, actualOutcome, streams, inspection };
            records.push(row);
            record(`parent-${spec.ordinal}-closure.json`, row);
            append('parent-closed', {
                ordinal: spec.ordinal,
                pid: actualOutcome.pid,
                actualClose: actualOutcome.closeObserved,
                streamsComplete: streams.complete,
            });
            active = null;
            try {
                requireObservedClosure(deadlineOutcome);
                assert.equal(deadlineOutcome.code, spec.expectedParentCode);
                assert.equal(streams.complete, true, 'Parent streams not durable/closed.');
                assert.equal(
                    inspection?.ownershipComplete,
                    true,
                    'Leaf/collector ownership proof incomplete.',
                );
                assert.equal(
                    inspection?.valid,
                    true,
                    inspection?.error ?? 'Raw product validation failed.',
                );
                await ports.verify('after-parent-' + spec.ordinal);
                assert.ok(
                    clock.now() <= job.deadlineMs,
                    'Job evidence closure exceeded immutable shared deadline.',
                );
            } catch (e) {
                fail(e);
            }
        }
        if (!failure) {
            assert.equal(records.length, 2);
            ports.summary(records);
        }
    } catch (error) {
        fail(error);
    } finally {
        // Defensive joins also cover synchronous recorder/validation failures after admission.
        if (active) {
            fail(failure ?? 'Collector cleanup.');
            await active.close;
            try {
                active.session.closeLogs();
            } catch (e) {
                fail(e);
            }
            active = null;
        }
        ownerClock.clear(overall);
        try {
            const verified = await ports.verify('postflight');
            pinsUnchanged = record('unchanged-inputs.json', {
                sourceSHA256: manifest.sourceSHA256,
                manifestSHA256: ports.manifestSHA256,
                verification: verified,
                matching: true,
            });
        } catch (error) {
            fail(error);
        }
        try {
            ports.journal.close();
            journalClosed = ports.journal.proof();
        } catch (e) {
            fail(e);
        }
    }
    const preparedClosure = {
        complete:
            !preparedClosureUnknown &&
            preparedDescriptors.every(
                (entry) => entry.synced === true && entry.closed === true && !entry.errors.length,
            ),
        closureUnknown: preparedClosureUnknown,
        handles: preparedDescriptors.map((entry) => ({
            name: entry.name ?? null,
            syncObserved: entry.synced === true,
            closeObserved: entry.closed === true,
            closeAttempted: entry.attempted === true,
            errors: [...entry.errors],
        })),
    };
    const preparedEvidenceClosed = record('prepared-descriptors.json', preparedClosure);
    if (!preparedClosure.complete) fail('Prepared log durability/closure unconfirmed.');
    if (!journalClosed) fail('Journal incomplete, not durable or not closed.');
    if (!ports.evidenceComplete()) fail('Evidence writes/closures unconfirmed.');
    const result = {
        status: failure ? 'INVALID_PRODUCT_COLLECTION' : 'COLLECTED_UNREVIEWED_WINDOWS_PAIR',
        failure,
        parents: records.length,
        sourceSHA256: manifest.sourceSHA256,
        collectorSHA256: manifest.collectorSHA256,
        manifestSHA256: ports.manifestSHA256,
        journalClosed,
        preparedClosure,
        policyReviewed: false,
        thresholdsSelected: false,
        collectionOnly: true,
        totalMemoryQualified: false,
        elapsedMs: clock.now() - started,
        leaseReleasePending: false,
        observation:
            records.length &&
            records.every((r) => r.inspection?.ownershipComplete && r.streams.complete)
                ? (records.find(
                      (r) => r.inspection?.observation?.status !== 'COMPLETE_RAW_OBSERVATION',
                  )?.inspection?.observation ??
                  (failure
                      ? observationOutcome({ ownershipComplete: true, complete: false, failure })
                      : { status: 'COMPLETE_RAW_OBSERVATION', memoryQualified: false }))
                : observationOutcome({ ownershipComplete: false, complete: false, failure }),
    };
    const proof = {
        directParentsClosed: records.every(
            (r) =>
                r.actualOutcome.spawnObserved &&
                r.actualOutcome.exitObserved &&
                r.actualOutcome.closeObserved &&
                [0, 1].includes(r.actualOutcome.code) &&
                r.actualOutcome.code === r.actualOutcome.closeCode &&
                r.actualOutcome.signal === null &&
                r.actualOutcome.closeSignal === null,
        ),
        leafReceiptsClosed: records.every((r) => r.inspection?.ownershipComplete === true),
        admissionCertain: !admissionUncertain,
        evidenceClosed:
            journalClosed &&
            recordsClosed &&
            preparedEvidenceClosed &&
            preparedClosure.complete &&
            ports.evidenceComplete() &&
            records.every((r) => r.streams.complete === true),
        inputsUnchanged: pinsUnchanged,
    };
    result.leaseReleasePending = Object.values(proof).every(Boolean);
    const resultClosed = record('result-before-release.json', result);
    const releaseReady = result.leaseReleasePending && resultClosed && leaseOwned;
    if (releaseReady) {
        try {
            // The real outer-bound lease is explicitly provisional. A direct lease is
            // not released until the final required child record has closed below.
            if (ports.lease.deferredRelease === true) {
                const release = await ports.lease.release({ ...proof, resultClosed: true });
                assert.equal(release?.deferred, true);
                releaseDelegated = true;
            }
            record('marker-release.json', {
                released: false,
                delegatedToIndependentOuter: releaseDelegated,
                releaseAfterFinalEvidence: true,
                resultClosedBeforeRelease: true,
                proof,
            });
        } catch (e) {
            releaseProtocolFailed = true;
            fail(e);
        }
    }
    const evidenceHealthy = () => proof.evidenceClosed && recordsClosed && ports.evidenceComplete();
    const invalidObservation = () =>
        observationOutcome({ ownershipComplete: false, durable: false, complete: false });
    const completion = {
        ...result,
        observation:
            evidenceHealthy() && !releaseProtocolFailed ? result.observation : invalidObservation(),
        status: failure ? 'INVALID_PRODUCT_COLLECTION' : 'COLLECTED_UNREVIEWED_WINDOWS_PAIR',
        failure,
        markerReleased: false,
        leaseReleaseDelegated: releaseDelegated,
        leaseRetained: ports.lease.state?.().retained ?? leaseOwned,
        leaseOwnershipUnverified:
            ports.lease.state?.().created && !ports.lease.state?.().identityConfirmed,
        collectorOwnExitOrCloseSelfAttested: false,
    };
    const completionDurable = record('completion.json', completion);
    let finalEvidenceAcknowledged = false;
    const childEvidenceClosed = completionDurable && evidenceHealthy();
    if (
        releaseReady &&
        !releaseProtocolFailed &&
        childEvidenceClosed &&
        !completion.leaseOwnershipUnverified &&
        !admissionUncertain &&
        preparedClosure.complete &&
        proof.directParentsClosed &&
        proof.leafReceiptsClosed
    ) {
        try {
            if (releaseDelegated) {
                assert.equal(
                    typeof ports.finalEvidenceClosed,
                    'function',
                    'Final evidence-closed acknowledgment required',
                );
                assert(
                    completionReceipt?.name === 'completion.json' &&
                        /^[a-f0-9]{64}$/.test(completionReceipt.sha256) &&
                        Number.isSafeInteger(completionReceipt.bytes) &&
                        completionReceipt.bytes > 0 &&
                        completionReceipt.bytes <= 262144,
                    'Actual final completion byte receipt required',
                );
                await ports.finalEvidenceClosed(completionReceipt, completion.observation);
                finalEvidenceAcknowledged = true;
            } else {
                await ports.lease.release({ ...proof, resultClosed: true });
                released = true;
            }
        } catch (e) {
            fail(e);
        }
    }
    if (
        !childEvidenceClosed ||
        (releaseDelegated && !finalEvidenceAcknowledged) ||
        (completion.leaseRetained && !released && !finalEvidenceAcknowledged) ||
        completion.leaseOwnershipUnverified ||
        admissionUncertain ||
        !preparedClosure.complete ||
        !proof.directParentsClosed ||
        !proof.leafReceiptsClosed
    ) {
        return await ports.holdUnknown({
            ...completion,
            status: 'INVALID_PRODUCT_COLLECTION',
            failure,
            observation: invalidObservation(),
            completionDurable,
            finalEvidenceAcknowledged,
        });
    }
    // No required child evidence write follows the final acknowledgment or direct release.
    for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) events.off(event, interrupt);
    events.off('message', message);
    stopEntry?.();
    return {
        ...completion,
        markerReleased: released,
        leaseRetained: !released && completion.leaseRetained,
        status: failure ? 'INVALID_PRODUCT_COLLECTION' : completion.status,
        failure,
        completionDurable,
        finalEvidenceAcknowledged,
    };
}
