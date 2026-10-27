import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialCaptureBlocks } from '../src/features/automation/serial-capture';
import {
    AUTOMATION_LIMITS,
    validateCapture,
    type CommandCapture,
    type AutomationRecord,
} from '../shared/automation';
import { exportResults } from '../src/features/automation/exports';
import { formatReceivedOutput, receivedOutput } from '../src/features/automation/received-output';

const first = '2026-10-15T10:00:00.010Z',
    last = '2026-10-15T10:00:00.005Z';
const capture = (blocks: SerialCaptureBlocks): CommandCapture => ({
    stdout: '',
    stderr: '',
    exitCode: null,
    completion: 'timeout',
    truncated: false,
    chunks: blocks.finish(),
});

test('Serial blocks preserve first/last observed order through clock jumps and copy exact bytes', () => {
    const blocks = new SerialCaptureBlocks(),
        bytes = new Uint8Array([1, 2]);
    blocks.append(bytes, first);
    bytes.fill(99);
    blocks.append(new Uint8Array([3]), last);
    blocks.append(new Uint8Array(), first);
    const result = validateCapture(capture(blocks));
    assert.deepEqual([...Buffer.from(result.chunks[0].base64, 'base64')], [1, 2, 3]);
    assert.equal(result.chunks[0].receivedAt, first);
    assert.deepEqual(result.chunks[0].aggregation, {
        kind: 'serial-byte-block-v1',
        firstReceivedAt: first,
        lastReceivedAt: last,
        contributingReads: 2,
    });
});
test('64 KiB in one-byte reads needs at most 64 blocks without raising the shared record limit', () => {
    const blocks = new SerialCaptureBlocks();
    for (let index = 0; index < AUTOMATION_LIMITS.outputBytes; index++)
        blocks.append(new Uint8Array([index & 255]), first);
    const result = validateCapture(capture(blocks));
    assert.equal(AUTOMATION_LIMITS.chunks, 256);
    assert.equal(result.chunks.length, 64);
    for (const block of result.chunks) assert.equal(block.aggregation!.contributingReads, 1024);
    assert.equal(
        Buffer.concat(result.chunks.map((c) => Buffer.from(c.base64, 'base64'))).length,
        65536,
    );
    assert.throws(() => blocks.append(new Uint8Array([1]), first), /bound/);
});
test('one read crossing a block boundary counts once in each contributing block', () => {
    const blocks = new SerialCaptureBlocks();
    blocks.append(new Uint8Array(1025), first);
    assert.deepEqual(
        blocks.finish().map((c) => c.aggregation!.contributingReads),
        [1, 1],
    );
    blocks.append(new Uint8Array([2]), last);
    assert.deepEqual(
        blocks.finish().map((c) => c.aggregation!.contributingReads),
        [1, 2],
    );
});
test('Serial block provenance rejects malformed, contradictory and nonserial claims; legacy SSH is unchanged', () => {
    const blocks = new SerialCaptureBlocks();
    blocks.append(new Uint8Array([65, 66]), first);
    const valid = capture(blocks),
        chunk = valid.chunks[0];
    for (const invalid of [
        { ...chunk, stream: 'stdout' },
        { ...chunk, aggregation: { ...chunk.aggregation, kind: 'native-read' } },
        { ...chunk, aggregation: { ...chunk.aggregation, contributingReads: 0 } },
        { ...chunk, aggregation: { ...chunk.aggregation, contributingReads: 3 } },
        { ...chunk, aggregation: { ...chunk.aggregation, firstReceivedAt: last } },
        { ...chunk, aggregation: { ...chunk.aggregation, lastReceivedAt: last } },
        {
            ...chunk,
            aggregation: { ...chunk.aggregation, lastReceivedAt: '2026-02-30T00:00:00.000Z' },
        },
        { ...chunk, aggregation: { ...chunk.aggregation, inventedTime: first } },
        { ...chunk, base64: Buffer.alloc(1025).toString('base64') },
    ])
        assert.throws(() => validateCapture({ ...valid, chunks: [invalid] }), /provenance/);
    const legacy = {
        ...valid,
        chunks: [{ stream: 'stdout' as const, base64: 'QQ==', receivedAt: first }],
    };
    assert.deepEqual(validateCapture(legacy), legacy);
});
test('raw bytes, UTF-8 block continuations and truthful aggregation ranges survive every export', () => {
    const blocks = new SerialCaptureBlocks();
    const expected = 'a'.repeat(1023) + '€\x1b[32m\nboard# ';
    const bytes = new TextEncoder().encode(expected);
    blocks.append(bytes.subarray(0, 1000), first);
    blocks.append(bytes.subarray(1000), last);
    const r: AutomationRecord = {
        ...capture(blocks),
        stdout: expected,
        id: 'one',
        runId: 'run',
        ordinal: 1,
        name: 'fixture',
        command: 'ls',
        transport: 'serial',
        target: { endpoint: 'synthetic' },
        startedAt: first,
        completedAt: first,
        localZone: 'UTC',
        durationMs: 1,
        deviceTime: null,
        receiveTimeSource: 'local-client',
    };
    const fragments = receivedOutput(r);
    assert.equal(fragments.map((c) => c.text).join(''), expected);
    assert.equal(fragments[1].continuesFromPreviousChunk, true);
    assert.equal(fragments[0].aggregation!.contributingReads, 2);
    const json = JSON.parse(exportResults([r], 'json', 'all', 0));
    assert.equal(json.schemaVersion, 2);
    assert.deepEqual(json.records[0].chunks, r.chunks);
    assert.deepEqual(
        Buffer.concat(
            json.records[0].chunks.map((c: { base64: string }) => Buffer.from(c.base64, 'base64')),
        ),
        Buffer.from(bytes),
    );
    const csv = exportResults([r], 'csv', 'all', 0);
    for (const field of [
        'chunkRepresentation',
        'firstReceivedAt',
        'lastReceivedAt',
        'contributingReads',
        'receive-block',
        'serial-byte-block-v1',
        first,
        last,
    ])
        assert.ok(csv.includes(field));
    for (const format of ['text', 'markdown'] as const) {
        const text = exportResults([r], format, 'all', 0);
        assert.ok(text.includes('serial byte block'));
        assert.ok(text.includes(first));
        assert.ok(text.includes(last));
        assert.ok(text.includes('interior read boundaries/times are not retained'));
    }
    assert.ok(formatReceivedOutput(r).includes('A read may contribute to multiple blocks'));
    const ssh = {
        ...r,
        transport: 'ssh' as const,
        chunks: [{ stream: 'stdout' as const, base64: 'QQ==', receivedAt: first }],
    };
    assert.equal(JSON.parse(exportResults([ssh], 'json', 'all', 0)).schemaVersion, 1);
    assert.equal(exportResults([ssh], 'csv', 'all', 0).includes('chunkRepresentation'), false);
});
