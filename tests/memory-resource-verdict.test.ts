import { mockLife } from './fixtures/memory-fast-test-input';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MemoryAssessment,
    validateMemoryPolicy,
    requirements,
    childTermination,
    requireNegativeDetection,
    type MemoryPolicy,
    type ProcessSample,
} from './fixtures/memory-resource-verdict';
import {
    ProcessSampler,
    readLinuxProcesses,
    type ProcessRow,
} from './fixtures/memory-resource-processes';
import { viewerCoverage, viewerOwnerKinds } from './fixtures/memory-resource-core';
import { verifySoak, verifyNegativeWrapper } from './fixtures/memory-resource-verifier';
const budget = {
    maxDeltaBytes: 1024,
    maxSlopeBytesPerComparableCheckpoint: 0.25,
    calibrationRuns: Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(64, '0')),
};
const policy = (): MemoryPolicy => ({
    reviewed: true,
    slopeUnit: 'bytes-per-comparable-checkpoint',
    identitySHA256: 'a'.repeat(64),
    roles: { gateway: { heapUsedBytes: { ...budget }, arrayBuffersBytes: { ...budget } } },
});
const sample = (bytes = 100): ProcessSample => ({
    pid: 10,
    created: 'A',
    role: 'gateway',
    state: 'running',
    rssBytes: bytes,
    heapUsedBytes: bytes,
    arrayBuffersBytes: bytes,
    externalBytes: bytes,
    unsupported: [],
});

