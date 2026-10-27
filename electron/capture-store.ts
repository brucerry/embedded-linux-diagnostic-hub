import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { physicalFS } from './physical-fs';
import { NativeCaptureCatalog } from './capture-catalog';
import { automationOutcome, type AutomationOutcome } from '../shared/automation-result';
import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    appendFrames,
    base64Bytes,
    boundedCapturePage,
    bytesBase64,
    captureHeader,
    captureVerifier,
    failedCapture,
    interruptedCapture,
    integer,
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
} from '../shared/capture-store';

const fs = physicalFS.promises,
    owners = new Set<string>(),
    noFollow = physicalFS.constants.O_NOFOLLOW ?? 0,
    nonBlock = physicalFS.constants.O_NONBLOCK ?? 0;
const samePath = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
type CloseFailure = (error: unknown) => void;
async function closeFile(handle: FileHandle, onFailure?: CloseFailure) {
    try {
        await handle.close();
    } catch (error) {
        onFailure?.(error);
        throw error;
    }
}
async function directory(file: string) {
    const stat = await fs.lstat(file);
    if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !samePath(await fs.realpath(file), path.resolve(file))
    )
        throw new CaptureStorageError(
            'integrity',
            'Capture directories must be physical, unaliased directories.',
        );
}
async function regular(
    file: string,
    write = false,
    create = false,
    onCloseFailure?: CloseFailure,
): Promise<FileHandle> {
    const before = create ? undefined : await fs.lstat(file);
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
        throw new CaptureStorageError(
            'integrity',
            'Capture files must be regular, unlinked physical files.',
        );
    const flags =
        (write ? physicalFS.constants.O_RDWR : physicalFS.constants.O_RDONLY) |
        noFollow |
        nonBlock |
        (create ? physicalFS.constants.O_CREAT | physicalFS.constants.O_EXCL : 0);
    const handle = await fs.open(file, flags, 0o600);
    try {
        const after = await handle.stat();
        if (
            !after.isFile() ||
            after.nlink !== 1 ||
            (before && (before.dev !== after.dev || before.ino !== after.ino))
        )
            throw new CaptureStorageError('integrity', 'Capture file identity changed.');
        return handle;
    } catch (error) {
        await closeFile(handle, onCloseFailure);
        throw error;
    }
}
async function writeAll(handle: FileHandle, bytes: Uint8Array, position = 0) {
    for (let offset = 0; offset < bytes.length;) {
        const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
        if (result.bytesWritten <= 0)
            throw new CaptureStorageError('io', 'Capture storage made no write progress.');
        offset += result.bytesWritten;
    }
}
async function boundedJson(file: string, onCloseFailure: CloseFailure) {
    const handle = await regular(file, false, false, onCloseFailure);
    try {
        const size = (await handle.stat()).size;
        integer(size, 1, CAPTURE_STORAGE.metadataBytes);
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
            const result = await handle.read(bytes, offset, size - offset, offset);
            if (!result.bytesRead)
                throw new CaptureStorageError('integrity', 'Capture metadata was shortened.');
            offset += result.bytesRead;
        }
        if ((await handle.stat()).size !== size)
            throw new CaptureStorageError('integrity', 'Capture metadata changed while reading.');
        return JSON.parse(bytes.toString('utf8'));
    } finally {
        await closeFile(handle, onCloseFailure);
    }
}
async function atomicJson(file: string, value: unknown, onCloseFailure: CloseFailure) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > CAPTURE_STORAGE.metadataBytes)
        throw new CaptureStorageError('invalid', 'Capture metadata exceeded its memory budget.');
    const temporary = path.join(path.dirname(file), 'meta-' + crypto.randomUUID() + '.tmp');
    const handle = await regular(temporary, true, true, onCloseFailure);
    try {
        await writeAll(handle, bytes);
        await handle.sync();
    } finally {
        await closeFile(handle, onCloseFailure);
    }
    // A failure leaves the previous committed metadata and the owned temporary file intact.
    await fs.rename(temporary, file);
}
interface NativeMetadata {
    capture: StoredCapture;
    offset: number;
}

