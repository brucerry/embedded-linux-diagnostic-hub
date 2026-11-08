import type {} from './memory-product-app';

export interface AggregateRunnerCleanupTarget {
    id: number;
    value: {
        readonly active?: Promise<void>;
        readonly busy: boolean;
        readonly cleanupPending: boolean;
    };
}

/** Bundled into the private App fixture; invoked through its page-global API. */
export async function joinAggregatePageOperations() {
    const api = window.memoryProduct,
        failures: unknown[] = [];
    let before: ReturnType<typeof api.serial.snapshot> | undefined;
    let after: ReturnType<typeof api.serial.snapshot> | undefined;
    let serialJoinInvoked = false,
        repositoryJoined = false;
    let runners: {
        id: number;
        value: AggregateRunnerCleanupTarget['value'];
        active?: Promise<void>;
    }[] = [];
    const runnerJoins: number[] = [];
    const failure = (stage: string, error: unknown) => {
        failures.push(new Error(stage + ': ' + String(error), { cause: error }));
    };
    // Capture strong references and the actual accepted promises before unmount drops React refs.
    try {
        const targets = api.runnerCleanupTargets();
        if (!Array.isArray(targets)) throw Error('Actual runner inventory unavailable.');
        runners = targets.map(({ id, value }) => {
            if (
                !Number.isSafeInteger(id) ||
                id < 1 ||
                !value ||
                !Object.hasOwn(value, 'active') ||
                typeof value.busy !== 'boolean' ||
                typeof value.cleanupPending !== 'boolean' ||
                (value.active !== undefined && !(value.active instanceof Promise))
            )
                throw Error('Actual runner join probe unavailable: ' + id);
            return { id, value, active: value.active };
        });
    } catch (error) {
        failure('capture-runner-joins', error);
    }
    const active = (value: ReturnType<typeof api.serial.snapshot>) => {
        for (const key of ['opens', 'closes', 'remaining'] as const)
            if (!Number.isSafeInteger(value[key]) || value[key] < 0)
                throw Error('Actual synthetic Serial counter unavailable: ' + key);
        for (const key of [
            'readerActive',
            'writerActive',
            'pumping',
            'heldOpen',
            'heldWrite',
            'promptPending',
        ] as const)
            if (typeof value[key] !== 'boolean')
                throw Error('Actual synthetic Serial probe unavailable: ' + key);
        return (
            value.opens !== value.closes ||
            value.readerActive ||
            value.writerActive ||
            value.pumping ||
            value.heldOpen ||
            value.heldWrite ||
            value.promptPending ||
            value.remaining > 0
        );
    };
    try {
        api.unmount();
    } catch (error) {
        if (!(error instanceof Error && error.message === 'Actual App not mounted.'))
            failure('unmount', error);
    }
    try {
        before = api.serial.snapshot();
        if (active(before)) {
            serialJoinInvoked = true;
            await api.closeSerial();
        }
        after = api.serial.snapshot();
        if (active(after)) throw Error('Actual synthetic Serial resources remain after cleanup.');
    } catch (error) {
        failure('close-serial', error);
    }
    for (const { id, value, active } of runners) {
        try {
            await active;
            if (value.busy || value.cleanupPending || value.active)
                throw Error(
                    'Runner still owns work or pending cleanup after its accepted promise settled.',
                );
            runnerJoins.push(id);
        } catch (error) {
            failure('join-runner-' + id, error);
        }
    }
    try {
        await api.closeRepository();
        repositoryJoined = true;
    } catch (error) {
        failure('close-repository', error);
    }
    if (failures.length)
        throw new AggregateError(
            failures,
            'Actual page operation cleanup failed; no success acknowledgement. ' +
                failures.map(String).join(' | '),
        );
    return {
        before,
        after,
        serialJoinInvoked,
        repositoryJoined,
        runnerJoins,
        scope: 'Actual private single-port counters and real joins; no missing instance is converted to zero.',
    };
}