test('soak source verdict blocks an unreviewed product run and rejects synthetic 256-MiB/sample growth', async () => {
    const blocked = await verifySoak({ growth: true });
    assert.equal(blocked.receipt.status, 'blocked');
    assert.equal(blocked.cycles, 0);
    assert.match(blocked.receipt.failure, /reviewed policy/);
    const growing = await verifySoak({ policy: true, growth: true });
    assert.equal(growing.receipt.status, 'failed');
    assert.match(growing.receipt.failure, /retained-memory-growth/);
    assert.equal(growing.realGrowthAllocated, 0);
    assert.equal(growing.realProcessesQueried, 0);
    const healthy = await verifySoak({ policy: true });
    assert.equal(healthy.receipt.status, 'passed-reviewed-memory-scope');
    assert.equal(healthy.receipt.cycles, 100);
    assert.equal(healthy.receipt.memory.status, 'passed-reviewed-metrics');
    assert.ok(
        healthy.receipt.memory.unqualifiedMetrics.some(
            (item: { metric: string }) => item.metric === 'rssBytes',
        ),
    );
});
test('reviewed assessment checks slopes, missing metrics, matched state and calibration identity', () => {
    validateMemoryPolicy(policy(), 'a'.repeat(64), ['gateway']);
    assert.throws(
        () =>
            validateMemoryPolicy(
                { ...policy(), reviewed: false } as unknown as MemoryPolicy,
                'a'.repeat(64),
                ['gateway'],
            ),
        /identity mismatch/,
    );
    assert.throws(
        () => validateMemoryPolicy(policy(), 'b'.repeat(64), ['gateway']),
        /identity mismatch/,
    );
    const uncalibrated = policy();
    uncalibrated.roles.gateway.heapUsedBytes!.calibrationRuns = [];
    assert.throws(
        () => validateMemoryPolicy(uncalibrated, 'a'.repeat(64), ['gateway']),
        /Uncalibrated/,
    );
    const assessment = new MemoryAssessment(policy());
    for (let i = 0; i < 3; i++) assessment.warm([sample()], 'constant/0');
    for (let i = 0; i < 10; i++) assessment.observe([sample(100 + i)], 'constant/0');
    assert.throws(() => assessment.finish(), /retained-memory-slope/);
    assert.throws(() => assessment.observe([sample()], 'growing/500'), /matched warmed/);
    assert.throws(
        () =>
            assessment.observe(
                [{ ...sample(), heapUsedBytes: null, unsupported: ['heap unsupported'] }],
                'constant/0',
            ),
        /unsupported/,
    );
    const both = policy();
    both.roles.renderer = both.roles.gateway;
    const incomplete = new MemoryAssessment(both);
    for (let i = 0; i < 3; i++)
        incomplete.warm([sample(), { ...sample(), pid: 11, role: 'renderer' }], 'constant/0');
    for (let i = 0; i < 3; i++) incomplete.observe([sample()], 'constant/0');
    assert.throws(() => incomplete.finish(), /renderer.*not measured/);
});
test('PID reuse retains replacement ownership through reparenting and rejects unreadable liveness', async () => {
    let rows: ProcessRow[] = [
        { pid: 10, parent: 1, created: 'root-A', rssBytes: 1 },
        { pid: 20, parent: 10, created: 'child-A', rssBytes: 1 },
    ];
    const sampler = new ProcessSampler([10], async () => rows);
    await sampler.sample();
    rows = [rows[0], { pid: 20, parent: 10, created: 'child-B', rssBytes: 2 }];
    const reused = await sampler.sample();
    assert.equal(reused.find((row) => row.created === 'child-A')!.state, 'terminated');
    assert.equal(reused.find((row) => row.created === 'child-B')!.state, 'running');
    rows = [{ pid: 20, parent: 1, created: 'child-B', rssBytes: 2 }];
    await assert.rejects(sampler.assertExited(), /still running/);
    rows = [];
    await sampler.assertExited();
    const unavailable = new ProcessSampler([10], async () => {
        throw Object.assign(Error('denied'), { code: 'EACCES' });
    });
    await assert.rejects(unavailable.assertExited(), /denied/);
    await assert.rejects(new ProcessSampler([10], async () => []).sample(), /identity unavailable/);
    await assert.rejects(
        readLinuxProcesses({
            list: async () => ['10'],
            read: async () => {
                throw Object.assign(Error('permission'), { code: 'EACCES' });
            },
        }),
        /permission/,
    );
});
test('signal crashes, Windows crash codes, timeouts and wrong exits cannot satisfy negative controls', async () => {
    const receipt = {
        ...mockLife(1),
        lifecycle: mockLife(1),
        evidenceClosed: true,
        verdict: 'EXPECTED_NEGATIVE_DETECTED',
        policySHA256: null,
        timedOut: false,
        samplerFailure: null,
        childExit: 'normal-failure',
    };
    requireNegativeDetection('js', mockLife(1), receipt, 'retained-heapUsed', /retained-heapUsed/);
    for (const bad of [
        { code: null, signal: 'SIGABRT' },
        { code: 3221225477, signal: null },
        { code: 2, signal: null },
        { timedOut: true },
    ])
        assert.throws(
            () =>
                requireNegativeDetection(
                    'js',
                    mockLife(1),
                    { ...receipt, ...bad },
                    'retained-heapUsed',
                    /retained-heapUsed/,
                ),
            /not leak detection/,
        );
    assert.equal(childTermination({ code: null, signal: 'SIGABRT' }), 'signalled');
    assert.equal(childTermination({ code: 3221225477, signal: null }), 'unexpected-exit-code');
    const signalled = await verifyNegativeWrapper('SIGABRT', null);
    assert.equal(signalled.accepted, false);
    assert.match(signalled.failure!, /Signal is not a normal outcome/);
    const crashed = await verifyNegativeWrapper(null, 3221225477);
    assert.equal(crashed.accepted, false);
    assert.match(crashed.failure!, /abnormal\/unknown child/);
    assert.equal((await verifyNegativeWrapper(null, 1)).accepted, true);
});
test('component viewer request keeps viewer coverage and owner requirements, including healthy attachment', async () => {
    const requested = requirements(true, ['run-success'], true);
    for (const value of viewerCoverage) assert.ok(requested.coverage.includes(value));
    for (const value of viewerOwnerKinds) assert.ok(requested.owners.includes(value));
    const absent = await verifySoak({ component: true, viewer: true });
    assert.equal(absent.receipt.status, 'failed');
    assert.equal(absent.cycles, 0);
    assert.match(absent.receipt.failure, /viewer/);
    const missingOwners = await verifySoak({
        component: true,
        viewer: true,
        attachedViewer: true,
        viewerOwners: false,
    });
    assert.equal(missingOwners.cycles, 0);
    assert.match(missingOwners.receipt.failure, /owner probe/);
    assert.equal(missingOwners.virtualIPCClosed, false);
    assert.ok(missingOwners.virtualTimersRemaining > 0, 'Unknown virtual custody remains held.');
    const attached = await verifySoak({ component: true, viewer: true, attachedViewer: true });
    assert.equal(attached.receipt.status, 'collected-component-lifecycle-evidence');
    assert.equal(attached.virtualIPCClosed, true);
    assert.equal(attached.virtualTimersRemaining, 0);
    assert.equal(attached.evidenceSynced && attached.evidenceClosed, true);
    for (const value of viewerCoverage) assert.ok(attached.receipt.coverage.includes(value));
    assert.equal(attached.receipt.memory.status, 'unqualified-no-reviewed-policy');
});
test('gateway process scope that shares the observer remains explicitly blocked', async () => {
    const blocked = await verifySoak({ policy: true, unsupportedScope: true });
    assert.equal(blocked.receipt.status, 'blocked');
    assert.equal(blocked.cycles, 0);
    assert.match(blocked.receipt.failure, /unsupported or incomplete/);
});

