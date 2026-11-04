import {projectProbeObservation} from './loopback-probe-observation.ts';

export const SNAPSHOT_WAIT_MS = 15_000;
const responseFields = ['snapshot-status-1xx','snapshot-status-2xx','snapshot-status-3xx',
    'snapshot-status-4xx','snapshot-status-5xx','snapshot-status-other','snapshot-finished','snapshot-finish-failed'] as const;
const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Pure reads of fixed metadata. Polling this never starts or retries device work.
export function snapshotCompletion(input: unknown) {
    const source=object(input),diagnostic=object(source.diagnostic),passive=object(diagnostic.passive),counts=object(passive.counts);
    if (diagnostic.overflow !== false || passive.failed !== false || passive.stopped !== false ||
        responseFields.some(key=>!Number.isSafeInteger(counts[key]) || (counts[key] as number)<0 || (counts[key] as number)>65535)) return 'invalid-observation';
    const n=(key:typeof responseFields[number])=>counts[key] as number;
    if (n('snapshot-status-1xx') || n('snapshot-status-3xx') || n('snapshot-status-4xx') || n('snapshot-status-5xx') || n('snapshot-status-other') || n('snapshot-finish-failed')) return 'snapshot-error';
    if (n('snapshot-status-2xx')>1 || n('snapshot-finished')>1) return 'unexpected-snapshot';
    if (source.commandCounts===null) return 'pending';
    const commands=projectProbeObservation([{probeCommands:source.commandCounts}]);
    if (!commands || commands.unproved) return 'invalid-observation';
    if (commands.timedOut || commands.failed) return 'probe-error';
    if (commands.started>52) return 'unexpected-snapshot';
    if (n('snapshot-finished')===1) {
        if (n('snapshot-status-2xx')!==1 || commands.started!==52 || commands.completed!==52 || commands.pending!==0) return 'invalid-observation';
        return 'complete';
    }
    return 'pending';
}
