import { ADAPTERS, preparePlan, validateProfile, validateReadiness } from './profile';
import {
    activeRun,
    CASE_BYTES,
    RUN_BYTES,
    RUN_TIMEOUT_MS,
    type CaseResult,
    type Evidence,
    type Inventory,
    type PreparedCase,
    type StartTests,
    type TestRun,
    type Verdict,
} from './types';
import { bounded, canonical, id, list, object, text, unique } from './validation';

export function utf8Hex(value: string): string {
    return Array.from(new TextEncoder().encode(value), (b) => b.toString(16).padStart(2, '0')).join(
        '',
    );
}
export function caseVerdict(result: CaseResult): Verdict {
    const e = result.evidence;
    if (!e || result.status !== 'done') return 'Skipped';
    if (e.execution === 'skipped') return 'Skipped';
    if (
        e.execution === 'interrupted' ||
        e.execution === 'error' ||
        e.truncated ||
        e.cleanup === 'unverified'
    )
        return 'Inconclusive';
    if (e.execution === 'blocked') return 'Blocked';
    if (e.execution === 'mismatch') return 'Fail';
    if (
        e.exitCode !== 0 ||
        !result.resource ||
        (result.test.adapter !== 'i2c.identity' && e.cleanup !== 'verified')
    )
        return 'Inconclusive';
    if (result.test.adapter === 'led.pattern')
        return result.feedback?.value === 'yes'
            ? 'Pass'
            : result.feedback?.value === 'no'
              ? 'Fail'
              : 'Inconclusive';
    if (result.test.adapter === 'uart.loopback')
        return e.measured === utf8Hex(String(result.test.parameters.payload)) ? 'Pass' : 'Fail';
    return typeof e.measured === 'number' &&
        (e.measured & Number(result.test.parameters.mask)) ===
            (Number(result.test.parameters.expected) & Number(result.test.parameters.mask))
        ? 'Pass'
        : 'Fail';
}
export function summarizeRun(run: TestRun): Verdict {
    const required = run.cases.filter((c) => c.test.required);
    const relevant = required.length ? required : run.cases;
    if (relevant.some((c) => c.verdict === 'Fail')) return 'Fail';
    if (
        activeRun(run) ||
        run.interruption ||
        !relevant.length ||
        relevant.some((c) => c.verdict === 'Inconclusive' || c.status !== 'done')
    )
        return 'Inconclusive';
    if (relevant.some((c) => c.verdict === 'Blocked')) return 'Blocked';
    if (relevant.some((c) => c.verdict === 'Skipped')) return 'Skipped';
    return 'Pass';
}
export function refreshVerdicts(run: TestRun): void {
    for (const c of run.cases) c.verdict = caseVerdict(c);
    run.verdict = summarizeRun(run);
}
export const blankEvidence = (execution: Evidence['execution'], reason: string): Evidence => ({
    execution,
    reason,
    measured: null,
    stdout: '',
    stderr: '',
    exitCode: null,
    durationMs: 0,
    truncated: false,
    cleanup: 'not-needed',
    cleanupDetail: 'No active operation performed.',
});
export class TestController {
    inventory: Inventory | null = null;
    private latest: TestRun | null = null;
    private reservation = false;
    private disposed = false;
    private abort: AbortController | null = null;
    private task: Promise<void> | null = null;
    private unsafe = false;
    constructor(
        private readonly discover: () => Promise<Inventory>,
        private readonly execute: (test: PreparedCase, signal: AbortSignal) => Promise<Evidence>,
    ) {}
    get busy() {
        return this.reservation || activeRun(this.latest);
    }
    read(): TestRun | null {
        return this.latest ? structuredClone(this.latest) : null;
    }
    readProgress(): TestRun | null {
        if (this.reservation)
            throw Error(
                'Test preparation is still running. Retry status or disconnect to cancel it.',
            );
        return this.read();
    }
    async discoverInventory() {
        if (this.busy || this.disposed)
            throw Error('Wait for the current test run or reconnect the device.');
        const inventory = await this.discover();
        if (this.disposed) throw Error('Device connection changed.');
        this.inventory = inventory;
        return structuredClone(inventory);
    }
    async prepare(profile: unknown) {
        if (!this.inventory || this.disposed)
            throw Error('Discover the current device before preparing tests.');
        return preparePlan(profile, this.inventory);
    }
    async start(input: unknown): Promise<TestRun> {
        if (this.busy || this.disposed || this.unsafe)
            throw Error(
                this.unsafe
                    ? 'Cleanup was not verified. Reconnect and review resource recovery before another test.'
                    : 'A test run is active or this connection has ended.',
            );
        if (this.latest?.phase === 'review')
            throw Error(
                'Record or dismiss pending operator observations before replacing this run.',
            );
        this.reservation = true;
        try {
            const v = object(
                input,
                ['profile', 'inventoryId', 'testIds', 'sequence', 'readiness'],
                'Start tests',
            );
            const profile = validateProfile(v.profile);
            if (!this.inventory || id(v.inventoryId, 'Inventory ID') !== this.inventory.id)
                throw Error('Inventory changed. Discover and review a fresh plan.');
            const testIds = unique(
                list(v.testIds, 'Selected tests', 64).map((x) => id(x, 'Test ID')),
                (x) => x,
                'Selected tests',
            );
            if (!testIds.length || testIds.some((x) => !profile.tests.some((t) => t.id === x)))
                throw Error('Select known tests before running.');
            const sequence = text(v.sequence, 'Sequence', 64);
            const saved = profile.sequences.find((s) => s.id === sequence);
            if (sequence && (!saved || canonical(saved.tests) !== canonical(testIds)))
                throw Error('Selected tests do not match the saved sequence.');
            const readiness = validateReadiness(v.readiness, profile.tests);
            if (!readiness.reviewed)
                throw Error('Review the resolved resources and exclusive-use requirements first.');
            const fresh = await this.discover();
            if (this.disposed) throw Error('Device connection changed.');
            const state = (i: Inventory) =>
                canonical({
                    mode: i.mode,
                    device: i.device,
                    resources: i.resources,
                    capabilities: i.capabilities,
                    nodes: i.nodes,
                    complete: i.complete,
                });
            if (state(fresh) !== state(this.inventory)) {
                this.inventory = fresh;
                throw Error(
                    'Device inventory changed. Discover and review the updated resource mappings.',
                );
            }
            this.inventory = fresh;
            const plan = await preparePlan(profile, fresh);
            const selected = testIds.map((x) => plan.cases.find((c) => c.test.id === x)!);
            for (const c of selected)
                if (!readiness.fixtures[c.test.id]?.ready)
                    c.problems.push('Required fixture/observer readiness has not been confirmed.');
            const run: TestRun = {
                id: crypto.randomUUID(),
                mode: fresh.mode,
                phase: 'running',
                startedAt: new Date().toISOString(),
                finishedAt: '',
                interruption: '',
                profile,
                profileDigest: plan.profileDigest,
                inventory: fresh,
                sequence,
                readiness,
                verdict: 'Inconclusive',
                cases: selected.map((c) => ({
                    test: c.test,
                    adapterVersion: ADAPTERS[c.test.adapter].version,
                    resource: c.resource,
                    status: 'pending',
                    verdict: 'Skipped',
                    reason: 'Not started.',
                    startedAt: '',
                    finishedAt: '',
                    evidence: null,
                    feedback: null,
                })),
            };
            this.latest = run;
            const abort = new AbortController();
            this.abort = abort;
            this.task = this.perform(run, selected, abort, saved?.stopOnFailure || false);
            return this.read()!;
        } finally {
            this.reservation = false;
        }
    }
    private async perform(
        run: TestRun,
        cases: PreparedCase[],
        abort: AbortController,
        stopOnFailure: boolean,
    ) {
        let bytes = 0,
            stopped = false;
        const timer = setTimeout(() => {
            run.interruption = 'Run exceeded its ten-minute budget.';
            abort.abort();
        }, RUN_TIMEOUT_MS);
        try {
            for (let i = 0; i < cases.length; i++) {
                const c = cases[i],
                    result = run.cases[i];
                result.startedAt = new Date().toISOString();
                if (abort.signal.aborted || stopped)
                    result.evidence = blankEvidence(
                        'skipped',
                        abort.signal.aborted
                            ? 'Not executed after interruption.'
                            : 'Skipped by stop-on-failure policy.',
                    );
                else if (c.problems.length)
                    result.evidence = blankEvidence('blocked', c.problems.join(' '));
                else {
                    result.status = 'running';
                    try {
                        const evidence = await this.execute(c, abort.signal);
                        if (this.disposed) return;
                        result.evidence = evidence;
                    } catch (error) {
                        if (this.disposed) return;
                        result.evidence = {
                            ...blankEvidence(
                                'error',
                                error instanceof Error ? error.message : 'Test execution failed.',
                            ),
                            cleanup: 'unverified',
                            cleanupDetail: 'Execution ended without verified cleanup.',
                        };
                    }
                    if (this.disposed) return;
                    // JSON escaping can expand bounded raw bytes (for example line breaks).
                    bounded(result.evidence, CASE_BYTES * 6 + 8192, 'Case evidence');
                    bytes += new TextEncoder().encode(
                        result.evidence.stdout + result.evidence.stderr,
                    ).length;
                    if (abort.signal.aborted) result.evidence.execution = 'interrupted';
                    if (result.evidence.cleanup === 'unverified') {
                        this.unsafe = true;
                        run.interruption ||= 'Resource cleanup could not be verified.';
                        abort.abort();
                    }
                    if (bytes > RUN_BYTES) {
                        run.interruption = 'Run evidence capacity exceeded.';
                        abort.abort();
                    }
                }
                result.status = 'done';
                result.finishedAt = new Date().toISOString();
                result.reason = result.evidence!.reason;
                result.verdict = caseVerdict(result);
                if (stopOnFailure && result.verdict === 'Fail') stopped = true;
                refreshVerdicts(run);
            }
        } catch (error) {
            run.interruption = error instanceof Error ? error.message : 'Run failed.';
            abort.abort();
        } finally {
            clearTimeout(timer);
            if (!this.disposed) {
                run.finishedAt = new Date().toISOString();
                run.phase = abort.signal.aborted
                    ? 'cancelled'
                    : run.cases.some(
                            (c) =>
                                c.test.adapter === 'led.pattern' &&
                                c.evidence?.execution === 'ok' &&
                                !c.feedback,
                        )
                      ? 'review'
                      : 'complete';
                for (const c of run.cases)
                    if (c.status !== 'done') {
                        const running = c.status === 'running';
                        c.status = 'done';
                        c.finishedAt = run.finishedAt;
                        c.evidence ??= {
                            ...blankEvidence(
                                running ? 'error' : 'skipped',
                                'Run ended before this case completed.',
                            ),
                            cleanup: running ? 'unverified' : 'not-needed',
                            cleanupDetail: running
                                ? 'No restoration evidence returned.'
                                : 'No active operation performed.',
                        };
                        c.reason = c.evidence.reason;
                    }
                refreshVerdicts(run);
            }
            this.abort = null;
        }
    }
    async cancel(runId: unknown): Promise<TestRun> {
        if (!this.latest || id(runId, 'Run ID') !== this.latest.id)
            throw Error('Unknown or stale run.');
        if (activeRun(this.latest)) {
            this.latest.interruption ||= 'Cancelled by user.';
            this.latest.phase = 'cleaning';
            this.abort?.abort();
            await this.task;
        } else if (this.latest.phase === 'review') {
            for (const c of this.latest.cases)
                if (c.test.adapter === 'led.pattern' && !c.feedback)
                    c.feedback = { value: 'unobserved', at: new Date().toISOString() };
            this.latest.phase = 'complete';
            refreshVerdicts(this.latest);
        }
        return this.read()!;
    }
    confirm(input: unknown): TestRun {
        const v = object(input, ['runId', 'testId', 'value'], 'Operator observation');
        if (!this.latest || this.disposed || this.busy || id(v.runId, 'Run ID') !== this.latest.id)
            throw Error('Wait for actuation to finish on this current run.');
        const c = this.latest.cases.find((c) => c.test.id === id(v.testId, 'Test ID'));
        if (!c || c.test.adapter !== 'led.pattern' || c.evidence?.execution !== 'ok' || c.feedback)
            throw Error('This case does not accept an operator observation.');
        if (!['yes', 'no', 'unobserved'].includes(String(v.value)))
            throw Error('Choose yes, no or unobserved.');
        c.feedback = {
            value: v.value as 'yes' | 'no' | 'unobserved',
            at: new Date().toISOString(),
        };
        c.reason =
            v.value === 'yes'
                ? 'Operator confirmed the expected pattern.'
                : v.value === 'no'
                  ? 'Operator reported unexpected LED behavior.'
                  : 'Physical behavior was not observed.';
        if (
            !this.latest.cases.some(
                (x) =>
                    x.test.adapter === 'led.pattern' &&
                    x.evidence?.execution === 'ok' &&
                    !x.feedback,
            )
        )
            this.latest.phase = 'complete';
        refreshVerdicts(this.latest);
        return this.read()!;
    }
    interrupt(reason: string) {
        this.disposed = true;
        this.abort?.abort();
        this.reservation = false;
        if (this.latest && activeRun(this.latest)) {
            this.latest.interruption = reason;
            this.latest.phase = 'cancelled';
            this.latest.finishedAt = new Date().toISOString();
            for (const c of this.latest.cases)
                if (c.status !== 'done') {
                    const running = c.status === 'running';
                    c.status = 'done';
                    c.finishedAt = this.latest.finishedAt;
                    c.evidence = {
                        ...blankEvidence(running ? 'interrupted' : 'skipped', reason),
                        cleanup: running ? 'unverified' : 'not-needed',
                        cleanupDetail: running
                            ? 'Connection ended before cleanup could be verified.'
                            : 'No active operation performed.',
                    };
                    c.reason = reason;
                }
            refreshVerdicts(this.latest);
        }
    }
    clear() {
        if (this.busy) throw Error('Cancel the active test and wait for cleanup before resetting.');
        this.latest = null;
        this.inventory = null;
    }
}
