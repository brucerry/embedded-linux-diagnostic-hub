import {
    AUTOMATION_LIMITS,
    armPlan,
    calibratedNow,
    validatePlan,
    type AutomationPlan,
    type AutomationRecord,
    type CommandCapture,
    type ClockCalibration,
} from '../../../shared/automation';
export interface RunClock {
    local(): number;
    mono(): number;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
    watch?(callback: () => void): () => void;
}
export const runClock: RunClock = {
    watch: (callback) => {
        const timer = setInterval(callback, 250);
        return () => clearInterval(timer);
    },
    local: () => Date.now(),
    mono: () => performance.now(),
    sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
            const cancel = () => {
                clearTimeout(timer);
                reject(Error('Cancelled.'));
            };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', cancel);
                resolve();
            }, ms);
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
        }),
};
export interface FlowBackend {
    connection(): string;
    available(): boolean;
    acquire(): () => void;
    execute(
        step: AutomationPlan['steps'][number],
        plan: AutomationPlan,
        signal: AbortSignal,
        id: string,
    ): Promise<
        CommandCapture & { requestBytes?: string; deviceTime?: AutomationRecord['deviceTime'] }
    >;
    target: AutomationRecord['target'];
    sampleClock?(): Promise<ClockCalibration>;
}
export interface FlowState {
    state: 'idle' | 'waiting' | 'running' | 'delaying' | 'paused' | 'finished';
    message: string;
    step?: string;
}
export class FlowRunner {
    private controller?: AbortController;
    private repeat = true;
    private stopped = false;
    private active?: Promise<void>;
    constructor(
        private changed: (s: FlowState) => void,
        private recorded: (r: AutomationRecord) => void,
        private clock: RunClock = runClock,
    ) {}
    get busy() {
        return Boolean(this.active);
    }
    stop() {
        this.repeat = false;
        this.stopped = true;
        if (this.controller && !this.executing) this.controller.abort();
        this.changed({
            state: this.executing ? 'running' : 'paused',
            message: this.executing
                ? 'Repetition stopped; active command will finish.'
                : 'Waiting flow stopped. Arm again to resume.',
        });
    }
    private executing = false;
    private failureNotice = '';
    interrupt(reason: string) {
        this.failureNotice = reason;
        this.cancel();
    }
    cancel() {
        this.repeat = false;
        this.stopped = true;
        this.controller?.abort();
    }
    start(input: AutomationPlan, backend: FlowBackend) {
        if (this.active) throw Error('A flow is already armed or running.');
        const plan = validatePlan(input),
            connection = backend.connection();
        if (!backend.available() || !connection)
            throw Error('Connect the selected transport first.');
        armPlan(plan, this.clock.local(), this.clock.mono(), connection);
        this.repeat = true;
        this.failureNotice = '';
        this.stopped = false;
        const controller = new AbortController();
        this.controller = controller;
        let release: () => void;
        try {
            release = backend.acquire();
        } catch (e) {
            this.controller = undefined;
            throw e;
        }
        const task = this.run(plan, backend, connection, controller.signal)
            .catch((error) => {
                this.changed({
                    state: 'paused',
                    message:
                        this.failureNotice ||
                        (controller.signal.aborted
                            ? 'Flow cancelled. Commands already sent may continue on the device.'
                            : String(error instanceof Error ? error.message : error) +
                              ' Flow paused; arm explicitly to resume.'),
                });
            })
            .finally(() => {
                release();
                this.executing = false;
                if (this.active === task) this.active = undefined;
                this.controller = undefined;
            });
        this.active = task;
        return task;
    }
    private async run(
        plan: AutomationPlan,
        backend: FlowBackend,
        connection: string,
        signal: AbortSignal,
    ) {
        let lastLocal = this.clock.local(),
            lastMono = this.clock.mono(),
            calibration = plan.start?.calibration;
        const guard = () => {
            if (signal.aborted) throw Error('Cancelled.');
            if (!backend.available() || backend.connection() !== connection)
                throw Error('Selected transport disconnected or changed.');
            const local = this.clock.local(),
                mono = this.clock.mono(),
                elapsed = mono - lastMono;
            if (elapsed < 0 || elapsed > 2500 || Math.abs(local - lastLocal - elapsed) > 1000)
                throw Error('App slept, timer stalled or local clock changed.');
            lastLocal = local;
            lastMono = mono;
        };
        const wait = async (ms: number, state: FlowState['state'], message: string) => {
            const end = this.clock.mono() + ms;
            this.changed({ state, message });
            while (this.clock.mono() < end) {
                await this.clock.sleep(Math.min(250, end - this.clock.mono()), signal);
                guard();
            }
        };
        if (plan.start) {
            this.changed({
                state: 'waiting',
                message:
                    'Armed start ' +
                    new Date(plan.start.epochMs).toISOString() +
                    ' using ' +
                    plan.start.clock +
                    ' clock · ' +
                    plan.start.zone +
                    (plan.start.utcOffset ? ' UTC' + plan.start.utcOffset : ''),
            });
            while (true) {
                guard();
                if (
                    plan.start.clock === 'device' &&
                    calibration &&
                    this.clock.mono() - calibration.sampledMonoMs > 10000
                ) {
                    if (!backend.sampleClock)
                        throw Error('Device clock source cannot be refreshed.');
                    const previous = calibratedNow(
                        calibration,
                        this.clock.local(),
                        this.clock.mono(),
                        connection,
                    );
                    const fresh = await backend.sampleClock();
                    guard();
                    if (fresh.source !== calibration.source || fresh.zone !== calibration.zone)
                        throw Error('Device clock source or timezone changed.');
                    if (
                        Math.abs(fresh.deviceEpochMs - previous) >
                        fresh.uncertaintyMs + calibration.uncertaintyMs + 1000
                    )
                        throw Error('Device clock changed.');
                    calibration = fresh;
                }
                const now =
                        plan.start.clock === 'device'
                            ? calibratedNow(
                                  calibration!,
                                  this.clock.local(),
                                  this.clock.mono(),
                                  connection,
                              )
                            : this.clock.local(),
                    remaining = plan.start.epochMs - now;
                if (remaining < -1000)
                    throw Error('Scheduled start was missed. Choose a new future time.');
                if (remaining <= 0) break;
                await this.clock.sleep(Math.min(250, remaining), signal);
            }
        }
        let run = 0;
        do {
            guard();
            const runId = crypto.randomUUID();
            run++;
            for (const [ordinal, step] of plan.steps.entries()) {
                if (!step.enabled) continue;
                if (step.delaySeconds)
                    await wait(step.delaySeconds * 1000, 'delaying', 'Delay before ' + step.name);
                guard();
                const id = crypto.randomUUID().replaceAll('-', ''),
                    startedAt = new Date(this.clock.local()).toISOString(),
                    began = this.clock.mono();
                this.changed({
                    state: 'running',
                    message: 'Run ' + run + ' · ' + step.name,
                    step: step.id,
                });
                this.executing = true;
                const unwatch = this.clock.watch?.(() => {
                    try {
                        guard();
                    } catch (error) {
                        this.failureNotice =
                            (error instanceof Error ? error.message : String(error)) +
                            ' Flow paused; commands already sent may continue. Arm explicitly to resume.';
                        this.controller?.abort();
                    }
                });
                let capture: Awaited<ReturnType<FlowBackend['execute']>>;
                try {
                    capture = await backend.execute(step, plan, signal, id);
                } catch (error) {
                    capture = {
                        stdout: '',
                        stderr: error instanceof Error ? error.message : String(error),
                        exitCode: null,
                        completion: signal.aborted ? 'cancelled' : 'transport-error',
                        truncated: false,
                        chunks: [],
                    };
                } finally {
                    unwatch?.();
                    this.executing = false;
                }
                const completedAt = new Date(this.clock.local()).toISOString();
                this.recorded({
                    ...capture,
                    id,
                    runId,
                    ordinal: ordinal + 1,
                    name: step.name,
                    command: step.command,
                    transport: plan.transport,
                    target: { ...backend.target },
                    startedAt,
                    completedAt,
                    localZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    durationMs: Math.max(0, this.clock.mono() - began),
                    deviceTime: capture.deviceTime ?? null,
                    execution: {
                        timeoutSeconds: plan.timeoutSeconds,
                        repeatSeconds: plan.repeatSeconds,
                        stepDelaySeconds: step.delaySeconds,
                        ...(plan.start
                            ? {
                                  scheduledStart: {
                                      epochMs: plan.start.epochMs,
                                      clock: plan.start.clock,
                                      zone: plan.start.zone,
                                      ...(plan.start.wallTime !== undefined
                                          ? { wallTime: plan.start.wallTime }
                                          : {}),
                                      ...(plan.start.utcOffset !== undefined
                                          ? { utcOffset: plan.start.utcOffset }
                                          : {}),
                                      ...(plan.start.calibration
                                          ? {
                                                source: plan.start.calibration.source,
                                                uncertaintyMs: plan.start.calibration.uncertaintyMs,
                                            }
                                          : {}),
                                  },
                              }
                            : {}),
                        ...(plan.transport === 'serial' ? { serial: { ...plan.serial } } : {}),
                    },
                });
                // Long command execution is allowed; check wall/monotonic drift and connection immediately after it.
                const local = this.clock.local(),
                    mono = this.clock.mono();
                if (Math.abs(local - lastLocal - (mono - lastMono)) > 1000)
                    throw Error('Local clock changed or app slept during command execution.');
                lastLocal = local;
                lastMono = mono;
                guard();
                if (
                    !['exit', 'prompt-observed'].includes(capture.completion) ||
                    capture.truncated ||
                    (plan.transport === 'ssh' &&
                        (capture.completion !== 'exit' ||
                            capture.exitCode === null ||
                            capture.termination))
                )
                    throw Error('Command ended with ' + capture.completion + '.');
                if (this.stopped) break;
            }
            if (this.stopped || !this.repeat || plan.repeatSeconds === null) break;
            await wait(
                plan.repeatSeconds * 1000,
                'waiting',
                'Repetition delay after completed flow; no overlap or catch-up.',
            );
        } while (!signal.aborted);
        this.changed({
            state: 'finished',
            message: 'Flow finished. Retained results are ready to review or export.',
        });
    }
}
export class ResultStore {
    records: AutomationRecord[] = [];
    evicted = 0;
    bytes = 0;
    add(record: AutomationRecord) {
        const size = new TextEncoder().encode(JSON.stringify(record)).length;
        this.records.push(record);
        this.bytes += size;
        while (
            this.records.length > AUTOMATION_LIMITS.rows ||
            this.bytes > AUTOMATION_LIMITS.retainedBytes
        ) {
            const removed = this.records.shift()!;
            this.bytes -= new TextEncoder().encode(JSON.stringify(removed)).length;
            this.evicted++;
        }
    }
    clear() {
        this.records = [];
        this.bytes = 0;
        this.evicted = 0;
    }
}
