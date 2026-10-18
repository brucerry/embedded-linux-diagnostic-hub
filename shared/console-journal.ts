import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    base64Bytes,
    bytesBase64,
    frameCrc,
    integer,
    isoTime,
    validId,
} from './capture-store';
import {
    consoleCompletion,
    consoleReady,
    consoleStep,
    sshInputBytes,
    type ConsoleCompletion,
    type SshInput,
} from './ssh-console';

export const CONSOLE_SCHEMA = 2 as const;
export type ConsolePhase = 'startup' | 'idle' | 'shutdown';
export type ConsoleCompletionReason =
    | 'prompt-observed'
    | 'ready'
    | 'idle-boundary'
    | 'closed'
    | 'cancelled'
    | 'timeout'
    | 'transport-error'
    | 'storage-error';
export interface ConsoleHeader {
    schema: 2;
    id: string;
    flowId: string;
    startedAt: string;
    receiveTimeSource: 'local-client' | 'gateway';
    target: { endpoint: string; username?: string };
    ready: ConsoleCompletion;
}
export type ConsoleSegment =
    | { kind: 'context'; phase: ConsolePhase }
    | {
          kind: 'command';
          runId: string;
          stepId: string;
          ordinal: number;
          name: string;
          input: Readonly<SshInput>;
          requestBase64: string;
          criterion: ConsoleCompletion;
      };
export interface ConsoleMatch {
    role: ConsoleCompletion['role'];
    literal: string;
}
export type ConsoleRecord =
    | {
          schema: 2;
          kind: 'segment-start';
          sequence: number;
          index: number;
          at: string;
          segment: ConsoleSegment;
          inputSent?: {
              preparation: number;
              contextIndex: number;
              disposition: 'write-dispatched';
          };
      }
    | {
          schema: 2;
          kind: 'preparation';
          sequence: number;
          index: number;
          at: string;
          segment: Extract<ConsoleSegment, { kind: 'command' }>;
      }
    | {
          schema: 2;
          kind: 'preparation-end';
          sequence: number;
          index: number;
          at: string;
          reason: 'cancelled' | 'timeout' | 'transport-error' | 'storage-error';
      }
    | {
          schema: 2;
          kind: 'observation';
          sequence: number;
          index: number;
          observation: number;
          stream: 'pty';
          origin: 'channel' | 'extended';
          receivedAt: string;
          offset: number;
          totalBytes: number;
          base64: string;
          crc32: string;
      }
    | {
          schema: 2;
          kind: 'segment-end';
          sequence: number;
          index: number;
          at: string;
          reason: ConsoleCompletionReason;
          match: ConsoleMatch | null;
      }
    | {
          schema: 2;
          kind: 'outcome';
          sequence: number;
          index: number;
          at: string;
          completion: Exclude<ConsoleCompletionReason, 'ready' | 'idle-boundary' | 'closed'>;
          exitCode: null;
          match: ConsoleMatch | null;
      };
