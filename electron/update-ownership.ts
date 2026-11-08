/** Native-only custody. A rejected operation is not a resource-retirement receipt. */
export class UpdateOwnership {
    private resources = new Map<
        object,
        { stage: string; resource: unknown; blocked?: boolean; error?: unknown }
    >();
    private operation?: Promise<unknown>;
    private observations = new Set<Promise<unknown>>();
    private stopping = false;
    private publications = new Map<string, 'published' | 'removed' | 'uncertain'>();
    publication(stage: string, state: 'published' | 'removed' | 'uncertain') {
        this.publications.set(stage, state);
        this.publish();
    }
    private changed = new Set<() => void>();
    private primary?: unknown;
    private primarySet = false;
    constructor(private notify: () => void = () => {}) {}
    get held() {
        return this.resources.size > 0;
    }
    get blocked() {
        return [...this.resources.values()].some((value) => value.blocked);
    }
    get active() {
        return this.operation !== undefined || this.observations.size > 0 || this.held;
    }
    get exclusive() {
        return this.operation !== undefined;
    }
    get closing() {
        return this.stopping;
    }
    snapshot() {
        return {
            active: this.active,
            closing: this.stopping,
            primary: this.primary,
            publications: Object.fromEntries(this.publications),
            resources: [...this.resources.values()].map(({ stage, blocked, error }) => ({
                stage,
                blocked: Boolean(blocked),
                error,
            })),
        };
    }
    hold(stage: string, resource: unknown) {
        const token = {};
        this.resources.set(token, { stage, resource });
        let retired = false;
        return {
            acknowledge: () => {
                if (retired) return;
                retired = true;
                this.resources.delete(token);
                this.publish();
            },
            blocked: (error: unknown) => {
                if (!retired) {
                    this.resources.get(token)!.blocked = true;
                    this.resources.get(token)!.error = error;
                    this.publish();
                }
            },
        };
    }
    diagnose(error: unknown) {
        if (!this.primarySet) {
            this.primary = error;
            this.primarySet = true;
        }
        this.publish();
    }
    private publish() {
        try {
            this.notify();
        } catch {
            /* Notification cannot acknowledge retirement. */
        }
        for (const resolve of this.changed) resolve();
        this.changed.clear();
    }
    start<T>(work: () => Promise<T>): Promise<T> {
        if (this.stopping) throw Error('Diagnostic Hub is shutting down.');
        if (this.active) throw Error(this.describe() || 'The previous update has not retired.');
        this.primary = undefined;
        this.primarySet = false;
        this.publications.clear();
        // Install before invoking work, including synchronous reentrant callbacks.
        const task = Promise.resolve().then(work);
        this.operation = task;
        void task.then(
            () => {
                if (this.operation === task) {
                    this.operation = undefined;
                    this.publish();
                }
            },
            (error) => {
                this.diagnose(error);
                if (this.operation === task) {
                    this.operation = undefined;
                    this.publish();
                }
            },
        );
        return task;
    }
    /** Independent metadata/check reads may coexist, but never enter an update transaction. */
    observe<T>(work: () => Promise<T>): Promise<T> {
        if (this.stopping) throw Error('Diagnostic Hub is shutting down.');
        if (this.exclusive || this.blocked || (this.held && !this.observations.size))
            throw Error(this.describe() || 'The previous update has not retired.');
        const task = Promise.resolve().then(work);
        this.observations.add(task);
        void task.then(
            () => {
                this.observations.delete(task);
                this.publish();
            },
            (error) => {
                this.diagnose(error);
                this.observations.delete(task);
                this.publish();
            },
        );
        return task;
    }
    async shutdown() {
        this.stopping = true;
        // Updates are allowed to finish, including their requested restart. Never
        // await this shutdown outcome from the transaction's restart callback.
        while (this.active)
            await new Promise<void>((resolve) => {
                this.changed.add(resolve);
            });
    }
    describe() {
        const blocked = [...this.resources.values()].filter((value) => value.blocked);
        if (!blocked.length) return '';
        const readable = (error: unknown) => {
            try {
                return String(error instanceof Error ? error.message : error).slice(0, 256);
            } catch {
                return 'Unprintable update error';
            }
        };
        return (
            'Update retirement unconfirmed; normal quit remains blocked. ' +
            (this.primarySet ? readable(this.primary) + '; ' : '') +
            blocked.map((value) => value.stage + ': ' + readable(value.error)).join('; ')
        );
    }
}

/** Retain all independent errors; never let finally replace the primary failure. */
export function updateErrors(
    primary: { failed: boolean; error?: unknown },
    cleanup: unknown[],
    cleanupStage = 'cleanup',
): void {
    const errors = [...(primary.failed ? [primary.error] : []), ...cleanup];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
        const first = errors[0];
        const readable = (value: unknown) => {
            try {
                return String(value instanceof Error ? value.message : value).slice(0, 512);
            } catch {
                return 'Unprintable update error';
            }
        };
        throw new AggregateError(
            errors,
            readable(first) + '; ' + cleanupStage + ': ' + cleanup.map(readable).join('; '),
            { cause: first },
        );
    }
}
