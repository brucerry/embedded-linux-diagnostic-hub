/** Browser-safe read-only reducer. Never opens, writes, seeds or closes a producer repository. */
import { base64Bytes, validId } from '../../shared/capture-store';
import {
    applyConsoleRecord,
    completeConsoleCursor,
    newConsoleCursor,
    type ConsoleRecord,
    type ConsoleSegment,
    type ConsoleSnapshot,
} from '../../shared/console-journal';
import {
    consoleSnapshot,
    type ConsoleRead,
    type ConsoleArchive,
} from '../../shared/console-storage';

function requireValue(ok: unknown, message: string): asserts ok {
    if (!ok) throw Error(message);
}
const table = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
/** Incremental CRC32 over actual ordered raw bytes, independent of frame partitioning. Not a cryptographic hash. */
export function consoleRawCrc() {
    let value = 0xffffffff,
        bytes = 0;
    return {
        add(input: Uint8Array) {
            for (const byte of input) value = table[(value ^ byte) & 255] ^ (value >>> 8);
            bytes += input.length;
            if (!Number.isSafeInteger(bytes))
                throw Error('Console byte counter exceeded safe integer.');
        },
        summary() {
            return { bytes, crc32: ((value ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0') };
        },
    };
}
type EndRecord = Extract<ConsoleRecord, { kind: 'segment-end' }>;
type OutcomeRecord = Extract<ConsoleRecord, { kind: 'outcome' }>;
type PreparationRecord = Extract<ConsoleRecord, { kind: 'preparation' }>;
type PreparationEnd = Extract<ConsoleRecord, { kind: 'preparation-end' }>;
export interface ConsoleSegmentSummary {
    index: number;
    sequence: number;
    segment: ConsoleSegment;
    inputSent: Extract<ConsoleRecord, { kind: 'segment-start' }>['inputSent'] | null;
    endedBy:
        | EndRecord
        | { kind: 'input-sent-boundary'; sequence: number; nextIndex: number; preparation: number }
        | null;
    outcome: OutcomeRecord | null;
    raw: { bytes: number; crc32: string };
}
export interface ConsoleJournalSummary {
    schema: 2;
    mode: 'console';
    capture: ConsoleSnapshot;
    replay: {
        verified: true;
        records: number;
        offset: number;
        observations: number;
        segments: number;
        complete: boolean;
    };
    raw: {
        stream: 'pty';
        bytes: number;
        crc32: string;
        origins: Record<'channel' | 'extended', { bytes: number; crc32: string }>;
    };
    segments: readonly ConsoleSegmentSummary[];
    preparations: readonly { record: PreparationRecord; discarded: PreparationEnd | null }[];
    metadataRows: number;
    readScope: 'one incremental real archive read; no raw output retained';
}
export interface ConsoleReadLimits {
    maxMetadataRows: number;
}
export interface ConsoleCatalogSummary {
    schema: 2;
    mode: 'console';
    captures: readonly ConsoleSnapshot[];
    pages: readonly { rows: number; mode: 'scan' | 'indexed' }[];
}
/** UUID cursor order, not command sequence/time order. Caller owns its separate archive view. */
export async function catalogConsoleArchive(
    archive: ConsoleArchive,
    maxCatalogRows: number,
): Promise<ConsoleCatalogSummary> {
    requireValue(
        Number.isSafeInteger(maxCatalogRows) && maxCatalogRows > 0,
        'Supply an explicit console catalog fixture bound.',
    );
    const captures: ConsoleSnapshot[] = [],
        pages: { rows: number; mode: 'scan' | 'indexed' }[] = [];
    let after: string | undefined;
    while (true) {
        const page = await archive.list(after, 25);
        requireValue(
            page.captures.length <= 25 && ['scan', 'indexed'].includes(page.mode),
            'Actual console catalog page/protocol changed.',
        );
        let previous = after;
        for (const raw of page.captures) {
            const capture = consoleSnapshot(raw);
            requireValue(
                previous === undefined || capture.header.id > previous,
                'Console UUID catalog is duplicated or reordered.',
            );
            previous = capture.header.id;
            captures.push(capture);
            requireValue(
                captures.length <= maxCatalogRows,
                'Actual console catalog exceeds its explicit fixture budget; no rows clipped.',
            );
        }
        pages.push({ rows: page.captures.length, mode: page.mode });
        if (page.next === null) break;
        validId(page.next);
        requireValue(
            page.captures.length > 0 && page.next === previous && page.next !== after,
            'Console catalog cursor did not advance exactly.',
        );
        after = page.next;
    }
    return { schema: 2, mode: 'console', captures, pages };
}

/** Caller supplies archive.read(id); for-await joins natural completion/iterator return on failure. */
export async function summarizeConsoleRead(
    id: string,
    source: AsyncIterable<ConsoleRead>,
    limits: ConsoleReadLimits,
): Promise<ConsoleJournalSummary> {
    validId(id);
    requireValue(
        Number.isSafeInteger(limits.maxMetadataRows) && limits.maxMetadataRows > 0,
        'Supply an explicit metadata-only semantic fixture bound.',
    );
    const cursor = newConsoleCursor(),
        all = consoleRawCrc(),
        channel = consoleRawCrc(),
        extended = consoleRawCrc();
    const segments = new Map<
        number,
        { value: Omit<ConsoleSegmentSummary, 'raw'>; raw: ReturnType<typeof consoleRawCrc> }
    >();
    const preparations = new Map<
        number,
        { record: PreparationRecord; discarded: PreparationEnd | null }
    >();
    let capture: ConsoleSnapshot | undefined,
        offset = 0,
        metadataRows = 0;
    const encoder = new TextEncoder();
    for await (const event of source) {
        if (event.kind === 'metadata') {
            requireValue(!capture, 'Duplicate console read metadata.');
            capture = consoleSnapshot(event.capture);
            requireValue(
                capture.header.id === id,
                'Console read returned another capture identity.',
            );
            continue;
        }
        requireValue(
            event.kind === 'record' && capture,
            'Console read record precedes its actual schema2 metadata.',
        );
        const pendingPreparation = cursor.preparing?.sequence;
        const record = applyConsoleRecord(cursor, event.record, capture.header);
        offset += encoder.encode(JSON.stringify(record) + '\n').length;
        requireValue(Number.isSafeInteger(offset), 'Console JSONL byte counter overflow.');
        if (record.kind !== 'observation') {
            metadataRows++;
            requireValue(
                metadataRows <= limits.maxMetadataRows,
                'Console metadata exceeds the explicit semantic fixture budget; nothing was clipped.',
            );
        }
        if (record.kind === 'preparation')
            preparations.set(record.sequence, { record, discarded: null });
        else if (record.kind === 'preparation-end') {
            requireValue(
                pendingPreparation !== undefined && preparations.has(pendingPreparation),
                'Missing durable console preparation.',
            );
            preparations.get(pendingPreparation)!.discarded = record;
        } else if (record.kind === 'segment-start') {
            if (record.inputSent) {
                const idle = segments.get(record.inputSent.contextIndex);
                requireValue(
                    idle &&
                        idle.value.segment.kind === 'context' &&
                        idle.value.segment.phase === 'idle',
                    'Missing actual idle input-dispatch boundary.',
                );
                idle.value.endedBy = {
                    kind: 'input-sent-boundary',
                    sequence: record.sequence,
                    nextIndex: record.index,
                    preparation: record.inputSent.preparation,
                };
            }
            segments.set(record.index, {
                value: {
                    index: record.index,
                    sequence: record.sequence,
                    segment: record.segment,
                    inputSent: record.inputSent ?? null,
                    endedBy: null,
                    outcome: null,
                },
                raw: consoleRawCrc(),
            });
        } else if (record.kind === 'observation') {
            const segment = segments.get(record.index);
            requireValue(segment, 'Raw console observation has no actual segment.');
            const bytes = base64Bytes(record.base64);
            all.add(bytes);
            (record.origin === 'channel' ? channel : extended).add(bytes);
            segment.raw.add(bytes);
        } else if (record.kind === 'segment-end') {
            const segment = segments.get(record.index);
            requireValue(segment, 'Console end lost its segment.');
            segment.value.endedBy = record;
        } else if (record.kind === 'outcome') {
            const segment = segments.get(record.index);
            requireValue(segment, 'Console outcome lost its segment.');
            segment.value.outcome = record;
        }
    }
    requireValue(capture, 'Actual console read returned no metadata.');
    for (const key of ['records', 'bytes', 'observations', 'segments'] as const)
        requireValue(
            cursor[key] === capture[key],
            'Console replay metadata counter differs: ' + key,
        );
    requireValue(
        !cursor.pendingObservation && offset === capture.offset,
        'Console replay raw boundary/JSONL offset differs.',
    );
    if (capture.state === 'complete') completeConsoleCursor(cursor);
    const raw = all.summary();
    requireValue(raw.bytes === capture.bytes, 'Console raw replay byte count differs.');
    return {
        schema: 2,
        mode: 'console',
        capture,
        replay: {
            verified: true,
            records: cursor.records,
            offset,
            observations: cursor.observations,
            segments: cursor.segments,
            complete: capture.state === 'complete',
        },
        raw: {
            stream: 'pty',
            ...raw,
            origins: { channel: channel.summary(), extended: extended.summary() },
        },
        segments: [...segments.values()].map((entry) => ({
            ...entry.value,
            raw: entry.raw.summary(),
        })),
        preparations: [...preparations.values()],
        metadataRows,
        readScope: 'one incremental real archive read; no raw output retained',
    };
}
