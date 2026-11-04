/** Private native qualification projections; no cleanup, IO or product mutation. */
export const nativeMainPreimage = '5c2fb3610fdf1801e521be69cc726572df82d4357c03a2c488695783855b78ef';
type Row = Record<string, unknown>;
function row(value: unknown): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Native observation object absent.');
    return value as Row;
}
function fields(value: unknown, keys: string[]) {
    const result = row(value);
    for (const key of keys) if (!Object.hasOwn(result, key)) throw Error('Native observation field absent: ' + key);
    return result;
}
function count(value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error('Native observation count malformed.');
    return value;
}
function flag(value: unknown) {
    if (typeof value !== 'boolean') throw Error('Native observation flag malformed.');
    return value;
}
function size(value: unknown) {
    if (!(value instanceof Set || value instanceof Map)) throw Error('Native observation collection malformed.');
    return count(value.size);
}
function promise(value: unknown) {
    if (value === undefined) return 0;
    if (value === null || typeof (value as Promise<unknown>).then !== 'function') throw Error('Native observed task malformed.');
    return 1;
}
export const mainOwnerNames = ['captureOpening', 'captureOpeningUnconfirmed', 'collection', 'connection', 'hostVerification',
    'reportAttempts', 'reportHandles', 'reportTemporary', 'reportDirectories',
    'updateOperation', 'updateObservations', 'updateResources', 'updateBlocked'] as const;
export function observeNativeMain(input: unknown) {
    const source = fields(input, ['quit', 'captureOpening', 'captureOpeningUnconfirmed', 'collectionTask', 'connectionAttempts', 'hostVerification',
        'reportExports', 'updateOwnership', 'ownsProfile']);
    const quit = row(source.quit), phase = quit.phase;
    if (!['idle', 'waiting', 'ready', 'blocked'].includes(phase as string)) throw Error('Native quit phase unobserved.');
    const updates = fields(source.updateOwnership, ['operation', 'observations', 'resources', 'publications', 'stopping']);
    if (source.collectionTask === undefined) throw Error('Native collection observation absent.');
    if (!(updates.observations instanceof Set)) throw Error('Native update observation inventory malformed.');
    const owners = { captureOpening: count(source.captureOpening), captureOpeningUnconfirmed: count(source.captureOpeningUnconfirmed), collection: source.collectionTask === null ? 0 : promise(source.collectionTask),
        connection: Number(flag(row(source.connectionAttempts).busy)), hostVerification: 0,
        reportAttempts: 0, reportHandles: 0, reportTemporary: 0, reportDirectories: 0,
        updateOperation: promise(updates.operation), updateObservations: size(updates.observations),
        updateResources: size(updates.resources), updateBlocked: 0 };
    const verification = fields(source.hostVerification, ['pending']);
    if (verification.pending !== null) {
        const pending = fields(verification.pending, ['id', 'finish']);
        if (typeof pending.id !== 'string' || typeof pending.finish !== 'function') throw Error('Native host verification shape changed.');
        owners.hostVerification = 1;
    }
    const publicationCache = { published: 0, removed: 0, uncertain: 0 };
    if (!(updates.resources instanceof Map) || !(updates.publications instanceof Map)) throw Error('Native update ownership shape changed.');
    for (const value of updates.resources.values()) {
        const held = fields(value, ['stage', 'resource']);
        if (typeof held.stage !== 'string' || (held.blocked !== undefined && typeof held.blocked !== 'boolean'))
            throw Error('Native update resource malformed.');
        owners.updateBlocked += Number(held.blocked === true);
    }
    for (const state of updates.publications.values()) {
        if (state !== 'published' && state !== 'removed' && state !== 'uncertain') throw Error('Native update publication malformed.');
        publicationCache[state as keyof typeof publicationCache]++;
    }
    const reports = fields(source.reportExports, ['owner', 'stopping']); flag(reports.stopping);
    let reportPublication: string | null = null, reportRetirement: string | null = null;
    if (reports.owner !== undefined) {
        const held = fields(reports.owner, ['custody', 'value']), custody = row(held.custody), value = fields(held.value, ['publication', 'retirement']);
        if (!['unpublished', 'pending', 'published', 'uncertain'].includes(value.publication as string) ||
            !['pending', 'blocked', 'acknowledged'].includes(value.retirement as string)) throw Error('Native report disposition malformed.');
        for (const name of ['directory', 'temporary'])
            if (custody[name] !== undefined && typeof custody[name] !== 'string') throw Error('Native report custody malformed.');
        owners.reportAttempts = 1;
        owners.reportHandles = Number(custody.handle !== undefined);
        owners.reportTemporary = Number(custody.temporary !== undefined);
        owners.reportDirectories = Number(custody.directory !== undefined);
        reportPublication = value.publication as string; reportRetirement = value.retirement as string;
    }
    return { sourceMain: nativeMainPreimage, quitPhase: phase as string, ownsProfile: flag(source.ownsProfile), owners,
        metadata: { reportPublication, reportRetirement, reportStopping: reports.stopping as boolean,
            updatePublications: publicationCache, updateStopping: flag(updates.stopping) } };
}
export function assertNativeMainRetired(input: unknown) {
    const value = fields(input, ['sourceMain', 'quitPhase', 'ownsProfile', 'owners', 'metadata']);
    if (value.sourceMain !== nativeMainPreimage || value.quitPhase !== 'ready' || value.ownsProfile !== true)
        throw Error('Native production quit readiness unconfirmed.');
    const owners = fields(value.owners, [...mainOwnerNames]);
    if (Object.keys(owners).some(key => !mainOwnerNames.includes(key as typeof mainOwnerNames[number]))) throw Error('Unassessed native main owner.');
    for (const name of mainOwnerNames) if (count(owners[name]) !== 0) throw Error('Native main owner remains: ' + name);
    const metadata = fields(value.metadata, ['reportPublication', 'reportRetirement', 'reportStopping', 'updatePublications', 'updateStopping']);
    if (metadata.reportStopping !== true || metadata.updateStopping !== true) throw Error('Native report/update admission not frozen.');
    if (metadata.reportPublication !== null || metadata.reportRetirement !== null)
        throw Error('Native report owner disposition remains.');
    const publications = fields(metadata.updatePublications, ['published', 'removed', 'uncertain']);
    for (const state of ['published', 'removed', 'uncertain']) count(publications[state]);
    return { scope: 'named-native-main-owners' as const, processRetirement: 'not-implied' as const };
}
export function createNativeCaptureOpening() {
    const tickets = new Set<object>();
    let unconfirmed = 0;
    return { get pending() { return tickets.size; }, get unconfirmed() { return unconfirmed; },
        run<T>(open: () => Promise<T>) {
            if (tickets.size >= 256) throw Error('Native capture opening observation bound exceeded.');
            const ticket = {}; tickets.add(ticket);
            let task: Promise<T>;
            try { task = open(); } catch (error) { tickets.delete(ticket); unconfirmed++; throw error; }
            const release = () => { tickets.delete(ticket); };
            void task.then(release, () => { release(); unconfirmed++; });
            return task;
        } };
}

