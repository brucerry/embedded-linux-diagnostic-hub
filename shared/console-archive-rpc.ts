import { CaptureStorageError, integer, validId } from './capture-store';
import { streamObject } from './ssh-stream-rpc';
import { consoleArchiveBounds } from './console-storage';
import { consoleReportScope, type ConsoleReportScope } from './console-report';
import type { CaptureReportFormat } from './capture-report';
export type ConsoleArchiveRequest =
    | { op: 'list'; after?: string; limit?: number }
    | { op: 'pin' }
    | { op: 'unpin'; handle: string }
    | { op: 'read'; id: string }
    | { op: 'delete'; id: string }
    | { op: 'pull'; handle: string }
    | { op: 'return'; handle: string }
    | ConsoleExportRequest;
export type ConsoleExportRequest =
    | { op: 'export'; owner: string; format: CaptureReportFormat; scope: ConsoleReportScope }
    | { op: 'cancel-export'; owner: string };
export type ConsoleArchiveRpc = (input: ConsoleArchiveRequest) => Promise<unknown>;
export function consoleArchiveReply(input: unknown): unknown {
    const reply = streamObject(input, ['ok', 'value', 'error']);
    if (reply.ok === true) {
        streamObject(reply, ['ok', 'value']);
        if (!Object.hasOwn(reply, 'value'))
            throw new CaptureStorageError(
                'integrity',
                'Console archive acknowledgement has no value.',
            );
        return reply.value;
    }
    if (reply.ok !== false)
        throw new CaptureStorageError('integrity', 'Invalid console archive acknowledgement.');
    streamObject(reply, ['ok', 'error']);
    const error = streamObject(reply.error, ['code', 'message']);
    if (
        ![
            'quota',
            'permission',
            'io',
            'unsupported',
            'busy',
            'invalid',
            'integrity',
            'backlog',
        ].includes(error.code as string) ||
        typeof error.message !== 'string' ||
        error.message.length > 512
    )
        throw new CaptureStorageError('integrity', 'Invalid console archive failure.');
    throw new CaptureStorageError(error.code as CaptureStorageError['code'], error.message);
}
export function consoleArchiveRequest(input: unknown): ConsoleArchiveRequest {
    const v = streamObject(input, [
        'op',
        'after',
        'limit',
        'id',
        'handle',
        'owner',
        'format',
        'scope',
    ]);
    if (v.op === 'list') {
        streamObject(v, ['op', 'after', 'limit']);
        consoleArchiveBounds(v.after, v.limit ?? 25);
    } else if (v.op === 'read' || v.op === 'delete') {
        streamObject(v, ['op', 'id']);
        if (typeof v.id !== 'string') throw Error('Invalid console capture identity.');
        validId(v.id);
    } else if (v.op === 'pull' || v.op === 'return' || v.op === 'unpin') {
        streamObject(v, ['op', 'handle']);
        if (typeof v.handle !== 'string') throw Error('Invalid console reader handle.');
        validId(v.handle);
    } else if (v.op === 'export' || v.op === 'cancel-export') {
        streamObject(v, v.op === 'export' ? ['op', 'owner', 'format', 'scope'] : ['op', 'owner']);
        if (typeof v.owner !== 'string') throw Error('Invalid console export owner.');
        validId(v.owner);
        if (v.op === 'export') {
            if (!['json', 'csv', 'markdown', 'text'].includes(v.format as string))
                throw Error('Invalid console export format.');
            consoleReportScope(v.scope);
        }
    } else if (v.op === 'pin') streamObject(v, ['op']);
    else throw Error('Unknown console archive operation.');
    integer(
        new TextEncoder().encode(JSON.stringify(v)).length,
        1,
        v.op === 'export' ? 64 * 1024 : 4096,
    );
    return structuredClone(v) as ConsoleArchiveRequest;
}
