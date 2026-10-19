/** Actual App UI only. This helper never creates a stored capture or supplies owner counts. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { expect, type Download, type Locator, type Page } from '@playwright/test';
import {
    base64Bytes,
    captureVerifier,
    storedCapture,
    type CaptureFrame,
    type StoredCapture,
} from '../../shared/capture-store';
import type { CaptureReportFormat } from '../../shared/capture-report';
import {
    ReportCursor,
    parseReportJson,
    parseReportCsv,
} from '../../scripts/lib/bounded-report-reader.mjs';
import { inspectOwnedArtifact } from '../../scripts/lib/owned-artifact-stream.mjs';
import type {} from './memory-product-app';
import type { ProductViewerDownload } from './memory-product-ui';

type Stream = CaptureFrame['stream'];
export interface ResultsCapture {
    id: string;
    sequence: number;
    transport: 'serial' | 'ssh';
    command: string;
    name?: string;
    state: 'complete' | 'incomplete';
    committedBytes: number;
    completion?: string | null;
    exitCode?: number | null;
    /** Caller derives these from the actual producer's known bytes, not from the exported file. */
    streams?: Partial<Record<Stream, { bytes: number; sha256: string }>>;
    /** Independently producer-derived complete UTF-8 projection, not inferred from report bytes. */
    readableOutput?: { bytes: number; sha256: string };
    readableTokens?: readonly string[];
}
export interface ResultsCatalogEvolution {
    mode: 'constant' | 'bounded-growing';
    previousIds: readonly string[];
    expectedAddedIds: readonly string[];
    bound: number;
}
export interface ResultsExportReadFault {
    realm: 'service-worker' | 'native-main';
    quotaMessage: string;
    arm(action: 'hold' | 'quota'): Promise<void>;
    status(): Promise<{
        method: 'read';
        action: 'hold' | 'quota';
        entered: boolean;
        released: boolean;
    }>;
    release(): Promise<void>;
    clear(): Promise<void>;
    /** Raw actual probes only; this helper makes no SW-owner verdict or zero-filled map. */
    snapshot?(): Promise<unknown>;
}
export interface ProductResultsOptions {
    transport: 'serial' | 'ssh';
    /** Complete actual catalog, including other-transport captures that must be preserved. */
    catalog: readonly ResultsCapture[];
    selection: readonly ResultsCapture[];
    search: { query: string; expectedIds: readonly string[] };
    evidenceDirectory: string;
    /** Explicit bounded semantic-fixture budget. Oversized downloads fail; they are never truncated. */
    maxDownloadBytes: number;
    requireCrossPage: boolean;
    clear: 'selected' | 'all-transport' | 'none';
    /** Replaces the actual page realm; schedule outside any same-realm memory/ledger baseline. */
    reopen: 'reload' | 'none';
    evolution?: ResultsCatalogEvolution;
    exportReadFault?: ResultsExportReadFault;
    nativeSaveCases?: (view: Locator) => Promise<unknown>;
    nativeEmptyExport?: {
        begin(): Promise<void>;
        finish(): Promise<{ calls: number; returned: number }>;
    };
    streamDownload?: ProductResultsDownload;
    browserDownloads?: { count(): number };
}
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const streams: Stream[] = ['serial', 'stdout', 'stderr'];
const sorted = (values: readonly string[]) => [...values].sort();
function exactIds(actual: readonly string[], expected: readonly string[]) {
    assert.equal(new Set(actual).size, actual.length, 'Duplicate capture membership.');
    assert.deepEqual(
        sorted(actual),
        sorted(expected),
        'Missing or substituted capture membership.',
    );
}
function record(value: unknown): Record<string, any> {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, any>;
}
function outcome(actual: unknown, expected: ResultsCapture) {
    if (expected.completion === undefined) return;
    if (expected.completion === null) return assert.equal(actual, null);
    const value = record(actual);
    assert.equal(value.completion, expected.completion);
    assert.equal(value.exitCode, expected.exitCode);
}
function streamAccumulator() {
    const values = new Map<Stream, { bytes: number; hash: ReturnType<typeof createHash> }>();
    return {
        add(stream: Stream, bytes: Uint8Array) {
            assert.ok(streams.includes(stream), 'Unknown report stream.');
            let value = values.get(stream);
            if (!value) values.set(stream, (value = { bytes: 0, hash: createHash('sha256') }));
            value.bytes += bytes.length;
            value.hash.update(bytes);
        },
        finish(expected: ResultsCapture) {
            const summary = streams.map((stream) => {
                const value = values.get(stream);
                return {
                    stream,
                    bytes: value?.bytes ?? 0,
                    sha256: value ? value.hash.digest('hex') : sha(''),
                };
            });
            assert.equal(
                summary.reduce((sum, value) => sum + value.bytes, 0),
                expected.committedBytes,
            );
            if (expected.streams) {
                for (const actual of summary) {
                    const wanted: { bytes: number; sha256: string } = expected.streams[
                        actual.stream
                    ] ?? { bytes: 0, sha256: sha('') };
                    assert.equal(actual.bytes, wanted.bytes, 'Exact stream byte count differs.');
                    assert.equal(actual.sha256, wanted.sha256, 'Exact stream bytes differ.');
                }
            }
            return summary;
        },
    };
}

function assertReadableOutput(actual: string | Uint8Array | undefined, expected: ResultsCapture) {
    const wanted = expected.readableOutput;
    assert.ok(
        wanted,
        'Full readable output expectation is required; tokens cannot attest completeness.',
    );
    assert.ok(Number.isSafeInteger(wanted.bytes) && wanted.bytes >= 0);
    assert.match(wanted.sha256, /^[a-f0-9]{64}$/);
    assert.notEqual(actual, undefined, 'Readable output body is missing.');
    assert.equal(
        typeof actual === 'string' ? Buffer.byteLength(actual) : actual!.byteLength,
        wanted.bytes,
        'Complete readable output byte count differs.',
    );
    assert.equal(sha(actual!), wanted.sha256, 'Complete readable output body differs.');
}

