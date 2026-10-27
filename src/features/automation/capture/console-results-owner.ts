import { CaptureStorageError } from '../../../../shared/capture-store';
import type { ConsoleArchive } from '../../../../shared/console-storage';
import type { ConsoleExportJob } from './console-export';
import type { ConsolePreview } from './console-results-view';
import { consoleSnapshot } from '../../../../shared/console-storage';

type Resource = { archive: ConsoleArchive; dispose(): Promise<void> };
/** A view owns its admitted operations and exports, never the producer or its transport. */
export class ConsoleResultsOwner {
    private resource?: Resource;
    private pending = new Set<Promise<unknown>>();
    private controller = new AbortController();
    private closing?: Promise<void>;
    private closed = false;
    private job?: ConsoleExportJob;
    private exportReserved = false;
    private exportCancelled = false;
    private exportTask?: Promise<Awaited<ConsoleExportJob['completed']>>;
    readonly ready: Promise<void>;
    constructor(
        open: () => Promise<Resource>,
        private busy: (value: boolean) => void,
    ) {
        this.ready = Promise.resolve()
            .then(open)
            .then((value) => {
                this.resource = value;
            });
        this.track(this.ready);
    }
    readonly check = () => {
        if (this.controller.signal.aborted || this.closed)
            throw new CaptureStorageError('io', 'Console results view was closed.');
    };
    private track<T>(task: Promise<T>) {
        this.pending.add(task);
        this.busy(true);
        void task
            .finally(() => {
                this.pending.delete(task);
                if (!this.pending.size && !this.closing) this.busy(false);
            })
            .catch(() => {});
        return task;
    }
    run<T>(work: (archive: ConsoleArchive, check: () => void) => Promise<T>) {
        try {
            this.check();
        } catch (error) {
            return Promise.reject<T>(error);
        }
        const task = Promise.resolve().then(async () => {
            await this.ready;
            this.check();
            return work(this.resource!.archive, this.check);
        });
        return this.track(task);
    }
    export(start: () => Promise<ConsoleExportJob>) {
        if (this.exportReserved)
            return Promise.reject(
                new CaptureStorageError('busy', 'Await the current console export.'),
            );
        this.exportReserved = true;
        this.exportCancelled = false;
        const task = this.run(async () => {
            const job = await start();
            this.job = job;
            try {
                if (this.controller.signal.aborted || this.exportCancelled) await job.cancel();
                return await job.completed;
            } finally {
                if (this.job === job) this.job = undefined;
            }
        });
        const result = task.finally(() => {
            this.exportReserved = false;
            if (this.exportTask === result) this.exportTask = undefined;
        });
        this.exportTask = result;
        return result;
    }
    async cancelExport() {
        this.exportCancelled = true;
        await this.job?.cancel();
        await this.exportTask?.catch(() => {});
    }
    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.controller.abort();
        this.busy(true);
        const task = (async () => {
            const failures: unknown[] = [];
            try {
                await this.job?.cancel();
            } catch (error) {
                failures.push(error);
            }
            while (this.pending.size) await Promise.allSettled([...this.pending]);
            try {
                await this.resource?.dispose();
            } catch (error) {
                failures.push(error);
            }
            if (failures.length)
                throw new AggregateError(failures, 'Console view cleanup remains pending.');
            this.closed = true;
            this.busy(false);
        })();
        this.closing = task;
        void task.catch(() => {
            if (this.closing === task) this.closing = undefined;
        });
        return task;
    }
    get resourceSnapshot() {
        return {
            pending: this.pending.size,
            export: this.exportReserved,
            closing: Boolean(this.closing) && !this.closed,
            closed: this.closed,
        };
    }
}
export async function readConsolePreview(
    archive: ConsoleArchive,
    id: string,
    check: () => void,
): Promise<ConsolePreview> {
    const records: ConsolePreview['records'][number][] = [];
    let capture: ConsolePreview['capture'] | undefined,
        shownBytes = 0,
        encodedBytes = 0;
    for await (const item of archive.read(id)) {
        check();
        if (item.kind === 'metadata') capture = consoleSnapshot(item.capture);
        else {
            const size = new TextEncoder().encode(JSON.stringify(item.record)).length;
            if (records.length >= 96 || encodedBytes + size > 64 * 1024) break;
            records.push(item.record);
            encodedBytes += size;
            if (item.record.kind === 'observation') {
                // Canonical validated base64; length arithmetic avoids another retained byte buffer.
                shownBytes +=
                    (item.record.base64.length * 3) / 4 -
                    (item.record.base64.endsWith('==')
                        ? 2
                        : item.record.base64.endsWith('=')
                          ? 1
                          : 0);
            }
        }
    }
    if (!capture) throw new CaptureStorageError('integrity', 'Console preview lacks metadata.');
    return { capture, records, shownBytes, clipped: records.length < capture.records };
}
