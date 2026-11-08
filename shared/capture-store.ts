/** Script bytes exclude the explicitly selected transport line ending. */
export const CAPTURE_INPUT = {
    scriptBytes: 8192,
    /** A maximum-size script plus the longest supported Serial line ending (CRLF). */
    transmittedBytes: 8194,
} as const;
/** Storage limits bound individual operations and working memory, never total output or retention. */
export const CAPTURE_STORAGE = {
    frameBytes: 16 * 1024,
    batchBytes: 64 * 1024,
    backlogBytes: 256 * 1024,
    previewBytes: 8 * 1024,
    pageRows: 100,
    pageBytes: 256 * 1024,
    metadataBytes: 32 * 1024,
} as const;
export type CaptureFailureCode =
    'quota' | 'permission' | 'io' | 'unsupported' | 'busy' | 'invalid' | 'integrity' | 'backlog';
export class CaptureStorageError extends Error {
    constructor(
        public readonly code: CaptureFailureCode,
        message: string,
    ) {
        const clean = String(message)
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .slice(0, 512);
        super(
            new TextDecoder().decode(new TextEncoder().encode(clean).subarray(0, 512), {
                stream: true,
            }),
        );
        this.name = 'CaptureStorageError';
    }
}
export function storageError(error: unknown): CaptureStorageError {
    if (error instanceof CaptureStorageError) return error;
    const e = error as { name?: string; code?: string; message?: string };
    const denied =
        ['NotAllowedError', 'SecurityError'].includes(e?.name ?? '') ||
        ['EACCES', 'EPERM'].includes(e?.code ?? '');
    const unsupported =
        e?.name === 'NotSupportedError' ||
        ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(e?.code ?? '');
    return new CaptureStorageError(
        e?.name === 'QuotaExceededError' || ['ENOSPC', 'EDQUOT'].includes(e?.code ?? '')
            ? 'quota'
            : denied
              ? 'permission'
              : unsupported
                ? 'unsupported'
                : 'io',
        (e?.message || String(error)).slice(0, 512),
    );
}
export interface CaptureHeader {
    transport: 'ssh' | 'serial';
    receiveTimeSource: 'local-client' | 'gateway';
    runId: string;
    stepId: string;
    command: string;
    name: string;
    startedAt: string;
    target?: { endpoint: string; username?: string; serialSettings?: string };
    requestBase64?: string;
    execution?: {
        mode: 'independent-script' | 'serial-command' | 'ssh-console';
        intent: 'script' | 'send-enter';
        timeoutMs: number;
    };
}
export interface CaptureFrame {
    observation: number;
    receivedAt: string;
    stream: 'stdout' | 'stderr' | 'serial';
    /** Original observation boundary, preserved even when split across storage frames. */
    offset: number;
    totalBytes: number;
    bytes: Uint8Array;
    crc32: string;
}
export interface StoredCapture {
    schema: 1;
    id: string;
    sequence: number;
    header: CaptureHeader;
    state: 'active' | 'complete' | 'incomplete';
    reason: string | null;
    /** Host finalization/recovery time, never a device emission/completion timestamp. */
    finalizedAt: string | null;
    failure: { code: CaptureFailureCode; message: string } | null;
    committedBytes: number;
    committedFrames: number;
    observations: number;
    firstReceivedAt: string | null;
    lastReceivedAt: string | null;
    /** Null after a crash when the number of observed but uncommitted bytes is unknown. */
    observedBytes: number | null;
    pendingObservation: {
        receivedAt: string;
        stream: CaptureFrame['stream'];
        totalBytes: number;
        offset: number;
    } | null;
}
export type CaptureRead =
    { type: 'metadata'; capture: StoredCapture } | { type: 'frame'; frame: CaptureFrame };
