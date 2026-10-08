import {
    ArrowDown,
    ArrowUp,
    Box,
    CircleAlert,
    CircleCheck,
    Command,
    FileInput,
    FileJson,
    FileOutput,
    FileText,
    Github,
    Globe,
    Monitor,
    RefreshCw,
    RotateCcw,
    Plug,
    Unplug,
    X,
} from 'lucide-react';
import { useState } from 'react';
import { categoryLabels, probes } from '../../shared/diagnostics/probes';
import { APP_VERSION, REPOSITORY_URL } from '../../shared/project';
import type { Category, Probe } from '../../shared/types';
import { RoundedIcon } from '../components/RoundedIcon';
import { useDeviceSession } from '../hooks/useDeviceSession';

import { Nav } from '../components/Nav';
import { CopyButton } from '../components/CopyButton';
import { ConnectModal } from '../features/connection/ConnectModal';
import { UpdateModal } from '../features/updates/UpdateModal';
import { ResetOverlay } from '../features/session/ResetOverlay';
import { EvidenceModal } from '../features/evidence/EvidenceModal';
import { DiagnosticsPage } from '../pages/DiagnosticsPage';
import { EmptyOverview } from '../pages/EmptyOverview';
import { OverviewPage } from '../pages/OverviewPage';
import { Reports } from '../pages/ReportsPage';
import { message } from '../services/errors';
import type { View } from './view';
function App() {
    const [showUpdates, setShowUpdates] = useState(false);
    const [view, setView] = useState<View>('overview');
    const [query, setQuery] = useState('');
    const [selectedProbe, setSelectedProbe] = useState<Probe | null>(null);
    const {
        snapshot,
        workspaceReady,
        connected,
        live,
        setLive,
        pauseLiveUpdates,
        interval,
        setInterval,
        history,
        busy,
        connecting,
        disconnecting,
        resetting,
        resetProgress,
        updateReport,
        showConnect,
        setShowConnect,
        hostVerification,
        error,
        setError,
        notice,
        imported,
        importInput,
        bridge,
        refresh,
        connect,
        disconnect,
        resetData,
        exportReport,
        importReport,
    } = useDeviceSession(() => setView('overview'));
    const selectedResult = snapshot?.results.find((item) => item.id === selectedProbe?.id);
    async function inspectProbe(probe: Probe) {
        if (snapshot?.results.some((result) => result.id === probe.id)) {
            setSelectedProbe(probe);
        } else if (!connected) {
            setError('');
            setShowConnect(true);
        } else if (!busy && !connecting && !disconnecting && !resetting && !live) {
            if (await refresh()) setSelectedProbe(probe);
        }
    }

    const title =
        view === 'overview'
            ? 'Device overview'
            : view === 'diagnostics'
              ? 'Diagnostic workbench'
              : view === 'reports'
                ? 'Reports & evidence'
                : categoryLabels[view];
    return (
        <div className="app-shell" inert={resetting}>
            <header className="site-header">
                <button
                    className="brand"
                    aria-label="Diagnostic Hub home"
                    onClick={() => setView('overview')}
                >
                    <span className="brand-mark">
                        <img src="./app-icon.svg" alt="" />
                    </span>
                    <span>
                        Diagnostic<span className="brand-hub">Hub</span>
                    </span>
                </button>
                <nav className="primary-nav" aria-label="Workspace">
                    <Nav
                        icon={Box}
                        label="Overview"
                        active={view === 'overview'}
                        onClick={() => setView('overview')}
                    />
                    <Nav
                        icon={Command}
                        label="Diagnostics"
                        active={view === 'diagnostics'}
                        onClick={() => setView('diagnostics')}
                        suffix={String(probes.length)}
                    />
                    <Nav
                        icon={FileText}
                        label="Reports & evidence"
                        active={view === 'reports'}
                        onClick={() => setView('reports')}
                    />
                </nav>
                <span className="edition-label">
                    <a
                        className="repository-link"
                        href={REPOSITORY_URL}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="GitHub repository"
                        title="View source on GitHub"
                        onClick={(event) => {
                            if (bridge) {
                                event.preventDefault();
                                void bridge.openRepository().catch((err) => setError(message(err)));
                            }
                        }}
                    >
                        <Github size={20} />
                    </a>
                    {bridge ? (
                        <Monitor size={17} aria-label="Desktop application" />
                    ) : (
                        <Globe size={17} aria-label="Web application" />
                    )}
                    <span className="version-label">v{APP_VERSION}</span>
                    {bridge && (
                        <button
                            className="repository-link update-check-button"
                            aria-label="Check for updates"
                            title="Check for updates"
                            disabled={
                                resetting || showConnect || showUpdates || Boolean(selectedProbe)
                            }
                            onClick={() => setShowUpdates(true)}
                        >
                            <RefreshCw size={19} />
                        </button>
                    )}
                </span>
            </header>
            <div className="workspace">
                <nav className="insight-nav" aria-label="Device insights">
                    {(Object.keys(categoryLabels) as Category[]).map((category) => (
                        <button
                            key={category}
                            className={`insight-tab ${view === category ? 'active' : ''}`}
                            aria-current={view === category ? 'page' : undefined}
                            onClick={() => setView(category)}
                        >
                            <RoundedIcon name={category} size={18} />
                            <span>{categoryLabels[category]}</span>
                        </button>
                    ))}
                </nav>
                <main key={view}>
                    <div className="page-heading">
                        <div>
                            <div className="eyebrow">
                                <span className="spectrum-dot" />
                                EMBEDDED LINUX, UNDERSTOOD
                            </div>
                            <h1>{title}</h1>
                            <p>
                                {view === 'overview'
                                    ? 'Every interface. Every insight. One connected workspace.'
                                    : view === 'reports'
                                      ? 'Keep the context. Share the evidence. Make issues reproducible.'
                                      : 'Inspect system capabilities and the evidence behind every result.'}
                            </p>
                        </div>
                        <div className="heading-actions">
                            <button
                                className="button secondary"
                                onClick={() => importInput.current?.click()}
                                disabled={busy || resetting || connecting || disconnecting}
                            >
                                <FileInput size={16} />
                                Import report
                            </button>
                            <button
                                className="button secondary"
                                onClick={exportReport}
                                disabled={
                                    !snapshot || busy || resetting || connecting || disconnecting
                                }
                            >
                                <FileOutput size={16} />
                                Export report
                            </button>
                            <button
                                className={`button primary connection-button ${connected ? 'connected' : 'disconnected'}`}
                                data-connection={connected ? 'connected' : 'disconnected'}
                                onClick={() => {
                                    if (connected) void disconnect();
                                    else {
                                        setError('');
                                        setShowConnect(true);
                                    }
                                }}
                                disabled={busy || resetting || connecting || disconnecting}
                            >
                                {connected ? <Plug size={18} /> : <Unplug size={18} />}
                                {disconnecting
                                    ? 'Disconnecting…'
                                    : connected
                                      ? 'Disconnect device'
                                      : 'Connect device'}
                            </button>
                        </div>
                    </div>

                    {updateReport && (
                        <div className="update-report-banner" role="status">
                            <strong>
                                {updateReport.mode === 'smart'
                                    ? 'Report reopened after update'
                                    : 'Report saved before update'}
                            </strong>
                            <p>
                                SSH is disconnected. Your report backup is available for manual
                                import:
                            </p>
                            <div className="update-report-path">
                                <code>{updateReport.reportPath}</code>
                                <CopyButton
                                    text={updateReport.reportPath}
                                    label="Copy saved report path"
                                    onCopy={(text) => bridge!.copyText(text)}
                                />
                            </div>
                        </div>
                    )}
                    <input
                        ref={importInput}
                        type="file"
                        accept=".json,application/json"
                        aria-label="Import diagnostic report"
                        className="visually-hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void importReport(file);
                        }}
                    />

                    <div className={`mode-banner ${snapshot ? 'ssh-banner' : ''}`}>
                        <div>
                            <span className="sample-tag">
                                {!snapshot && !connected
                                    ? 'NOT CONNECTED'
                                    : imported
                                      ? 'IMPORTED REPORT'
                                      : connected
                                        ? 'SSH SESSION'
                                        : 'SAVED SNAPSHOT'}
                            </span>
                            <span>
                                {!snapshot
                                    ? connected
                                        ? 'SSH connected · current record cleared.'
                                        : 'Connect your target device to collect diagnostics, or import a saved report.'
                                    : imported
                                      ? `Historical ${snapshot.mode === 'demo' ? 'sample' : 'SSH'} evidence opened locally. No device connection or upload.`
                                      : `${snapshot.username}@${snapshot.endpoint} · ${connected ? `${bridge ? 'Direct SSH connected.' : 'Gateway SSH connected.'} ${live ? `Live updates every ${interval}s after collection.` : 'Live updates paused.'}` : 'Disconnected. Displaying the last collected evidence.'}`}
                            </span>
                        </div>
                    </div>

                    <div className="live-controls">
                        <button
                            type="button"
                            role="switch"
                            aria-checked={live}
                            aria-label="Live updates"
                            className={`live-switch ${live ? 'enabled' : ''}`}
                            onClick={() => setLive((value) => !value)}
                            disabled={imported || resetting}
                        >
                            <span className="switch-track">
                                <span />
                            </span>
                            Live updates <strong>{live ? 'On' : 'Off'}</strong>
                        </button>
                        <label>
                            Interval
                            <select
                                aria-label="Live update interval"
                                value={interval}
                                disabled={resetting}
                                onChange={(e) => setInterval(Number(e.target.value))}
                            >
                                {[5, 15, 30, 60].map((seconds) => (
                                    <option key={seconds} value={seconds}>
                                        {seconds} seconds
                                    </option>
                                ))}
                            </select>
                        </label>
                        <button
                            className="button danger"
                            disabled={!snapshot || resetting || connecting || disconnecting}
                            onClick={() => void resetData()}
                            title="Clear the current snapshot and graph history from RAM. Saved reports remain on disk."
                        >
                            <RotateCcw size={16} />
                            {resetting ? 'Resetting session data…' : 'Reset session data'}
                        </button>
                        <span>
                            {resetting
                                ? 'Resetting session data · live updates paused'
                                : !connected
                                  ? 'Connect a target to start updates.'
                                  : busy || connecting
                                    ? 'Collecting · next update waits for completion'
                                    : live
                                      ? `Next collection in ${interval}s`
                                      : 'Manual refresh available'}
                        </span>
                    </div>

                    {error && (
                        <div className="error-banner" role="alert">
                            <CircleAlert size={17} />
                            <span>{error}</span>
                            <button aria-label="Dismiss error" onClick={() => setError('')}>
                                <X size={15} />
                            </button>
                        </div>
                    )}

                    {view === 'overview' ? (
                        snapshot || workspaceReady ? (
                            <OverviewPage
                                snapshot={snapshot}
                                imported={imported}
                                connected={connected}
                                native={Boolean(bridge)}
                                busy={busy}
                                connecting={connecting}
                                disconnecting={disconnecting}
                                live={live}
                                refresh={refresh}
                                setView={setView}
                                onInspectProbe={inspectProbe}
                            />
                        ) : (
                            <EmptyOverview
                                onConnect={() => {
                                    setError('');
                                    setShowConnect(true);
                                }}
                                onImport={() => importInput.current?.click()}
                            />
                        )
                    ) : view === 'reports' ? (
                        snapshot || workspaceReady ? (
                            <Reports
                                snapshot={snapshot}
                                imported={imported}
                                onExport={exportReport}
                                onImport={() => importInput.current?.click()}
                            />
                        ) : (
                            <section className="panel reports-panel">
                                <span className="report-illustration">
                                    <FileJson size={48} />
                                </span>
                                <h2>No diagnostic report yet</h2>
                                <p>
                                    Connect a target device to collect a snapshot, or import a
                                    previously saved report. Export becomes available when there is
                                    evidence to save.
                                </p>
                                <button
                                    className="button secondary"
                                    onClick={() => importInput.current?.click()}
                                >
                                    <FileInput size={17} />
                                    Import report
                                </button>
                            </section>
                        )
                    ) : (
                        <DiagnosticsPage
                            query={query}
                            setQuery={setQuery}
                            view={view}
                            snapshot={snapshot}
                            busy={busy}
                            connecting={connecting}
                            disconnecting={disconnecting}
                            connected={connected}
                            live={live}
                            refresh={refresh}
                            onInspectProbe={inspectProbe}
                        />
                    )}
                    <footer className="workspace-footer">
                        <span>
                            {connected ? <Plug size={16} /> : <Unplug size={16} />}
                            {!snapshot
                                ? connected
                                    ? 'SSH connected · no current snapshot'
                                    : 'No device connected · no data collected'
                                : imported
                                  ? 'Report opened locally · no device connection'
                                  : connected
                                    ? `Secure ${bridge ? 'direct' : 'gateway'} SSH connection`
                                    : 'Disconnected · historical evidence'}
                        </span>
                        <span>Ubuntu · Debian · OpenWrt · BusyBox</span>
                    </footer>
                </main>
            </div>
            {notice && (
                <div className="toast" role="status">
                    <CircleCheck size={17} />
                    {notice}
                </div>
            )}
            {showUpdates && bridge && (
                <UpdateModal
                    bridge={bridge}
                    snapshot={snapshot}
                    connecting={connecting || disconnecting || resetting}
                    onStart={pauseLiveUpdates}
                    onClose={() => setShowUpdates(false)}
                />
            )}
            {showConnect && (
                <ConnectModal
                    hostVerification={hostVerification}
                    onConfirmHostKey={async (accepted) => {
                        if (hostVerification)
                            await bridge?.confirmHostKey?.(hostVerification.id, accepted);
                    }}
                    native={Boolean(bridge)}
                    busy={connecting}
                    error={error}
                    onClose={() => {
                        if (!connecting) setShowConnect(false);
                    }}
                    onConnect={connect}
                    onPickKey={() => bridge?.pickKey() ?? Promise.resolve(null)}
                />
            )}
            <div className="page-scroll-controls" aria-label="Page position">
                <button
                    aria-label="Scroll to top"
                    title="Scroll to top"
                    disabled={resetting || showConnect || showUpdates || Boolean(selectedProbe)}
                    onClick={() =>
                        window.scrollTo({
                            top: 0,
                            behavior: 'smooth',
                        })
                    }
                >
                    <ArrowUp size={20} />
                </button>
                <button
                    aria-label="Scroll to bottom"
                    title="Scroll to bottom"
                    disabled={resetting || showConnect || showUpdates || Boolean(selectedProbe)}
                    onClick={() =>
                        window.scrollTo({
                            top: document.documentElement.scrollHeight,
                            behavior: 'smooth',
                        })
                    }
                >
                    <ArrowDown size={20} />
                </button>
            </div>
            {resetting && <ResetOverlay progress={resetProgress} />}
            {selectedProbe && selectedResult && snapshot && (
                <EvidenceModal
                    key={selectedProbe.id}
                    probe={selectedProbe}
                    result={selectedResult}
                    snapshot={snapshot}
                    mode={imported ? 'imported' : snapshot.mode}
                    history={history}
                    onCopy={(command) =>
                        bridge ? bridge.copyText(command) : navigator.clipboard.writeText(command)
                    }
                    onClose={() => setSelectedProbe(null)}
                />
            )}
        </div>
    );
}

export default App;