/** Strict CSV parser supports quoted CR/LF and escaped quotes; never splits physical lines as rows. */
export function parseResultsCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [],
        field = '',
        quoted = false,
        afterQuote = false,
        atStart = true;
    for (let index = 0; index < text.length; index++) {
        const c = text[index];
        if (quoted) {
            if (c === '"') {
                if (text[index + 1] === '"') {
                    field += '"';
                    index++;
                } else {
                    quoted = false;
                    afterQuote = true;
                }
            } else field += c;
            continue;
        }
        if (c === '"') {
            assert.ok(atStart && !afterQuote, 'Unexpected CSV quote.');
            quoted = true;
            atStart = false;
            continue;
        }
        if (c === ',' || c === '\r' || c === '\n') {
            row.push(field);
            field = '';
            atStart = true;
            afterQuote = false;
            if (c !== ',') {
                if (c === '\r') {
                    assert.equal(text[index + 1], '\n', 'Bare CSV CR.');
                    index++;
                }
                rows.push(row);
                row = [];
            }
        } else {
            assert.ok(!afterQuote, 'Text after closing CSV quote.');
            field += c;
            atStart = false;
        }
    }
    assert.equal(quoted, false, 'Truncated quoted CSV field.');
    if (field || row.length || !atStart || afterQuote) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/** Parse only metadata outside the product's variable-length tilde fences. */
export function markdownResultsSections(text: string) {
    const sections: { id: string; command?: string; output?: string; outcome?: unknown }[] = [];
    let current: (typeof sections)[number] | undefined;
    let fence: { length: number; language: string; body: string[] } | undefined;
    for (const line of text.split('\n')) {
        if (fence) {
            if (line === '~'.repeat(fence.length)) {
                if (current && fence.language === 'sh') {
                    assert.equal(current.command, undefined);
                    current.command = fence.body.join('\n');
                }
                if (current && fence.language === 'text') {
                    assert.equal(current.output, undefined);
                    current.output = fence.body.join('\n');
                }
                if (current && fence.language === 'json') {
                    assert.equal(current.outcome, undefined);
                    current.outcome = JSON.parse(fence.body.join('\n'));
                }
                fence = undefined;
            } else fence.body.push(line);
            continue;
        }
        const open = /^(~{3,})([a-z]*)$/.exec(line);
        if (open) {
            fence = { length: open[1].length, language: open[2], body: [] };
            continue;
        }
        const id = /^\*\*Capture ID:\*\* ([a-f0-9-]{36})(?:\s|$)/.exec(line);
        if (id) {
            current = { id: id[1] };
            sections.push(current);
        }
    }
    assert.equal(fence, undefined, 'Truncated Markdown code fence.');
    return sections;
}

export function assertResultsCatalogEvolution(
    currentIds: readonly string[],
    evolution: ResultsCatalogEvolution,
) {
    assert.ok(
        Number.isSafeInteger(evolution.bound) && evolution.bound > 0 && evolution.bound <= 500,
    );
    assert.ok(
        currentIds.length <= evolution.bound,
        'Actual catalog exceeds its explicit test profile bound.',
    );
    exactIds(evolution.previousIds, [...new Set(evolution.previousIds)]);
    const old = new Set(evolution.previousIds),
        current = new Set(currentIds);
    assert.equal(current.size, currentIds.length);
    const added = currentIds.filter((id) => !old.has(id));
    const removed = evolution.previousIds.filter((id) => !current.has(id));
    assert.deepEqual(removed, [], 'A removed catalog item cannot hide a newly retained capture.');
    exactIds(added, evolution.expectedAddedIds);
    if (evolution.mode === 'constant')
        assert.deepEqual(added, [], 'Constant catalog membership grew.');
    else assert.equal(evolution.mode, 'bounded-growing');
    return {
        mode: evolution.mode,
        count: currentIds.length,
        addedIds: added,
        removedIds: removed,
        bound: evolution.bound,
    };
}

export const resultsCsvFields = [
    'capture_id',
    'sequence',
    'name',
    'command',
    'capture_state',
    'reason',
    'committed_bytes',
    'observed_bytes',
    'completed_observations',
    'partial_observation',
    'receive_clock',
    'record_started_utc',
    'finalized_or_recovered_utc',
    'observation',
    'received_utc',
    'stream',
    'observation_offset',
    'observation_bytes',
    'raw_base64_prefixed',
    'transformedFields',
    'outcome_json_base64_prefixed',
    'export_scope',
];

export type ResultsReportInspection = {
    format: CaptureReportFormat;
    captures: number;
    captureIds: string[] | null;
    identityAttested: boolean;
    readableOutputAttested?: boolean;
    bytes: number;
    sha256: string;
    limitation?: string;
    allocation?: unknown;
};
export type ProductResultsDownload = (
    extension: string,
    action: () => Promise<void>,
    validate: (chunks: AsyncIterable<Uint8Array>) => Promise<ResultsReportInspection>,
) => Promise<ResultsReportInspection>;

