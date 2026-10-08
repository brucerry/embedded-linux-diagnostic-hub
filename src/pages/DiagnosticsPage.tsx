import {
    ArrowUpRight,
    Cable,
    Layers3,
    LoaderCircle,
    MemoryStick,
    Play,
    Search,
    X,
} from 'lucide-react';
import { useMemo } from 'react';
import { evidence, formatKiB, summarize } from '../../shared/diagnostics/metrics';
import { categoryLabels, probes } from '../../shared/diagnostics/probes';
import { searchDiagnostics } from '../../shared/diagnostics/search';
import type { Probe, Snapshot } from '../../shared/types';
import { RoundedIcon } from '../components/RoundedIcon';

import type { View } from '../app/view';
import { Badge } from '../components/Badge';
interface DiagnosticsProps {
    query: string;
    setQuery: (query: string) => void;
    view: View;
    snapshot: Snapshot | null;
    busy: boolean;
    connecting: boolean;
    disconnecting: boolean;
    connected: boolean;
    live: boolean;
    refresh: () => Promise<boolean>;
    onInspectProbe: (probe: Probe) => Promise<void>;
}
export function DiagnosticsPage({
    query,
    setQuery,
    view,
    snapshot,
    busy,
    connecting,
    disconnecting,
    connected,
    live,
    refresh,
    onInspectProbe,
}: DiagnosticsProps) {
    const summary = useMemo(() => (snapshot ? summarize(snapshot) : null), [snapshot]);
    const isDemo = snapshot?.mode === 'demo';
    const filtered = useMemo(
        () =>
            searchDiagnostics(
                probes.filter((probe) => view === 'diagnostics' || probe.category === view),
                query,
            ),
        [view, query],
    );
    return (
        <>
            {!snapshot && (
                <div className="context-note">
                    <Cable size={18} />
                    <div>
                        <strong>No diagnostic evidence collected</strong>
                        <span>
                            {connected
                                ? live
                                    ? 'SSH is connected. Waiting for the first snapshot.'
                                    : 'SSH is connected and live updates are paused. Select a check or Collect snapshot to read fresh data using this connection.'
                                : 'Connect a target device to run these checks. Select any check to begin connecting, or import a saved report.'}
                        </span>
                    </div>
                </div>
            )}
            <div className="workbench-toolbar">
                <div>
                    <span className="section-count">{filtered.length} diagnostics</span>
                    <span className="subtle-badge">Read-only</span>
                </div>
                <label className="search-field">
                    <Search size={16} />
                    <input
                        placeholder="Search diagnostics…"
                        aria-label="Search diagnostics"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    {query && (
                        <button aria-label="Clear search" onClick={() => setQuery('')}>
                            <X size={14} />
                        </button>
                    )}
                </label>
                <button
                    className="button secondary"
                    onClick={() => void refresh()}
                    disabled={busy || connecting || disconnecting || !connected || live}
                    title={live ? 'Pause live updates to collect manually' : undefined}
                >
                    {busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
                    {busy ? 'Collecting…' : 'Collect snapshot'}
                </button>
            </div>
            {view === 'memory' && summary && (
                <div className="context-note">
                    <MemoryStick size={18} />
                    <div>
                        <strong>Available memory and free memory tell different stories.</strong>
                        <span>
                            MemFree:{' '}
                            {summary.memory.free === null
                                ? 'unavailable'
                                : formatKiB(summary.memory.free)}{' '}
                            · MemAvailable:{' '}
                            {summary.memory.available === null
                                ? 'unavailable'
                                : formatKiB(summary.memory.available)}
                            . Reserved DMA/ION memory may limit large allocations; verify on the
                            target before stress testing.
                        </span>
                    </div>
                </div>
            )}
            {view === 'services' && (
                <div className="context-note">
                    <Layers3 size={18} />
                    <div>
                        <strong>Service inventory depends on the target.</strong>
                        <span>
                            Uses systemd, OpenWrt procd/ubus, or init script names. Listing a
                            service does not establish its health.
                        </span>
                    </div>
                </div>
            )}
            {view === 'hardware' && (
                <div className="context-note">
                    <Cable size={18} />
                    <div>
                        <strong>Hardware discovery follows target capabilities.</strong>
                        <span>
                            These checks discover kernel-exposed hardware and readings. LED/button
                            behavior, bus signal integrity, power/current accuracy, DDR stress, and
                            video output need board-specific functional tests and fixtures.
                        </span>
                    </div>
                </div>
            )}
            <div className="probe-grid">
                {filtered.map(({ probe, kind, rank }) => {
                    const result = snapshot?.results.find((item) => item.id === probe.id);
                    return (
                        <button
                            className="probe-card"
                            key={probe.id}
                            data-match-rank={kind ? rank : undefined}
                            disabled={
                                !result &&
                                (busy || connecting || disconnecting || (connected && live))
                            }
                            onClick={() => void onInspectProbe(probe)}
                        >
                            <div className="probe-card-top">
                                <span className="category-icon">
                                    <RoundedIcon name={probe.id} size={29} />
                                </span>
                                <Badge status={result?.status} />
                            </div>
                            <h3>{probe.title}</h3>
                            {kind && <span className={`match-label match-${rank}`}>{kind}</span>}
                            <p>{probe.description}</p>
                            <div className="probe-card-bottom">
                                <span>
                                    {result ? `${result.durationMs} ms · ` : ''}
                                    {categoryLabels[probe.category]}
                                </span>
                                <span>
                                    {result ? 'Inspect' : connected ? 'Collect' : 'Connect'}{' '}
                                    <ArrowUpRight size={14} />
                                </span>
                            </div>
                        </button>
                    );
                })}
            </div>
            {!filtered.length && (
                <div className="empty-search">
                    <Search size={28} />
                    <h3>No diagnostics match “{query}”</h3>
                    <button className="button secondary" onClick={() => setQuery('')}>
                        Clear search
                    </button>
                </div>
            )}
            {view === 'logs' && snapshot && (
                <section className="panel full-logs">
                    <div className="panel-heading">
                        <h3>Collected log evidence</h3>
                        <span className="subtle-badge">
                            {isDemo ? 'Sample output' : 'Remote output'}
                        </span>
                    </div>
                    <pre>
                        {evidence(snapshot, 'logs') ||
                            snapshot.results.find((item) => item.id === 'logs')?.stderr ||
                            'No output'}
                    </pre>
                </section>
            )}
        </>
    );
}
