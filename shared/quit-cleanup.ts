import { ConnectionFailure } from './connection';

export interface CleanupStep {
    stage: string;
    run(): unknown | Promise<unknown>;
}
export interface CleanupFailure {
    stage: string;
    error: unknown;
}

/** Start every independent step, including after a synchronous throw, and join all outcomes. */
export async function settleCleanup(steps: readonly CleanupStep[]): Promise<CleanupFailure[]> {
    const outcomes = await Promise.all(
        steps.map(async (step): Promise<CleanupFailure | null> => {
            try {
                await step.run();
                return null;
            } catch (error) {
                return { stage: step.stage, error };
            }
        }),
    );
    return outcomes.filter((result): result is CleanupFailure => result !== null);
}

export function throwCleanupFailures(failures: readonly CleanupFailure[]): void {
    if (failures.length)
        throw new AggregateError(
            failures.map((failure) => failure.error),
            'Cleanup failed: ' + failures.map((failure) => failure.stage).join(', '),
        );
}

export interface QuitCleanupPorts {
    cancelConnection(): unknown;
    clearHostVerification(): unknown;
    disconnect(): unknown;
    prepareConsole(): Promise<unknown>;
    joinConnection(): Promise<unknown>;
    joinSsh(): Promise<unknown>;
    finishConsole(): Promise<unknown>;
    shutdownCapture(): Promise<unknown>;
    shutdownReports?(): Promise<unknown>;
}

/** No independent rejection can bypass a sibling join or authorize a dependent store close. */
export async function runQuitCleanup(ports: QuitCleanupPorts): Promise<void> {
    const failures = await settleCleanup([
        { stage: 'cancel-connection', run: () => ports.cancelConnection() },
        { stage: 'host-verification', run: () => ports.clearHostVerification() },
        { stage: 'disconnect', run: () => ports.disconnect() },
    ]);
    failures.push(
        ...(await settleCleanup([
            {
                stage: 'console-and-ssh',
                run: async () => {
                    const preparation = await settleCleanup([
                        { stage: 'console-readers', run: () => ports.prepareConsole() },
                        // Observe connection rejection immediately, even while readers are held.
                        { stage: 'connection-settlement', run: () => ports.joinConnection() },
                    ]);
                    const ssh = await settleCleanup([
                        // Snapshot SSH owners only after the connection attempt has settled.
                        { stage: 'ssh-owners', run: () => ports.joinSsh() },
                    ]);
                    const prerequisites = [...preparation, ...ssh];
                    if (!prerequisites.length && !failures.length)
                        prerequisites.push(
                            ...(await settleCleanup([
                                { stage: 'console-journal', run: () => ports.finishConsole() },
                            ])),
                        );
                    throwCleanupFailures(prerequisites);
                },
            },
            { stage: 'native-capture', run: () => ports.shutdownCapture() },
            { stage: 'report-exports', run: () => ports.shutdownReports?.() },
        ])),
    );
    throwCleanupFailures(failures);
}

export type QuitOutcome = { status: 'ready' } | { status: 'blocked'; error: unknown };
export type QuitPhase = 'idle' | 'waiting' | 'ready' | 'blocked';

/** Cache before invoking callbacks, so reentrant requests cannot replay failed cleanup. */
export function createQuitController<T>(cleanup: (snapshot: T) => Promise<void>) {
    let phase: QuitPhase = 'idle';
    let task: Promise<QuitOutcome> | undefined;
    return {
        get phase(): QuitPhase {
            return phase;
        },
        begin(snapshot: T): Promise<QuitOutcome> {
            if (task) return task;
            phase = 'waiting';
            task = Promise.resolve()
                .then(() => cleanup(snapshot))
                .then(
                    (): QuitOutcome => {
                        phase = 'ready';
                        return { status: 'ready' };
                    },
                    (error: unknown): QuitOutcome => {
                        phase = 'blocked';
                        return { status: 'blocked', error };
                    },
                );
            return task;
        },
    };
}

/** Call only after frame authorization; mixed protocol operations still require their validator. */
export function quitAllowsIpc(name: string, operation?: string): boolean {
    switch (name) {
        case 'hub:serial-cleanup-ack':
        case 'hub:terminal-ack':
        case 'hub:automation-activity-release':
        case 'hub:cancel-report-export':
        case 'hub:report-export-status':
            return true;
        case 'hub:automation-stream':
            return ['read', 'ack', 'cancel', 'finalize'].includes(operation ?? '');
        case 'hub:automation-console':
            return ['read', 'ack', 'status', 'heartbeat'].includes(operation ?? '');
        default:
            return false;
    }
}

/** Only this runtime's typed public attempt failures are nonblocking operation outcomes. */
export function isConnectionAttemptOutcome(error: unknown): error is ConnectionFailure {
    return (
        error instanceof ConnectionFailure &&
        ['cancelled', 'network', 'authentication', 'host-key', 'policy'].includes(error.code)
    );
}

/** Settlement is not a closure receipt: the caller must still join every actual SSH owner. */
export async function settleConnectionAttempt(
    done: Promise<void> | undefined,
): Promise<ConnectionFailure | null> {
    try {
        await done;
        return null;
    } catch (error) {
        if (isConnectionAttemptOutcome(error)) return error;
        throw error;
    }
}
