import { integer } from './capture-store';
import { streamObject } from './ssh-stream-rpc';
import { consoleReady, type ConsoleCompletion } from './ssh-console';
import { consoleSegment, type ConsoleSegment } from './console-journal';
import { consoleWriteReply, type ConsoleWriteReply } from './console-storage';
export const CONSOLE_IDLE_RENEWAL_MS = 20000;
export interface ConsoleCleanup {
    storageAdapterClosed: boolean;
    journalClosure: 'pending' | 'acknowledged' | 'unacknowledged';
}
export function consoleCleanup(input: unknown): ConsoleCleanup {
    const value = streamObject(input, ['storageAdapterClosed', 'journalClosure']);
    if (
        typeof value.storageAdapterClosed !== 'boolean' ||
        !['pending', 'acknowledged', 'unacknowledged'].includes(value.journalClosure as string) ||
        (value.journalClosure !== 'pending' && value.storageAdapterClosed !== true)
    )
        throw Error('Invalid console cleanup evidence.');
    return value as unknown as ConsoleCleanup;
}
export interface ConsoleOwner {
    id: string;
    connection: string;
    capability: string;
}
export type ConsoleRpcRequest =
    | { protocol: 1; action: 'capabilities' }
    | {
          protocol: 1;
          action: 'open';
          epoch: string;
          id: string;
          connection: string;
          ready: ConsoleCompletion;
          timeoutMs: number;
      }
    | ({ protocol: 1; action: 'status' | 'release' | 'heartbeat' } & ConsoleOwner)
    | ({ protocol: 1; action: 'finish'; reason: 'complete' | 'cancelled' } & ConsoleOwner)
    | ({
          protocol: 1;
          action: 'step';
          sequence: number;
          segment: Extract<ConsoleSegment, { kind: 'command' }>;
          timeoutMs: number;
      } & ConsoleOwner)
    | ({ protocol: 1; action: 'read'; revision: number } & ConsoleOwner)
    | ({
          protocol: 1;
          action: 'ack';
          sequence: number;
          reply: ConsoleWriteReply | null;
          error: { code: string; message: string } | null;
      } & ConsoleOwner);
/** AbortSignal is a local fetch option, never serialized as an owner request or IPC body. */
export type ConsoleRpc = (
    input: ConsoleRpcRequest,
    options?: { signal?: AbortSignal },
) => Promise<unknown>;
export function consoleOwner(input: unknown): ConsoleOwner {
    const v = streamObject(input, ['id', 'connection', 'capability']);
    if (
        typeof v.id !== 'string' ||
        !/^[A-Za-z0-9_-]{16,64}$/.test(v.id) ||
        typeof v.connection !== 'string' ||
        !/^[A-Za-z0-9_-]{16,64}$/.test(v.connection) ||
        typeof v.capability !== 'string' ||
        !/^[a-f0-9]{64}$/.test(v.capability)
    )
        throw Error('Console owner is invalid or stale.');
    return { id: v.id, connection: v.connection, capability: v.capability };
}
export function consoleRpcRequest(input: unknown): ConsoleRpcRequest {
    const v = streamObject(input, [
        'protocol',
        'action',
        'epoch',
        'id',
        'connection',
        'ready',
        'timeoutMs',
        'capability',
        'sequence',
        'segment',
        'reason',
        'revision',
        'reply',
        'error',
    ]);
    if (v.protocol !== 1) throw Error('Unsupported console protocol.');
    if (v.action === 'capabilities') {
        streamObject(v, ['protocol', 'action']);
        return { protocol: 1, action: 'capabilities' };
    }
    if (v.action === 'open') {
        streamObject(v, ['protocol', 'action', 'epoch', 'id', 'connection', 'ready', 'timeoutMs']);
        if (typeof v.epoch !== 'string' || !/^[a-f0-9]{32}$/.test(v.epoch))
            throw Error('Invalid console generation.');
        consoleOwner({ id: v.id, connection: v.connection, capability: '0'.repeat(64) });
        consoleReady(v.ready);
        integer(v.timeoutMs as number, 1000, 300000);
    } else {
        const owner = consoleOwner({
            id: v.id,
            connection: v.connection,
            capability: v.capability,
        });
        const base = ['protocol', 'action', ...Object.keys(owner)];
        switch (v.action) {
            case 'status':
            case 'release':
            case 'heartbeat':
                streamObject(v, base);
                break;
            case 'finish':
                streamObject(v, [...base, 'reason']);
                if (!['complete', 'cancelled'].includes(v.reason as string))
                    throw Error('Invalid console stop reason.');
                break;
            case 'step': {
                streamObject(v, [...base, 'sequence', 'segment', 'timeoutMs']);
                integer(v.sequence as number);
                integer(v.timeoutMs as number, 1000, 300000);
                const segment = consoleSegment(v.segment);
                if (segment.kind !== 'command')
                    throw Error('Console input requires a command segment.');
                break;
            }
            case 'read':
                streamObject(v, [...base, 'revision']);
                integer(v.revision as number);
                break;
            case 'ack': {
                streamObject(v, [...base, 'sequence', 'reply', 'error']);
                integer(v.sequence as number);
                if ((v.reply === null) === (v.error === null))
                    throw Error('Console acknowledgement requires exactly one reply or error.');
                if (v.reply !== null) consoleWriteReply(v.reply);
                if (v.error !== null) {
                    const error = streamObject(v.error, ['code', 'message']);
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
                        throw Error('Invalid console persistence failure.');
                }
                break;
            }
            default:
                throw Error('Unsupported console operation.');
        }
    }
    return structuredClone(v) as unknown as ConsoleRpcRequest;
}
