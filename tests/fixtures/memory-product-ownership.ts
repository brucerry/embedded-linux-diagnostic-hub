/** Private, read-only projections of the exact source-bound lifetime fields. */
type Row = Record<string, unknown>;
type Details = Record<string, number | boolean>;
export interface Custody {
    producer: number;
    writer: number;
    reader: number;
    ack: number;
    cleanup: number;
    details: Details;
}
const empty = (): Custody => ({ producer: 0, writer: 0, reader: 0, ack: 0, cleanup: 0, details: {} });
export function probeFields(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Private ownership observation is not an object.');
    const row = value as Row;
    for (const key of keys)
        if (!Object.hasOwn(row, key)) throw Error('Private ownership field absent: ' + key);
    return row;
}
function flag(row: Row, key: string): boolean {
    if (typeof row[key] !== 'boolean') throw Error('Private ownership flag changed: ' + key);
    return row[key] as boolean;
}
function count(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
        throw Error('Private ownership count changed.');
    return value as number;
}
function promise(value: unknown, optional = false) {
    if (value === undefined && optional) return false;
    if (!value || typeof (value as Promise<unknown>).then !== 'function')
        throw Error('Private ownership promise absent.');
    return true;
}
function capability(value: unknown) {
    const row = probeFields(value, ['id', 'connection', 'capability']);
    if (typeof row.id !== 'string' || !row.id || typeof row.connection !== 'string' ||
        !row.connection || typeof row.capability !== 'string' || !/^[a-f0-9]{64}$/.test(row.capability))
        throw Error('Private SSH capability shape changed.');
    return row;
}

export function serialAutomationCustody(value: unknown): Custody {
    if (value === undefined) return empty();
    const row = probeFields(value, ['port', 'writer', 'generation', 'retirement', 'acknowledge',
        'finishing', 'retired', 'releaseRequested', 'closeRequested', 'closed', 'closeFailed']);
    if (!row.port || !row.writer || typeof row.acknowledge !== 'function')
        throw Error('Private Serial owner shape changed.');
    count(row.generation); promise(row.retirement);
    for (const key of ['finishing', 'retired', 'releaseRequested', 'closeRequested', 'closed', 'closeFailed']) flag(row, key);
    let pendingWrite = false, rejectedWrite = false, writeSettled = false, retainedBreak = false;
    if (row.write !== undefined) {
        const write = probeFields(row.write, ['task', 'settled', 'failed']);
        promise(write.task);
        writeSettled = flag(write, 'settled');
        pendingWrite = !writeSettled;
        rejectedWrite = flag(write, 'failed');
        if (write.retainedReason !== undefined && typeof write.retainedReason !== 'string')
            throw Error('Private Serial retained reason shape changed.');
        retainedBreak = typeof write.retainedReason === 'string';
    }
    return { ...empty(), producer: 1, writer: Number(pendingWrite),
        cleanup: Number(!row.retired || row.closeRequested && !row.closed || row.closeFailed),
        details: { pendingWrite, rejectedWrite, writeSettled, retainedBreak,
            retirementAcknowledged: row.retired as boolean, closeRequested: row.closeRequested as boolean,
            closeAcknowledged: row.closed as boolean, closeFailed: row.closeFailed as boolean } };
}

export function runnerCustody(value: unknown): Custody {
    const row = probeFields(value, ['active', 'controller', 'cleanup', 'cleanupRetry', 'executing']);
    const active = promise(row.active, true), retry = promise(row.cleanupRetry, true);
    flag(row, 'executing');
    let sshCleanup = false;
    if (row.cleanup !== undefined) {
        const cleanup = probeFields(row.cleanup, ['retry', 'release', 'label']);
        if (typeof cleanup.retry !== 'function' || typeof cleanup.release !== 'function' ||
            typeof cleanup.label !== 'string') throw Error('Private runner cleanup shape changed.');
        sshCleanup = cleanup.label === 'SSH';
    }
    return { ...empty(), producer: Number(active) + Number(row.executing),
        cleanup: Number(row.cleanup !== undefined) + Number(retry),
        details: { controller: Number(Boolean(row.controller)), sshCleanup, retryPending: retry } };
}

