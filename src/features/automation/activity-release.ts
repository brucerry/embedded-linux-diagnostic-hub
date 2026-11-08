interface ReleaseAttempt {
    release: () => Promise<unknown>;
    resumes: (() => void)[];
    acknowledged: boolean;
    transportRetired: boolean;
    retired: boolean;
    resumed: number;
    failed: boolean;
    error?: unknown;
    task?: Promise<void>;
}

/** Retain a Page owner until its local admission and host-lease retirement both acknowledge. */
export class ActivityReleaseQueue {
    private attempts = new Set<ReleaseAttempt>();
    constructor(private changed: (message: string) => void) {}

    get hasFailures() {
        return [...this.attempts].some((attempt) => attempt.failed);
    }

    private publish() {
        const failures = [...this.attempts].filter((attempt) => attempt.failed);
        const first = failures[0];
        let detail = 'The release diagnostic could not be formatted.';
        if (first) {
            try {
                detail = first.error instanceof Error ? first.error.message : String(first.error);
            } catch {}
        }
        const message = first
            ? 'Background execution cleanup remains pending: ' +
              detail +
              (failures.length > 1 ? ' (' + failures.length + ' owned attempts).' : '.') +
              ' New runs are disarmed. Retry cleanup explicitly.'
            : '';
        // Reporting cannot retire an owner or replace its original release failure.
        try {
            this.changed(message);
        } catch {}
    }

    create(release: () => Promise<unknown>, resumes: (() => void)[], transportRetired = false) {
        const attempt: ReleaseAttempt = {
            release,
            resumes,
            transportRetired,
            acknowledged: false,
            retired: false,
            resumed: 0,
            failed: false,
        };
        return () => {
            if (attempt.retired) return Promise.resolve();
            this.attempts.add(attempt);
            return this.run(attempt);
        };
    }

    private run(attempt: ReleaseAttempt): Promise<void> {
        if (attempt.task) return attempt.task;
        // Defer dispatch so even a synchronous throw is registered before it settles.
        const task = Promise.resolve().then(async () => {
            try {
                // A lost background-lease reply must not re-own a positively retired transport.
                // Start its release once, but return local admissions without waiting for that reply.
                const released = attempt.acknowledged
                    ? Promise.resolve()
                    : Promise.resolve()
                          .then(attempt.release)
                          .then(() => {
                              attempt.acknowledged = true;
                          });
                // A cancelled pre-arm acquisition has no transport-retirement proof yet;
                // its local fence stays held through the host lease acknowledgement.
                if (!attempt.transportRetired) await released;
                let resumeFailure: { error: unknown } | undefined;
                try {
                    while (attempt.resumed < attempt.resumes.length) {
                        attempt.resumes[attempt.resumed]();
                        attempt.resumed++;
                    }
                } catch (error) {
                    resumeFailure = { error };
                    attempt.failed = true;
                    attempt.error = error;
                    this.publish();
                }
                try {
                    await released;
                } catch (error) {
                    if (resumeFailure)
                        throw new AggregateError(
                            [error, resumeFailure.error],
                            'Host release and local admission retirement failed.',
                            { cause: error },
                        );
                    throw error;
                }
                if (resumeFailure) throw resumeFailure.error;
                attempt.retired = true;
                this.attempts.delete(attempt);
            } catch (error) {
                attempt.failed = true;
                attempt.error = error;
                throw error;
            } finally {
                if (attempt.task === task) attempt.task = undefined;
                this.publish();
            }
        });
        attempt.task = task;
        void task.catch(() => {});
        return task;
    }

    async retryFailures() {
        const pending = [...this.attempts].filter((attempt) => attempt.failed);
        const results = await Promise.allSettled(pending.map((attempt) => this.run(attempt)));
        const failures = results.filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failures.length === 1) throw failures[0].reason;
        if (failures.length > 1)
            throw new AggregateError(
                failures.map((result) => result.reason),
                'Background release attempts remain pending.',
            );
    }
}
