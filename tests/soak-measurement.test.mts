import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MatchedCheckpoints,
    SamplingWindows,
    assertSoakGcCapability,
} from '../scripts/lib/soak-measurement.mjs';
import { qualificationArguments } from '../scripts/memory-runtime.mjs';
import {
    MemoryAssessment,
    validateMemoryPolicy,
    type MemoryPolicy,
} from './fixtures/memory-resource-verdict';

const readWindow = (overrides: any = {}) => ({
    schema: 1,
    clockDomain: 'node-performance',
    attempt: 1,
    quiescent: false,
    forceGc: false,
    readStartedMono: 0,
    readEndedMono: 800,
    status: 'usable',
    counts: { requests: 3, attempted: 1, usable: 1, unavailable: 0, coalesced: 2 },
    ...overrides,
});
test('slow reads and coalesced requests remain actual evidence without fabricated 250-ms samples', () => {
    const gate = new SamplingWindows();
    gate.accept(readWindow());
    gate.accept(
        readWindow({
            attempt: 2,
            readStartedMono: 850,
            readEndedMono: 1700,
            counts: { requests: 4, attempted: 2, usable: 2, unavailable: 0, coalesced: 2 },
        }),
    );
    const proof = gate.finish({
        requests: 4,
        attempted: 2,
        usable: 2,
        unavailable: 0,
        coalesced: 2,
    });
    assert.equal(proof.actualReadWindows, 2);
    assert.equal(proof.coalesced, 2);
    assert.equal(proof.totalReadMs, 1650);
    assert.equal(proof.maxReadMs, 850);
    assert.equal(proof.lastEndMono, 1700);
});
for (const [label, overrides] of [
    ['foreign clock', { clockDomain: 'wall-clock' }],
    ['infinite end', { readEndedMono: Infinity }],
    ['negative start', { readStartedMono: -1 }],
    ['backward read', { readStartedMono: 900 }],
    ['missing attempt', { attempt: 2 }],
    ['force GC outside quiescence', { forceGc: true }],
    [
        'fractional counter',
        { counts: { requests: 3, attempted: 1, usable: 1, unavailable: 0, coalesced: 0.5 } },
    ],
    [
        'invented available sample',
        { counts: { requests: 3, attempted: 1, usable: 2, unavailable: 0, coalesced: 2 } },
    ],
    [
        'unavailable without reason',
        {
            status: 'unavailable',
            counts: { requests: 3, attempted: 1, usable: 0, unavailable: 1, coalesced: 2 },
        },
    ],
] as const)
    test('sampling evidence rejects ' + label, () => {
        const gate = new SamplingWindows();
        assert.throws(() => gate.accept(readWindow(overrides)));
        assert.throws(() => gate.finish(readWindow().counts));
    });
test('overlap, regressed counters, missing final read and unavailable sampling refuse qualification', () => {
    const overlap = new SamplingWindows();
    overlap.accept(readWindow());
    assert.throws(
        () => overlap.accept(readWindow({ attempt: 2, readStartedMono: 799, readEndedMono: 900 })),
        /window/,
    );
    const regression = new SamplingWindows();
    regression.accept(readWindow());
    assert.throws(
        () =>
            regression.accept(
                readWindow({
                    attempt: 2,
                    readStartedMono: 800,
                    readEndedMono: 900,
                    counts: { requests: 2, attempted: 2, usable: 2, unavailable: 0, coalesced: 0 },
                }),
            ),
        /regression/,
    );
    const missing = new SamplingWindows();
    missing.accept(readWindow());
    assert.throws(
        () =>
            missing.finish({ requests: 4, attempted: 2, usable: 2, unavailable: 0, coalesced: 2 }),
        /Incomplete/,
    );
    const unavailable = new SamplingWindows();
    const counts = { requests: 1, attempted: 1, usable: 0, unavailable: 1, coalesced: 0 };
    unavailable.accept(readWindow({ status: 'unavailable', error: 'actual read refused', counts }));
    assert.throws(() => unavailable.finish(counts), /unavailable/);
});

