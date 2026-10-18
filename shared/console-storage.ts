import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    base64Bytes,
    bytesBase64,
    integer,
    isoTime,
    validId,
} from './capture-store';
import { streamObject } from './ssh-stream-rpc';
import {
    consoleHeader,
    consoleSegment,
    type ConsoleHeader,
    type ConsoleMatch,
    type ConsoleRepository,
    type ConsoleSnapshot,
    type ConsoleRecord,
} from './console-journal';

export type ConsoleRead =
    { kind: 'metadata'; capture: ConsoleSnapshot } | { kind: 'record'; record: ConsoleRecord };
export interface ConsoleArchive {
    pin(): Promise<{ release(): Promise<void> }>;
    list(
        after?: string,
        limit?: number,
    ): Promise<{ captures: ConsoleSnapshot[]; next: string | null; mode: 'scan' | 'indexed' }>;
    read(id: string): AsyncIterable<ConsoleRead>;
    delete(id: string): Promise<void>;
}
const snapshotFields = [
    'schema',
    'header',
    'state',
    'offset',
    'records',
    'bytes',
    'observations',
    'segments',
    'finalizedAt',
    'reason',
    'observedBytes',
    'failure',
    'shellClosed',
];
const failures = [
    'quota',
    'permission',
    'io',
    'unsupported',
    'busy',
    'invalid',
    'integrity',
    'backlog',
];
export function consoleSnapshot(input: unknown): ConsoleSnapshot {
    const v = streamObject(input, snapshotFields);
    if (
        snapshotFields.some((k) => !Object.hasOwn(v, k)) ||
        v.schema !== 2 ||
        !['active', 'complete', 'incomplete'].includes(v.state as string) ||
        typeof v.shellClosed !== 'boolean'
    )
        throw new CaptureStorageError('integrity', 'Invalid console snapshot.');
    const header = consoleHeader(v.header);
    for (const key of ['offset', 'records', 'bytes', 'observations', 'segments'])
        integer(v[key] as number);
    if (v.observedBytes !== null) integer(v.observedBytes as number, v.bytes as number);
    if (v.finalizedAt !== null) isoTime(v.finalizedAt as string);
    if (v.reason !== null && (typeof v.reason !== 'string' || v.reason.length > 128))
        throw Error('Invalid console reason.');
    if (v.failure !== null) {
        const failure = streamObject(v.failure, ['code', 'message']);
        if (
            !failures.includes(failure.code as string) ||
            typeof failure.message !== 'string' ||
            failure.message.length > 512
        )
            throw Error('Invalid console failure evidence.');
    }
    if (
        v.state === 'complete' &&
        (!v.shellClosed ||
            v.reason !== 'complete' ||
            v.finalizedAt === null ||
            v.failure !== null ||
            v.observedBytes !== v.bytes)
    )
        throw new CaptureStorageError(
            'integrity',
            'Console completion lacks durable byte/cleanup evidence.',
        );
    return { ...v, header } as unknown as ConsoleSnapshot;
}
export type ConsoleWrite =
    | { op: 'input-sent'; at: string }
    | {
          op: 'discard-preparation';
          reason: 'cancelled' | 'timeout' | 'transport-error' | 'storage-error';
          at: string;
      }
    | { op: 'begin'; header: Omit<ConsoleHeader, 'schema' | 'id'> }
    | { op: 'start'; segment: Parameters<ConsoleRepository['start']>[0]; at: string }
    | { op: 'observe'; base64: string; receivedAt: string; origin: 'channel' | 'extended' }
    | {
          op: 'end';
          reason: Parameters<ConsoleRepository['end']>[0];
          match: ConsoleMatch | null;
          at: string;
      }
    | {
          op: 'outcome';
          completion: Parameters<ConsoleRepository['outcome']>[0];
          match: ConsoleMatch | null;
          at: string;
      }
    | {
          op: 'finish';
          reason: Parameters<ConsoleRepository['finish']>[0];
          observedBytes: number;
          shellClosed: true;
      }
    | {
          op: 'fail';
          observedBytes: number | null;
          error: { code: CaptureStorageError['code']; message: string };
          shellClosed?: true;
      }
    | { op: 'close' };