/** Same membership, outcome and full-output checks as the bounded reference parser. */
export async function inspectProductResultsStream(
    format: CaptureReportFormat,
    input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    expected: readonly ResultsCapture[],
    maximum = 128 * 1024 ** 2,
): Promise<ResultsReportInspection> {
    assert(expected.length > 0 && expected.length <= 500);
    assert(maximum > 0 && maximum <= 128 * 1024 ** 2);
    exactIds(
        expected.map((value) => value.id),
        [...new Set(expected.map((value) => value.id))],
    );
    const byId = new Map(expected.map((value) => [value.id, value])),
        seen = new Set<string>();
    async function* chunks() {
        for await (const value of input) {
            assert(value instanceof Uint8Array);
            for (let offset = 0; offset < value.length; offset += 65536)
                yield value.subarray(offset, offset + 65536);
        }
    }
    const cursor = new ReportCursor(chunks(), maximum);
    try {
        if (format === 'json') {
            let current: any,
                total = 0,
                complete = 0;
            const root = await parseReportJson(cursor, {
                rawStart(row: any) {
                    assert(!current, 'Overlapping capture rows');
                    assert.equal(row.schemaVersion, 3);
                    const capture = storedCapture(row.capture),
                        wanted = byId.get(capture.id);
                    assert(wanted, 'Unexpected JSON capture');
                    assert(!seen.has(capture.id), 'Duplicate capture membership');
                    seen.add(capture.id);
                    assert.equal(capture.header.command, wanted.command);
                    assert.equal(capture.header.transport, wanted.transport);
                    assert.equal(capture.sequence, wanted.sequence);
                    if (wanted.name !== undefined) assert.equal(capture.header.name, wanted.name);
                    assert.equal(capture.state, wanted.state);
                    assert.equal(capture.committedBytes, wanted.committedBytes);
                    outcome(row.outcome, wanted);
                    current = {
                        capture,
                        wanted,
                        verify: captureVerifier(capture),
                        raw: streamAccumulator(),
                        frames: 0,
                    };
                },
                frame(input: any) {
                    assert(current, 'JSON frame before metadata');
                    assert(++current.frames <= current.capture.committedFrames, 'Excess raw frame');
                    const { base64, ...provenance } = record(input),
                        frame = { ...provenance, bytes: base64Bytes(base64) } as CaptureFrame;
                    current.verify.append(frame);
                    current.raw.add(frame.stream, frame.bytes);
                },
                capture(row: any) {
                    assert(current, 'JSON capture omitted raw observations');
                    assert.equal(row.captureComplete, current.wanted.state === 'complete');
                    assert.equal(row.verifiedCommittedBytes, current.wanted.committedBytes);
                    current.verify.finish();
                    current.raw.finish(current.wanted);
                    total += current.wanted.committedBytes;
                    if (current.wanted.state === 'complete') complete++;
                    current = null;
                },
            });
            assert(!current);
            assert.equal(root.schemaVersion, 3);
            assert(
                Number.isSafeInteger(root.throughSequence) &&
                    root.throughSequence >= Math.max(...expected.map((value) => value.sequence)),
            );
            exactIds([...seen], [...byId.keys()]);
            assert.deepEqual(root.summary, {
                captures: expected.length,
                complete,
                incomplete: expected.length - complete,
                verifiedCommittedBytes: total,
            });
            return {
                format,
                captures: seen.size,
                captureIds: [...seen],
                identityAttested: true,
                ...(await cursor.finish()),
            };
        }
        if (format === 'csv') {
            let header: string[] | undefined;
            const raw = new Map<string, ReturnType<typeof streamAccumulator>>();
            await parseReportCsv(cursor, (cells: string[]) => {
                if (!header) {
                    assert.deepEqual(cells, resultsCsvFields, 'Actual CSV schema changed');
                    header = cells;
                    return;
                }
                assert.equal(cells.length, header.length, 'CSV cell count differs');
                const row = Object.fromEntries(header.map((name, index) => [name, cells[index]])),
                    wanted = byId.get(row.capture_id);
                assert(wanted, 'Unexpected CSV capture');
                seen.add(wanted.id);
                let accumulator = raw.get(wanted.id);
                if (!accumulator) raw.set(wanted.id, (accumulator = streamAccumulator()));
                const transformed = new Set(row.transformedFields.split(';').filter(Boolean));
                const original = (name: string) =>
                    transformed.has(name)
                        ? (assert(row[name].startsWith("'")), row[name].slice(1))
                        : row[name];
                assert.equal(original('command'), wanted.command);
                if (wanted.name !== undefined) assert.equal(original('name'), wanted.name);
                assert.equal(Number(row.sequence), wanted.sequence);
                assert.equal(row.capture_state, wanted.state);
                assert.equal(Number(row.committed_bytes), wanted.committedBytes);
                if (row.stream) {
                    assert(row.raw_base64_prefixed.startsWith('base64:'));
                    accumulator.add(
                        row.stream as Stream,
                        base64Bytes(row.raw_base64_prefixed.slice(7)),
                    );
                } else assert.equal(row.raw_base64_prefixed, 'base64:');
                if (wanted.completion !== undefined) {
                    if (wanted.completion === null)
                        assert.equal(row.outcome_json_base64_prefixed, '');
                    else {
                        assert(row.outcome_json_base64_prefixed.startsWith('base64:'));
                        outcome(
                            JSON.parse(
                                new TextDecoder('utf-8', { fatal: true }).decode(
                                    Buffer.from(
                                        row.outcome_json_base64_prefixed.slice(7),
                                        'base64',
                                    ),
                                ),
                            ),
                            wanted,
                        );
                    }
                }
            });
            assert(header);
            exactIds([...seen], [...byId.keys()]);
            for (const wanted of expected) raw.get(wanted.id)!.finish(wanted);
            return {
                format,
                captures: seen.size,
                captureIds: [...seen],
                identityAttested: true,
                ...(await cursor.finish()),
            };
        }
        const readable = async (wanted: ResultsCapture) => {
            assert(wanted.readableOutput, 'Full readable output expectation required');
            const target = wanted.readableOutput;
            assert(Number.isSafeInteger(target.bytes) && target.bytes >= 0);
            assert.match(target.sha256, /^[a-f0-9]{64}$/);
            const hash = createHash('sha256'),
                tokens = (wanted.readableTokens ?? []).map((token) => {
                    const raw = Buffer.from(token);
                    assert(raw.length > 0 && raw.length <= 8192);
                    return { raw, found: false };
                });
            const overlap = Math.max(0, ...tokens.map((token) => token.raw.length - 1));
            let tail = Buffer.alloc(0);
            const decoder = new TextDecoder('utf-8', { fatal: true });
            await cursor.exact(target.bytes, (part: Buffer) => {
                hash.update(part);
                decoder.decode(part, { stream: true });
                if (tokens.length) {
                    const search = Buffer.concat([tail, part]);
                    for (const token of tokens) token.found ||= search.includes(token.raw);
                    tail = Buffer.from(search.subarray(Math.max(0, search.length - overlap)));
                }
            });
            decoder.decode();
            assert.equal(
                hash.digest('hex'),
                target.sha256,
                'Complete readable output body differs',
            );
            assert(
                tokens.every((token) => token.found),
                'Readable output omitted expected content',
            );
        };
        if (format === 'markdown') {
            for (let index = 0; index < expected.length; index++) {
                await cursor.until('**Capture ID:** ');
                const id = new TextDecoder('utf-8', { fatal: true }).decode(await cursor.small(36)),
                    wanted = byId.get(id);
                assert(wanted, 'Unexpected Markdown capture');
                assert(!seen.has(id), 'Duplicate capture membership');
                seen.add(id);
                await cursor.until('### ⌨️ Command\n\n');
                const commandFence = await cursor.fence('sh'),
                    command = await cursor.small(Buffer.byteLength(wanted.command), 8192);
                assert.equal(
                    new TextDecoder('utf-8', { fatal: true }).decode(command),
                    wanted.command,
                );
                await cursor.expect('\n');
                await cursor.closeFence(commandFence);
                const middle = await cursor.until(
                    '### 📥 Detailed received output\n\nDecoded per stream as UTF-8 in receive-observation order; invalid bytes use replacement characters.\n\n',
                );
                const metadata = markdownResultsSections(
                    '**Capture ID:** ' +
                        id +
                        '\n' +
                        new TextDecoder('utf-8', { fatal: true }).decode(middle),
                );
                assert.equal(metadata.length, 1);
                outcome(metadata[0].outcome ?? null, wanted);
                const outputFence = await cursor.fence('text');
                await readable(wanted);
                await cursor.expect('\n');
                await cursor.closeFence(outputFence);
            }
            const trailer = new TextDecoder('utf-8', { fatal: true }).decode(
                await cursor.until('\u0000', 1048576, true),
            );
            assert.equal(
                trailer,
                '\n---\n\n**Export integrity:** all ' +
                    expected.length +
                    ' captures read through their pinned committed high-water marks. **Incomplete captures:** ' +
                    expected.filter((value) => value.state !== 'complete').length +
                    '.\n',
                'Truncated or substituted Markdown integrity trailer',
            );
            exactIds([...seen], [...byId.keys()]);
            return {
                format,
                captures: seen.size,
                captureIds: [...seen],
                identityAttested: true,
                readableOutputAttested: true,
                ...(await cursor.finish()),
            };
        }
        assert.equal(format, 'text');
        let first = true;
        for (const wanted of [...expected].sort((a, b) => a.sequence - b.sequence)) {
            const header = new TextDecoder('utf-8', { fatal: true }).decode(
                await cursor.until(
                    '\nCommand:\n' + wanted.command + '\nReceived output (UTF-8 projection):\n',
                ),
            );
            if (first) {
                assert(
                    header.includes('\nCaptures: ' + expected.length + ';'),
                    'Text report count differs',
                );
                first = false;
            }
            await readable(wanted);
            await cursor.expect('\n');
        }
        return {
            format,
            captures: expected.length,
            captureIds: null,
            identityAttested: false,
            readableOutputAttested: true,
            limitation:
                'Text schema omits capture IDs; count/command/output semantics do not independently prove ID membership.',
            ...(await cursor.finish()),
        };
    } finally {
        await cursor.close();
    }
}

