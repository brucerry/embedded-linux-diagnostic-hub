/** Private build observation only; React refs are never kept alive by this module. */
interface Ref<T> {
    current: T;
}
const records: { inspection: WeakRef<Ref<string | null>>; epoch: WeakRef<Ref<number>> }[] = [];
export function trackProductPageRefs(inspection: Ref<string | null>, epoch: Ref<number>) {
    for (let index = records.length - 1; index >= 0; index--)
        if (!records[index].inspection.deref() || !records[index].epoch.deref())
            records.splice(index, 1);
    if (records.some((row) => row.inspection.deref() === inspection)) return;
    if (records.length >= 256) throw Error('Private Page ref observation bound exceeded.');
    records.push({ inspection: new WeakRef(inspection), epoch: new WeakRef(epoch) });
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