export function sshClientCustody(value: unknown): Custody {
    const row = probeFields(value, ['executing', 'owner', 'startUncertain']);
    const executing = promise(row.executing, true), uncertain = flag(row, 'startUncertain');
    if (row.owner !== undefined) capability(row.owner);
    return { ...empty(), producer: Number(executing || row.owner !== undefined), cleanup: Number(uncertain),
        details: { executing, capabilityHeld: row.owner !== undefined, startUncertain: uncertain } };
}

export function sshHostCustody(value: unknown): Custody {
    const row = probeFields(value, ['state', 'retiring', 'finalizedOwner', 'shutdownTask']);
    if (!(row.retiring instanceof Set)) throw Error('Private SSH retiring inventory changed.');
    const states = new Set<unknown>(row.retiring);
    if (row.state !== undefined) states.add(row.state);
    let readers = 0, acks = 0, producers = 0, pendingDataBytes = 0;
    for (const value of states) {
        const state = probeFields(value, ['runningDone', 'reading']);
        producers += Number(!flag(state, 'runningDone'));
        readers += Number(flag(state, 'reading'));
        if (state.ack !== undefined) { promise(probeFields(state.ack, ['promise']).promise); acks++; }
        if (state.data !== undefined) pendingDataBytes += count(probeFields(state.data, ['totalBytes']).totalBytes);
    }
    count(pendingDataBytes);
    if (row.finalizedOwner !== undefined) {
        const receipt = capability(row.finalizedOwner);
        if (!['local-client', 'gateway'].includes(receipt.source as string))
            throw Error('Private SSH receipt source changed.');
    }
    const shutdown = promise(row.shutdownTask, true);
    return { ...empty(), producer: states.size, reader: readers, ack: acks,
        cleanup: row.retiring.size + Number(shutdown),
        details: { producers, pendingDataBytes, retirementReceipt: Number(row.finalizedOwner !== undefined),
            currentStates: Number(row.state !== undefined), retiringStates: row.retiring.size, shutdownPending: shutdown } };
}

export function activityReleaseCustody(value: unknown): Custody {
    const row = probeFields(value, ['attempts']);
    if (!(row.attempts instanceof Set)) throw Error('Private activity release inventory changed.');
    let releasePending = 0, resumePending = 0, failed = 0, tasks = 0, acknowledged = 0;
    for (const value of row.attempts) {
        const attempt = probeFields(value, ['release', 'resumes', 'acknowledged', 'transportRetired', 'retired', 'resumed', 'failed']);
        if (typeof attempt.release !== 'function' || !Array.isArray(attempt.resumes) ||
            !attempt.resumes.every(fn => typeof fn === 'function'))
            throw Error('Private activity continuation shape changed.');
        for (const key of ['acknowledged', 'transportRetired', 'retired', 'failed']) flag(attempt, key);
        const resumed = count(attempt.resumed);
        if (resumed > attempt.resumes.length) throw Error('Private activity resume cursor changed.');
        acknowledged += Number(attempt.acknowledged);
        releasePending += Number(!attempt.acknowledged);
        resumePending += attempt.resumes.length - resumed;
        failed += Number(attempt.failed);
        tasks += Number(promise(attempt.task, true));
    }
    return { ...empty(), cleanup: row.attempts.size,
        details: { attempts: row.attempts.size, releasePending, resumePending, failed, tasks, acknowledged } };
}

export function browserExportCustody(value: unknown) {
    const row = probeFields(value, ['active', 'rpc', 'helpers', 'busyHelpers', 'connectedHelpers']);
    for (const key of ['active', 'rpc', 'helpers', 'busyHelpers', 'connectedHelpers']) count(row[key]);
    if ((row.active as number) > 4 || (row.helpers as number) > 4 ||
        (row.busyHelpers as number) > (row.helpers as number) ||
        (row.connectedHelpers as number) > (row.helpers as number))
        throw Error('Private browser export bound changed.');
    return { export: row.active as number, rpc: row.rpc as number };
}
