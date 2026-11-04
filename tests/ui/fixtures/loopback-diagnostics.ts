// Pure test evidence projection. Never retain request bodies, error text or credentials.
export const passiveStages = [
    'snapshot-status-1xx', 'snapshot-status-2xx', 'snapshot-status-3xx',
    'snapshot-status-4xx', 'snapshot-status-5xx', 'snapshot-status-other',
    'snapshot-finished', 'snapshot-finish-failed',
    'history-worker-created', 'history-worker-closed',
] as const;
export type PassiveStage = (typeof passiveStages)[number];
const stages = [
    'allocated', 'page-ready', 'fingerprint-verified', 'connect-requested',
    'dialog-closed', 'terminal-opened', 'flow-started', 'exports-reached',
    'case-failure', 'finally', 'cleanup-started', 'cleanup-failed',
    ...passiveStages,
] as const;
type Stage = (typeof stages)[number];
const ownerCounters = ['sshClients', 'readyClients', 'acceptedClients', 'probeExecutions',
    'fileHandles', 'failedFileCloses'] as const;
const ownerFlags = ['sshListening', 'sshCloseAcknowledged', 'gatewayCloseAcknowledged',
    'journalFailed'] as const;
const gatewayCounters = ['cleanupTimers', 'requestTasks', 'httpSockets', 'httpResponses',
    'httpBodyReaders', 'pendingConnections', 'sessions', 'inFlight', 'ownedSessions',
    'retiringSessions', 'connectionAttempts'] as const;
const failureCodes = ['retirement-rejected', 'resource-unacknowledged', 'journal-unacknowledged'] as const;
const counter = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 65535) : null;
const flag = (value: unknown) => typeof value === 'boolean' ? value : null;
const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
function resources(input: unknown) {
    const source = object(input), gateway = object(source.gateway);
    return {
        owner: Object.fromEntries([
            ...ownerCounters.map(key => [key, counter(source[key])]),
            ...ownerFlags.map(key => [key, flag(source[key])]),
        ]),
        gateway: Object.fromEntries([
            ['serverListening', flag(gateway.serverListening)],
            ...gatewayCounters.map(key => [key, counter(gateway[key])]),
        ]),
    };
}

export function createLoopbackDiagnostics() {
    const events: Stage[] = [];
    let overflow = false;
    let modal: { visible: boolean; busy: boolean } | null = null;
    let firstCleanupFailure: Record<string, unknown> | null = null;
    let firstCaseFailure: ReturnType<typeof resources> | null = null;
    const passive = {counts: Object.fromEntries(passiveStages.map(key => [key, 0])) as Record<PassiveStage, number>, failed: false, stopped: false};
    function stage(value: Stage) {
        if (!stages.includes(value)) return;
        if (events.length === 32) { overflow = true; return; }
        events.push(value);
    }
    function cleanupFailure(input: unknown, codes: readonly string[]) {
        if (firstCleanupFailure) return;
        firstCleanupFailure = {
            codes: failureCodes.filter(code => codes.includes(code)),
            ...resources(input),
        };
        stage('cleanup-failed');
    }
    function snapshot() {
        // Detach all returned arrays/objects so callers cannot erase the first failure.
        return JSON.parse(JSON.stringify({schema: 1, stages: events, overflow, modal, firstCaseFailure, firstCleanupFailure, passive}));
    }
    return { stage, cleanupFailure, snapshot,
        observe: (value: PassiveStage) => {
            if (!passiveStages.includes(value)) { passive.failed = true; return; }
            passive.counts[value] = Math.min(65535, passive.counts[value] + 1);
            stage(value);
        },
        observerFailed: () => { passive.failed = true; },
        observerStopped: () => { passive.stopped = true; },
        observerOverflow: () => { overflow = true; },
        caseFailure: (input: unknown) => { firstCaseFailure ??= resources(input); },
        modalState: (visible: boolean, busy: boolean) => { modal = {visible, busy}; } };
}

// Independent receipt projection; unknown object fields are never forwarded.
export function sanitizeLoopbackDiagnostics(input: unknown) {
    const source = object(input), observer = createLoopbackDiagnostics();
    if (source.schema !== 1 || !Array.isArray(source.stages) || source.stages.length > 32) return null;
    for (const value of source.stages) {
        if (typeof value !== 'string' || !stages.includes(value as Stage)) return null;
        observer.stage(value as Stage);
    }
    const modal = object(source.modal);
    if (typeof modal.visible === 'boolean' && typeof modal.busy === 'boolean')
        observer.modalState(modal.visible, modal.busy);
    if (source.firstCaseFailure !== null && source.firstCaseFailure !== undefined) {
        const first = object(source.firstCaseFailure);
        observer.caseFailure({...object(first.owner), gateway: first.gateway});
    }
    if (source.firstCleanupFailure !== null && source.firstCleanupFailure !== undefined) {
        const first = object(source.firstCleanupFailure);
        if (!Array.isArray(first.codes) || first.codes.length > 3 ||
            first.codes.some(code => !failureCodes.includes(code as typeof failureCodes[number]))) return null;
        observer.cleanupFailure({...object(first.owner), gateway: first.gateway}, first.codes);
    }
    const result = observer.snapshot();
    const passive = object(source.passive), counts = object(passive.counts);
    if (typeof passive.failed !== 'boolean' || typeof passive.stopped !== 'boolean' ||
        passiveStages.some(key => typeof counts[key] !== 'number' || !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0 || (counts[key] as number) > 65535)) return null;
    result.passive = {counts: Object.fromEntries(passiveStages.map(key => [key, counts[key]])), failed: passive.failed, stopped: passive.stopped};
    // Projection must preserve the recorded order rather than append another failure event.
    result.stages = [...source.stages];
    result.overflow = source.overflow === true;
    return result;
}
