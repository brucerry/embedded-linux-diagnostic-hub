import assert from 'node:assert/strict';
import { cleanupErrorReason } from './pilot-cleanup-diagnostics.mjs';
import { createHash } from 'node:crypto';
export const timelineLimits = Object.freeze({
    events: 96,
    rows: 2,
    bytes: 34816,
    pendingBytes: 34816,
    summaryBytes: 16384,
    causeBytes: 1024,
    envelopeBytes: 512,
    operations: 4096,
});
export const timelinePhases = Object.freeze([
    'entry',
    'runtime',
    'import',
    'assertions',
    'tool-discovery',
    'tool-identities',
    'home',
    'compiler',
    'compiler-join',
    'artifact',
    'fixture',
    'gateway',
    'journal-open',
    'connect',
    'actor-open',
    ...Array.from({ length: 8 }, (_, i) => 'step-' + (i + 1)),
    'finish',
    'settled',
    'readback',
    'cleanup',
    'cleanup-actor',
    'cleanup-session',
    'cleanup-pty',
    'cleanup-server',
    'cleanup-store',
    'cleanup-journal',
    'startup-join',
    'diagnostic-drain',
    'verdict',
]);
export const timelineOrigins = Object.freeze([
    'stage-timer',
    'parent-ipc',
    'signal',
    'disconnect',
    'runtime',
    'compiler',
    'ownership-hold',
    'work-failure',
    'abort-observed',
    'parent-runtime-timer',
    'parent-stage-timer',
    'parent-entry-cutoff',
    'parent-completion-cutoff',
    'parent-signal',
    'child-admission-cutoff',
]);
const costNames = Object.freeze([
    'process-query',
    'descendant-proof',
    'diagnostic-ack',
    'startup-diagnostics',
    'journal',
    'diagnostic-encode',
    'diagnostic-queue',
    'parent-evidence',
]);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
/** Local paired sample. No shared cross-process clock origin is presumed. */
export function stageClockSample() {
    const before = process.hrtime.bigint();
    const perfUs = Math.round(performance.now() * 1000);
    const after = process.hrtime.bigint();
    return { hrBefore: Number(before / 1000000n), perfUs, hrAfter: Number(after / 1000000n) };
}
export function validateStageClock(s) {
    assert(s && Object.keys(s).sort().join(',') === 'hrAfter,hrBefore,perfUs');
    assert(
        [s.hrBefore, s.perfUs, s.hrAfter].every(integer) && s.hrAfter >= s.hrBefore,
        'Invalid paired clock sample',
    );
    return s;
}
/** Causal parent-send/child-event/parent-receive bracket; delivery uncertainty is never zeroed. */
export function stageClockMapping(sample, { sent, received }) {
    validateStageClock(sample);
    assert(
        integer(sent) && integer(received) && received >= sent,
        'Invalid causal delivery bracket',
    );
    const perfMs = sample.perfUs / 1000;
    return Object.freeze({
        anchorPerfUs: sample.perfUs,
        parentOffsetMs: [sent - perfMs - 0.001, received + 1 - perfMs + 0.001],
        deliveryWidthMs: received + 1 - sent,
        parentRoundingMs: 1,
        localSampleWidthMs: sample.hrAfter - sample.hrBefore + 1,
        performanceRoundingMs: 0.001,
        commonOriginAssumed: false,
    });
}
export function mappedStageInterval(perfUs, mapping) {
    assert.equal(perfUs, mapping.anchorPerfUs, 'Unanchored event mapping is not permitted');
    assert(
        integer(perfUs) &&
            Array.isArray(mapping.parentOffsetMs) &&
            mapping.parentOffsetMs.length === 2,
    );
    const [a, b] = mapping.parentOffsetMs;
    assert(Number.isFinite(a) && Number.isFinite(b) && b >= a);
    return [perfUs / 1000 + a - 0.001, perfUs / 1000 + b + 0.001];
}
export function stageIntervalOrder(a, b) {
    assert(a[1] >= a[0] && b[1] >= b[0]);
    return a[1] < b[0] ? 'before' : b[1] < a[0] ? 'after' : 'unresolved';
}
/** Fixed ledger/counters only. No per-event IO, timer, process query or authority. */
export function ptyStageTimeline({
    deadline,
    emit,
    hold,
    clock = stageClockSample,
    pid = process.pid,
}) {
    assert(integer(deadline) && integer(pid));
    const events = [],
        active = new Map(),
        counters = costNames.map(() => [0, 0, 0, 0, 0, 0]);
    let first,
        causeTask,
        causeStarted = false,
        finishTask,
        failed,
        lastHr = 0,
        lastPerf = 0,
        operations = 0,
        later = 0,
        measured = 0,
        lastSample = null,
        offsetLower = -Infinity,
        offsetUpper = Infinity;
    const fault = (e) => {
        if (failed) return;
        failed = e;
        hold(e);
    };
    const sample = () => {
        assert(measured < 8400, 'PTY timeline sampling bound');
        const s = Object.freeze({ ...validateStageClock(clock()) });
        assert(s.hrBefore >= lastHr && s.perfUs >= lastPerf, 'Nonmonotonic diagnostic clock');
        const lower = s.hrBefore - s.perfUs / 1000 - 0.001,
            upper = s.hrAfter + 1 - s.perfUs / 1000 + 0.001;
        offsetLower = Math.max(offsetLower, lower);
        offsetUpper = Math.min(offsetUpper, upper);
        assert(offsetUpper >= offsetLower, 'Inconsistent local clock origin');
        lastHr = s.hrAfter;
        lastPerf = s.perfUs;
        measured++;
        lastSample = s;
        return s;
    };
    const write = (phase, edge) => {
        if (failed) return;
        try {
            assert(events.length < timelineLimits.events, 'PTY timeline event bound');
            assert(integer(phase) && phase < timelinePhases.length);
            const s = sample();
            const row = [events.length, phase, edge, s.hrBefore, s.perfUs, s.hrAfter];
            events.push(row);
            return row;
        } catch (e) {
            fault(e);
        }
    };
    // These phases only drain custody already admitted by the original controller.
    // A diagnostic fault must close new work, never bypass these owned attempts.
    const settlement = (name) =>
        [
            'settled',
            'compiler-join',
            'startup-join',
            'diagnostic-drain',
            ...timelinePhases.filter((p) => p.startsWith('cleanup')),
        ].includes(name);
    const settlementCost = (name) => name === 'journal' || name === 'descendant-proof';
    const begin = (name) => {
        if (failed) {
            if (!settlement(name)) throw failed;
            return;
        }
        try {
            const phase = timelinePhases.indexOf(name);
            assert(phase >= 0 && !active.has(phase), 'Unknown or repeated active PTY phase');
            const row = write(phase, 0);
            if (row) active.set(phase, row[0]);
            if (failed && !settlement(name)) throw failed;
            return phase;
        } catch (e) {
            fault(e);
            if (!settlement(name)) throw e;
        }
    };
    const end = (phase, ok = true) => {
        if (phase === undefined) return;
        if (failed) {
            if (!settlement(timelinePhases[phase])) throw failed;
            return;
        }
        try {
            assert(active.has(phase), 'Unentered or duplicate PTY phase end');
            const row = write(phase, ok ? (first ? 4 : 1) : 2);
            if (row) active.delete(phase);
            if (failed && !settlement(timelinePhases[phase])) throw failed;
        } catch (e) {
            fault(e);
            if (!settlement(timelinePhases[phase])) throw e;
        }
    };
    const costStart = (name) => {
        if (failed) return;
        try {
            const id = costNames.indexOf(name);
            assert(
                id >= 0 && ++operations <= timelineLimits.operations,
                'PTY timeline operation bound',
            );
            const s = sample();
            const c = counters[id];
            c[0]++;
            c[3]++;
            return { id, at: s.perfUs, done: false };
        } catch (e) {
            fault(e);
        }
    };
    const costEnd = (token, ok = true) => {
        if (!token || failed) return;
        try {
            assert(!token.done, 'Duplicate diagnostic cost completion');
            token.done = true;
            const s = sample(),
                c = counters[token.id],
                elapsed = s.perfUs - token.at;
            assert(integer(elapsed) && Number.isSafeInteger(c[4] + elapsed));
            c[ok ? 1 : 2]++;
            c[3]--;
            c[4] += elapsed;
            c[5] = Math.max(c[5], elapsed);
        } catch (e) {
            fault(e);
        }
    };
    const anchor = () => {
        try {
            return sample();
        } catch (e) {
            fault(e);
            return null;
        }
    };
    const payload = () => ({
        schema: 1,
        kind: 'pty-stage-timeline',
        processRole: 'stage',
        pid,
        deadline,
        diagnosticClock: lastSample,
        localOffsetInterval: measured ? [offsetLower, offsetUpper] : null,
        events: events.map((r) => [...r]),
        pendingPhases: [...active.keys()],
        missingPhases: timelinePhases
            .map((_, id) => id)
            .filter((id) => !events.some((row) => row[1] === id && row[2] === 0)),
        firstCancellation: first ?? null,
        laterCancellationCount: later,
        counters: counters.map((c, id) => [id, ...c]),
        counterNames: costNames,
        sampledOperations: measured,
        measuredThrough: { hrMs: lastHr, perfUs: lastPerf },
        phaseLedgerComplete:
            !failed &&
            active.size === 0 &&
            timelinePhases.every((_, id) => events.some((row) => row[1] === id && row[2] === 0)),
        diagnosticFailed: Boolean(failed),
        authority: false,
        omissions: [
            'Final summary own encode/send/ACK and later stage-final/pipe-close are outside this snapshot.',
            'Aggregate service sums overlap; not CPU or critical-path attribution.',
            'Missing phase ends remain pending; no closure or release proof.',
        ],
    });
    const publish = (stage, data, max) => {
        try {
            const encoding = costStart('diagnostic-encode');
            const bytes =
                Buffer.byteLength(JSON.stringify({ stage, data })) + timelineLimits.envelopeBytes;
            costEnd(encoding);
            assert(bytes <= max, 'Complete PTY timeline frame bound');
            const task = Promise.resolve(emit(stage, data));
            void task.catch(fault);
            return task;
        } catch (e) {
            fault(e);
            return Promise.reject(e);
        }
    };
    return Object.freeze({
        begin,
        end,
        anchor,
        costStart,
        costEnd,
        async phase(name, work) {
            const token = begin(name);
            try {
                const result = await work();
                end(token);
                return result;
            } catch (e) {
                try {
                    end(token, false);
                } catch {}
                throw e;
            }
        },
        async measure(name, work) {
            const token = costStart(name);
            if (failed && !settlementCost(name)) throw failed;
            try {
                const result = await work();
                costEnd(token);
                if (failed && !settlementCost(name)) throw failed;
                return result;
            } catch (e) {
                costEnd(token, false);
                throw e;
            }
        },
        cancel(origin, reason, alreadyAborted) {
            if (failed) return first ?? null;
            if (first) {
                if (later < timelineLimits.operations) later++;
                else fault(Error('Later cancellation counter bound'));
                return first;
            }
            try {
                const code = timelineOrigins.indexOf(origin);
                assert(code >= 0, 'Unknown cancellation origin');
                const s = sample();
                const text = cleanupErrorReason(reason);
                first = Object.freeze({
                    origin: code,
                    ordinal: events.length,
                    phase: Object.freeze([...active.keys()].slice(-16)),
                    activePhaseCount: active.size,
                    clock: s,
                    deadline,
                    alreadyAborted: Boolean(alreadyAborted),
                    reasonSHA256: createHash('sha256').update(text).digest('hex'),
                });
                return first;
            } catch (e) {
                fault(e);
                return null;
            }
        },
        publishCancellation() {
            if (!first || causeStarted) return causeTask;
            causeStarted = true;
            causeTask = publish(
                'pty-stage-first-cancel',
                {
                    schema: 1,
                    kind: 'pty-stage-first-cancel',
                    pid,
                    firstCancellation: first,
                    authority: false,
                },
                timelineLimits.causeBytes,
            );
            void causeTask.catch(() => {});
            return causeTask;
        },
        first: () => first ?? null,
        failure: () => failed ?? null,
        snapshot: payload,
        finish() {
            return (finishTask ??= (async () => {
                await causeTask;
                if (failed) throw failed;
                const data = payload();
                await publish('pty-stage-timeline', data, timelineLimits.summaryBytes);
                await causeTask;
                return {
                    summaryDurableACKObserved: true,
                    firstCauseAtCapture: Boolean(data.firstCancellation),
                    authority: false,
                };
            })());
        },
    });
}