export interface ConsoleCursor {
    records: number;
    bytes: number;
    observations: number;
    segments: number;
    active: null | { index: number; segment: ConsoleSegment };
    preparing: null | {
        sequence: number;
        index: number;
        segment: Extract<ConsoleSegment, { kind: 'command' }>;
    };
    pendingObservation: null | {
        observation: number;
        receivedAt: string;
        origin: 'channel' | 'extended';
        totalBytes: number;
        offset: number;
    };
    pendingOutcome: null | {
        index: number;
        criterion: ConsoleCompletion;
        reason: ConsoleCompletionReason;
        match: ConsoleMatch | null;
    };
}
export interface ConsoleSnapshot {
    schema: 2;
    header: ConsoleHeader;
    state: 'active' | 'complete' | 'incomplete';
    offset: number;
    records: number;
    bytes: number;
    observations: number;
    segments: number;
    finalizedAt: string | null;
    reason: string | null;
    observedBytes: number | null;
    failure: { code: import('./capture-store').CaptureFailureCode; message: string } | null;
    shellClosed: boolean;
}
/** Trusted gateway-local ownership proof, distinct from an absent remote journal close ACK. */
export interface GatewayConsoleDisposal {
    scope: 'gateway-operation-adapter';
    disposed: boolean;
    journalClosure: 'unacknowledged';
}
export interface ConsoleRepository {
    begin(input: Omit<ConsoleHeader, 'schema' | 'id'>): Promise<ConsoleSnapshot>;
    start(segment: ConsoleSegment, at: string): Promise<number>;
    /** A command start during idle persists preparation; only inputSent opens its output segment. */
    inputSent(at: string): Promise<void>;
    discardPreparation(
        reason: 'cancelled' | 'timeout' | 'transport-error' | 'storage-error',
        at: string,
    ): Promise<void>;
    observe(bytes: Uint8Array, receivedAt: string, origin: 'channel' | 'extended'): Promise<void>;
    end(reason: ConsoleCompletionReason, match: ConsoleMatch | null, at: string): Promise<void>;
    outcome(
        completion: Exclude<ConsoleCompletionReason, 'ready' | 'idle-boundary' | 'closed'>,
        match: ConsoleMatch | null,
        at: string,
    ): Promise<void>;
    finish(
        reason: 'complete' | 'cancelled' | 'timeout' | 'transport-error',
        observedBytes: number,
        shellClosed: true,
    ): Promise<ConsoleSnapshot>;
    fail(
        observedBytes: number | null,
        error: CaptureStorageError,
        shellClosed?: true,
    ): Promise<void>;
    close(): Promise<void>;
    readonly resourceClosed: boolean;
    readonly snapshot: ConsoleSnapshot | null;
}
function object(input: unknown, fields: readonly string[]) {
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).some(
            (k) =>
                typeof k !== 'string' ||
                !fields.includes(k) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(input, k)!, 'value'),
        )
    )
        throw new CaptureStorageError('invalid', 'Invalid console journal metadata.');
    return input as Record<string, unknown>;
}
function text(input: unknown, max: number, label: string) {
    if (
        typeof input !== 'string' ||
        !input ||
        input.length > max ||
        /[\x00-\x1f\x7f-\x9f]/.test(input) ||
        new TextEncoder().encode(input).length > max
    )
        throw new CaptureStorageError('invalid', 'Invalid console ' + label + '.');
    return input;
}
export function consoleHeader(input: unknown): ConsoleHeader {
    const v = object(input, [
        'schema',
        'id',
        'flowId',
        'startedAt',
        'receiveTimeSource',
        'target',
        'ready',
    ]);
    if (v.schema !== 2 || typeof v.id !== 'string')
        throw new CaptureStorageError('unsupported', 'Unsupported console journal schema.');
    validId(v.id);
    text(v.flowId, 128, 'flow');
    isoTime(v.startedAt as string);
    if (!['local-client', 'gateway'].includes(v.receiveTimeSource as string))
        throw new CaptureStorageError('invalid', 'Invalid console receive source.');
    const target = object(v.target, ['endpoint', 'username']);
    text(target.endpoint, 512, 'endpoint');
    if (target.username !== undefined) text(target.username, 128, 'username');
    return {
        schema: 2,
        id: v.id,
        flowId: v.flowId as string,
        startedAt: v.startedAt as string,
        receiveTimeSource: v.receiveTimeSource as ConsoleHeader['receiveTimeSource'],
        target: {
            endpoint: target.endpoint as string,
            ...(target.username === undefined ? {} : { username: target.username as string }),
        },
        ready: consoleReady(v.ready),
    };
}
export function consoleSegment(input: unknown): ConsoleSegment {
    const v = object(input, [
        'kind',
        'phase',
        'runId',
        'stepId',
        'ordinal',
        'name',
        'input',
        'requestBase64',
        'criterion',
    ]);
    if (v.kind === 'context') {
        object(v, ['kind', 'phase']);
        if (!['startup', 'idle', 'shutdown'].includes(v.phase as string))
            throw new CaptureStorageError('invalid', 'Invalid context phase.');
        return { kind: 'context', phase: v.phase as ConsolePhase };
    }
    if (v.kind !== 'command')
        throw new CaptureStorageError('invalid', 'Unknown console segment kind.');
    object(v, [
        'kind',
        'runId',
        'stepId',
        'ordinal',
        'name',
        'input',
        'requestBase64',
        'criterion',
    ]);
    text(v.runId, 128, 'run');
    text(v.stepId, 128, 'step');
    text(v.name, 256, 'name');
    integer(v.ordinal as number, 1, 20);
    const step = consoleStep(v.input, v.criterion),
        payload = sshInputBytes('console', { intent: step.intent, command: step.command });
    if (v.requestBase64 !== bytesBase64(payload))
        throw new CaptureStorageError(
            'integrity',
            'Console input bytes do not match explicit intent.',
        );
    return {
        kind: 'command',
        runId: v.runId as string,
        stepId: v.stepId as string,
        ordinal: v.ordinal as number,
        name: v.name as string,
        input: Object.freeze({ intent: step.intent, command: step.command }),
        requestBase64: v.requestBase64 as string,
        criterion: step.completion,
    };
}
function match(input: unknown, criterion: ConsoleCompletion): ConsoleMatch | null {
    if (input === null) return null;
    const v = object(input, ['role', 'literal']);
    if (
        v.role !== criterion.role ||
        typeof v.literal !== 'string' ||
        !criterion.literals.includes(v.literal)
    )
        throw new CaptureStorageError(
            'integrity',
            'Console completion does not match its frozen literal criterion.',
        );
    return { role: criterion.role, literal: v.literal };
}
export const newConsoleCursor = (): ConsoleCursor => ({
    records: 0,
    bytes: 0,
    observations: 0,
    segments: 0,
    active: null,
    preparing: null,
    pendingObservation: null,
    pendingOutcome: null,
});
/** One current segment/observation/outcome, independent of retained output/segment count. */
export function applyConsoleRecord(
    cursor: ConsoleCursor,
    input: unknown,
    header: ConsoleHeader,
): ConsoleRecord {
    const v = object(input, [
        'schema',
        'kind',
        'sequence',
        'index',
        'at',
        'segment',
        'observation',
        'stream',
        'origin',
        'receivedAt',
        'offset',
        'totalBytes',
        'base64',
        'crc32',
        'reason',
        'match',
        'completion',
        'exitCode',
        'inputSent',
    ]);
    if (v.schema !== 2 || v.sequence !== cursor.records)
        throw new CaptureStorageError('integrity', 'Console record sequence/schema differs.');
    integer(v.index as number);
    integer(cursor.records + 1);
    if (v.kind === 'preparation') {
        object(v, ['schema', 'kind', 'sequence', 'index', 'at', 'segment']);
        isoTime(v.at as string);
        const segment = consoleSegment(v.segment);
        if (
            segment.kind !== 'command' ||
            cursor.preparing ||
            cursor.pendingObservation ||
            cursor.pendingOutcome ||
            cursor.active?.segment.kind !== 'context' ||
            cursor.active.segment.phase !== 'idle' ||
            v.index !== cursor.segments
        )
            throw new CaptureStorageError(
                'integrity',
                'Command preparation requires persisted idle context.',
            );
        cursor.preparing = { sequence: cursor.records, index: v.index as number, segment };
        cursor.records++;
        return { ...v, segment } as unknown as ConsoleRecord;
    }
    if (v.kind === 'preparation-end') {
        object(v, ['schema', 'kind', 'sequence', 'index', 'at', 'reason']);
        isoTime(v.at as string);
        if (
            !cursor.preparing ||
            v.index !== cursor.preparing.index ||
            cursor.pendingObservation ||
            !['cancelled', 'timeout', 'transport-error', 'storage-error'].includes(
                v.reason as string,
            )
        )
            throw new CaptureStorageError('integrity', 'Invalid unsent command preparation end.');
        cursor.preparing = null;
        cursor.records++;
        return v as unknown as ConsoleRecord;
    }
    if (v.kind === 'segment-start') {
        object(v, ['schema', 'kind', 'sequence', 'index', 'at', 'segment', 'inputSent']);
        isoTime(v.at as string);
        if (v.inputSent !== undefined) {
            const sent = object(v.inputSent, ['preparation', 'contextIndex', 'disposition']);
            if (
                !cursor.preparing ||
                sent.preparation !== cursor.preparing.sequence ||
                sent.contextIndex !== cursor.active?.index ||
                sent.disposition !== 'write-dispatched' ||
                cursor.active?.segment.kind !== 'context' ||
                cursor.active.segment.phase !== 'idle' ||
                cursor.pendingObservation ||
                cursor.pendingOutcome ||
                v.index !== cursor.preparing.index ||
                JSON.stringify(consoleSegment(v.segment)) !==
                    JSON.stringify(cursor.preparing.segment)
            )
                throw new CaptureStorageError(
                    'integrity',
                    'Input-sent boundary differs from its durable preparation/context.',
                );
            cursor.active = null;
            cursor.preparing = null;
        }
        if (
            cursor.active ||
            cursor.preparing ||
            cursor.pendingOutcome ||
            cursor.pendingObservation ||
            v.index !== cursor.segments
        )
            throw new CaptureStorageError(
                'integrity',
                'Console segment boundary precedes persistence.',
            );
        cursor.active = { index: v.index as number, segment: consoleSegment(v.segment) };
        cursor.segments++;
        cursor.records++;
        return { ...v, segment: cursor.active.segment } as unknown as ConsoleRecord;
    }
    if (v.kind === 'observation') {
        object(v, [
            'schema',
            'kind',
            'sequence',
            'index',
            'observation',
            'stream',
            'origin',
            'receivedAt',
            'offset',
            'totalBytes',
            'base64',
            'crc32',
        ]);
        isoTime(v.receivedAt as string);
        if (
            !cursor.active ||
            cursor.active.index !== v.index ||
            v.stream !== 'pty' ||
            !['channel', 'extended'].includes(v.origin as string) ||
            v.observation !== cursor.observations
        )
            throw new CaptureStorageError('integrity', 'Invalid PTY observation identity.');
        integer(v.totalBytes as number, 1, CAPTURE_STORAGE.backlogBytes);
        integer(v.offset as number, 0, Number(v.totalBytes) - 1);
        if (
            typeof v.base64 !== 'string' ||
            v.base64.length > Math.ceil(CAPTURE_STORAGE.frameBytes / 3) * 4
        )
            throw new CaptureStorageError('invalid', 'Oversized PTY frame.');
        const bytes = base64Bytes(v.base64),
            pending = cursor.pendingObservation;
        if (
            !bytes.length ||
            bytes.length > CAPTURE_STORAGE.frameBytes ||
            bytes.length + Number(v.offset) > Number(v.totalBytes) ||
            v.crc32 !== frameCrc(bytes) ||
            (pending
                ? pending.offset !== v.offset ||
                  pending.totalBytes !== v.totalBytes ||
                  pending.receivedAt !== v.receivedAt ||
                  pending.origin !== v.origin
                : v.offset !== 0)
        )
            throw new CaptureStorageError('integrity', 'PTY frame range/integrity differs.');
        const offset = Number(v.offset) + bytes.length;
        cursor.bytes += bytes.length;
        integer(cursor.bytes);
        cursor.pendingObservation =
            offset === v.totalBytes
                ? null
                : {
                      observation: v.observation as number,
                      receivedAt: v.receivedAt as string,
                      origin: v.origin as 'channel' | 'extended',
                      totalBytes: v.totalBytes as number,
                      offset,
                  };
        if (!cursor.pendingObservation) cursor.observations++;
        cursor.records++;
        return v as unknown as ConsoleRecord;
    }
    if (v.kind === 'segment-end') {
        object(v, ['schema', 'kind', 'sequence', 'index', 'at', 'reason', 'match']);
        isoTime(v.at as string);
        const active = cursor.active;
        if (
            !active ||
            cursor.preparing ||
            active.index !== v.index ||
            cursor.pendingObservation ||
            ![
                'prompt-observed',
                'ready',
                'idle-boundary',
                'closed',
                'cancelled',
                'timeout',
                'transport-error',
                'storage-error',
            ].includes(v.reason as string)
        )
            throw new CaptureStorageError('integrity', 'Invalid console segment seal.');
        let matched: ConsoleMatch | null = null;
        if (active.segment.kind === 'command') {
            if (['ready', 'idle-boundary', 'closed'].includes(v.reason as string))
                throw new CaptureStorageError(
                    'invalid',
                    'Command completion cannot be context completion.',
                );
            matched = match(v.match, active.segment.criterion);
            if ((v.reason === 'prompt-observed') !== (matched !== null))
                throw new CaptureStorageError(
                    'integrity',
                    'Prompt completion evidence is missing or invented.',
                );
            cursor.pendingOutcome = {
                index: active.index,
                criterion: active.segment.criterion,
                reason: v.reason as ConsoleCompletionReason,
                match: matched,
            };
        } else {
            if (v.reason === 'prompt-observed')
                throw new CaptureStorageError(
                    'invalid',
                    'Context cannot become a command outcome.',
                );
            if (v.reason === 'ready') {
                if (active.segment.phase !== 'startup')
                    throw new CaptureStorageError(
                        'invalid',
                        'Only startup context can establish readiness.',
                    );
                matched = match(v.match, header.ready);
                if (!matched)
                    throw new CaptureStorageError(
                        'integrity',
                        'Missing initial readiness evidence.',
                    );
            } else if (v.match !== null)
                throw new CaptureStorageError('invalid', 'Unexpected context match metadata.');
        }
        cursor.active = null;
        cursor.records++;
        return { ...v, match: matched } as unknown as ConsoleRecord;
    }
    if (v.kind === 'outcome') {
        object(v, ['schema', 'kind', 'sequence', 'index', 'at', 'completion', 'exitCode', 'match']);
        isoTime(v.at as string);
        const pending = cursor.pendingOutcome;
        if (
            !pending ||
            cursor.active ||
            pending.index !== v.index ||
            v.exitCode !== null ||
            v.completion !== pending.reason ||
            JSON.stringify(match(v.match, pending.criterion)) !== JSON.stringify(pending.match)
        )
            throw new CaptureStorageError(
                'integrity',
                'Console outcome must follow its sealed command without an invented exit.',
            );
        cursor.pendingOutcome = null;
        cursor.records++;
        return v as unknown as ConsoleRecord;
    }
    throw new CaptureStorageError('invalid', 'Unknown console journal record.');
}
export function completeConsoleCursor(cursor: ConsoleCursor) {
    if (cursor.active || cursor.preparing || cursor.pendingOutcome || cursor.pendingObservation)
        throw new CaptureStorageError(
            'integrity',
            'Console still has unsealed context, raw observations or outcomes.',
        );
}
