import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    bytesBase64,
    frameCrc,
    integer,
    storageError,
    validId,
} from '../../../../shared/capture-store';
import {
    applyConsoleRecord,
    completeConsoleCursor,
    consoleHeader,
    consoleSegment,
    newConsoleCursor,
    type ConsoleCursor,
    type ConsoleHeader,
    type ConsoleMatch,
    type ConsoleRecord,
    type ConsoleRepository,
    type ConsoleSegment,
    type ConsoleSnapshot,
} from '../../../../shared/console-journal';
import {
    consoleArchiveBounds,
    consoleSnapshot,
    type ConsoleArchive,
    type ConsoleRead,
} from '../../../../shared/console-storage';

type Lease = { release(): Promise<void> };
async function lease(name: string, mode: 'shared' | 'exclusive'): Promise<Lease> {
    if (!navigator.locks)
        throw new CaptureStorageError('unsupported', 'Cross-tab console ownership is unavailable.');
    let release!: () => void, granted!: (value: Lease) => void, denied!: (error: unknown) => void;
    const held = new Promise<void>((r) => {
            release = r;
        }),
        ready = new Promise<Lease>((a, b) => {
            granted = a;
            denied = b;
        });
    const task = navigator.locks.request(name, { mode, ifAvailable: true }, async (lock) => {
        if (!lock) {
            denied(
                new CaptureStorageError(
                    'busy',
                    'Console storage is owned by another run, reader or tab.',
                ),
            );
            return;
        }
        granted({
            release: async () => {
                release();
                await task;
            },
        });
        await held;
    });
    void task.catch(denied);
    return ready;
}
function request<T>(r: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(storageError(r.error));
    });
}
function completed(tx: IDBTransaction) {
    return new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(storageError(tx.error ?? Error('Console transaction aborted.')));
        tx.onerror = () => {};
    });
}
const counts = (c: ConsoleCursor) => ({
    records: c.records,
    bytes: c.bytes,
    observations: c.observations,
    segments: c.segments,
});
type Envelope = { id: string; snapshot: ConsoleSnapshot };
function envelope(input: unknown): ConsoleSnapshot {
    const value = input as Envelope;
    if (!value || Object.keys(value).some((k) => !['id', 'snapshot'].includes(k)))
        throw new CaptureStorageError('integrity', 'Invalid browser console metadata.');
    const snapshot = consoleSnapshot(value.snapshot);
    if (snapshot.header.id !== value.id)
        throw new CaptureStorageError('integrity', 'Console metadata identity differs.');
    return snapshot;
}
/** Separate v2 database. Commit completion, not a request callback, acknowledges every operation. */
export class IndexedDbConsoleJournal implements ConsoleRepository, ConsoleArchive {
    private meta: ConsoleSnapshot | null = null;
    private cursor = newConsoleCursor();
    private activeStart?: { cursor: ConsoleCursor; offset: number };
    private operation?: Promise<unknown>;
    private closing?: Promise<void>;
    private ended = false;
    private unavailable = false;
    private broken?: CaptureStorageError;
    private writer?: Lease;
    private captureWriter?: Lease;
    private activity?: Lease;
    private transactions = new Set<Promise<void>>();
    private readers = 0;
    private readersReleased?: () => void;
    private constructor(
        private db: IDBDatabase,
        private name: string,
    ) {
        db.onversionchange = () => {
            this.unavailable = true;
            db.close();
            void this.close().catch(() => {});
        };
    }
    static async open(name = 'diagnostic-hub-console-v2') {
        if (!globalThis.isSecureContext || !globalThis.indexedDB || !navigator.locks)
            throw new CaptureStorageError(
                'unsupported',
                'Console storage requires a secure origin, IndexedDB and cross-tab ownership.',
            );
        if (!/^diagnostic-hub-console(?:-test-[a-z0-9-]{1,64})?-v2$/.test(name))
            throw new CaptureStorageError('invalid', 'Unsupported console database name.');
        const opening = indexedDB.open(name, 1);
        let failure: unknown;
        opening.onupgradeneeded = (e) => {
            try {
                if ((e as IDBVersionChangeEvent).oldVersion !== 0)
                    throw Error('Unsupported console migration; existing data retained.');
                opening.result.createObjectStore('captures', { keyPath: 'id' });
                opening.result.createObjectStore('records');
            } catch (error) {
                failure = error;
                opening.transaction!.abort();
            }
        };
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            let rejected = false;
            opening.onsuccess = () => {
                if (rejected) opening.result.close();
                else resolve(opening.result);
            };
            opening.onerror = () =>
                reject(
                    new CaptureStorageError(
                        opening.error?.name === 'VersionError' ? 'unsupported' : 'io',
                        String(failure ?? opening.error ?? 'Console database unavailable.'),
                    ),
                );
            opening.onblocked = () => {
                rejected = true;
                reject(
                    new CaptureStorageError('busy', 'Another tab blocks console database access.'),
                );
            };
        });
        if (
            db.objectStoreNames.length !== 2 ||
            !['captures', 'records'].every((k) => db.objectStoreNames.contains(k))
        ) {
            db.close();
            throw new CaptureStorageError(
                'unsupported',
                'Existing console database schema differs.',
            );
        }
        const tx = db.transaction(['captures', 'records'], 'readonly'),
            done = completed(tx);
        if (
            tx.objectStore('captures').keyPath !== 'id' ||
            tx.objectStore('captures').autoIncrement ||
            tx.objectStore('records').keyPath !== null ||
            tx.objectStore('records').autoIncrement
        ) {
            tx.abort();
            await done.catch(() => {});
            db.close();
            throw new CaptureStorageError('integrity', 'Existing console database keys differ.');
        }
        await done;
        return new IndexedDbConsoleJournal(db, name);
    }
    get resourceClosed() {
        return this.ended;
    }
    get snapshot() {
        return this.meta ? structuredClone(this.meta) : null;
    }
    private check() {
        if (this.unavailable || this.ended || this.closing)
            throw new CaptureStorageError('io', 'Console database is closing or closed.');
    }
    private exclusive<T>(work: () => Promise<T>, allowBroken = false) {
        this.check();
        if (this.operation)
            throw new CaptureStorageError('busy', 'Await current console persistence.');
        if (this.broken && !allowBroken) throw this.broken;
        const task = Promise.resolve()
            .then(work)
            .catch((error) => {
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
    private async transaction<T>(
        mode: IDBTransactionMode,
        work: (tx: IDBTransaction) => Promise<T>,
    ) {
        if (this.unavailable || this.ended)
            throw new CaptureStorageError('io', 'Console database is unavailable.');
        const tx = this.db.transaction(['captures', 'records'], mode),
            done = completed(tx);
        this.transactions.add(done);
        void done.catch(() => {});
        try {
            const result = await work(tx);
            await done;
            if (this.unavailable)
                throw new CaptureStorageError(
                    'io',
                    'Console database closed before acknowledgement.',
                );
            return result;
        } catch (error) {
            try {
                tx.abort();
            } catch {}
            await done.catch(() => {});
            throw storageError(error);
        } finally {
            this.transactions.delete(done);
        }
    }
    async begin(input: Omit<ConsoleHeader, 'schema' | 'id'>) {
        return this.exclusive(async () => {
            if (this.meta)
                throw new CaptureStorageError('busy', 'This console writer already has a flow.');
            const writer = await lease(this.name + ':writer', 'exclusive');
            this.writer = writer;
            this.check();
            const header = consoleHeader({ ...input, schema: 2, id: crypto.randomUUID() });
            this.captureWriter = await lease(this.name + ':capture:' + header.id, 'shared');
            this.activity = await lease(this.name + ':active:' + header.id, 'exclusive');
            this.check();
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
            const catalog = await lease(this.name + ':catalog', 'exclusive');
            try {
                this.check();
                await this.transaction('readwrite', async (tx) => {
                    await request(
                        tx.objectStore('captures').add({ id: header.id, snapshot: meta }),
                    );
                });
            } finally {
                await catalog.release();
            }
            this.check();
            this.meta = meta;
            return structuredClone(meta);
        });
    }
    private async commit(records: Iterable<ConsoleRecord>) {
        if (!this.meta || this.meta.state !== 'active')
            throw new CaptureStorageError('busy', 'Console journal is not writable.');
        const next = structuredClone(this.cursor),
            id = this.meta.header.id;
        let offset = this.meta.offset;
        const meta = await this.transaction('readwrite', async (tx) => {
            const queued: Promise<unknown>[] = [];
            for (const r of records) {
                const record = applyConsoleRecord(next, r, this.meta!.header);
                offset += new TextEncoder().encode(JSON.stringify(record) + '\n').length;
                queued.push(request(tx.objectStore('records').add(record, [id, record.sequence])));
            }
            if (next.pendingObservation)
                throw new CaptureStorageError(
                    'integrity',
                    'Console observation must commit its complete range.',
                );
            const snapshot = { ...this.meta!, offset, ...counts(next), observedBytes: next.bytes };
            queued.push(request(tx.objectStore('captures').put({ id, snapshot })));
            await Promise.all(queued);
            return snapshot;
        });
        this.cursor = next;
        this.meta = meta;
    }
    async start(input: ConsoleSegment, at: string) {
        return this.exclusive(async () => {
            const segment = consoleSegment(input),
                before = { cursor: structuredClone(this.cursor), offset: this.meta?.offset ?? 0 },
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
                throw new CaptureStorageError('integrity', 'No durable console preparation.');
            await this.verify(this.activeStart);
            const before = { cursor: structuredClone(this.cursor), offset: this.meta?.offset ?? 0 };
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
        reason: Parameters<ConsoleRepository['discardPreparation']>[0],
        at: string,
    ) {
        return this.exclusive(async () => {
            const prepared = this.cursor.preparing;
            if (!prepared)
                throw new CaptureStorageError('integrity', 'No unsent console preparation.');
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
            throw new CaptureStorageError('invalid', 'Invalid PTY bytes.');
        integer(input.length, 1, CAPTURE_STORAGE.backlogBytes);
        const bytes = Uint8Array.from(input);
        return this.exclusive(async () => {
            const index = this.cursor.active?.index;
            if (index === undefined)
                throw new CaptureStorageError('integrity', 'PTY output has no active segment.');
            let sequence = this.cursor.records;
            const observation = this.cursor.observations;
            function* records(): Generator<ConsoleRecord> {
                for (let offset = 0; offset < bytes.length; offset += CAPTURE_STORAGE.frameBytes) {
                    const part = bytes.subarray(offset, offset + CAPTURE_STORAGE.frameBytes);
                    yield {
                        schema: 2,
                        kind: 'observation',
                        sequence: sequence++,
                        index: index!,
                        observation,
                        stream: 'pty',
                        origin,
                        receivedAt,
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
    private async *records(id: string, from: number, to: number) {
        let sequence = from;
        while (sequence < to) {
            const rows = (await this.transaction('readonly', (tx) =>
                request(
                    tx
                        .objectStore('records')
                        .getAll(IDBKeyRange.bound([id, sequence], [id, to - 1]), 8),
                ),
            )) as ConsoleRecord[];
            if (!rows.length)
                throw new CaptureStorageError('integrity', 'Console record range is missing.');
            for (const row of rows) {
                if (row.sequence !== sequence++)
                    throw new CaptureStorageError('integrity', 'Console record range differs.');
                yield row;
            }
        }
    }
    private async verify(before = { cursor: newConsoleCursor(), offset: 0 }) {
        if (!this.meta) throw new CaptureStorageError('busy', 'Console journal unavailable.');
        const cursor = structuredClone(before.cursor);
        let offset = before.offset;
        for await (const r of this.records(
            this.meta.header.id,
            before.cursor.records,
            this.cursor.records,
        )) {
            const record = applyConsoleRecord(cursor, r, this.meta.header);
            offset += new TextEncoder().encode(JSON.stringify(record) + '\n').length;
        }
        if (offset !== this.meta.offset || JSON.stringify(cursor) !== JSON.stringify(this.cursor))
            throw new CaptureStorageError('integrity', 'Console checkpoint counters differ.');
    }
    async end(
        reason: Parameters<ConsoleRepository['end']>[0],
        match: ConsoleMatch | null,
        at: string,
    ) {
        return this.exclusive(async () => {
            if (!this.activeStart)
                throw new CaptureStorageError('integrity', 'Console segment has no start.');
            await this.verify(this.activeStart);
            const index = this.cursor.active?.index;
            if (index === undefined)
                throw new CaptureStorageError('integrity', 'Console has no active segment.');
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
        completion: Parameters<ConsoleRepository['outcome']>[0],
        match: ConsoleMatch | null,
        at: string,
    ) {
        return this.exclusive(async () => {
            const index = this.cursor.pendingOutcome?.index;
            if (index === undefined)
                throw new CaptureStorageError('integrity', 'Console has no pending outcome.');
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
        reason: Parameters<ConsoleRepository['finish']>[0],
        observedBytes: number,
        shellClosed: true,
    ) {
        return this.exclusive(async () => {
            if (!this.meta || shellClosed !== true)
                throw new CaptureStorageError('integrity', 'Console cleanup was not acknowledged.');
            completeConsoleCursor(this.cursor);
            await this.verify();
            integer(observedBytes, this.cursor.bytes);
            const meta: ConsoleSnapshot = {
                ...this.meta,
                state: reason === 'complete' ? 'complete' : 'incomplete',
                reason,
                observedBytes,
                shellClosed: true,
                finalizedAt: new Date().toISOString(),
            };
            consoleSnapshot(meta);
            await this.transaction('readwrite', async (tx) => {
                await request(
                    tx.objectStore('captures').put({ id: meta.header.id, snapshot: meta }),
                );
            });
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
                shellClosed: shellClosed === true,
                finalizedAt: new Date().toISOString(),
                failure: { code: error.code, message: error.message },
            };
            await this.transaction('readwrite', async (tx) => {
                await request(
                    tx.objectStore('captures').put({ id: meta.header.id, snapshot: meta }),
                );
            });
            this.meta = meta;
        }, true);
    }
    async list(after?: string, limit = 25) {
        this.check();
        const bounds = consoleArchiveBounds(after, limit);
        this.readers++;
        try {
            const rows = (await this.transaction('readonly', (tx) =>
                request(
                    tx
                        .objectStore('captures')
                        .getAll(
                            bounds.after ? IDBKeyRange.lowerBound(bounds.after, true) : undefined,
                            bounds.limit + 1,
                        ),
                ),
            )) as Envelope[];
            const captures = await Promise.all(
                rows.slice(0, bounds.limit).map(async (row) => {
                    const meta = envelope(row);
                    if (meta.state !== 'active') return meta;
                    const active = await navigator.locks.request(
                        this.name + ':active:' + meta.header.id,
                        { mode: 'shared', ifAvailable: true },
                        (lock) => !lock,
                    );
                    return active
                        ? meta
                        : {
                              ...meta,
                              state: 'incomplete' as const,
                              reason: 'interrupted',
                              observedBytes: null,
                          };
                }),
            );
            return {
                captures,
                next: rows.length > bounds.limit ? captures.at(-1)!.header.id : null,
                mode: 'indexed' as const,
            };
        } finally {
            this.readers--;
            if (!this.readers) this.readersReleased?.();
        }
    }
    async *read(id: string): AsyncGenerator<ConsoleRead> {
        this.check();
        validId(id);
        this.readers++;
        let owned: Lease | undefined;
        try {
            owned = await lease(this.name + ':capture:' + id, 'shared');
            this.check();
            const row = await this.transaction('readonly', (tx) =>
                request(tx.objectStore('captures').get(id)),
            );
            if (!row) throw new CaptureStorageError('io', 'Saved console capture is missing.');
            const meta = envelope(row),
                cursor = newConsoleCursor();
            const active =
                meta.state === 'active' &&
                (await navigator.locks.request(
                    this.name + ':active:' + id,
                    { mode: 'shared', ifAvailable: true },
                    (lock) => !lock,
                ));
            yield {
                kind: 'metadata',
                capture:
                    meta.state === 'active' && !active
                        ? {
                              ...meta,
                              state: 'incomplete',
                              reason: 'interrupted',
                              observedBytes: null,
                          }
                        : meta,
            };
            let offset = 0;
            for await (const raw of this.records(id, 0, meta.records)) {
                const record = applyConsoleRecord(cursor, raw, meta.header);
                offset += new TextEncoder().encode(JSON.stringify(record) + '\n').length;
                yield { kind: 'record', record };
            }
            if (
                JSON.stringify(counts(cursor)) !==
                    JSON.stringify({
                        records: meta.records,
                        bytes: meta.bytes,
                        observations: meta.observations,
                        segments: meta.segments,
                    }) ||
                cursor.pendingObservation ||
                offset !== meta.offset
            )
                throw new CaptureStorageError('integrity', 'Retained console prefix differs.');
            if (meta.state === 'complete') completeConsoleCursor(cursor);
        } finally {
            await owned?.release();
            this.readers--;
            if (!this.readers) this.readersReleased?.();
        }
    }
    async pin() {
        this.check();
        this.readers++;
        let catalog: Lease | undefined;
        try {
            catalog = await lease(this.name + ':catalog', 'shared');
            this.check();
        } catch (error) {
            await catalog?.release();
            this.readers--;
            if (!this.readers) this.readersReleased?.();
            throw error;
        }
        let released = false;
        return {
            release: async () => {
                if (released) return;
                released = true;
                await catalog!.release();
                this.readers--;
                if (!this.readers) this.readersReleased?.();
            },
        };
    }
    async delete(id: string) {
        this.check();
        validId(id);
        this.readers++;
        let owned: Lease | undefined, catalog: Lease | undefined;
        try {
            catalog = await lease(this.name + ':catalog', 'exclusive');
            owned = await lease(this.name + ':capture:' + id, 'exclusive');
            this.check();
            await this.transaction('readwrite', async (tx) => {
                await Promise.all([
                    request(tx.objectStore('captures').delete(id)),
                    request(
                        tx
                            .objectStore('records')
                            .delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
                    ),
                ]);
            });
        } finally {
            await owned?.release();
            await catalog?.release();
            this.readers--;
            if (!this.readers) this.readersReleased?.();
        }
    }
    close(): Promise<void> {
        if (this.ended) return Promise.resolve();
        if (this.closing) return this.closing;
        const task = (async () => {
            await this.operation?.catch(() => {});
            if (this.readers)
                await new Promise<void>((resolve) => {
                    this.readersReleased = resolve;
                });
            await Promise.all([...this.transactions].map((task) => task.catch(() => {})));
            await this.activity?.release();
            this.activity = undefined;
            await this.captureWriter?.release();
            this.captureWriter = undefined;
            await this.writer?.release();
            this.writer = undefined;
            this.db.close();
            this.unavailable = true;
            this.ended = true;
        })();
        this.closing = task;
        void task.catch(() => {
            if (this.closing === task) this.closing = undefined;
        });
        return task;
    }
}
