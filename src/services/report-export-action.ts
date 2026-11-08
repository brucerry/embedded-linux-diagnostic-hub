import type { DesktopBridge, Snapshot } from '../../shared/types';
import type { ReportExportStatus } from '../../shared/report-export';

/** Renderer admission is advisory; the native owner remains authoritative across disposal. */
export class ReportExportAction {
    private owner?: { id: string };
    private value: ReportExportStatus | null = null;
    private epoch = 0;
    private revision = 0;
    private attached = false;
    constructor(
        private bridge: Pick<
            DesktopBridge,
            'exportReport' | 'cancelReportExport' | 'reportExportStatus' | 'onReportExportStatus'
        >,
        private changed: (value: ReportExportStatus | null) => void,
        private identity: () => string,
    ) {}
    private accept(value: ReportExportStatus | null) {
        if (!value || (this.owner && this.owner.id !== value.id)) return;
        this.owner ??= { id: value.id };
        this.value = { ...value, cleanup: [...value.cleanup] };
        this.revision++;
        if (this.attached) this.changed(this.value);
    }
    attach() {
        this.attached = true;
        const epoch = ++this.epoch;
        const unsubscribe = this.bridge.onReportExportStatus((value) => {
            if (this.attached && epoch === this.epoch) this.accept(value);
        });
        const revision = this.revision;
        void this.bridge
            .reportExportStatus()
            .then((value) => {
                if (this.attached && epoch === this.epoch && revision === this.revision)
                    this.accept(value);
            })
            .catch(() => {});
        return () => {
            if (epoch !== this.epoch) return;
            this.attached = false;
            this.epoch++;
            unsubscribe();
            if (this.owner && this.value?.retirement !== 'acknowledged')
                void this.bridge.cancelReportExport(this.owner.id).catch(() => {});
        };
    }
    async start(snapshot: Snapshot) {
        if (this.value && this.value.retirement !== 'acknowledged') return;
        const owner = (this.owner = { id: this.identity() });
        this.value = {
            id: owner.id,
            filename: `diagnostic-${snapshot.mode}-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`,
            publication: 'unpublished',
            retirement: 'pending',
            cancelRequested: false,
            cleanup: [],
        };
        this.revision++;
        if (this.attached) this.changed(this.value);
        try {
            const value = await this.bridge.exportReport(snapshot, owner.id);
            if (this.owner === owner) this.accept(value);
        } catch (error) {
            if (this.owner !== owner || this.value?.retirement === 'acknowledged') return;
            // An IPC rejection is not a native retirement acknowledgement. Reconcile
            // status, otherwise keep admission blocked rather than fabricate release.
            const revision = this.revision;
            try {
                const status = await this.bridge.reportExportStatus();
                if (this.owner !== owner || revision !== this.revision) return;
                if (status && (status.id === owner.id || status.retirement !== 'acknowledged')) {
                    if (status.id !== owner.id) this.owner = { id: status.id };
                    this.accept(status);
                    return;
                }
                this.accept({
                    ...this.value!,
                    publication: 'uncertain',
                    retirement: 'unknown',
                    primary:
                        'Report export reply has no matching native disposition: ' +
                        String(error instanceof Error ? error.message : error).slice(0, 400),
                });
            } catch {
                if (this.owner === owner && revision === this.revision)
                    this.accept({
                        ...this.value!,
                        publication: 'uncertain',
                        retirement: 'unknown',
                        primary:
                            'Report export reply and native retirement status are unavailable.',
                    });
            }
        }
    }
    cancel() {
        if (this.owner) void this.bridge.cancelReportExport(this.owner.id).catch(() => {});
    }
}
