import { automationRequest, validateCapture, type AutomationRequest } from './automation';
import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    base64Bytes,
    frameCrc,
    isoTime,
} from './capture-store';
import type { StreamedCommandCapture } from './automation-stream';

export type SshStreamRequest =
    | { protocol: 1; action: 'capabilities' }
    | { protocol: 1; action: 'start'; epoch: string; request: AutomationRequest }
    | {
          protocol: 1;
          action: 'read' | 'cancel' | 'finalize';
          id: string;
          connection: string;
          capability: string;
      }
    | {
          protocol: 1;
          action: 'ack';
          id: string;
          connection: string;
          capability: string;
          sequence: number;
      };
export type SshStreamRpc = (input: SshStreamRequest) => Promise<unknown>;
export interface SshStreamData {
    protocol: 1;
    type: 'data';
    id: string;
    sequence: number;
    receivedAt: string;
    receiveTimeSource: 'local-client' | 'gateway';
    stream: 'stdout' | 'stderr';
    totalBytes: number;
    frames: { offset: number; base64: string; crc32: string }[];
}
export function streamObject(input: unknown, fields: readonly string[]) {
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
        throw Error('Invalid SSH stream metadata.');
    return input as Record<string, unknown>;
}
export function streamRequest(input: unknown): SshStreamRequest {
    const v = streamObject(input, [
        'protocol',
        'action',
        'request',
        'epoch',
        'id',
        'connection',
        'capability',
        'sequence',
    ]);
    if (v.protocol !== 1) throw Error('Unsupported SSH streaming protocol.');
    if (v.action === 'capabilities') {
        streamObject(v, ['protocol', 'action']);
        return { protocol: 1, action: 'capabilities' };
    }
    if (v.action === 'start') {
        streamObject(v, ['protocol', 'action', 'request', 'epoch']);
        if (typeof v.epoch !== 'string' || !/^[a-f0-9]{32}$/.test(v.epoch))
            throw Error('Invalid SSH stream generation.');
        streamObject(v.request, ['id', 'connection', 'command', 'timeoutMs']);
        return {
            protocol: 1,
            action: 'start',
            epoch: v.epoch,
            request: automationRequest(v.request),
        };
    }
    if (!['read', 'ack', 'cancel', 'finalize'].includes(v.action as string))
        throw Error('Invalid SSH stream operation.');
    streamObject(
        v,
        v.action === 'ack'
            ? ['protocol', 'action', 'id', 'connection', 'capability', 'sequence']
            : ['protocol', 'action', 'id', 'connection', 'capability'],
    );
    if (
        typeof v.id !== 'string' ||
        !/^[A-Za-z0-9_-]{16,64}$/.test(v.id) ||
        typeof v.connection !== 'string' ||
        !/^[A-Za-z0-9_-]{16,64}$/.test(v.connection) ||
        typeof v.capability !== 'string' ||
        !/^[a-f0-9]{64}$/.test(v.capability)
    )
        throw Error('Invalid SSH stream owner.');
    if (v.action === 'ack' && (!Number.isSafeInteger(v.sequence) || Number(v.sequence) < 0))
        throw Error('Invalid SSH stream credit.');
    return v as unknown as SshStreamRequest;
}
export function streamCapabilities(input: unknown, source: 'local-client' | 'gateway') {
    const v = streamObject(input, [
        'protocol',
        'independentStream',
        'receiveTimeSource',
        'frameBytes',
        'backlogBytes',
        'epoch',
    ]);
    if (
        v.protocol !== 1 ||
        v.independentStream !== 1 ||
        v.receiveTimeSource !== source ||
        v.frameBytes !== CAPTURE_STORAGE.frameBytes ||
        v.backlogBytes !== CAPTURE_STORAGE.backlogBytes ||
        typeof v.epoch !== 'string' ||
        !/^[a-f0-9]{32}$/.test(v.epoch)
    )
        throw Error(
            'Full SSH capture requires a supported streaming runtime. Update the desktop app or gateway.',
        );
    return v.epoch as string;
}
export function streamData(
    input: unknown,
    id: string,
    sequence: number,
    source: 'local-client' | 'gateway',
) {
    const v = streamObject(input, [
        'protocol',
        'type',
        'id',
        'sequence',
        'receivedAt',
        'receiveTimeSource',
        'stream',
        'totalBytes',
        'frames',
    ]);
    if (
        v.protocol !== 1 ||
        v.type !== 'data' ||
        v.id !== id ||
        v.sequence !== sequence ||
        v.receiveTimeSource !== source ||
        !['stdout', 'stderr'].includes(v.stream as string) ||
        !Number.isSafeInteger(v.totalBytes) ||
        Number(v.totalBytes) < 1 ||
        Number(v.totalBytes) > CAPTURE_STORAGE.backlogBytes ||
        !Array.isArray(v.frames) ||
        v.frames.length !== Math.ceil(Number(v.totalBytes) / CAPTURE_STORAGE.frameBytes)
    )
        throw Error('Invalid SSH receive observation.');
    isoTime(v.receivedAt as string);
    const bytes = new Uint8Array(Number(v.totalBytes));
    let offset = 0;
    for (const item of v.frames) {
        const f = streamObject(item, ['offset', 'base64', 'crc32']);
        if (
            typeof f.base64 !== 'string' ||
            f.base64.length > Math.ceil(CAPTURE_STORAGE.frameBytes / 3) * 4
        )
            throw Error('Oversized SSH frame.');
        const part = base64Bytes(f.base64);
        if (
            f.offset !== offset ||
            part.length !== Math.min(CAPTURE_STORAGE.frameBytes, bytes.length - offset) ||
            f.crc32 !== frameCrc(part)
        )
            throw Error('Invalid SSH frame range or integrity.');
        bytes.set(part, offset);
        offset += part.length;
    }
    return { bytes, receivedAt: v.receivedAt as string, stream: v.stream as 'stdout' | 'stderr' };
}
export function streamResult(input: unknown, id: string): StreamedCommandCapture {
    const v = streamObject(input, ['protocol', 'type', 'id', 'capture', 'rejected']);
    if (v.protocol !== 1 || v.type !== 'end' || v.id !== id)
        throw Error('Invalid SSH stream completion.');
    const raw = streamObject(v.capture, [
        'stdout',
        'stderr',
        'exitCode',
        'completion',
        'truncated',
        'chunks',
        'previewClipped',
        'termination',
    ]);
    const capture = validateCapture(raw);
    if (
        capture.chunks.length ||
        typeof raw.previewClipped !== 'boolean' ||
        capture.truncated ||
        new TextEncoder().encode(capture.stdout + capture.stderr).length >
            CAPTURE_STORAGE.previewBytes * 3 ||
        ![
            'exit',
            'signalled',
            'uncertain-close',
            'cancelled',
            'timeout',
            'transport-error',
        ].includes(capture.completion)
    )
        throw Error('Invalid SSH streaming result.');
    streamRejected(v);
    return { ...capture, previewClipped: raw.previewClipped as boolean };
}
export function streamRejected(input: unknown) {
    const v = streamObject(input, ['protocol', 'type', 'id', 'capture', 'rejected']);
    if (v.rejected === undefined) return null;
    const r = streamObject(v.rejected, ['bytes', 'code', 'message']);
    if (
        !Number.isSafeInteger(r.bytes) ||
        Number(r.bytes) < 1 ||
        (r.code !== 'backlog' && r.code !== 'io') ||
        typeof r.message !== 'string' ||
        r.message.length > 512 ||
        new TextEncoder().encode(r.message).length > 512
    )
        throw Error('Invalid SSH rejection evidence.');
    return { bytes: r.bytes as number, failure: new CaptureStorageError(r.code, r.message) };
}