/** Semantic validation of actual downloaded bytes. Does not fetch or manufacture capture data. */
export function inspectProductResultsReport(
    format: CaptureReportFormat,
    bytes: Uint8Array,
    expected: readonly ResultsCapture[],
) {
    assert.ok(expected.length > 0);
    exactIds(
        expected.map((value) => value.id),
        [...new Set(expected.map((value) => value.id))],
    );
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const byId = new Map(expected.map((value) => [value.id, value]));
    if (format === 'json') {
        const value = record(JSON.parse(text));
        assert.equal(value.schemaVersion, 3);
        assert.ok(Array.isArray(value.captures));
        assert.ok(
            Number.isSafeInteger(value.throughSequence) &&
                value.throughSequence >= Math.max(...expected.map((item) => item.sequence)),
            'Pinned report sequence differs.',
        );
        exactIds(
            value.captures.map((row: any) => row.capture.id),
            [...byId.keys()],
        );
        let total = 0,
            complete = 0;
        for (const input of value.captures) {
            const row = record(input),
                capture = storedCapture(row.capture as StoredCapture),
                wanted = byId.get(capture.id)!;
            assert.equal(row.schemaVersion, 3);
            assert.equal(capture.header.command, wanted.command);
            assert.equal(capture.header.transport, wanted.transport);
            assert.equal(capture.sequence, wanted.sequence);
            if (wanted.name !== undefined) assert.equal(capture.header.name, wanted.name);
            assert.equal(capture.state, wanted.state);
            assert.equal(capture.committedBytes, wanted.committedBytes);
            assert.equal(row.captureComplete, wanted.state === 'complete');
            assert.equal(row.verifiedCommittedBytes, wanted.committedBytes);
            outcome(row.outcome, wanted);
            const verify = captureVerifier(capture),
                raw = streamAccumulator();
            assert.ok(Array.isArray(row.rawObservations));
            for (const encoded of row.rawObservations) {
                const { base64, ...provenance } = record(encoded),
                    frame = { ...provenance, bytes: base64Bytes(base64) } as CaptureFrame;
                verify.append(frame);
                raw.add(frame.stream, frame.bytes);
            }
            verify.finish();
            raw.finish(wanted);
            total += wanted.committedBytes;
            if (wanted.state === 'complete') complete++;
        }
        assert.deepEqual(value.summary, {
            captures: expected.length,
            complete,
            incomplete: expected.length - complete,
            verifiedCommittedBytes: total,
        });
        return {
            format,
            captures: expected.length,
            captureIds: [...byId.keys()],
            identityAttested: true,
            bytes: bytes.length,
            sha256: sha(bytes),
        };
    }
    if (format === 'csv') {
        const [header, ...rows] = parseResultsCsv(text);
        const required = resultsCsvFields;
        assert.deepEqual(header, required, 'Actual CSV schema changed.');
        const seen = new Set<string>(),
            raw = new Map<string, ReturnType<typeof streamAccumulator>>();
        for (const cells of rows) {
            assert.equal(cells.length, header.length, 'CSV cell count differs.');
            const row = Object.fromEntries(header.map((name, index) => [name, cells[index]])),
                wanted = byId.get(row.capture_id);
            assert.ok(wanted, 'Unexpected CSV capture.');
            seen.add(wanted.id);
            let accumulator = raw.get(wanted.id);
            if (!accumulator) raw.set(wanted.id, (accumulator = streamAccumulator()));
            const transformed = new Set(row.transformedFields.split(';').filter(Boolean));
            const original = (name: string) =>
                transformed.has(name)
                    ? (assert.ok(row[name].startsWith("'")), row[name].slice(1))
                    : row[name];
            assert.equal(original('command'), wanted.command);
            if (wanted.name !== undefined) assert.equal(original('name'), wanted.name);
            assert.equal(Number(row.sequence), wanted.sequence);
            assert.equal(row.capture_state, wanted.state);
            assert.equal(Number(row.committed_bytes), wanted.committedBytes);
            if (row.stream) {
                assert.ok(row.raw_base64_prefixed.startsWith('base64:'));
                accumulator.add(
                    row.stream as Stream,
                    base64Bytes(row.raw_base64_prefixed.slice(7)),
                );
            } else assert.equal(row.raw_base64_prefixed, 'base64:');
            if (wanted.completion !== undefined) {
                if (wanted.completion === null) assert.equal(row.outcome_json_base64_prefixed, '');
                else {
                    assert.ok(row.outcome_json_base64_prefixed.startsWith('base64:'));
                    outcome(
                        JSON.parse(
                            Buffer.from(
                                row.outcome_json_base64_prefixed.slice(7),
                                'base64',
                            ).toString('utf8'),
                        ),
                        wanted,
                    );
                }
            }
        }
        exactIds([...seen], [...byId.keys()]);
        for (const wanted of expected) raw.get(wanted.id)!.finish(wanted);
        return {
            format,
            captures: seen.size,
            captureIds: [...seen],
            identityAttested: true,
            bytes: bytes.length,
            sha256: sha(bytes),
        };
    }
    if (format === 'markdown') {
        const sections = markdownResultsSections(text);
        exactIds(
            sections.map((value) => value.id),
            [...byId.keys()],
        );
        for (const section of sections) {
            const wanted = byId.get(section.id)!;
            assert.equal(section.command, wanted.command);
            outcome(section.outcome ?? null, wanted);
            assertReadableOutput(section.output, wanted);
            for (const token of wanted.readableTokens ?? [])
                assert.ok(
                    section.output?.includes(token),
                    'Readable Markdown output omitted expected content.',
                );
        }
        assert.ok(text.includes('**Export integrity:** all ' + expected.length + ' captures'));
        return {
            format,
            captures: expected.length,
            captureIds: sections.map((value) => value.id),
            identityAttested: true,
            readableOutputAttested: true,
            bytes: bytes.length,
            sha256: sha(bytes),
        };
    }
    assert.equal(format, 'text');
    assert.ok(text.includes('\nCaptures: ' + expected.length + ';'), 'Text report count differs.');
    const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cursor = 0;
    for (const wanted of [...expected].sort((a, b) => a.sequence - b.sequence)) {
        assert.ok(
            wanted.readableOutput,
            'Full readable output expectation is required; tokens cannot attest completeness.',
        );
        const marker = Buffer.from(
            '\nCommand:\n' + wanted.command + '\nReceived output (UTF-8 projection):\n',
        );
        const position = raw.indexOf(marker, cursor);
        assert.ok(position >= cursor, 'Text command omitted.');
        const begin = position + marker.length,
            end = begin + wanted.readableOutput.bytes;
        assertReadableOutput(raw.subarray(begin, end), wanted);
        assert.equal(raw[end], 10, 'Text output/schema separator is missing.');
        cursor = end + 1;
        for (const token of wanted.readableTokens ?? [])
            assert.ok(text.includes(token), 'Readable text output omitted expected content.');
    }
    assert.equal(cursor, raw.length, 'Text report has trailing or substituted output sections.');
    return {
        format,
        captures: expected.length,
        captureIds: null,
        identityAttested: false,
        readableOutputAttested: true,
        bytes: bytes.length,
        sha256: sha(bytes),
        limitation:
            'Text schema omits capture IDs; count/command/output semantics do not independently prove ID membership.',
    };
}