/** Reads and verifies only the committed prefix; caller holds writer or reader ownership. */
async function* committedFrames(
    handle: FileHandle,
    input: NativeMetadata,
): AsyncGenerator<CaptureRead> {
    const verifier = captureVerifier(input.capture);
    const bytes = Buffer.alloc(CAPTURE_STORAGE.frameBytes);
    let position = 0,
        pending = '',
        frames = 0;
    while (position < input.offset) {
        const result = await handle.read(
            bytes,
            0,
            Math.min(bytes.length, input.offset - position),
            position,
        );
        if (!result.bytesRead)
            throw new CaptureStorageError(
                'integrity',
                'Native journal ended before its committed high-water mark.',
            );
        position += result.bytesRead;
        pending += bytes.subarray(0, result.bytesRead).toString('utf8');
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
            if (end > CAPTURE_STORAGE.metadataBytes)
                throw new CaptureStorageError(
                    'integrity',
                    'Native journal frame exceeded its bound.',
                );
            const raw = JSON.parse(pending.slice(0, end));
            pending = pending.slice(end + 1);
            frames++;
            if (frames > input.capture.committedFrames)
                throw new CaptureStorageError(
                    'integrity',
                    'Native journal has unexpected committed frames.',
                );
            const frame = { ...raw, bytes: base64Bytes(raw.bytes) } as CaptureFrame;
            verifier.append(frame);
            yield { type: 'frame', frame };
        }
        if (pending.length > CAPTURE_STORAGE.metadataBytes)
            throw new CaptureStorageError(
                'integrity',
                'Native journal contains an oversized frame.',
            );
    }
    if (pending || frames !== input.capture.committedFrames)
        throw new CaptureStorageError(
            'integrity',
            'Native journal frame count or boundary is incomplete.',
        );
    verifier.finish();
}