export function observeNativeCapture(input: unknown) {
    if (input === undefined) return null;
    const host = fields(input, ['store', 'server', 'exports', 'closing']); flag(host.closing);
    const s = fields(host.server, ['writer', 'beginning', 'readers', 'pins', 'mutations', 'calls', 'disposed', 'pinReservations', 'completed', 'expiredPins']);
    const d = fields(host.store, ['active', 'modifying', 'closed', 'closing', 'readers', 'pins', 'deleting', 'operation', 'resultWriting', 'listing', 'catalog', 'metadataQueues', 'metadataUncertain', 'jsonOperations']);
    for (const value of [s.readers, s.pins, d.readers, d.metadataQueues, d.metadataUncertain, d.jsonOperations])
        if (!(value instanceof Map)) throw Error('Native capture map observation malformed.');
    for (const value of [host.exports, s.mutations, s.completed, s.expiredPins, d.deleting, d.resultWriting])
        if (!(value instanceof Set)) throw Error('Native capture set observation malformed.');
    for (const value of [s.writer, d.active]) if (value !== undefined && typeof value !== 'string') throw Error('Native writer identity malformed.');
    let readers = 0;
    if (!(d.readers instanceof Map)) throw Error('Native reader inventory malformed.');
    for (const value of d.readers.values()) readers = count(readers + count(value));
    return { owners: { writer: Number(s.writer !== undefined) + promise(s.beginning) + Number(d.active !== undefined) + Number(flag(d.modifying)),
        reader: size(s.readers) + readers, pin: size(s.pins) + count(s.pinReservations) + count(d.pins),
        export: size(host.exports), rpc: count(s.calls), cleanup: size(s.mutations) + size(d.deleting) + size(d.resultWriting) + promise(d.operation) +
            count(d.listing) + size(d.metadataQueues) + size(d.metadataUncertain) + size(d.jsonOperations) + Number(flag(d.closing)) },
        services: { rpcTimer: !flag(s.disposed), storeOpen: !flag(d.closed), catalogOpen: d.catalog !== undefined },
        cache: { completed: size(s.completed), expiredPins: size(s.expiredPins) } };
}

export function observeNativeActivity(input: unknown) {
    if (input === undefined) return null;
    const value = fields(input, ['lease', 'suspended']);
    if (typeof value.lease !== 'string') throw Error('Native activity lease shape changed.');
    return { lease: value.lease !== '', suspended: flag(value.suspended) };
}
const consoleCounts = ['references', 'readers', 'pins', 'pendingReaders', 'pendingPins', 'requests', 'exports'] as const;
export function observeNativeConsole(input: unknown) {
    const service = row(input), value = fields(service.snapshot, [...consoleCounts, 'transition', 'writer', 'closed']);
    for (const name of consoleCounts) count(value[name]);
    for (const name of ['transition', 'writer', 'closed']) flag(value[name]);
    return { snapshot: { ...value }, hasResources: flag(service.hasResources) };
}
export function assertNativeConsoleRetired(input: unknown) {
    const value = fields(input, [...consoleCounts, 'transition', 'writer', 'closed']);
    for (const name of consoleCounts) if (count(value[name]) !== 0) throw Error('Native console owner remains: ' + name);
    if (flag(value.transition) || flag(value.writer)) throw Error('Native console transition/writer remains.');
    flag(value.closed); // A journal that never opened does not need closed=true.
}
