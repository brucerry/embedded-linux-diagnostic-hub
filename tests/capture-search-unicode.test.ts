import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePreview, matchesCapture, PlainCaptureText } from '../shared/capture-query';
import { matchesConsoleCapture } from '../shared/console-query';
import {
    applyConsoleRecord,
    completeConsoleCursor,
    consoleHeader,
    newConsoleCursor,
    type ConsoleRecord,
} from '../shared/console-journal';
import { consoleSnapshot, type ConsoleArchive } from '../shared/console-storage';
import {
    CAPTURE_STORAGE,
    appendFrames,
    bytesBase64,
    frameCrc,
    newCapture,
    type CaptureFrame,
    type CaptureRepository,
    type StoredCapture,
} from '../shared/capture-store';

function memoryArchive(parts: Uint8Array[]) {
    const at = '2026-10-29T00:00:00.000Z',
        header = consoleHeader({
            schema: 2,
            id: '00000000-0000-4000-8000-000000000001',
            flowId: 'crlf-projection-fixture',
            startedAt: at,
            receiveTimeSource: 'local-client',
            target: { endpoint: 'in-memory journal' },
            ready: { role: 'shell-prompt', literals: ['fixture#'] },
        }),
        encoder = new TextEncoder(),
        cursor = newConsoleCursor(),
        records: ConsoleRecord[] = [];
    const add = (record: ConsoleRecord) => records.push(applyConsoleRecord(cursor, record, header));
    add({
        schema: 2,
        kind: 'segment-start',
        sequence: 0,
        index: 0,
        at,
        segment: { kind: 'context', phase: 'startup' },
    });
    for (const [observation, bytes] of parts.entries()) {
        assert.ok(bytes.length <= CAPTURE_STORAGE.frameBytes);
        add({
            schema: 2,
            kind: 'observation',
            sequence: records.length,
            index: 0,
            observation,
            stream: 'pty',
            origin: 'channel',
            receivedAt: at,
            offset: 0,
            totalBytes: bytes.length,
            base64: bytesBase64(bytes),
            crc32: frameCrc(bytes),
        });
    }
    add({
        schema: 2,
        kind: 'segment-end',
        sequence: records.length,
        index: 0,
        at,
        reason: 'ready',
        match: { role: 'shell-prompt', literal: 'fixture#' },
    });
    add({
        schema: 2,
        kind: 'segment-start',
        sequence: records.length,
        index: 1,
        at,
        segment: { kind: 'context', phase: 'shutdown' },
    });
    add({
        schema: 2,
        kind: 'segment-end',
        sequence: records.length,
        index: 1,
        at,
        reason: 'closed',
        match: null,
    });
    completeConsoleCursor(cursor);
    const meta = consoleSnapshot({
        schema: 2,
        header,
        state: 'complete',
        offset: records.reduce(
            (sum, record) => sum + encoder.encode(JSON.stringify(record) + '\n').length,
            0,
        ),
        records: cursor.records,
        bytes: cursor.bytes,
        observations: cursor.observations,
        segments: cursor.segments,
        finalizedAt: at,
        reason: 'complete',
        observedBytes: cursor.bytes,
        failure: null,
        shellClosed: true,
    });
    assert.equal(records.length, parts.length + 4);
    assert.equal(meta.observations, parts.length);
    assert.equal(meta.segments, 2);
    assert.ok(meta.offset < 1048576 && meta.bytes < 131072);
    let pins = 0,
        readers = 0;
    const archive: ConsoleArchive = {
        async pin() {
            pins++;
            let released = false;
            return {
                async release() {
                    assert.equal(released, false);
                    released = true;
                    pins--;
                },
            };
        },
        async list(after, limit = 25) {
            assert.ok(limit >= 1 && limit <= 50);
            return {
                captures: !after || after < header.id ? [structuredClone(meta)] : [],
                next: null,
                mode: 'scan',
            };
        },
        async *read(id) {
            assert.equal(id, header.id);
            readers++;
            try {
                yield { kind: 'metadata', capture: structuredClone(meta) };
                for (const record of records)
                    yield { kind: 'record', record: structuredClone(record) };
            } finally {
                readers--;
            }
        },
        async delete() {
            throw Error('This fixture never deletes evidence.');
        },
    };
    return { archive, meta, records, parts, counts: () => ({ pins, readers }) };
}