/** Receiver validation is evidence integrity only; it creates no completion or release authority. */
export function validateTimelineRecord(stage, data) {
    assert(['pty-stage-first-cancel', 'pty-stage-timeline'].includes(stage));
    assert(data?.schema === 1 && data.authority === false && integer(data.pid));
    assert.equal(
        data.kind,
        stage === 'pty-stage-first-cancel' ? 'pty-stage-first-cancel' : 'pty-stage-timeline',
    );
    const limit =
        stage === 'pty-stage-first-cancel'
            ? timelineLimits.causeBytes
            : timelineLimits.summaryBytes;
    assert(
        Buffer.byteLength(JSON.stringify({ stage, data })) + timelineLimits.envelopeBytes <= limit,
        'Timeline receiver frame bound',
    );
    const cause = data.firstCancellation;
    if (cause) {
        assert(
            integer(cause.origin) &&
                cause.origin < timelineOrigins.length &&
                integer(cause.ordinal) &&
                cause.ordinal <= timelineLimits.events,
        );
        validateStageClock(cause.clock);
        assert(integer(cause.deadline) && typeof cause.alreadyAborted === 'boolean');
        assert(/^[a-f0-9]{64}$/.test(cause.reasonSHA256));
        assert(
            Array.isArray(cause.phase) &&
                cause.phase.length <= 16 &&
                cause.phase.every((id) => integer(id) && id < timelinePhases.length),
        );
        assert(
            integer(cause.activePhaseCount) &&
                cause.activePhaseCount <= timelinePhases.length &&
                cause.phase.length === Math.min(cause.activePhaseCount, 16),
        );
    }
    if (stage === 'pty-stage-first-cancel') {
        assert(cause);
        return data;
    }
    assert(
        integer(data.deadline) &&
            Array.isArray(data.events) &&
            data.events.length <= timelineLimits.events,
    );
    const active = new Set(),
        entered = new Set();
    let hr = 0,
        perf = 0;
    for (const [index, row] of data.events.entries()) {
        assert(Array.isArray(row) && row.length === 6 && row.every(integer));
        const [seq, id, edge, before, us, after] = row;
        assert(
            seq === index &&
                id < timelinePhases.length &&
                [0, 1, 2, 4].includes(edge) &&
                after >= before &&
                before >= hr &&
                us >= perf,
            'Malformed/reordered timeline phase',
        );
        if (edge === 0) {
            assert(!active.has(id));
            active.add(id);
            entered.add(id);
        } else {
            assert(active.has(id), 'Missing phase entry');
            active.delete(id);
        }
        hr = after;
        perf = us;
    }
    assert.deepEqual(data.pendingPhases, [...active]);
    assert.deepEqual(
        data.missingPhases,
        timelinePhases.map((_, id) => id).filter((id) => !entered.has(id)),
    );
    assert(typeof data.diagnosticFailed === 'boolean');
    assert.equal(
        data.phaseLedgerComplete,
        !data.diagnosticFailed && active.size === 0 && data.missingPhases.length === 0,
    );
    assert(Array.isArray(data.counters) && data.counters.length === costNames.length);
    for (const [index, row] of data.counters.entries()) {
        const [id, ...c] = row;
        assert.equal(id, index);
        assert(integer(id) && id < costNames.length && c.length === 6 && c.every(integer));
        assert(c[0] === c[1] + c[2] + c[3] && c[0] <= timelineLimits.operations && c[5] <= c[4]);
    }
    assert(
        integer(data.laterCancellationCount) &&
            data.laterCancellationCount <= timelineLimits.operations,
    );
    return data;
}

