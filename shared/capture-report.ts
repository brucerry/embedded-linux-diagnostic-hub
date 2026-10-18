import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    type CaptureRepository,
    type StoredCapture,
} from './capture-store';
import { streamCaptureJson } from './capture-export';
import { captureScope, matchesCapture, type CaptureScope } from './capture-query';

export type CaptureReportFormat = 'json' | 'csv' | 'markdown' | 'text';
export type CaptureReportScope = CaptureScope;
const encoder = new TextEncoder();
const encoded = (value: string) => encoder.encode(value);
const mark = (value: string) =>
    value
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/[\\`*_{}\[\]()#+.!|~\-]/g, '\\$&');
const formula = (value: string) => /^[\s\x00-\x1f\x7f-\x9f]*[=+\-@]/.test(value);
const csv = (value: string) =>
    '"' + (formula(value) ? "'" + value : value).replace(/"/g, '""') + '"';
// These are this schema's arbitrary text cells; remaining cells are canonical IDs/enums/counts/times/base64.
const csvChanges = (capture: StoredCapture) =>
    [
        ['name', capture.header.name],
        ['command', capture.header.command],
        ['reason', capture.reason ?? ''],
    ]
        .filter(([, value]) => formula(value))
        .map(([field]) => field)
        .join(';');
const icon = (capture: StoredCapture) => (capture.state === 'complete' ? '✅' : '⚠️');
function scopeLabel(scope: CaptureReportScope) {
    if (scope.ids) return 'Selected captures (' + scope.ids.length + ')';
    if (scope.filter)
        return (
            'Filtered retained captures: ' +
            Object.entries(scope.filter)
                .map(([field, value]) => field + '=' + value)
                .join('; ')
        );
    return scope.runId ? 'Run ' + scope.runId : 'All retained captures';
}
async function outcomeCell(store: CaptureRepository, id: string) {
    const outcome = (await store.result?.(id)) ?? null;
    return outcome
        ? 'base64:' + btoa(String.fromCharCode(...encoded(JSON.stringify(outcome))))
        : '';
}
async function* outcomeEvidence(store: CaptureRepository, id: string, markdown: boolean) {
    const outcome = (await store.result?.(id)) ?? null;
    if (!outcome) {
        yield encoded(
            markdown
                ? '\n**Command outcome:** metadata unavailable; raw completeness does not establish command success.\n\n'
                : '\nCommand outcome metadata unavailable; raw completeness does not establish command success.\n',
        );
        return;
    }
    const json = JSON.stringify(outcome);
    if (markdown) {
        yield encoded(
            '\n### Execution evidence\n\n**Completion:** ' +
                mark(outcome.completion) +
                ' · **Exit code:** ' +
                (outcome.exitCode ?? 'unavailable') +
                ' · **Host completed (UTC):** ' +
                outcome.completedAt +
                '\n\n',
        );
        const n = Math.max(3, tildeMaximum(json).max + 1);
        yield* fence(n, 'json');
        yield encoded(json + '\n');
        yield* fence(n);
    } else yield encoded('\nCommand outcome JSON: ' + json + '\n');
}
function* fence(length: number, language = ''): Generator<Uint8Array> {
    while (length > 0) {
        const n = Math.min(length, CAPTURE_STORAGE.frameBytes);
        yield encoded('~'.repeat(n));
        length -= n;
    }
    yield encoded(language + '\n');
}
function tildeMaximum(text: string, previous = { current: 0, max: 0 }) {
    for (const c of text) {
        previous.current = c === '~' ? previous.current + 1 : 0;
        previous.max = Math.max(previous.max, previous.current);
    }
    return previous;
}
async function* catalog(
    store: CaptureRepository,
    through: number,
    scope: CaptureReportScope,
    progress?: () => void | Promise<void>,
) {
    if (!through) return;
    let after = 0;
    const found = new Set<string>();
    while (true) {
        const page = await store.page(after, CAPTURE_STORAGE.pageRows, through);
        for (const capture of page.records)
            if (await matchesCapture(store, capture, scope, undefined, progress)) {
                if (capture.state === 'active')
                    throw new CaptureStorageError(
                        'busy',
                        'Finish or cancel selected captures before export.',
                    );
                if (scope.ids) found.add(capture.id);
                yield capture;
            }
        if (page.next === null) break;
        after = page.next;
    }
    if (scope.ids && found.size !== scope.ids.length)
        throw new CaptureStorageError(
            'integrity',
            'Some selected captures are unavailable in this snapshot; no partial selection is exported.',
        );
}
/** Readable projection only: independent decoders prevent stdout/stderr fragments corrupting each other. */
async function* decoded(
    store: CaptureRepository,
    id: string,
    progress?: () => void | Promise<void>,
) {
    const decoders = new Map<string, TextDecoder>();
    // JSON validation ensures every frame and final count is verified even for readable projections.
    // Avoid a second whole-output representation: validate the same bounded frames as they arrive.
    const { appendFrames, newCapture } = await import('./capture-store');
    let verified: StoredCapture | undefined, metadata: StoredCapture | undefined;
    for await (const event of store.read(id)) {
        await progress?.();
        if (event.type === 'metadata') {
            if (metadata) throw new CaptureStorageError('integrity', 'Duplicate capture metadata.');
            metadata = event.capture;
            verified = newCapture(metadata.id, metadata.sequence, metadata.header);
        } else {
            if (!verified || !metadata)
                throw new CaptureStorageError('integrity', 'Output arrived before metadata.');
            verified = appendFrames(verified, [event.frame]);
            let decoder = decoders.get(event.frame.stream);
            if (!decoder) {
                decoder = new TextDecoder();
                decoders.set(event.frame.stream, decoder);
            }
            const text = decoder.decode(event.frame.bytes, { stream: true });
            if (text) yield text;
        }
    }
    if (
        !metadata ||
        !verified ||
        metadata.committedBytes !== verified.committedBytes ||
        metadata.committedFrames !== verified.committedFrames ||
        metadata.observations !== verified.observations ||
        metadata.firstReceivedAt !== verified.firstReceivedAt ||
        metadata.lastReceivedAt !== verified.lastReceivedAt ||
        JSON.stringify(metadata.pendingObservation) !== JSON.stringify(verified.pendingObservation)
    )
        throw new CaptureStorageError(
            'integrity',
            'Readable output does not match its pinned raw evidence.',
        );
    for (const decoder of decoders.values()) {
        const text = decoder.decode();
        if (text) yield text;
    }
}
async function outputStats(
    store: CaptureRepository,
    id: string,
    progress?: () => void | Promise<void>,
) {
    const stats = { current: 0, max: 0 };
    for await (const text of decoded(store, id, progress)) tildeMaximum(text, stats);
    return stats.max;
}

/** Pins catalog membership, streams bounded pages and never embeds large output in a table cell. */
export async function* streamCaptureReport(
    store: CaptureRepository,
    format: CaptureReportFormat,
    scope: CaptureReportScope = {},
    pinnedThrough?: number,
    progress?: () => void | Promise<void>,
): AsyncGenerator<Uint8Array> {
    scope = captureScope(scope);
    if (
        !['json', 'csv', 'markdown', 'text'].includes(format) ||
        (scope.title && scope.title.length > 256) ||
        (scope.runId && scope.runId.length > 128)
    )
        throw new CaptureStorageError('invalid', 'Invalid capture report format or scope.');
    const pin = await store.pin();
    try {
        if (pinnedThrough !== undefined) {
            if (
                !Number.isSafeInteger(pinnedThrough) ||
                pinnedThrough < 0 ||
                pinnedThrough > pin.through
            )
                throw new CaptureStorageError(
                    'integrity',
                    'Invalid pinned export high-water mark.',
                );
            pin.through = pinnedThrough;
        }
        let count = 0,
            complete = 0,
            incomplete = 0,
            bytes = 0;
        for await (const capture of catalog(store, pin.through, scope, progress)) {
            count++;
            bytes += capture.committedBytes;
            capture.state === 'complete' ? complete++ : incomplete++;
        }
        if (!count)
            throw new CaptureStorageError('invalid', 'No stored captures match this export.');
        if (format === 'json') {
            yield encoded(
                '{"schemaVersion":3,"throughSequence":' +
                    pin.through +
                    ',"scope":' +
                    JSON.stringify(scope) +
                    ',"captures":[',
            );
            let index = 0;
            for await (const capture of catalog(store, pin.through, scope, progress)) {
                if (index++) yield encoded(',');
                yield* streamCaptureJson(store, capture.id);
            }
            yield encoded(
                '],"summary":' +
                    JSON.stringify({
                        captures: count,
                        complete,
                        incomplete,
                        verifiedCommittedBytes: bytes,
                    }) +
                    '}\n',
            );
            return;
        }
        if (format === 'csv') {
            yield encoded(
                'capture_id,sequence,name,command,capture_state,reason,committed_bytes,observed_bytes,completed_observations,partial_observation,receive_clock,record_started_utc,finalized_or_recovered_utc,observation,received_utc,stream,observation_offset,observation_bytes,raw_base64_prefixed,transformedFields,outcome_json_base64_prefixed,export_scope\r\n',
            );
            for await (const capture of catalog(store, pin.through, scope, progress)) {
                let rows = 0;
                const outcome = await outcomeCell(store, capture.id),
                    label = scopeLabel(scope);
                // Reuse the raw validator without retaining JSON; a missing block makes the whole export fail.
                // This verification pass finishes before any CSV row for the capture is accepted.
                for await (const ignored of streamCaptureJson(store, capture.id)) {
                    void ignored;
                    await progress?.();
                }
                for await (const event of store.read(capture.id))
                    if (event.type === 'frame') {
                        const { bytesBase64 } = await import('./capture-store'),
                            f = event.frame;
                        yield encoded(
                            [
                                capture.id,
                                String(capture.sequence),
                                capture.header.name,
                                capture.header.command,
                                capture.state,
                                capture.reason ?? '',
                                String(capture.committedBytes),
                                capture.observedBytes === null
                                    ? 'unknown'
                                    : String(capture.observedBytes),
                                String(capture.observations),
                                String(Boolean(capture.pendingObservation)),
                                capture.header.receiveTimeSource,
                                capture.header.startedAt,
                                capture.finalizedAt ?? '',
                                String(f.observation),
                                f.receivedAt,
                                f.stream,
                                String(f.offset),
                                String(f.totalBytes),
                                'base64:' + bytesBase64(f.bytes),
                                csvChanges(capture),
                                outcome,
                                label,
                            ]
                                .map(csv)
                                .join(',') + '\r\n',
                        );
                        rows++;
                    }
                if (!rows)
                    yield encoded(
                        [
                            capture.id,
                            String(capture.sequence),
                            capture.header.name,
                            capture.header.command,
                            capture.state,
                            capture.reason ?? '',
                            String(capture.committedBytes),
                            capture.observedBytes === null
                                ? 'unknown'
                                : String(capture.observedBytes),
                            String(capture.observations),
                            String(Boolean(capture.pendingObservation)),
                            capture.header.receiveTimeSource,
                            capture.header.startedAt,
                            capture.finalizedAt ?? '',
                            '',
                            '',
                            '',
                            '',
                            '',
                            'base64:',
                            csvChanges(capture),
                            outcome,
                            label,
                        ]
                            .map(csv)
                            .join(',') + '\r\n',
                    );
            }
            return;
        }
        const title = scope.title ?? 'Automation run report';
        if (format === 'markdown') {
            yield encoded(
                '# 🧪 ' +
                    mark(title) +
                    '\n\n**Captures:** ' +
                    count +
                    ' · **Complete:** ' +
                    complete +
                    ' · **Incomplete:** ' +
                    incomplete +
                    ' · **Committed bytes:** ' +
                    bytes +
                    '\n\n' +
                    '**Scope:** ' +
                    mark(scopeLabel(scope)) +
                    ' · **Pinned through sequence:** ' +
                    pin.through +
                    '\n\n' +
                    '> ℹ️ ✅ means capture completeness, not command success. Times are host receive/record times in UTC, not device emission times. Finalized time may be recovery time. Incomplete captures contain only their verified committed prefix; an unknown observed tail stays unknown.\n\n' +
                    '> 📎 This file is a readable UTF-8 projection. **Raw JSON v3** preserves exact base64 bytes, per-observation timestamps, boundaries, stream IDs, checksums and completeness.\n\n---\n\n' +
                    '## 📋 Capture summary\n\n| # | Command label | Capture | Bytes | First received (UTC) | Last received (UTC) |\n| --- | --- | --- | ---: | --- | --- |\n',
            );
            let number = 0;
            for await (const capture of catalog(store, pin.through, scope, progress))
                yield encoded(
                    '| ' +
                        ++number +
                        ' | ' +
                        mark(capture.header.name || 'Unnamed command') +
                        ' | ' +
                        icon(capture) +
                        ' **' +
                        capture.state +
                        '** | ' +
                        capture.committedBytes +
                        ' | ' +
                        (capture.firstReceivedAt ?? 'None retained') +
                        ' | ' +
                        (capture.lastReceivedAt ?? 'None retained') +
                        ' |\n',
                );
            let numberDetail = 0;
            for await (const capture of catalog(store, pin.through, scope, progress)) {
                const outputFence = Math.max(
                        3,
                        (await outputStats(store, capture.id, progress)) + 1,
                    ),
                    commandFence = Math.max(3, tildeMaximum(capture.header.command).max + 1);
                yield encoded(
                    '\n---\n\n## ' +
                        icon(capture) +
                        ' ' +
                        ++numberDetail +
                        '. ' +
                        mark(capture.header.name || 'Unnamed command') +
                        '\n\n' +
                        '**Transport:** ' +
                        capture.header.transport +
                        ' · **Receive clock:** ' +
                        capture.header.receiveTimeSource +
                        ' · **Capture:** **' +
                        capture.state +
                        '**\n\n' +
                        '**Target:** ' +
                        mark(capture.header.target?.endpoint ?? 'Unrecorded') +
                        (capture.header.target?.username
                            ? ' · **User:** ' + mark(capture.header.target.username)
                            : '') +
                        (capture.header.target?.serialSettings
                            ? ' · **Serial framing:** ' + mark(capture.header.target.serialSettings)
                            : '') +
                        '\n\n' +
                        (capture.header.execution
                            ? '**Input intent:** ' +
                              capture.header.execution.intent +
                              ' · **Mode:** ' +
                              capture.header.execution.mode +
                              ' · **Timeout:** ' +
                              capture.header.execution.timeoutMs +
                              ' ms\n\n'
                            : '') +
                        '**Capture ID:** ' +
                        capture.id +
                        ' · **Completed receive observations:** ' +
                        capture.observations +
                        (capture.pendingObservation
                            ? ' · **Partial receive observation retained**'
                            : '') +
                        ' · **Committed bytes:** ' +
                        capture.committedBytes +
                        ' · **Observed bytes:** ' +
                        (capture.observedBytes ?? 'Unknown after interruption') +
                        '\n\n' +
                        '**Record started (UTC):** ' +
                        capture.header.startedAt +
                        ' · **Finalized / recovered (UTC):** ' +
                        (capture.finalizedAt ?? 'Unknown') +
                        '\n\nFirst/last receive timestamps follow observation order, including clock jumps.\n\n' +
                        '**Completion / recovery reason:** ' +
                        mark(capture.reason ?? 'Unspecified') +
                        '\n\n### ⌨️ Command\n\n',
                );
                yield* fence(commandFence, 'sh');
                yield encoded(capture.header.command + '\n');
                yield* fence(commandFence);
                yield* outcomeEvidence(store, capture.id, true);
                yield encoded(
                    '\n### 📥 Detailed received output\n\nDecoded per stream as UTF-8 in receive-observation order; invalid bytes use replacement characters.\n\n',
                );
                yield* fence(outputFence, 'text');
                for await (const text of decoded(store, capture.id, progress)) yield encoded(text);
                yield encoded('\n');
                yield* fence(outputFence);
            }
            yield encoded(
                '\n---\n\n**Export integrity:** all ' +
                    count +
                    ' captures read through their pinned committed high-water marks. **Incomplete captures:** ' +
                    incomplete +
                    '.\n',
            );
        } else {
            yield encoded(
                title +
                    '\nCaptures: ' +
                    count +
                    '; complete: ' +
                    complete +
                    '; incomplete: ' +
                    incomplete +
                    '; committed bytes: ' +
                    bytes +
                    '\nHost receive/record timestamps are UTC. Raw JSON v3 preserves exact bytes and provenance.\n',
            );
            for await (const capture of catalog(store, pin.through, scope, progress)) {
                yield* outcomeEvidence(store, capture.id, false);
                yield encoded(
                    '\n----------------------------------------\n' +
                        capture.header.name +
                        '\nCapture: ' +
                        capture.state +
                        '; receive clock: ' +
                        capture.header.receiveTimeSource +
                        '\nCommitted bytes: ' +
                        capture.committedBytes +
                        '; observed bytes: ' +
                        (capture.observedBytes ?? 'unknown') +
                        '; completed receive observations: ' +
                        capture.observations +
                        '; partial observation: ' +
                        Boolean(capture.pendingObservation) +
                        '\nStarted: ' +
                        capture.header.startedAt +
                        '; finalized/recovered: ' +
                        (capture.finalizedAt ?? 'unknown') +
                        '\nFirst received: ' +
                        (capture.firstReceivedAt ?? 'none retained') +
                        '; last received: ' +
                        (capture.lastReceivedAt ?? 'none retained') +
                        '\nReason: ' +
                        capture.reason +
                        '\nCommand:\n' +
                        capture.header.command +
                        '\nReceived output (UTF-8 projection):\n',
                );
                for await (const text of decoded(store, capture.id, progress)) yield encoded(text);
                yield encoded('\n');
            }
        }
    } finally {
        await pin.release();
    }
}
