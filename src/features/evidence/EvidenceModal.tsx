import { CircleAlert, ShieldCheck, Terminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EvidencePresentation } from '../../../shared/diagnostics/evidence';
import {
    evidencePresentation,
    graphReadings,
    HISTORY_LIMIT,
    type HistoryFrame,
} from '../../../shared/diagnostics/presentation';
import { processTable } from '../../../shared/diagnostics/processes';
import type { Probe, ProbeResult, Snapshot } from '../../../shared/types';
import { CopyButton } from '../../components/CopyButton';
import { EvidenceTree } from './EvidenceTree';
import { LiveGraph } from './LiveGraph';

import { Badge } from '../../components/Badge';
import { Modal } from '../../components/Modal';
interface EvidenceModalProps {
    probe: Probe;
    result: ProbeResult;
    snapshot: Snapshot;
    mode: string;
    history: HistoryFrame[];
    onCopy: (command: string) => Promise<void>;
    onClose: () => void;
}

export function EvidenceModal({
    probe,
    result,
    snapshot,
    mode,
    history,
    onCopy,
    onClose,
}: EvidenceModalProps) {
    const latestFrame = history.at(-1);
    const precedingFrame = history.at(-2);
    const previousProcess =
        latestFrame?.connection === precedingFrame?.connection &&
        latestFrame?.source === precedingFrame?.source
            ? precedingFrame?.processes
            : undefined;
    const presentation = useMemo<EvidencePresentation>(() => {
        const resources =
            probe.id === 'processes' ? processTable(result, previousProcess) : undefined;
        return resources
            ? {
                  table: resources,
                  note: 'CPU is the sampled share of total system CPU time and needs two snapshots of the same process. Memory is kernel-reported resident/virtual/swap usage; shared pages can appear in multiple processes. Only readable processes are listed.',
              }
            : evidencePresentation(probe.id, result);
    }, [probe.id, result.stdout, result.status, previousProcess]);
    const preferred = 'stdout';
    const [tab, setTab] = useState<'stdout' | 'stderr' | 'table' | 'tree' | 'graph'>('stdout');
    const graph = useMemo(() => {
        const latestFrame = history.at(-1);
        const current =
            latestFrame?.capturedAt === snapshot.capturedAt
                ? (latestFrame.readings[probe.id] ?? [])
                : graphReadings(probe.id, result, snapshot, previousProcess);
        // Imported reports and manually collected snapshots can plot a single real sample.
        const frames =
            current.length && latestFrame?.capturedAt !== snapshot.capturedAt
                ? [
                      ...history,
                      {
                          capturedAt: snapshot.capturedAt,
                          readings: { [probe.id]: current },
                          source: snapshot.endpoint,
                      },
                  ].slice(-HISTORY_LIMIT)
                : history;
        let readings = current;
        for (let index = frames.length - 1; !readings.length && index >= 0; index--) {
            readings = frames[index].readings[probe.id] ?? [];
        }
        return { history: frames, readings, retainedOnly: current.length === 0 };
    }, [history, probe.id, result, snapshot, previousProcess]);
    const graphAvailable = graph.readings.length > 0;
    const table = presentation.table;
    const command = result.command || probe.command;
    useEffect(() => {
        if (
            (tab === 'graph' && !graphAvailable) ||
            (tab === 'tree' && !presentation.tree) ||
            (tab === 'table' && !table)
        )
            setTab(preferred);
    }, [graphAvailable, presentation.tree, table, preferred, tab]);
    const tabs = [
        ['stdout', 'Standard output'],
        ['stderr', 'Standard error'],
        ...(table ? [['table', 'Table view']] : []),
        ...(presentation.tree ? [['tree', 'Tree view']] : []),
        ...(graphAvailable ? [['graph', 'Graph view']] : []),
    ] as const;
    return (
        <Modal title={probe.title} onClose={onClose} wide>
            <div className="evidence-meta">
                <Badge status={result.status} />
                <span>
                    {mode === 'imported'
                        ? 'Imported evidence'
                        : mode === 'demo'
                          ? 'Sample evidence'
                          : 'Remote evidence'}
                </span>
                <span>{result.durationMs} ms</span>
                <span>Exit {result.exitCode ?? 'unknown'}</span>
            </div>
            <p className="evidence-description">{probe.description}</p>
            {probe.id === 'ethernet' &&
                result.status === 'collected' &&
                /^Warning:/m.test(result.stderr) && (
                    <div className="context-note ethernet-warning" role="status">
                        <CircleAlert size={18} />
                        <span>
                            Some interface attributes could not be read. Valid readings remain
                            available in the views below; inspect Standard error for the affected
                            paths. A down interface is not automatically a hardware fault.
                        </span>
                    </div>
                )}
            {result.status === 'unavailable' && (
                <div className="context-note">
                    <CircleAlert size={18} />
                    <span>
                        This check has no collected evidence. The firmware may lack the required
                        driver, exposed data, or utility; this does not establish that the board
                        lacks the hardware.
                    </span>
                </div>
            )}
            <div className="command-tools">
                <details className="collection-command">
                    <summary>
                        <Terminal size={14} />
                        Collection command
                    </summary>
                    <div className="snippet command-snippet">
                        <pre className="command-code">{command}</pre>
                        <CopyButton text={command} label="Copy command" onCopy={onCopy} />
                    </div>
                </details>
            </div>
            <div className="evidence-tabs" role="tablist" aria-label="Evidence views">
                {tabs.map(([name, label]) => (
                    <button
                        key={name}
                        id={`evidence-tab-${name}`}
                        role="tab"
                        aria-selected={tab === name}
                        aria-controls="evidence-panel"
                        tabIndex={tab === name ? 0 : -1}
                        className={tab === name ? 'selected' : ''}
                        onKeyDown={(event) => {
                            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
                                return;
                            event.preventDefault();
                            const index = tabs.findIndex(([value]) => value === tab);
                            const next =
                                event.key === 'Home'
                                    ? 0
                                    : event.key === 'End'
                                      ? tabs.length - 1
                                      : (index +
                                            (event.key === 'ArrowRight' ? 1 : -1) +
                                            tabs.length) %
                                        tabs.length;
                            setTab(tabs[next][0] as typeof tab);
                            document.getElementById(`evidence-tab-${tabs[next][0]}`)?.focus();
                        }}
                        onClick={() => setTab(name as typeof tab)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div
                key={tab}
                id="evidence-panel"
                role="tabpanel"
                aria-labelledby={`evidence-tab-${tab}`}
            >
                {tab === 'tree' && presentation.tree ? (
                    <EvidenceTree nodes={presentation.tree} />
                ) : tab === 'table' && table ? (
                    <div className="evidence-table-wrap">
                        {table.rows.length ? (
                            <table
                                className={`evidence-table${probe.id === 'logs' ? ' log-table' : probe.id === 'processes' ? ' process-table' : ''}`}
                            >
                                <thead>
                                    <tr>
                                        {table.columns.map((column) => (
                                            <th key={column} scope="col">
                                                {column}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {table.rows.slice(0, 2000).map((row, i) => (
                                        <tr key={i}>
                                            {row.map((value, j) => (
                                                <td key={j}>{value}</td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <p className="graph-note">
                                No collected standard output to display as a table.
                            </p>
                        )}
                        {table.rows.length > 2000 && (
                            <p className="graph-note">
                                First 2,000 rows shown. Full output is available in Standard output
                                and the exported report.
                            </p>
                        )}
                    </div>
                ) : tab === 'graph' && graphAvailable ? (
                    <>
                        {graph.retainedOnly && (
                            <p className="graph-note">
                                This snapshot has no numeric readings. Showing retained samples.
                            </p>
                        )}
                        <LiveGraph
                            id={probe.id}
                            history={graph.history}
                            readings={graph.readings}
                        />
                    </>
                ) : (
                    <div className="snippet output-snippet">
                        <pre className="evidence-output" tabIndex={0}>
                            {result[tab === 'stderr' ? 'stderr' : 'stdout'] ||
                                `No ${tab === 'stderr' ? 'standard error' : 'standard output'} captured.`}
                        </pre>
                        <CopyButton
                            text={result[tab === 'stderr' ? 'stderr' : 'stdout']}
                            label={`Copy ${tab === 'stderr' ? 'standard error' : 'standard output'}`}
                            onCopy={onCopy}
                        />
                    </div>
                )}
            </div>
            {presentation.note && <p className="presentation-note">{presentation.note}</p>}
            <p className="evidence-timestamp">
                Collected {new Date(result.collectedAt).toLocaleString()}
            </p>
            {result.truncated && (
                <div className="context-note">
                    Output was truncated at 256 KiB. The report records this limit.
                </div>
            )}
            <div className="evidence-footer">
                <ShieldCheck size={14} />
                Read-only evidence · command completion does not establish hardware health.
            </div>
        </Modal>
    );
}
