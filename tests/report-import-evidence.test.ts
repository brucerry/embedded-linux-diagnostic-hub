import assert from 'node:assert/strict';
import test from 'node:test';
import { createReport, parseReport } from '../shared/report';
import { strictIsoInstant } from '../shared/automation-time';

const stamp = '2028-02-29T12:34:56.123Z';
const report = () => ({
    schemaVersion: 1,
    mode: 'ssh',
    endpoint: 'synthetic.invalid:22',
    username: 'synthetic',
    capturedAt: stamp,
    results: [
        {
            id: 'identity',
            status: 'collected',
            exitCode: 0,
            stdout: 'Linux\nretained prefix\n',
            stderr: 'bounded warning',
            durationMs: 1,
            collectedAt: stamp,
            truncated: true,
            command: 'uname -a # exact historical command',
        },
    ],
});

test('snapshot and probe evidence reject normalized calendar dates and ambiguous local timestamps', () => {
    const invalid = [
        '2026-02-30T12:00:00Z',
        '2026-02-29T12:00:00Z',
        '2026-02-28T24:00:00Z',
        '2028-02-29T12:34:56',
        '2028-02-29T12:34:56+14:01',
        'not-a-date',
    ];
    for (const field of ['capturedAt', 'collectedAt'] as const) {
        for (const value of invalid) {
            const input = report();
            if (field === 'capturedAt') input.capturedAt = value;
            else input.results[0].collectedAt = value;
            const before = JSON.stringify(input);
            assert.throws(() => parseReport(before), /Unsupported report/, field + ': ' + value);
            assert.equal(JSON.stringify(input), before);
        }
    }
});

test('valid ISO precision, offsets and leap day survive report round-trip without losing partial raw evidence', () => {
    for (const value of ['1970-01-01T00:00:00Z', '2028-02-29T12:34:56.1+05:30', stamp]) {
        const input = report();
        input.capturedAt = value;
        input.results[0].collectedAt = value;
        const before = structuredClone(input);
        const parsed = parseReport(JSON.stringify(input));
        assert.equal(parsed.capturedAt, value);
        const identity = parsed.results.find((row) => row.id === 'identity')!;
        assert.deepEqual(identity, input.results[0]);
        assert.equal(identity.truncated, true);
        const missing = parsed.results.find((row) => row.id === 'flash')!;
        assert.equal(missing.status, 'unavailable');
        assert.match(missing.stderr, /not collected in the imported report/);
        assert.equal(missing.collectedAt, value);
        const reopened = parseReport(JSON.stringify(createReport(parsed)));
        assert.equal(reopened.capturedAt, value);
        assert.deepEqual(
            reopened.results.find((row) => row.id === 'identity'),
            identity,
        );
        assert.equal(reopened.results.find((row) => row.id === 'flash')?.status, 'unavailable');
        assert.deepEqual(input, before);
    }
});

test('Automation command/capture/journal JSON schemas are not silently accepted as diagnostic snapshots', () => {
    for (const input of [
        { schemaVersion: 1, scope: 'all', records: [{ id: 'command', runId: 'run' }] },
        { schemaVersion: 3, throughSequence: 1, captures: [] },
        { schemaVersion: 2, captures: [{ capture: {}, records: [] }] },
    ])
        assert.throws(() => parseReport(JSON.stringify(input)), /Unsupported report/);
});

test('nested cached network evidence validates its own timestamp and keeps partial provenance', () => {
    const input = report();
    const section = {
        id: 'cached-addresses',
        operation: 'ip-address-json',
        scope: 'all',
        source: 'cached',
        command: 'ip -j address',
        stdout: '[{"ifname":"eth0"}',
        stderr: 'retained warning',
        status: 'collected',
        exitCode: 0,
        durationMs: 2,
        truncated: true,
        collectedAt: '2026-02-30T12:00:00Z',
    };
    const value = {
        ...input,
        results: [
            {
                ...input.results[0],
                networkEvidence: {
                    version: 1,
                    sections: [section],
                    omissions: [],
                },
            },
        ],
    };
    assert.throws(() => parseReport(JSON.stringify(value)), /Unsupported network evidence/);
    section.collectedAt = '2028-02-29T12:34:56+05:30';
    const before = structuredClone(value);
    const parsed = parseReport(JSON.stringify(value));
    assert.deepEqual(
        parsed.results.find((row) => row.id === 'identity')!.networkEvidence?.sections,
        [section],
    );
    assert.deepEqual(value, before);
});

test('historical report instants and precision do not inherit schedule bounds or require optional legacy fields', () => {
    const historical = [
        '1969-12-31T23:59:59.000Z',
        '1970-01-01T00:00:00+01:00',
        '2028-02-29T12:34:56.123456Z',
    ];
    for (const value of historical) {
        const input = report(),
            { command: _command, ...legacy } = input.results[0];
        const section = {
            ...legacy,
            id: 'old-section',
            collectedAt: value,
            operation: 'iw-info',
            scope: 'wlan0',
            source: 'cached',
            command: 'iw dev wlan0 info',
        };
        const data = {
            ...input,
            capturedAt: value,
            results: [
                {
                    ...legacy,
                    collectedAt: value,
                    networkEvidence: { version: 1, sections: [section], omissions: [] },
                },
            ],
        };
        const before = structuredClone(data),
            parsed = parseReport(JSON.stringify(data));
        const identity = parsed.results.find((row) => row.id === 'identity')!;
        assert.equal(parsed.capturedAt, value);
        assert.equal(identity.collectedAt, value);
        assert.equal(identity.networkEvidence?.sections[0].collectedAt, value);
        assert.equal('command' in identity, false);
        const withoutNetwork = parseReport(
            JSON.stringify({
                ...input,
                capturedAt: value,
                results: [{ ...legacy, collectedAt: value }],
            }),
        );
        assert.equal(
            'networkEvidence' in withoutNetwork.results.find((row) => row.id === 'identity')!,
            false,
        );
        assert.equal(identity.truncated, true);
        assert.deepEqual(data, before);
        assert.throws(
            () => strictIsoInstant(value),
            'Existing device/schedule rules stay unchanged',
        );
    }
});
