import { randomUUID } from 'node:crypto';
import { CaptureStorageError, storageError } from '../shared/capture-store';
import { consoleArchiveRequest } from '../shared/console-archive-rpc';
import type { ConsoleExportRequest } from '../shared/console-archive-rpc';
import type { CaptureReportFormat } from '../shared/capture-report';
import { streamConsoleReport } from '../shared/console-report';
import { saveCaptureExport } from './capture-store';
import { NativeConsoleJournal } from './console-journal';
import type { ConsoleRead } from '../shared/console-storage';
type Reader = {
    iterator: ReturnType<NativeConsoleJournal['read']>;
    first: IteratorResult<ConsoleRead> | null;
    pulling: boolean;
    closing?: Promise<void>;
};
/** One physical v2 repository; reader admission is fenced across renderer reset and flow start. */
export class NativeConsoleService {
    private current?: NativeConsoleJournal;
    private transition?: Promise<NativeConsoleJournal>;
    private writer = false;
    private references = 0;
    private readers = new Map<string, Reader>();
    private pins = new Map<string, Awaited<ReturnType<NativeConsoleJournal['pin']>>>();
    private pendingReaders = 0;
    private pendingPins = 0;
    private epoch = 0;
    private closing = false;
    private requests = new Set<Promise<unknown>>();
    private exports = new Map<string, { controller: AbortController; done: Promise<boolean> }>();
    constructor(
        private profile: string,
        private destination?: (format: CaptureReportFormat) => Promise<string | null>,
    ) {}
    private check() {
        if (this.closing)
            throw new CaptureStorageError('busy', 'Console storage is shutting down.');
    }
    private getJournal() {
        this.check();
        if (this.transition) return this.transition;
        if (this.current && !this.current.resourceClosed) return Promise.resolve(this.current);
        this.writer = false;
        const task = NativeConsoleJournal.open(this.profile, { profileOwned: true }).then(
            (store) => {
                this.current = store;
                return store;
            },
        );
        this.transition = task;
        void task
            .finally(() => {
                if (this.transition === task) this.transition = undefined;
            })
            .catch(() => {});
        return task;
    }
    createWriter = (): Promise<NativeConsoleJournal> => {
        this.check();
        if (
            this.references ||
            this.transition ||
            (this.writer && this.current && !this.current.resourceClosed)
        )
            return Promise.reject(
                new CaptureStorageError(
                    'busy',
                    'A console reader, writer or cleanup still owns storage.',
                ),
            );
        this.writer = true;
        const previous = this.current;
        const task = (async () => {
            await previous?.close();
            const store = await NativeConsoleJournal.open(this.profile, { profileOwned: true });
            this.current = store;
            return store;
        })();
        this.transition = task;
        void task
            .finally(() => {
                if (this.transition === task) this.transition = undefined;
            })
            .catch(() => {});
        return task;
    };
    private async closeReader(handle: string) {
        const reader = this.readers.get(handle);
        if (!reader) return;
        if (reader.closing) return reader.closing;
        const task = (async () => {
            await reader.iterator.return(undefined);
            this.readers.delete(handle);
            this.references--;
        })();
        reader.closing = task;
        try {
            await task;
        } catch (error) {
            reader.closing = undefined;
            throw error;
        }
    }
    dispatch(input: unknown): Promise<unknown> {
        const task = this.runDispatch(input);
        this.requests.add(task);
        void task.finally(() => this.requests.delete(task)).catch(() => {});
        return task;
    }
    private async runDispatch(input: unknown): Promise<unknown> {
        this.check();
        const request = consoleArchiveRequest(input),
            epoch = this.epoch;
        if (request.op === 'export') return { saved: await this.save(request, epoch) };
        if (request.op === 'cancel-export') {
            const job = this.exports.get(request.owner);
            if (job) {
                job.controller.abort();
                await job.done.catch(() => {});
            }
            return { ok: true };
        }
        if (request.op === 'unpin') {
            const pin = this.pins.get(request.handle);
            if (pin) {
                await pin.release();
                if (this.pins.get(request.handle) === pin) {
                    this.pins.delete(request.handle);
                    this.references--;
                }
            }
            return { ok: true };
        }
        if (request.op === 'pull' || request.op === 'return') {
            const reader = this.readers.get(request.handle);
            if (!reader) {
                if (request.op === 'return') return { ok: true };
                throw new CaptureStorageError('invalid', 'Console reader is stale.');
            }
            if (request.op === 'return') {
                await this.closeReader(request.handle);
                return { ok: true };
            }
            if (reader.pulling || reader.closing)
                throw new CaptureStorageError('busy', 'Await the current console read.');
            reader.pulling = true;
            try {
                const next = reader.first ?? (await reader.iterator.next());
                reader.first = null;
                if (epoch !== this.epoch)
                    throw new CaptureStorageError('io', 'Console reader owner changed.');
                if (next.done) {
                    await this.closeReader(request.handle);
                    return { done: true };
                }
                return { done: false, value: next.value };
            } catch (error) {
                await this.closeReader(request.handle);
                throw storageError(error);
            } finally {
                reader.pulling = false;
            }
        }
        const admission = request.op === 'read' ? 'reader' : request.op === 'pin' ? 'pin' : null;
        if (admission === 'reader') {
            if (this.readers.size + this.pendingReaders >= 4)
                throw new CaptureStorageError('busy', 'Close an existing console reader first.');
            this.pendingReaders++;
        } else if (admission === 'pin') {
            if (this.pins.size + this.pendingPins >= 4)
                throw new CaptureStorageError('busy', 'Close another console export first.');
            this.pendingPins++;
        }
        this.references++;
        let keep = false;
        try {
            const journal = await this.getJournal();
            if (epoch !== this.epoch)
                throw new CaptureStorageError('io', 'Console archive owner changed.');
            if (request.op === 'list') {
                const result = await journal.list(request.after, request.limit);
                if (epoch !== this.epoch)
                    throw new CaptureStorageError('io', 'Console catalog owner changed.');
                return result;
            }
            if (request.op === 'delete') {
                await journal.delete(request.id);
                return { ok: true };
            }
            if (request.op === 'pin') {
                const pin = await journal.pin();
                if (epoch !== this.epoch) {
                    await pin.release();
                    throw new CaptureStorageError('io', 'Console export owner changed.');
                }
                const handle = randomUUID();
                this.pins.set(handle, pin);
                keep = true;
                return { handle };
            }
            const iterator = journal.read(request.id);
            let first: Awaited<ReturnType<typeof iterator.next>>;
            try {
                first = await iterator.next();
                if (epoch !== this.epoch)
                    throw new CaptureStorageError('io', 'Console reader owner changed.');
            } catch (error) {
                await iterator.return(undefined);
                throw error;
            }
            const handle = randomUUID();
            this.readers.set(handle, { iterator, first, pulling: false });
            keep = true;
            return { handle };
        } finally {
            if (admission === 'reader') this.pendingReaders--;
            else if (admission === 'pin') this.pendingPins--;
            if (!keep) this.references--;
        }
    }
    private save(request: Extract<ConsoleExportRequest, { op: 'export' }>, epoch: number) {
        if (!this.destination)
            return Promise.reject(
                new CaptureStorageError('unsupported', 'Native console export is unavailable.'),
            );
        if (this.exports.size >= 2 || this.exports.has(request.owner))
            return Promise.reject(
                new CaptureStorageError('busy', 'Finish or cancel another console export first.'),
            );
        const controller = new AbortController();
        const check = () => {
            if (controller.signal.aborted || epoch !== this.epoch)
                throw new CaptureStorageError('io', 'Console export cancelled.');
        };
        this.references++;
        const done = (async () => {
            const journal = await this.getJournal();
            check();
            const pin = await journal.pin();
            try {
                const file = await this.destination!(request.format);
                check();
                if (!file) return false;
                await saveCaptureExport(
                    file,
                    streamConsoleReport(journal, request.format, request.scope, check),
                    true,
                    controller.signal,
                );
                return true;
            } finally {
                await pin.release();
            }
        })().finally(() => {
            this.references--;
            this.exports.delete(request.owner);
        });
        this.exports.set(request.owner, { controller, done });
        return done;
    }
    async reset() {
        this.epoch++;
        for (const job of this.exports.values()) job.controller.abort();
        await Promise.all(
            [...this.pins].map(async ([handle, pin]) => {
                await pin.release();
                if (this.pins.get(handle) === pin) {
                    this.pins.delete(handle);
                    this.references--;
                }
            }),
        );
        await Promise.all([...this.readers.keys()].map((handle) => this.closeReader(handle)));
        await Promise.allSettled([...this.requests]);
    }
    async shutdown() {
        this.closing = true;
        await this.reset();
        await this.transition?.catch(() => {});
        if (this.references)
            throw new CaptureStorageError('busy', 'Console operations remain pending.');
        await this.current?.close();
    }
    get hasResources() {
        return (
            Boolean(this.current && !this.current.resourceClosed) ||
            Boolean(this.transition) ||
            this.references > 0 ||
            this.requests.size > 0 ||
            this.exports.size > 0
        );
    }
    get snapshot() {
        return {
            references: this.references,
            readers: this.readers.size,
            pins: this.pins.size,
            pendingReaders: this.pendingReaders,
            pendingPins: this.pendingPins,
            requests: this.requests.size,
            exports: this.exports.size,
            transition: Boolean(this.transition),
            writer: this.writer && Boolean(this.current && !this.current.resourceClosed),
            closed: Boolean(this.current?.resourceClosed),
        };
    }
}
