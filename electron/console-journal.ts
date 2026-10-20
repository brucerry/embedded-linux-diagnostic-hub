import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { physicalFS } from './physical-fs';
import { consoleArchiveBounds, type ConsoleArchive } from '../shared/console-storage';
import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    frameCrc,
    integer,
    isoTime,
    storageError,
    validId,
    bytesBase64,
} from '../shared/capture-store';
import {
    applyConsoleRecord,
    completeConsoleCursor,
    consoleHeader,
    consoleSegment,
    newConsoleCursor,
    type ConsoleHeader,
    type ConsoleCursor,
    type ConsoleRecord,
    type ConsoleSegment,
    type ConsoleMatch,
    type ConsoleCompletionReason,
    type ConsoleRepository,
    type ConsoleSnapshot,
} from '../shared/console-journal';

const fs = physicalFS.promises,
    owners = new Set<string>();
const normalized = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
async function directory(p: string) {
    const s = await fs.lstat(p);
    if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        normalized(await fs.realpath(p)) !== normalized(p)
    )
        throw new CaptureStorageError(
            'integrity',
            'Console storage requires physical, unaliased directories.',
        );
}
async function regular(p: string, write = false, create = false): Promise<FileHandle> {
    const before = create ? undefined : await fs.lstat(p);
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
        throw new CaptureStorageError(
            'integrity',
            'Console files must be regular, unlinked files.',
        );
    const flags =
        (write ? physicalFS.constants.O_RDWR : physicalFS.constants.O_RDONLY) |
        (physicalFS.constants.O_NOFOLLOW ?? 0) |
        (physicalFS.constants.O_NONBLOCK ?? 0) |
        (create ? physicalFS.constants.O_CREAT | physicalFS.constants.O_EXCL : 0);
    const h = await fs.open(p, flags, 0o600);
    try {
        const after = await h.stat();
        if (
            !after.isFile() ||
            after.nlink !== 1 ||
            (before && (before.dev !== after.dev || before.ino !== after.ino))
        )
            throw new CaptureStorageError('integrity', 'Console file identity changed.');
        return h;
    } catch (error) {
        await h.close();
        throw error;
    }
}
async function writeAll(h: FileHandle, bytes: Uint8Array, position: number) {
    for (let offset = 0; offset < bytes.length;) {
        const r = await h.write(bytes, offset, bytes.length - offset, position + offset);
        if (r.bytesWritten <= 0)
            throw new CaptureStorageError('io', 'Console journal made no write progress.');
        offset += r.bytesWritten;
    }
}
async function writeJson(p: string, input: unknown, atomic = false) {
    const bytes = Buffer.from(JSON.stringify(input));
    integer(bytes.length, 1, CAPTURE_STORAGE.metadataBytes);
    const dest = atomic ? path.join(path.dirname(p), 'meta-' + randomUUID() + '.tmp') : p,
        h = await regular(dest, true, true);
    try {
        await writeAll(h, bytes, 0);
        await h.sync();
    } finally {
        await h.close();
    }
    if (atomic) await fs.rename(dest, p);
}
async function readJson(p: string) {
    const h = await regular(p);
    try {
        const size = (await h.stat()).size;
        integer(size, 1, CAPTURE_STORAGE.metadataBytes);
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
            const r = await h.read(bytes, offset, size - offset, offset);
            if (!r.bytesRead)
                throw new CaptureStorageError('integrity', 'Console metadata was shortened.');
            offset += r.bytesRead;
        }
        if ((await h.stat()).size !== size)
            throw new CaptureStorageError('integrity', 'Console metadata changed while reading.');
        return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
    } finally {
        await h.close();
    }
}
function snapshot(input: unknown, id: string): ConsoleSnapshot {
    const v = input as ConsoleSnapshot;
    if (
        !v ||
        typeof v !== 'object' ||
        Array.isArray(v) ||
        Object.keys(v).some(
            (k) =>
                ![
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
                ].includes(k),
        ) ||
        v.schema !== 2 ||
        !['active', 'complete', 'incomplete'].includes(v.state) ||
        typeof v.shellClosed !== 'boolean'
    )
        throw new CaptureStorageError('integrity', 'Invalid console checkpoint.');
    const header = consoleHeader(v.header);
    if (header.id !== id)
        throw new CaptureStorageError('integrity', 'Console checkpoint identity differs.');
    for (const n of ['offset', 'records', 'bytes', 'observations', 'segments'] as const)
        integer(v[n]);
    if (v.observedBytes !== null) integer(v.observedBytes, v.bytes);
    if (v.finalizedAt !== null) isoTime(v.finalizedAt);
    if (v.reason !== null && (typeof v.reason !== 'string' || v.reason.length > 128))
        throw new CaptureStorageError('integrity', 'Invalid console finalization reason.');
    if (
        v.failure !== null &&
        (!v.failure ||
            ![
                'quota',
                'permission',
                'io',
                'unsupported',
                'busy',
                'invalid',
                'integrity',
                'backlog',
            ].includes(v.failure.code) ||
            typeof v.failure.message !== 'string' ||
            v.failure.message.length > 512)
    )
        throw new CaptureStorageError('integrity', 'Invalid console failure evidence.');
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
            'Console completion lacks actual cleanup evidence.',
        );
    return { ...v, header };
}
const counts = (c: ConsoleCursor) => ({
    records: c.records,
    bytes: c.bytes,
    observations: c.observations,
    segments: c.segments,
});
/** New namespace, no migration/reset of captures-v1. One bounded actor writes one journal. */
export class NativeConsoleJournal implements ConsoleRepository, ConsoleArchive {
    private meta: ConsoleSnapshot | null = null;
    private cursor = newConsoleCursor();
    private raw?: FileHandle;
    private operation?: Promise<unknown>;
    private closing?: Promise<void>;
    private closed = false;
    private broken?: CaptureStorageError;
    private readerCount = 0;
    private readPins = new Map<string, number>();
    private listing = 0;
    private catalogPins = 0;
    private deleting = new Set<string>();
    private readersReleased?: () => void;
    private activeStart?: { offset: number; cursor: ConsoleCursor };
    private constructor(
        private root: string,
        private key: string,
        private diagnostic?: { measure<T>(name: string, work: () => Promise<T>): Promise<T> },
    ) {}
    static async open(
        profile: string,
        ownership: {
            profileOwned: true;
            diagnostic?: { measure<T>(name: string, work: () => Promise<T>): Promise<T> };
        },
    ) {
        if (ownership?.profileOwned !== true)
            throw new CaptureStorageError(
                'busy',
                'Console storage requires installation-profile ownership.',
            );
        await directory(path.resolve(profile));
        const root = path.join(path.resolve(profile), 'console-captures-v2'),
            key = normalized(root);
        if (owners.has(key))
            throw new CaptureStorageError('busy', 'Console repository is already owned.');
        owners.add(key);
        try {
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            await directory(root);
            const store = new NativeConsoleJournal(root, key, ownership.diagnostic);
            const entries = await fs.opendir(root);
            for await (const entry of entries)
                if (/^\.deleting-[a-f0-9-]{36}$/.test(entry.name)) {
                    validId(entry.name.slice('.deleting-'.length));
                    await store.finishDeletion(path.join(root, entry.name));
                }
            return store;
        } catch (error) {
            owners.delete(key);
            throw storageError(error);
        }
    }
    get resourceClosed() {
        return this.closed;
    }
    get snapshot() {
        return this.meta ? structuredClone(this.meta) : null;
    }
    private check() {
        if (this.closed || this.closing)
            throw new CaptureStorageError('busy', 'Console repository is closing or closed.');
    }
    private exclusive<T>(run: () => Promise<T>, allowBroken = false): Promise<T> {
        this.check();
        if (this.broken && !allowBroken) throw this.broken;
        if (this.operation)
            throw new CaptureStorageError(
                'busy',
                'Await the current console persistence operation.',
            );
        const task = run().catch((error) => {
            this.broken ??= storageError(error);
            throw this.broken;
        });
        this.operation = task;
        void task
            .finally(() => {
                if (this.operation === task) this.operation = undefined;
            })
            .catch(() => {});
        return task;
    }
    private folder(id: string) {
        validId(id);
        return path.join(this.root, id);
    }
    async begin(input: Omit<ConsoleHeader, 'schema' | 'id'>) {
        return this.exclusive(async () => {
            if (this.catalogPins)
                throw new CaptureStorageError(
                    'busy',
                    'A console export owns the catalog snapshot.',
                );
            if (this.meta)
                throw new CaptureStorageError('busy', 'This console journal already has a flow.');
            const header = consoleHeader({ ...input, schema: 2, id: randomUUID() }),
                folder = this.folder(header.id);
            await fs.mkdir(folder, { mode: 0o700 });
            await directory(folder);
            await writeJson(path.join(folder, 'header.json'), header);
            this.raw = await regular(path.join(folder, 'raw.jsonl'), true, true);
            const meta: ConsoleSnapshot = {
                schema: 2,
                header,
                state: 'active',
                offset: 0,
                ...counts(this.cursor),
                finalizedAt: null,
                reason: null,
                observedBytes: 0,
                failure: null,
                shellClosed: false,
            };
            await writeJson(path.join(folder, 'meta.json'), meta);
            this.meta = meta;
            return structuredClone(meta);
        });
    }
    private commit(records: Iterable<ConsoleRecord>) {
        return this.diagnostic
            ? this.diagnostic.measure('journal', () => this.commitOwned(records))
            : this.commitOwned(records);
    }
    private async commitOwned(records: Iterable<ConsoleRecord>) {
        if (!this.meta || !this.raw || this.meta.state !== 'active')
            throw new CaptureStorageError('busy', 'Console journal is not writable.');
        const next = structuredClone(this.cursor);
        let offset = this.meta.offset;
        for (const record of records) {
            const valid = applyConsoleRecord(next, record, this.meta.header),
                line = Buffer.from(JSON.stringify(valid) + '\n');
            integer(line.length, 1, CAPTURE_STORAGE.metadataBytes);
            await writeAll(this.raw, line, offset);
            offset += line.length;
            integer(offset);
        }
        if (next.pendingObservation)
            throw new CaptureStorageError(
                'integrity',
                'An observation must commit its complete byte range.',
            );
        await this.raw.sync();
        const meta = { ...this.meta, offset, ...counts(next), observedBytes: next.bytes };
        await writeJson(path.join(this.folder(meta.header.id), 'meta.json'), meta, true);
        this.cursor = next;
        this.meta = meta;
    }
    async start(input: ConsoleSegment, at: string) {
        return this.exclusive(async () => {
            const segment = consoleSegment(input),
                before = { offset: this.meta?.offset ?? 0, cursor: structuredClone(this.cursor) },
                index = this.cursor.segments;
            if (
                segment.kind === 'command' &&
                this.cursor.active?.segment.kind === 'context' &&
                this.cursor.active.segment.phase === 'idle'
            ) {
                await this.commit([
                    {
                        schema: 2,
                        kind: 'preparation',
                        sequence: this.cursor.records,
                        index,
                        at,
                        segment,
                    },
                ]);
                return index;
            }
            await this.commit([
                {
                    schema: 2,
                    kind: 'segment-start',
                    sequence: this.cursor.records,
                    index,
                    at,
                    segment,
                },
            ]);
            this.activeStart = before;
            return index;
        });
    }
    async inputSent(at: string) {
        return this.exclusive(async () => {
            const prepared = this.cursor.preparing,
                contextIndex = this.cursor.active?.index;
            if (!prepared || contextIndex === undefined || !this.activeStart)
                throw new CaptureStorageError(
                    'integrity',
                    'No durable command preparation is available.',
                );
            // Implicitly sealing idle must verify its existing prefix before moving the fence.
            await this.verify(this.activeStart.offset, this.activeStart.cursor);
            const before = { offset: this.meta?.offset ?? 0, cursor: structuredClone(this.cursor) };
            await this.commit([
                {
                    schema: 2,
                    kind: 'segment-start',
                    sequence: this.cursor.records,
                    index: prepared.index,
                    at,
                    segment: prepared.segment,
                    inputSent: {
                        preparation: prepared.sequence,
                        contextIndex,
                        disposition: 'write-dispatched',
                    },
                },
            ]);
            this.activeStart = before;
        });
    }
    async discardPreparation(
        reason: 'cancelled' | 'timeout' | 'transport-error' | 'storage-error',
        at: string,
    ) {
        return this.exclusive(async () => {
            const prepared = this.cursor.preparing;
            if (!prepared)
                throw new CaptureStorageError('integrity', 'No unsent preparation exists.');
            await this.commit([
                {
                    schema: 2,
                    kind: 'preparation-end',
                    sequence: this.cursor.records,
                    index: prepared.index,
                    at,
                    reason,
                },
            ]);
        });
    }
    async observe(input: Uint8Array, receivedAt: string, origin: 'channel' | 'extended') {
        if (!(input instanceof Uint8Array))
            throw new CaptureStorageError('invalid', 'Invalid PTY observation.');
        integer(input.length, 1, CAPTURE_STORAGE.backlogBytes);
        const bytes = Uint8Array.from(input);
        return this.exclusive(async () => {
            const index = this.cursor.active?.index;
            if (index === undefined)
                throw new CaptureStorageError(
                    'integrity',
                    'PTY output has no typed context/command segment.',
                );
            const observation = this.cursor.observations;
            let sequence = this.cursor.records;
            function* records(): Generator<ConsoleRecord> {
                for (let offset = 0; offset < bytes.length; offset += CAPTURE_STORAGE.frameBytes) {
                    const part = bytes.subarray(offset, offset + CAPTURE_STORAGE.frameBytes);
                    yield {
                        schema: 2,
                        kind: 'observation',
                        sequence: sequence++,
                        index: index!,
                        observation,
                        receivedAt,
                        stream: 'pty',
                        origin,
                        offset,
                        totalBytes: bytes.length,
                        base64: bytesBase64(part),
                        crc32: frameCrc(part),
                    };
                }
            }
            await this.commit(records());
        });
    }
    private async *records(h: FileHandle, from: number, to: number): AsyncGenerator<unknown> {
        const size = (await h.stat()).size;
        if (size < to)
            throw new CaptureStorageError(
                'integrity',
                'Console journal is shorter than its committed prefix.',
            );
        const bytes = Buffer.alloc(CAPTURE_STORAGE.frameBytes),
            decoder = new TextDecoder('utf8', { fatal: true });
        let position = from,
            pending = '';
        while (position < to) {
            const r = await h.read(bytes, 0, Math.min(bytes.length, to - position), position);
            if (!r.bytesRead)
                throw new CaptureStorageError('integrity', 'Console read made no progress.');
            position += r.bytesRead;
            pending += decoder.decode(bytes.subarray(0, r.bytesRead), { stream: true });
            for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
                const line = pending.slice(0, end);
                integer(
                    new TextEncoder().encode(line + '\n').length,
                    1,
                    CAPTURE_STORAGE.metadataBytes,
                );
                pending = pending.slice(end + 1);
                yield JSON.parse(line);
            }
            if (pending.length > CAPTURE_STORAGE.metadataBytes)
                throw new CaptureStorageError('integrity', 'Oversized console journal record.');
        }
        pending += decoder.decode();
        if (pending)
            throw new CaptureStorageError('integrity', 'Console journal ended inside a record.');
    }
    private async verify(from = 0, before = newConsoleCursor()) {
        if (!this.meta || !this.raw)
            throw new CaptureStorageError('busy', 'Console journal unavailable.');
        const cursor = structuredClone(before);
        for await (const record of this.records(this.raw, from, this.meta.offset))
            applyConsoleRecord(cursor, record, this.meta.header);
        if (JSON.stringify(cursor) !== JSON.stringify(this.cursor))
            throw new CaptureStorageError(
                'integrity',
                'Console checkpoint counters or boundaries differ.',
            );
    }
    async end(reason: ConsoleCompletionReason, match: ConsoleMatch | null, at: string) {
        return this.exclusive(async () => {
            const index = this.cursor.active?.index;
            if (index === undefined || !this.activeStart)
                throw new CaptureStorageError('integrity', 'No active console segment.');
            await this.verify(this.activeStart.offset, this.activeStart.cursor);
            await this.commit([
                {
                    schema: 2,
                    kind: 'segment-end',
                    sequence: this.cursor.records,
                    index,
                    at,
                    reason,
                    match,
                },
            ]);
            this.activeStart = undefined;
        });
    }
    async outcome(
        completion: Exclude<ConsoleCompletionReason, 'ready' | 'idle-boundary' | 'closed'>,
        match: ConsoleMatch | null,
        at: string,
    ) {
        return this.exclusive(async () => {
            const index = this.cursor.pendingOutcome?.index;
            if (index === undefined)
                throw new CaptureStorageError(
                    'integrity',
                    'No sealed console command awaits its outcome.',
                );
            await this.commit([
                {
                    schema: 2,
                    kind: 'outcome',
                    sequence: this.cursor.records,
                    index,
                    at,
                    completion,
                    exitCode: null,
                    match,
                },
            ]);
        });
    }
    async finish(
        reason: 'complete' | 'cancelled' | 'timeout' | 'transport-error',
        observedBytes: number,
        shellClosed: true,
    ) {
        return this.exclusive(async () => {
            if (!this.meta || shellClosed !== true)
                throw new CaptureStorageError(
                    'integrity',
                    'Console cleanup has not acknowledged channel closure.',
                );
            completeConsoleCursor(this.cursor);
            await this.verify();
            integer(observedBytes, this.cursor.bytes);
            if (reason === 'complete' && observedBytes !== this.cursor.bytes)
                throw new CaptureStorageError(
                    'integrity',
                    'Complete console capture requires retained bytes to equal observed bytes.',
                );
            const meta: ConsoleSnapshot = {
                ...this.meta,
                state: reason === 'complete' ? 'complete' : 'incomplete',
                reason,
                observedBytes,
                shellClosed: true,
                finalizedAt: new Date().toISOString(),
            };
            await writeJson(path.join(this.folder(meta.header.id), 'meta.json'), meta, true);
            this.meta = meta;
            return structuredClone(meta);
        });
    }
    async fail(observedBytes: number | null, error: CaptureStorageError, shellClosed?: true) {
        return this.exclusive(async () => {
            if (!this.meta) return;
            if (observedBytes !== null) integer(observedBytes, this.meta.bytes);
            const meta: ConsoleSnapshot = {
                ...this.meta,
                state: 'incomplete',
                reason: 'storage-error',
                observedBytes,
                finalizedAt: new Date().toISOString(),
                failure: { code: error.code, message: error.message },
                shellClosed: shellClosed === true,
            };
            await writeJson(path.join(this.folder(meta.header.id), 'meta.json'), meta, true);
            this.meta = meta;
        }, true);
    }
    async *read(
        id: string,
    ): AsyncGenerator<
        { kind: 'metadata'; capture: ConsoleSnapshot } | { kind: 'record'; record: ConsoleRecord }
    > {
        this.check();
        const folder = this.folder(id);
        if (this.deleting.has(id))
            throw new CaptureStorageError('busy', 'Console deletion is pending.');
        this.readerCount++;
        this.readPins.set(id, (this.readPins.get(id) ?? 0) + 1);
        let handle: FileHandle | undefined;
        try {
            await directory(folder);
            const local = this.meta?.header.id === id;
            const meta = local
                    ? structuredClone(this.meta!)
                    : snapshot(await readJson(path.join(folder, 'meta.json')), id),
                header = consoleHeader(await readJson(path.join(folder, 'header.json')));
            if (JSON.stringify(header) !== JSON.stringify(meta.header))
                throw new CaptureStorageError('integrity', 'Console immutable header differs.');
            handle = await regular(path.join(folder, 'raw.jsonl'));
            const cursor = newConsoleCursor();
            const effective =
                meta.state === 'active' && !local
                    ? {
                          ...meta,
                          state: 'incomplete' as const,
                          reason: 'interrupted',
                          observedBytes: null,
                      }
                    : meta;
            yield { kind: 'metadata', capture: effective };
            for await (const raw of this.records(handle, 0, meta.offset))
                yield { kind: 'record', record: applyConsoleRecord(cursor, raw, header) };
            if (
                JSON.stringify(counts(cursor)) !==
                    JSON.stringify({
                        records: meta.records,
                        bytes: meta.bytes,
                        observations: meta.observations,
                        segments: meta.segments,
                    }) ||
                cursor.pendingObservation
            )
                throw new CaptureStorageError(
                    'integrity',
                    'Console retained prefix counters differ.',
                );
            if (meta.state === 'complete') completeConsoleCursor(cursor);
        } finally {
            await handle?.close();
            const pins = (this.readPins.get(id) ?? 1) - 1;
            if (pins) this.readPins.set(id, pins);
            else this.readPins.delete(id);
            this.readerCount--;
            if (!this.readerCount) this.readersReleased?.();
        }
    }
    async list(after?: string, limit = 25) {
        this.check();
        const bounds = consoleArchiveBounds(after, limit);
        if (this.deleting.size)
            throw new CaptureStorageError('busy', 'Console cleanup is pending; retry the catalog.');
        this.listing++;
        this.readerCount++;
        try {
            await directory(this.root);
            const ids: string[] = [];
            const entries = await fs.opendir(this.root);
            for await (const entry of entries) {
                if (!/^[a-f0-9-]{36}$/.test(entry.name)) continue;
                validId(entry.name);
                if (bounds.after && entry.name <= bounds.after) continue;
                const index = ids.findIndex((id) => id > entry.name);
                ids.splice(index < 0 ? ids.length : index, 0, entry.name);
                if (ids.length > bounds.limit + 1) ids.pop();
            }
            const captures: ConsoleSnapshot[] = [];
            for (const id of ids.slice(0, bounds.limit)) {
                const folder = this.folder(id);
                await directory(folder);
                const local = this.meta?.header.id === id;
                const meta = local
                    ? structuredClone(this.meta!)
                    : snapshot(await readJson(path.join(folder, 'meta.json')), id);
                const header = consoleHeader(await readJson(path.join(folder, 'header.json')));
                if (JSON.stringify(header) !== JSON.stringify(meta.header))
                    throw new CaptureStorageError('integrity', 'Console immutable header differs.');
                captures.push(
                    meta.state === 'active' && !local
                        ? {
                              ...meta,
                              state: 'incomplete',
                              reason: 'interrupted',
                              observedBytes: null,
                          }
                        : meta,
                );
            }
            return {
                captures,
                next: ids.length > bounds.limit ? captures.at(-1)!.header.id : null,
                mode: 'scan' as const,
            };
        } finally {
            this.listing--;
            this.readerCount--;
            if (!this.readerCount) this.readersReleased?.();
        }
    }
    async pin() {
        this.check();
        if (this.deleting.size)
            throw new CaptureStorageError('busy', 'Console deletion is pending.');
        this.catalogPins++;
        this.readerCount++;
        let released = false;
        return {
            release: async () => {
                if (released) return;
                released = true;
                this.catalogPins--;
                this.readerCount--;
                if (!this.readerCount) this.readersReleased?.();
            },
        };
    }
    private async deletionFiles(folder: string) {
        await directory(folder);
        const names: string[] = [],
            entries = await fs.opendir(folder);
        for await (const entry of entries) {
            if (
                !['header.json', 'meta.json', 'raw.jsonl'].includes(entry.name) &&
                !/^meta-[a-f0-9-]{36}\.tmp$/.test(entry.name)
            )
                throw new CaptureStorageError(
                    'integrity',
                    'Console directory contains an unknown file; deletion refused.',
                );
            names.push(entry.name);
            if (names.length > 1024)
                throw new CaptureStorageError(
                    'integrity',
                    'Excessive console temporary files require inspection.',
                );
            const handle = await regular(path.join(folder, entry.name));
            await handle.close();
        }
        return names;
    }
    private async finishDeletion(folder: string) {
        const names = await this.deletionFiles(folder);
        for (const name of names) {
            const file = path.join(folder, name),
                handle = await regular(file);
            await handle.close();
            await fs.unlink(file);
        }
        await fs.rmdir(folder);
    }
    async delete(id: string) {
        this.check();
        validId(id);
        if (
            this.meta?.header.id === id ||
            this.readPins.has(id) ||
            this.deleting.has(id) ||
            this.listing ||
            this.catalogPins
        )
            throw new CaptureStorageError(
                'busy',
                'An active console, reader or catalog owns this capture.',
            );
        this.deleting.add(id);
        this.readerCount++;
        try {
            const folder = this.folder(id),
                tombstone = path.join(this.root, '.deleting-' + id);
            await this.deletionFiles(folder);
            await fs.rename(folder, tombstone);
            await this.finishDeletion(tombstone);
        } finally {
            this.deleting.delete(id);
            this.readerCount--;
            if (!this.readerCount) this.readersReleased?.();
        }
    }
    close(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.closing) return this.closing;
        const task = (async () => {
            await this.operation?.catch(() => {});
            await this.raw?.close();
            this.raw = undefined;
            if (this.readerCount)
                await new Promise<void>((resolve) => (this.readersReleased = resolve));
            this.closed = true;
            owners.delete(this.key);
        })();
        this.closing = task;
        void task.catch(() => {
            if (this.closing === task) this.closing = undefined;
        });
        return task;
    }
}
