import { UpdateOwnership } from './update-ownership';
import { writeUpdateFile, publishUpdateFile, removeUpdateFile } from './update-owned-file';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createReport, MAX_REPORT_BYTES, parseReport } from '../shared/report';
import type { Snapshot, UpdateMode, UpdateRecovery } from '../shared/types';

interface PendingReport {
    id: string;
    mode: 'preserve' | 'smart';
}

// Backups are durable; the small restart marker is acknowledged only after the UI loads it.
// Neither renderer-supplied paths nor connection credentials enter this store.
export class UpdateReports {
    private pending: string;

    private armedId: string | null | undefined;
    isArmed(report: PendingReport | null) {
        return report !== null && this.armedId === report.id;
    }
    constructor(
        private directory: string,
        private ownership = new UpdateOwnership(),
    ) {
        this.pending = path.join(directory, 'pending.json');
    }

    async save(mode: UpdateMode, snapshot?: Snapshot): Promise<PendingReport | null> {
        if (mode === 'clean' || !snapshot) return null;
        const content = JSON.stringify(createReport(snapshot), null, 4);
        if (Buffer.byteLength(content) > MAX_REPORT_BYTES)
            throw Error('The report exceeds the 16 MiB import limit. Update was not started.');
        // Validate the same format that the next version will import before writing a backup.
        parseReport(content);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const pending = { id: randomUUID(), mode };
        await writeUpdateFile(this.ownership, 'backup', this.reportPath(pending.id), content);
        return pending;
    }

    async arm(report: PendingReport | null): Promise<void> {
        if (!report) {
            await removeUpdateFile(this.ownership, 'restore marker removal', this.pending);
            this.armedId = null;
            return;
        }
        const temporary = `${this.pending}.${randomUUID()}.part`;
        await publishUpdateFile(
            this.ownership,
            'restore marker',
            temporary,
            this.pending,
            JSON.stringify(report),
            () => {
                this.armedId = report.id;
            },
        );
    }

    private reportPath(id: string): string {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))
            throw Error('Invalid saved update report.');
        return path.join(this.directory, `report-${id}.json`);
    }

    private async marker(): Promise<PendingReport | null> {
        let content: string;
        try {
            if ((await stat(this.pending)).size > 4096)
                throw Error('Invalid update report marker.');
            content = await readFile(this.pending, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        const value = JSON.parse(content);
        if (!value || (value.mode !== 'preserve' && value.mode !== 'smart'))
            throw Error('Invalid update report marker.');
        this.reportPath(value.id);
        return { id: value.id, mode: value.mode };
    }

    async read(): Promise<UpdateRecovery | null> {
        const pending = await this.marker();
        if (!pending) return null;
        const reportPath = this.reportPath(pending.id);
        if ((await stat(reportPath)).size > MAX_REPORT_BYTES)
            throw Error('The saved update report exceeds the 16 MiB import limit.');
        return {
            ...pending,
            reportPath,
            ...(pending.mode === 'smart'
                ? { snapshot: parseReport(await readFile(reportPath, 'utf8')) }
                : {}),
        };
    }

    async acknowledge(id: string): Promise<void> {
        this.reportPath(id);
        if ((await this.marker())?.id === id) {
            await removeUpdateFile(this.ownership, 'restore marker removal', this.pending);
            if (this.armedId === id) this.armedId = null;
        }
    }
}
