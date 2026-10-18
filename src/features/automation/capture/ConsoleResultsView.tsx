import { useMemo } from 'react';
import { PlainCaptureText } from '../../../../shared/capture-query';
import { base64Bytes } from '../../../../shared/capture-store';
import type { ConsolePreview, ConsoleResultsViewProps } from './console-results-view';
import './console-results.css';

function previewGroups(preview: ConsolePreview) {
    const groups = new Map<
        number,
        {
            title: string;
            context: boolean;
            command: string;
            criterion: string;
            evidence: string;
            text: string;
            first: string;
            last: string;
            observations: Set<number>;
            origins: Set<string>;
        }
    >();
    const decoder = new TextDecoder(),
        plain = new PlainCaptureText();
    let remaining = 8192,
        textClipped = false;
    for (const record of preview.records) {
        if (record.kind === 'segment-start' || record.kind === 'preparation') {
            const segment = record.segment;
            const old = groups.get(record.index);
            groups.set(record.index, {
                title:
                    segment.kind === 'context'
                        ? segment.phase + ' context'
                        : (record.kind === 'preparation'
                              ? 'Prepared input: '
                              : 'Command ' + segment.ordinal + ': ') + segment.name,
                context: segment.kind === 'context',
                command: segment.kind === 'command' ? segment.input.command : '',
                criterion:
                    segment.kind === 'command'
                        ? (segment.input.intent === 'send-enter'
                              ? 'Send Enter — exact CR (0D)'
                              : 'Script + CR') +
                          ' · ' +
                          segment.criterion.role +
                          ' · ' +
                          JSON.stringify(segment.criterion.literals)
                        : '',
                evidence:
                    record.kind === 'segment-start' && record.inputSent
                        ? 'Input write dispatched.'
                        : record.kind === 'preparation'
                          ? 'Preparation alone does not establish dispatch. Missing input-sent evidence in an incomplete capture is uncertain; never replay automatically.'
                          : '',
                text: old?.text ?? '',
                first: old?.first ?? '',
                last: old?.last ?? '',
                observations: old?.observations ?? new Set(),
                origins: old?.origins ?? new Set(),
            });
        }
        const group = groups.get(record.index);
        if (!group) continue;
        if (record.kind === 'observation') {
            const projection = plain.append(
                decoder.decode(base64Bytes(record.base64), { stream: true }),
            );
            const taken = Math.min(remaining, projection.length);
            group.text += projection.slice(0, taken);
            remaining -= taken;
            if (projection.length > taken) textClipped = true;
            group.first ||= record.receivedAt;
            group.last = record.receivedAt;
            group.observations.add(record.observation);
            group.origins.add(record.origin);
        } else if (record.kind === 'outcome')
            group.evidence +=
                (group.evidence ? ' ' : '') +
                'Completion: ' +
                record.completion +
                ' · process exit status unavailable' +
                (record.match ? ' · matched ' + JSON.stringify(record.match) : '');
        else if (record.kind === 'segment-end')
            group.evidence +=
                (group.evidence ? ' ' : '') +
                'Segment ended: ' +
                record.reason +
                (record.match ? ' · ' + JSON.stringify(record.match) : '');
        else if (record.kind === 'preparation-end')
            group.evidence += ' Preparation ended: ' + record.reason + '.';
    }
    if (!preview.clipped) {
        const tail = plain.append(decoder.decode()),
            last = [...groups.values()].at(-1);
        if (last) last.text += tail.slice(0, remaining);
        if (tail.length > remaining) textClipped = true;
    }
    return { groups: [...groups], textClipped };
}
const utc = (value: string) => value.replace('T', ' ').replace('Z', ' UTC');
const bytes = (value: number) => value.toLocaleString() + ' bytes';
export default function ConsoleResultsView(props: ConsoleResultsViewProps) {
    const preview = useMemo(
        () => (props.preview ? previewGroups(props.preview) : null),
        [props.preview],
    );
    const disabled = props.operation !== null || props.running || props.status !== 'ready';
    return (
        <div className="console-results">
            <p>
                One retained capture covers an owned SSH console flow, including startup, idle and
                shutdown context. Prompt observation has no process exit status.
            </p>
            <div className="console-results-toolbar">
                <button
                    className="button secondary"
                    onClick={props.onRefresh}
                    disabled={props.operation !== null}
                >
                    Refresh captures
                </button>
                <span role="status">
                    {props.status === 'loading'
                        ? 'Reading retained captures…'
                        : props.status === 'ready'
                          ? props.rows.length + ' flows on this page'
                          : 'Storage unavailable'}
                </span>
            </div>
            {props.message && (
                <p className="console-results-error" role="alert">
                    {props.message}
                </p>
            )}
            {props.notice && <p role="status">{props.notice}</p>}
            <div className="console-results-filters">
                <label>
                    Search all retained output
                    <input
                        aria-label="Search all stored console output"
                        maxLength={256}
                        value={props.filter.query ?? ''}
                        disabled={props.operation !== null}
                        onChange={(event) =>
                            props.onFilter({ ...props.filter, query: event.target.value })
                        }
                    />
                </label>
                <label>
                    Command or step name
                    <input
                        aria-label="Filter console commands"
                        maxLength={256}
                        value={props.filter.name ?? ''}
                        disabled={props.operation !== null}
                        onChange={(event) =>
                            props.onFilter({ ...props.filter, name: event.target.value })
                        }
                    />
                </label>
                <label>
                    Capture or completion state
                    <select
                        aria-label="Filter console completion"
                        value={props.filter.completion ?? ''}
                        disabled={props.operation !== null}
                        onChange={(event) =>
                            props.onFilter({
                                ...props.filter,
                                ...(event.target.value
                                    ? { completion: event.target.value }
                                    : { completion: undefined }),
                            })
                        }
                    >
                        <option value="">All states</option>
                        <option value="complete">Capture complete</option>
                        <option value="incomplete">Capture incomplete</option>
                        <option value="active">Active capture</option>
                        <option value="prompt-observed">Prompt observed</option>
                        <option value="cancelled">Cancelled</option>
                        <option value="timeout">Timeout</option>
                        <option value="transport-error">Transport error</option>
                        <option value="storage-error">Storage error</option>
                    </select>
                </label>
            </div>
            <div
                className="console-results-catalog"
                aria-label="Retained console flows"
                aria-busy={props.status === 'loading'}
            >
                {props.rows.map((capture) => (
                    <article className="console-result-card" key={capture.header.id}>
                        <div className="console-result-identity">
                            <label>
                                <input
                                    type="checkbox"
                                    aria-label={'Select console flow ' + capture.header.id}
                                    checked={props.selectedIds.has(capture.header.id)}
                                    disabled={props.operation !== null}
                                    onChange={(event) =>
                                        props.onSelect(capture.header.id, event.target.checked)
                                    }
                                />{' '}
                                Select flow
                            </label>
                            <code title={capture.header.id}>{capture.header.id.slice(0, 8)}</code>
                        </div>
                        <div className="console-result-summary">
                            <p>
                                <strong>{capture.header.target.endpoint}</strong>
                                {capture.header.target.username
                                    ? ' · ' + capture.header.target.username
                                    : ''}
                            </p>
                            <p>
                                <time dateTime={capture.header.startedAt}>
                                    {utc(capture.header.startedAt)}
                                </time>
                            </p>
                            <p className={'console-capture-state state-' + capture.state}>
                                {capture.state === 'complete'
                                    ? 'Capture complete'
                                    : capture.state === 'active'
                                      ? 'Active capture'
                                      : 'Capture incomplete'}
                                {capture.reason && capture.reason !== 'complete'
                                    ? ' · ' + capture.reason
                                    : ''}
                            </p>
                            <dl>
                                <div>
                                    <dt>Retained</dt>
                                    <dd>{bytes(capture.bytes)}</dd>
                                </div>
                                <div>
                                    <dt>Observed</dt>
                                    <dd>
                                        {capture.observedBytes === null
                                            ? 'Unknown'
                                            : bytes(capture.observedBytes)}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Shell closed</dt>
                                    <dd>
                                        {capture.shellClosed ? 'Acknowledged' : 'Unacknowledged'}
                                    </dd>
                                </div>
                            </dl>
                            {capture.failure && (
                                <p className="console-results-error">
                                    {capture.failure.code}: {capture.failure.message}
                                </p>
                            )}
                        </div>
                        <button
                            className="button secondary"
                            disabled={props.operation !== null || props.previewLoading}
                            onClick={() => props.onPreview(capture.header.id)}
                        >
                            Preview flow
                        </button>
                    </article>
                ))}
                {!props.rows.length && props.status === 'ready' && (
                    <p>No retained console flows match these filters.</p>
                )}
            </div>
            <div className="console-results-toolbar" aria-label="Console result pages">
                <button
                    className="button secondary"
                    disabled={
                        !props.canPrevious || props.status === 'loading' || props.operation !== null
                    }
                    onClick={props.onPrevious}
                >
                    Previous page
                </button>
                <span>
                    Page {props.page} · {props.selectedIds.size} selected across pages
                </span>
                <button
                    className="button secondary"
                    disabled={
                        !props.canNext || props.status === 'loading' || props.operation !== null
                    }
                    onClick={props.onNext}
                >
                    Next page
                </button>
            </div>
            {props.previewLoading && <p role="status">Reading bounded console preview…</p>}
            {props.preview && preview && (
                <section className="console-preview" aria-label="Console flow preview">
                    <div className="console-results-toolbar">
                        <h4>Console preview · {props.preview.capture.header.id.slice(0, 8)}</h4>
                        <button className="button secondary" onClick={props.onClosePreview}>
                            Close preview
                        </button>
                    </div>
                    <p>
                        Combined PTY output · {bytes(props.preview.shownBytes)} represented in this
                        prefix · receive observer: {props.preview.capture.header.receiveTimeSource}
                    </p>
                    {(props.preview.clipped || preview.textClipped) && (
                        <p className="console-preview-clipped">
                            Preview clipped. Exports read and verify the complete retained journal.
                        </p>
                    )}
                    {preview.groups.map(([index, group]) => (
                        <section
                            className={group.context ? 'console-context' : 'console-command'}
                            key={index}
                        >
                            <h5>{group.title}</h5>
                            {group.criterion && <p>{group.criterion}</p>}
                            {group.command && (
                                <details>
                                    <summary>Exact script text</summary>
                                    <pre tabIndex={0}>{group.command}</pre>
                                </details>
                            )}
                            {group.evidence && <p>{group.evidence}</p>}
                            {group.first && (
                                <p className="console-receive-provenance">
                                    Host receive observations: {group.observations.size} ·{' '}
                                    {group.origins.size ? [...group.origins].join(', ') : 'none'}
                                    <br />
                                    First: {utc(group.first)} · Last: {utc(group.last)}
                                </p>
                            )}
                            {group.text && (
                                <pre aria-label={group.title + ' readable PTY output'} tabIndex={0}>
                                    {group.text}
                                </pre>
                            )}
                        </section>
                    ))}
                    <p>
                        Readable text strips terminal controls and does not execute links or
                        clipboard commands. JSON/base64 exports retain exact bytes and every
                        recorded receive boundary. Device emission time is unavailable.
                    </p>
                </section>
            )}
            <div className="console-results-export">
                <label>
                    Console export scope
                    <select
                        aria-label="Console export scope"
                        disabled={props.operation !== null}
                        value={props.exportSelection}
                        onChange={(event) =>
                            props.onExportSelection(
                                event.target.value as ConsoleResultsViewProps['exportSelection'],
                            )
                        }
                    >
                        <option value="filtered">All filtered flows</option>
                        <option value="selected">Selected flows</option>
                        <option value="all">All retained flows</option>
                    </select>
                </label>
                <label>
                    Console export format
                    <select
                        aria-label="Console export format"
                        disabled={props.operation !== null}
                        value={props.exportFormat}
                        onChange={(event) =>
                            props.onFormat(
                                event.target.value as ConsoleResultsViewProps['exportFormat'],
                            )
                        }
                    >
                        <option value="json">JSON · exact evidence</option>
                        <option value="csv">CSV</option>
                        <option value="markdown">Markdown</option>
                        <option value="text">Text</option>
                    </select>
                </label>
                <button
                    className="button primary"
                    disabled={
                        disabled ||
                        (props.exportSelection === 'selected' && !props.selectedIds.size)
                    }
                    onClick={props.onExport}
                >
                    Export console evidence
                </button>
                {props.operation === 'export' && (
                    <button className="button secondary" onClick={props.onCancelExport}>
                        Cancel export
                    </button>
                )}
            </div>
            {props.exportStatus && <p role="status">{props.exportStatus}</p>}
            <div className="console-results-toolbar">
                <button
                    className="button danger"
                    disabled={disabled || !props.selectedIds.size}
                    onClick={props.onClearSelected}
                >
                    Clear selected console flows
                </button>
                <button className="button danger" disabled={disabled} onClick={props.onClearAll}>
                    Clear all retained console flows
                </button>
            </div>
            {props.deletionConfirmation && (
                <div
                    className="console-delete-confirmation"
                    role="group"
                    aria-label="Confirm console capture deletion"
                >
                    <p>
                        Permanently delete{' '}
                        {props.deletionConfirmation === 'all'
                            ? 'all retained console flows in this profile or browser origin, including filtered and off-page flows'
                            : props.selectedIds.size + ' selected console flows'}{' '}
                        and their raw evidence?
                    </p>
                    <button
                        className="button danger"
                        disabled={disabled}
                        onClick={props.onConfirmClear}
                    >
                        Delete {props.deletionConfirmation === 'all' ? 'all retained' : 'selected'}{' '}
                        console flows
                    </button>
                    <button
                        className="button secondary"
                        disabled={props.operation === 'delete'}
                        onClick={props.onKeepCaptures}
                    >
                        Keep captures
                    </button>
                </div>
            )}
            <p className="console-results-note">
                Retained evidence stays until explicit deletion. Filtering and export inspect full
                stored evidence independently of this bounded page and preview. Active flows must
                finish or be cancelled before export or deletion.
            </p>
        </div>
    );
}
