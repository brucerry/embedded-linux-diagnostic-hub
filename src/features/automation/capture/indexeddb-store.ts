import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    appendFrames,
    boundedCapturePage,
    captureHeader,
    captureVerifier,
    failedCapture,
    interruptedCapture,
    newCapture,
    pageBounds,
    sealedCapture,
    storageError,
    storedCapture,
    validId,
    type CaptureFrame,
    type CaptureHeader,
    type CapturePage,
    type CaptureRead,
    type CaptureRepository,
    type StoredCapture,
} from '../../../../shared/capture-store';
import { automationOutcome, type AutomationOutcome } from '../../../../shared/automation-result';

type Lease = { release(): Promise<void> };
async function lease(name: string, mode: 'shared' | 'exclusive'): Promise<Lease> {
    if (!navigator.locks)
        throw new CaptureStorageError('unsupported', 'Cross-tab capture ownership is unavailable.');
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => {
        unlock = resolve;
    });
    let granted!: (lease: Lease) => void, denied!: (reason: unknown) => void;
    const ready = new Promise<Lease>((resolve, reject) => {
        granted = resolve;
        denied = reject;
    });
    const request = navigator.locks.request(name, { mode, ifAvailable: true }, async (lock) => {
        if (!lock) {
            denied(
                new CaptureStorageError(
                    'busy',
                    'Capture storage is owned by another operation or tab.',
                ),
            );
            return;
        }
        granted({
            release: async () => {
                unlock();
                await request;
            },
        });
        await held;
    });
    void request.catch(denied);
    return ready;
}
function request<T>(input: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        input.onsuccess = () => resolve(input.result);
        input.onerror = () => reject(input.error);
    });
}
function completed(tx: IDBTransaction) {
    return new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(storageError(tx.error ?? Error('Capture transaction aborted.')));
        tx.onerror = () => {};
    });
}
function captureSchema(db: IDBDatabase, tx: IDBTransaction, outcomes = true) {
    for (const name of outcomes
        ? ['captures', 'frames', 'settings', 'results']
        : ['captures', 'frames', 'settings']) {
        if (!db.objectStoreNames.contains(name))
            throw new CaptureStorageError(
                'integrity',
                'Stored capture database structure is unsupported; existing data was retained.',
            );
        const store = tx.objectStore(name);
        if (store.autoIncrement || store.keyPath !== (name === 'captures' ? 'id' : null))
            throw new CaptureStorageError(
                'integrity',
                'Stored capture keys are incompatible; existing data was retained.',
            );
    }
    const captures = tx.objectStore('captures');
    if (!captures.indexNames.contains('sequence'))
        throw new CaptureStorageError(
            'integrity',
            'Stored capture ordering index is missing; existing data was retained.',
        );
    const index = captures.index('sequence');
    if (index.keyPath !== 'sequence' || !index.unique || index.multiEntry)
        throw new CaptureStorageError(
            'integrity',
            'Stored capture ordering index is incompatible; existing data was retained.',
        );
}
function verifyCommittedFrames(tx: IDBTransaction, capture: StoredCapture): Promise<void> {
    return new Promise((resolve, reject) => {
        const verifier = captureVerifier(capture),
            query = tx
                .objectStore('frames')
                .openCursor(
                    IDBKeyRange.bound([capture.id, 0], [capture.id, Number.MAX_SAFE_INTEGER]),
                );
        let index = 0;
        query.onerror = () => reject(query.error);
        query.onsuccess = () => {
            try {
                const cursor = query.result;
                if (!cursor) {
                    verifier.finish();
                    resolve();
                    return;
                }
                const key = cursor.primaryKey;
                if (
                    !Array.isArray(key) ||
                    key[0] !== capture.id ||
                    key[1] !== index ||
                    index >= capture.committedFrames
                )
                    throw new CaptureStorageError(
                        'integrity',
                        'Committed raw frame keys are missing, reordered or unexpected at seal.',
                    );
                verifier.append(cursor.value);
                index++;
                cursor.continue(); // one bounded frame at a time; never materialize the capture
            } catch (error) {
                reject(error);
            }
        };
    });
}

