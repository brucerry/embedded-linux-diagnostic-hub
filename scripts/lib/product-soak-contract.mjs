import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const PRODUCT_SOAK_TIMING = Object.freeze({
    warmupMs: 300000,
    measuredMs: 1800000,
    measuredDeadlineMs: 1980000,
    minCycles: 100,
    budgetMs: 2400000,
    cleanupReserveMs: 60000,
});
export const SOAK_EVIDENCE_LIMITS = Object.freeze({
    timelineBytes: 512 * 1024 ** 2,
    lineBytes: 1024 ** 2,
    rows: 1000000,
    policyBytes: 256 * 1024,
});
const modes = ['normal', 'forced'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
function keys(value, fields) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
}
function time(value, maximum = PRODUCT_SOAK_TIMING.budgetMs) {
    assert.ok(
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum,
    );
}
function cycles(value) {
    assert.ok(
        Number.isSafeInteger(value) &&
            value >= PRODUCT_SOAK_TIMING.minCycles &&
            value <= SOAK_EVIDENCE_LIMITS.rows,
    );
}
/** Process-local monotonic intervals only. Wall-clock labels and warm-up never measure the run. */
export function validateSoakMeasurementWindow(value) {
    keys(value, [
        'schemaVersion',
        'clock',
        'warmupStartMs',
        'warmupEndMs',
        'measuredStartMs',
        'measuredEndMs',
        'completedCycles',
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.clock, 'process-performance-now/v1');
    for (const key of ['warmupStartMs', 'warmupEndMs', 'measuredStartMs', 'measuredEndMs'])
        time(value[key], Number.MAX_SAFE_INTEGER);
    assert.ok(
        value.warmupEndMs >= value.warmupStartMs &&
            value.measuredStartMs >= value.warmupEndMs &&
            value.measuredEndMs >= value.measuredStartMs,
    );
    const achievedWarmupMs = value.warmupEndMs - value.warmupStartMs;
    const achievedMeasuredMs = value.measuredEndMs - value.measuredStartMs;
    time(achievedWarmupMs);
    time(achievedMeasuredMs, PRODUCT_SOAK_TIMING.measuredDeadlineMs);
    assert.ok(achievedWarmupMs >= PRODUCT_SOAK_TIMING.warmupMs, 'Insufficient separate warm-up.');
    assert.ok(
        achievedMeasuredMs >= PRODUCT_SOAK_TIMING.measuredMs,
        'At least 30 measured minutes are required; warm-up cannot count.',
    );
    cycles(value.completedCycles);
    return { achievedWarmupMs, achievedMeasuredMs, completedCycles: value.completedCycles };
}

/** Version-two summary bindings are necessary consistency checks, never qualification. */
export function validateStagedGCModes(receipt) {
    assert.equal(receipt.schemaVersion, 2, 'Use per-mode measured GC evidence schema version 2.');
    assert.ok(
        !Object.hasOwn(receipt, 'reviewedPolicySHA256'),
        'A shared GC policy reference is unsupported.',
    );
    for (const mode of modes) {
        const value = receipt[mode + 'GC'];
        keys(value, [
            'status',
            'gcMode',
            'policySHA256',
            'assessmentIdentity',
            'sourceSHA256',
            'adapterHash',
            'achievedWarmupMs',
            'achievedMeasuredMs',
            'totalMs',
            'completedCycles',
            'receiptSHA256',
        ]);
        assert.equal(value.status, 'passed');
        assert.equal(value.gcMode, mode);
        for (const key of [
            'policySHA256',
            'assessmentIdentity',
            'sourceSHA256',
            'adapterHash',
            'receiptSHA256',
        ])
            assert.match(value[key], hashPattern);
        time(value.achievedWarmupMs);
        time(value.achievedMeasuredMs, PRODUCT_SOAK_TIMING.measuredDeadlineMs);
        time(value.totalMs);
        assert.ok(value.achievedWarmupMs >= PRODUCT_SOAK_TIMING.warmupMs);
        assert.ok(
            value.achievedMeasuredMs >= PRODUCT_SOAK_TIMING.measuredMs,
            'At least 30 measured minutes are required; total elapsed is not measured time.',
        );
        assert.ok(value.totalMs >= value.achievedWarmupMs + value.achievedMeasuredMs);
        cycles(value.completedCycles);
    }
    for (const key of ['policySHA256', 'assessmentIdentity', 'receiptSHA256'])
        assert.notEqual(
            receipt.normalGC[key],
            receipt.forcedGC[key],
            'GC modes must not reuse ' + key + '.',
        );
    assert.equal(receipt.normalGC.sourceSHA256, receipt.forcedGC.sourceSHA256);
}

function inspectTimeline(raw, summary, scope, policy) {
    assert.ok(
        Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= SOAK_EVIDENCE_LIMITS.timelineBytes,
    );
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let offset = 0,
        rows = 0,
        measured = 0,
        checkpoints = 0,
        warmups = 0,
        warming = 0;
    let assessment,
        window,
        receipt,
        sawMeasured = false;
    while (offset < raw.length) {
        const end = raw.indexOf(10, offset);
        assert.ok(
            end >= offset && end - offset > 0 && end - offset <= SOAK_EVIDENCE_LIMITS.lineBytes,
            'Incomplete or oversized soak timeline line.',
        );
        const text = decoder.decode(raw.subarray(offset, end));
        const row = JSON.parse(text);
        assert.equal(JSON.stringify(row), text, 'Require actual canonical soak-emitter rows.');
        keys(row, ['time', 'stage', 'data']);
        assert.ok(Number.isSafeInteger(row.time) && row.time >= 0);
        assert.ok(typeof row.stage === 'string' && row.stage.length > 0 && row.stage.length <= 256);
        assert.ok(++rows <= SOAK_EVIDENCE_LIMITS.rows);
        offset = end + 1;
        assert.equal(receipt, undefined, 'Soak receipt must be the final timeline row.');
        if (row.stage === 'assessment-context') {
            assert.equal(assessment, undefined);
            assert.equal(warmups + measured + warming + checkpoints, 0);
            assessment = row.data;
        } else if (row.stage === 'quiescent-checkpoint') {
            assert.ok(assessment && !window);
            if (row.data.phase === 'warmup') {
                assert.equal(sawMeasured, false);
                assert.equal(row.data.ordinal, warming++);
            } else {
                assert.equal(row.data.phase, 'measured');
                sawMeasured = true;
                assert.equal(row.data.ordinal, checkpoints++);
            }
        } else if (row.stage === 'warmup-cycle') {
            assert.ok(assessment && !window && !sawMeasured);
            warmups++;
            assert.equal(warmups, warming);
        } else if (row.stage === 'measured-cycle') {
            assert.ok(assessment && !window);
            sawMeasured = true;
            assert.equal(row.data.ordinal, measured++);
            assert.equal(checkpoints, measured);
        } else if (row.stage === 'measurement-window') {
            assert.ok(assessment && !window && sawMeasured);
            window = row.data;
            assert.equal(window.completedCycles, measured);
        } else if (row.stage === 'receipt') receipt = row.data;
    }
    assert.ok(
        assessment && window && receipt && warmups > 0,
        'Missing actual policy/measurement timeline records.',
    );
    assert.equal(assessment.mode, 'reviewed-policy-enforcement');
    const context = assessment.context;
    assert.equal(assessment.assessmentIdentity, hash(Buffer.from(JSON.stringify(context))));
    assert.equal(assessment.assessmentIdentity, summary.assessmentIdentity);
    assert.equal(policy.reviewed, true);
    assert.equal(policy.identitySHA256, summary.assessmentIdentity);
    assert.equal(context.sourceSHA256, summary.sourceSHA256);
    assert.equal(context.adapterHash, summary.adapterHash);
    assert.equal(context.config.gcMode, summary.gcMode);
    assert.equal(
        context.config.lane,
        scope === 'web' ? 'browser' : scope.startsWith('desktop-') ? 'desktop' : 'gateway',
    );
    assert.equal(context.config.component, false);
    for (const key of ['warmupMs', 'measuredMs', 'measuredDeadlineMs', 'minCycles'])
        assert.equal(context.config[key], PRODUCT_SOAK_TIMING[key]);
    assert.ok(
        Array.isArray(context.scope.roles) &&
            context.scope.roles.length > 0 &&
            new Set(context.scope.roles).size === context.scope.roles.length,
    );
    assert.deepEqual(Object.keys(policy.roles).sort(), [...context.scope.roles].sort());
    const times = validateSoakMeasurementWindow(window);
    assert.equal(
        receipt.status,
        'passed-reviewed-memory-scope',
        'Diagnostic/component/calibration results cannot qualify a product mode.',
    );
    assert.equal(receipt.failure, null);
    assert.deepEqual(receipt.missing, []);
    assert.equal(receipt.lane, context.config.lane);
    assert.equal(receipt.gcMode, summary.gcMode);
    for (const key of [
        'sourceSHA256',
        'adapterHash',
        'assessmentIdentity',
        'policySHA256',
        'achievedWarmupMs',
        'achievedMeasuredMs',
    ])
        assert.equal(receipt[key], summary[key]);
    assert.equal(receipt.achievedWarmupMs, times.achievedWarmupMs);
    assert.equal(receipt.achievedMeasuredMs, times.achievedMeasuredMs);
    assert.equal(receipt.cycles, measured);
    assert.equal(measured, summary.completedCycles);
    assert.equal(receipt.warmupCycles, warmups);
    assert.equal(warmups, warming);
    assert.equal(receipt.totalMs, summary.totalMs);
    assert.ok(receipt.totalMs >= window.measuredEndMs - window.warmupStartMs);
    assert.deepEqual(receipt.measurementWindow, window);
    assert.equal(receipt.memory.status, 'passed-reviewed-metrics');
    assert.equal(receipt.memory.assessmentIdentity, summary.assessmentIdentity);
    assert.equal(receipt.memory.policySHA256, summary.policySHA256);
    return { gcMode: summary.gcMode, ...times };
}

/** Consume existing harness policy/timeline records. This does not authenticate review,
 * bind final-artifact runtime/provenance, reassess budgets or establish parent retirement. */
export async function consumeStagedGCEvidence(rawReceipt, expected, readRetainedBytes) {
    const receipt = structuredClone(rawReceipt);
    const scope = expected.scope;
    validateStagedGCModes(receipt);
    assert.equal(receipt.scope, scope);
    const caseId =
        scope === 'web'
            ? 'web-product-resource-qualification'
            : scope === 'gateway'
              ? 'gateway-product-resource-qualification'
              : 'desktop-product-resource-qualification';
    const cases = receipt.cases.filter((row) => row.id === caseId);
    assert.equal(cases.length, 1);
    const used = new Set();
    async function retained(reference, maximum) {
        const matches = cases[0].evidence.filter((row) => row.sha256 === reference);
        assert.equal(
            matches.length,
            1,
            'Require one mode-specific resource-case evidence reference.',
        );
        const item = matches[0];
        assert.ok(!used.has(item.path));
        used.add(item.path);
        assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= maximum);
        const bytes = await readRetainedBytes(item.path, maximum);
        assert.ok(
            Buffer.isBuffer(bytes) && bytes.length === item.bytes && hash(bytes) === reference,
            'GC evidence changed after retained verification.',
        );
        return bytes;
    }
    const observations = [];
    for (const mode of modes) {
        const summary = receipt[mode + 'GC'];
        const policyBytes = await retained(summary.policySHA256, SOAK_EVIDENCE_LIMITS.policyBytes);
        const policy = JSON.parse(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(policyBytes),
        );
        const timeline = await retained(summary.receiptSHA256, SOAK_EVIDENCE_LIMITS.timelineBytes);
        observations.push(inspectTimeline(timeline, summary, scope, policy));
    }
    return Object.freeze({
        status: 'gc-policy-measurement-consistent-unqualified',
        observations,
        releaseAcceptance: false,
    });
}
