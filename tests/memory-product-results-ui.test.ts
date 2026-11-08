/** Pure modeled report bytes only. No store, browser, capture producer or resource qualification. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    assertResultsCatalogEvolution,
    inspectProductResultsReport,
    markdownResultsSections,
    parseResultsCsv,
    type ResultsCapture,
} from './fixtures/memory-product-results-ui';
import { appendFrames, frameCrc, newCapture } from '../shared/capture-store';

const id = '12345678-1234-4123-8123-123456789abc';
const otherId = '22345678-1234-4123-8123-123456789abc';
const at = '2026-10-15T00:00:00.000Z';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value: string) => new TextEncoder().encode(value);
function model() {
    const command = '=printf "model,含义"\nsecond line',
        name = 'Modeled row';
    const output = 'MODEL-OUTPUT\n**Capture ID:** ' + otherId + '\n~~~\n含义\n';
    const bytes = encoded(output),
        frame = {
            observation: 0,
            receivedAt: at,
            stream: 'serial' as const,
            offset: 0,
            totalBytes: bytes.length,
            bytes,
            crc32: frameCrc(bytes),
        };
    const capture = {
        ...appendFrames(
            newCapture(id, 1, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'model-only',
                stepId: 'model-step',
                name,
                command,
                startedAt: at,
            }),
            [frame],
        ),
        state: 'complete' as const,
        observedBytes: bytes.length,
        finalizedAt: at,
        reason: 'prompt-observed',
    };
    const expected: ResultsCapture = {
        id,
        sequence: 1,
        transport: 'serial',
        name,
        command,
        state: 'complete',
        committedBytes: bytes.length,
        completion: 'prompt-observed',
        exitCode: null,
        streams: { serial: { bytes: bytes.length, sha256: hash(bytes) } },
        readableOutput: { bytes: bytes.length, sha256: hash(bytes) },
        readableTokens: ['MODEL-OUTPUT', '含义'],
    };
    const outcome = { completion: 'prompt-observed', exitCode: null };
    const json = {
        schemaVersion: 3,
        throughSequence: 1,
        scope: { ids: [id] },
        captures: [
            {
                schemaVersion: 3,
                capture,
                outcome,
                rawObservations: [
                    { ...frame, bytes: undefined, base64: Buffer.from(bytes).toString('base64') },
                ],
                captureComplete: true,
                verifiedCommittedBytes: bytes.length,
            },
        ],
        summary: { captures: 1, complete: 1, incomplete: 0, verifiedCommittedBytes: bytes.length },
    };
    const markdown =
        '# Model\n\n**Capture ID:** ' +
        id +
        ' metadata\n\n~~~~~~sh\n' +
        command +
        '\n~~~~~~\n\n~~~~~~json\n' +
        JSON.stringify(outcome) +
        '\n~~~~~~\n\n~~~~~~text\n' +
        output +
        '\n~~~~~~\n\n**Export integrity:** all 1 captures read through pinned marks.\n';
    const text =
        'Model\nCaptures: 1; complete: 1; incomplete: 0; committed bytes: ' +
        bytes.length +
        '\nCommand:\n' +
        command +
        '\nReceived output (UTF-8 projection):\n' +
        output +
        '\n';
    const header =
        'capture_id,sequence,name,command,capture_state,reason,committed_bytes,observed_bytes,completed_observations,partial_observation,receive_clock,record_started_utc,finalized_or_recovered_utc,observation,received_utc,stream,observation_offset,observation_bytes,raw_base64_prefixed,transformedFields,outcome_json_base64_prefixed,export_scope';
    const cells = [
        id,
        '1',
        name,
        "'" + command,
        'complete',
        'prompt-observed',
        String(bytes.length),
        String(bytes.length),
        '1',
        'false',
        'local-client',
        at,
        at,
        '0',
        at,
        'serial',
        '0',
        String(bytes.length),
        'base64:' + Buffer.from(bytes).toString('base64'),
        'command',
        'base64:' + Buffer.from(JSON.stringify(outcome)).toString('base64'),
        'Selected captures (1)',
    ];
    const csv =
        header +
        '\r\n' +
        cells.map((value) => '"' + value.replaceAll('"', '""') + '"').join(',') +
        '\r\n';
    return { expected, json, markdown, text, csv, output };
}

test('CSV parser preserves quoted multiline Unicode/quotes and rejects ambiguous or truncated fields', () => {
    assert.deepEqual(parseResultsCsv('one,two\r\n"a\r\nb","含""义"\r\n'), [
        ['one', 'two'],
        ['a\r\nb', '含"义'],
    ]);
    for (const input of ['"truncated', '"a"junk,b\r\n', 'a"b,c\r\n', 'a,b\rc,d'])
        assert.throws(() => parseResultsCsv(input));
});
test('Markdown metadata parser ignores fake IDs and short fences inside a real longer output fence', () => {
    const value = model(),
        sections = markdownResultsSections(value.markdown);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].id, id);
    assert.equal(sections[0].command, value.expected.command);
    assert.ok(sections[0].output?.includes(otherId));
    assert.throws(() =>
        markdownResultsSections(value.markdown.slice(0, value.markdown.lastIndexOf('~~~~~~'))),
    );
});
test('constant catalogs compare exact identities and cannot offset removal with an equal-size replacement', () => {
    assert.equal(
        assertResultsCatalogEvolution([id], {
            mode: 'constant',
            previousIds: [id],
            expectedAddedIds: [],
            bound: 2,
        }).count,
        1,
    );
    assert.throws(
        () =>
            assertResultsCatalogEvolution([otherId], {
                mode: 'constant',
                previousIds: [id],
                expectedAddedIds: [otherId],
                bound: 2,
            }),
        /removed/,
    );
    assert.throws(() =>
        assertResultsCatalogEvolution([id, id], {
            mode: 'constant',
            previousIds: [id],
            expectedAddedIds: [],
            bound: 2,
        }),
    );
});
test('bounded growth needs exact new IDs and stays inside the explicit caller profile bound', () => {
    assert.deepEqual(
        assertResultsCatalogEvolution([id, otherId], {
            mode: 'bounded-growing',
            previousIds: [id],
            expectedAddedIds: [otherId],
            bound: 2,
        }).addedIds,
        [otherId],
    );
    assert.throws(() =>
        assertResultsCatalogEvolution([id, otherId], {
            mode: 'bounded-growing',
            previousIds: [id],
            expectedAddedIds: [],
            bound: 2,
        }),
    );
    assert.throws(
        () =>
            assertResultsCatalogEvolution([id, otherId], {
                mode: 'bounded-growing',
                previousIds: [id],
                expectedAddedIds: [otherId],
                bound: 1,
            }),
        /bound/,
    );
});
test('modeled JSON validates complete exact bytes, checksum boundaries, membership and unavailable exit status', () => {
    const value = model(),
        result = inspectProductResultsReport('json', encoded(JSON.stringify(value.json)), [
            value.expected,
        ]);
    assert.equal(result.identityAttested, true);
    assert.deepEqual(result.captureIds, [id]);
});
test('JSON rejects substituted IDs/commands, mismatched summary, corrupted raw bytes and wrong outcome', () => {
    for (const mutate of [
        (j: any) => (j.captures[0].capture.id = otherId),
        (j: any) => (j.captures[0].capture.header.command = 'different'),
        (j: any) => (j.summary.captures = 2),
        (j: any) => (j.captures[0].rawObservations[0].base64 = 'AA=='),
        (j: any) => (j.captures[0].outcome.exitCode = 0),
        (j: any) => (j.throughSequence = 0),
    ]) {
        const value = model();
        mutate(value.json);
        assert.throws(() =>
            inspectProductResultsReport('json', encoded(JSON.stringify(value.json)), [
                value.expected,
            ]),
        );
    }
});
test('JSON independent stream expectation rejects self-consistent but incorrect payload provenance', () => {
    const value = model(),
        expected = {
            ...value.expected,
            streams: {
                serial: { bytes: value.expected.committedBytes, sha256: hash('different') },
            },
        };
    assert.throws(
        () => inspectProductResultsReport('json', encoded(JSON.stringify(value.json)), [expected]),
        /stream bytes/,
    );
});
test('CSV semantic check reverses only declared formula protection and verifies exact raw bytes/outcome', () => {
    const value = model();
    assert.equal(
        inspectProductResultsReport('csv', encoded(value.csv), [value.expected]).identityAttested,
        true,
    );
    assert.throws(() =>
        inspectProductResultsReport(
            'csv',
            encoded(value.csv.replace('"command","base64:', '"","base64:')),
            [value.expected],
        ),
    );
    const raw = parseResultsCsv(value.csv)[1][18];
    assert.throws(
        () =>
            inspectProductResultsReport(
                'csv',
                encoded(
                    value.csv.replace(
                        raw,
                        'base64:' +
                            Buffer.alloc(value.expected.committedBytes, 90).toString('base64'),
                    ),
                ),
                [value.expected],
            ),
        /stream bytes/,
    );
});
test('Markdown checks actual command/outcome/output inside the correct capture section', () => {
    const value = model();
    assert.equal(
        inspectProductResultsReport('markdown', encoded(value.markdown), [value.expected])
            .identityAttested,
        true,
    );
    assert.throws(() =>
        inspectProductResultsReport(
            'markdown',
            encoded(value.markdown.replace('MODEL-OUTPUT', 'omitted')),
            [value.expected],
        ),
    );
    assert.throws(() =>
        inspectProductResultsReport(
            'markdown',
            encoded(value.markdown.replace('"exitCode":null', '"exitCode":0')),
            [value.expected],
        ),
    );
});
test('Text semantics never claims ID membership and rejects missing command/output/count', () => {
    const value = model(),
        result = inspectProductResultsReport('text', encoded(value.text), [value.expected]);
    assert.equal(result.identityAttested, false);
    assert.equal(result.captureIds, null);
    for (const text of [
        value.text.replace('Captures: 1;', 'Captures: 2;'),
        value.text.replace(value.expected.command, 'wrong'),
        value.text.replace('MODEL-OUTPUT', 'omitted'),
    ])
        assert.throws(() => inspectProductResultsReport('text', encoded(text), [value.expected]));
});

for (const format of ['markdown', 'text'] as const)
    test(
        format +
            ' rejects omitted, truncated and same-length-corrupted bodies with metadata and tokens preserved',
        () => {
            const value = model();
            for (const body of [
                value.output.replace(otherId, ''),
                value.output.replace(otherId, '9'.repeat(otherId.length)),
                '',
            ]) {
                const report = value[format].replace(value.output, body);
                assert.ok(report.includes(value.expected.command));
                if (body)
                    for (const token of value.expected.readableTokens!)
                        assert.ok(report.includes(token));
                assert.throws(
                    () => inspectProductResultsReport(format, encoded(report), [value.expected]),
                    /readable output/,
                );
            }
            const { readableOutput, ...withoutExpectation } = value.expected;
            assert.ok(readableOutput);
            assert.throws(
                () =>
                    inspectProductResultsReport(format, encoded(value[format]), [
                        withoutExpectation,
                    ]),
                /expectation is required/,
            );
        },
    );
test('invalid UTF8 and duplicate expected membership fail rather than silently clipping/merging', () => {
    const value = model();
    assert.throws(() =>
        inspectProductResultsReport('text', new Uint8Array([0xff]), [value.expected]),
    );
    assert.throws(() =>
        inspectProductResultsReport('json', encoded(JSON.stringify(value.json)), [
            value.expected,
            value.expected,
        ]),
    );
});