const sample = (overrides: any = {}) => ({
    pid: 42,
    created: 'instance-A',
    role: 'gateway',
    state: 'running',
    heapUsedBytes: 100,
    arrayBuffersBytes: 100,
    externalBytes: 100,
    rssBytes: 100,
    unsupported: [],
    ...overrides,
});
const window = (ordinal: number, overrides: any = {}) => ({
    clockDomain: 'node-performance',
    startMono: ordinal * 300,
    endMono: ordinal * 300 + 50,
    globalOrdinal: ordinal,
    ...overrides,
});
function warmed(role = 'gateway') {
    const gate = new MatchedCheckpoints([role]);
    for (let n = 0; n < 3; n++) gate.visit([sample({ role })], 'constant/0', 'warmup', window(n));
    return gate;
}
function completed(role = 'gateway') {
    const gate = warmed(role);
    for (let n = 3; n < 6; n++) gate.visit([sample({ role })], 'constant/0', 'measured', window(n));
    return gate;
}
test('threshold-free calibration completeness retains exact checkpoint ordinals and monotonic windows', () => {
    const proof = completed().finish();
    assert.equal(proof.complete, true);
    assert.equal(proof.series.length, 4);
    assert.equal(proof.series[0].warm, 3);
    assert.equal(proof.series[0].measured, 3);
    assert.equal(proof.series[0].firstGlobalOrdinal, 0);
    assert.equal(proof.series[0].lastGlobalOrdinal, 5);
    assert.equal(proof.series[0].firstStartMono, 0);
    assert.equal(proof.series[0].lastEndMono, 1550);
    assert.equal(proof.slopeUnit, 'bytes-per-comparable-checkpoint');
});
for (const [label, overrides] of [
    ['foreign clock', { clockDomain: 'wall-clock' }],
    ['missing clock', { clockDomain: undefined }],
    ['negative clock', { startMono: -1 }],
    ['backward read', { endMono: 899 }],
    ['infinite clock', { startMono: Infinity }],
    ['NaN clock', { endMono: NaN }],
    ['overlapping window', { startMono: 849 }],
    ['non-spaced window', { startMono: 899 }],
    ['repeated ordinal', { globalOrdinal: 2 }],
    ['backward ordinal', { globalOrdinal: 1 }],
    ['fractional ordinal', { globalOrdinal: 3.5 }],
] as const)
    test('measurement rejects ' + label + ' and cannot recover into success', () => {
        const gate = warmed();
        assert.throws(() => gate.visit([sample()], 'constant/0', 'measured', window(3, overrides)));
        assert.throws(() => gate.visit([sample()], 'constant/0', 'measured', window(4)));
        assert.throws(() => gate.finish());
    });
for (const [label, value, state] of [
    ['replacement PID', sample({ pid: 43 }), 'constant/0'],
    ['reused PID creation', sample({ created: 'instance-B' }), 'constant/0'],
    ['other retained state', sample(), 'growing/1'],
] as const)
    test('warming cannot cross ' + label, () => {
        const gate = warmed();
        assert.throws(
            () => gate.visit([value], state, 'measured', window(3)),
            /exact matched warm/,
        );
    });