test('product calibration records unreviewed raw checkpoints while retaining full coverage, owners and scope preflight', async () => {
    const raw = await verifySoak({ calibration: true });
    assert.equal(raw.receipt.status, 'collected-product-calibration-evidence');
    assert.equal(raw.receipt.memory.status, 'unreviewed-product-calibration');
    assert.equal(raw.receipt.memory.thresholdsSelected, false);
    assert.equal(raw.receipt.cycles, 100);
    assert.ok(raw.checkpoints >= 106);
    assert.equal(raw.assessmentContext.context.config.component, false);
    assert.equal(raw.assessmentContext.assessmentIdentity, raw.receipt.assessmentIdentity);
    assert.ok(raw.shutdownSamples >= 2);
    assert.equal(raw.finalShutdownSamples, 1);
    assert.equal(raw.virtualIPCClosed, true);
    assert.equal(raw.virtualTimersRemaining, 0);
    assert.equal(raw.realCycles, 0); // Virtual source-verdict inputs, never product calibration evidence.
    const scope = await verifySoak({ calibration: true, unsupportedScope: true });
    assert.equal(scope.receipt.status, 'blocked');
    assert.equal(scope.cycles, 0);
    const owners = await verifySoak({ calibration: true, missingOwners: true });
    assert.equal(owners.receipt.status, 'failed');
    assert.equal(owners.cycles, 0);
    assert.match(owners.receipt.failure, /Missing exact owner probe producer/);
    const viewer = await verifySoak({ calibration: true, viewer: true });
    assert.equal(viewer.receipt.status, 'failed');
    assert.equal(viewer.cycles, 0);
    await assert.rejects(verifySoak({ calibration: true, component: true }), /full product mode/);
    await assert.rejects(verifySoak({ calibration: true, policy: true }), /no enforcement policy/);
});

test('negative wrapper forwards the reviewed policy instead of silently using provisional ceilings', async () => {
    const checked = await verifyNegativeWrapper(null, 1, true);
    assert.equal(checked.accepted, true);
    assert.equal(checked.realChildrenStarted, 0);
    assert.ok(checked.childArgs.includes('--policy=C:/reviewed-policy.json'));
    assert.ok(!checked.childArgs.includes('--diagnostic=1'));
    const empty = await verifyNegativeWrapper(null, 1, true, '');
    assert.equal(empty.accepted, false);
    assert.match(empty.failure!, /nonempty reviewed policy/);
    assert.deepEqual(empty.childArgs, []);
});
