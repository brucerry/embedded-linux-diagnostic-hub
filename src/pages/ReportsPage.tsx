import { FileInput, FileJson, FileOutput, ShieldCheck } from 'lucide-react';
import type { Snapshot } from '../../shared/types';

export function Reports({
    snapshot,
    imported,
    onExport,
    onImport,
}: {
    snapshot: Snapshot | null;
    imported: boolean;
    onExport: () => void;
    onImport: () => void;
}) {
    return (
        <section className="panel reports-panel">
            <div className="report-illustration">
                <FileJson size={48} strokeWidth={1.4} />
            </div>
            <span className="subtle-badge">
                {!snapshot
                    ? 'NO CURRENT SNAPSHOT'
                    : imported
                      ? 'IMPORTED EVIDENCE'
                      : snapshot?.mode === 'demo'
                        ? 'DEMO EVIDENCE'
                        : 'SSH EVIDENCE'}
            </span>
            <h2>One snapshot. All the context.</h2>
            <p>
                Export a structured JSON report with device identity, collection timestamps, exact
                commands, exit codes, findings, and raw output. Import saved reports locally in
                either edition.
            </p>
            <div className="report-details">
                <div>
                    <span>Source</span>
                    <strong>
                        {snapshot?.mode === 'demo'
                            ? 'Simulated device data'
                            : (snapshot?.endpoint ?? '—')}
                    </strong>
                </div>
                <div>
                    <span>Captured</span>
                    <strong>
                        {snapshot ? new Date(snapshot.capturedAt).toLocaleString() : '—'}
                    </strong>
                </div>
                <div>
                    <span>Diagnostics</span>
                    <strong>{snapshot ? `${snapshot.results.length} results` : '—'}</strong>
                </div>
                <div>
                    <span>Format</span>
                    <strong>JSON · schema v1</strong>
                </div>
            </div>
            <div className="heading-actions">
                <button className="button secondary" onClick={onImport}>
                    <FileInput size={17} />
                    Import report
                </button>
                <button className="button primary" onClick={onExport} disabled={!snapshot}>
                    <FileOutput size={17} />
                    Export diagnostic report
                </button>
            </div>
            <div className="report-note">
                <ShieldCheck size={15} />
                Report import stays local. Credentials are excluded from exports.
            </div>
        </section>
    );
}
