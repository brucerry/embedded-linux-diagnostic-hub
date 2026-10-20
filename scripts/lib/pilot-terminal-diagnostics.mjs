import assert from 'node:assert/strict';
import { pilotLimits } from './hosted-pilot-contract.mjs';
import {
    planStartupIdentity,
    lifecycleEvidenceStages,
    requireIdentityPlan,
    reportingRefusal,
} from './startup-identity-report.mjs';
/** PTY-only queue with reserved terminal capacity inside the original global limits. */
export function terminalRuntimeDiagnostics(send, hold) {
    let tail = Promise.resolve(),
        failed,
        rows = 0,
        bytes = 0,
        pending = 0,
        lifecycleOrdinal = 0;
    let observer;
    let reservation,
        timelineReservation,
        timelineRows = 0,
        timelineBytes = 0,
        timelinePending = 0,
        timelineCauseClaimed = false,
        timelineSummaryClaimed = false,
        normalClosed = false,
        terminalRows = 0,
        terminalBytes = 0,
        terminalPending = 0;
    const budget = (stage, count, charge, queued, encoded, terminal = false, timeline = false) => {
        const unusedRows = reservation ? reservation.rows - terminalRows : 0;
        const unusedBytes = reservation ? reservation.bytes - terminalBytes : 0;
        const unusedPending = reservation ? reservation.pendingBytes - terminalPending : 0;
        for (const [counter, requested, current, limit] of [
            ['frameBytes', encoded, 0, 65536],
            ['rows', count, rows, 1024 - (terminal ? 0 : unusedRows)],
            ['totalBytes', charge, bytes, pilotLimits.evidenceBytes - (terminal ? 0 : unusedBytes)],
            ['pendingBytes', queued, pending, 262144 - (terminal ? 0 : unusedPending)],
        ])
            if (requested + current > limit)
                throw reportingRefusal(stage, counter, encoded, current, limit);
        if (terminal) {
            assert(reservation, 'Terminal diagnostic reservation unavailable');
            const protectedRows =
                timelineReservation && !timeline ? timelineReservation.rows - timelineRows : 0;
            const protectedBytes =
                timelineReservation && !timeline ? timelineReservation.bytes - timelineBytes : 0;
            // The first-cause credit is always available. The larger summary may only
            // enqueue after the entire existing queue drains, so it cannot crowd a60KiB closure frame.
            const protectedPending =
                timelineReservation && !timeline && !timelineCauseClaimed ? 2048 : 0;
            assert(
                terminalRows + count <= reservation.rows - protectedRows,
                'Terminal diagnostic row reservation',
            );
            assert(
                terminalBytes + charge <= reservation.bytes - protectedBytes,
                'Terminal diagnostic byte reservation',
            );
            assert(
                terminalPending + queued <= reservation.pendingBytes - protectedPending,
                'Terminal diagnostic pending reservation',
            );
            if (timeline) {
                assert(timelineReservation && timelineRows + count <= timelineReservation.rows);
                assert(timelineBytes + charge <= timelineReservation.bytes);
                assert(timelinePending + queued <= timelineReservation.pendingBytes);
            }
        }
    };
    const enqueue = (work, queued, terminal = false, timeline = false) => {
        pending += queued;
        if (terminal) terminalPending += queued;
        if (timeline) timelinePending += queued;
        const queueCost = observer?.costStart('diagnostic-queue');
        const task = tail.then(() => {
            observer?.costEnd(queueCost, !failed);
            if (failed) throw failed;
            return work();
        });
        tail = task.then(
            () => {
                pending -= queued;
                if (terminal) terminalPending -= queued;
                if (timeline) timelinePending -= queued;
            },
            (e) => {
                pending -= queued;
                if (terminal) terminalPending -= queued;
                if (timeline) timelinePending -= queued;
                failed ??= e;
                hold(e);
            },
        );
        void task.catch(() => {});
        return task;
    };
    const add = (stage, data, terminal = false, timeline = false) => {
        // Timeline producer reserves full wire/journal overhead, not just its raw payload.
        const size =
            Buffer.byteLength(JSON.stringify({ stage, data })) * (timeline ? 2 : 1) +
            (timeline ? 512 : 0);
        if (failed) return Promise.reject(failed);
        if (!terminal && normalClosed)
            return Promise.reject(Error('Normal diagnostic admission closed by hold'));
        if (terminal)
            assert(
                [
                    'stage-held',
                    'stage-cancel-ack',
                    'pty-terminal',
                    'startup-terminal-observation',
                    'startup-terminal-observation-unavailable',
                    'stage-esbuild-stop-before',
                    'stage-esbuild-stop-after',
                    ...(timeline ? ['pty-stage-first-cancel', 'pty-stage-timeline'] : []),
                ].includes(stage),
                'Terminal observation stage allowlist',
            );
        budget(stage, 1, size, size, size, terminal, timeline);
        rows++;
        bytes += size;
        if (terminal) {
            terminalRows++;
            terminalBytes += size;
        }
        if (timeline) {
            timelineRows++;
            timelineBytes += size;
        }
        return enqueue(() => send(stage, data), size, terminal, timeline);
    };
    const emit = (stage, data) => add(stage, data);
    emit.publishIdentity = (stage, data) => {
        const lifecycle = lifecycleEvidenceStages.includes(stage);
        const plan = planStartupIdentity(stage, data, lifecycle ? lifecycleOrdinal + 1 : undefined);
        requireIdentityPlan(plan);
        if (failed) return Promise.reject(failed);
        if (normalClosed)
            return Promise.reject(Error('Normal diagnostic admission closed by hold'));
        const b = plan.budget;
        budget(plan.manifest.stage, b.rows, b.chargedBytes, b.peakBytes, b.peakBytes);
        if (lifecycle) lifecycleOrdinal++;
        rows += b.rows;
        bytes += b.chargedBytes;
        return enqueue(async () => {
            for (const frame of plan.frames()) await send(frame.stage, frame.data);
        }, b.peakBytes);
    };
    return {
        setObserver(value) {
            assert(rows === 0 && !observer);
            observer = value;
        },
        emit,
        reserveTerminal(limits) {
            assert(
                !reservation && rows === 0 && bytes === 0 && pending === 0,
                'Reserve terminal slots before diagnostic admission',
            );
            assert(Number.isInteger(limits.rows) && limits.rows > 0 && limits.rows <= 16);
            assert(Number.isInteger(limits.bytes) && limits.bytes > 0 && limits.bytes <= 131072);
            assert(
                Number.isInteger(limits.pendingBytes) &&
                    limits.pendingBytes > 0 &&
                    limits.pendingBytes <= 65536,
            );
            reservation = Object.freeze({ ...limits });
            return Object.freeze({
                reserveTimeline() {
                    assert(
                        !timelineReservation && terminalRows === 0 && rows === 0,
                        'Reserve timeline before admission',
                    );
                    assert(
                        reservation.rows >= 2 &&
                            reservation.bytes >= 34816 &&
                            reservation.pendingBytes >= 34816,
                    );
                    timelineReservation = Object.freeze({
                        rows: 2,
                        bytes: 34816,
                        pendingBytes: 34816,
                    });
                    return Object.freeze({
                        emit: (stage, data) => {
                            assert(
                                ['pty-stage-first-cancel', 'pty-stage-timeline'].includes(stage),
                            );
                            if (stage === 'pty-stage-first-cancel') {
                                assert(!timelineCauseClaimed, 'One first-cause attempt');
                                timelineCauseClaimed = true;
                            } else {
                                assert(
                                    !timelineSummaryClaimed && pending === 0,
                                    'Summary requires the original queue drained',
                                );
                                timelineSummaryClaimed = true;
                            }
                            const size = Buffer.byteLength(JSON.stringify({ stage, data })) + 512;
                            assert(
                                size <= (stage === 'pty-stage-first-cancel' ? 1024 : 16384),
                                'Timeline complete frame bound',
                            );
                            assert(
                                2 * (size - 512) + 512 <=
                                    (stage === 'pty-stage-first-cancel' ? 2048 : 32768),
                                'Timeline logical and wire charge',
                            );
                            return add(stage, data, true, true);
                        },
                    });
                },
                emit: (stage, data) => add(stage, data, true),
                note(stage, data) {
                    try {
                        void add(stage, data, true).catch(hold);
                    } catch (e) {
                        hold(e);
                    }
                },
                enterHold() {
                    normalClosed = true;
                },
            });
        },
        note(stage, data) {
            if (normalClosed) return;
            try {
                void emit(stage, data).catch(hold);
            } catch (e) {
                hold(e);
            }
        },
        async drain() {
            await tail;
            if (failed) throw failed;
        },
    };
}
