import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePreview, matchesCapture, PlainCaptureText } from '../shared/capture-query';
import { streamConsoleReport } from '../shared/console-report';
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

function project(parts: string[]) {
    const plain = new PlainCaptureText();
    return parts.map((part) => plain.append(part)).join('');
}

test('readable CRLF projection is independent of append boundaries', () => {
    const raw = 'first\r\nsecond\r\n';
    for (let split = 0; split <= raw.length; split++)
        assert.equal(project([raw.slice(0, split), '', raw.slice(split)]), 'first\nsecond\n');
    assert.equal(project([...raw]), 'first\nsecond\n');
});

test('readable projection preserves lone CR, lone LF and intentional blank lines', () => {
    assert.equal(project(['a\rb\nc\r\n\r\nd']), 'a\nb\nc\n\nd');
    assert.equal(project(['\r', '\r', '\n', '\n', '\r', 'Z\n\n']), '\n\n\n\nZ\n\n');
    assert.equal(project(['end\r', '']), 'end\n');
});

test('controls interrupt raw CRLF adjacency without changing escape parser behavior', () => {
    const cases: [string[], string][] = [
        [['A\r', '\b', '\nB'], 'A\n\nB'],
        [['A\bB'], 'AB'],
        [['A\r', '\x1b[', '31m', '\nB'], 'A\n\nB'],
        [['A\r', '\x9b31m', '\nB'], 'A\n\nB'],
        [['A\r', '\x9dhidden\x9c', '\nB'], 'A\n\nB'],
        [['A\x1b]52;c;hidden\r', '\n', '\x07B'], 'AB'],
        [['A\x1b[3', '\r', '1m\nB'], 'A\nB'],
        [['A\x1bP', 'hidden\r\n', '\x1b', '\\B'], 'AB'],
        [['A\x1b', '\r', '\nB'], 'A\nB'],
    ];
    for (const [parts, expected] of cases) assert.equal(project(parts), expected);
});

test('CRLF state stays instance local and survives empty split UTF-8 decoder output', () => {
    const first = new PlainCaptureText(),
        second = new PlainCaptureText(),
        decoder = new TextDecoder();
    assert.equal(first.append('A\r'), 'A\n');
    assert.equal(second.append('\nB'), '\nB');
    assert.equal(first.append(''), '');
    assert.equal(first.append('\nC'), 'C');
    assert.equal(first.append(decoder.decode(new Uint8Array([0xe2]), { stream: true })), '');
    assert.equal(
        first.append(decoder.decode(new Uint8Array([0x82, 0xac, 13]), { stream: true })),
        '€\n',
    );
    assert.equal(first.append(decoder.decode(new Uint8Array([10]), { stream: true })), '');
    assert.equal(first.append(decoder.decode()), '');
});

