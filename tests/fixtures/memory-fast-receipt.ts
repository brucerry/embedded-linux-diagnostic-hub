import assert from 'node:assert/strict';
import { requireObservedClosure } from '../../scripts/lib/owned-child.mjs';
import { assertMemorySample, retained, type Memory } from './memory-resource-core';
import { sha256 } from './memory-resource-identity';

type Row = { stage: string; data: any };
export const fastDetectors: Record<string, RegExp> = {
    js: /retained-heapUsed/,
    buffer: /retained-arrayBuffers/,
    listener: /unsettled owners.*listener/,
    timer: /Unreleased timer owners/,
    pin: /unsettled owners.*pin/,
};
const fields = ['heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'rss'] as const;
const memory = (data: any): Memory => Object.fromEntries(fields.map((k) => [k, data[k]])) as Memory;

function expectedRows() {
    const result: any[] = [{ stage: 'identity' }];
    const checkpoint = (stage: string, cycle = -1) => {
        for (const gc of ['unforced', 'forced-first', 'forced-second'])
            result.push({ stage, cycle, gc });
    };
    const cycle = (phase: string, ordinal: number) => {
        for (const scenario of ['success', 'cancel', 'quota-begin', 'quota-append']) {
            result.push({ stage: 'work', phase, cycle: ordinal, gc: 'unforced', scenario });
            if (scenario === 'success')
                for (const format of ['json', 'csv', 'markdown', 'text'])
                    result.push({ stage: 'export', phase, cycle: ordinal, gc: 'unforced', format });
        }
        for (const stage of ['before-store-close', 'after-store-close', 'after-teardown']) {
            result.push({ stage, phase, cycle: ordinal, gc: 'unforced' });
            checkpoint(`${phase}-${stage}`, ordinal);
        }
    };
    checkpoint('startup');
    for (let i = 0; i < 3; i++) cycle('warmup', i);
    checkpoint('warmed-baseline');
    for (let i = 0; i < 12; i++) {
        cycle('measured', i);
        checkpoint('closed-cycle', i);
    }
    return result;
}

export function validateFastTranscript(rows: Row[], config: any, policySHA256: string | null) {
    assert.ok(rows.length >= 3 && rows.length <= 345, 'Incomplete or excessive fast timeline.');
    const finished = rows.at(-1)!;
    assert.equal(finished.stage, 'finished');
    assert.equal(finished.data.policySHA256, policySHA256, 'Leaf policy bytes differ.');
    assert.equal(
        finished.data.contractSHA256,
        sha256(JSON.stringify(config.contract)),
        'Leaf contract differs.',
    );
    const failed = rows.at(-2)?.stage === 'failure';
    const body = rows.slice(0, failed ? -2 : -1),
        expected = expectedRows();
    assert.ok(body.length <= expected.length);
    if (!failed) assert.equal(body.length, expected.length, 'Missing successful checkpoint rows.');
    let joins = 0;
    for (const [i, row] of body.entries()) {
        const want = expected[i];
        assert.equal(row.stage, want.stage, 'Unexpected checkpoint/stage order.');
        if (i === 0) {
            for (const [key, value] of Object.entries(config))
                assert.deepEqual(row.data[key], value, 'Identity changed: ' + key);
            assert.equal(row.data.configSHA256, sha256(JSON.stringify(config)));
            continue;
        }
        for (const key of ['cycle', 'gc', 'phase']) assert.equal(row.data[key], want[key]);
        assertMemorySample(memory(row.data));
        if (want.scenario) assert.equal(row.data.detail.scenario, want.scenario);
        if (want.format) {
            assert.equal(row.data.detail.format, want.format);
            assert.match(row.data.detail.sha256, /^[a-f0-9]{64}$/);
        }
        if (row.stage === 'after-teardown') {
            joins++;
            assert.deepEqual(row.data.detail.owners, []);
            assert.equal(row.data.detail.diskRecords, 0);
            for (const key of ['capturedBytes', 'exportedBytes'])
                assert.ok(Number.isSafeInteger(row.data.detail[key]) && row.data.detail[key] >= 0);
            assert.equal(
                row.data.detail.cache,
                'closed; catalog removed; canonical captures explicitly cleared',
            );
        }
    }
    const closed = body
        .filter((r) => r.stage === 'closed-cycle' && r.data.gc === 'forced-second')
        .map((r) => memory(r.data));
    const baseline = body.find(
        (r) => r.stage === 'warmed-baseline' && r.data.gc === 'forced-second',
    );
    const failure = failed ? rows.at(-2)!.data.message : null;
    assert.equal(finished.data.failure, failure);
    if (config.control === 'none' && !failed) assert.equal(finished.data.retainedControls, 0);
    if (config.control !== 'none') {
        assert.ok(Object.hasOwn(fastDetectors, config.control));
        assert.ok(
            failed && fastDetectors[config.control].test(failure),
            'Unrelated seeded failure.',
        );
        const allocations = ['js', 'buffer'].includes(config.control);
        assert.equal(body.length, allocations ? 343 : 87, 'Seed failed at an unrelated stage.');
        assert.equal(joins, allocations ? 15 : 4);
        assert.equal(closed.length, allocations ? 12 : 0);
        assert.equal(
            finished.data.retainedControls,
            allocations ? 12 : config.control === 'pin' ? 2 : 1,
        );
    }
    return { failure, joins, closed, baseline: baseline ? memory(baseline.data) : null };
}

export function rssEvidence(rows: any[], sampled: boolean, expectedPID?: number) {
    if (!sampled) {
        assert.equal(rows.length, 0);
        return { attempts: 0, usable: 0, unavailable: 0, peak: null };
    }
    assert.ok(
        rows.length > 0 && rows.length <= 4096,
        'Sampled RSS evidence is missing or excessive.',
    );
    let peak: number | null = null,
        usable = 0,
        previous: number | null = null,
        previousCompleted = 0,
        maxGapMs = 0,
        maxLatencyMs = 0;
    for (const row of rows) {
        if (expectedPID !== undefined)
            assert.equal(row.pid, expectedPID, 'RSS PID differs from owned leaf.');
        assert.ok(
            Number.isFinite(row.startedMs) &&
                row.startedMs >= previousCompleted &&
                Number.isFinite(row.completedMs) &&
                row.completedMs >= row.startedMs,
        );
        assert.equal(row.latencyMs, row.completedMs - row.startedMs);
        if (previous !== null) {
            assert.ok(row.startedMs >= previous);
            maxGapMs = Math.max(maxGapMs, row.startedMs - previous);
        }
        previous = row.startedMs;
        previousCompleted = row.completedMs;
        maxLatencyMs = Math.max(maxLatencyMs, row.latencyMs);
        assert.equal(row.unavailable, row.rssBytes === null);
        if (row.rssBytes !== null) {
            assert.ok(
                Number.isSafeInteger(row.rssBytes) && row.rssBytes >= 0,
                'Invalid RSS observation.',
            );
            usable++;
            peak = Math.max(peak ?? 0, row.rssBytes);
        }
    }
    assert.ok(usable > 0 && peak !== null, 'Sampled run has no usable RSS observation/peak.');
    return {
        attempts: rows.length,
        usable,
        unavailable: rows.length - usable,
        peak,
        firstStartedMs: rows[0].startedMs,
        lastCompletedMs: rows.at(-1).completedMs,
        maxGapMs,
        maxLatencyMs,
    };
}

export function validateFastCollection(input: {
    lifecycle: any;
    config: any;
    policySHA256: string | null;
    rows: Row[];
    rss: any[];
    evidenceClosed: boolean;
    samplerFailure: unknown;
    measurement?: any;
    ceilings: { heapUsed: number; arrayBuffers: number };
    childEvidence: any;
    childLog: string;
}) {
    requireObservedClosure(input.lifecycle);
    assert.equal(input.evidenceClosed, true, 'Evidence handles did not close.');
    assert.equal(input.samplerFailure, null, 'Sampler/collector error.');
    const sampled = input.config.observerMode === 'sampled';
    const sampler = rssEvidence(input.rss, sampled, input.lifecycle.pid);
    const audit = validateFastTranscript(input.rows, input.config, input.policySHA256);
    assert.deepEqual(input.childEvidence, {
        timelineClosed: true,
        timelineSynced: true,
        policySHA256: input.policySHA256,
        contractSHA256: sha256(JSON.stringify(input.config.contract)),
    });
    if (input.lifecycle.code === 0) {
        assert.equal(input.config.control, 'none');
        assert.equal(audit.failure, null);
        assert.equal(audit.joins, 15);
        const measurement = input.measurement;
        assert.ok(measurement && audit.baseline);
        assert.deepEqual(measurement.config, input.config);
        assert.equal(measurement.policySHA256, input.policySHA256);
        assert.deepEqual(measurement.baseline, audit.baseline);
        assert.deepEqual(measurement.samples, audit.closed);
        assert.deepEqual(measurement.ceilings, input.ceilings);
        assert.deepEqual(
            measurement.summary,
            retained(audit.baseline!, audit.closed, input.ceilings),
        );
        return {
            verdict: input.policySHA256 ? 'FINITE_POLICY_PASS' : 'PROVISIONAL_DIAGNOSTIC',
            sampler,
            audit,
        };
    }
    assert.equal(input.lifecycle.code, 1, 'Unexpected child exit.');
    assert.ok(audit.failure, 'Normal failure lacks failure evidence.');
    assert.ok(
        input.childLog.includes(audit.failure),
        'Leaf log does not confirm the recorded failure.',
    );
    if (['js', 'buffer'].includes(input.config.control)) {
        let detected = false;
        try {
            retained(audit.baseline!, audit.closed, input.ceilings);
        } catch (error) {
            assert.ok(
                fastDetectors[input.config.control].test(String(error)),
                'Wrong numeric seed detector.',
            );
            assert.equal(
                audit.failure,
                String(error),
                'Failure does not match the exact-policy numerical violation.',
            );
            detected = true;
        }
        assert.ok(detected, 'Seed has no exact-policy numerical violation.');
    }
    return {
        verdict: input.config.control === 'none' ? 'REGRESSION_FAIL' : 'EXPECTED_NEGATIVE_DETECTED',
        sampler,
        audit,
    };
}
