import test from 'node:test';
import assert from 'node:assert/strict';
import { streamConsoleReport } from '../shared/console-report';
import { streamConsoleReport as beforeMarkdown } from './fixtures/console-report-before-markdown';
import {
    applyConsoleRecord,
    completeConsoleCursor,
    consoleHeader,
    newConsoleCursor,
    type ConsoleRecord,
    type ConsoleSegment,
} from '../shared/console-journal';
import { consoleSnapshot, type ConsoleArchive } from '../shared/console-storage';
import { base64Bytes, bytesBase64, CAPTURE_STORAGE, frameCrc } from '../shared/capture-store';

const at = '2026-10-30T00:00:00.000Z';
const prompt = { role: 'shell-prompt' as const, literal: 'fixture#' };
const criterion = { role: 'shell-prompt' as const, literals: ['fixture#'] };

/** Immutable public-schema fixture: no native store, timers, globals, disk or cleanup hooks. */
function fixture(options: { hostile?: boolean; incomplete?: boolean } = {}) {
    const header = consoleHeader({
        schema: 2,
        id: '00000000-0000-4000-8000-000000000061',
        flowId: 'markdown-presentation-fixture',
        startedAt: at,
        receiveTimeSource: 'local-client',
        target: {
            endpoint: options.hostile ? 'fixture | <img> ## injected' : 'synthetic memory console',
        },
        ready: criterion,
    });
    const cursor = newConsoleCursor(),
        records: ConsoleRecord[] = [],
        encoder = new TextEncoder();
    const append = (value: Record<string, unknown>) =>
        records.push(
            applyConsoleRecord(cursor, { schema: 2, sequence: cursor.records, ...value }, header),
        );
    const context = (phase: 'startup' | 'idle' | 'shutdown') => {
        const index = cursor.segments;
        append({ kind: 'segment-start', index, at, segment: { kind: 'context', phase } });
        return index;
    };
    const observe = (index: number, value: string) => {
        const bytes = encoder.encode(value);
        assert.ok(bytes.length > 0 && bytes.length <= CAPTURE_STORAGE.frameBytes);
        append({
            kind: 'observation', index, observation: cursor.observations, stream: 'pty',
            origin: 'channel', receivedAt: at, offset: 0, totalBytes: bytes.length,
            base64: bytesBase64(bytes), crc32: frameCrc(bytes),
        });
    };
    const end = (
        index: number,
        reason: 'ready' | 'idle-boundary' | 'closed' | 'prompt-observed',
    ) => append({
        kind: 'segment-end', index, at, reason,
        match: reason === 'ready' || reason === 'prompt-observed' ? prompt : null,
    });
    const startup = context('startup');
    observe(startup, 'fixture#');
    end(startup, 'ready');
    const command = options.hostile
        ? 'printf "pipes | text"\n~~~\n```\n<script>literal command text</script>'
        : 'pwd';
    for (let ordinal = 1; ordinal <= (options.incomplete ? 1 : 2); ordinal++) {
        const idle = context('idle'),
            index = cursor.segments,
            script = ordinal === 1 ? command : '',
            segment: Extract<ConsoleSegment, { kind: 'command' }> = {
                kind: 'command', runId: 'memory-run', stepId: 'step-' + ordinal, ordinal,
                name: options.hostile ? 'Inspect | **name** <img> ## injected' : ordinal === 1 ? 'Inspect' : 'Enter',
                input: { intent: ordinal === 1 ? 'script' : 'send-enter', command: script },
                requestBase64: bytesBase64(encoder.encode(script + '\r')), criterion,
            },
            preparation = cursor.records;
        append({ kind: 'preparation', index, at, segment });
        if (options.incomplete) break;
        append({
            kind: 'segment-start', index, at, segment,
            inputSent: { preparation, contextIndex: idle, disposition: 'write-dispatched' },
        });
        observe(index, options.hostile
            ? 'literal | output\n~~~~~\n```\n<img>\x1b]52;c;hidden-clipboard\x07\r\nfixture#'
            : ordinal === 1 ? '/tmp\r\nfixture#' : 'fixture#');
        end(index, 'prompt-observed');
        append({ kind: 'outcome', index, at, completion: 'prompt-observed', exitCode: null, match: prompt });
    }
    if (!options.incomplete) {
        const shutdown = context('shutdown');
        observe(shutdown, 'bye');
        end(shutdown, 'closed');
        completeConsoleCursor(cursor);
    }
    const meta = consoleSnapshot({
        schema: 2, header, state: options.incomplete ? 'incomplete' : 'complete',
        offset: records.reduce((sum, record) => sum + encoder.encode(JSON.stringify(record) + '\n').length, 0),
        records: cursor.records, bytes: cursor.bytes, observations: cursor.observations, segments: cursor.segments,
        finalizedAt: at, reason: options.incomplete ? 'interrupted | notes\n## injected' : 'complete',
        observedBytes: options.incomplete ? null : cursor.bytes,
        failure: options.incomplete ? { code: 'io', message: 'Synthetic interrupted preparation' } : null,
        shellClosed: !options.incomplete,
    });
    assert.ok(records.length <= 24 && meta.bytes < 2048 && meta.offset < 32768);
    const original = JSON.stringify({ meta, records });
    let pins = 0, releases = 0, readers = 0, reads = 0, lists = 0;
    const archive: ConsoleArchive = {
        async pin() {
            assert.equal(pins, 0);
            pins++;
            let released = false;
            return { async release() {
                assert.equal(released, false);
                released = true; pins--; releases++;
            } };
        },
        async list(after, limit = 25) {
            assert.equal(pins, 1);
            assert.equal(after, undefined);
            assert.equal(limit, 25);
            assert.ok(++lists <= 1);
            return { captures: [structuredClone(meta)], next: null, mode: 'scan' };
        },
        async *read(id) {
            assert.equal(pins, 1);
            assert.equal(id, header.id);
            assert.ok(++reads <= 1);
            readers++;
            try {
                yield { kind: 'metadata', capture: structuredClone(meta) };
                for (const record of records) yield { kind: 'record', record: structuredClone(record) };
            } finally { readers--; }
        },
        async delete() { assert.fail('Unexpected deletion'); },
    };
    return {
        archive, meta, records, command,
        assertReleased() {
            assert.deepEqual({ pins, releases, readers, reads, lists }, { pins: 0, releases: 1, readers: 0, reads: 1, lists: 1 });
            assert.equal(JSON.stringify({ meta, records }), original);
        },
    };
}

