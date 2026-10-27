import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { BrushCleaning } from 'lucide-react';
import {
    CATALOG_WINDOW,
    catalogPage,
    captureCompletion,
    type CaptureFilter,
    type CaptureScope,
    type CatalogRow,
} from '../../../../shared/capture-query';
import { CaptureStorageError, type CaptureRepository } from '../../../../shared/capture-store';
import type { CaptureReportFormat } from '../../../../shared/capture-report';
import { openCaptureRepository } from './repository';
import { startBrowserCaptureExport } from './browser-export';

interface Props {
    transport?: 'ssh' | 'serial';
    visible: boolean;
    running: boolean;
    epoch: number;
    headingRef: Ref<HTMLHeadingElement>;
    headerOffset: number;
    onBusy(value: boolean): void;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export default function StoredSerialResults(props: Props) {
    const transport = props.transport ?? 'serial',
        label = transport === 'ssh' ? 'SSH' : 'Serial';
    const [store, setStore] = useState<CaptureRepository | null>(null),
        [failure, setFailure] = useState(''),
        [notice, setNotice] = useState(''),
        [rows, setRows] = useState<CatalogRow[]>([]),
        [loading, setLoading] = useState(false),
        [busy, setBusy] = useState(false),
        [cursor, setCursor] = useState(0),
        [back, setBack] = useState<number[]>([]),
        [next, setNext] = useState<number | null>(null),
        [query, setQuery] = useState(''),
        [search, setSearch] = useState(''),
        [completion, setCompletion] = useState(''),
        [name, setName] = useState(''),
        [selected, setSelected] = useState(new Set<string>()),
        [scope, setScope] = useState<'selected' | 'filtered' | 'all'>('filtered'),
        [format, setFormat] = useState<CaptureReportFormat>('json'),
        [revision, setRevision] = useState(0),
        [confirmClear, setConfirmClear] = useState(false);
    const job = useRef<Awaited<ReturnType<typeof startBrowserCaptureExport>> | null>(null);
    const filter = useMemo<CaptureFilter>(
        () => ({
            transport,
            ...(completion ? { completion } : {}),
            ...(name ? { name } : {}),
            ...(search ? { query: search } : {}),
        }),
        [transport, completion, name, search],
    );
    useEffect(() => {
        const timer = setTimeout(() => setSearch(query), 250);
        return () => clearTimeout(timer);
    }, [query]);
    useEffect(() => {
        if (!props.visible || store) return;
        let current = true;
        void openCaptureRepository()
            .then((value) => {
                if (current) {
                    setStore(value);
                    setFailure('');
                }
            })
            .catch((error) => {
                if (current) setFailure(message(error));
            });
        return () => {
            current = false;
        };
    }, [props.visible, store, revision]);
    useEffect(() => {
        setCursor(0);
        setBack([]);
    }, [filter]);
    useEffect(() => {
        if (!props.visible || !store) return;
        const controller = new AbortController();
        setLoading(true);
        void catalogPage(store, filter, cursor, controller.signal)
            .then((page) => {
                if (!controller.signal.aborted) {
                    setRows(page.records);
                    setNext(page.next);
                    setFailure('');
                }
            })
            .catch((error) => {
                if (!controller.signal.aborted) setFailure(message(error));
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [props.visible, store, filter, cursor, props.epoch, revision]);
    const action = (value: boolean) => {
        setBusy(value);
        props.onBusy(value);
    };
    const choose = (id: string, checked: boolean) =>
        setSelected((previous) => {
            if (checked && !previous.has(id) && previous.size >= CATALOG_WINDOW.selected) {
                setFailure(
                    'Select at most 1000 captures, or export all filtered/retained captures.',
                );
                return previous;
            }
            const value = new Set(previous);
            if (checked) value.add(id);
            else value.delete(id);
            return value;
        });
    const exportClicked = async () => {
        if (!store || props.running || busy) return;
        // Display search is debounced; an explicit export snapshots the current input.
        const exportFilter: CaptureFilter = {
            transport,
            ...(completion ? { completion } : {}),
            ...(name ? { name } : {}),
            ...(query ? { query } : {}),
        };
        const chosen: CaptureScope =
            scope === 'selected'
                ? { ids: [...selected], title: 'Selected ' + label + ' captures' }
                : {
                      filter: scope === 'all' ? { transport } : exportFilter,
                      title:
                          scope === 'all'
                              ? 'All stored ' + label + ' captures'
                              : 'Filtered ' + label + ' captures',
                  };
        action(true);
        setFailure('');
        setNotice('Preparing the complete stored export…');
        try {
            if (window.diagnosticHub) {
                const bridge = window.diagnosticHub.captureStorage;
                if (!bridge)
                    throw new CaptureStorageError(
                        'unsupported',
                        'Native capture export is unavailable.',
                    );
                const result = await bridge({ op: 'export', format, scope: chosen });
                if (!result.ok)
                    throw new CaptureStorageError(
                        result.error.code as CaptureStorageError['code'],
                        result.error.message,
                    );
                setNotice(result.value ? 'Export saved.' : 'Export cancelled.');
            } else {
                const download = await startBrowserCaptureExport(format, chosen);
                job.current = download;
                setNotice('Exporting complete stored captures…');
                await download.completed;
                setNotice(
                    'Complete export sent to the browser. Check Downloads for final save status.',
                );
            }
        } catch (error) {
            setFailure(message(error));
            setNotice('Export did not complete; stored captures are retained.');
        } finally {
            job.current = null;
            action(false);
        }
    };
    const clear = async (all: boolean) => {
        if (!store || props.running || busy) return;
        action(true);
        setFailure('');
        let deleted = 0;
        try {
            if (all) {
                const pin = await store.pin(),
                    through = pin.through;
                await pin.release();
                let after = 0;
                while (true) {
                    const page = await store.page(after, 100, through);
                    for (const capture of page.records)
                        if (capture.header.transport === transport) {
                            await store.delete(capture.id);
                            deleted++;
                        }
                    if (page.next === null) break;
                    after = page.next;
                }
                setSelected(new Set());
            } else {
                for (const id of [...selected]) {
                    await store.delete(id);
                    deleted++;
                }
                setSelected(new Set());
            }
            setNotice(
                'Deleted ' +
                    deleted +
                    ' stored ' +
                    label +
                    ' capture' +
                    (deleted === 1 ? '' : 's') +
                    '.',
            );
            setConfirmClear(false);
        } catch (error) {
            setFailure(
                'Deleted ' + deleted + ' captures before cleanup stopped: ' + message(error),
            );
        } finally {
            setCursor(0);
            setBack([]);
            setRevision((value) => value + 1);
            action(false);
        }
    };
    const disabled = busy || props.running || loading || !store;
    // Keep operation ownership in the mounted component while another transport is shown.
    if (!props.visible) return null;
    return (
        <div aria-label={'Stored ' + label + ' captures'}>
            <div className="automation-results-heading">
                <h2
                    id="automation-stored-results-title"
                    ref={props.headingRef}
                    tabIndex={-1}
                    style={{ scrollMarginTop: props.headerOffset }}
                >
                    Stored {label} results
                </h2>
                <span>
                    {rows.length} shown · at most {CATALOG_WINDOW.rows} rows / {Math.round(256)} KiB
                    per page · {selected.size} selected across pages
                </span>
                <button
                    className="button secondary"
                    disabled={loading || busy || (!store && !failure)}
                    onClick={() => setRevision((value) => value + 1)}
                >
                    Refresh stored results
                </button>
                <button
                    className="button danger"
                    disabled={disabled || (!rows.length && !search && !completion && !name)}
                    onClick={() => setConfirmClear(true)}
                >
                    <BrushCleaning size={16} aria-hidden="true" />
                    Clear retained results
                </button>
            </div>
            <p>
                Host receive time is not device emission time. Timestamps follow receive-observation
                order, including clock changes.
            </p>
            {store?.recoveryFailure && (
                <p role="alert" className="automation-warning">
                    Storage recovery: {store.recoveryFailure.message}
                </p>
            )}
            {failure && (
                <p role="alert" className="automation-warning">
                    {failure}
                </p>
            )}
            {notice && <p role="status">{notice}</p>}
            {confirmClear && (
                <div
                    className="automation-warning"
                    role="group"
                    aria-label="Confirm stored capture deletion"
                >
                    <p>
                        Permanently delete all stored {label} captures in this profile or browser
                        origin, including other pages and their raw output?
                    </p>
                    <button
                        className="button danger"
                        disabled={disabled}
                        onClick={() => void clear(true)}
                    >
                        Delete all stored {label} captures
                    </button>
                    <button className="button secondary" onClick={() => setConfirmClear(false)}>
                        Keep captures
                    </button>
                </div>
            )}
            <div className="automation-fields">
                <label>
                    Search all stored output and metadata
                    <input
                        aria-label="Search automation results"
                        value={query}
                        maxLength={256}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>
                <label>
                    Command completion
                    <select
                        aria-label="Result completion filter"
                        value={completion}
                        onChange={(event) => setCompletion(event.target.value)}
                    >
                        <option value="">All</option>
                        {[
                            'exit',
                            'signalled',
                            'uncertain-close',
                            'prompt-observed',
                            'timeout',
                            'cancelled',
                            'transport-error',
                            'storage-error',
                            'metadata-missing',
                        ].map((value) => (
                            <option key={value} value={value}>
                                {value}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Exact command label
                    <input
                        aria-label="Result command filter"
                        value={name}
                        maxLength={256}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Any label"
                    />
                </label>
            </div>
            <div className="automation-results" aria-busy={loading}>
                <table>
                    <thead>
                        <tr>
                            <th>Select</th>
                            <th>Command</th>
                            <th>Capture / completion</th>
                            <th>Host receive timestamps (UTC)</th>
                            <th>Received output preview</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => {
                            const c = row.capture,
                                o = row.outcome;
                            return (
                                <tr key={c.id} data-capture-id={c.id}>
                                    <td>
                                        <input
                                            type="checkbox"
                                            aria-label={
                                                'Select result ' + c.header.name + ' ' + c.id
                                            }
                                            checked={selected.has(c.id)}
                                            disabled={busy || loading || c.state === 'active'}
                                            onChange={(event) => choose(c.id, event.target.checked)}
                                        />
                                    </td>
                                    <td>
                                        <strong>{c.header.name}</strong>
                                        <details>
                                            <summary>Command and prepared request</summary>
                                            <pre>{c.header.command || 'Enter'}</pre>
                                            <p>
                                                Prepared request bytes (base64):{' '}
                                                {c.header.requestBase64 ?? 'not recorded'}
                                            </p>
                                            <p>
                                                {c.header.target?.endpoint} ·{' '}
                                                {c.header.target?.serialSettings}
                                            </p>
                                            <p>Capture ID: {c.id}</p>
                                        </details>
                                    </td>
                                    <td>
                                        <p>
                                            Raw capture: <strong>{c.state}</strong> ·{' '}
                                            {c.committedBytes} committed bytes
                                            {o?.truncated ? ' · capture incomplete' : ''}
                                        </p>
                                        <p>
                                            Command: {captureCompletion(o)} · exit:{' '}
                                            {o?.exitCode ?? 'unavailable'}
                                        </p>
                                        {o && (
                                            <p>
                                                Host completed: {o.completedAt} · host capture
                                                elapsed: {Math.round(o.durationMs)} ms
                                            </p>
                                        )}
                                        {c.failure && (
                                            <p className="automation-warning">
                                                {c.failure.code}: {c.failure.message} · observed
                                                bytes: {c.observedBytes ?? 'unknown'}
                                            </p>
                                        )}
                                        {o?.deviceTime && (
                                            <p>
                                                Device time observed: {o.deviceTime.value} ·{' '}
                                                {o.deviceTime.source} · received at{' '}
                                                {o.deviceTime.observedAt}
                                            </p>
                                        )}
                                    </td>
                                    <td>
                                        <p>First: {c.firstReceivedAt ?? 'none retained'}</p>
                                        <p>Last: {c.lastReceivedAt ?? 'none retained'}</p>
                                        <p>Receive source: {c.header.receiveTimeSource}</p>
                                    </td>
                                    <td>
                                        <pre>
                                            {row.stdout}
                                            {row.stderr ? '\n[stderr]\n' + row.stderr : ''}
                                        </pre>
                                        {row.previewClipped && (
                                            <p>
                                                First 8 KiB of raw bytes shown as plain text.
                                                Complete retained output is available in exports.
                                            </p>
                                        )}
                                        {c.state === 'active' && (
                                            <p>
                                                Capture in progress; preview is available after
                                                completion.
                                            </p>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                {!rows.length && !loading && <p>No retained matching results.</p>}
            </div>
            <div className="automation-actions">
                <button
                    className="button secondary"
                    disabled={loading || !cursor}
                    onClick={() => {
                        setCursor(0);
                        setBack([]);
                    }}
                >
                    First page
                </button>
                <button
                    className="button secondary"
                    disabled={loading || !back.length}
                    onClick={() => {
                        setCursor(back.at(-1)!);
                        setBack((values) => values.slice(0, -1));
                    }}
                >
                    Previous page
                </button>
                <button
                    className="button secondary"
                    disabled={loading || next === null}
                    onClick={() => {
                        setBack((values) => [...values, cursor].slice(-32));
                        setCursor(next!);
                    }}
                >
                    Next page
                </button>
                <button
                    className="button secondary"
                    disabled={!selected.size || busy}
                    onClick={() => setSelected(new Set())}
                >
                    Clear selection
                </button>
                <button
                    className="button danger"
                    disabled={disabled || !selected.size}
                    onClick={() => void clear(false)}
                >
                    Delete selected captures
                </button>
            </div>
            <div className="automation-fields">
                <label>
                    Export scope
                    <select
                        aria-label="Export scope"
                        value={scope}
                        onChange={(event) => setScope(event.target.value as typeof scope)}
                    >
                        <option value="filtered">All filtered stored captures</option>
                        <option value="selected">
                            Selected ({selected.size}, including other pages)
                        </option>
                        <option value="all">All stored {label} captures</option>
                    </select>
                </label>
                <label>
                    Export format
                    <select
                        aria-label="Export format"
                        value={format}
                        onChange={(event) => setFormat(event.target.value as CaptureReportFormat)}
                    >
                        <option value="json">JSON · exact raw bytes and execution evidence</option>
                        <option value="csv">CSV</option>
                        <option value="markdown">Markdown</option>
                        <option value="text">Text</option>
                    </select>
                </label>
                <button
                    className="button"
                    disabled={disabled || (scope === 'selected' && !selected.size)}
                    onClick={() => void exportClicked()}
                >
                    Download QA results
                </button>
                {busy && job.current && (
                    <button className="button danger" onClick={() => void job.current?.cancel()}>
                        Cancel export
                    </button>
                )}
            </div>
            <p>
                Captured output is retained until explicitly deleted. The display window is bounded;
                exports read complete stored captures independently of this page. Review exports for
                secrets.
            </p>
        </div>
    );
}
