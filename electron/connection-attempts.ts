import {
    ConnectionFailure,
    CONNECTION_FAILURE_MESSAGES,
    connectionAttemptId,
} from '../shared/connection';
import {
    settleCleanup,
    settleConnectionAttempt,
    throwCleanupFailures,
} from '../shared/quit-cleanup';

interface ConnectionPorts {
    clear(): void;
    joinCleanup(): Promise<void>;
}
export interface ConnectionAttemptSnapshot {
    readonly id: string;
    readonly controller: AbortController;
    readonly done: Promise<void>;
}
interface Attempt extends ConnectionAttemptSnapshot {
    done: Promise<void>;
    pending: boolean;
    started: boolean;
    preparation: Promise<void>;
    operation: Promise<void>;
    retirement?: Promise<void>;
}
function cleanupFailure(errors: unknown[]): ConnectionFailure {
    const failure = new ConnectionFailure('cleanup', CONNECTION_FAILURE_MESSAGES.cleanup);
    const unique = [...new Set(errors)];
    failure.cause =
        unique.length === 1
            ? unique[0]
            : new AggregateError(unique, 'Connection failed and owned cleanup also failed.');
    return failure;
}

/** One desktop owner: handshake settlement alone never acknowledges retired resources. */
export class DesktopConnectionAttempts {
    private current?: Attempt;
    constructor(private readonly ports: ConnectionPorts) {}

    get busy(): boolean {
        return Boolean(this.current && (this.current.pending || this.current.retirement));
    }
    get snapshot(): ConnectionAttemptSnapshot | undefined {
        const attempt = this.current;
        return attempt && { id: attempt.id, controller: attempt.controller, done: attempt.done };
    }

    connect(id: string, start: (signal: AbortSignal) => Promise<void>): Promise<void> {
        connectionAttemptId(id);
        if (this.busy)
            throw new ConnectionFailure(
                this.current!.pending ? 'policy' : 'cleanup',
                this.current!.pending
                    ? 'A connection or its cleanup is already in progress.'
                    : CONNECTION_FAILURE_MESSAGES.cleanup,
            );
        const controller = new AbortController();
        // Reserve the new identity before invoking ports; cancellation cannot reach its predecessor.
        const preparation = Promise.resolve()
            .then(async () => {
                const failures = await settleCleanup([
                    { stage: 'previous-disconnect', run: () => this.ports.clear() },
                ]);
                failures.push(
                    ...(await settleCleanup([
                        { stage: 'previous-owners', run: () => this.ports.joinCleanup() },
                    ])),
                );
                throwCleanupFailures(failures);
            })
            .catch((error) => {
                throw cleanupFailure([error]);
            });
        const attempt = {
            id,
            controller,
            pending: true,
            started: false,
            preparation,
        } as Attempt;
        this.current = attempt;
        attempt.operation = preparation.then(async () => {
            if (controller.signal.aborted)
                throw new ConnectionFailure('cancelled', 'Connection cancelled.');
            attempt.started = true;
            await start(controller.signal);
            if (controller.signal.aborted)
                throw new ConnectionFailure('cancelled', 'Connection cancelled.');
        });
        const done = attempt.operation
            .catch(async (error) => {
                try {
                    await this.retire(attempt);
                } catch (cleanup) {
                    throw cleanupFailure([error, cleanup]);
                }
                throw error;
            })
            .finally(() => {
                attempt.pending = false;
            });
        attempt.done = done;
        void done.catch(() => {}); // The caller and quit snapshot still observe the original result.
        return done;
    }

    async cancel(id: string): Promise<void> {
        connectionAttemptId(id);
        const attempt = this.current;
        if (!attempt || attempt.id !== id) return;
        const retirement = this.retire(attempt);
        const failures = await settleCleanup([
            { stage: 'connection-attempt', run: () => settleConnectionAttempt(attempt.done) },
            { stage: 'connection-retirement', run: () => retirement },
        ]);
        throwCleanupFailures(failures);
    }

    private retire(attempt: Attempt): Promise<void> {
        if (attempt.retirement) return attempt.retirement;
        attempt.controller.abort();
        const started = attempt.started;
        const task = Promise.resolve().then(async () => {
            const failures = started
                ? await settleCleanup([
                      { stage: 'connection-disconnect', run: () => this.ports.clear() },
                  ])
                : [];
            // Join the raw operation, not done (which itself waits for this retirement).
            await attempt.operation.catch(() => {});
            failures.push(
                ...(await settleCleanup([
                    {
                        stage: 'connection-owners',
                        // A failed preparation is retained, never retried in this transaction.
                        run: () => (started ? this.ports.joinCleanup() : attempt.preparation),
                    },
                ])),
            );
            throwCleanupFailures(failures);
        });
        attempt.retirement = task;
        void task.then(
            () => {
                if (this.current === attempt) this.current = undefined;
            },
            () => {}, // Failed retirement keeps its identity and blocks replacement admission.
        );
        return task;
    }
}
