import { CaptureStorageError, validId } from '../../../../shared/capture-store';
import {
    consoleArchiveRequest,
    type ConsoleArchiveRpc,
    type ConsoleArchiveRequest,
} from '../../../../shared/console-archive-rpc';
import {
    consoleArchiveBounds,
    consoleSnapshot,
    type ConsoleArchive,
    type ConsoleRead,
} from '../../../../shared/console-storage';
import { streamObject } from '../../../../shared/ssh-stream-rpc';
import {
    applyConsoleRecord,
    newConsoleCursor,
    completeConsoleCursor,
} from '../../../../shared/console-journal';
import { IndexedDbConsoleJournal } from './indexeddb-console';
/** Each view/export owns only its reader handles; returning one never cancels a producer. */
export class NativeConsoleArchive implements ConsoleArchive {
    private handles = new Set<string>();
    private pins = new Set<string>();
    private requests = new Set<Promise<unknown>>();
    private closed = false;
    constructor(private rpc: ConsoleArchiveRpc) {}
    private call(input: ConsoleArchiveRequest) {
        if (this.closed && input.op !== 'return' && input.op !== 'unpin')
            return Promise.reject(new CaptureStorageError('io', 'Console archive view is closed.'));
        const task = (async () => {
            const reply = streamObject(await this.rpc(consoleArchiveRequest(input)), [
                'ok',
                'value',
                'error',
            ]);
            if (reply.ok === true) {
                streamObject(reply, ['ok', 'value']);
                return reply.value;
            }
            if (reply.ok !== false) throw Error('Invalid console archive acknowledgement.');
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
                throw Error('Invalid console archive failure.');
            throw new CaptureStorageError(error.code as CaptureStorageError['code'], error.message);
        })();
        this.requests.add(task);
        void task.finally(() => this.requests.delete(task)).catch(() => {});
        return task;
    }
    async list(after?: string, limit = 25) {
        const bounds = consoleArchiveBounds(after, limit),
            value = streamObject(await this.call({ op: 'list', ...bounds }), [
                'captures',
                'next',
                'mode',
            ]);
        if (
            !Array.isArray(value.captures) ||
            value.captures.length > bounds.limit ||
            value.mode !== 'scan' ||
            (value.next !== null && typeof value.next !== 'string')
        )
            throw Error('Invalid bounded console catalog.');
        const captures = value.captures.map(consoleSnapshot);
        if (value.next !== null) {
            validId(value.next as string);
            if (value.next !== captures.at(-1)?.header.id)
                throw Error('Invalid console catalog cursor.');
        }
        return { captures, next: value.next as string | null, mode: 'scan' as const };
    }
    async *read(id: string): AsyncGenerator<ConsoleRead> {
        validId(id);
        const opened = streamObject(await this.call({ op: 'read', id }), ['handle']);
        if (typeof opened.handle !== 'string') throw Error('Invalid console read handle.');
        validId(opened.handle);
        const handle = opened.handle;
        this.handles.add(handle);
        let meta: ReturnType<typeof consoleSnapshot> | undefined;
        const cursor = newConsoleCursor();
        let offset = 0;
        try {
            while (true) {
                if (this.closed)
                    throw new CaptureStorageError('io', 'Console archive view is closed.');
                const next = streamObject(await this.call({ op: 'pull', handle }), [
                    'done',
                    'value',
                ]);
                if (next.done === true) break;
                if (next.done !== false) throw Error('Invalid console reader acknowledgement.');
                const event = streamObject(next.value, ['kind', 'capture', 'record']);
                if (event.kind === 'metadata') {
                    streamObject(event, ['kind', 'capture']);
                    if (meta) throw Error('Duplicate console metadata.');
                    meta = consoleSnapshot(event.capture);
                    if (meta.header.id !== id) throw Error('Console read identity differs.');
                    yield { kind: 'metadata', capture: meta };
                } else if (event.kind === 'record') {
                    streamObject(event, ['kind', 'record']);
                    if (!meta) throw Error('Console read has no metadata.');
                    const record = applyConsoleRecord(cursor, event.record, meta.header);
                    offset += new TextEncoder().encode(JSON.stringify(record) + '\n').length;
                    yield {
                        kind: 'record',
                        record,
                    };
                } else throw Error('Unknown console archive record.');
            }
            if (
                !meta ||
                (['records', 'bytes', 'observations', 'segments'] as const).some(
                    (key) => cursor[key] !== meta![key],
                ) ||
                cursor.pendingObservation ||
                offset !== meta.offset
            )
                throw new CaptureStorageError('integrity', 'Console replay counters differ.');
            if (meta.state === 'complete') completeConsoleCursor(cursor);
        } finally {
            await this.call({ op: 'return', handle });
            this.handles.delete(handle);
        }
    }
    async delete(id: string) {
        validId(id);
        const reply = streamObject(await this.call({ op: 'delete', id }), ['ok']);
        if (reply.ok !== true) throw Error('Console deletion was not acknowledged.');
    }
    async pin() {
        const value = streamObject(await this.call({ op: 'pin' }), ['handle']);
        if (typeof value.handle !== 'string') throw Error('Invalid console export pin.');
        validId(value.handle);
        const handle = value.handle;
        this.pins.add(handle);
        let released = false;
        const release = async () => {
            if (released) return;
            await this.call({ op: 'unpin', handle });
            released = true;
            this.pins.delete(handle);
        };
        if (this.closed) {
            await release();
            throw new CaptureStorageError('io', 'Console archive view is closed.');
        }
        return { release };
    }
    async dispose() {
        this.closed = true;
        while (this.requests.size) await Promise.allSettled([...this.requests]);
        await Promise.all(
            [...this.handles].map(async (handle) => {
                await this.call({ op: 'return', handle });
                this.handles.delete(handle);
            }),
        );
        await Promise.all(
            [...this.pins].map(async (handle) => {
                await this.call({ op: 'unpin', handle });
                this.pins.delete(handle);
            }),
        );
    }
    get resourceSnapshot() {
        return {
            closed: this.closed,
            readers: this.handles.size,
            pins: this.pins.size,
            requests: this.requests.size,
        };
    }
}
export async function openConsoleArchive(): Promise<{
    archive: ConsoleArchive;
    dispose: () => Promise<void>;
}> {
    if (window.diagnosticHub) {
        if (!window.diagnosticHub.consoleStorage)
            throw new CaptureStorageError(
                'unsupported',
                'Update the desktop app to review console captures.',
            );
        const archive = new NativeConsoleArchive(window.diagnosticHub.consoleStorage);
        return { archive, dispose: () => archive.dispose() };
    }
    const archive = await IndexedDbConsoleJournal.open();
    return { archive, dispose: () => archive.close() };
}