/** One immutable, schema-validated journal; no disk, native service, timers or cleanup hooks. */
function memoryArchive() {
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
        parts = [
            encoder.encode('A\r'),
            encoder.encode('\nB\r\n\r\n'),
            new Uint8Array([0xe2]),
            new Uint8Array([0x82, 0xac, 13]),
            encoder.encode('\nC\x1b[31m\r\n'),
            encoder.encode('tail\r\nfixture#'),
        ],
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
    assert.equal(records.length, 10);
    assert.equal(meta.observations, 6);
    assert.equal(meta.segments, 2);
    assert.ok(meta.offset < 8192 && meta.bytes < 128);
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

async function collect(source: AsyncIterable<Uint8Array>) {
    const decoder = new TextDecoder();
    let result = '';
    for await (const part of source) {
        assert.ok(part.length <= CAPTURE_STORAGE.frameBytes);
        result += decoder.decode(part, { stream: true });
        assert.ok(result.length < 32768);
    }
    return result + decoder.decode();
}

test('actual console reports and search normalize CRLF while canonical JSON and base64 stay exact', async () => {
    const f = memoryArchive(),
        before = structuredClone({ meta: f.meta, records: f.records }),
        expected = 'A\nB\n\n€\nC\ntail\nfixture#';
    for (const format of ['markdown', 'text', 'json'] as const) {
        const output = await collect(
            streamConsoleReport(f.archive, format, { ids: [f.meta.header.id] }),
        );
        let restored: ConsoleRecord[];
        if (format === 'json') {
            const json = JSON.parse(output);
            assert.deepEqual(json.captures[0].capture, f.meta);
            restored = json.captures[0].records;
        } else {
            restored = [
                ...output.matchAll(/Canonical record JSON base64: ([A-Za-z0-9+/=]+)/g),
            ].map((match) => JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')));
            if (format === 'text') {
                const readable = [...output.matchAll(/^Readable PTY: (.+)$/gm)]
                    .map((match) => JSON.parse(match[1]))
                    .join('');
                assert.equal(readable, expected);
            } else {
                assert.deepEqual(output.match(/^>.*$/gm), [
                    '> A',
                    '> ',
                    '> B',
                    '> ',
                    '> ',
                    '> €',
                    '> ',
                    '> C',
                    '> ',
                    '> tail',
                    '> fixture\\#',
                ]);
            }
            assert.ok(!output.includes('\x1b'));
        }
        assert.deepEqual(restored, f.records);
        const raw = restored
            .filter((record) => record.kind === 'observation')
            .map((record) => Buffer.from(record.base64, 'base64'));
        assert.deepEqual(Buffer.concat(raw), Buffer.concat(f.parts));
        assert.deepEqual({ meta: f.meta, records: f.records }, before);
        assert.deepEqual(f.counts(), { pins: 0, readers: 0 });
    }
    assert.equal(await matchesConsoleCapture(f.archive, f.meta, { query: 'A\nB' }), true);
    assert.equal(await matchesConsoleCapture(f.archive, f.meta, { query: 'A\n\nB' }), false);
    assert.deepEqual(f.counts(), { pins: 0, readers: 0 });
});

test('actual capture preview and search keep per-stream CRLF state and raw-byte clipping', async () => {
    const at = '2026-10-29T00:00:00.000Z',
        encoder = new TextEncoder();
    for (const clipped of [false, true]) {
        const parts: [CaptureFrame['stream'], string][] = [
            ['stdout', 'out\r'],
            ['stderr', '\nerr\r'],
            ['stdout', '\nnext'],
            ['stderr', '\nend'],
            ...(clipped
                ? [
                      ['stdout', 'x'.repeat(CAPTURE_STORAGE.previewBytes) + 'hidden-tail'] as [
                          CaptureFrame['stream'],
                          string,
                      ],
                  ]
                : []),
        ];
        const frames: CaptureFrame[] = parts.map(([stream, text], observation) => {
            const bytes = encoder.encode(text);
            return {
                stream,
                observation,
                receivedAt: at,
                offset: 0,
                totalBytes: bytes.length,
                bytes,
                crc32: frameCrc(bytes),
            };
        });
        const active = newCapture('00000000-0000-4000-8000-000000000002', 1, {
            transport: 'ssh',
            receiveTimeSource: 'gateway',
            runId: 'secondary-consumer-fixture',
            stepId: 'one',
            name: 'Memory capture',
            command: 'fixture command',
            startedAt: at,
        });
        const committed = appendFrames(active, frames),
            capture: StoredCapture = {
                ...committed,
                state: 'complete',
                observedBytes: committed.committedBytes,
                reason: 'fixture complete',
                finalizedAt: at,
            },
            before = structuredClone({ capture, frames });
        let readers = 0;
        const unexpected = async (): Promise<never> => {
            throw Error('Only in-memory reads are expected.');
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
                    yield { type: 'metadata', capture: structuredClone(capture) };
                    for (const frame of frames)
                        yield { type: 'frame', frame: structuredClone(frame) };
                } finally {
                    readers--;
                }
            },
        };
        const preview = await capturePreview(store, capture);
        const firstFourBytes = frames.slice(0, 4).reduce((sum, frame) => sum + frame.bytes.length, 0);
        assert.deepEqual(preview, {
            stdout:
                'out\nnext' +
                (clipped ? 'x'.repeat(CAPTURE_STORAGE.previewBytes - firstFourBytes) : ''),
            stderr: '\nerr\nend',
            previewClipped: clipped,
        });
        assert.ok(!preview.stdout.includes('hidden-tail'));
        for (const [query, expected] of [
            ['out\nnext', true],
            ['\nerr\nend', true],
            ['out\n\nnext', false],
            ['hidden-tail', clipped],
        ] as const) {
            assert.equal(await matchesCapture(store, capture, { filter: { query } }), expected);
            assert.equal(readers, 0);
        }
        assert.deepEqual({ capture, frames }, before);
        assert.equal(readers, 0);
    }
});
