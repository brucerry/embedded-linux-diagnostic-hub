/** Private build observation only; React refs are never kept alive by this module. */
interface Ref<T> {
    current: T;
}
const custodyNames = [
    'arming',
    'armAttempt',
    'cleanupActivity',
    'cleanupActivityRetirement',
    'cleanupClock',
    'cleanupConsoleResults',
    'pendingClockSamples',
] as const;
export type PageCustodyRefs = Record<(typeof custodyNames)[number], Ref<unknown>>;
const records: {
    inspection: WeakRef<Ref<string | null>>;
    epoch: WeakRef<Ref<number>>;
    custody: WeakRef<Ref<unknown>>[];
}[] = [];
const pendingRuns = new Set<object>();

/** Observe the complete actual Start continuation, including cancelled pre-arm acquisition. */
export function trackProductPageRun<A extends unknown[], R>(run: (...args: A) => Promise<R>) {
    return function (this: unknown, ...args: A): Promise<R> {
        if (pendingRuns.size >= 256) throw Error('Private Page task observation bound exceeded.');
        const ticket = {};
        pendingRuns.add(ticket); // Reserve before invoking product code or admitting its RPC.
        let task: Promise<R>;
        try {
            task = run.apply(this, args);
        } catch (error) {
            pendingRuns.delete(ticket);
            throw error;
        }
        const release = () => {
            pendingRuns.delete(ticket);
        };
        void task.then(release, release);
        return task; // Identity and original success/rejection are preserved.
    };
}

export function trackProductPageRefs(
    inspection: Ref<string | null>,
    epoch: Ref<number>,
    refs: PageCustodyRefs,
) {
    const custody = custodyNames.map((name) => {
        const value = refs[name];
        if (!value || !Object.hasOwn(value, 'current'))
            throw Error('Actual Page custody ref absent: ' + name);
        return value;
    });
    for (let index = records.length - 1; index >= 0; index--)
        if (
            !records[index].inspection.deref() &&
            !records[index].epoch.deref() &&
            records[index].custody.every((ref) => !ref.deref())
        )
            records.splice(index, 1);
    const existing = records.find((row) => row.inspection.deref() === inspection);
    if (existing) {
        if (
            existing.epoch.deref() !== epoch ||
            existing.custody.some((ref, index) => ref.deref() !== custody[index])
        )
            throw Error('Actual Page custody identity changed.');
        return;
    }
    if (records.length >= 256) throw Error('Private Page ref observation bound exceeded.');
    records.push({
        inspection: new WeakRef(inspection),
        epoch: new WeakRef(epoch),
        custody: custody.map((ref) => new WeakRef(ref)),
    });
}

export function readProductPageCustody() {
    const counts = {
        pages: 0,
        pendingRuns: pendingRuns.size,
        arming: 0,
        armAttempts: 0,
        hostLeases: 0,
        retirementContinuations: 0,
        clockSuspensions: 0,
        consoleSuspensions: 0,
        pendingClockSamples: 0,
    };
    for (const record of records) {
        const values = record.custody.map((ref) => ref.deref());
        const inspection = record.inspection.deref(),
            epoch = record.epoch.deref();
        if (values.every((value) => !value) && !inspection && !epoch) continue;
        // Missing observations are unsupported, never interpreted as released resources.
        if (values.some((value) => !value) || !inspection || !epoch)
            throw Error('Actual Page custody observation incomplete.');
        if (
            (inspection.current !== null && typeof inspection.current !== 'string') ||
            !Number.isSafeInteger(epoch.current) ||
            epoch.current < 0
        )
            throw Error('Actual Page custody identity shape changed.');
        const [arming, attempt, lease, retire, clock, console, samples] = values.map(
            (ref) => ref!.current,
        );
        if (
            typeof arming !== 'boolean' ||
            (attempt !== null && typeof attempt !== 'symbol') ||
            (lease !== undefined && typeof lease !== 'string') ||
            [retire, clock, console].some(
                (value) => value !== undefined && typeof value !== 'function',
            ) ||
            !Number.isSafeInteger(samples) ||
            (samples as number) < 0
        )
            throw Error('Actual Page custody shape changed.');
        counts.pages++;
        counts.arming += Number(arming);
        counts.armAttempts += Number(attempt !== null);
        counts.hostLeases += Number(lease !== undefined);
        counts.retirementContinuations += Number(retire !== undefined);
        counts.clockSuspensions += Number(clock !== undefined);
        counts.consoleSuspensions += Number(console !== undefined);
        counts.pendingClockSamples += samples as number;
    }
    return counts;
}
export function readProductPageRefs() {
    for (let index = records.length - 1; index >= 0; index--) {
        const inspection = records[index].inspection.deref(),
            epoch = records[index].epoch.deref();
        if (!inspection || !epoch) continue;
        if (
            (inspection.current !== null && typeof inspection.current !== 'string') ||
            !Number.isSafeInteger(epoch.current) ||
            epoch.current < 0
        )
            throw Error('Actual Page ref shape changed.');
        return { inspectionId: inspection.current, activityEpoch: epoch.current };
    }
    throw Error('Actual Automation Page refs have not been observed.');
}
