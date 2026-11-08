import { validateCapture, type AutomationRecord } from './automation';
import { CaptureStorageError, isoTime } from './capture-store';
import { validateScheduleMetadata } from './automation-time';

export type AutomationOutcome = Pick<
    AutomationRecord,
    | 'id'
    | 'ordinal'
    | 'completedAt'
    | 'localZone'
    | 'durationMs'
    | 'deviceTime'
    | 'execution'
    | 'completion'
    | 'exitCode'
    | 'termination'
    | 'truncated'
>;
export const OUTCOME_BYTES = 8192;
const fields = [
    'id',
    'ordinal',
    'completedAt',
    'localZone',
    'durationMs',
    'deviceTime',
    'execution',
    'completion',
    'exitCode',
    'termination',
    'truncated',
];
export function automationOutcome(input: unknown): AutomationOutcome {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new CaptureStorageError('invalid', 'Invalid command outcome.');
    const value = input as AutomationOutcome;
    if (
        Object.keys(value).some((key) => !fields.includes(key)) ||
        !/^[a-f0-9]{32}$/.test(value.id) ||
        !Number.isInteger(value.ordinal) ||
        value.ordinal < 1 ||
        value.ordinal > 20 ||
        typeof value.localZone !== 'string' ||
        value.localZone.length > 128 ||
        !Number.isFinite(value.durationMs) ||
        value.durationMs < 0 ||
        value.durationMs > Number.MAX_SAFE_INTEGER
    )
        throw new CaptureStorageError('invalid', 'Invalid command outcome metadata.');
    isoTime(value.completedAt);
    validateCapture({
        stdout: '',
        stderr: '',
        chunks: [],
        completion: value.completion,
        exitCode: value.exitCode,
        truncated: value.truncated,
        ...(value.termination ? { termination: value.termination } : {}),
    });
    if (value.deviceTime !== null) {
        const d = value.deviceTime;
        if (
            !d ||
            Object.keys(d).some(
                (key) => !['value', 'source', 'zone', 'observedAt'].includes(key),
            ) ||
            typeof d.value !== 'string' ||
            d.value.length > 256 ||
            typeof d.source !== 'string' ||
            d.source.length > 512 ||
            typeof d.zone !== 'string' ||
            d.zone.length > 128
        )
            throw new CaptureStorageError('invalid', 'Invalid device-time observation.');
        isoTime(d.observedAt);
    }
    if (value.execution) {
        const x = value.execution;
        if (
            Object.keys(x).some(
                (key) =>
                    ![
                        'timeoutSeconds',
                        'repeatSeconds',
                        'stepDelaySeconds',
                        'scheduledStart',
                        'serial',
                    ].includes(key),
            ) ||
            !Number.isFinite(x.timeoutSeconds) ||
            x.timeoutSeconds < 1 ||
            x.timeoutSeconds > 300 ||
            !(
                x.repeatSeconds === null ||
                (Number.isFinite(x.repeatSeconds) &&
                    x.repeatSeconds >= 0 &&
                    x.repeatSeconds <= 86400)
            ) ||
            !Number.isFinite(x.stepDelaySeconds) ||
            x.stepDelaySeconds < 0 ||
            x.stepDelaySeconds > 86400
        )
            throw new CaptureStorageError('invalid', 'Invalid command execution metadata.');
        if (x.scheduledStart) {
            const s = x.scheduledStart;
            if (
                Object.keys(s).some(
                    (key) =>
                        ![
                            'epochMs',
                            'clock',
                            'zone',
                            'wallTime',
                            'utcOffset',
                            'source',
                            'uncertaintyMs',
                        ].includes(key),
                ) ||
                !Number.isFinite(s.epochMs) ||
                s.epochMs < 0 ||
                s.epochMs > 253402300799999 ||
                !['local', 'device'].includes(s.clock) ||
                (s.source !== undefined &&
                    (typeof s.source !== 'string' || s.source.length > 512)) ||
                (s.uncertaintyMs !== undefined &&
                    (!Number.isFinite(s.uncertaintyMs) ||
                        s.uncertaintyMs < 0 ||
                        s.uncertaintyMs > 30000))
            )
                throw new CaptureStorageError('invalid', 'Invalid scheduled execution evidence.');
            validateScheduleMetadata(s);
        }
        if (
            x.serial &&
            (Object.keys(x.serial).some(
                (key) => !['lineEnding', 'prompt', 'timestampPrefix'].includes(key),
            ) ||
                !['none', 'CR', 'LF', 'CRLF'].includes(x.serial.lineEnding) ||
                typeof x.serial.prompt !== 'string' ||
                x.serial.prompt.length > 256 ||
                typeof x.serial.timestampPrefix !== 'string' ||
                x.serial.timestampPrefix.length > 128)
        )
            throw new CaptureStorageError('invalid', 'Invalid Serial execution metadata.');
    }
    if (
        value.termination &&
        Object.keys(value.termination).some(
            (key) => !['signal', 'coreDumped', 'message', 'truncated'].includes(key),
        )
    )
        throw new CaptureStorageError('invalid', 'Unknown termination evidence field.');
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).length > OUTCOME_BYTES)
        throw new CaptureStorageError(
            'invalid',
            'Command outcome metadata exceeded its bounded record.',
        );
    return JSON.parse(encoded) as AutomationOutcome;
}
export function outcomeOf(row: AutomationRecord): AutomationOutcome {
    const value: Record<string, unknown> = {};
    for (const field of fields)
        if ((row as unknown as Record<string, unknown>)[field] !== undefined)
            value[field] = (row as unknown as Record<string, unknown>)[field];
    return automationOutcome(value);
}
