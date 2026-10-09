import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEVICE_CLOCK_COMMAND,
    deviceRebooted,
    deviceZoneLabel,
    parseDeviceClock,
    validateDeviceClock,
} from '../shared/diagnostics/device-clock';

import { clockOutput } from './fixtures/device-clock';

test('GNU/BusyBox clock fields preserve the device calendar and signed zone', () => {
    const sample = parseDeviceClock(`Welcome\n${clockOutput()}Bye\n`);
    assert.equal(sample.date, '2026-10-09');
    assert.equal(sample.time, '16:35:42');
    assert.equal(sample.uptimeSeconds, 100.5);
    assert.equal(deviceZoneLabel(sample), 'CST · UTC+08:00');
    assert.deepEqual(validateDeviceClock({ status: 'available', sample }), {
        status: 'available',
        sample,
    });
    assert.equal(
        deviceZoneLabel(parseDeviceClock(clockOutput('2026-10-09', '03:05:00', '-0330', 'NST'))),
        'NST · UTC-03:30',
    );
    assert.equal(
        deviceZoneLabel(parseDeviceClock(clockOutput('2026-10-09', '08:35:00', '+0000', 'UTC'))),
        'UTC · UTC+00:00',
    );
    assert.ok(!DEVICE_CLOCK_COMMAND.includes('date -s'));
});

test('unsupported optional fields and minimal metadata retain valid device calendar', () => {
    const sample = parseDeviceClock(
        clockOutput('2026-10-09', '16:35:00', '%z', '%Z', '', '', '%s'),
    );
    assert.equal(sample.epochSeconds, null);
    assert.equal(sample.utcOffsetMinutes, null);
    assert.equal(sample.bootId, null);
    assert.equal(sample.uptimeSeconds, null);
    assert.equal(deviceZoneLabel(sample), 'Timezone unknown');
    assert.equal(
        deviceZoneLabel(parseDeviceClock(clockOutput('2026-10-09', '16:35:00', '+0545', ''))),
        'UTC+05:45',
    );
});

test('malformed calendar, markers, field structure and transport samples are rejected', () => {
    for (const output of [
        clockOutput('2026-02-30'),
        clockOutput('2026-10-09', '25:00:00'),
        clockOutput().replace('boot=', 'other='),
        clockOutput() + clockOutput(),
        clockOutput().replace('__END_DIAGNOSTIC_HUB_CLOCK_V1__', ''),
        'x'.repeat(8193),
    ])
        assert.throws(() => parseDeviceClock(output));
    const sample = parseDeviceClock(clockOutput());
    for (const patch of [
        { utcOffsetMinutes: 1440 },
        { epochSeconds: Infinity },
        { zone: '<script>' },
        { bootId: 'bad' },
        { uptimeSeconds: -1 },
        { date: 'bad' },
    ])
        assert.throws(() =>
            validateDeviceClock({ status: 'available', sample: { ...sample, ...patch } }),
        );
    assert.throws(() => validateDeviceClock({ status: 'unavailable', reason: 'raw shell stderr' }));
    assert.equal(parseDeviceClock(clockOutput('2024-02-29')).date, '2024-02-29');
});

test('reboot evidence uses boot identity or uptime rollback, not clock corrections', () => {
    const previous = parseDeviceClock(clockOutput());
    assert.equal(deviceRebooted(previous, { ...previous, uptimeSeconds: 2 }), true);
    assert.equal(
        deviceRebooted(previous, { ...previous, bootId: '22222222-2222-4222-8222-222222222222' }),
        true,
    );
    assert.equal(deviceRebooted(previous, { ...previous, uptimeSeconds: 110 }), false);
    assert.equal(deviceRebooted({ bootId: null, uptimeSeconds: null }, previous), false);
});
