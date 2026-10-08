import {
    ArrowRight,
    ArrowUpRight,
    Cable,
    ChevronRight,
    CircleAlert,
    CircleCheck,
    LoaderCircle,
    Plug,
    RefreshCw,
    Server,
    ShieldCheck,
    Terminal,
    Unplug,
} from 'lucide-react';
import { useMemo } from 'react';
import { evidence, formatKiB, summarize } from '../../shared/diagnostics/metrics';
import { categoryLabels, probes } from '../../shared/diagnostics/probes';
import type { Category, Probe, Snapshot } from '../../shared/types';
import { RoundedIcon } from '../components/RoundedIcon';
import { BitsArtwork } from '../features/overview/BitsArtwork';

import type { View } from '../app/view';
import { Metric } from '../components/Metric';
import { Progress } from '../components/Progress';
interface OverviewProps {
    snapshot: Snapshot | null;
    imported: boolean;
    connected: boolean;
    native: boolean;
    busy: boolean;
    connecting: boolean;
    disconnecting: boolean;
    live: boolean;
    refresh: () => Promise<boolean>;
    setView: (view: View) => void;
    onInspectProbe: (probe: Probe) => Promise<void>;
}
export function OverviewPage({
    snapshot,
    imported,
    connected,
    native,
    busy,
    connecting,
    disconnecting,
    live,
    refresh,
    setView,
    onInspectProbe,
}: OverviewProps) {
    const summary = useMemo(() => summarize(snapshot), [snapshot]);
    const isDemo = snapshot?.mode === 'demo';
    const collected = snapshot?.results.filter((item) => item.status === 'collected').length ?? 0;
    const attention = summary.findings.filter((item) => item.level === 'warning').length;
    return (
        <>
            <section className="device-hero">
                <div className="device-hero-info">
                    <div className="hero-meta">
                        <span className="hero-tag">
                            <Server size={12} />
                            {imported
                                ? 'IMPORTED EVIDENCE'
                                : isDemo
                                  ? 'SAMPLE DEVICE'
                                  : 'LINUX DEVICE'}
                        </span>
                        <span
                            className={`connection-pill ${connected ? 'connected' : 'disconnected'}`}
                        >
                            {connected ? <Plug size={15} /> : <Unplug size={15} />}
                            {imported
                                ? 'Historical snapshot'
                                : isDemo
                                  ? 'Simulated snapshot'
                                  : connected
                                    ? 'SSH connected'
                                    : 'Disconnected'}
                        </span>
                    </div>
                    <h2>{snapshot ? summary.hostname : 'Identity not collected'}</h2>
                    <p>
                        {snapshot ? summary.distro : '—'}
                        <span>·</span>
                        {summary.architecture}
                        <span>·</span>
                        {`Kernel ${summary.kernel}`}
                    </p>
                    <div className="device-address">
                        <Cable size={15} />
                        <span>{snapshot?.endpoint ?? '—'}</span>
                        <span className="address-separator" />
                        <span>SSH</span>
                        <span className="address-separator" />
                        <ShieldCheck size={14} />
                        <span>Read-only collection</span>
                    </div>
                </div>
                <BitsArtwork collecting={busy || connecting} />
                <div className="hero-actions">
                    <button
                        className="hero-button"
                        onClick={() => void refresh()}
                        disabled={busy || connecting || disconnecting || !connected || live}
                        title={live ? 'Pause live updates to collect manually' : undefined}
                    >
                        {busy ? (
                            <LoaderCircle size={15} className="spin" />
                        ) : (
                            <RefreshCw size={15} />
                        )}
                        {busy ? 'Collecting…' : 'Refresh snapshot'}
                    </button>
                    <span>
                        Captured{' '}
                        {snapshot
                            ? new Date(snapshot.capturedAt).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                              })
                            : '—'}
                    </span>
                </div>
            </section>

            <div className="metric-grid">
                <Metric
                    title="System load"
                    icon="system"
                    value={summary.load[0] || '—'}
                    unit="1 min"
                    detail={
                        summary.load.length
                            ? `5 min ${summary.load[1]}  ·  15 min ${summary.load[2]}`
                            : 'Load average unavailable'
                    }
                >
                    <div
                        className="load-description"
                        title="Average number of runnable tasks and tasks in uninterruptible wait, often for I/O. The minute labels are averaging windows, not task durations or CPU percentages."
                    >
                        Average task count · runnable + I/O wait
                    </div>
                </Metric>
                <Metric
                    title="Memory usage"
                    icon="memory"
                    value={
                        summary.memory.usedPercent === null ? '—' : `${summary.memory.usedPercent}`
                    }
                    unit={summary.memory.usedPercent === null ? '' : '%'}
                    detail={
                        summary.memory.total
                            ? `${formatKiB(summary.memory.available ?? summary.memory.free ?? 0)} ${summary.memory.available === null ? 'free' : 'available'} of ${formatKiB(summary.memory.total)}`
                            : 'Memory data unavailable'
                    }
                >
                    <Progress value={summary.memory.usedPercent ?? 0} />
                </Metric>
                <Metric
                    title="Writable storage"
                    icon="storage"
                    value={String(
                        (
                            summary.filesystems.find((item) => item.mount === '/overlay') ||
                            summary.filesystems.find((item) => item.mount === '/')
                        )?.percent ?? '—',
                    )}
                    unit="%"
                    detail={
                        (
                            summary.filesystems.find((item) => item.mount === '/overlay') ||
                            summary.filesystems.find((item) => item.mount === '/')
                        )?.mount || 'Root filesystem unavailable'
                    }
                >
                    <Progress
                        value={
                            (
                                summary.filesystems.find((item) => item.mount === '/overlay') ||
                                summary.filesystems.find((item) => item.mount === '/')
                            )?.percent ?? 0
                        }
                        warning
                    />
                </Metric>
                <Metric
                    title="Device uptime"
                    icon="rtc"
                    value={summary.uptime}
                    detail={`Kernel ${summary.kernel}`}
                >
                    <div className="uptime-foot">
                        <span className="small-dot" />
                        Since last boot
                    </div>
                </Metric>
            </div>

            <section className="hardware-explorer" aria-labelledby="hardware-heading">
                <div className="section-heading">
                    <div>
                        <div className="eyebrow">BUILT FOR THE BENCH</div>
                        <h2 id="hardware-heading">Explore your hardware.</h2>
                        <p>Start with an interface. Follow the evidence.</p>
                    </div>
                    <button className="button secondary" onClick={() => setView('hardware')}>
                        All hardware <ArrowUpRight size={17} />
                    </button>
                </div>
                <div className="hardware-shortcuts">
                    {[
                        'leds',
                        'ethernet',
                        'wireless',
                        'uart',
                        'usb',
                        'flash',
                        'temperature',
                        'ddr',
                    ].map((id, index) => {
                        const probe = probes.find((item) => item.id === id)!;
                        const result = snapshot?.results.find((item) => item.id === id);
                        return (
                            <button
                                className={`hardware-tile tone-${index % 4}`}
                                key={id}
                                disabled={
                                    !result &&
                                    (busy || connecting || disconnecting || (connected && live))
                                }
                                onClick={() => void onInspectProbe(probe)}
                            >
                                <RoundedIcon name={id} size={38} />
                                <span>{probe.title}</span>
                                <span className="tile-status">
                                    {!result
                                        ? connected
                                            ? busy || connecting
                                                ? 'Collecting…'
                                                : live
                                                  ? 'Waiting for snapshot'
                                                  : 'Collect snapshot'
                                            : 'Connect device'
                                        : result.status === 'collected'
                                          ? 'Evidence ready'
                                          : result.status === 'unavailable'
                                            ? 'Unavailable'
                                            : 'Collection error'}
                                    <ArrowUpRight size={16} />
                                </span>
                            </button>
                        );
                    })}
                </div>
            </section>

            <div className="overview-grid">
                <section className="panel diagnostics-panel">
                    <div className="panel-heading">
                        <div>
                            <h3>Diagnostic coverage</h3>
                            <p>Common checks. Distro-aware collection.</p>
                        </div>
                        <button className="text-button" onClick={() => setView('diagnostics')}>
                            View all <ArrowUpRight size={15} />
                        </button>
                    </div>
                    <div className="coverage-summary">
                        <span className="coverage-icon">
                            <CircleCheck size={19} />
                        </span>
                        <div>
                            <strong>
                                {snapshot
                                    ? `${collected} of ${probes.length} checks collected`
                                    : 'No current snapshot'}
                            </strong>
                            <span>
                                Collection success is evidence availability, not a hardware PASS.
                            </span>
                        </div>
                        <span className="coverage-number">
                            {snapshot ? Math.round((collected / probes.length) * 100) : '—'}
                            <small>%</small>
                        </span>
                    </div>
                    <div className="coverage-list">
                        {(Object.keys(categoryLabels) as Category[])
                            .filter((category) => category !== 'logs')
                            .map((category) => {
                                const items = (snapshot?.results ?? []).filter(
                                    (result) =>
                                        probes.find((probe) => probe.id === result.id)?.category ===
                                        category,
                                );
                                return (
                                    <button
                                        key={category}
                                        className="coverage-row"
                                        onClick={() => setView(category)}
                                    >
                                        <span className="category-icon">
                                            <RoundedIcon name={category} size={21} />
                                        </span>
                                        <span>{categoryLabels[category]}</span>
                                        <span className="row-detail">
                                            {snapshot
                                                ? `${items.filter((item) => item.status === 'collected').length}/${items.length} collected`
                                                : 'Not collected'}
                                        </span>
                                        <ChevronRight size={14} />
                                    </button>
                                );
                            })}
                    </div>
                </section>

                <section className="panel findings-panel">
                    <div className="panel-heading">
                        <div>
                            <h3>
                                Things to investigate{' '}
                                <span className="count-label">{snapshot ? attention : '—'}</span>
                            </h3>
                            <p>Findings grounded in this snapshot.</p>
                        </div>
                        <CircleAlert size={19} className="muted-icon" />
                    </div>
                    <div className="findings-list">
                        {summary.findings.length ? (
                            summary.findings.map((finding, index) => (
                                <button
                                    className="finding"
                                    key={`${finding.probe}-${index}`}
                                    onClick={() =>
                                        void onInspectProbe(
                                            probes.find((probe) => probe.id === finding.probe)!,
                                        )
                                    }
                                >
                                    <span className={`finding-icon ${finding.level}`}>
                                        <CircleAlert size={16} />
                                    </span>
                                    <div>
                                        <strong>{finding.title}</strong>
                                        <p>{finding.detail}</p>
                                        <span>
                                            Inspect evidence <ArrowRight size={12} />
                                        </span>
                                    </div>
                                </button>
                            ))
                        ) : (
                            <div className="empty-findings">
                                <CircleCheck size={28} />
                                <strong>
                                    {snapshot ? 'No threshold findings' : 'Not collected'}
                                </strong>
                                <p>
                                    {snapshot
                                        ? 'Review the raw evidence for context. This is not a complete device health assessment.'
                                        : 'Findings will appear after a new snapshot is collected.'}
                                </p>
                            </div>
                        )}
                    </div>
                    <div className="panel-footnote">
                        <ShieldCheck size={14} />
                        No configuration changes or stress tests are performed.
                    </div>
                </section>
            </div>

            <section className="panel log-preview">
                <div className="panel-heading">
                    <div className="inline-title">
                        <Terminal size={18} />
                        <h3>Recent system activity</h3>
                        <span className="subtle-badge">
                            {!snapshot ? 'No snapshot' : isDemo ? 'Sample logs' : 'Snapshot logs'}
                        </span>
                    </div>
                    <button className="text-button" onClick={() => setView('logs')}>
                        Open logs <ArrowUpRight size={15} />
                    </button>
                </div>
                <pre>
                    {!snapshot
                        ? 'Not collected'
                        : evidence(snapshot, 'logs').trim().split('\n').slice(-3).join('\n') ||
                          'No log evidence collected. Open logs to inspect the result.'}
                </pre>
            </section>
        </>
    );
}