test('ephemeral role warms and measures within each actual PID lifetime', () => {
    const gate = completed('electron-renderer');
    const replacement = sample({ role: 'electron-renderer', pid: 43, created: 'instance-B' });
    assert.equal(gate.needsWarm([replacement], 'constant/0').length, 4);
    for (let n = 6; n < 9; n++)
        gate.visit([replacement], 'constant/0', 'ephemeral-warm', window(n));
    for (let n = 9; n < 12; n++) gate.visit([replacement], 'constant/0', 'measured', window(n));
    const proof = gate.finish();
    assert.equal(proof.series.length, 8);
    assert(
        proof.series.every(
            (row: any) => row.warm === 3 && row.measured === 3 && row.kind === 'lifecycle-local',
        ),
    );
    assert.equal(proof.processInstances, 2);
});
test('stable role cannot acquire ephemeral warmup during measurement', () => {
    assert.throws(
        () => warmed().visit([sample({ pid: 43 })], 'constant/0', 'ephemeral-warm', window(3)),
        /Stable series/,
    );
});
test('incomplete calibration cannot pass without policy thresholds', () => {
    const gate = warmed();
    gate.visit([sample()], 'constant/0', 'measured', window(3));
    gate.visit([sample()], 'constant/0', 'measured', window(4));
    assert.throws(() => gate.finish(), /Fewer than three/);
    const missingRole = new MatchedCheckpoints(['gateway', 'electron-renderer']);
    for (let n = 0; n < 6; n++)
        missingRole.visit([sample()], 'constant/0', n < 3 ? 'warmup' : 'measured', window(n));
    assert.throws(() => missingRole.finish(), /never measured/);
});
test('terminated processes retain null metrics and cannot provide a baseline', () => {
    const dead = sample({
        state: 'terminated',
        heapUsedBytes: null,
        arrayBuffersBytes: null,
        externalBytes: null,
        rssBytes: null,
    });
    const gate = new MatchedCheckpoints(['gateway']);
    for (let n = 0; n < 3; n++) gate.visit([dead], 'constant/0', 'warmup', window(n));
    assert.throws(() => gate.visit([sample()], 'constant/0', 'measured', window(3)), /warm/);
    assert.throws(
        () =>
            new MatchedCheckpoints(['gateway']).visit(
                [sample({ state: 'terminated' })],
                'constant/0',
                'warmup',
                window(0),
            ),
        /not zero/,
    );
});
test('metric unavailability is explicit and duplicate process rows cannot multiply observations', () => {
    assert.throws(
        () =>
            warmed().visit([sample({ heapUsedBytes: null })], 'constant/0', 'measured', window(3)),
        /reason/,
    );
    assert.throws(
        () => warmed().visit([sample(), sample()], 'constant/0', 'measured', window(3)),
        /Duplicate process/,
    );
    const gate = new MatchedCheckpoints(['gateway']);
    for (let n = 0; n < 6; n++)
        gate.visit(
            [sample({ externalBytes: null, unsupported: ['External unavailable'] })],
            'constant/0',
            n < 3 ? 'warmup' : 'measured',
            window(n),
        );
    assert.deepEqual(gate.finish().unavailable, [
        { key: '["gateway","externalBytes"]', reason: 'External unavailable' },
    ]);
});
test('process and series ceilings refuse the first excess identity/state without OS queries', () => {
    const instances = new MatchedCheckpoints(['gateway']);
    for (let n = 0; n < 256; n++) instances.needsWarm([sample({ pid: n + 1 })], 'constant/0');
    assert.throws(
        () => instances.needsWarm([sample({ pid: 257 })], 'constant/0'),
        /process history bound/,
    );
    const states = new MatchedCheckpoints(['gateway']);
    for (let n = 0; n < 256; n++) states.visit([sample()], 'state/' + n, 'warmup', window(n));
    assert.equal(states.series.size, 1024);
    assert.throws(
        () => states.visit([sample()], 'state/256', 'warmup', window(256)),
        /series bound/,
    );
});
test('GC launch arguments select forced diagnostics without executing GC or a child', () => {
    for (const mode of ['soak', 'soak-metadata']) {
        // Metadata entry uses the existing identity entry with its explicit soak target.
        const entry = mode === 'soak' ? 'soak' : 'identity';
        const extra = mode === 'soak' ? [] : ['--identity-for=soak'];
        const normal = qualificationArguments(
            entry,
            [...extra, '--gc=normal'],
            { preloadPath: '/owned/preload.cjs' },
            '/owned/tsx',
        );
        const forced = qualificationArguments(
            entry,
            [...extra, '--gc=forced'],
            { preloadPath: '/owned/preload.cjs' },
            '/owned/tsx',
        );
        assert(!normal.includes('--expose-gc'));
        assert.equal(forced.filter((value) => value === '--expose-gc').length, 1);
    }
    assert.throws(
        () =>
            qualificationArguments(
                'soak',
                ['--gc=normal', '--gc=forced'],
                { preloadPath: 'p' },
                'l',
            ),
        /Conflicting/,
    );
    let calls = 0;
    const gc = () => calls++;
    assert.equal(
        assertSoakGcCapability('forced', { execArgv: ['--expose-gc'] }, gc).forcedCalls,
        0,
    );
    assert.equal(calls, 0);
    assert.throws(() => assertSoakGcCapability('forced', { execArgv: [] }, gc), /expose-gc/);
    assert.throws(
        () => assertSoakGcCapability('forced', { execArgv: ['--expose-gc'] }, undefined),
        /unavailable/,
    );
    assert.equal(assertSoakGcCapability('normal', { execArgv: [] }, undefined).mode, 'normal');
});
test('slope policy units are checked and sparse global ordinals retain per-comparable-checkpoint slope', () => {
    const budget = {
        maxDeltaBytes: 1000,
        maxSlopeBytesPerComparableCheckpoint: 11,
        calibrationRuns: Array.from({ length: 10 }, (_, n) => n.toString(16).padStart(64, '0')),
    };
    const policy: MemoryPolicy = {
        reviewed: true,
        slopeUnit: 'bytes-per-comparable-checkpoint',
        identitySHA256: 'a'.repeat(64),
        roles: { gateway: { heapUsedBytes: budget, arrayBuffersBytes: budget } },
    };
    validateMemoryPolicy(policy, 'a'.repeat(64), ['gateway']);
    const legacy = { ...policy, slopeUnit: 'bytes-per-cycle' } as unknown as MemoryPolicy;
    assert.throws(() => validateMemoryPolicy(legacy, 'a'.repeat(64), ['gateway']), /unit/);
    assert.throws(() => new MemoryAssessment(legacy), /unit/);
    const assessment = new MemoryAssessment(policy),
        gate = new MatchedCheckpoints(['gateway']);
    for (let n = 0; n < 3; n++) {
        gate.visit([sample()], 'constant/0', 'warmup', window(n));
        assessment.warm([sample()], 'constant/0');
    }
    for (const [index, ordinal] of [10, 100, 1000].entries()) {
        const value = sample({
            heapUsedBytes: 100 + index * 10,
            arrayBuffersBytes: 100 + index * 10,
        });
        gate.visit([value], 'constant/0', 'measured', window(ordinal));
        assessment.observe([value], 'constant/0');
    }
    assert.equal(gate.finish().series[0].lastGlobalOrdinal, 1000);
    assert(
        assessment
            .finish()
            .every(
                (row) =>
                    row.bytesPerComparableCheckpoint === 10 &&
                    row.slopeUnit === 'bytes-per-comparable-checkpoint',
            ),
    );
});
