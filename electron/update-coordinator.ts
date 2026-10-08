import { validateSnapshot } from '../shared/report';
import type { Snapshot, UpdateMode } from '../shared/types';
import { UpdateReports } from './update-reports';
import type { ReleaseUpdater } from './updates';

interface Lifecycle {
    isConnecting(): boolean;
    isConnected(): boolean;
    waitForCollection(): Promise<void>;
    latestSnapshot(): Snapshot | null;
    disconnect(): void;
    progress(message: string): void;
    restart(executable: string): void;
}

// One native transaction owns draining, disconnect, backup, verification and restart.
// Its lock remains held until quit, or is released on failure without reconnecting SSH.
export class UpdateCoordinator {
    active = false;

    constructor(
        private updater: Pick<ReleaseUpdater, 'assertCanDownload' | 'download' | 'executable'>,
        private reports: UpdateReports,
        private lifecycle: Lifecycle,
    ) {}

    async start(input: unknown): Promise<void> {
        if (!input || typeof input !== 'object') throw Error('Select an update option first.');
        const request = input as { mode: unknown; snapshot?: unknown };
        if (!['clean', 'preserve', 'smart'].includes(request.mode as string))
            throw Error('Select an update option first.');
        const mode = request.mode as UpdateMode;
        const supplied =
            mode !== 'clean' && request.snapshot !== undefined
                ? validateSnapshot(request.snapshot)
                : undefined;
        if (this.active) throw Error('An update is already in progress.');
        if (this.lifecycle.isConnecting()) throw Error('Wait for the SSH connection to finish.');
        this.updater.assertCanDownload();
        this.active = true;
        let armed = false;
        let saved: Awaited<ReturnType<UpdateReports['save']>> = null;
        try {
            const connected = this.lifecycle.isConnected();
            this.lifecycle.progress('Waiting for any active collection to finish…');
            await this.lifecycle.waitForCollection();
            const snapshot = connected ? (this.lifecycle.latestSnapshot() ?? supplied) : supplied;
            this.lifecycle.progress('Disconnecting the device…');
            this.lifecycle.disconnect();
            if (mode !== 'clean' && snapshot) this.lifecycle.progress('Saving your report…');
            saved = await this.reports.save(mode, snapshot);
            this.lifecycle.progress('Downloading and verifying the update…');
            await this.updater.download();
            const executable = await this.updater.executable();
            await this.reports.arm(saved);
            armed = true;
            this.lifecycle.progress('Restarting with the update…');
            this.lifecycle.restart(executable);
        } catch (error) {
            this.active = false;
            if (armed && saved) await this.reports.acknowledge(saved.id);
            throw error;
        }
    }
}