function memoryCapture(parts: Uint8Array[], streams: CaptureFrame['stream'][] = []) {
    const at = '2026-10-29T00:00:00.000Z';
    const frames: CaptureFrame[] = parts.map((bytes, observation) => ({
        bytes,
        observation,
        stream: streams[observation] ?? 'stdout',
        receivedAt: at,
        offset: 0,
        totalBytes: bytes.length,
        crc32: frameCrc(bytes),
    }));
    const capture: StoredCapture = {
        ...appendFrames(
            newCapture('00000000-0000-4000-8000-000000000002', 1, {
                transport: 'ssh',
                receiveTimeSource: 'gateway',
                runId: 'fixture',
                stepId: 'fixture',
                name: 'memory',
                command: 'fixture',
                startedAt: at,
            }),
            frames,
        ),
        state: 'complete',
        reason: 'fixture',
        observedBytes: parts.reduce((n, p) => n + p.length, 0),
        finalizedAt: at,
    };
    let readers = 0;
    const unexpected = async (): Promise<never> => {
        throw Error('No IO beyond synthetic reads.');
    };
    const store: CaptureRepository = {
        begin: unexpected,
        append: unexpected,
        seal: unexpected,
        fail: unexpected,
        page: unexpected,
        delete: unexpected,
        close: unexpected,
        pin: unexpected,
        async *read(id) {
            assert.equal(id, capture.id);
            readers++;
            try {
                for (const frame of frames) yield { type: 'frame', frame };
            } finally {
                readers--;
            }
        },
    };
    return { store, capture, frames, readers: () => readers };
}
const encoder = new TextEncoder();
async function matchBoth(parts: Uint8Array[], query: string) {
    // Empty decoder output is valid; zero-byte stored frames are not.
    const frames = parts.filter((part) => part.length);
    const f = memoryCapture(frames),
        journal = memoryArchive(frames),
        before = structuredClone({ frames: f.frames, records: journal.records });
    const result = [
        await matchesCapture(f.store, f.capture, { filter: { query } }),
        await matchesConsoleCapture(journal.archive, journal.meta, { query }),
    ];
    assert.equal(f.readers(), 0);
    assert.deepEqual(journal.counts(), { readers: 0, pins: 0 });
    assert.deepEqual({ frames: f.frames, records: journal.records }, before);
    return result;
}

import { CaptureTextSearch } from '../shared/capture-search';

