import assert from 'node:assert/strict';

type Emit = (stage: string, data: unknown) => Promise<void>;
export interface AggregateDiagnosticClock {
    set(callback: () => void, milliseconds: number): unknown;
    clear(handle: unknown): void;
}
const actualClock: AggregateDiagnosticClock = {
    set: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AggregateCallDeadline extends Error {
    constructor(
        readonly id: number,
        readonly phase: string,
    ) {
        super('Call remains unjoined after 10000 ms: ' + phase);
    }
}

/** A bounded wait never cancels, clears, or certifies its underlying call. */
export class AggregateCallTracker {
    private sequence = 0;
    private readonly active = new Map<
        number,
        { id: number; phase: string; deadlineExpired: boolean }
    >();
    constructor(
        private emit: Emit,
        private stage = 'aggregate-bounded-call',
        private clock: AggregateDiagnosticClock = actualClock,
    ) {}
    pending() {
        return [...this.active.values()].map((row) => ({ ...row }));
    }
    assertJoined() {
        assert.equal(
            this.active.size,
            0,
            'Actual calls remain unjoined: ' +
                this.pending()
                    .map((row) => row.phase)
                    .join(', '),
        );
    }
    async run<T>(phase: string, work: () => Promise<T>): Promise<T> {
        const row = { id: ++this.sequence, phase, deadlineExpired: false };
        this.active.set(row.id, row);
        let timer: unknown;
        const actual = (async () => {
            try {
                await this.emit(this.stage, { ...row, state: 'started' });
                const value = await work();
                await this.emit(this.stage, {
                    ...row,
                    state: row.deadlineExpired ? 'settled-after-deadline' : 'settled',
                });
                return value;
            } catch (error) {
                await this.emit(this.stage, {
                    ...row,
                    state: row.deadlineExpired ? 'rejected-after-deadline' : 'rejected',
                    error: String(error),
                });
                throw error;
            } finally {
                this.active.delete(row.id);
            }
        })();
        const deadline = new Promise<never>((_, reject) => {
            timer = this.clock.set(() => {
                row.deadlineExpired = true;
                reject(new AggregateCallDeadline(row.id, phase));
            }, 10000);
        });
        try {
            return await Promise.race([actual, deadline]);
        } finally {
            this.clock.clear(timer);
        }
    }
}

export interface AggregateFailureObservation {
    name: string;
    read(): Promise<unknown>;
}

/** Save the original error before even constructing optional diagnostic reads. */
export async function recordAggregateFailure(options: {
    error: unknown;
    emit: Emit;
    calls: AggregateCallTracker;
    collect(): readonly AggregateFailureObservation[];
}) {
    const { error, emit, calls } = options;
    try {
        await emit('aggregate-cycle-failed', {
            primary: String(error),
            stack: error instanceof Error ? error.stack : null,
        });
    } catch (recording) {
        throw new AggregateError([error, recording], 'Original error and failure-recording error.');
    }
    const saveContext = async (data: unknown) => {
        try {
            await emit('aggregate-failure-context', data);
        } catch (recording) {
            throw new AggregateError(
                [error, recording],
                'Original error and context-recording error.',
            );
        }
    };
    let observations: readonly AggregateFailureObservation[];
    try {
        observations = options.collect();
    } catch (collection) {
        await saveContext({
            collectionError: String(collection),
            unjoined: calls.pending(),
        });
        return;
    }
    const results = await Promise.all(
        observations.map(async ({ name, read }) => {
            try {
                return {
                    name,
                    status: 'fulfilled',
                    value: await calls.run('failure-context/' + name, read),
                };
            } catch (failure) {
                return {
                    name,
                    status: failure instanceof AggregateCallDeadline ? 'unjoined' : 'rejected',
                    error: String(failure),
                };
            }
        }),
    );
    await saveContext({
        observations: results,
        unjoined: calls.pending(),
        scope: 'A diagnostic deadline is not a cancellation or cleanup acknowledgement.',
    });
}
