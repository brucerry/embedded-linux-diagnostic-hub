import { ExternalLink, Download, LoaderCircle, RefreshCw, X, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
    DesktopBridge,
    Snapshot,
    UpdateMode,
    UpdateStatus,
    UpdateProgress,
    UpdateInfo,
} from '../../../shared/types';
import { RELEASES_URL } from '../../../shared/project';
import { Modal } from '../../components/Modal';
import { message } from '../../services/errors';
import { UpdateLocation } from './UpdateLocation';

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
    const progressRef = useRef<HTMLElement>(null);
    const [includePrereleases, setIncludePrereleases] = useState(true);
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (busy) progressRef.current?.closest<HTMLElement>('.modal')?.scrollTo({ top: 0 });
    }, [busy]);

    const [error, setError] = useState('');
    const [mode, setMode] = useState<UpdateMode>(snapshot ? 'smart' : 'clean');
    const [progress, setProgress] = useState<UpdateProgress>({ stage: 'preparing', message: '' });
    const [info, setInfo] = useState<UpdateInfo | null>(null);
    const [infoError, setInfoError] = useState('');
    const readInfo = async () => {
        try {
            const value = await bridge.readUpdateInfo?.();
            if (value) setInfo(value);
            setInfoError('');
        } catch (e) {
            setInfoError(message(e));
        }
    };
    const determinate =
        progress.stage === 'download' &&
        Number.isSafeInteger(progress.totalBytes) &&
        progress.totalBytes! > 0 &&
        Number.isSafeInteger(progress.receivedBytes) &&
        progress.receivedBytes! >= 0 &&
        progress.receivedBytes! <= progress.totalBytes!;
    async function check(include: boolean) {
        setBusy(true);
        setError('');
        setStatus(null);
        setProgress({
            stage: 'preparing',
            message: 'Checking update support and release availability…',
        });
        await readInfo();
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
    useEffect(
        () =>
            bridge.onUpdateProgress?.((value) =>
                setProgress(
                    typeof value === 'string' ? { stage: 'preparing', message: value } : value,
                ),
            ),
        [bridge],
    );
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
                    disabled={busy || Boolean(status?.manualUpdate)}
                    onChange={(event) => {
                        setIncludePrereleases(event.target.checked);
                        void check(event.target.checked);
                    }}
                />
                Include prereleases
            </label>
            {busy && (
                <section ref={progressRef} className="update-progress" aria-label="Update progress">
                    <p role="status">
                        <LoaderCircle size={16} className="spin" /> {progress.message}
                    </p>
                    <progress
                        aria-label={
                            progress.stage === 'download'
                                ? 'Release download progress'
                                : 'Current update stage progress'
                        }
                        {...(determinate
                            ? { value: progress.receivedBytes, max: progress.totalBytes }
                            : {})}
                    />
                    {determinate && (
                        <p>
                            {Math.floor((progress.receivedBytes! / progress.totalBytes!) * 100)}% ·{' '}
                            {progress.receivedBytes!.toLocaleString()} /{' '}
                            {progress.totalBytes!.toLocaleString()} bytes downloaded. Verification
                            follows.
                        </p>
                    )}
                    {progress.stagingPath && (
                        <p>
                            Temporary staging file:<code>{progress.stagingPath}</code>
                        </p>
                    )}
                    {progress.verifiedPath && (
                        <p>
                            Verified launchable app:<code>{progress.verifiedPath}</code>
                        </p>
                    )}
                </section>
            )}
            {info && (
                <details className="update-locations">
                    <summary>Application locations and previous update</summary>
                    <UpdateLocation bridge={bridge} info={info} />
                </details>
            )}
            {infoError && <p role="alert">Update location unavailable: {infoError}</p>}
            {status && (
                <section className="fingerprint-panel">
                    <p>
                        Current version: <strong>v{status.currentVersion}</strong>
                    </p>
                    {status.installationUnavailableReason && (
                        <p role="status">{status.installationUnavailableReason}</p>
                    )}
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
                    ) : status.installationUnavailableReason ? null : (
                        <p role="status">No newer compatible release is available.</p>
                    )}
                </section>
            )}
            {status?.manualUpdate && (
                <section className="update-location" aria-label="Mac manual update guidance">
                    <h3>
                        Manual macOS update · current app architecture:{' '}
                        {status.manualUpdate.architecture === 'arm64'
                            ? 'Apple Silicon arm64'
                            : 'Intel x64'}
                    </h3>
                    <p>
                        The installer detects native machine architecture, including translated
                        terminals. Quit Diagnostic Hub. Open GitHub releases and download
                        download-run-macos.sh plus its checksum from the same release tag. Verify
                        the saved helper with the command below, then run that saved installer
                        locally as your ordinary user. It selects the newest stable release by
                        default and verifies the archive checksum, architecture, bundle and ad-hoc
                        integrity signature.
                    </p>
                    <p>
                        Default installation destination:{' '}
                        <code>{status.manualUpdate.defaultDestination}</code>
                    </p>
                    <code>{status.manualUpdate.verificationCommand}</code>
                    <button
                        className="button secondary"
                        onClick={() =>
                            void bridge
                                .copyText(status.manualUpdate!.verificationCommand)
                                .catch((err) => setError(message(err)))
                        }
                    >
                        <Copy size={16} />
                        Copy helper verification command
                    </button>
                    <p>
                        The helper reports download, verification, installation and launch-request
                        stages. A launch request is not confirmation of a running app. Confirm the
                        opened app's version and location. Automatic in-app handoff is unavailable
                        on both Mac architectures; the installer rolls back on failure and honors
                        Gatekeeper and organization policy.
                    </p>
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
                    <X size={16} aria-hidden="true" />
                    Cancel update
                </button>
                {status?.release && (
                    <button
                        className="button primary"
                        disabled={busy || connecting || !status.installable}
                        onClick={async () => {
                            setBusy(true);
                            setError('');
                            setProgress({ stage: 'preparing', message: 'Preparing the update…' });
                            onStart();
                            try {
                                await bridge.startUpdate({
                                    mode,
                                    ...(snapshot ? { snapshot } : {}),
                                });
                            } catch (err) {
                                setError(message(err));
                                setBusy(false);
                                await readInfo();
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