/** Trusted main process only. The packaged app must already own this installation profile. */
export class NativeCaptureStore implements CaptureRepository {
    recoveryFailure?: CaptureStorageError;
    private active?: string;
    private modifying = false;
    private closed = false;
    private readers = new Map<string, number>();
    private sequence = 0;
    private pins = 0;
    private deleting = new Set<string>();
    private operation?: Promise<StoredCapture>;
    private resultWriting = new Set<string>();
    private catalog?: NativeCaptureCatalog;
    private catalogFile?: string;
    private listing = 0;
    private metadataQueues = new Map<string, Promise<void>>();
    private metadataUncertain = new Map<string, CaptureStorageError>();
    private jsonOperations = new Map<string, number>();
    private closing = false;
    private constructor(
        private root: string,
        private ownerKey: string,
    ) {}
    static async open(profileDirectory: string, ownership: { profileOwned: true }) {
        if (ownership?.profileOwned !== true)
            throw new CaptureStorageError(
                'busy',
                'Capture storage requires exclusive installation profile ownership.',
            );
        await directory(profileDirectory);
        const root = path.join(path.resolve(profileDirectory), 'captures-v1');
        try {
            await fs.mkdir(root, { mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw storageError(error);
        }
        await directory(root);
        const key = process.platform === 'win32' ? root.toLowerCase() : root;
        if (owners.has(key))
            throw new CaptureStorageError('busy', 'This profile capture store is already open.');
        owners.add(key);
        const store = new NativeCaptureStore(root, key);
        try {
            await store.recover();
            return store;
        } catch (error) {
            await store.closeCatalog().catch(() => {});
            // An unacknowledged metadata close must not admit another store for this profile.
            if (!store.metadataUncertain.size) owners.delete(key);
            throw storageError(error);
        }
    }
    private check() {
        if (this.closed) throw new CaptureStorageError('io', 'Capture store is closed.');
        if (this.closing) throw new CaptureStorageError('busy', 'Capture store is closing.');
        if (this.metadataUncertain.size)
            throw new CaptureStorageError(
                'io',
                'Capture metadata closure was not confirmed; storage remains owned for inspection. ' +
                    this.metadataUncertain.values().next().value!.message,
            );
    }
    private disableCatalog(error: unknown) {
        const failure = storageError(error);
        this.recoveryFailure ??= new CaptureStorageError(
            failure.code,
            'Native catalog index is unavailable; captures are retained and bounded directory reads remain available. ' +
                failure.message,
        );
        try {
            this.catalog?.close();
        } finally {
            this.catalog = undefined;
        }
    }
    private async openCatalog() {
        this.catalogFile = path.join(this.root, '.catalog-' + crypto.randomUUID() + '.sqlite');
        try {
            const handle = await regular(this.catalogFile, true, true);
            try {
                const before = await handle.stat();
                this.catalog = new NativeCaptureCatalog(this.catalogFile);
                const after = await fs.lstat(this.catalogFile);
                if (
                    !after.isFile() ||
                    after.isSymbolicLink() ||
                    after.nlink !== 1 ||
                    before.dev !== after.dev ||
                    before.ino !== after.ino
                )
                    throw new CaptureStorageError(
                        'integrity',
                        'Native catalog file identity changed.',
                    );
            } finally {
                await handle.close();
            }
        } catch (error) {
            if (error instanceof CaptureStorageError && error.code === 'integrity') throw error;
            this.disableCatalog(error);
        }
    }
    private async closeCatalog() {
        try {
            this.catalog?.close();
        } finally {
            this.catalog = undefined;
        }
        if (this.catalogFile) {
            try {
                const handle = await regular(this.catalogFile);
                await handle.close();
                await fs.unlink(this.catalogFile);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            } finally {
                this.catalogFile = undefined;
            }
        }
    }
    private indexCapture(capture: StoredCapture, recovering = false) {
        try {
            this.catalog?.add(capture.sequence, capture.id);
        } catch (error) {
            if (recovering && error instanceof CaptureStorageError && error.code === 'integrity')
                throw error;
            this.disableCatalog(error);
        }
    }
    private async folder(id: string) {
        this.check();
        validId(id);
        await directory(this.root);
        const folder = path.join(this.root, id);
        await directory(folder);
        return folder;
    }
    /** Own every JSON operation from admission through actual close, without imposing a lock. */
    private async jsonOwned<T>(
        key: string,
        operation: (onCloseFailure: CloseFailure) => Promise<T>,
    ): Promise<T> {
        this.check();
        this.jsonOperations.set(key, (this.jsonOperations.get(key) ?? 0) + 1);
        try {
            return await operation((error) => {
                this.metadataUncertain.set(key, storageError(error));
            });
        } finally {
            const count = this.jsonOperations.get(key)! - 1;
            if (count) this.jsonOperations.set(key, count);
            else this.jsonOperations.delete(key);
        }
    }
    /** One short metadata file operation per capture, including its actual close acknowledgment.
     * Never call this recursively or hold it while joining a mutation, reset or page operation.
     * The tail always resolves: an operation failure cannot strand later admitted callers.
     */
    private async metadataExclusive<T>(
        id: string,
        operation: (onCloseFailure: CloseFailure) => Promise<T>,
    ): Promise<T> {
        this.check();
        validId(id);
        const previous = this.metadataQueues.get(id);
        let release!: () => void;
        const tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.metadataQueues.set(id, tail);
        try {
            await previous;
            this.check();
            return await this.jsonOwned(id, operation);
        } finally {
            release();
            if (this.metadataQueues.get(id) === tail) this.metadataQueues.delete(id);
        }
    }
    private metadata(id: string): Promise<NativeMetadata> {
        return this.metadataExclusive(id, async (onCloseFailure) => {
            const input = (await boundedJson(
                path.join(await this.folder(id), 'meta.json'),
                onCloseFailure,
            )) as NativeMetadata;
            const capture = storedCapture(input.capture);
            integer(input.offset);
            if (capture.id !== id)
                throw new CaptureStorageError(
                    'integrity',
                    'Stored capture identity does not match its directory.',
                );
            return { capture, offset: input.offset };
        });
    }
    private mutate(
        id: string,
        operation: (input: NativeMetadata, folder: string) => Promise<NativeMetadata>,
    ): Promise<StoredCapture> {
        this.check();
        validId(id);
        if (this.active !== id)
            throw new CaptureStorageError('busy', 'Capture writer no longer owns this record.');
        if (this.modifying)
            return Promise.reject(
                new CaptureStorageError(
                    'backlog',
                    'Only one native capture commit may be outstanding.',
                ),
            );
        this.modifying = true;
        const pending = (async () => {
            try {
                const folder = await this.folder(id),
                    next = await operation(await this.metadata(id), folder);
                storedCapture(next.capture);
                await this.metadataExclusive(id, (onCloseFailure) =>
                    atomicJson(path.join(folder, 'meta.json'), next, onCloseFailure),
                );
                return structuredClone(next.capture);
            } catch (error) {
                throw storageError(error);
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
        if (this.active || this.modifying)
            throw new CaptureStorageError('busy', 'Finish the active capture first.');
        this.modifying = true;
        const id = crypto.randomUUID();
        try {
            await directory(this.root);
            const folder = path.join(this.root, '.pending-' + id);
            const capture = newCapture(id, ++this.sequence, header);
            await this.jsonOwned('sequence.json', (onCloseFailure) =>
                atomicJson(
                    path.join(this.root, 'sequence.json'),
                    { sequence: this.sequence },
                    onCloseFailure,
                ),
            );
            await fs.mkdir(folder, { mode: 0o700 });
            const journal = await regular(path.join(folder, 'raw.jsonl'), true, true);
            let journalFailure: CaptureStorageError | undefined;
            try {
                await journal.sync();
            } catch (error) {
                journalFailure = storageError(error);
            }
            try {
                await journal.close();
            } catch (error) {
                const closeFailure = storageError(error);
                const prefix = (message: string) =>
                    new TextDecoder().decode(new TextEncoder().encode(message).subarray(0, 224), {
                        stream: true,
                    });
                journalFailure = journalFailure
                    ? new CaptureStorageError(
                          journalFailure.code,
                          prefix(journalFailure.message) +
                              '; journal close also failed: ' +
                              prefix(closeFailure.message),
                      )
                    : closeFailure;
            }
            if (journalFailure) throw journalFailure;
            await this.jsonOwned('.pending-' + id + '/meta.json', (onCloseFailure) =>
                atomicJson(path.join(folder, 'meta.json'), { capture, offset: 0 }, onCloseFailure),
            );
            await fs.rename(folder, path.join(this.root, id));
            this.active = id;
            this.indexCapture(capture);
            return capture;
        } catch (error) {
            throw storageError(error);
        } finally {
            this.modifying = false;
        }
    }
    append(id: string, frames: readonly CaptureFrame[]) {
        return this.mutate(id, async (input, folder) => {
            const capture = appendFrames(input.capture, frames);
            const bytes = Buffer.from(
                frames
                    .map(
                        (frame) =>
                            JSON.stringify({ ...frame, bytes: bytesBase64(frame.bytes) }) + '\n',
                    )
                    .join(''),
            );
            if (bytes.length > 96 * 1024)
                throw new CaptureStorageError(
                    'backlog',
                    'Native journal encoding exceeded its batch budget.',
                );
            const journal = await regular(path.join(folder, 'raw.jsonl'), true);
            try {
                if ((await journal.stat()).size !== input.offset)
                    throw new CaptureStorageError(
                        'integrity',
                        'An uncommitted native journal tail must not be overwritten.',
                    );
                await writeAll(journal, bytes, input.offset);
                await journal.sync();
            } finally {
                await journal.close();
            }
            const offset = input.offset + bytes.length;
            integer(offset);
            // Publish counters only after the entire journal batch was written and synchronized.
            return { capture, offset };
        });
    }
    async seal(id: string, observedBytes: number, reason: string) {
        const capture = await this.mutate(id, async (input, folder) => {
            const journal = await regular(path.join(folder, 'raw.jsonl'), true);
            try {
                if ((await journal.stat()).size !== input.offset)
                    throw new CaptureStorageError(
                        'integrity',
                        'Native seal found a missing or uncommitted journal tail.',
                    );
                // Verify CRC, observation sequence/ranges and aggregate counters under the
                // existing exclusive mutation ownership, before publishing completeness.
                for await (const _frame of committedFrames(journal, input)) {
                    /* bounded streaming verification */
                }
                if ((await journal.stat()).size !== input.offset)
                    throw new CaptureStorageError(
                        'integrity',
                        'Native journal changed during seal verification.',
                    );
                await journal.sync();
            } finally {
                await journal.close();
            }
            return { ...input, capture: sealedCapture(input.capture, observedBytes, reason) };
        });
        this.active = undefined;
        return capture;
    }
    async fail(id: string, observedBytes: number | null, failure: CaptureStorageError) {
        if (this.active !== id) return;
        if (this.operation) await this.operation.catch(() => {});
        if (this.active !== id) return;
        try {
            await this.mutate(id, async (input) => ({
                ...input,
                capture: failedCapture(input.capture, observedBytes, failure),
            }));
        } finally {
            this.active = undefined;
        }
    }
    private async scan(
        after = 0,
        limit: number = CAPTURE_STORAGE.pageRows,
        through = Number.MAX_SAFE_INTEGER,
    ): Promise<CapturePage> {
        this.check();
        const bounds = pageBounds(after, limit, through),
            records: StoredCapture[] = [];
        let bytes = 0,
            more = false;
        await directory(this.root);
        const entries = await fs.opendir(this.root);
        // Keep only the next page, not an unbounded directory/catalog array.
        for await (const entry of entries) {
            if (!/^[a-f0-9-]{36}$/.test(entry.name)) continue;
            const capture = (await this.metadata(entry.name)).capture;
            if (capture.sequence <= bounds.after || capture.sequence > bounds.through) continue;
            if (records.some((row) => row.sequence === capture.sequence))
                throw new CaptureStorageError(
                    'integrity',
                    'Stored capture sequences conflict; evidence was retained.',
                );
            const index = records.findIndex((row) => row.sequence > capture.sequence);
            records.splice(index < 0 ? records.length : index, 0, capture);
            bytes += Buffer.byteLength(JSON.stringify(capture)) + 1;
            while (records.length > bounds.limit || bytes > CAPTURE_STORAGE.pageBytes - 64) {
                bytes -= Buffer.byteLength(JSON.stringify(records.pop()!)) + 1;
                more = true;
            }
        }
        return { records, next: more ? records.at(-1)!.sequence : null };
    }
    private async list(after: number, limit: number, through: number): Promise<CapturePage> {
        this.check();
        const bounds = pageBounds(after, limit, through);
        if (this.deleting.size)
            throw new CaptureStorageError(
                'busy',
                'Capture cleanup is pending; retry the catalog read.',
            );
        this.listing++;
        try {
            if (!this.catalog) return await this.scan(after, limit, through);
            let candidates: ReturnType<NativeCaptureCatalog['page']>;
            try {
                candidates = this.catalog.page(bounds.after, bounds.through, bounds.limit);
            } catch (error) {
                this.disableCatalog(error);
                return await this.scan(after, limit, through);
            }
            const records: StoredCapture[] = [];
            let bytes = 64;
            for (const row of candidates) {
                const capture = (await this.metadata(row.id)).capture;
                if (capture.sequence !== row.sequence)
                    throw new CaptureStorageError(
                        'integrity',
                        'Capture metadata no longer matches its indexed sequence; evidence was retained.',
                    );
                const cost = Buffer.byteLength(JSON.stringify(capture)) + 1;
                if (records.length === bounds.limit || bytes + cost > CAPTURE_STORAGE.pageBytes) {
                    if (!records.length)
                        throw new CaptureStorageError(
                            'integrity',
                            'Capture metadata cannot fit a bounded page.',
                        );
                    return { records, next: records.at(-1)!.sequence };
                }
                bytes += cost;
                records.push(capture);
            }
            return { records, next: null };
        } finally {
            this.listing--;
        }
    }
    async page(
        after = 0,
        limit: number = CAPTURE_STORAGE.pageRows,
        through = Number.MAX_SAFE_INTEGER,
    ) {
        const page = await this.list(after, limit, through);
        if (!this.modifying)
            page.records = page.records.map((capture) =>
                capture.state === 'active' && capture.id !== this.active
                    ? interruptedCapture(capture)
                    : capture,
            );
        return boundedCapturePage(page);
    }
    async *read(id: string): AsyncGenerator<CaptureRead> {
        this.check();
        validId(id);
        if ([...this.readers.values()].reduce((n, count) => n + count, 0) >= 8)
            throw new CaptureStorageError('busy', 'Finish another capture reader first.');
        if (this.active === id || this.deleting.has(id))
            throw new CaptureStorageError('busy', 'Finish capture or cleanup before exporting it.');
        this.readers.set(id, (this.readers.get(id) ?? 0) + 1);
        let handle: FileHandle | undefined;
        try {
            const input = await this.metadata(id);
            if (input.capture.state === 'active') {
                if (this.active === id || this.modifying)
                    throw new CaptureStorageError(
                        'busy',
                        'Capture is still acquiring writer ownership.',
                    );
                input.capture = interruptedCapture(input.capture);
            }
            handle = await regular(path.join(await this.folder(id), 'raw.jsonl'));
            if ((await handle.stat()).size < input.offset)
                throw new CaptureStorageError(
                    'integrity',
                    'Committed native journal bytes are missing.',
                );
            yield { type: 'metadata', capture: input.capture };
            yield* committedFrames(handle, input);
        } finally {
            await handle?.close();
            const count = (this.readers.get(id) ?? 1) - 1;
            if (count) this.readers.set(id, count);
            else this.readers.delete(id);
        }
    }
    async delete(id: string) {
        this.check();
        validId(id);
        if (
            this.active === id ||
            this.readers.has(id) ||
            this.pins ||
            this.deleting.has(id) ||
            this.resultWriting.has(id) ||
            this.jsonOperations.has(id + '/result.json') ||
            this.listing
        )
            throw new CaptureStorageError(
                'busy',
                'An active capture, cleanup or export owns this record.',
            );
        this.deleting.add(id);
        try {
            const folder = await this.folder(id),
                tombstone = path.join(this.root, '.deleting-' + id);
            await this.deletionFiles(folder); // validate every physical file before committing intent
            // Renaming makes explicit deletion recoverable. A crash can never leave a
            // half-deleted canonical capture masquerading as ordinary stored evidence.
            await fs.rename(folder, tombstone);
            try {
                this.catalog?.delete(id);
            } catch (error) {
                this.disableCatalog(error);
            }
            await this.finishDeletion(tombstone);
        } finally {
            this.deleting.delete(id);
        }
    }
    private async deletionFiles(folder: string) {
        await directory(folder);
        const names: string[] = [],
            entries = await fs.opendir(folder);
        for await (const entry of entries) {
            if (
                !['meta.json', 'raw.jsonl', 'result.json'].includes(entry.name) &&
                !/^meta-[a-f0-9-]{36}\.tmp$/.test(entry.name)
            )
                throw new CaptureStorageError(
                    'integrity',
                    'Capture directory contains an unknown file; cleanup refused.',
                );
            names.push(entry.name);
            if (names.length > 1024)
                throw new CaptureStorageError(
                    'integrity',
                    'Capture cleanup requires inspection of excessive temporary files.',
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
    private async recover() {
        try {
            const saved = await this.jsonOwned('sequence.json', (onCloseFailure) =>
                boundedJson(path.join(this.root, 'sequence.json'), onCloseFailure),
            );
            integer(saved.sequence);
            this.sequence = saved.sequence;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await this.openCatalog();
        // One streaming recovery pass. Old capture/outcome/journal files stay in place;
        // the disposable index is always rebuilt and never supplies recovery metadata.
        const entries = await fs.opendir(this.root);
        for await (const entry of entries) {
            if (/^\.deleting-[a-f0-9-]{36}$/.test(entry.name)) {
                validId(entry.name.slice('.deleting-'.length));
                try {
                    await this.finishDeletion(path.join(this.root, entry.name));
                } catch (error) {
                    const failure = storageError(error);
                    this.recoveryFailure ??= new CaptureStorageError(
                        failure.code,
                        'Previously requested capture deletion could not finish; its retained deletion folder requires inspection. ' +
                            failure.message,
                    );
                }
                continue;
            }
            if (/^\.catalog-[a-f0-9-]{36}\.sqlite$/.test(entry.name)) {
                if (entry.name !== path.basename(this.catalogFile!)) {
                    const file = path.join(this.root, entry.name),
                        handle = await regular(file);
                    await handle.close();
                    try {
                        await fs.unlink(file);
                    } catch (error) {
                        const failure = storageError(error);
                        this.recoveryFailure ??= new CaptureStorageError(
                            failure.code,
                            'A disposable stale catalog could not be removed; stored captures are retained. ' +
                                failure.message,
                        );
                    }
                }
                continue;
            }
            if (/^\.pending-[a-f0-9-]{36}$/.test(entry.name)) {
                this.recoveryFailure ??= new CaptureStorageError(
                    'io',
                    'An unpublished capture folder was retained for inspection; no request was acknowledged from it.',
                );
                continue;
            }
            if (!/^[a-f0-9-]{36}$/.test(entry.name)) continue;
            const input = await this.metadata(entry.name),
                capture = input.capture;
            this.sequence = Math.max(this.sequence, capture.sequence);
            if (capture.state === 'active') {
                const journal = await regular(
                    path.join(await this.folder(capture.id), 'raw.jsonl'),
                );
                let tail = 0;
                try {
                    tail = (await journal.stat()).size - input.offset;
                } finally {
                    await journal.close();
                }
                if (tail < 0)
                    throw new CaptureStorageError(
                        'integrity',
                        'Native recovery found missing committed bytes.',
                    );
                input.capture = failedCapture(
                    capture,
                    null,
                    new CaptureStorageError(
                        'io',
                        'Capture interrupted before final commit; ' +
                            tail +
                            ' uncommitted journal bytes retained; observed tail unknown.',
                    ),
                );
                try {
                    await this.metadataExclusive(capture.id, async (onCloseFailure) =>
                        atomicJson(
                            path.join(await this.folder(capture.id), 'meta.json'),
                            input,
                            onCloseFailure,
                        ),
                    );
                } catch (error) {
                    if (this.metadataUncertain.has(capture.id)) throw error;
                    const failure = storageError(error);
                    if (!['io', 'quota', 'permission'].includes(failure.code)) throw failure;
                    this.recoveryFailure = failure;
                }
            }
            this.indexCapture(input.capture, true);
        }
    }
    async result(id: string): Promise<AutomationOutcome | null> {
        validId(id);
        if (this.deleting.has(id))
            throw new CaptureStorageError('busy', 'Capture cleanup owns this record.');
        return this.jsonOwned(id + '/result.json', async (onCloseFailure) => {
            const folder = await this.folder(id);
            try {
                return automationOutcome(
                    await boundedJson(path.join(folder, 'result.json'), onCloseFailure),
                );
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw storageError(error);
            }
        });
    }
    async record(id: string, input: AutomationOutcome) {
        this.check();
        validId(id);
        const outcome = automationOutcome(input);
        if (this.active === id || this.pins || this.deleting.has(id) || this.resultWriting.size)
            throw new CaptureStorageError(
                'busy',
                'A capture, export or metadata commit owns this record.',
            );
        this.resultWriting.add(id);
        try {
            const previous = await this.result(id);
            if (previous) {
                if (JSON.stringify(previous) !== JSON.stringify(outcome))
                    throw new CaptureStorageError(
                        'integrity',
                        'Committed command outcomes are immutable.',
                    );
                return;
            }
            if ((await this.metadata(id)).capture.state === 'active')
                throw new CaptureStorageError(
                    'busy',
                    'Seal raw capture before recording its outcome.',
                );
            await this.jsonOwned(id + '/result.json', async (onCloseFailure) =>
                atomicJson(
                    path.join(await this.folder(id), 'result.json'),
                    outcome,
                    onCloseFailure,
                ),
            );
        } catch (error) {
            throw storageError(error);
        } finally {
            this.resultWriting.delete(id);
        }
    }
    private hasPending() {
        return Boolean(
            this.readers.size ||
            this.modifying ||
            this.pins ||
            this.deleting.size ||
            this.resultWriting.size ||
            this.listing ||
            this.metadataQueues.size ||
            this.metadataUncertain.size ||
            this.jsonOperations.size,
        );
    }
    async close() {
        if (this.closed) return;
        const busy = () =>
            new CaptureStorageError(
                'busy',
                'Finish pending capture commits and exports before closing storage.',
            );
        if (this.closing || this.hasPending()) throw busy();
        let failure: { error: unknown } | undefined;
        try {
            if (this.active)
                await this.fail(
                    this.active,
                    null,
                    new CaptureStorageError('io', 'Capture store closed before completion.'),
                );
        } catch (error) {
            failure = { error };
        }
        // fail() can admit readers or discover uncertain closure while this call awaits it.
        if (this.metadataUncertain.size) failure ??= { error: busy() };
        if (!this.metadataUncertain.size) {
            if (this.hasPending()) {
                if (failure) throw failure.error;
                throw busy();
            }
            // No await between the final ownership check and closing admission.
            this.closing = true;
            try {
                await this.closeCatalog();
            } catch (error) {
                failure ??= { error };
            } finally {
                this.closed = true;
                this.closing = false;
                owners.delete(this.ownerKey);
            }
        }
        if (failure) throw failure.error;
    }
    async pin() {
        this.check();
        if (this.deleting.size || this.resultWriting.size || this.pins >= 32)
            throw new CaptureStorageError(
                'busy',
                'Capture cleanup is pending or export ownership is full.',
            );
        this.pins++;
        let released = false;
        return {
            through: this.sequence,
            release: async () => {
                if (!released) {
                    released = true;
                    this.pins--;
                }
            },
        };
    }
}

/** Destination comes only from a trusted native Save dialog. Failure never replaces an existing file. */
export async function saveCaptureExport(
    destination: string,
    source: AsyncIterable<Uint8Array>,
    overwrite = false,
    signal?: AbortSignal,
) {
    const check = () => {
        if (signal?.aborted)
            throw new CaptureStorageError('io', 'Export cancelled before file commit.');
    };
    check();
    destination = path.resolve(destination);
    const parent = path.dirname(path.resolve(destination));
    await directory(parent);
    let existing: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
        existing = await fs.lstat(destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
        existing &&
        (!overwrite || !existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
    )
        throw new CaptureStorageError(
            'invalid',
            'Export destination already exists or is not a regular unlinked file.',
        );
    const temporary = path.join(parent, '.diagnostic-hub-export-' + crypto.randomUUID() + '.tmp');
    let handle: FileHandle | undefined,
        committed = false,
        created = false;
    try {
        handle = await regular(temporary, true, true);
        created = true;
        let position = 0;
        for await (const bytes of source) {
            check();
            if (!(bytes instanceof Uint8Array) || bytes.byteLength > CAPTURE_STORAGE.batchBytes)
                throw new CaptureStorageError(
                    'backlog',
                    'Export encoder exceeded its bounded chunk budget.',
                );
            await writeAll(handle, bytes, position);
            position += bytes.length;
            integer(position);
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        check();
        if (existing) {
            const current = await fs.lstat(destination);
            if (
                !current.isFile() ||
                current.isSymbolicLink() ||
                current.nlink !== 1 ||
                current.dev !== existing.dev ||
                current.ino !== existing.ino ||
                current.mtimeMs !== existing.mtimeMs ||
                current.size !== existing.size
            )
                throw new CaptureStorageError(
                    'integrity',
                    'Export destination changed; previous file preserved.',
                );
            check();
            await fs.rename(temporary, destination);
        } else {
            check();
            await fs.link(temporary, destination);
            await fs.unlink(temporary);
        }
        committed = true;
    } catch (error) {
        throw storageError(error);
    } finally {
        await handle?.close();
        if (created && !committed) await fs.unlink(temporary).catch(() => {});
    }
}
