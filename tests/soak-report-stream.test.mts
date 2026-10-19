import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { streamCaptureReport } from '../shared/capture-report';
import {
    newCapture,
    appendFrames,
    sealedCapture,
    frameCrc,
    type CaptureFrame,
} from '../shared/capture-store';
import {
    inspectProductResultsReport,
    inspectProductResultsStream,
    type ResultsCapture,
} from './fixtures/memory-product-results-ui';
const at = '2026-10-19T00:00:00.000Z',
    hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function model() {
    const id = '11111111-1111-4111-8111-111111111111',
        command = '=printf "comma,含义"\nsecond line',
        name = 'metadata "quoted",\r\n含义',
        output = 'BODY\n**Capture ID:** 22222222-2222-4222-8222-222222222222\n~~~~~~~~~\n中文😀\n';
    const raw = Buffer.from(output),
        frames: CaptureFrame[] = [];
    let capture = newCapture(id, 1, {
        transport: 'serial',
        receiveTimeSource: 'local-client',
        runId: 'actual-product-serializer-model',
        stepId: 'step',
        command,
        name,
        startedAt: at,
    });
    for (let offset = 0; offset < raw.length; offset += 17) {
        const bytes = raw.subarray(offset, offset + 17),
            frame: CaptureFrame = {
                observation: frames.length,
                receivedAt: at,
                stream: 'serial' as const,
                offset: 0,
                totalBytes: bytes.length,
                bytes,
                crc32: frameCrc(bytes),
            };
        frames.push(frame);
        capture = appendFrames(capture, [frame]);
    }
    capture = sealedCapture(capture, raw.length, 'prompt-observed');
    capture.finalizedAt = at;
    const outcome = { completion: 'prompt-observed', exitCode: null, completedAt: at };
    const expected: ResultsCapture = {
        id,
        sequence: 1,
        transport: 'serial',
        command,
        name,
        state: 'complete',
        committedBytes: raw.length,
        completion: 'prompt-observed',
        exitCode: null,
        streams: { serial: { bytes: raw.length, sha256: hash(raw) } },
        readableOutput: { bytes: raw.length, sha256: hash(raw) },
        readableTokens: ['BODY', '中文😀'],
    };
    const store: any = {
        async pin() {
            return { through: 1, async release() {} };
        },
        async page(after: number) {
            return { records: after ? [] : [capture], next: null };
        },
        async result() {
            return outcome;
        },
        async *read() {
            yield { type: 'metadata', capture };
            for (const frame of frames) yield { type: 'frame', frame };
        },
    };
    return { store, expected };
}
for (const format of ['json', 'csv', 'markdown', 'text'] as const)
    for (const chunk of [1, 7, 65536])
        test(
            'actual ' + format + ' serializer semantics survive ' + chunk + '-byte reader chunks',
            async () => {
                const { store, expected } = model(),
                    parts: Uint8Array[] = [];
                for await (const part of streamCaptureReport(store, format, {})) parts.push(part);
                const raw = Buffer.concat(parts);
                async function* input() {
                    for (let offset = 0; offset < raw.length; offset += chunk)
                        yield raw.subarray(offset, offset + chunk);
                }
                const reference = inspectProductResultsReport(format, raw, [expected]),
                    actual = await inspectProductResultsStream(format, input(), [expected]);
                for (const key of [
                    'format',
                    'captures',
                    'captureIds',
                    'identityAttested',
                    'readableOutputAttested',
                    'bytes',
                    'sha256',
                ] as const)
                    assert.deepEqual(actual[key], reference[key]);
                assert.equal((actual.allocation as any).wholeReportMaterialized, false);
            },
        );
for (const format of ['json', 'csv', 'markdown', 'text'] as const)
    test(
        'incremental ' +
            format +
            ' refuses wrong full-output expectation and truncated actual report',
        async () => {
            const { store, expected } = model(),
                parts: Uint8Array[] = [];
            for await (const part of streamCaptureReport(store, format, {})) parts.push(part);
            const raw = Buffer.concat(parts);
            const changed = {
                ...expected,
                streams: { serial: { bytes: expected.committedBytes, sha256: 'a'.repeat(64) } },
                readableOutput: { bytes: expected.committedBytes, sha256: 'a'.repeat(64) },
            };
            await assert.rejects(inspectProductResultsStream(format, [raw], [changed]));
            await assert.rejects(
                inspectProductResultsStream(format, [raw.subarray(0, -9)], [expected]),
            );
            await assert.rejects(
                inspectProductResultsStream(format, [raw], [expected], raw.length - 1),
                /file bound/,
            );
        },
    );