async function actualCatalog(page: Page) {
    return page.evaluate(() => window.memoryProduct.catalog());
}
function assertCatalog(
    rows: Awaited<ReturnType<typeof actualCatalog>>,
    expected: readonly ResultsCapture[],
) {
    exactIds(
        rows.map((row) => row.id),
        expected.map((row) => row.id),
    );
    for (const wanted of expected) {
        const row = rows.find((value) => value.id === wanted.id)!;
        assert.equal(row.command, wanted.command);
        assert.equal(row.sequence, wanted.sequence);
        assert.equal(row.state, wanted.state);
        assert.equal(row.committedBytes, wanted.committedBytes);
    }
}
async function resultsView(page: Page, transport: 'serial' | 'ssh') {
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: /Connection/ })
        .click();
    await flow.getByLabel('Automation transport', { exact: true }).selectOption(transport);
    if (transport === 'ssh')
        await flow
            .getByLabel('SSH execution mode', { exact: true })
            .selectOption('independent-script');
    const view = flow.locator(
        '[aria-label="Stored ' + (transport === 'serial' ? 'Serial' : 'SSH') + ' captures"]',
    );
    await expect(view).toBeVisible();
    await expect(
        view.getByRole('button', { name: 'Refresh stored results', exact: true }),
    ).toBeEnabled();
    return view;
}
const visibleIds = (view: Locator) =>
    view
        .locator('tbody tr[data-capture-id]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-capture-id')!));