export interface CapturePage {
    records: StoredCapture[];
    next: number | null;
}
export interface CaptureRepository {
    /** Immutable execution metadata, committed after raw seal and before the next command. */
    record?(id: string, outcome: import('./automation-result').AutomationOutcome): Promise<void>;
    result?(id: string): Promise<import('./automation-result').AutomationOutcome | null>;
    readonly recoveryFailure?: CaptureStorageError;
    begin(header: CaptureHeader): Promise<StoredCapture>;
    append(id: string, frames: readonly CaptureFrame[]): Promise<StoredCapture>;
    seal(id: string, observedBytes: number, reason: string): Promise<StoredCapture>;
    fail(id: string, observedBytes: number | null, failure: CaptureStorageError): Promise<void>;
    page(after?: number, limit?: number, through?: number): Promise<CapturePage>;
    /** Holds a read lease until the iterator is exhausted/returned. Active captures are busy. */
    read(id: string): AsyncIterable<CaptureRead>;
    delete(id: string): Promise<void>;
    close(): Promise<void>;
    /** Pins catalog membership through a sequence; deletion is blocked until release. */
    pin(): Promise<{ through: number; release(): Promise<void> }>;
}
export function validId(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))
        throw new CaptureStorageError('invalid', 'Invalid capture identity.');
}
export function integer(value: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new CaptureStorageError('invalid', 'Invalid capture counter.');
}
export function isoTime(value: string) {
    if (
        typeof value !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value
    )
        throw new CaptureStorageError('invalid', 'Invalid receive observation timestamp.');
}
export function captureHeader(header: CaptureHeader): CaptureHeader {
    if (
        !header ||
        !['ssh', 'serial'].includes(header.transport) ||
        !['local-client', 'gateway'].includes(header.receiveTimeSource)
    )
        throw new CaptureStorageError('invalid', 'Invalid capture transport or provenance.');
    for (const field in header)
        if (
            Object.hasOwn(header, field) &&
            ![
                'transport',
                'receiveTimeSource',
                'runId',
                'stepId',
                'command',
                'name',
                'startedAt',
                'target',
                'requestBase64',
                'execution',
            ].includes(field)
        )
            throw new CaptureStorageError('invalid', 'Unknown capture header field.');
    if (header.transport === 'serial' && header.receiveTimeSource !== 'local-client')
        throw new CaptureStorageError(
            'invalid',
            'Serial observations originate at the local client.',
        );
    for (const [field, max] of [
        ['runId', 128],
        ['stepId', 128],
        ['command', CAPTURE_INPUT.scriptBytes],
        ['name', 256],
    ] as const) {
        if (
            typeof header[field] !== 'string' ||
            new TextEncoder().encode(header[field]).length > max
        )
            throw new CaptureStorageError('invalid', 'Invalid capture ' + field + '.');
    }
    isoTime(header.startedAt);
    let target: CaptureHeader['target'];
    if (header.target !== undefined) {
        if (!header.target || typeof header.target !== 'object')
            throw new CaptureStorageError('invalid', 'Invalid capture target metadata.');
        for (const field in header.target)
            if (!['endpoint', 'username', 'serialSettings'].includes(field))
                throw new CaptureStorageError('invalid', 'Unknown capture target metadata.');
        for (const [field, limit] of [
            ['endpoint', 512],
            ['username', 128],
            ['serialSettings', 256],
        ] as const)
            if (
                header.target[field] !== undefined &&
                (typeof header.target[field] !== 'string' ||
                    new TextEncoder().encode(header.target[field]).length > limit)
            )
                throw new CaptureStorageError('invalid', 'Invalid capture target field.');
        if (typeof header.target.endpoint !== 'string')
            throw new CaptureStorageError('invalid', 'Capture target endpoint is missing.');
        target = {
            endpoint: header.target.endpoint,
            ...(header.target.username !== undefined ? { username: header.target.username } : {}),
            ...(header.target.serialSettings !== undefined
                ? { serialSettings: header.target.serialSettings }
                : {}),
        };
    }
    if (
        header.requestBase64 !== undefined &&
        base64Bytes(header.requestBase64).length > CAPTURE_INPUT.transmittedBytes
    )
        throw new CaptureStorageError(
            'invalid',
            'Capture request exceeds its transmitted byte budget.',
        );
    let execution: CaptureHeader['execution'];
    if (header.execution !== undefined) {
        const input = header.execution;
        if (
            !input ||
            typeof input !== 'object' ||
            !['independent-script', 'serial-command', 'ssh-console'].includes(input.mode) ||
            !['script', 'send-enter'].includes(input.intent)
        )
            throw new CaptureStorageError('invalid', 'Invalid capture execution intent.');
        for (const field in input)
            if (!['mode', 'intent', 'timeoutMs'].includes(field))
                throw new CaptureStorageError('invalid', 'Unknown execution metadata.');
        integer(input.timeoutMs, 1000, 300000);
        execution = { mode: input.mode, intent: input.intent, timeoutMs: input.timeoutMs };
    }
    if (
        new TextEncoder().encode(JSON.stringify(header)).length >
        CAPTURE_STORAGE.metadataBytes - 4096
    )
        throw new CaptureStorageError(
            'invalid',
            'Capture header exceeded its encoded metadata budget.',
        );
    return {
        transport: header.transport,
        receiveTimeSource: header.receiveTimeSource,
        runId: header.runId,
        stepId: header.stepId,
        command: header.command,
        name: header.name,
        startedAt: header.startedAt,
        ...(target ? { target } : {}),
        ...(header.requestBase64 !== undefined ? { requestBase64: header.requestBase64 } : {}),
        ...(execution ? { execution } : {}),
    };
}
export function newCapture(id: string, sequence: number, header: CaptureHeader): StoredCapture {
    validId(id);
    integer(sequence, 1);
    return {
        schema: 1,
        id,
        sequence,
        header: captureHeader(header),
        state: 'active',
        reason: null,
        finalizedAt: null,
        failure: null,
        committedBytes: 0,
        committedFrames: 0,
        observations: 0,
        firstReceivedAt: null,
        lastReceivedAt: null,
        observedBytes: null,
        pendingObservation: null,
    };
}
export function frameCost(frame: CaptureFrame) {
    return frame.bytes.byteLength + 256;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
export function frameCrc(bytes: Uint8Array) {
    let value = 0xffffffff;
    for (let index = 0; index < bytes.length; index++)
        value = crcTable[(value ^ bytes[index]) & 255] ^ (value >>> 8);
    return ((value ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
export function validateFrame(frame: CaptureFrame) {
    if (!frame) throw new CaptureStorageError('invalid', 'Missing raw capture frame.');
    for (const field in frame)
        if (
            Object.hasOwn(frame, field) &&
            ![
                'observation',
                'receivedAt',
                'stream',
                'offset',
                'totalBytes',
                'bytes',
                'crc32',
            ].includes(field)
        )
            throw new CaptureStorageError('invalid', 'Unknown raw capture frame field.');
    integer(frame.observation);
    integer(frame.offset);
    integer(frame.totalBytes, 1);
    isoTime(frame.receivedAt);
    if (
        !['stdout', 'stderr', 'serial'].includes(frame.stream) ||
        !(frame.bytes instanceof Uint8Array) ||
        frame.bytes.byteLength < 1 ||
        frame.bytes.byteLength > CAPTURE_STORAGE.frameBytes ||
        frame.offset + frame.bytes.byteLength > frame.totalBytes
    )
        throw new CaptureStorageError('invalid', 'Invalid raw capture frame.');
    if (frame.crc32 !== frameCrc(frame.bytes))
        throw new CaptureStorageError('integrity', 'Raw capture frame checksum does not match.');
    if (typeof SharedArrayBuffer !== 'undefined' && frame.bytes.buffer instanceof SharedArrayBuffer)
        throw new CaptureStorageError(
            'invalid',
            'Capture frames must own immutable non-shared byte buffers.',
        );
}
export function appendFrames(input: StoredCapture, frames: readonly CaptureFrame[]): StoredCapture {
    if (input.state !== 'active')
        throw new CaptureStorageError('invalid', 'Capture is already sealed.');
    if (!Array.isArray(frames) || !frames.length || frames.length > 256)
        throw new CaptureStorageError(
            'backlog',
            'Capture storage batch has too many observations.',
        );
    for (const frame of frames) validateFrame(frame);
    if (frames.reduce((n, f) => n + frameCost(f), 0) > CAPTURE_STORAGE.batchBytes)
        throw new CaptureStorageError(
            'backlog',
            'Capture storage batch exceeded its memory budget.',
        );
    const next = structuredClone(input);
    for (const frame of frames) {
        if ((next.header.transport === 'serial') !== (frame.stream === 'serial'))
            throw new CaptureStorageError(
                'invalid',
                'Capture stream does not match its transport.',
            );
        const previous = next.pendingObservation;
        if (
            frame.observation !== next.observations ||
            frame.offset !== (previous?.offset ?? 0) ||
            (previous &&
                (previous.receivedAt !== frame.receivedAt ||
                    previous.stream !== frame.stream ||
                    previous.totalBytes !== frame.totalBytes))
        )
            throw new CaptureStorageError(
                'integrity',
                'Receive observations are missing, reordered or inconsistent.',
            );
        const offset = frame.offset + frame.bytes.byteLength;
        next.pendingObservation =
            offset === frame.totalBytes
                ? null
                : {
                      receivedAt: frame.receivedAt,
                      stream: frame.stream,
                      totalBytes: frame.totalBytes,
                      offset,
                  };
        if (!next.pendingObservation) next.observations++;
        if (!next.committedFrames) next.firstReceivedAt = frame.receivedAt;
        next.lastReceivedAt = frame.receivedAt;
        next.committedBytes += frame.bytes.byteLength;
        next.committedFrames++;
        integer(next.committedBytes);
        integer(next.committedFrames);
        integer(next.observations);
    }
    return next;
}
export function sealedCapture(
    input: StoredCapture,
    observedBytes: number,
    reason: string,
): StoredCapture {
    integer(observedBytes);
    if (
        input.state !== 'active' ||
        input.pendingObservation ||
        observedBytes !== input.committedBytes
    )
        throw new CaptureStorageError(
            'integrity',
            'An incomplete raw capture cannot be declared complete.',
        );
    return {
        ...input,
        observedBytes,
        state: 'complete',
        reason: reason.slice(0, 512),
        finalizedAt: new Date().toISOString(),
        failure: null,
    };
}
export function failedCapture(
    input: StoredCapture,
    observedBytes: number | null,
    failure: CaptureStorageError,
): StoredCapture {
    if (observedBytes !== null) integer(observedBytes, input.committedBytes);
    return {
        ...input,
        observedBytes,
        state: 'incomplete',
        reason: failure.message,
        finalizedAt: new Date().toISOString(),
        failure: { code: failure.code, message: failure.message },
    };
}
/** Recovery must remain readable/exportable/deletable even when no failure metadata can be written. */
export function interruptedCapture(input: StoredCapture): StoredCapture {
    return {
        ...failedCapture(
            input,
            null,
            new CaptureStorageError(
                'io',
                'Capture interrupted; verified committed prefix and any uncommitted journal bytes retained; observed tail unknown.',
            ),
        ),
        finalizedAt: null,
    };
}
export function storedCapture(input: StoredCapture): StoredCapture {
    if (!input || input.schema !== 1)
        throw new CaptureStorageError('integrity', 'Unsupported stored capture schema.');
    validId(input.id);
    integer(input.sequence, 1);
    captureHeader(input.header);
    for (const value of [input.committedBytes, input.committedFrames, input.observations])
        integer(value);
    for (const time of [input.firstReceivedAt, input.lastReceivedAt])
        if (time !== null) isoTime(time);
    if (
        input.committedFrames === 0
            ? input.firstReceivedAt !== null || input.lastReceivedAt !== null
            : !input.firstReceivedAt || !input.lastReceivedAt
    )
        throw new CaptureStorageError(
            'integrity',
            'Stored receive timestamp range is inconsistent.',
        );
    if (!['active', 'complete', 'incomplete'].includes(input.state))
        throw new CaptureStorageError('integrity', 'Invalid stored completeness state.');
    if (input.finalizedAt !== null) isoTime(input.finalizedAt);
    if (
        (input.state === 'active' && input.finalizedAt !== null) ||
        (input.state === 'complete' && input.finalizedAt === null)
    )
        throw new CaptureStorageError(
            'integrity',
            'Capture finalization timestamp does not match its state.',
        );
    if (input.state === 'incomplete' && !input.failure)
        throw new CaptureStorageError('integrity', 'Incomplete capture has no failure provenance.');
    if (input.observedBytes !== null) integer(input.observedBytes, input.committedBytes);
    if (input.pendingObservation) {
        isoTime(input.pendingObservation.receivedAt);
        integer(input.pendingObservation.totalBytes, 1);
        integer(input.pendingObservation.offset, 1, input.pendingObservation.totalBytes - 1);
        if (!['stdout', 'stderr', 'serial'].includes(input.pendingObservation.stream))
            throw new CaptureStorageError('integrity', 'Invalid stored observation.');
    }
    if (
        input.state === 'complete' &&
        (input.pendingObservation || input.observedBytes !== input.committedBytes || input.failure)
    )
        throw new CaptureStorageError('integrity', 'Stored completeness metadata is inconsistent.');
    if (input.reason !== null && (typeof input.reason !== 'string' || input.reason.length > 512))
        throw new CaptureStorageError('integrity', 'Invalid stored reason.');
    if (
        input.failure &&
        (typeof input.failure.message !== 'string' ||
            input.failure.message.length > 512 ||
            ![
                'quota',
                'permission',
                'io',
                'unsupported',
                'busy',
                'invalid',
                'integrity',
                'backlog',
            ].includes(input.failure.code))
    )
        throw new CaptureStorageError('integrity', 'Invalid stored failure.');
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > CAPTURE_STORAGE.metadataBytes)
        throw new CaptureStorageError('integrity', 'Stored capture metadata exceeded its bound.');
    return structuredClone(input);
}
export function pageBounds(
    after = 0,
    limit: number = CAPTURE_STORAGE.pageRows,
    through = Number.MAX_SAFE_INTEGER,
) {
    integer(after);
    integer(limit, 1, CAPTURE_STORAGE.pageRows);
    integer(through, after);
    return { after, limit, through };
}
export function boundedCapturePage(page: CapturePage): CapturePage {
    let bytes = 64;
    for (let index = 0; index < page.records.length; index++) {
        bytes += new TextEncoder().encode(JSON.stringify(page.records[index])).length + 1;
        if (bytes > CAPTURE_STORAGE.pageBytes) {
            if (!index)
                throw new CaptureStorageError(
                    'integrity',
                    'Capture metadata cannot fit a bounded page.',
                );
            return {
                records: page.records.slice(0, index),
                next: page.records[index - 1].sequence,
            };
        }
    }
    return page;
}
export function captureVerifier(metadata: StoredCapture) {
    let verified = newCapture(metadata.id, metadata.sequence, metadata.header);
    return {
        append(frame: CaptureFrame) {
            verified = appendFrames(verified, [frame]);
        },
        finish() {
            if (
                metadata.committedBytes !== verified.committedBytes ||
                metadata.committedFrames !== verified.committedFrames ||
                metadata.observations !== verified.observations ||
                metadata.firstReceivedAt !== verified.firstReceivedAt ||
                metadata.lastReceivedAt !== verified.lastReceivedAt ||
                JSON.stringify(metadata.pendingObservation) !==
                    JSON.stringify(verified.pendingObservation)
            )
                throw new CaptureStorageError(
                    'integrity',
                    'Stored raw evidence does not match its pinned committed high-water mark.',
                );
        },
    };
}
export function bytesBase64(bytes: Uint8Array) {
    if (bytes.length > CAPTURE_STORAGE.frameBytes)
        throw new CaptureStorageError(
            'backlog',
            'Raw byte encoder exceeded its bounded frame budget.',
        );
    return btoa(String.fromCharCode(...bytes));
}
export function base64Bytes(value: string) {
    if (
        typeof value !== 'string' ||
        value.length > Math.ceil(CAPTURE_STORAGE.frameBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    )
        throw new CaptureStorageError('integrity', 'Invalid stored raw byte encoding.');
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    if (bytesBase64(bytes) !== value)
        throw new CaptureStorageError('integrity', 'Noncanonical stored raw encoding.');
    return bytes;
}