export type ConsoleWriteReply = {
    snapshot: ConsoleSnapshot | null;
    value: number | null;
    closed: boolean;
};
const fields: Record<ConsoleWrite['op'], string[]> = {
    'input-sent': ['at'],
    'discard-preparation': ['reason', 'at'],
    begin: ['header'],
    start: ['segment', 'at'],
    observe: ['base64', 'receivedAt', 'origin'],
    end: ['reason', 'match', 'at'],
    outcome: ['completion', 'match', 'at'],
    finish: ['reason', 'observedBytes', 'shellClosed'],
    fail: ['observedBytes', 'error', 'shellClosed'],
    close: [],
};
function checkedMatch(input: unknown) {
    if (input === null) return;
    const v = streamObject(input, ['role', 'literal']);
    if (
        !['shell-prompt', 'intermediate-input-prompt'].includes(v.role as string) ||
        typeof v.literal !== 'string' ||
        !v.literal.trim() ||
        v.literal.length > 256 ||
        /[\x00-\x1f\x7f-\x9f]/.test(v.literal)
    )
        throw Error('Invalid console match.');
}
export function consoleWriteRequest(input: unknown): ConsoleWrite {
    const v = streamObject(input, ['op', ...new Set(Object.values(fields).flat())]);
    if (typeof v.op !== 'string' || !Object.hasOwn(fields, v.op))
        throw Error('Unsupported console storage operation.');
    const keys = fields[v.op as ConsoleWrite['op']];
    streamObject(v, ['op', ...keys]);
    if (keys.some((k) => k !== 'shellClosed' && !Object.hasOwn(v, k)))
        throw Error('Missing console storage field.');
    switch (v.op) {
        case 'input-sent':
            isoTime(v.at as string);
            break;
        case 'discard-preparation':
            isoTime(v.at as string);
            if (
                !['cancelled', 'timeout', 'transport-error', 'storage-error'].includes(
                    v.reason as string,
                )
            )
                throw Error('Invalid unsent preparation completion.');
            break;
        case 'begin': {
            const h = streamObject(v.header, [
                'flowId',
                'startedAt',
                'receiveTimeSource',
                'target',
                'ready',
            ]);
            consoleHeader({ ...h, schema: 2, id: '00000000-0000-4000-8000-000000000000' });
            break;
        }
        case 'start':
            consoleSegment(v.segment);
            isoTime(v.at as string);
            break;
        case 'observe': {
            if (
                typeof v.base64 !== 'string' ||
                v.base64.length > Math.ceil(CAPTURE_STORAGE.backlogBytes / 3) * 4 ||
                !['channel', 'extended'].includes(v.origin as string)
            )
                throw Error('Invalid bounded PTY observation.');
            integer(base64Bytes(v.base64).length, 1, CAPTURE_STORAGE.backlogBytes);
            isoTime(v.receivedAt as string);
            break;
        }
        case 'end':
        case 'outcome': {
            const reason = v.op === 'end' ? v.reason : v.completion;
            if (
                !(
                    v.op === 'end'
                        ? [
                              'prompt-observed',
                              'ready',
                              'idle-boundary',
                              'closed',
                              'cancelled',
                              'timeout',
                              'transport-error',
                              'storage-error',
                          ]
                        : [
                              'prompt-observed',
                              'cancelled',
                              'timeout',
                              'transport-error',
                              'storage-error',
                          ]
                ).includes(reason as string)
            )
                throw Error('Invalid console completion.');
            checkedMatch(v.match);
            isoTime(v.at as string);
            break;
        }
        case 'finish':
            if (
                !['complete', 'cancelled', 'timeout', 'transport-error'].includes(
                    v.reason as string,
                ) ||
                v.shellClosed !== true
            )
                throw Error('Console cleanup was not acknowledged.');
            integer(v.observedBytes as number);
            break;
        case 'fail': {
            if (v.observedBytes !== null) integer(v.observedBytes as number);
            if (v.shellClosed !== undefined && v.shellClosed !== true)
                throw Error('Invalid console cleanup evidence.');
            const error = streamObject(v.error, ['code', 'message']);
            if (
                !failures.includes(error.code as string) ||
                typeof error.message !== 'string' ||
                error.message.length > 512
            )
                throw Error('Invalid console failure.');
            break;
        }
    }
    return structuredClone(v) as unknown as ConsoleWrite;
}
export function consoleWriteReply(input: unknown): ConsoleWriteReply {
    const v = streamObject(input, ['snapshot', 'value', 'closed']);
    if (
        typeof v.closed !== 'boolean' ||
        (v.value !== null && (!Number.isSafeInteger(v.value) || Number(v.value) < 0))
    )
        throw Error('Invalid console storage acknowledgement.');
    return {
        snapshot: v.snapshot === null ? null : consoleSnapshot(v.snapshot),
        value: v.value as number | null,
        closed: v.closed,
    };
}
export async function dispatchConsoleWrite(
    store: ConsoleRepository,
    input: unknown,
): Promise<ConsoleWriteReply> {
    const request = consoleWriteRequest(input);
    let value: number | null = null;
    switch (request.op) {
        case 'input-sent':
            await store.inputSent(request.at);
            break;
        case 'discard-preparation':
            await store.discardPreparation(request.reason, request.at);
            break;
        case 'begin':
            await store.begin(request.header);
            break;
        case 'start':
            value = await store.start(request.segment, request.at);
            break;
        case 'observe':
            await store.observe(base64Bytes(request.base64), request.receivedAt, request.origin);
            break;
        case 'end':
            await store.end(request.reason, request.match, request.at);
            break;
        case 'outcome':
            await store.outcome(request.completion, request.match, request.at);
            break;
        case 'finish':
            await store.finish(request.reason, request.observedBytes, true);
            break;
        case 'fail':
            await store.fail(
                request.observedBytes,
                new CaptureStorageError(request.error.code, request.error.message),
                request.shellClosed,
            );
            break;
        case 'close':
            await store.close();
            break;
    }
    return consoleWriteReply({ snapshot: store.snapshot, value, closed: store.resourceClosed });
}
/** Same bounded durable operation contract across trusted native storage and the browser credit pump. */
export class RemoteConsoleRepository implements ConsoleRepository {
    private current: ConsoleSnapshot | null = null;
    private closed = false;
    private pending = false;
    private expectedHeader?: Omit<ConsoleHeader, 'schema' | 'id'>;
    private broken?: unknown;
    constructor(private rpc: (input: ConsoleWrite) => Promise<unknown>) {}
    get snapshot() {
        return this.current ? structuredClone(this.current) : null;
    }
    get resourceClosed() {
        return this.closed;
    }
    private async call(input: ConsoleWrite) {
        if (this.pending)
            throw new CaptureStorageError('busy', 'Await the console acknowledgement.');
        if (this.closed) throw new CaptureStorageError('io', 'Console operation port is closed.');
        if (this.broken && !['close', 'fail'].includes(input.op)) throw this.broken;
        const request = consoleWriteRequest(input);
        if (request.op === 'begin') {
            if (this.expectedHeader)
                throw new CaptureStorageError('busy', 'Console flow already began.');
            const {
                schema: _schema,
                id: _id,
                ...header
            } = consoleHeader({
                ...request.header,
                schema: 2,
                id: '00000000-0000-4000-8000-000000000000',
            });
            this.expectedHeader = header;
        }
        this.pending = true;
        try {
            const reply = consoleWriteReply(await this.rpc(request));
            const next = reply.snapshot,
                previous = this.current;
            if (reply.closed !== (request.op === 'close'))
                throw new CaptureStorageError(
                    'integrity',
                    'Console port close acknowledgement differs.',
                );
            if (next) {
                const { schema: _schema, id: _id, ...header } = next.header;
                if (
                    !this.expectedHeader ||
                    JSON.stringify(header) !== JSON.stringify(this.expectedHeader)
                )
                    throw new CaptureStorageError(
                        'integrity',
                        'Console header acknowledgement differs.',
                    );
                if (
                    previous &&
                    (next.header.id !== previous.header.id ||
                        (['offset', 'records', 'bytes', 'observations', 'segments'] as const).some(
                            (key) => next[key] < previous[key],
                        ))
                )
                    throw new CaptureStorageError(
                        'integrity',
                        'Console acknowledgement moved backwards or changed identity.',
                    );
            } else if (previous || !['fail', 'close'].includes(request.op))
                throw new CaptureStorageError(
                    'integrity',
                    'Console acknowledgement lost its capture.',
                );
            if ((request.op === 'start') !== (reply.value !== null))
                throw new CaptureStorageError(
                    'integrity',
                    'Console segment acknowledgement differs.',
                );
            if (request.op === 'close' && JSON.stringify(next) !== JSON.stringify(previous))
                throw new CaptureStorageError(
                    'integrity',
                    'Console close changed retained metadata.',
                );
            this.current = next;
            this.closed = reply.closed;
            return reply;
        } catch (error) {
            this.broken ??= error;
            throw error;
        } finally {
            this.pending = false;
        }
    }
    async begin(header: Omit<ConsoleHeader, 'schema' | 'id'>) {
        const result = await this.call({ op: 'begin', header });
        if (!result.snapshot) throw Error('Missing console capture.');
        return result.snapshot;
    }
    async start(segment: Parameters<ConsoleRepository['start']>[0], at: string) {
        const result = await this.call({ op: 'start', segment, at });
        if (result.value === null) throw Error('Missing console segment identity.');
        return result.value;
    }
    async inputSent(at: string) {
        await this.call({ op: 'input-sent', at });
    }
    async discardPreparation(
        reason: Parameters<ConsoleRepository['discardPreparation']>[0],
        at: string,
    ) {
        await this.call({ op: 'discard-preparation', reason, at });
    }
    async observe(bytes: Uint8Array, receivedAt: string, origin: 'channel' | 'extended') {
        await this.call({ op: 'observe', base64: bytesBase64(bytes), receivedAt, origin });
    }
    async end(
        reason: Parameters<ConsoleRepository['end']>[0],
        match: ConsoleMatch | null,
        at: string,
    ) {
        await this.call({ op: 'end', reason, match, at });
    }
    async outcome(
        completion: Parameters<ConsoleRepository['outcome']>[0],
        match: ConsoleMatch | null,
        at: string,
    ) {
        await this.call({ op: 'outcome', completion, match, at });
    }
    async finish(
        reason: Parameters<ConsoleRepository['finish']>[0],
        observedBytes: number,
        shellClosed: true,
    ) {
        const result = await this.call({ op: 'finish', reason, observedBytes, shellClosed });
        if (!result.snapshot) throw Error('Missing console seal.');
        return result.snapshot;
    }
    async fail(observedBytes: number | null, error: CaptureStorageError, shellClosed?: true) {
        await this.call({
            op: 'fail',
            observedBytes,
            error: { code: error.code, message: error.message },
            ...(shellClosed ? { shellClosed } : {}),
        });
    }
    async close() {
        if (this.closed) return;
        await this.call({ op: 'close' });
        if (!this.closed) throw Error('Console storage cleanup not acknowledged.');
    }
}
export function consoleArchiveBounds(after: unknown, limit: unknown = 25) {
    if (after !== undefined) {
        if (typeof after !== 'string') throw Error('Invalid console page cursor.');
        validId(after);
    }
    integer(limit as number, 1, 50);
    return { after: after as string | undefined, limit: limit as number };
}
