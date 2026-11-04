import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseUptimeSeconds, formatUptime, summarize } from '../shared/diagnostics/metrics';
import { deviceRebooted } from '../shared/diagnostics/device-clock';
import type { Snapshot } from '../shared/types';

// Execute the exact App input expressions and uptime effect body with fake
// callbacks. No React mount, clock sampling, real timers or transport operations.
const app = readFileSync('src/app/App.tsx', 'utf8');
const start = app.indexOf('    const uptimeResult =');
const end = app.indexOf('    const selectedResult =');
assert(start >= 0 && end > start);
const inputs = app.slice(start, end);
assert(inputs.includes('const clock = useDeviceClock({'));
const bindInputs = new Function(
    'snapshot', 'transport', 'connected', 'activeDevice', 'clockReset', 'resetting',
    'disconnecting', 'imported', 'useDeviceClock', 'parseUptimeSeconds', inputs,
);
const hook = readFileSync('src/hooks/useDeviceClock.ts', 'utf8');
const effectStart = hook.indexOf('        const previous = observed.current;');
const effectEnd = hook.indexOf('    }, [generation, uptime]);');
assert(effectStart >= 0 && effectEnd > effectStart);
const effectBody = hook.slice(effectStart, effectEnd);
assert(effectBody.includes('if (uptime !== null || previous.generation !== generation)'));
assert(effectBody.endsWith('            observed.current = { generation, uptime };\n'));
const bindEffect = new Function('observed', 'generation', 'uptime', 'deviceRebooted', 'refresh', effectBody);

function report(stdout: string, status = 'collected') {
    return { results: [{ id: 'uptime', status, stdout, stderr: '' }] } as Snapshot;
}
function clockInput(snapshot: Snapshot | null, imported = false): number | null {
    let seen: { uptime: number | null } | undefined;
    bindInputs(snapshot, {}, true, { generation: 7 }, 0, false, false, imported,
        (input: { uptime: number | null }) => { seen = input; return {}; }, parseUptimeSeconds);
    assert(seen);
    return seen.uptime;
}
function refreshes(next: number | null, previous: number | null = 100, generation = 7) {
    let calls = 0;
    const observed = { current: { generation: 7, uptime: previous as number | null } };
    bindEffect(observed, generation, next, deviceRebooted, { current: () => { calls++; } });
    assert.equal(observed.current.uptime, next === null && generation === 7 ? previous : next);
    return calls;
}

test('missing and whitespace-only uptime stay unknown while literal zero remains valid', () => {
    for (const text of ['', ' ', '\t\r\n', ' \n \t']) {
        assert.equal(parseUptimeSeconds(text), null);
        assert.equal(formatUptime(text), 'Unavailable');
    }
    for (const text of ['0', '0.00 0.00', ' 000.000\t4.5\r\n']) {
        assert.equal(parseUptimeSeconds(text), 0);
        assert.equal(formatUptime(text), '0h 0m');
    }
});

test('ordinary uptime decimal readings and existing human display retain their values', () => {
    for (const [text, seconds] of [
        ['100.25 500.70\n', 100.25], ['90061.5 0', 90061.5], ['00012.50', 12.5],
    ] as const) assert.equal(parseUptimeSeconds(text), seconds);
    assert.equal(formatUptime('90061.5 0'), '1d 1h 1m');
    assert.equal(formatUptime('3599.99 0'), '0h 59m');
    assert.equal(formatUptime('3600.00 0'), '1h 0m');
    assert.equal(parseUptimeSeconds('12.5 unknown-idle'), 12.5, 'Only uptime is derived; siblings remain raw');
});

test('non-decimal, signed and partial tokens cannot invent uptime measurements', () => {
    for (const token of ['NaN', 'Infinity', '+12', '-1', '-0', '0x10', '1e3', '1e309',
        '.5', '12.', '12ms', '12.3.4', '12/3']) {
        assert.equal(parseUptimeSeconds(token + ' 0'), null, token);
        assert.equal(formatUptime(token + ' 0'), 'Unavailable', token);
    }
});

test('overflow, unsafe magnitudes and nonzero underflow are unknown without a hardware range limit', () => {
    for (const token of ['9'.repeat(400), '9007199254740992', '9007199254740991.1',
        '0.' + '0'.repeat(400) + '1'])
        assert.equal(parseUptimeSeconds(token + ' 0'), null);
    assert.equal(parseUptimeSeconds('9007199254740991 0'), Number.MAX_SAFE_INTEGER);
    assert.equal(parseUptimeSeconds('9007199254740991.000 0'), Number.MAX_SAFE_INTEGER);
    assert.equal(parseUptimeSeconds('0.' + '0'.repeat(400) + ' 0'), 0);
    assert.equal(parseUptimeSeconds('0.01 0'), 0.01);
});

test('actual App inputs and hook effect do not request a reboot refresh for absent or failed evidence', () => {
    for (const snapshot of [null, report(''), report(' \t\r\n'), report('1e3 0'),
        report('0x10 0'), report('42.0 1', 'error'), report('42.0 1', 'unavailable')]) {
        const uptime = clockInput(snapshot);
        assert.equal(uptime, null);
        assert.equal(refreshes(uptime), 0);
    }
});

test('actual App and hook preserve genuine zero rollback and increasing-uptime behavior', () => {
    const zero = clockInput(report('0.00 0.00'));
    assert.equal(zero, 0);
    assert.equal(refreshes(zero), 1, 'A genuine rollback still requests refresh');
    assert.equal(refreshes(zero, 100, 8), 0, 'A new connection generation is not an old-device reboot');
    const increasing = clockInput(report('101.25 999'));
    assert.equal(increasing, 101.25);
    assert.equal(refreshes(increasing), 0);
});

test('imported uptime remains displayable but cannot act as live reboot evidence', () => {
    const snapshot = report('42.50 999');
    assert.equal(summarize(snapshot).uptime, '0h 0m');
    assert.equal(clockInput(snapshot, true), null);
    assert.equal(refreshes(clockInput(snapshot, true)), 0);
});

test('unknown overview readings preserve exact raw report data and useful sibling identity', () => {
    const snapshot = report(' \t\r\n');
    snapshot.results.push({ ...snapshot.results[0], id: 'identity', stdout: 'Linux\nretained-host\nkernel\narm64' });
    const before = JSON.stringify(snapshot);
    const summary = summarize(snapshot);
    assert.equal(summary.uptime, 'Unavailable');
    assert.equal(summary.hostname, 'retained-host');
    assert.equal(summary.architecture, 'arm64');
    assert.equal(JSON.stringify(snapshot), before);
});