async function collect(source: AsyncIterable<Uint8Array>) {
    const decoder = new TextDecoder();
    let result = '', chunks = 0;
    for await (const part of source) {
        assert.ok(++chunks <= 256 && part.length <= CAPTURE_STORAGE.frameBytes);
        result += decoder.decode(part, { stream: true });
        assert.ok(result.length <= 131072);
    }
    return result + decoder.decode();
}
function canonical(report: string) {
    const decode = (value: string) => JSON.parse(new TextDecoder().decode(base64Bytes(value)));
    return {
        metadata: [...report.matchAll(/Canonical metadata JSON base64: ([A-Za-z0-9+/=]+)/g)].map((m) => decode(m[1])),
        records: [...report.matchAll(/Canonical record JSON base64: ([A-Za-z0-9+/=]+)/g)].map((m) => decode(m[1])),
    };
}
function inspectMarkdown(report: string) {
    const outside: string[] = [], fences: string[] = [];
    let delimiter = '', body: string[] = [];
    for (const line of report.split('\n')) {
        if (!delimiter && /^~{3,}text$/.test(line)) { delimiter = line.slice(0, -4); body = []; }
        else if (delimiter && line === delimiter) { fences.push(body.join('\n')); delimiter = ''; }
        else if (delimiter) body.push(line);
        else outside.push(line);
    }
    assert.equal(delimiter, '', 'Every requested-input fence closes');
    for (const line of outside.filter((s) => s.startsWith('|'))) {
        let pipes = 0, backslashes = 0;
        for (const c of line) {
            if (c === '|' && backslashes % 2 === 0) pipes++;
            backslashes = c === '\\' ? backslashes + 1 : 0;
        }
        assert.equal(pipes, 3, 'Metadata table stays two columns');
    }
    return { outside: outside.join('\n'), fences };
}

