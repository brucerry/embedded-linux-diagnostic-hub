import { ExternalLink, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DesktopBridge, Snapshot, UpdateMode, UpdateStatus } from '../../../shared/types';
import { RELEASES_URL } from '../../../shared/project';
import { Modal } from '../../components/Modal';
import { message } from '../../services/errors';

export function UpdateModal({
    bridge,
    snapshot,
    connecting,
    onStart,
    onClose,
}: {
    bridge: DesktopBridge;
    snapshot: Snapshot | null;
    connecting: boolean;
    onStart: () => void;
    onClose: () => void;
}) {
    const [includePrereleases, setIncludePrereleases] = useState(true);
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [mode, setMode] = useState<UpdateMode>(snapshot ? 'smart' : 'clean');
    const [progress, setProgress] = useState('');
    async function check(include: boolean) {
        setBusy(true);
        setError('');
        setStatus(null);
        setProgress('Checking GitHub…');
        try {
            const result = await bridge.checkUpdates(include);
            setStatus(result);
        } catch (err) {
            setError(message(err));
        } finally {
            setBusy(false);
        }
    }
    useEffect(() => {
        void check(true);
    }, []);
    useEffect(() => bridge.onUpdateProgress?.(setProgress), [bridge]);
    return (
        <Modal title="Application updates" onClose={onClose} busy={busy}>
            <p>
                Check{' '}
                <a
                    className="release-link"
                    href={RELEASES_URL}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="GitHub releases (opens in your browser)"
                    onClick={(event) => {
                        event.preventDefault();
                        void bridge.openReleases().catch((err) => setError(message(err)));
                    }}
                >
                    GitHub <ExternalLink size={14} aria-hidden="true" />
                </a>{' '}
                for the newest compatible release. Downloads are saved in your user folder and
                require no administrator permission.
            </p>
            <label className="checkbox-label">
                <input
                    type="checkbox"
                    checked={includePrereleases}
                    disabled={busy}
                    onChange={(event) => {
                        setIncludePrereleases(event.target.checked);
                        void check(event.target.checked);
                    }}
                />
                Include prereleases
            </label>
            {busy && (
                <p role="status">
                    <LoaderCircle size={16} className="spin" /> {progress}
                </p>
            )}
            {status && (
                <section className="fingerprint-panel">
                    <p>
                        Current version: <strong>v{status.currentVersion}</strong>
                    </p>
                    {status.release ? (
                        <>
                            <p>
                                Available: <strong>v{status.release.version}</strong> ·{' '}
                                {status.release.prerelease ? 'Prerelease' : 'Official release'}
                            </p>
                            {status.release.notes && (
                                <details>
                                    <summary>Release notes</summary>
                                    <pre className="update-notes">{status.release.notes}</pre>
                                </details>
                            )}
                            {!status.installable && (
                                <p>Install updates from a packaged desktop application.</p>
                            )}
                        </>
                    ) : (
                        <p role="status">No newer compatible release is available.</p>
                    )}
                </section>
            )}
            {status?.release && (
                <fieldset className="update-options" disabled={busy}>
                    <legend>Choose how to update</legend>
                    {(
                        [
                            [
                                'clean',
                                'Update without saving',
                                'Start with an empty workspace. Do not save the current report. Existing backups and trusted SSH fingerprints are kept.',
                            ],
                            [
                                'preserve',
                                'Save report & update',
                                'Save the current report, then start with an empty workspace. You can import the backup later.',
                            ],
                            [
                                'smart',
                                'Save, update & reopen report',
                                'Save the current report and reopen it automatically after the update, with SSH disconnected.',
                            ],
                        ] as const
                    ).map(([value, title, description]) => (
                        <label
                            key={value}
                            className={`update-option ${mode === value ? 'selected' : ''}`}
                        >
                            <input
                                type="radio"
                                name="update-mode"
                                value={value}
                                checked={mode === value}
                                onChange={() => setMode(value)}
                            />
                            <span>
                                <strong>{title}</strong>
                                <span>{description}</span>
                            </span>
                        </label>
                    ))}
                    {!snapshot && (
                        <p>
                            No report is available to save. All update modes will start with an
                            empty workspace.
                        </p>
                    )}
                </fieldset>
            )}
            <p>
                Starting an update pauses live updates, waits for any active collection, and
                disconnects the device. The updated app never reconnects automatically.
            </p>
            {snapshot && mode !== 'clean' && (
                <p>
                    Your report backup is saved in the app's user data folder under update-reports.
                </p>
            )}
            {error && (
                <div role="alert" className="form-error">
                    {error}
                </div>
            )}
            <div className="modal-actions">
                <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void check(includePrereleases)}
                >
                    <RefreshCw size={16} />
                    Check again
                </button>
                <button className="button secondary" disabled={busy} onClick={onClose}>
                    Cancel update
                </button>
                {status?.release && (
                    <button
                        className="button primary"
                        disabled={busy || connecting || !status.installable}
                        onClick={async () => {
                            setBusy(true);
                            setError('');
                            setProgress('Preparing the update…');
                            onStart();
                            try {
                                await bridge.startUpdate({
                                    mode,
                                    ...(snapshot ? { snapshot } : {}),
                                });
                            } catch (err) {
                                setError(message(err));
                                setBusy(false);
                            }
                        }}
                    >
                        <Download size={16} />
                        Start update
                    </button>
                )}
            </div>
        </Modal>
    );
}
