/** Private qualification verdict. This validates observed state, never performs cleanup. */
const ownerNames = ['writer', 'reader', 'pin', 'export', 'rpc', 'cleanup'] as const;
const serviceNames = ['rpcTimer', 'storeOpen', 'catalogOpen'] as const;
const cacheNames = ['completed', 'expiredPins'] as const;
type ObjectRow = Record<string, unknown>;
type TerminalDownloadState = 'completed' | 'cancelled' | 'interrupted';

function object(value: unknown, name: string): ObjectRow {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Native shutdown object missing or malformed: ' + name);
    return value as ObjectRow;
}
function own(row: ObjectRow, key: string, name: string) {
    if (!Object.hasOwn(row, key)) throw Error('Native shutdown field missing: ' + name + '.' + key);
    return row[key];
}
function exactly(row: ObjectRow, keys: readonly string[], name: string) {
    for (const key of keys) own(row, key, name);
    for (const key of Object.keys(row))
        if (!keys.includes(key))
            throw Error('Native shutdown field unassessed: ' + name + '.' + key);
}
function falseValue(value: unknown, name: string) {
    if (value !== false) throw Error('Native shutdown resource not verified closed: ' + name);
}
function count(value: unknown, name: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw Error('Native shutdown count missing or malformed: ' + name);
    return value;
}

/**
 * The caller supplies the final actual will-quit snapshot and its actual download records.
 * captureExpected must be remembered from observed host creation, not inferred from this snapshot.
 * A verified receipt covers these named owners only; process/history joins are separate gates.
 */
export function assertProductNativeShutdown(
    value: unknown,
    options: { captureExpected: boolean; downloads: unknown },
) {
    const snapshot = object(value, 'snapshot'),
        input = object(options, 'options');
    if (typeof own(input, 'captureExpected', 'options') !== 'boolean')
        throw Error('Native shutdown capture expectation must be an observed boolean.');
    falseValue(own(snapshot, 'sshHasResources', 'snapshot'), 'sshHasResources');
    falseValue(own(snapshot, 'consoleHasResources', 'snapshot'), 'consoleHasResources');
    const activity = object(own(snapshot, 'activity', 'snapshot'), 'activity');
    falseValue(own(activity, 'lease', 'activity'), 'activity.lease');

    const captureValue = own(snapshot, 'capture', 'snapshot');
    let cachedMetadata: { completed: number; expiredPins: number } | null = null;
    if (captureValue === null) {
        if (options.captureExpected)
            throw Error('Previously observed native capture host is absent.');
    } else {
        const capture = object(captureValue, 'capture'),
            owners = object(own(capture, 'owners', 'capture'), 'capture.owners'),
            services = object(own(capture, 'services', 'capture'), 'capture.services'),
            cache = object(own(capture, 'cache', 'capture'), 'capture.cache');
        exactly(owners, ownerNames, 'capture.owners');
        exactly(services, serviceNames, 'capture.services');
        exactly(cache, cacheNames, 'capture.cache');
        for (const name of ownerNames)
            if (count(owners[name], 'capture.owners.' + name) !== 0)
                throw Error('Native shutdown owner remains: ' + name);
        for (const name of serviceNames) falseValue(services[name], 'capture.services.' + name);
        cachedMetadata = {
            completed: count(cache.completed, 'capture.cache.completed'),
            expiredPins: count(cache.expiredPins, 'capture.cache.expiredPins'),
        };
    }

    const records = own(input, 'downloads', 'options');
    if (!Array.isArray(records)) throw Error('Actual native download record array is required.');
    const downloadStates: Record<TerminalDownloadState, number> = {
        completed: 0,
        cancelled: 0,
        interrupted: 0,
    };
    for (const [index, value] of records.entries()) {
        const row = object(value, 'downloads[' + index + ']'),
            state = own(row, 'state', 'downloads[' + index + ']');
        if (state !== 'completed' && state !== 'cancelled' && state !== 'interrupted')
            throw Error('Native download is pending or unassessed: ' + String(state));
        downloadStates[state]++;
    }
    return {
        verified: true as const,
        scope: 'native-owner-snapshot-and-terminal-downloads' as const,
        capturePresent: captureValue !== null,
        cachedMetadata,
        downloadStates,
    };
}
