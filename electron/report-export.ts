import path from 'node:path';
import type * as FS from 'node:fs/promises';
import { createReport } from '../shared/report';
import type { Snapshot } from '../shared/types';
import type { ReportExportStatus } from '../shared/report-export';

type Bindings = Pick<typeof FS, 'mkdir' | 'open' | 'link' | 'unlink' | 'rmdir' | 'lstat' | 'realpath'>;
export interface ReportExportIO {
    fs: Bindings;
    random(): string;
    choose(filename: string): Promise<{ canceled: boolean; filePath?: string }>;
    notify(status: ReportExportStatus): void;
}
const readable = (error: unknown) => {
    try { return String(error instanceof Error ? error.message : error).slice(0, 512); }
    catch { return 'Unprintable export error'; }
};
const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const cancelled = Symbol('report-export-cancelled');

/** All I/O is injected; importing this module performs no filesystem operations.
 * Namespace assumption: trusted, stable selected parent; no hostile same-user/admin
 * mutation. Private exclusive staging is not an atomic handle-relative namespace.
 */
export class ReportExportAttempt {
    readonly completed: Promise<ReportExportStatus>;
    readonly retired: Promise<void>;
    private complete!: (value: ReportExportStatus) => void;
    private retire!: () => void;
    private value: ReportExportStatus;
    private primary?: unknown;
    private cleanup = new Map<string, unknown>();
    private custody: { directory?: string; temporary?: string; handle?: FS.FileHandle } = {};
    constructor(readonly id: string, snapshot: Snapshot, private io: ReportExportIO) {
        this.value = { id, filename: `diagnostic-${snapshot.mode}-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`,
            publication: 'unpublished', retirement: 'pending', cancelRequested: false, cleanup: [] };
        this.completed = new Promise((resolve) => { this.complete = resolve; });
        this.retired = new Promise((resolve) => { this.retire = resolve; });
    }
    status(): ReportExportStatus { return { ...this.value, cleanup: [...this.value.cleanup] }; }
    originalErrors() { return { primary: this.primary, cleanup: new Map(this.cleanup) }; }
    retainedResources() {
        return { directory: this.custody.directory, temporary: this.custody.temporary,
            handleHeld: this.custody.handle !== undefined };
    }
    cancel() {
        if (this.value.retirement !== 'acknowledged') {
            this.value.cancelRequested = true;
            this.emit();
        }
        return this.retired;
    }
    private emit() { try { this.io.notify(this.status()); } catch { /* Notification cannot retire resources. */ } }
    private check() { if (this.value.cancelRequested) throw cancelled; }
    private fail(error: unknown) {
        if (this.value.primary === undefined) { this.primary = error; this.value.primary = readable(error); }
        this.emit();
    }
    private blocked(stage: string, error: unknown) {
        this.cleanup.set(stage, error);
        this.value.cleanup = [...this.cleanup].map(([key, value]) => key + ': ' + readable(value));
        this.value.retirement = 'blocked';
        this.emit();
    }
    /** Invoked once by the service after admission, before any caller await. */
    async run(snapshot: Snapshot) {
        let directory: string | undefined, temporary: string | undefined;
        let handle: FS.FileHandle | undefined;
        let fileOwned = false, publicationUncertain = false;
        this.emit();
        try {
            const choice = await this.io.choose(this.value.filename);
            if (choice.canceled || !choice.filePath) this.value.cancelRequested = true;
            this.check();
            const destination = path.resolve(choice.filePath!);
            const parent = path.dirname(destination);
            const stat = await this.io.fs.lstat(parent);
            if (!stat.isDirectory() || stat.isSymbolicLink() || await this.io.fs.realpath(parent) !== parent)
                throw Error('Report destination parent must be a physical directory.');
            this.check();
            const token = this.io.random();
            if (!/^[a-f0-9-]{36}$/i.test(token)) throw Error('Invalid report staging identity.');
            const proposed = path.join(parent, '.diagnostic-hub-report-' + token);
            // Exclusive creation; never adopt an existing directory or change its permissions.
            await this.io.fs.mkdir(proposed, { recursive: false, mode: 0o700 });
            directory = proposed;
            this.custody.directory = directory;
            this.check();
            temporary = path.join(directory, 'report.tmp');
            handle = await this.io.fs.open(temporary, 'wx', 0o600);
            this.custody.handle = handle;
            this.custody.temporary = temporary;
            fileOwned = true; // Custody is installed before stat/write awaits.
            const identity = await handle.stat();
            if (!identity.isFile() || identity.nlink !== 1) throw Error('Invalid report staging file.');
            const text = JSON.stringify(createReport(snapshot), null, 2);
            let position = 0;
            for (let start = 0; start < text.length;) {
                this.check();
                let end = Math.min(text.length, start + 16384);
                // Preserve UTF-8 bytes when a surrogate pair crosses a chunk boundary.
                if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
                const bytes = new TextEncoder().encode(text.slice(start, end));
                for (let offset = 0; offset < bytes.length;) {
                    this.check();
                    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position);
                    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset)
                        throw Error('Report writer did not acknowledge a valid byte count.');
                    position += bytesWritten; offset += bytesWritten;
                }
                start = end;
            }
            await handle.sync();
            this.check();
            this.value.publication = 'pending'; this.emit();
            this.check();
            try {
                // Same-volume new-only publication; never fall back to rename/overwrite.
                await this.io.fs.link(temporary, destination);
                this.value.publication = 'published'; this.emit();
            } catch (error) {
                // Collision is a known no-publication outcome; other errors may have
                // ambiguous disposition. Do not remove/retry the destination.
                publicationUncertain = code(error) !== 'EEXIST';
                this.value.publication = publicationUncertain ? 'uncertain' : 'unpublished';
                throw error;
            }
        } catch (error) {
            if (error === cancelled && this.value.publication === 'pending') this.value.publication = 'unpublished';
            if (error !== cancelled) this.fail(error);
        }
        if (handle) {
            try { await handle.close(); this.custody.handle = undefined; }
            catch (error) { this.blocked('close', error); return; }
        }
        if (publicationUncertain) {
            this.blocked('publication', Error('No acknowledged publication disposition; staging retained.'));
            return;
        }
        if (fileOwned) {
            try { await this.io.fs.unlink(temporary!); this.custody.temporary = undefined; }
            catch (error) { this.blocked('remove staging file', error); return; }
        }
        if (directory) {
            try { await this.io.fs.rmdir(directory); this.custody.directory = undefined; }
            catch (error) { this.blocked('remove staging directory', error); return; }
        }
        this.value.retirement = 'acknowledged';
        this.value.outcome = this.value.publication === 'published' ? 'saved' :
            this.value.primary !== undefined ? 'failed' : 'cancelled';
        this.emit(); this.retire(); this.complete(this.status());
    }
}

export class NativeReportExports {
    private owner?: ReportExportAttempt;
    private last?: ReportExportStatus;
    private stopping = false;
    constructor(private readonly io: ReportExportIO) {}
    get retainedAttempt() { return this.owner; }
    start(id: string, snapshot: Snapshot): Promise<ReportExportStatus> {
        if (this.stopping) throw Error('Diagnostic Hub is shutting down.');
        if (this.owner) throw Error('The previous report export has not retired.');
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error('Invalid report export identity.');
        const owner = new ReportExportAttempt(id, snapshot, this.io);
        this.owner = owner;
        void owner.retired.then(() => {
            if (this.owner === owner) { this.last = owner.status(); this.owner = undefined; }
        });
        void owner.run(snapshot);
        return owner.completed;
    }
    status() {
        const value = this.owner?.status() ?? this.last;
        return value ? { ...value, cleanup: [...value.cleanup] } : null;
    }
    cancel(id: string) { if (this.owner?.id === id) void this.owner.cancel(); }
    shutdown(): Promise<void> {
        this.stopping = true;
        return this.owner?.cancel() ?? Promise.resolve();
    }
}
