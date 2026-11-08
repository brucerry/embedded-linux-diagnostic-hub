import { assertCallbackSource } from './fixtures/source-bound-callbacks';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import {
    bindPage,
    boundSpan,
    bindSamplingLifecycle,
    samplingLifecycleSpan,
    type PageContext,
} from './fixtures/automation-page-arm-callbacks';
import {
    FlowRunner,
    type FlowBackend,
    type FlowState,
    type RunClock,
} from '../src/features/automation/runner';
import { validatePlan, type AutomationPlan, type AutomationTransport } from '../shared/automation';
import type { FlowInspection } from '../src/features/automation/flow/inspection';
const source = readFileSync('src/features/automation/AutomationPage.tsx', 'utf8');
assertCallbackSource('src/features/automation/AutomationPage.tsx', source);
assert.equal(
    source.includes(boundSpan),
    true,
    'Exact page callback binding drifted; review before regenerating.',
);
assert.equal(source.includes(samplingLifecycleSpan), true);
const timerKeys = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;
const timers = timerKeys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
after(() =>
    timerKeys.forEach((k, i) =>
        assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, k), timers[i]),
    ),
);
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
        release = r;
    });
    return { promise, release };
}
async function until(check: () => boolean) {
    for (let n = 0; n < 256; n++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.fail('Bounded page/runner memory gate did not settle.');
}
function observe(p: Promise<void>) {
    const v: { settled: boolean; failure?: unknown } = { settled: false };
    void p.then(
        () => {
            v.settled = true;
        },
        (e) => {
            v.failure = e;
            v.settled = true;
        },
    );
    return v;
}
function plan(mode: 'independent-script' | 'console', at: number | null = null): AutomationPlan {
    const criterion = { role: 'shell-prompt' as const, literals: ['memory# '] };
    return {
        transport: 'ssh',
        ssh: mode === 'console' ? { mode, ready: criterion, completion: criterion } : { mode },
        steps: [
            {
                id: 'one',
                name: 'Memory command',
                enabled: true,
                command: 'synthetic command never executed',
                delaySeconds: 0,
                ...(mode === 'console'
                    ? { ssh: { intent: 'script' as const, completion: criterion } }
                    : {}),
            },
        ],
        timeoutSeconds: 10,
        repeatSeconds: null,
        start: at === null ? null : { epochMs: at, clock: 'local', zone: 'UTC' },
        serial: { lineEnding: 'CR', prompt: '', timestampPrefix: '' },
    };
}
function fixture(
    mode: 'prepare-failure' | 'waiting-control',
    options: { publish?: boolean; preparedFirst?: boolean } = {},
) {
    const epoch = Date.UTC(2028, 1, 29, 12);
    let wall = epoch,
        mono = 0,
        logicalSleeps = 0,
        waiters = 0,
        reservation: symbol | undefined;
    const repository = gate(),
        closure = gate(),
        privateGates = [repository, closure];
    const sleeps: ReturnType<typeof gate>[] = [];
    const calls = {
        repository: 0,
        backend: 0,
        acquires: 0,
        releases: 0,
        closes: 0,
        quiesces: 0,
        resumes: 0,
        executions: 0,
        records: 0,
        leaseReleases: [] as string[],
    };
    const states: FlowState[] = [];
    const ui: {
        running: boolean;
        error: string;
        inspection: FlowInspection | null;
        busy: boolean[];
        sampling: boolean;
        calibration?: unknown;
        transport: 'ssh' | 'serial';
        clockKind: 'local' | 'device';
        scheduled: boolean;
    } = {
        running: false,
        error: '',
        inspection: null,
        busy: [],
        sampling: false,
        transport: 'ssh',
        clockKind: 'device',
        scheduled: true,
    };
    let input = plan('independent-script');
    let disposed = false;
    const clock: RunClock = {
        local: () => wall,
        mono: () => mono,
        sleep: async (ms, signal) => {
            assert.ok(ms > 0 && ms <= 250);
            assert.ok(++logicalSleeps <= 32);
            if (mode === 'prepare-failure') {
                if (signal.aborted) throw Error('Cancelled logical wait.');
                wall += ms;
                mono += ms;
                await Promise.resolve();
                return;
            }
            const g = gate();
            sleeps.push(g);
            privateGates.push(g);
            waiters++;
            await new Promise<void>((resolve, reject) => {
                let done = false;
                const settle = (error?: Error) => {
                    if (done) return;
                    done = true;
                    waiters--;
                    signal.removeEventListener('abort', cancel);
                    if (error) reject(error);
                    else {
                        wall += ms;
                        mono += ms;
                        resolve();
                    }
                };
                const cancel = () => settle(Error('Cancelled logical wait.'));
                signal.addEventListener('abort', cancel, { once: true });
                void g.promise.then(() =>
                    settle(signal.aborted ? Error('Cancelled old logical wait.') : undefined),
                );
                if (signal.aborted) cancel();
            });
        },
    };
    const runner = new FlowRunner(
        (s) => {
            states.push(s);
            if (options.publish) {
                const active =
                    Boolean(s.cleanupPending) ||
                    ['waiting', 'running', 'delaying'].includes(s.state);
                ui.running = active;
                ui.busy.push(active);
            }
        },
        () => {
            calls.records++;
            assert.fail('No command result can be recorded before preparation.');
        },
        clock,
    );
    const transport: Partial<AutomationTransport> = {
        automationConnection: () => 'memory-connection',
    };
    const liveLeases = new Set<string>();
    const onBusy = (value: boolean) => ui.busy.push(value);
    const ctx: PageContext = {
        cleanupClock: { current: undefined },
        pendingClockSamples: { current: 0 },
        manualClockSample: { current: null },
        runner: { current: runner },
        arming: { current: false },
        armAttempt: { current: null },
        activityEpoch: { current: 0 },
        flowInspectionId: { current: null },
        cleanupActivity: { current: undefined },
        cleanupConsoleResults: { current: undefined },
        consoleResultsAdmission: {
            current: {
                async quiesce() {
                    assert.equal(reservation, undefined);
                    const token = Symbol('actual admission IO boundary');
                    reservation = token;
                    calls.quiesces++;
                    return () => {
                        if (reservation !== token) return;
                        reservation = undefined;
                        calls.resumes++;
                    };
                },
            },
        },
        props: {
            clockAdmission: {
                async quiesce() {
                    return () => {};
                },
            },
            connected: true,
            transport,
            serial: { current: { generation: 1, label: 'unused Serial' }, framing: 'unused' },
            target: { endpoint: 'synthetic SSH' },
            busy: false,
            blocked: false,
            onBusy,
        },
        latest: {
            current: {
                transport,
                connected: true,
                blocked: false,
                onBusy,
                target: { endpoint: 'synthetic SSH' },
            },
        },
        fieldIssues: [],
        focusIssue: () => assert.fail('Valid fixture has no field issues.'),
        build: () => validatePlan(input),
        hidden: false,
        connected: true,
        captureActionBusy: false,
        desktop: {
            async acquireAutomationActivity() {
                assert.equal(liveLeases.size, 0);
                const id = 'memory-lease-' + ++calls.acquires;
                liveLeases.add(id);
                return id;
            },
            async releaseAutomationActivity(id) {
                assert.ok(liveLeases.delete(id));
                calls.leaseReleases.push(id);
            },
        },
        setTransport: (v) => {
            ui.transport = v;
        },
        setClockKind: (v) => {
            ui.clockKind = v;
        },
        setScheduled: (v) => {
            ui.scheduled = v;
        },
        setSampling: (v) => {
            ui.sampling = v;
        },
        setCalibration: (v) => {
            ui.calibration = v;
        },
        setError: (v) => {
            ui.error = v;
        },
        setRunning: (v) => {
            ui.running = v;
        },
        setState: (v) => states.push(v),
        setFlowInspection: (v) => {
            ui.inspection = v;
        },
        openCaptureRepository: async () => {
            calls.repository++;
            await repository.promise;
            return {};
        },
        openConsoleJournal: async () => assert.fail('No IndexedDB/native journal opening.'),
        sample: async () => assert.fail('No device clock sample.'),
        serialCaptureBackend: () => assert.fail('No Serial backend admitted.'),
        sshCaptureBackend: () => assert.fail('Cancelled pre-arm must not construct its backend.'),
        sshConsoleBackend: (...args) => {
            calls.backend++;
            assert.equal(args.length, 8);
            assert.equal(args[0], transport);
            assert.equal(args[1], 'local-client');
            const before = args[6] as () => Promise<void>;
            const prepared = args[7] as () => void;
            assert.equal(typeof prepared, 'function');
            let localCloses = 0;
            const backend: FlowBackend = {
                target: { endpoint: 'synthetic SSH' },
                connection: () => 'memory-connection',
                available: () => true,
                acquire: () => () => {
                    calls.releases++;
                },
                prepare: async (_p, _s, check) => {
                    assert.equal(mode, 'prepare-failure');
                    check();
                    await before();
                    check();
                    if (options.preparedFirst && calls.backend === 1) prepared();
                    throw Error('Synthetic readiness/freshness failure.');
                },
                execute: async () => {
                    calls.executions++;
                    assert.fail('No synthetic command dispatch admitted.');
                },
                finishFlow: async () => {
                    calls.closes++;
                    if (mode === 'prepare-failure') {
                        if (++localCloses === 1)
                            throw Error('Synthetic owned closure unacknowledged.');
                        await closure.promise;
                    }
                },
            };
            return backend;
        },
    };
    const bind = () => bindPage(ctx);
    return {
        epoch,
        ctx,
        runner,
        ui,
        calls,
        states,
        repository,
        closure,
        sleeps,
        liveLeases,
        bind,
        setPlan: (p: AutomationPlan) => {
            input = p;
        },
        get heldReservation() {
            return Boolean(reservation);
        },
        get waiters() {
            return waiters;
        },
        async finish() {
            if (disposed) return;
            disposed = true;
            privateGates.forEach((g) => g.release());
            if (runner.cleanupPending) await runner.retryCleanup();
            else if (runner.busy) {
                runner.cancel();
                await until(() => !runner.busy);
            }
            if (ctx.cleanupActivity.current) {
                await ctx.desktop!.releaseAutomationActivity!(ctx.cleanupActivity.current);
                ctx.cleanupActivity.current = undefined;
            }
            ctx.cleanupConsoleResults.current?.();
            ctx.cleanupConsoleResults.current = undefined;
            assert.equal(waiters, 0);
            assert.equal(liveLeases.size, 0);
            assert.equal(ctx.pendingClockSamples.current, 0);
        },
    };
}
test('cancelled pre-arm completion cannot discard replacement cleanup ownership before explicit acknowledgement', async () => {
    const f = fixture('prepare-failure');
    let old: ReturnType<typeof observe> | undefined;
    try {
        old = observe(f.bind().start());
        await until(() => f.calls.repository === 1);
        assert.equal(f.ctx.arming.current, true);
        f.bind().cancel();
        assert.equal(f.ctx.arming.current, false);
        f.setPlan(plan('console', f.epoch + 3000));
        const replacement = observe(f.bind().start());
        await until(() => replacement.settled);
        assert.equal(replacement.failure, undefined);
        assert.equal(f.runner.cleanupPending, true);
        assert.equal(f.runner.busy, true);
        assert.equal(f.calls.quiesces, 1);
        assert.equal(f.calls.resumes, 0);
        assert.equal(f.heldReservation, true);
        const resume = f.ctx.cleanupConsoleResults.current;
        assert.equal(typeof resume, 'function');
        const inspected = f.ui.inspection?.active.id;
        assert.ok(inspected);
        assert.match(f.states.at(-1)!.message, /cleanup remains pending.*Synthetic owned closure/);
        f.repository.release();
        await until(() => old!.settled);
        assert.equal(old.failure, undefined);
        assert.equal(f.ui.inspection?.active.id, inspected);
        assert.equal(f.runner.busy, true);
        assert.equal(f.calls.releases, 0);
        assert.equal(f.liveLeases.size, 1);
        assert.equal(f.ctx.cleanupConsoleResults.current, resume);
        f.bind().cancel();
        await until(() => f.calls.closes === 2);
        assert.equal(f.runner.busy, true);
        assert.equal(f.liveLeases.size, 1);
        assert.equal(f.calls.resumes, 0);
        f.closure.release();
        await until(() => !f.runner.busy && f.calls.leaseReleases.length === 1 && !f.ui.running);
        assert.equal(f.calls.resumes, 1);
        assert.equal(f.heldReservation, false);
        assert.equal(f.calls.releases, 1);
        assert.deepEqual(f.calls.leaseReleases, ['memory-lease-1']);
        assert.equal(f.calls.records, 0);
        assert.equal(f.calls.executions, 0);
        assert.equal(f.calls.closes, 2);
    } finally {
        await f.finish();
    }
});
test('late cancelled repository reply leaves replacement scheduled admission intact and explicit reschedule stays disarmed', async () => {
    const f = fixture('waiting-control');
    try {
        const old = observe(f.bind().start());
        await until(() => f.calls.repository === 1);
        f.bind().cancel();
        f.setPlan(plan('console', f.epoch + 3000));
        const waiting = observe(f.bind().start());
        await until(() => f.waiters === 1);
        const inspection = f.ui.inspection?.active.id;
        f.repository.release();
        await until(() => old.settled);
        assert.equal(f.ui.inspection?.active.id, inspection);
        assert.equal(f.runner.busy, true);
        assert.equal(f.ui.running, true);
        assert.equal(f.calls.quiesces, 0);
        assert.equal(f.liveLeases.size, 1);
        f.bind().cancel();
        await until(() => waiting.settled);
        assert.equal(waiting.failure, undefined);
        assert.equal(f.runner.busy, false);
        assert.equal(f.liveLeases.size, 0);
        assert.equal(f.waiters, 0);
        assert.equal(f.calls.executions, 0);
        f.sleeps[0].release();
        f.setPlan(plan('console', f.epoch + 6000));
        const next = observe(f.bind().start());
        await until(() => f.waiters === 1);
        assert.notEqual(f.ui.inspection?.active.id, inspection);
        assert.equal(f.calls.acquires, 2);
        f.bind().cancel();
        await until(() => next.settled);
        assert.equal(next.failure, undefined);
        assert.equal(f.calls.executions, 0);
        assert.equal(f.calls.records, 0);
        assert.equal(f.calls.releases, 2);
        assert.deepEqual(f.calls.leaseReleases, ['memory-lease-1', 'memory-lease-2']);
        assert.equal(f.ctx.arming.current, false);
    } finally {
        await f.finish();
    }
});

for (const preparedFirst of [false, true])
    test(`cleanup retry acknowledgement retains replacement ${preparedFirst ? 'cleanup reservation' : 'pending arm'} ownership`, async () => {
        const f = fixture('prepare-failure', { publish: true, preparedFirst }),
            releaseReply = gate(),
            newLeaseReply = gate();
        let next: ReturnType<typeof observe> | undefined;
        const originalAcquire = f.ctx.desktop!.acquireAutomationActivity!,
            originalRelease = f.ctx.desktop!.releaseAutomationActivity!;
        try {
            f.setPlan(plan('console'));
            const first = observe(f.bind().start());
            await until(() => first.settled);
            assert.equal(first.failure, undefined);
            assert.equal(f.runner.cleanupPending, true);
            assert.equal(f.calls.resumes, preparedFirst ? 1 : 0);
            const oldResume = f.ctx.cleanupConsoleResults.current;
            assert.equal(typeof oldResume, 'function');
            f.ctx.desktop!.releaseAutomationActivity = async (id) => {
                await originalRelease(id);
                if (id === 'memory-lease-1') await releaseReply.promise;
            };
            f.bind().cancel();
            await until(() => f.calls.closes === 2);
            f.closure.release();
            await until(() => !f.runner.busy && f.calls.leaseReleases.length === 1);
            assert.equal(f.liveLeases.size, 0);
            if (!preparedFirst)
                f.ctx.desktop!.acquireAutomationActivity = async () => {
                    const id = await originalAcquire();
                    await newLeaseReply.promise;
                    return id;
                };
            f.setPlan(plan('console'));
            next = observe(f.bind().start());
            await until(() => (preparedFirst ? next!.settled : f.calls.acquires === 2));
            const newAttempt = f.ctx.armAttempt.current,
                newResume = f.ctx.cleanupConsoleResults.current;
            if (preparedFirst) {
                assert.equal(next.failure, undefined);
                assert.equal(f.runner.cleanupPending, true);
                assert.notEqual(newResume, oldResume);
                assert.equal(typeof newResume, 'function');
                assert.equal(f.heldReservation, true);
            } else {
                assert.equal(f.ctx.arming.current, true);
                assert.equal(f.ui.running, true);
                assert.equal(f.liveLeases.size, 1);
            }
            const writes = f.ui.busy.length;
            releaseReply.release();
            await until(() => f.ui.busy.length > writes);
            assert.equal(f.ui.running, true);
            assert.equal(f.ui.busy.at(-1), true);
            if (preparedFirst) {
                assert.equal(f.ctx.cleanupConsoleResults.current === newResume, true);
                assert.equal(f.heldReservation, true);
                assert.equal(f.calls.resumes, true ? 1 : 2);
                assert.equal(f.runner.cleanupPending, true);
            } else {
                assert.equal(f.ctx.armAttempt.current, newAttempt);
                assert.equal(f.ctx.arming.current, true);
            }
            f.bind().cancel();
            newLeaseReply.release();
            await until(() => next!.settled && !f.runner.busy && f.liveLeases.size === 0);
            assert.equal(f.calls.executions, 0);
            assert.equal(f.calls.records, 0);
        } finally {
            releaseReply.release();
            newLeaseReply.release();
            if (f.ctx.arming.current && !f.runner.busy) f.bind().cancel();
            if (next) await until(() => next!.settled);
            await f.finish();
        }
    });

for (const outcome of ['failure', 'success', 'same-action-failure'] as const)
    test(`manual clock ${outcome} respects current arm diagnostic ownership`, async () => {
        const f = fixture('prepare-failure'),
            reply = gate();
        const sampleError = Error('Synthetic old manual clock unavailable'),
            armError = Error('Synthetic new arm admission refused');
        const calibration = {
            source: 'Synthetic fixed clock',
            connection: 'memory-connection',
            deviceEpochMs: f.epoch,
            sampledLocalMs: f.epoch,
            sampledMonoMs: 0,
            uncertaintyMs: 1,
            zone: 'UTC',
        };
        let samples = 0;
        f.ctx.sample = async () => {
            samples++;
            await reply.promise;
            if (outcome === 'success') return calibration;
            throw sampleError;
        };
        try {
            f.bind().sampleClicked();
            assert.equal(f.ui.sampling, true);
            assert.equal(samples, 1);
            if (outcome !== 'same-action-failure') {
                // The active UI permits changing to local timing and arming while a manual sample is pending.
                f.ctx.desktop!.acquireAutomationActivity = async () => {
                    throw armError;
                };
                f.setPlan(plan('console'));
                const attempt = observe(f.bind().start());
                await until(() => attempt.settled);
                assert.equal(attempt.failure, undefined);
                assert.equal(f.ui.error, armError.message);
                assert.equal(f.runner.busy, false);
                assert.equal(f.liveLeases.size, 0);
            }
            reply.release();
            await until(() => !f.ui.sampling);
            assert.equal(
                f.ui.error,
                outcome === 'same-action-failure'
                    ? sampleError.message
                    : true
                      ? armError.message
                      : outcome === 'failure'
                        ? sampleError.message
                        : armError.message,
            );
            assert.equal(f.ui.calibration === calibration, outcome === 'success' && !true);
            assert.equal(f.calls.records, 0);
            assert.equal(f.calls.executions, 0);
            assert.equal(f.calls.quiesces, 0);
            assert.equal(f.liveLeases.size, 0);
        } finally {
            reply.release();
            await until(() => !f.ui.sampling);
            await f.finish();
        }
    });

for (const action of ['transport', 'clock-kind', 'newer-sample'] as const)
    test(`sampling context ${action} fences stale publication and busy ownership`, async () => {
        const f = fixture('prepare-failure'),
            first = gate(),
            second = gate();
        let reads = 0;
        const oldError = Error('Old clock request failed');
        const value = {
            source: 'Synthetic current clock',
            connection: 'memory-connection',
            deviceEpochMs: f.epoch,
            sampledLocalMs: f.epoch,
            sampledMonoMs: 0,
            uncertaintyMs: 1,
            zone: 'UTC',
        };
        f.ctx.sample = async () => {
            const count = ++reads;
            await (count === 1 ? first.promise : second.promise);
            if (action === 'transport' || count === 2) return value;
            throw oldError;
        };
        try {
            f.bind().sampleClicked();
            assert.equal(f.ui.sampling, true);
            if (action === 'transport') {
                f.bind().changeTransport('serial');
                assert.equal(f.ui.transport, 'serial');
                assert.equal(f.ui.calibration, undefined);
            } else if (action === 'clock-kind') {
                f.bind().changeClockKind('local');
                assert.equal(f.ui.clockKind, 'local');
            } else {
                f.bind().sampleClicked();
                assert.equal(reads, 2);
            }
            first.release();
            for (let i = 0; i < 32; i++) await Promise.resolve();
            if (action === 'transport') assert.equal(f.ui.calibration === value, !true);
            else {
                assert.equal(f.ui.error, true ? '' : oldError.message);
                if (action === 'newer-sample') assert.equal(f.ui.sampling, true);
            }
            if (action === 'newer-sample') {
                second.release();
                await until(() => !f.ui.sampling && f.ui.calibration === value);
                assert.equal(f.ui.calibration, value);
            } else await until(() => !f.ui.sampling);
            assert.equal(f.liveLeases.size, 0);
            assert.equal(f.calls.executions, 0);
        } finally {
            first.release();
            second.release();
            await until(() => !f.ui.sampling);
            await f.finish();
        }
    });

test('run mode changes cannot revive a pending manual sample when switched back', async () => {
    const f = fixture('prepare-failure'),
        reply = gate();
    const value = {
        source: 'Synthetic stale clock',
        connection: 'memory-connection',
        deviceEpochMs: f.epoch,
        sampledLocalMs: f.epoch,
        sampledMonoMs: 0,
        uncertaintyMs: 1,
        zone: 'UTC',
    };
    f.ctx.sample = async () => {
        await reply.promise;
        return value;
    };
    try {
        f.bind().sampleClicked();
        f.bind().changeScheduled(false);
        f.bind().changeScheduled(true);
        assert.equal(f.ui.scheduled, true);
        assert.equal(f.ui.sampling, true);
        reply.release();
        await until(() => !f.ui.sampling);
        assert.equal(f.ui.calibration, undefined);
        assert.equal(f.ctx.manualClockSample.current, null);
    } finally {
        reply.release();
        await until(() => !f.ui.sampling);
        await f.finish();
    }
});
for (const change of ['connection', 'transport-object', 'connected', 'target-roundtrip'] as const)
    test(`manual sample rejects retired ${change} identity`, async () => {
        const f = fixture('prepare-failure'),
            reply = gate();
        const value = {
            source: 'Synthetic stale clock',
            connection: 'memory-connection',
            deviceEpochMs: f.epoch,
            sampledLocalMs: f.epoch,
            sampledMonoMs: 0,
            uncertaintyMs: 1,
            zone: 'UTC',
        };
        const oldContextCleanup = bindSamplingLifecycle(f.ctx);
        f.ctx.sample = async () => {
            await reply.promise;
            if (change === 'connection') throw Error('Old connection clock failure');
            return value;
        };
        try {
            f.bind().sampleClicked();
            const active = f.ctx.props.transport;
            assert.ok(active);
            if (change === 'connection')
                active.automationConnection = () => 'replacement-connection';
            else if (change === 'transport-object') f.ctx.latest.current.transport = { ...active };
            else if (change === 'connected') f.ctx.latest.current.connected = false;
            else {
                f.ctx.latest.current.target = { endpoint: 'new target' };
                oldContextCleanup();
                f.ctx.latest.current.target = { endpoint: 'synthetic SSH' };
            }
            assert.equal(f.ui.sampling, true);
            reply.release();
            await until(() => !f.ui.sampling);
            assert.equal(f.ui.calibration, undefined);
            assert.equal(f.ui.error, '');
            assert.equal(f.ctx.manualClockSample.current, null);
            assert.equal(f.liveLeases.size, 0);
        } finally {
            reply.release();
            await until(() => !f.ui.sampling);
            await f.finish();
        }
    });
test('retired props cleanup cannot suppress a new-context current sample error', async () => {
    const f = fixture('prepare-failure'),
        reply = gate(),
        currentError = Error('New context clock unavailable');
    const oldContextCleanup = bindSamplingLifecycle(f.ctx);
    try {
        f.ctx.props = { ...f.ctx.props, target: { endpoint: 'new target' } };
        f.ctx.latest.current = { ...f.ctx.latest.current, target: { endpoint: 'new target' } };
        f.ctx.sample = async () => {
            await reply.promise;
            throw currentError;
        };
        f.bind().sampleClicked();
        oldContextCleanup();
        assert.equal(f.ctx.manualClockSample.current?.valid, true);
        reply.release();
        await until(() => !f.ui.sampling);
        assert.equal(f.ui.error, currentError.message);
        assert.equal(f.ctx.manualClockSample.current, null);
    } finally {
        reply.release();
        await until(() => !f.ui.sampling);
        await f.finish();
    }
});
for (const finish of ['cancel', 'dispose'] as const)
    test(`manual sample ${finish} invalidates publication but waits for reader settlement`, async () => {
        const f = fixture('prepare-failure'),
            reply = gate();
        const value = {
            source: 'Synthetic stale clock',
            connection: 'memory-connection',
            deviceEpochMs: f.epoch,
            sampledLocalMs: f.epoch,
            sampledMonoMs: 0,
            uncertaintyMs: 1,
            zone: 'UTC',
        };
        const cleanup = bindSamplingLifecycle(f.ctx);
        f.ctx.sample = async () => {
            await reply.promise;
            return value;
        };
        try {
            f.bind().sampleClicked();
            if (finish === 'cancel') f.bind().cancel();
            else cleanup();
            assert.equal(f.ui.sampling, true);
            reply.release();
            await until(() => !f.ui.sampling);
            assert.equal(f.ui.calibration, undefined);
            assert.equal(f.ui.error, '');
            assert.equal(f.ctx.manualClockSample.current, null);
            assert.equal(f.liveLeases.size, 0);
        } finally {
            reply.release();
            await until(() => !f.ui.sampling);
            await f.finish();
        }
    });

test('newest sampling failure keeps earlier outstanding reader busy', async () => {
    const f = fixture('prepare-failure'),
        older = gate(),
        newer = gate(),
        error = Error('Current sample unavailable');
    let reads = 0;
    f.ctx.sample = async () => {
        const read = ++reads;
        await (read === 1 ? older.promise : newer.promise);
        if (read === 2) throw error;
        throw Error('Stale older failure');
    };
    try {
        f.bind().sampleClicked();
        f.bind().sampleClicked();
        assert.equal(reads, 2);
        newer.release();
        await until(() => f.ui.error === error.message && f.ctx.manualClockSample.current === null);
        assert.equal(f.ui.sampling, true);
        older.release();
        await until(() => !f.ui.sampling);
        for (let i = 0; i < 32; i++) await Promise.resolve();
        assert.equal(f.ui.error, error.message);
        assert.equal(f.ui.calibration, undefined);
    } finally {
        older.release();
        newer.release();
        for (let i = 0; i < 32; i++) await Promise.resolve();
        await f.finish();
    }
});