export class IndexedDbCaptureStore implements CaptureRepository {
    recoveryFailure?: CaptureStorageError;
    private active?: { id: string; capture: Lease; writer: Lease };
    private modifying = false;
    private closed = false;
    private opening = false;
    private initializing?: Promise<StoredCapture>;
    private operation?: Promise<StoredCapture>;
    private recording?: Promise<void>;
    private leases = new Set<Lease>();
    private reserving = 0;
    private releasing?: Promise<void>;
    private constructor(
        private db: IDBDatabase,
        private name: string,
    ) {
        db.onversionchange = () => {
            db.close();
            this.closed = true;
            this.releasing = (async () => {
                await this.initializing?.catch(() => {});
                await this.operation?.catch(() => {});
                await this.recording?.catch(() => {});
                for (const owned of [...this.leases]) await owned.release();
                this.active = undefined;
            })();
            void this.releasing.catch(() => {});
        };
    }
    private async acquire(name: string, mode: 'shared' | 'exclusive') {
        this.check();
        if (this.leases.size + this.reserving >= 32)
            throw new CaptureStorageError('busy', 'Finish another capture reader or export first.');
        this.reserving++;
        try {
            const owned = await lease(name, mode);
            if (this.closed) {
                await owned.release();
                throw new CaptureStorageError(
                    'io',
                    'Capture database closed while acquiring ownership.',
                );
            }
            let closing: Promise<void> | undefined;
            const tracked = {
                release: () =>
                    (closing ??= (async () => {
                        try {
                            await owned.release();
                        } finally {
                            this.leases.delete(tracked);
                        }
                    })()),
            };
            this.leases.add(tracked);
            return tracked;
        } finally {
            this.reserving--;
        }
    }
    static async open(name = 'diagnostic-hub-captures-v1') {
        if (!isSecureContext || !globalThis.indexedDB || !navigator.locks)
            throw new CaptureStorageError(
                'unsupported',
                'Full capture requires a secure origin, IndexedDB and cross-tab ownership.',
            );
        if (!/^diagnostic-hub-captures(?:-test-[a-f0-9-]{36})?-v1$/.test(name))
            throw new CaptureStorageError('invalid', 'Invalid capture database namespace.');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const opening = indexedDB.open(name, 2);
            let rejected = false;
            let upgradeFailure: CaptureStorageError | undefined;
            opening.onupgradeneeded = (event) => {
                try {
                    if (event.oldVersion > 0)
                        captureSchema(opening.result, opening.transaction!, false);
                    else {
                        const captures = opening.result.createObjectStore('captures', {
                            keyPath: 'id',
                        });
                        captures.createIndex('sequence', 'sequence', { unique: true });
                        for (const name of ['frames', 'settings'])
                            opening.result.createObjectStore(name);
                    }
                    if (!opening.result.objectStoreNames.contains('results'))
                        opening.result.createObjectStore('results');
                    captureSchema(opening.result, opening.transaction!);
                } catch (error) {
                    upgradeFailure = storageError(error);
                    opening.transaction!.abort();
                }
            };
            opening.onsuccess = () => {
                if (rejected) opening.result.close();
                else resolve(opening.result);
            };
            opening.onerror = () =>
                reject(
                    upgradeFailure ??
                        (opening.error?.name === 'VersionError'
                            ? new CaptureStorageError(
                                  'unsupported',
                                  'Stored captures use a newer database version. Use a newer application; existing captures were left intact.',
                              )
                            : storageError(opening.error)),
                );
            opening.onblocked = () => {
                rejected = true;
                reject(
                    new CaptureStorageError(
                        'busy',
                        'Close the older capture-store tab before upgrading.',
                    ),
                );
            };
        });
        const store = new IndexedDbCaptureStore(db, name);
        try {
            if (
                !['captures', 'frames', 'settings', 'results'].every((name) =>
                    db.objectStoreNames.contains(name),
                )
            )
                throw new CaptureStorageError(
                    'integrity',
                    'Stored capture database structure is unsupported; existing data was retained.',
                );
            captureSchema(
                db,
                db.transaction(['captures', 'frames', 'settings', 'results'], 'readonly'),
            );
            await store.recover();
            return store;
        } catch (error) {
            db.close();
            throw storageError(error);
        }
    }
    private check() {
        if (this.closed) throw new CaptureStorageError('io', 'Capture database is closed.');
    }
    private async transaction<T>(
        stores: string[],
        mode: IDBTransactionMode,
        body: (tx: IDBTransaction) => Promise<T>,
    ) {
        this.check();
        const tx = this.db.transaction(stores, mode),
            done = completed(tx);
        // Install rejection handling before requests, including validation failures that abort explicitly.
        void done.catch(() => {});
        try {
            const value = await body(tx);
            await done;
            return value;
        } catch (error) {
            try {
                tx.abort();
            } catch {}
            await done.catch(() => {});
            throw storageError(error);
        }
    }
    private lock(id: string, mode: 'shared' | 'exclusive') {
        validId(id);
        return this.acquire(this.name + ':capture:' + id, mode);
    }
    private async sequenceState(tx: IDBTransaction) {
        const saved: unknown = await request(tx.objectStore('settings').get('sequence')),
            highest = await request(
                tx.objectStore('captures').index('sequence').openKeyCursor(null, 'prev'),
            ),
            maximum = highest?.key ?? 0;
        if (!Number.isSafeInteger(maximum) || (maximum as number) < 0)
            throw new CaptureStorageError(
                'integrity',
                'Stored capture sequence is invalid; evidence was retained.',
            );
        return { saved, maximum: maximum as number };
    }
    private checkedSequence(input: unknown) {
        if (input === undefined) return 0;
        if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0)
            throw new CaptureStorageError(
                'integrity',
                'Stored capture sequence counter is invalid. Existing captures remain readable; new capture is blocked.',
            );
        return input;
    }
    private async metadata(id: string) {
        return this.transaction(['captures'], 'readonly', async (tx) => {
            const raw = await request(tx.objectStore('captures').get(id));
            if (!raw)
                throw new CaptureStorageError('integrity', 'Stored capture metadata is missing.');
            return storedCapture(raw);
        });
    }
    private mutate(
        id: string,
        transform: (input: StoredCapture) => StoredCapture,
        frames?: readonly CaptureFrame[],
    ): Promise<StoredCapture> {
        this.check();
        validId(id);
        if (this.active?.id !== id)
            throw new CaptureStorageError('busy', 'Capture writer no longer owns this record.');
        if (this.modifying)
            return Promise.reject(
                new CaptureStorageError('backlog', 'Only one capture commit may be outstanding.'),
            );
        this.modifying = true;
        const pending = (async () => {
            try {
                return await this.transaction(['captures', 'frames'], 'readwrite', async (tx) => {
                    const captures = tx.objectStore('captures'),
                        raw = await request(captures.get(id));
                    if (!raw)
                        throw new CaptureStorageError(
                            'integrity',
                            'Stored capture disappeared during commit.',
                        );
                    const before = storedCapture(raw),
                        next = storedCapture(transform(before));
                    if (next.state === 'complete') {
                        // A single readwrite transaction excludes frame mutations until
                        // verified completeness and its counters are committed together.
                        await verifyCommittedFrames(tx, before);
                    }
                    if (frames)
                        for (let i = 0; i < frames.length; i++)
                            tx.objectStore('frames').add(structuredClone(frames[i]), [
                                id,
                                before.committedFrames + i,
                            ]);
                    captures.put(next);
                    return next;
                });
            } finally {
                this.modifying = false;
                this.operation = undefined;
            }
        })();
        this.operation = pending;
        return pending;
    }
    async begin(header: CaptureHeader) {
        this.check();
        header = captureHeader(header);
        if (this.active || this.opening)
            throw new CaptureStorageError('busy', 'Finish the active capture first.');
        this.opening = true;
        const pending = this.beginCapture(header);
        this.initializing = pending;
        try {
            return await pending;
        } finally {
            if (this.initializing === pending) this.initializing = undefined;
            this.opening = false;
        }
    }
    private async beginCapture(header: CaptureHeader) {
        const writer = await this.acquire(this.name + ':writer', 'exclusive'),
            id = crypto.randomUUID();
        let capture: Lease | undefined;
        try {
            capture = await this.lock(id, 'exclusive');
            const result = await this.transaction(
                ['captures', 'settings'],
                'readwrite',
                async (tx) => {
                    const settings = tx.objectStore('settings'),
                        { saved, maximum } = await this.sequenceState(tx),
                        sequence = Math.max(this.checkedSequence(saved), maximum) + 1;
                    const next = newCapture(id, sequence, header);
                    tx.objectStore('captures').add(next);
                    settings.put(sequence, 'sequence');
                    return next;
                },
            );
            if (this.closed)
                throw new CaptureStorageError(
                    'io',
                    'Capture database closed before initialization was acknowledged; no command was sent.',
                );
            this.active = { id, capture, writer };
            return result;
        } catch (error) {
            await capture?.release();
            await writer.release();
            throw storageError(error);
        }
    }
    append(id: string, frames: readonly CaptureFrame[]) {
        return this.mutate(id, (input) => appendFrames(input, frames), frames);
    }
    private async release() {
        const owned = this.active;
        this.active = undefined;
        await owned?.capture.release();
        await owned?.writer.release();
    }
    async seal(id: string, observedBytes: number, reason: string) {
        const result = await this.mutate(id, (input) =>
            sealedCapture(input, observedBytes, reason),
        );
        await this.release();
        return result;
    }
    async fail(id: string, observedBytes: number | null, failure: CaptureStorageError) {
        if (this.active?.id !== id) return;
        if (this.operation) await this.operation.catch(() => {});
        if (this.active?.id !== id) return;
        try {
            await this.mutate(id, (input) => failedCapture(input, observedBytes, failure));
        } finally {
            await this.release();
        }
    }
    private async rawPage(
        after = 0,
        limit: number = CAPTURE_STORAGE.pageRows,
        through = Number.MAX_SAFE_INTEGER,
    ): Promise<CapturePage> {
        const bounds = pageBounds(after, limit, through);
        return this.transaction(
            ['captures'],
            'readonly',
            (tx) =>
                new Promise((resolve, reject) => {
                    const records: StoredCapture[] = [];
                    let bytes = 0;
                    if (bounds.after === bounds.through) return resolve({ records, next: null });
                    const query = tx
                        .objectStore('captures')
                        .index('sequence')
                        .openCursor(IDBKeyRange.bound(bounds.after, bounds.through, true, false));
                    query.onerror = () => reject(query.error);
                    query.onsuccess = () => {
                        const cursor = query.result;
                        if (!cursor) return resolve({ records, next: null });
                        try {
                            const capture = storedCapture(cursor.value),
                                cost = new TextEncoder().encode(JSON.stringify(capture)).length + 1;
                            if (
                                records.length === bounds.limit ||
                                bytes + cost > CAPTURE_STORAGE.pageBytes - 64
                            )
                                return resolve({ records, next: records.at(-1)!.sequence });
                            records.push(capture);
                            bytes += cost;
                            cursor.continue();
                        } catch (error) {
                            reject(error);
                        }
                    };
                }),
        );
    }
    async page(
        after = 0,
        limit: number = CAPTURE_STORAGE.pageRows,
        through = Number.MAX_SAFE_INTEGER,
    ) {
        const page = await this.rawPage(after, limit, through);
        for (let index = 0; index < page.records.length; index++)
            if (page.records[index].state === 'active') {
                let owned: Lease | undefined;
                try {
                    owned = await this.lock(page.records[index].id, 'shared');
                    const latest = await this.metadata(page.records[index].id);
                    page.records[index] =
                        latest.state === 'active' ? interruptedCapture(latest) : latest;
                } catch (error) {
                    if (!(error instanceof CaptureStorageError) || error.code !== 'busy')
                        throw error;
                } finally {
                    await owned?.release();
                }
            }
        return boundedCapturePage(page);
    }
    async *read(id: string): AsyncGenerator<CaptureRead> {
        this.check();
        const owned = await this.lock(id, 'shared');
        try {
            let metadata = await this.metadata(id);
            if (metadata.state === 'active') metadata = interruptedCapture(metadata);
            const verifier = captureVerifier(metadata);
            yield { type: 'metadata', capture: metadata };
            // The pinned count is authoritative. A missing block is corruption, never normal EOF.
            const readAhead = Math.floor(
                CAPTURE_STORAGE.backlogBytes / (CAPTURE_STORAGE.frameBytes + 256),
            );
            for (let index = 0; index < metadata.committedFrames; index += readAhead) {
                const count = Math.min(readAhead, metadata.committedFrames - index);
                // A counted/key-bounded getAll amortizes backend transaction latency. At most
                // 15 frames (<256 KiB with provenance) are prefetched; this never reads the full file.
                const frames = await this.transaction(['frames'], 'readonly', (tx) =>
                    request(
                        tx
                            .objectStore('frames')
                            .getAll(IDBKeyRange.bound([id, index], [id, index + count - 1]), count),
                    ),
                );
                if (frames.length !== count)
                    throw new CaptureStorageError(
                        'integrity',
                        'A committed raw capture block is missing in the pinned range at ' +
                            index +
                            '.',
                    );
                for (let offset = 0; offset < frames.length; offset++) {
                    const frame = frames[offset];
                    if (!frame)
                        throw new CaptureStorageError(
                            'integrity',
                            'A committed raw capture block is missing at ' + (index + offset) + '.',
                        );
                    verifier.append(frame);
                    yield { type: 'frame', frame };
                }
            }
            verifier.finish();
        } finally {
            await owned.release();
        }
    }
    async delete(id: string) {
        this.check();
        const catalog = await this.acquire(this.name + ':catalog', 'exclusive');
        let owned: Lease | undefined;
        try {
            owned = await this.lock(id, 'exclusive');
            await this.transaction(['captures', 'frames', 'results'], 'readwrite', async (tx) => {
                tx.objectStore('captures').delete(id);
                tx.objectStore('results').delete(id);
                tx.objectStore('frames').delete(
                    IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]),
                );
            });
        } finally {
            await owned?.release();
            await catalog.release();
        }
    }
    private async recover() {
        let writer: Lease;
        try {
            writer = await this.acquire(this.name + ':writer', 'exclusive');
        } catch (error) {
            if (error instanceof CaptureStorageError && error.code === 'busy') return;
            throw error;
        }
        try {
            try {
                await this.transaction(['captures', 'settings'], 'readwrite', async (tx) => {
                    const { saved, maximum } = await this.sequenceState(tx),
                        counter = this.checkedSequence(saved);
                    if (counter < maximum) tx.objectStore('settings').put(maximum, 'sequence');
                });
            } catch (error) {
                const failure = storageError(error);
                if (!['integrity', 'io', 'quota', 'permission'].includes(failure.code))
                    throw failure;
                this.recoveryFailure = failure;
            }
            let after = 0;
            while (true) {
                const page = await this.rawPage(after);
                for (const capture of page.records)
                    if (capture.state === 'active') {
                        const owned = await this.lock(capture.id, 'exclusive');
                        try {
                            await this.transaction(['captures'], 'readwrite', async (tx) => {
                                tx.objectStore('captures').put(
                                    failedCapture(
                                        capture,
                                        null,
                                        new CaptureStorageError(
                                            'io',
                                            'Capture interrupted before final commit; uncommitted tail is unknown.',
                                        ),
                                    ),
                                );
                            });
                        } catch (error) {
                            const failure = storageError(error);
                            if (!['io', 'quota', 'permission'].includes(failure.code))
                                throw failure;
                            this.recoveryFailure = failure;
                        } finally {
                            await owned.release();
                        }
                    }
                if (page.next === null) break;
                after = page.next;
            }
        } finally {
            await writer.release();
        }
    }
    async result(id: string): Promise<AutomationOutcome | null> {
        validId(id);
        const owned = await this.acquire(this.name + ':outcome:' + id, 'shared');
        try {
            return await this.transaction(['results'], 'readonly', async (tx) => {
                const raw = await request(tx.objectStore('results').get(id));
                return raw === undefined ? null : automationOutcome(raw);
            });
        } finally {
            await owned.release();
        }
    }
    async record(id: string, input: AutomationOutcome) {
        if (this.recording)
            throw new CaptureStorageError('busy', 'Another command outcome is committing.');
        const pending = this.recordOutcome(id, input);
        this.recording = pending;
        try {
            await pending;
        } finally {
            if (this.recording === pending) this.recording = undefined;
        }
    }
    private async recordOutcome(id: string, input: AutomationOutcome) {
        validId(id);
        const outcome = automationOutcome(input),
            catalog = await this.acquire(this.name + ':catalog', 'exclusive');
        let owned: Lease | undefined;
        try {
            owned = await this.acquire(this.name + ':outcome:' + id, 'exclusive');
            await this.transaction(['captures', 'results'], 'readwrite', async (tx) => {
                const capture = await request(tx.objectStore('captures').get(id));
                if (!capture || storedCapture(capture).state === 'active')
                    throw new CaptureStorageError(
                        'busy',
                        'Seal raw capture before recording its outcome.',
                    );
                const table = tx.objectStore('results'),
                    previous = await request(table.get(id));
                if (previous !== undefined) {
                    if (JSON.stringify(automationOutcome(previous)) !== JSON.stringify(outcome))
                        throw new CaptureStorageError(
                            'integrity',
                            'Committed command outcomes are immutable.',
                        );
                    return;
                }
                table.add(outcome, id);
            });
        } finally {
            await owned?.release();
            await catalog.release();
        }
    }
    async close() {
        if (this.closed) {
            await this.releasing;
            return;
        }
        if (this.opening)
            throw new CaptureStorageError(
                'busy',
                'Capture store is still acquiring writer ownership.',
            );
        let failure: unknown;
        try {
            if (this.active)
                await this.fail(
                    this.active.id,
                    null,
                    new CaptureStorageError('io', 'Capture store closed before completion.'),
                );
        } catch (error) {
            failure = error;
        }
        if (this.leases.size || this.reserving)
            throw new CaptureStorageError(
                'busy',
                'Finish capture readers and exports before closing storage.',
            );
        this.db.close();
        this.closed = true;
        if (failure) throw failure;
    }
    async pin() {
        this.check();
        const owned = await this.acquire(this.name + ':catalog', 'shared');
        try {
            const through = await this.transaction(
                ['captures', 'settings'],
                'readonly',
                async (tx) => {
                    const { saved, maximum } = await this.sequenceState(tx);
                    return typeof saved === 'number' && Number.isSafeInteger(saved) && saved >= 0
                        ? Math.max(saved, maximum)
                        : maximum;
                },
            );
            return { through, release: () => owned.release() };
        } catch (error) {
            await owned.release();
            throw error;
        }
    }
}
