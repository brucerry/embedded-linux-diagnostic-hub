import { useEffect, useMemo, useState } from 'react';
import type { Snapshot } from '../../../shared/types';
import { wirelessSummary } from '../../../shared/diagnostics/network/wireless';
import { lanSummary } from '../../../shared/diagnostics/network/lan';
import { evidenceReason } from '../../../shared/diagnostics/network/evidence';
import type { DetailGroup } from '../../../shared/diagnostics/network/model';
import { CopyButton } from '../../components/CopyButton';
interface Props {
    id: 'wireless' | 'ethernet';
    snapshot: Snapshot;
    mode: string;
    onCopy: (text: string) => Promise<void>;
    refreshCapabilities?: () => Promise<unknown>;
}
function Details({ value }: { value: DetailGroup }) {
    return (
        <details className="network-detail">
            <summary>{value.title}</summary>
            {value.source && <p className="network-source-time">{value.source}</p>}
            {value.note && <p>{value.note}</p>}
            {value.fields.length ? (
                <dl>
                    {value.fields.map((field, index) => (
                        <div key={index}>
                            <dt>{field.label}</dt>
                            <dd>{field.value}</dd>
                        </div>
                    ))}
                </dl>
            ) : (
                <p>Not reported in recognized output. Inspect raw evidence.</p>
            )}
        </details>
    );
}
export function NetworkSummary({ id, snapshot, mode, onCopy, refreshCapabilities }: Props) {
    const model = useMemo(
        () => (id === 'wireless' ? wirelessSummary(snapshot) : lanSummary(snapshot)),
        [id, snapshot],
    );
    const [selected, setSelected] = useState('');
    const [refreshing, setRefreshing] = useState(false);
    useEffect(() => {
        if (!model.interfaces.some((i) => i.id === selected))
            setSelected(model.interfaces[0]?.id ?? '');
    }, [model, selected]);
    const iface = model.interfaces.find((i) => i.id === selected) ?? model.interfaces[0];
    const primary = snapshot.results.find((r) => r.id === id);
    const all = snapshot.results.filter((r) =>
        id === 'wireless'
            ? ['wireless', 'ethernet', 'interfaces'].includes(r.id)
            : ['ethernet', 'interfaces', 'routes'].includes(r.id),
    );
    const failures = all.flatMap((r) => [
        ...(r.status !== 'collected'
            ? [{ key: r.id, label: r.id, reason: evidenceReason(r) }]
            : []),
        ...(r.networkEvidence?.sections
            .filter((s) => s.status !== 'collected' || s.truncated)
            .map((s) => ({
                key: s.id,
                label: s.operation + ' · ' + s.scope,
                reason: evidenceReason(s),
            })) ?? []),
        ...(r.networkEvidence?.omissions.map((o, index) => ({
            key: r.id + '-omission-' + index,
            label: o.operation + ' · ' + o.scope,
            reason: o.reason,
        })) ?? []),
    ]);
    const metric = (label: string, value: string | number | undefined) => (
        <div className="network-metric" key={label}>
            <span>{label}</span>
            <strong>{value === undefined || value === '' ? 'Not reported' : String(value)}</strong>
        </div>
    );
    const physical = iface?.groups.find((g) => g.id === 'physical');
    const physicalField = (name: string) => physical?.fields.find((f) => f.label === name)?.value;
    return (
        <section
            className="network-summary"
            aria-label={id === 'wireless' ? 'Wi-Fi summary' : 'LAN summary'}
        >
            <div className="network-summary-heading">
                <div>
                    <h3>
                        {id === 'wireless'
                            ? 'Current wireless observations'
                            : 'Link and network observations'}
                    </h3>
                    <p>
                        {mode === 'imported' ? 'Historical imported evidence' : 'Snapshot evidence'}{' '}
                        · {new Date(snapshot.capturedAt).toLocaleString()}
                    </p>
                </div>
                {id === 'wireless' && refreshCapabilities && (
                    <button
                        className="button secondary"
                        disabled={refreshing}
                        onClick={() => {
                            setRefreshing(true);
                            void refreshCapabilities().finally(() => setRefreshing(false));
                        }}
                    >
                        {refreshing ? 'Refreshing…' : 'Refresh capabilities'}
                    </button>
                )}
            </div>
            {model.interfaces.length > 0 ? (
                <>
                    <label className="network-interface-select">
                        Interface
                        <select
                            aria-label="Network interface"
                            value={iface?.id}
                            onChange={(e) => setSelected(e.target.value)}
                        >
                            {model.interfaces.map((i) => (
                                <option key={i.id} value={i.id}>
                                    {i.name}
                                    {i.phy ? ' · ' + i.phy : ''}
                                    {i.kind !== 'Unclassified' ? ' · ' + i.kind : ''}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="network-metrics">
                        {metric('Administrative state', iface?.admin)}
                        {metric('Carrier / lower layer', iface?.carrier)}
                        {metric('Operating state', iface?.state)}
                        {id === 'wireless' ? (
                            <>
                                {metric('Mode', iface?.mode)}
                                {metric('Association', iface?.association)}
                                {metric('SSID', iface?.ssid)}
                                {metric(
                                    'Channel / frequency',
                                    iface?.channel
                                        ? iface.channel +
                                              (iface.frequency !== undefined
                                                  ? ' / ' + iface.frequency + ' MHz'
                                                  : ' / frequency not reported')
                                        : iface?.frequency !== undefined
                                          ? iface.frequency + ' MHz'
                                          : undefined,
                                )}
                                {metric('Channel width', iface?.width)}
                                {metric('Signal', iface?.signal)}
                                {metric('Current-channel noise', iface?.noise)}
                                {metric('Current transmit power', iface?.txPower)}
                                {metric('Peers', iface?.peers)}
                            </>
                        ) : (
                            <>
                                {metric('Kind', iface?.kind)}
                                {metric('MTU', iface?.mtu)}
                                {metric('Speed', physicalField('Speed'))}
                                {metric('Duplex', physicalField('Duplex'))}
                                {metric('Autonegotiation', physicalField('Auto-negotiation'))}
                            </>
                        )}
                    </div>
                    <p className="network-context">
                        {iface?.name}
                        {iface?.mac ? ' · ' + iface.mac : ''}
                        {iface?.bssid ? ' · BSSID ' + iface.bssid : ''}. Administrative, carrier and
                        operating state are independent observations. UNKNOWN is not a failure.
                    </p>
                    {iface?.groups.map((g) => (
                        <Details key={g.id} value={g} />
                    ))}
                </>
            ) : (
                <p className="context-note">
                    No recognized interface inventory was collected. This does not establish that
                    the hardware is absent.
                </p>
            )}
            {id === 'wireless' && (
                <p className="network-context">
                    Signal, noise and current transmit power are separate reported values. Peer
                    bitrates are PHY rates, not measured throughput. Capability channels can be
                    disabled or restricted.
                </p>
            )}
            {id === 'ethernet' && (
                <p className="network-context">
                    Counters are cumulative. A route or neighbor entry does not prove reachability;
                    STALE is a neighbor-cache state. Optional physical fields need driver support.
                </p>
            )}
            {model.groups.map((g) => (
                <Details key={g.id} value={g} />
            ))}
            {model.warnings.map((warning, index) => (
                <p className="context-note" role="status" key={index}>
                    {warning}
                </p>
            ))}
            {failures.length > 0 && (
                <details className="network-detail">
                    <summary>Unavailable or limited observations ({failures.length})</summary>
                    <ul>
                        {failures.map((f) => (
                            <li key={f.key}>
                                <strong>{f.label}</strong>: {f.reason}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
            {!primary?.networkEvidence && (
                <p className="context-note">
                    Additional network commands were not collected in this report. Available legacy
                    fields remain readable.
                </p>
            )}
            <details className="network-detail">
                <summary>Command evidence and collection limits</summary>
                <p>
                    These are bounded read-only observations taken in sequence, not one atomic
                    measurement. Cached capabilities keep their original capture time. No scan or
                    setting change is performed.
                </p>
                {all.map((r) => (
                    <div className="network-primary-source" key={r.id}>
                        <h4>
                            {r.id} · primary · {evidenceReason(r)}
                        </h4>
                        <p>
                            {r.collectedAt} · {r.durationMs} ms · exit {r.exitCode ?? 'unknown'}
                        </p>
                        <pre>{r.command || 'Legacy command not recorded'}</pre>
                        {(r.networkEvidence?.sections ?? []).map((s) => (
                            <details className="network-command" key={s.id}>
                                <summary>
                                    {s.operation} · {s.scope} ·{' '}
                                    {s.source === 'cached' ? 'Cached' : evidenceReason(s)}
                                </summary>
                                <p>
                                    {s.collectedAt} · {s.durationMs} ms · exit{' '}
                                    {s.exitCode ?? 'unknown'}
                                    {s.truncated ? ' · truncated' : ''}
                                </p>
                                <div className="snippet">
                                    <pre>{s.command}</pre>
                                    <CopyButton
                                        text={s.command ?? ''}
                                        label={'Copy ' + s.operation + ' command'}
                                        onCopy={onCopy}
                                    />
                                </div>
                                <h5>Standard output</h5>
                                <pre tabIndex={0}>{s.stdout || 'No output'}</pre>
                                <h5>Standard error</h5>
                                <pre tabIndex={0}>{s.stderr || 'No standard error'}</pre>
                            </details>
                        ))}
                    </div>
                ))}
            </details>
        </section>
    );
}