test('actual capture and console search agree with whole projected lowercase at every byte split', async () => {
    for (const [raw, queries] of [
        ['ΟΣ', ['ος', 'οσ', 'ς', 'σ']],
        ['AΣB', ['aσb', 'aς', 'ς', 'σ']],
        ['AΣ\u0301B', ['aσ\u0301b', 'aς', 'ς']],
        ['AΣ\u0301', ['aς\u0301', 'aσ', 'σ']],
        ['İ𐐀É', ['i\u0307𐐨é', 'i𐐨é', 'é']],
        ['HeLLo\x1b[31mA\x1b[0m\r\nB', ['helloa\nb', 'a\n\nb', 'HELLO']],
    ] as const) {
        const bytes = encoder.encode(raw),
            plain = new PlainCaptureText().append(raw);
        for (let i = 0; i <= bytes.length; i++)
            for (const query of queries) {
                const expected = plain.toLowerCase().includes(query.toLowerCase());
                assert.deepEqual(
                    await matchBoth(
                        [bytes.subarray(0, i), new Uint8Array(), bytes.subarray(i)],
                        query,
                    ),
                    [expected, expected],
                    `${JSON.stringify(raw)} query=${query} split=${i}`,
                );
            }
    }
});
test('stream matcher preserves literal/default lowercase semantics without case folding or normalization', () => {
    const alphabet = ['A', 'Σ', 'σ', 'ς', '\u0301', '\u0345', "'", '.', ' ', 'İ', '𐐀', 'é'];
    const queries = ['aς', 'aσ', 'σ', 'ς', 'i\u0307', '𐐨', 'e\u0301', 'é', '.*', 'ss'];
    // All 3-code-point combinations, including Cased + Case_Ignorable overlap.
    for (const a of alphabet)
        for (const b of alphabet)
            for (const c of alphabet) {
                const raw = a + b + c;
                for (const query of queries) {
                    const search = new CaptureTextSearch(query);
                    for (const part of [a, '', b, c]) search.append(part);
                    assert.equal(
                        search.finish(),
                        raw.toLowerCase().includes(query.toLowerCase()),
                        `${JSON.stringify(raw)} / ${query}`,
                    );
                }
            }
    for (const [raw, query, expected] of [
        ['Straße', 'STRASSE', false],
        ['é', 'e\u0301', false],
        ['abc', '.*', false],
    ] as const) {
        const search = new CaptureTextSearch(query);
        search.append(raw);
        assert.equal(search.finish(), expected);
    }
});
test('sigma candidate is not published before following text or EOF proves it', () => {
    const final = new CaptureTextSearch('ς');
    assert.equal(final.append('AΣ'), false);
    assert.equal(final.append(''), false);
    assert.equal(final.append('B'), false);
    assert.equal(final.finish(), false);
    const middle = new CaptureTextSearch('σ');
    assert.equal(middle.append('AΣ'), false);
    assert.equal(middle.append('B'), true);
    const end = new CaptureTextSearch('ς');
    assert.equal(end.append('AΣ'), false);
    assert.equal(end.finish(), true);
});
test('arbitrarily extended ignorable context retains only query-sized state', () => {
    for (const query of ['ς', 'aς', 'σ', 'x'.repeat(256)]) {
        const search = new CaptureTextSearch(query);
        search.append('AΣ');
        for (let i = 0; i < 64; i++) search.append('\u0301'.repeat(1024));
        assert.ok(
            JSON.stringify(search).length < 2048,
            'Matcher must not retain streamed ignorable text.',
        );
        const expected = ('AΣ' + '\u0301'.repeat(65536))
            .toLowerCase()
            .includes(query.toLowerCase());
        assert.equal(search.finish(), expected);
    }
});
test('capture streams cannot supply each other sigma context or substring prefixes', async () => {
    const f = memoryCapture([encoder.encode('AΣ'), encoder.encode('B')], ['stdout', 'stderr']);
    assert.equal(await matchesCapture(f.store, f.capture, { filter: { query: 'aς' } }), true);
    assert.equal(await matchesCapture(f.store, f.capture, { filter: { query: 'aσb' } }), false);
    assert.equal(f.readers(), 0);
});
test('cancellation and read errors preserve original failures and close owned iterators', async () => {
    const f = memoryCapture([encoder.encode('AΣ'), encoder.encode('B')]),
        controller = new AbortController();
    const original = f.store.read.bind(f.store);
    let open = 0;
    f.store.read = async function* (id) {
        open++;
        try {
            for await (const event of original(id)) {
                yield event;
                controller.abort();
            }
        } finally {
            open--;
        }
    };
    await assert.rejects(
        matchesCapture(f.store, f.capture, { filter: { query: 'ς' } }, controller.signal),
        /Catalog request cancelled/,
    );
    assert.equal(open, 0);
    assert.equal(f.readers(), 0);
    const failure = new Error('original read failure');
    f.store.read = async function* () {
        throw failure;
    };
    await assert.rejects(
        matchesCapture(f.store, f.capture, { filter: { query: 'ς' } }),
        (error) => error === failure,
    );
});
