import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    frameCost,
    frameCrc,
    isoTime,
    storageError,
    type CaptureFrame,
    type CaptureHeader,
    type CaptureRepository,
    type StoredCapture,
} from './capture-store';

/** One producer awaits append; flush/seal is the durable fence before any later command. */
export class CaptureWriter {
    private pending: CaptureFrame[] = [];
    private pendingBytes = 0;
    private inFlightBytes = 0;
    private writing?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private accepting = false;
    private ending = false;
    private ended = false;
    private observation = 0;
    private observed = 0;
    private preview = new Uint8Array(CAPTURE_STORAGE.previewBytes);
    private previewSize = 0;
    private failure?: CaptureStorageError;
    private failureSaved?: Promise<void>;
    private last: StoredCapture;
    private constructor(
        private store: CaptureRepository,
        capture: StoredCapture,
        private onFailure: (error: CaptureStorageError) => void,
    ) {
        this.last = capture;
    }
    static async begin(
        store: CaptureRepository,
        header: CaptureHeader,
        onFailure: (error: CaptureStorageError) => void = () => {},
    ) {
        return new CaptureWriter(store, await store.begin(header), onFailure);
    }
    get id() {
        return this.last.id;
    }
    get snapshot() {
        return structuredClone(this.last);
    }
    rejectObservation(bytes: number, error: CaptureStorageError) {
        this.check();
        if (
            !Number.isSafeInteger(bytes) ||
            bytes < 0 ||
            !Number.isSafeInteger(this.observed + bytes)
        )
            throw this.broken(
                new CaptureStorageError('invalid', 'Invalid rejected observation size.'),
            );
        this.observed += bytes;
        this.broken(error);
    }
    get backlogBytes() {
        return this.pendingBytes + this.inFlightBytes;
    }
    get observedBytes() {
        return this.observed;
    }
    get previewBytes() {
        return this.preview.slice(0, this.previewSize);
    }
    get previewClipped() {
        return this.observed > this.previewSize;
    }
    get error() {
        return this.failure;
    }
    private check() {
        if (this.failure) throw this.failure;
        if (this.ended) throw new CaptureStorageError('invalid', 'Capture writer is closed.');
    }
    private broken(error: unknown) {
        if (!this.failure) {
            this.failure = storageError(error);
            clearTimeout(this.timer);
            // Stop the producer immediately; keep ownership until the outstanding write has settled.
            try {
                this.onFailure(this.failure);
            } catch {
                /* Observer cannot resume a failed writer. */
            }
            void Promise.resolve()
                .then(() => this.saveFailure())
                .catch(() => {});
        }
        return this.failure;
    }
    private drain() {
        this.check();
        if (this.writing || !this.pending.length) return this.writing;
        clearTimeout(this.timer);
        this.timer = undefined;
        const batch = this.pending;
        this.inFlightBytes = this.pendingBytes;
        this.pending = [];
        this.pendingBytes = 0;
        this.writing = this.store
            .append(this.id, batch)
            .then((capture) => {
                this.last = capture;
            })
            .catch((error) => {
                this.broken(error);
            })
            .finally(() => {
                this.inFlightBytes = 0;
                this.writing = undefined;
            });
        return this.writing;
    }
    async append(bytes: Uint8Array, receivedAt: string, stream: CaptureFrame['stream']) {
        this.check();
        if (this.accepting || this.ending)
            throw this.broken(
                new CaptureStorageError(
                    'backlog',
                    'Capture producer must await each append before sending more data.',
                ),
            );
        this.accepting = true;
        try {
            isoTime(receivedAt);
            if (!(bytes instanceof Uint8Array) || !['stdout', 'stderr', 'serial'].includes(stream))
                throw new CaptureStorageError('invalid', 'Invalid receive observation.');
            if (!bytes.length) return;
            this.observed += bytes.byteLength;
            if (!Number.isSafeInteger(this.observed))
                throw new CaptureStorageError('backlog', 'Capture byte counter exhausted.');
            if (bytes.byteLength > CAPTURE_STORAGE.backlogBytes)
                throw new CaptureStorageError(
                    'backlog',
                    'A receive observation exceeded the bounded producer buffer; capture is incomplete.',
                );
            const previewLength = Math.min(bytes.length, this.preview.length - this.previewSize);
            this.preview.set(bytes.subarray(0, previewLength), this.previewSize);
            this.previewSize += previewLength;
            for (let offset = 0; offset < bytes.length; offset += CAPTURE_STORAGE.frameBytes) {
                this.check();
                const length = Math.min(CAPTURE_STORAGE.frameBytes, bytes.length - offset);
                if (this.pendingBytes + length + 256 > CAPTURE_STORAGE.batchBytes) {
                    await this.drain();
                    this.check();
                    // A previous in-flight batch may have left the pending batch full.
                    if (this.pendingBytes + length + 256 > CAPTURE_STORAGE.batchBytes) {
                        await this.drain();
                        this.check();
                    }
                }
                // Buffer.slice aliases its input in Node; always copy into an owned Uint8Array.
                const raw = new Uint8Array(length);
                raw.set(bytes.subarray(offset, offset + length));
                const frame: CaptureFrame = {
                    observation: this.observation,
                    receivedAt,
                    stream,
                    offset,
                    totalBytes: bytes.length,
                    bytes: raw,
                    crc32: frameCrc(raw),
                };
                this.pending.push(frame);
                this.pendingBytes += frameCost(frame);
                if (this.backlogBytes > CAPTURE_STORAGE.backlogBytes)
                    throw new CaptureStorageError('backlog', 'Capture storage backlog exhausted.');
            }
            this.observation++;
            if (!this.timer)
                this.timer = setTimeout(() => {
                    this.timer = undefined;
                    void this.flushPending().catch(() => {});
                }, 50);
        } catch (error) {
            throw this.broken(error);
        } finally {
            this.accepting = false;
        }
    }
    async flush() {
        if (this.accepting)
            throw new CaptureStorageError(
                'busy',
                'Await the receive observation before flushing capture storage.',
            );
        await this.flushPending();
    }
    private async flushPending() {
        this.check();
        clearTimeout(this.timer);
        this.timer = undefined;
        while (true) {
            this.check();
            // Another flush may take the pending batch while this one awaits the previous
            // acknowledgement. Recheck both queues before reporting a completed fence.
            if (this.writing) {
                await this.writing;
                continue;
            }
            if (!this.pending.length) break;
            await this.drain();
        }
    }
    private async saveFailure() {
        if (!this.failureSaved)
            this.failureSaved = (async () => {
                if (this.writing) await this.writing;
                try {
                    await this.store.fail(this.id, this.observed, this.failure!);
                } catch {
                    /* A full disk may also reject failure metadata; reopen recovers active as interrupted. */
                }
                this.pending = [];
                this.pendingBytes = 0;
                this.ended = true;
            })();
        await this.failureSaved;
    }
    async finish(reason: string): Promise<StoredCapture> {
        if (this.accepting || this.ending)
            throw this.broken(
                new CaptureStorageError(
                    'backlog',
                    'Finish requires an awaited producer and exclusive completion.',
                ),
            );
        this.ending = true;
        try {
            await this.flush();
            this.check();
            this.last = await this.store.seal(this.id, this.observed, reason);
            this.check();
            this.ended = true;
            return structuredClone(this.last);
        } catch (error) {
            this.broken(error);
            await this.saveFailure();
            throw this.failure;
        }
    }
    async abort(error: unknown) {
        this.broken(error);
        await this.saveFailure();
    }
}
