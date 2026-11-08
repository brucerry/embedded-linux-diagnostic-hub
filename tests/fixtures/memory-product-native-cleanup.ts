type CleanupClock = {
    now(): number;
    set(callback: () => void, milliseconds: number): unknown;
    clear(handle: unknown): void;
};
const systemClock: CleanupClock = {
    now: () => performance.now(),
    set: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
/** One existing 10-second join bound covers the complete cleanup, including evidence writes. */
export const productCleanupJoinMilliseconds = 10000;
/** Test driver only. A timeout is unknown cleanup; every remaining disposer is still invoked. */
export async function runNativeCleanup(
    steps: readonly { name: string; run(): Promise<unknown> }[],
    emit: (stage: string, data: unknown) => Promise<void>,
    options: { stage?: string; clock?: CleanupClock } = {},
) {
    const errors: unknown[] = [];
    const clock = options.clock ?? systemClock;
    const deadline = clock.now() + productCleanupJoinMilliseconds;
    const join = async (name: string, operation: () => Promise<unknown>) => {
        const task = Promise.resolve().then(operation);
        // A timed-out disposer is still running/unknown, never silently abandoned as success.
        void task.catch(() => {});
        const remaining = deadline - clock.now();
        if (remaining <= 0)
            throw Error(`Product cleanup deadline exhausted; ${name} completion is unverified.`);
        let timer: unknown;
        try {
            await Promise.race([
                task,
                new Promise<never>((_resolve, reject) => {
                    timer = clock.set(
                        () =>
                            reject(
                                Error(
                                    `Product cleanup ${name} did not acknowledge within the existing 10-second join bound.`,
                                ),
                            ),
                        remaining,
                    );
                }),
            ]);
        } finally {
            if (timer !== undefined) clock.clear(timer);
        }
    };
    for (const step of steps) {
        let failure: unknown,
            failed = false;
        try {
            await join(step.name, step.run);
        } catch (error) {
            failed = true;
            failure = error;
            errors.push(error);
        }
        try {
            await join('receipt:' + step.name, () =>
                emit(options.stage ?? 'native-cleanup-step', {
                    name: step.name,
                    verified: !failed,
                    ...(failed ? { failure: String(failure) } : {}),
                }),
            );
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length)
        throw new AggregateError(
            errors,
            'Native cleanup failed; every remaining disposer was still attempted.',
        );
}
