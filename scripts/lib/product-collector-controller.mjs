// @ts-nocheck
import assert from 'node:assert/strict';
import {
    productJob,
    observeProductOwner,
    productClock,
} from '../../tests/fixtures/memory-product-owner.ts';
import { requireObservedClosure } from './owned-child.mjs';
import { randomUUID } from 'node:crypto';

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
    const started = startedAt,
        cohortDeadline = started + limits.cohortMs;
    const records = [];
    let failure = null,
        active = null,
        leaseOwned = false,
        journalClosed = false,
        released = false,
        admissionUncertain = false,
        pinsUnchanged = false;
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
            ports.record(name, value);
            return true;
        } catch (e) {
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
        await ports.verify('preflight');
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
                session = ports.begin(
                    spec,
                    () => {
                        assert.equal(failure, null, 'Admission cancelled before spawn.');
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
                        return job;
                    },
                    (error) => fail(error),
                );
            } catch (error) {
                admissionUncertain = !error.noChildStarted;
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
        policyReviewed: false,
        thresholdsSelected: false,
        collectionOnly: true,
        totalMemoryQualified: false,
        elapsedMs: clock.now() - started,
        leaseReleasePending: false,
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
            ports.evidenceComplete() &&
            records.every((r) => r.streams.complete === true),
        inputsUnchanged: pinsUnchanged,
    };
    result.leaseReleasePending = Object.values(proof).every(Boolean);
    const resultClosed = record('result-before-release.json', result);
    if (result.leaseReleasePending && resultClosed && leaseOwned) {
        try {
            ports.lease.release({ ...proof, resultClosed: true });
            released = true;
            record('marker-release.json', {
                released: true,
                resultClosedBeforeRelease: true,
                proof,
            });
        } catch (e) {
            fail(e);
        }
    }
    const completion = {
        ...result,
        status: failure ? 'INVALID_PRODUCT_COLLECTION' : 'COLLECTED_UNREVIEWED_WINDOWS_PAIR',
        failure,
        markerReleased: released,
        leaseRetained: ports.lease.state?.().retained ?? (leaseOwned && !released),
        leaseOwnershipUnverified:
            ports.lease.state?.().created && !ports.lease.state?.().identityConfirmed,
        collectorOwnExitOrCloseSelfAttested: false,
    };
    const completionDurable = record('completion.json', completion);
    if (
        completion.leaseRetained ||
        completion.leaseOwnershipUnverified ||
        admissionUncertain ||
        !proof.directParentsClosed ||
        !proof.leafReceiptsClosed
    ) {
        // Production port stays attached with ownership handlers and a referenced handle.
        // Tests can observe this boundary without starting or detaching an OS process.
        return await ports.holdUnknown({ ...completion, completionDurable });
    }
    for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) events.off(event, interrupt);
    events.off('message', message);
    return {
        ...completion,
        status: failure ? 'INVALID_PRODUCT_COLLECTION' : completion.status,
        failure,
        completionDurable,
    };
}
