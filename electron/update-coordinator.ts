import { validateSnapshot } from '../shared/report';
import type { Snapshot, UpdateMode, UpdateProgress } from '../shared/types';
import type { UpdateReports } from './update-reports';
import type { ReleaseUpdater } from './updates';

interface Lifecycle {
    isConnecting(): boolean;
    isReportExporting?(): boolean;
    isConnected(): boolean;
    waitForCollection(): Promise<void>;
    quiesceSerial?(): Promise<void>;
    latestSnapshot(): Snapshot | null;
    disconnect(): void;
    progress(value: UpdateProgress): void;
    restart(executable: string): void | Promise<void>;
}

// One native transaction owns draining, disconnect, backup, verification and restart.
// Its lock remains held until quit, or is released on failure without reconnecting SSH.
export class UpdateCoordinator {
    active = false;

    constructor(
        private updater: Pick<ReleaseUpdater, 'assertCanDownload' | 'download' | 'executable'>,
        private reports: Pick<UpdateReports, 'save' | 'arm' | 'acknowledge'>,
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
        if (this.lifecycle.isReportExporting?.())
            throw Error('Finish the current report export before updating.');
        this.updater.assertCanDownload();
        this.active = true;
        let armed = false;
        let saved: Awaited<ReturnType<UpdateReports['save']>> = null;
        try {
            if (this.lifecycle.quiesceSerial) {
                this.lifecycle.progress({
                    stage: 'preparing',
                    message: 'Closing local Serial before update…',
                });
                await this.lifecycle.quiesceSerial();
            }
            const connected = this.lifecycle.isConnected();
            this.lifecycle.progress({
                stage: 'preparing',
                message: 'Waiting for any active collection to finish…',
            });
            await this.lifecycle.waitForCollection();
            const snapshot = connected ? (this.lifecycle.latestSnapshot() ?? supplied) : supplied;
            this.lifecycle.progress({ stage: 'preparing', message: 'Disconnecting the device…' });
            this.lifecycle.disconnect();
            if (mode !== 'clean' && snapshot)
                this.lifecycle.progress({ stage: 'preparing', message: 'Saving your report…' });
            saved = await this.reports.save(mode, snapshot);
            this.lifecycle.progress({
                stage: 'preparing',
                message: 'Downloading and verifying the update…',
            });
            await this.updater.download((progress) => this.lifecycle.progress(progress));
            const executable = await this.updater.executable();
            await this.reports.arm(saved);
            armed = true;
            this.lifecycle.progress({
                stage: 'handoff',
                message: 'Restart requested; awaiting the new application.',
                verifiedPath: executable,
            });
            await this.lifecycle.restart(executable);
        } catch (error) {
            try {
                try {
                    this.lifecycle.progress({
                        stage: 'failed',
                        message: error instanceof Error ? error.message : String(error),
                    });
                } catch {
                    // A lost renderer must not interrupt native transaction unwind.
                }
                if (armed && saved) {
                    try {
                        await this.reports.acknowledge(saved.id);
                    } catch (disarmError) {
                        throw new AggregateError(
                            [error, disarmError],
                            (error instanceof Error ? error.message : String(error)) +
                                '; recovery marker disarm failed: ' +
                                (disarmError instanceof Error
                                    ? disarmError.message
                                    : String(disarmError)),
                            { cause: error },
                        );
                    }
                }
            } finally {
                // Keep reentrant updates locked out until marker disarm settles.
                this.active = false;
            }
            throw error;
        }
    }
}