async function ready(view: Locator) {
    await expect(view.locator('.automation-results')).toHaveAttribute('aria-busy', 'false');
    await expect(
        view.getByRole('button', { name: 'Refresh stored results', exact: true }),
    ).toBeEnabled();
}
async function resetFilters(view: Locator) {
    await view.getByLabel('Search automation results', { exact: true }).fill('');
    await view.getByLabel('Result command filter', { exact: true }).fill('');
    await view.getByLabel('Result completion filter', { exact: true }).selectOption('');
    await view.getByRole('button', { name: 'Refresh stored results', exact: true }).click();
    const first = view.getByRole('button', { name: 'First page', exact: true });
    if (await first.isEnabled()) await first.click();
}
async function waitFirstPage(view: Locator, ids: readonly string[]) {
    await expect
        .poll(async () => {
            const actual = await visibleIds(view),
                next = await view
                    .getByRole('button', { name: 'Next page', exact: true })
                    .isEnabled();
            return (
                actual.length <= 20 &&
                actual.every((id, index) => id === ids[index]) &&
                (ids.length ? actual.length > 0 : actual.length === 0) &&
                (next ? actual.length < ids.length : actual.length === ids.length)
            );
        })
        .toBe(true);
    await ready(view);
}
async function boundedDownload(
    page: Page,
    view: Locator,
    format: CaptureReportFormat,
    expected: readonly ResultsCapture[],
    directory: string,
    limit: number,
    streamDownload?: ProductResultsDownload,
    browserDownloads?: { count(): number },
) {
    await view.getByLabel('Export format', { exact: true }).selectOption(format);
    if (streamDownload) {
        const extension = { markdown: 'md', text: 'txt', json: 'json', csv: 'csv' }[format];
        const result = await streamDownload(
            extension,
            () => view.getByRole('button', { name: 'Download QA results', exact: true }).click(),
            (chunks) => inspectProductResultsStream(format, chunks, expected, limit),
        );
        assert(result.bytes > 0 && result.bytes <= limit);
        await expect(
            view.getByRole('button', { name: 'Download QA results', exact: true }),
        ).toBeEnabled();
        return {
            ...result,
            path: null,
            suggestedFilename: null,
            ...(browserDownloads
                ? {
                      browserAttestation:
                          'Actual CDP begin/progress and completed owned file stream verified once.',
                  }
                : {
                      nativeAttestation:
                          'Actual trusted Save/store/export and owned file stream verified once.',
                  }),
        };
    }
    let observed: Download | undefined,
        duplicate = false;
    const listener = (file: Download) => {
        if (observed) duplicate = true;
        else observed = file;
    };
    page.on('download', listener);
    try {
        await view.getByRole('button', { name: 'Download QA results', exact: true }).click();
        await expect.poll(() => Boolean(observed)).toBe(true);
        const download = observed!;
        assert.equal(await download.failure(), null);
        const destination = path.join(
            directory,
            randomUUID() + '.' + { markdown: 'md', text: 'txt', json: 'json', csv: 'csv' }[format],
        );
        await download.saveAs(destination);
        const before = await fs.lstat(destination);
        assert.ok(
            before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= limit,
            'Actual report exceeds the explicitly bounded semantic fixture budget.',
        );
        const inspected = await inspectOwnedArtifact(
            destination,
            (chunks) => inspectProductResultsStream(format, chunks, expected, limit),
            { limit },
        );
        const result = inspected.result;
        await fs.unlink(destination);
        assert.equal(duplicate, false);
        await expect(
            view.getByRole('button', { name: 'Download QA results', exact: true }),
        ).toBeEnabled();
        return { ...result, path: destination, suggestedFilename: download.suggestedFilename() };
    } finally {
        page.off('download', listener);
    }
}
async function assertFailedDownloads(downloads: readonly Download[]) {
    for (const file of downloads)
        assert.ok(
            await file.failure(),
            'A failed/cancelled export produced an acknowledged successful file.',
        );
}

export async function exerciseProductResultsReadFault(
    page: Page,
    view: Locator,
    hook: ResultsExportReadFault,
    action: 'hold' | 'quota',
    browserDownloads?: { count(): number },
) {
    assert.ok(['service-worker', 'native-main'].includes(hook.realm));
    assert.ok(hook.quotaMessage.length > 0);
    const downloads: Download[] = [],
        listener = (file: Download) => downloads.push(file);
    page.on('download', listener);
    const browserDownloadBaseline = browserDownloads?.count();
    let armed = false;
    try {
        await hook.arm(action);
        armed = true;
        await view.getByLabel('Export format', { exact: true }).selectOption('json');
        await view.getByRole('button', { name: 'Download QA results', exact: true }).click();
        await expect.poll(async () => (await hook.status()).entered).toBe(true);
        const entered = await hook.status();
        assert.equal(entered.method, 'read');
        assert.equal(entered.action, action);
        let heldSnapshot: unknown;
        if (action === 'hold') {
            assert.equal(entered.released, false);
            await expect(
                view.getByRole('button', { name: 'Cancel export', exact: true }),
            ).toBeVisible();
            await view.getByRole('button', { name: 'Cancel export', exact: true }).click();
            await expect(
                view.getByRole('button', { name: 'Download QA results', exact: true }),
            ).toBeDisabled();
            heldSnapshot = await hook.snapshot?.();
            await hook.release();
        }
        await expect(view.getByRole('alert')).toContainText(
            action === 'hold' ? 'Export cancelled.' : hook.quotaMessage,
        );
        await expect(
            view.getByRole('button', { name: 'Download QA results', exact: true }),
        ).toBeEnabled();
        await assertFailedDownloads(downloads);
        if (browserDownloads)
            assert.equal(
                browserDownloads.count(),
                browserDownloadBaseline,
                'Failed/cancelled Results export started an actual browser download.',
            );
        return {
            action,
            actualStatus: await hook.status(),
            heldSnapshot,
            quiescentSnapshot: await hook.snapshot?.(),
            ownershipVerdict:
                'unassessed; raw probe snapshots require the primary adapter' as const,
        };
    } finally {
        page.off('download', listener);
        if (armed) {
            const state = await hook.status();
            if (state.entered && !state.released && state.action === 'hold') await hook.release();
            await hook.clear();
        }
    }
}

