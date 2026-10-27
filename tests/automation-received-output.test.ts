import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutomationRecord, RawChunk } from '../shared/automation';
import { exportResults } from '../src/features/automation/exports';
import { receivedOutput, formatReceivedOutput } from '../src/features/automation/received-output';
import { observedDeviceTime } from '../src/features/automation/serial-completion';
const chunk = (
    stream: RawChunk['stream'],
    bytes: number[] | string,
    receivedAt = '2026-10-14T10:00:00.123Z',
): RawChunk => ({ stream, base64: Buffer.from(bytes).toString('base64'), receivedAt });
const record = (chunks: RawChunk[]): AutomationRecord => ({
    id: 'one',
    runId: 'run',
    ordinal: 1,
    name: 'fixture',
    command: 'echo fixture',
    transport: 'serial',
    target: { endpoint: 'mock' },
    startedAt: '2026-10-14T10:00:00.000Z',
    completedAt: '2026-10-14T10:00:01.000Z',
    localZone: 'UTC',
    durationMs: 1000,
    deviceTime: null,
    stdout: 'raw aggregate',
    stderr: 'local status',
    exitCode: null,
    completion: 'prompt-observed',
    truncated: false,
    chunks,
    receiveTimeSource: 'local-client',
    execution: {
        timeoutSeconds: 60,
        repeatSeconds: null,
        stepDelaySeconds: 0,
        serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
    },
});
function csvRows(text: string) {
    const rows: string[][] = [];
    let row: string[] = [],
        value = '',
        quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (quoted && text[i + 1] === '"') {
                value += '"';
                i++;
            } else quoted = !quoted;
        } else if (c === ',' && !quoted) {
            row.push(value);
            value = '';
        } else if (c === '\n' && !quoted) {
            row.push(value.replace(/\r$/, ''));
            rows.push(row);
            row = [];
            value = '';
        } else value += c;
    }
    row.push(value);
    rows.push(row);
    return rows;
}
test('receive fragments retain observed order through clock jumps and preserve split/multiline UTF-8 streams', () => {
    const r = record([
        chunk('serial', 'first\nsecond\n'),
        chunk('serial', [0xe2, 0x82]),
        chunk('stderr', 'error\n', '2026-10-14T10:00:00.122Z'),
        chunk('serial', [0xac, 10]),
        chunk('serial', 'partial'),
    ]);
    const before = structuredClone(r);
    const fragments = receivedOutput(r);
    assert.deepEqual(
        fragments.map((c) => c.index),
        [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
        fragments.map((c) => c.receivedAt),
        r.chunks.map((c) => c.receivedAt),
    );
    assert.equal(fragments[0].text, 'first\nsecond\n');
    assert.equal(fragments[1].text, '');
    assert.equal(fragments[1].pendingUtf8Bytes, 2);
    assert.equal(fragments[2].text, 'error\n');
    assert.equal(fragments[3].text, '€\n');
    assert.equal(fragments[3].continuesFromPreviousChunk, true);
    assert.equal(fragments[4].text, 'partial');
    assert.deepEqual(r, before);
    const output = formatReceivedOutput(r);
    assert.match(output, /Local client receive time/);
    assert.match(output, /not device emission time/);
    assert.ok(output.indexOf('first') < output.indexOf('error'));
    assert.ok(output.indexOf('error') < output.indexOf('€'));
    assert.equal(observedDeviceTime('TIME=2026-10-14T10:00:00Z', '', r.completedAt), null);
});
test('exports include timestamped chunks, formula-safe CSV and exact legacy-compatible JSON', () => {
    const r = record([
        chunk('serial', '=SUM(1,2)\n"line"\n'),
        chunk('serial', 'part', '2026-10-14T09:59:59.999Z'),
    ]);
    r.truncated = true;
    const json = JSON.parse(exportResults([r], 'json', 'all', 0));
    assert.equal(json.schemaVersion, 1);
    assert.deepEqual(json.records[0], r);
    const csv = csvRows(exportResults([r], 'csv', 'all', 0));
    const keys = csv.shift()!;
    const rows = csv.map((c) => Object.fromEntries(keys.map((k, i) => [k, c[i]])));
    assert.equal(rows.length, 3);
    assert.equal(rows[0].rowType, 'command');
    assert.equal(rows[0].stdout, 'raw aggregate');
    assert.equal(rows[1].rowType, 'receive-chunk');
    assert.equal(rows[1].receivedAt, r.chunks[0].receivedAt);
    assert.equal(rows[2].receivedAt, r.chunks[1].receivedAt);
    assert.equal(rows[1].chunkText, '\'=SUM(1,2)\n"line"\n');
    assert.equal(rows[1].transformedFields, 'chunkText');
    assert.equal(rows[1].chunkBase64, r.chunks[0].base64);
    assert.equal(rows[1].truncated, 'true');
    assert.equal(rows[1].stdout, '');
    for (const format of ['text', 'markdown'] as const) {
        const text = exportResults([r], format, 'all', 0);
        assert.match(text, /Received output/);
        assert.match(text, /10:00:00.123Z/);
        assert.match(text, /09:59:59.999Z/);
        assert.match(text, /Capture truncated/);
        assert.match(text, /raw aggregate/);
    }
    delete r.receiveTimeSource;
    assert.match(formatReceivedOutput(r), /source not recorded/);
    assert.equal(
        'receiveTimeSource' in JSON.parse(exportResults([r], 'json', 'all', 0)).records[0],
        false,
    );
    r.receiveTimeSource = 'gateway';
    assert.match(formatReceivedOutput(r), /Gateway receive time/);
});
test('malformed and incomplete encoding stays bounded and raw bytes remain available', () => {
    const r = record([
        chunk('stdout', [0xe0, 0x80]),
        chunk('serial', [0xf0, 0x9f]),
        chunk('stderr', '\x00\x1btext'),
    ]);
    r.truncated = true;
    const f = receivedOutput(r);
    assert.equal(f[0].pendingUtf8Bytes, 0);
    assert.equal(f[1].incompleteAtEnd, true);
    assert.equal(f[1].text, '�');
    const text = formatReceivedOutput(r);
    assert.match(text, /incomplete UTF-8 at capture end/);
    assert.ok(text.includes('\\x00\\x1btext'));
    assert.match(text, /Capture truncated/);
    assert.deepEqual(JSON.parse(exportResults([r], 'json', 'all', 0)).records[0].chunks, r.chunks);
    r.chunks = [];
    assert.match(formatReceivedOutput(r), /No retained receive chunks/);
});
