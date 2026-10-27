import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceTable, graphReadings, historyFrame } from '../shared/diagnostics/presentation';
import type { ProbeResult, Snapshot } from '../shared/types';
const result = (stdout: string, status: ProbeResult['status'] = 'collected'): ProbeResult => ({
    id: 'test',
    stdout,
    status,
    stderr: '',
    exitCode: status === 'collected' ? 0 : 127,
    durationMs: 1,
    collectedAt: new Date().toISOString(),
    truncated: false,
});

test('table parsing preserves multiline sysfs values without turning prose into table rows', () => {
    assert.deepEqual(evidenceTable('gpio', result('/sys/test/label=a=b\nextra line')).rows, [
        ['/sys/test/label', 'a=b\nextra line'],
    ]);
    assert.deepEqual(evidenceTable('logs', result('log entry\nnext entry')).rows, []);
    assert.equal(evidenceTable('memory', result('MemTotal: 123 kB', 'unavailable')).rows.length, 0);
});

test('graphs use supported numeric measurements with distinct kernel units', () => {
    assert.deepEqual(
        graphReadings(
            'temperature',
            result(
                '/sys/class/thermal/thermal_zone0/temp=42500\n/sys/class/hwmon/hwmon0/temp1_crit=100000',
            ),
        ).map((r) => [r.value, r.unit]),
        [[42.5, '°C']],
    );
    assert.deepEqual(
        graphReadings(
            'current',
            result(
                '/sys/class/hwmon/hwmon0/in1_input=1200\n/sys/class/hwmon/hwmon0/curr1_input=500',
            ),
        ).map((r) => [r.value, r.unit]),
        [
            [1200, 'mV'],
            [500, 'mA'],
        ],
    );
    assert.equal(
        graphReadings('power', result('/sys/class/regulator/regulator.0/microvolts=8500000'))[0]
            .unit,
        'µV',
    );
    assert.equal(
        graphReadings(
            'temperature',
            result(
                '/sys/class/hwmon/hwmon0/temp1_type=4\n/sys/class/hwmon/hwmon0/temp1_input=1200',
            ),
        )[0].unit,
        'mV',
    );
    assert.equal(graphReadings('logs', result('value=42')).length, 0);
    assert.deepEqual(
        graphReadings('memory', result('MemTotal: 512 kB\nMemFree: 256 kB')).map((r) => [
            r.series,
            r.value,
        ]),
        [
            ['used', 0.25],
            ['free', 0.25],
        ],
    );
    assert.equal(
        graphReadings('temperature', result('/sys/class/thermal/thermal_zone0/temp=nan')).length,
        0,
    );
});

test('numeric history frames exclude raw evidence and commands', () => {
    const snapshot: Snapshot = {
        schemaVersion: 1,
        mode: 'ssh',
        endpoint: 'example:22',
        username: 'root',
        capturedAt: new Date().toISOString(),
        results: [{ ...result('1.2 2.3 3.4 1/23 123'), id: 'load' }],
    };
    const frame = historyFrame(snapshot);
    assert.equal(frame.readings.load.length, 3);
    assert.equal(JSON.stringify(frame).includes('stdout'), false);
    assert.equal(JSON.stringify(frame).includes('endpoint'), false);
});