/** Caller provides only real produced IDs/bytes; no fixture seed or ownership fake is implemented. */
export async function exerciseProductResults(page: Page, input: ProductResultsOptions) {
    assert.ok(path.isAbsolute(input.evidenceDirectory));
    assert.ok(Number.isSafeInteger(input.maxDownloadBytes) && input.maxDownloadBytes > 0);
    assert.ok(input.catalog.length <= 500 && input.selection.length > 0);
    assert.ok(
        input.search.query.length > 0 &&
            input.search.query.length <= 256 &&
            input.search.expectedIds.length <= 20 &&
            input.search.expectedIds.length > 0,
    );
    const all = [...input.catalog].sort((a, b) => a.sequence - b.sequence),
        byId = new Map(all.map((value) => [value.id, value]));
    for (const item of input.selection) {
        assert.equal(item.transport, input.transport);
        const catalogItem = byId.get(item.id);
        assert.ok(catalogItem);
        for (const key of [
            'id',
            'sequence',
            'transport',
            'command',
            'state',
            'committedBytes',
        ] as const)
            assert.equal(catalogItem[key], item[key]);
        assert.ok(
            item.streams && item.completion !== undefined,
            'Selected semantic fixtures need independent expected stream hashes and outcome semantics.',
        );
        byId.set(item.id, item);
    }
    const scoped = all
        .filter((value) => value.transport === input.transport)
        .map((value) => byId.get(value.id)!);
    assertCatalog(await actualCatalog(page), all);
    const evolution = input.evolution
        ? assertResultsCatalogEvolution(
              all.map((value) => value.id),
              input.evolution,
          )
        : null;
    await fs.mkdir(input.evidenceDirectory, { recursive: true });
    const directory = path.join(
        await fs.realpath(input.evidenceDirectory),
        'results-' + randomUUID(),
    );
    await fs.mkdir(directory);
    let view = await resultsView(page, input.transport);
    await resetFilters(view);
    await waitFirstPage(
        view,
        scoped.map((value) => value.id),
    );
    const clearSelection = view.getByRole('button', { name: 'Clear selection', exact: true });
    if (await clearSelection.isEnabled()) await clearSelection.click();
    const selected = new Set(input.selection.map((value) => value.id)),
        pages: string[][] = [],
        selectedPages = new Set<number>();
    let previous: string[] = [];
    while (true) {
        await ready(view);
        const ids = await visibleIds(view);
        assert.ok(ids.length <= 20);
        if (pages.length) assert.notDeepEqual(ids, previous, 'Next page did not advance.');
        assert.deepEqual(
            ids,
            scoped
                .slice(pages.flat().length, pages.flat().length + ids.length)
                .map((value) => value.id),
        );
        for (const id of ids)
            if (selected.has(id)) {
                await view.locator('tr[data-capture-id="' + id + '"] input[type=checkbox]').check();
                selectedPages.add(pages.length);
            }
        pages.push(ids);
        previous = ids;
        assert.ok(pages.length <= 500, 'Actual catalog traversal did not terminate.');
        const next = view.getByRole('button', { name: 'Next page', exact: true });
        if (!(await next.isEnabled())) break;
        await next.click();
        await expect.poll(() => visibleIds(view)).not.toEqual(previous);
    }
    exactIds(
        pages.flat(),
        scoped.map((value) => value.id),
    );
    if (input.requireCrossPage) {
        assert.ok(
            pages.length > 1 && selectedPages.size > 1,
            'Produce/select actual captures on different pages; a small catalog cannot qualify pagination.',
        );
    }
    const covered = ['stored-results-bounded-pages'];
    if (selectedPages.size > 1) covered.push('stored-results-cross-page-selection');
    await view.getByLabel('Export scope', { exact: true }).selectOption('selected');
    const exports = [];
    for (const format of ['json', 'csv', 'markdown', 'text'] as const) {
        exports.push(
            await boundedDownload(
                page,
                view,
                format,
                input.selection,
                directory,
                input.maxDownloadBytes,
                input.streamDownload,
                input.browserDownloads,
            ),
        );
        covered.push('stored-results-' + format + '-download-semantics');
    }
    const searchExpected = input.search.expectedIds
        .map((id) => {
            const value = byId.get(id);
            assert.ok(value && value.transport === input.transport);
            return value;
        })
        .sort((a, b) => a.sequence - b.sequence);
    await view.getByLabel('Search automation results', { exact: true }).fill(input.search.query);
    await expect.poll(() => visibleIds(view)).toEqual(searchExpected.map((value) => value.id));
    await ready(view);
    await view.getByLabel('Export scope', { exact: true }).selectOption('filtered');
    exports.push(
        await boundedDownload(
            page,
            view,
            'json',
            searchExpected,
            directory,
            input.maxDownloadBytes,
            input.streamDownload,
            input.browserDownloads,
        ),
    );
    covered.push('stored-results-search-filtered-export');
    await resetFilters(view);
    await waitFirstPage(
        view,
        scoped.map((value) => value.id),
    );
    await view.getByLabel('Export scope', { exact: true }).selectOption('all');
    exports.push(
        await boundedDownload(
            page,
            view,
            'json',
            scoped,
            directory,
            input.maxDownloadBytes,
            input.streamDownload,
            input.browserDownloads,
        ),
    );
    covered.push('stored-results-all-export-membership');
    const faultResults: unknown[] = [];
    if (input.nativeSaveCases) faultResults.push(await input.nativeSaveCases(view));
    if (input.exportReadFault) {
        await view.getByLabel('Export scope', { exact: true }).selectOption('selected');
        for (const action of ['hold', 'quota'] as const) {
            faultResults.push(
                await exerciseProductResultsReadFault(
                    page,
                    view,
                    input.exportReadFault,
                    action,
                    input.browserDownloads,
                ),
            );
            assertCatalog(await actualCatalog(page), all);
            covered.push(
                action === 'hold'
                    ? 'stored-results-cancel-held-read'
                    : 'stored-results-read-failure-preserves-catalog',
            );
        }
    }
    await view.getByLabel('Export scope', { exact: true }).selectOption('filtered');
    await view
        .getByLabel('Search automation results', { exact: true })
        .fill('__no_results_' + randomUUID());
    await expect.poll(() => visibleIds(view)).toEqual([]);
    await ready(view);
    const refusedDownloads: Download[] = [],
        refusalListener = (file: Download) => refusedDownloads.push(file);
    page.on('download', refusalListener);
    const browserRefusalBaseline = input.browserDownloads?.count();
    let destinationGuard: { calls: number; returned: number } | undefined;
    let destinationGuardArmed = false;
    try {
        if (input.nativeEmptyExport) {
            await input.nativeEmptyExport.begin();
            destinationGuardArmed = true;
        }
        await view.getByRole('button', { name: 'Download QA results', exact: true }).click();
        await expect(view.getByRole('alert')).toContainText(
            'No stored captures match this export.',
        );
        await expect(
            view.getByRole('button', { name: 'Download QA results', exact: true }),
        ).toBeEnabled();
        await assertFailedDownloads(refusedDownloads);
        if (input.browserDownloads)
            assert.equal(
                input.browserDownloads.count(),
                browserRefusalBaseline,
                'Empty Results refusal started an actual browser download.',
            );
    } finally {
        page.off('download', refusalListener);
        if (destinationGuardArmed) destinationGuard = await input.nativeEmptyExport!.finish();
    }
    if (destinationGuard) {
        assert.equal(destinationGuard.calls, 0, 'Empty export unexpectedly requested native Save.');
        assert.equal(destinationGuard.returned, 0);
    }
    assertCatalog(await actualCatalog(page), all);
    covered.push('stored-results-empty-export-refusal');
    await resetFilters(view);
    await waitFirstPage(
        view,
        scoped.map((value) => value.id),
    );
    await view.getByRole('button', { name: 'Clear retained results', exact: true }).click();
    await expect(
        view.getByRole('group', { name: 'Confirm stored capture deletion', exact: true }),
    ).toBeVisible();
    await view.getByRole('button', { name: 'Keep captures', exact: true }).click();
    assertCatalog(await actualCatalog(page), all);
    covered.push('stored-results-clear-refusal-preserves-catalog');
    let remaining = all;
    if (input.clear !== 'none') {
        if (input.clear === 'selected') {
            await view
                .getByRole('button', { name: 'Delete selected captures', exact: true })
                .click();
            remaining = all.filter((value) => !selected.has(value.id));
        } else {
            await view.getByRole('button', { name: 'Clear retained results', exact: true }).click();
            await view
                .getByRole('button', {
                    name:
                        'Delete all stored ' +
                        (input.transport === 'serial' ? 'Serial' : 'SSH') +
                        ' captures',
                    exact: true,
                })
                .click();
            remaining = all.filter((value) => value.transport !== input.transport);
        }
        await expect
            .poll(async () => (await actualCatalog(page)).map((value) => value.id).sort())
            .toEqual(remaining.map((value) => value.id).sort());
        assertCatalog(await actualCatalog(page), remaining);
        covered.push('stored-results-clear-' + input.clear + '-exact-membership');
    }
    let reopenSnapshot: unknown;
    if (input.reopen === 'reload') {
        await page.evaluate(async () => {
            const state = window.memoryProduct.serial.snapshot();
            if (
                state.opens !== state.closes ||
                state.readerActive ||
                state.writerActive ||
                state.pumping ||
                window.memoryProduct.runnerState().busy
            )
                throw Error(
                    'Actual producers must be quiescent before replacing the Results page realm.',
                );
            window.memoryProduct.unmount();
            await window.memoryProduct.closeRepository();
        });
        await page.reload();
        await page.waitForFunction(() => Boolean(window.memoryProduct));
        reopenSnapshot = await page.evaluate(() => window.memoryProduct.serial.snapshot());
        const actual = reopenSnapshot as { opens: number; sent: number };
        assert.equal(actual.opens, 0);
        assert.equal(actual.sent, 0);
        assertCatalog(await actualCatalog(page), remaining);
        view = await resultsView(page, input.transport);
        await resetFilters(view);
        await waitFirstPage(
            view,
            remaining
                .filter((value) => value.transport === input.transport)
                .map((value) => value.id),
        );
        covered.push('stored-results-real-profile-reopen-after-page-reload');
    }
    return {
        covered,
        pages,
        exports,
        faultResults,
        evolution,
        remainingIds: remaining.map((value) => value.id),
        reopenSnapshot,
        capabilities: {
            fullOutputSearchOrigin: {
                status: 'unassessed',
                reason: 'Matched IDs and filtered export are checked; the actual producer must bind an output-only search token beyond the real preview boundary.',
            },
            exportReadFaults: input.exportReadFault
                ? {
                      status: 'exercised-actual-hook',
                      reason: 'Actual UI outcomes checked; raw owner probes still need primary assessment.',
                  }
                : {
                      status: 'unsupported',
                      reason: 'Page begin/append/seal/record hooks do not hold/fail the service-worker read generator; supply a real SW adapter.',
                  },
            serviceWorkerOwners: {
                status: 'unsupported',
                reason: 'This helper has no independently verified broker/worker/IDB ownership adapter and fills no counts with zero.',
            },
            consoleJournal: {
                status: 'unsupported',
                reason: 'Persistent-console journal has a separate catalog/report schema; current memoryProduct.catalog is the command capture repository.',
            },
            textIdentity: {
                status: 'unsupported',
                reason: 'Text schema has no capture IDs; only its command/output/count semantics are attested.',
            },
            pagination:
                selectedPages.size > 1
                    ? {
                          status: 'exercised',
                          reason: 'Actual selection identities spanned rendered pages.',
                      }
                    : { status: 'unsupported', reason: 'No actual cross-page selection occurred.' },
            memoryQualification: {
                status: 'unassessed',
                reason: 'UI/catalog semantics are not GC, backing-store, slope/policy, native-process or release qualification.',
            },
        },
    };
}