test('console Markdown has rich flow metadata, Script/Enter/context sections and exact canonical records', async (t) => {
    const f = fixture();
    let progress = 0;
    const report = await collect(streamConsoleReport(f.archive, 'markdown', {}, async () => { progress++; }));
    f.assertReleased();
    assert.ok(progress > f.records.length);
    assert.match(report, /^# ⌨️ Console results\n/);
    assert.match(report, /\| Field \| Recorded value \|/);
    assert.match(report, /\| Shell closure \| Confirmed \|/);
    assert.match(report, /✅ means a complete retained capture, not command success/);
    assert.match(report, /### 🧩 Context · startup/);
    assert.match(report, /### 🧩 Context · idle/);
    assert.match(report, /### 🧩 Context · shutdown/);
    assert.match(report, /### 📝 Prepared input · 1 · Inspect/);
    assert.match(report, /### ⌨️ Command segment · 1 · Inspect/);
    assert.match(report, /### ⌨️ Command segment · 2 · Enter/);
    assert.match(report, /Send Enter \(one CR; no script text\)/);
    assert.match(report, /👁️ Command observation/);
    assert.match(report, /exit code unavailable/);
    assert.match(report, /> \/tmp/);
    assert.ok(report.includes('\n---\n'));
    assert.deepEqual(inspectMarkdown(report).fences, ['pwd', 'pwd']);
    assert.deepEqual(canonical(report), { metadata: [f.meta], records: f.records });
    if (process.env.HUB_CONSOLE_MARKDOWN_SAMPLE === '1')
        t.diagnostic('SYNTHETIC_MARKDOWN_SAMPLE_BASE64=' + bytesBase64(new TextEncoder().encode(report)));
});

test('console Markdown escapes hostile metadata and streamed PTY while safely fencing only bounded script text', async () => {
    const f = fixture({ hostile: true }), report = await collect(streamConsoleReport(f.archive, 'markdown'));
    f.assertReleased();
    const parsed = inspectMarkdown(report);
    assert.deepEqual(parsed.fences, [f.command, f.command]);
    assert.ok(!parsed.outside.includes('<img>') && !parsed.outside.includes('<script>'));
    assert.ok(!parsed.outside.split('\n').some((s) => s === '## injected'));
    assert.ok(parsed.outside.includes('\\|') && parsed.outside.includes('&lt;img&gt;'));
    assert.ok(report.includes('~~~~text\n' + f.command + '\n~~~~'));
    assert.ok(!report.includes('hidden-clipboard'));
    assert.deepEqual(canonical(report), { metadata: [f.meta], records: f.records });
});

test('incomplete prepared input remains uncertain without inventing dispatch, closure or command success', async () => {
    const f = fixture({ incomplete: true }), report = await collect(streamConsoleReport(f.archive, 'markdown'));
    f.assertReleased();
    assert.match(report, /## ⚠️ Console flow/);
    assert.match(report, /\| Capture state \| incomplete \|/);
    assert.match(report, /\| Shell closure \| Unconfirmed \|/);
    assert.match(report, /\| Observed bytes \| Unknown \|/);
    assert.match(report, /### 📝 Prepared input/);
    assert.match(report, /dispatch uncertain/);
    assert.ok(!report.includes('### ⌨️ Command segment'));
    assert.ok(!report.includes('write-dispatched; not remote execution confirmation'));
    assert.ok(!report.includes('## ✅ Console flow'));
    assert.ok(!inspectMarkdown(report).outside.split('\n').some((s) => s === '## injected'));
    assert.deepEqual(canonical(report), { metadata: [f.meta], records: f.records });
});

test('JSON, CSV and plain-text bytes and progress/ownership match the preserved pre-Markdown exporter', async () => {
    for (const options of [{}, { hostile: true }, { incomplete: true }])
        for (const format of ['json', 'csv', 'text'] as const) {
            const current = fixture(options), previous = fixture(options);
            let currentProgress = 0, previousProgress = 0;
            const actual = await collect(streamConsoleReport(current.archive, format, {}, async () => { currentProgress++; }));
            const expected = await collect(beforeMarkdown(previous.archive, format, {}, async () => { previousProgress++; }));
            assert.equal(actual, expected, format + ' byte contract');
            assert.equal(currentProgress, previousProgress);
            current.assertReleased(); previous.assertReleased();
        }
});
