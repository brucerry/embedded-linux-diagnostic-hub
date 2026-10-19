import assert from 'node:assert/strict';
import { pilotLimits } from './hosted-pilot-contract.mjs';
import {
    planStartupIdentity,
    requireIdentityPlan,
    reportingRefusal,
} from './startup-identity-report.mjs';
/** PTY-only queue with reserved terminal capacity inside the original global limits. */
export function terminalRuntimeDiagnostics(send, hold) {
    let tail = Promise.resolve(),
        failed,
        rows = 0,
        bytes = 0,
        pending = 0;
    let reservation,
        normalClosed = false,
        terminalRows = 0,
        terminalBytes = 0,
        terminalPending = 0;
    const budget = (stage, count, charge, queued, encoded, terminal = false) => {
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
            assert(terminalRows + count <= reservation.rows, 'Terminal diagnostic row reservation');
            assert(
                terminalBytes + charge <= reservation.bytes,
                'Terminal diagnostic byte reservation',
            );
            assert(
                terminalPending + queued <= reservation.pendingBytes,
                'Terminal diagnostic pending reservation',
            );
        }
    };
    const enqueue = (work, queued, terminal = false) => {
        pending += queued;
        if (terminal) terminalPending += queued;
        const task = tail.then(() => {
            if (failed) throw failed;
            return work();
        });
        tail = task.then(
            () => {
                pending -= queued;
                if (terminal) terminalPending -= queued;
            },
            (e) => {
                pending -= queued;
                if (terminal) terminalPending -= queued;
                failed ??= e;
                hold(e);
            },
        );
        void task.catch(() => {});
        return task;
    };
    const add = (stage, data, terminal = false) => {
        const size = Buffer.byteLength(JSON.stringify({ stage, data }));
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
                ].includes(stage),
                'Terminal observation stage allowlist',
            );
        budget(stage, 1, size, size, size, terminal);
        rows++;
        bytes += size;
        if (terminal) {
            terminalRows++;
            terminalBytes += size;
        }
        return enqueue(() => send(stage, data), size, terminal);
    };
    const emit = (stage, data) => add(stage, data);
    emit.publishIdentity = (stage, data) => {
        const plan = planStartupIdentity(stage, data);
        requireIdentityPlan(plan);
        if (failed) return Promise.reject(failed);
        if (normalClosed)
            return Promise.reject(Error('Normal diagnostic admission closed by hold'));
        const b = plan.budget;
        budget(plan.manifest.stage, b.rows, b.chargedBytes, b.peakBytes, b.peakBytes);
        rows += b.rows;
        bytes += b.chargedBytes;
        return enqueue(async () => {
            for (const frame of plan.frames()) await send(frame.stage, frame.data);
        }, b.peakBytes);
    };
    return {
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
