import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    base64Bytes,
    bytesBase64,
    integer,
} from './capture-store';
import { captureScope, PlainCaptureText } from './capture-query';
import type { CaptureReportFormat } from './capture-report';
import {
    applyConsoleRecord,
    completeConsoleCursor,
    newConsoleCursor,
    type ConsoleRecord,
    type ConsoleSnapshot,
} from './console-journal';
import { consoleSnapshot, type ConsoleArchive } from './console-storage';
import { streamObject } from './ssh-stream-rpc';
import { consoleFilter, matchesConsoleCapture, type ConsoleFilter } from './console-query';

export interface ConsoleReportScope {
    ids?: string[];
    title?: string;
    filter?: ConsoleFilter;
}
export function consoleReportScope(input: unknown = {}): ConsoleReportScope {
    const value = streamObject(input, ['ids', 'title', 'filter']);
    const scope = captureScope({
        ...(value.ids !== undefined ? { ids: value.ids } : {}),
        ...(value.title !== undefined ? { title: value.title } : {}),
    });
    if (value.filter !== undefined && value.ids !== undefined)
        throw new CaptureStorageError('invalid', 'Choose selected IDs or a console filter.');
    return {
        ...scope,
        ...(value.filter !== undefined ? { filter: consoleFilter(value.filter) } : {}),
    };
}
const encoder = new TextEncoder();
function* text(value: string): Generator<Uint8Array> {
    // A row is bounded by one validated journal record, independently of retained output size.
    const bytes = encoder.encode(value);
    for (let offset = 0; offset < bytes.length; offset += CAPTURE_STORAGE.frameBytes)
        yield bytes.subarray(offset, offset + CAPTURE_STORAGE.frameBytes);
}
const exact = (value: unknown) => {
    const bytes = encoder.encode(JSON.stringify(value));
    integer(bytes.length, 1, CAPTURE_STORAGE.metadataBytes);
    const pieces: string[] = [];
    // A multiple of three preserves canonical base64 when independently encoded blocks join.
    const block = CAPTURE_STORAGE.frameBytes - (CAPTURE_STORAGE.frameBytes % 3);
    for (let offset = 0; offset < bytes.length; offset += block)
        pieces.push(bytesBase64(bytes.subarray(offset, offset + block)));
    return pieces.join('');
};
const formula = (value: string) => /^[\s\x00-\x1f\x7f-\x9f]*[=+\-@]/.test(value);
const csv = (value: string) =>
    '"' + (formula(value) ? "'" + value : value).replace(/"/g, '""') + '"';
const markdown = (value: string) =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/[\\`*_{}\[\]()#+.!|~\-]/g, '\\$&');

// Only bounded metadata belongs in a heading/table. PTY text stays streamed and blockquoted.
const markdownInline = (value: string) =>
    markdown(
        value.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) =>
            c === '\n'
                ? '\\n'
                : c === '\r'
                  ? '\\r'
                  : c === '\t'
                    ? '\\t'
                    : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'),
        ),
    );
function markdownTable(rows: readonly (readonly [string, string])[]) {
    return (
        '| Field | Recorded value |\n| --- | --- |\n' +
        rows.map(([key, value]) => '| ' + key + ' | ' + markdownInline(value) + ' |\n').join('') +
        '\n'
    );
}
function markdownInput(command: string) {
    // consoleSegment already bounds script text to8192 UTF-8 bytes; never scan retained PTY output.
    const runs = command.match(/~+/g) ?? [],
        delimiter = '~'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    return delimiter + 'text\n' + command + '\n' + delimiter + '\n\n';
}
function markdownCapture(meta: ConsoleSnapshot) {
    return (
        '\n---\n\n## ' +
        (meta.state === 'complete' ? '✅' : '⚠️') +
        ' Console flow · ' +
        meta.header.id +
        '\n\n' +
        markdownTable([
            ['Capture state', meta.state],
            ['Shell closure', meta.shellClosed ? 'Confirmed' : 'Unconfirmed'],
            ['Target', meta.header.target.endpoint],
            ['User', meta.header.target.username ?? 'Unrecorded'],
            ['Flow ID', meta.header.flowId],
            ['Record started', meta.header.startedAt],
            ['Finalized / recovered', meta.finalizedAt ?? 'Unknown'],
            ['Receive clock', meta.header.receiveTimeSource],
            ['Retained bytes', String(meta.bytes)],
            ['Observed bytes', String(meta.observedBytes ?? 'Unknown')],
            ['Completion / recovery reason', meta.reason ?? 'Unknown'],
        ])
    );
}
const observationIcon = (reason: string) =>
    reason === 'prompt-observed'
        ? '👁️'
        : reason === 'cancelled'
          ? '⏹️'
          : reason === 'timeout'
            ? '⌛'
            : reason === 'transport-error' || reason === 'storage-error'
              ? '⚠️'
              : '🔹';
function markdownRecord(record: ConsoleRecord, label: string) {
    if (record.kind === 'segment-start' || record.kind === 'preparation') {
        const segment = record.segment;
        if (segment.kind === 'context')
            return (
                '### 🧩 Context · ' +
                segment.phase +
                '\n\n**Context is not a command.** Recorded: ' +
                markdownInline(record.at) +
                '\n\n'
            );
        return (
            '\n---\n\n### ' +
            (record.kind === 'preparation' ? '📝 Prepared input' : '⌨️ Command segment') +
            ' · ' +
            segment.ordinal +
            ' · ' +
            markdownInline(segment.name || 'Unnamed command') +
            '\n\n' +
            markdownTable([
                ['Input intent', segment.input.intent],
                ['Recorded at', record.at],
                [
                    'Dispatch evidence',
                    record.kind === 'segment-start' && record.inputSent
                        ? 'write-dispatched; not remote execution confirmation'
                        : 'Not established by this record; incomplete evidence may leave dispatch uncertain',
                ],
                ['Completion criterion', JSON.stringify(segment.criterion)],
            ]) +
            (segment.input.intent === 'send-enter'
                ? '**Requested input:** Send Enter (one CR; no script text).\n\n'
                : '**Requested script** (the console appends one CR):\n\n' +
                  markdownInput(segment.input.command))
        );
    }
    const heading =
        record.kind === 'observation'
            ? '📥 Received PTY'
            : record.kind === 'outcome'
              ? observationIcon(record.completion) + ' Command observation'
              : record.kind === 'preparation-end'
                ? observationIcon(record.reason) + ' Preparation ended'
                : observationIcon(record.reason) + ' Segment boundary';
    return '#### ' + heading + '\n\n**' + markdownInline(label) + '**\n\n';
}

async function* catalog(
    store: ConsoleArchive,
    scope: ConsoleReportScope,
    progress?: () => void | Promise<void>,
) {
    let after: string | undefined;
    const wanted = scope.ids ? new Set(scope.ids) : undefined;
    const found = new Set<string>();
    while (true) {
        await progress?.();
        const page = await store.list(after, 25);
        if (page.captures.length > 25)
            throw new CaptureStorageError('integrity', 'Console catalog page exceeded its bound.');
        let previous = after;
        for (const raw of page.captures) {
            const meta = consoleSnapshot(raw),
                id = meta.header.id;
            if (previous && id <= previous)
                throw new CaptureStorageError('integrity', 'Console catalog did not advance.');
            previous = id;
            if (wanted && !wanted.has(id)) continue;
            if (scope.filter && !(await matchesConsoleCapture(store, meta, scope.filter, progress)))
                continue;
            if (meta.state === 'active')
                throw new CaptureStorageError(
                    'busy',
                    'Finish or cancel selected console flows before export.',
                );
            if (wanted) found.add(id);
            yield meta;
        }
        if (page.next === null) break;
        if (!page.captures.length || page.next !== previous)
            throw new CaptureStorageError('integrity', 'Console catalog cursor differs.');
        after = page.next;
    }
    if (wanted && found.size !== wanted.size)
        throw new CaptureStorageError(
            'invalid',
            'A selected console capture is no longer retained. Refresh the catalog.',
        );
}

/** Independently replay the immutable prefix, including its encoded offset, before accepting EOF. */
async function* records(
    store: ConsoleArchive,
    expected: ConsoleSnapshot,
    progress?: () => void | Promise<void>,
) {
    const cursor = newConsoleCursor();
    let meta: ConsoleSnapshot | undefined,
        offset = 0;
    for await (const item of store.read(expected.header.id)) {
        await progress?.();
        if (item.kind === 'metadata') {
            if (meta)
                throw new CaptureStorageError('integrity', 'Duplicate console report metadata.');
            meta = consoleSnapshot(item.capture);
            if (JSON.stringify(meta) !== JSON.stringify(expected))
                throw new CaptureStorageError(
                    'integrity',
                    'Console snapshot changed during export.',
                );
        } else if (item.kind === 'record') {
            if (!meta) throw new CaptureStorageError('integrity', 'Console records lack metadata.');
            const record = applyConsoleRecord(cursor, item.record, meta.header);
            offset += encoder.encode(JSON.stringify(record) + '\n').length;
            integer(offset);
            yield record;
        } else throw new CaptureStorageError('integrity', 'Unknown console report event.');
    }
    if (
        !meta ||
        offset !== meta.offset ||
        cursor.pendingObservation ||
        (['records', 'bytes', 'observations', 'segments'] as const).some(
            (key) => cursor[key] !== meta![key],
        )
    )
        throw new CaptureStorageError('integrity', 'Console export prefix counters differ.');
    if (meta.state === 'complete') completeConsoleCursor(cursor);
}
function summary(record: ConsoleRecord) {
    if (record.kind === 'segment-start' || record.kind === 'preparation') {
        const segment = record.segment;
        return segment.kind === 'context'
            ? 'Context: ' + segment.phase
            : (record.kind === 'preparation'
                  ? 'Prepared input (dispatch not established by this record): '
                  : 'Command: ') +
                  segment.input.intent +
                  '; name=' +
                  JSON.stringify(segment.name) +
                  '; script=' +
                  JSON.stringify(segment.input.command) +
                  '; request=' +
                  segment.requestBase64 +
                  '; criterion=' +
                  JSON.stringify(segment.criterion);
    }
    if (record.kind === 'outcome')
        return (
            'Completion: ' +
            record.completion +
            '; exit code unavailable; match=' +
            JSON.stringify(record.match)
        );
    if (record.kind === 'segment-end')
        return 'Segment end: ' + record.reason + '; match=' + JSON.stringify(record.match);
    if (record.kind === 'preparation-end') return 'Preparation ended: ' + record.reason;
    return (
        'Combined PTY (' +
        record.origin +
        '), received ' +
        record.receivedAt +
        '; observation ' +
        record.observation
    );
}

/** Complete retained evidence, bounded one record at a time; never the UI preview or an output cap. */
export async function* streamConsoleReport(
    store: ConsoleArchive,
    format: CaptureReportFormat,
    input: ConsoleReportScope = {},
    progress?: () => void | Promise<void>,
): AsyncGenerator<Uint8Array> {
    const scope = consoleReportScope(input);
    if (!['json', 'csv', 'markdown', 'text'].includes(format))
        throw new CaptureStorageError('invalid', 'Invalid console report format.');
    const pin = await store.pin();
    try {
        const explanation =
            'Console PTY evidence uses one combined stream. Prompt observation is not a process exit status. Context is not a command. Missing input-sent metadata in incomplete evidence means dispatch is uncertain; never replay automatically.';
        if (format === 'json')
            yield* text(
                '{"format":"diagnostic-hub-console","schema":2,"mode":"console","byteEncoding":"base64","scope":' +
                    JSON.stringify(scope) +
                    ',"captures":[',
            );
        else if (format === 'csv') {
            yield* text(
                'capture_id,row_kind,summary,readable_text,formula_escaped_fields,canonical_json_base64,execution_mode\r\n',
            );
            yield* text(
                ['', 'export-scope', JSON.stringify(scope), explanation, '', '', 'console']
                    .map(csv)
                    .join(',') + '\r\n',
            );
        } else
            yield* text(
                (format === 'markdown' ? '# ⌨️ Console results\n\n' : 'Console results\n') +
                    explanation +
                    '\nExecution mode: console. Export scope JSON: ' +
                    (format === 'markdown'
                        ? markdown(JSON.stringify(scope))
                        : JSON.stringify(scope)) +
                    '\n' +
                    'Each canonical JSON base64 field is authoritative and round-trips exact metadata and bytes. Readable UTF-8 is a control-stripped projection; invalid UTF-8 uses replacement characters.\n\n',
            );
        if (format === 'markdown')
            yield* text(
                '**Interpretation:** ✅ means a complete retained capture, not command success. ' +
                    'Shell closure is a separate acknowledgement. 👁️ means prompt observation, ' +
                    'with no process exit status; ⏹️ means cancellation, ⌛ timeout and ⚠️ incomplete ' +
                    'capture or recorded transport/storage failure. Prepared input alone does not ' +
                    'establish dispatch. Context is not a command.\n\n',
            );
        let firstCapture = true;
        for await (const meta of catalog(store, scope, progress)) {
            const id = meta.header.id;
            if (format === 'json')
                yield* text(
                    (firstCapture ? '' : ',') +
                        '{"capture":' +
                        JSON.stringify(meta) +
                        ',"records":[',
                );
            else if (format === 'csv')
                yield* text(
                    [
                        id,
                        'metadata',
                        meta.state + '; ' + (meta.reason ?? 'unknown'),
                        explanation,
                        '',
                        exact(meta),
                        'console',
                    ]
                        .map(csv)
                        .join(',') + '\r\n',
                );
            else if (format === 'markdown')
                yield* text(
                    markdownCapture(meta) +
                        'Canonical metadata JSON base64: ' +
                        exact(meta) +
                        '\n\n',
                );
            else
                yield* text(
                    'Capture ' +
                        id +
                        '\n\n' +
                        'State: ' +
                        meta.state +
                        '; retained bytes: ' +
                        meta.bytes +
                        '; observed bytes: ' +
                        (meta.observedBytes ?? 'unknown') +
                        '; shell closed: ' +
                        meta.shellClosed +
                        '\n\n' +
                        'Canonical metadata JSON base64: ' +
                        exact(meta) +
                        '\n\n',
                );
            firstCapture = false;
            let firstRecord = true;
            const decoder = new TextDecoder(),
                plain = new PlainCaptureText();
            for await (const record of records(store, meta, progress)) {
                if (format === 'json')
                    yield* text((firstRecord ? '' : ',') + JSON.stringify(record));
                else {
                    const readable =
                        record.kind === 'observation'
                            ? plain.append(
                                  decoder.decode(base64Bytes(record.base64), { stream: true }),
                              )
                            : '';
                    const label = summary(record),
                        canonical = exact(record);
                    if (format === 'csv') {
                        const escaped = [
                            formula(label) ? 'summary' : '',
                            formula(readable) ? 'readable_text' : '',
                        ]
                            .filter(Boolean)
                            .join(';');
                        yield* text(
                            [id, record.kind, label, readable, escaped, canonical, 'console']
                                .map(csv)
                                .join(',') + '\r\n',
                        );
                    } else if (format === 'markdown')
                        yield* text(
                            markdownRecord(record, label) +
                                (readable
                                    ? readable
                                          .split('\n')
                                          .map((line) => '> ' + markdown(line))
                                          .join('\n') + '\n\n'
                                    : '') +
                                'Canonical record JSON base64: ' +
                                canonical +
                                '\n\n',
                        );
                    else
                        yield* text(
                            label +
                                '\n' +
                                (readable
                                    ? 'Readable PTY: ' + JSON.stringify(readable) + '\n'
                                    : '') +
                                'Canonical record JSON base64: ' +
                                canonical +
                                '\n\n',
                        );
                }
                firstRecord = false;
            }
            if (format === 'json') yield* text(']}');
            else {
                const tail = plain.append(decoder.decode());
                if (tail) {
                    if (format === 'csv')
                        yield* text(
                            [
                                id,
                                'readable-tail',
                                '',
                                tail,
                                formula(tail) ? 'readable_text' : '',
                                '',
                                'console',
                            ]
                                .map(csv)
                                .join(',') + '\r\n',
                        );
                    else
                        yield* text(
                            'Readable decoder tail: ' +
                                (format === 'markdown'
                                    ? markdown(JSON.stringify(tail))
                                    : JSON.stringify(tail)) +
                                '\n\n',
                        );
                }
            }
        }
        if (format === 'json') yield* text(']}\n');
    } finally {
        await pin.release();
    }
}