export const timelineJournalTags = Object.freeze([
    'real-os-pty:pty-stage-first-cancel',
    'real-os-pty:pty-stage-timeline',
    'pty-parent-first-cancel',
]);
/** Root journal shares the original10MiB/4096-row ceiling with prerequisites and ordinary evidence. */
export function timelineJournalBudget(initialBytes, maximumBytes, maximumRows = 4096) {
    assert(
        integer(initialBytes) &&
            integer(maximumBytes) &&
            maximumBytes >= initialBytes + timelineLimits.bytes + 2048 &&
            maximumBytes <= 10485760 &&
            integer(maximumRows) &&
            maximumRows >= 3 &&
            maximumRows <= 4096,
    );
    let bytes = initialBytes,
        rows = 0,
        reservedBytes = timelineLimits.bytes + 2048,
        reservedRows = 3;
    const charged = new Set(),
        written = new Set();
    return Object.freeze({
        reserve(n, tag) {
            assert(integer(n));
            const special = tag !== undefined;
            if (special) {
                assert(
                    timelineJournalTags.includes(tag) && !charged.has(tag),
                    'One root timeline byte reservation',
                );
                assert(n <= (tag === timelineJournalTags[1] ? 32768 : 2048) && n <= reservedBytes);
            }
            assert(
                bytes + n <= maximumBytes - (special ? 0 : reservedBytes),
                'Root journal protected timeline byte reserve',
            );
            bytes += n;
            if (special) {
                reservedBytes -= n;
                charged.add(tag);
            }
        },
        row(tag) {
            const special = tag !== undefined;
            if (special)
                assert(
                    charged.has(tag) && !written.has(tag),
                    'Unreserved or duplicate timeline row',
                );
            assert(
                rows < maximumRows - (special ? 0 : reservedRows),
                'Root journal protected timeline row reserve',
            );
            rows++;
            if (special) {
                reservedRows--;
                written.add(tag);
            }
        },
        snapshot: () => ({ bytes, rows, reservedBytes, reservedRows, authority: false }),
    });
}

export const stageReasonDigest = (reason) =>
    createHash('sha256').update(cleanupErrorReason(reason)).digest('hex');
