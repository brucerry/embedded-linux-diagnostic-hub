import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyExit, validateConnection } from '../backend/ssh/session';
import {
    formatUptime,
    parseFilesystems,
    parseMemory,
    parseRelease,
    summarize,
} from '../shared/diagnostics/metrics';
import { probes } from '../shared/diagnostics/probes';
import { createReport, parseReport, validateSnapshot } from '../shared/report';
import { webBase } from '../vite.config.mts';
import { demoSnapshot } from './fixtures/snapshots';

test('memory usage uses MemAvailable and does not substitute MemFree when missing', () => {
    const memory = parseMemory('MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\n');
    assert.equal(memory.usedPercent, 40);
    assert.equal(memory.free, 100);
    assert.equal(parseMemory('MemTotal: 1000 kB\nMemFree: 100 kB\n').usedPercent, null);
    assert.equal(parseMemory('').usedPercent, null);
});

test('POSIX df handles mount paths containing spaces and ignores malformed records', () => {
    const fs = parseFilesystems(
        'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 850 150 85% /media/test drive\ninvalid\n',
    );
    assert.equal(fs.length, 1);
    assert.equal(fs[0].mount, '/media/test drive');
    assert.equal(fs[0].percent, 85);
});

test('OpenWrt read-only ROM and duplicate overlay mounts do not produce spurious findings', () => {
    const summary = summarize(demoSnapshot('openwrt'));
    assert.equal(summary.findings.length, 1);
    assert.equal(summary.findings[0].title, 'Low space on /overlay');
    assert.equal(summary.memory.usedPercent, 36);
    assert.equal(summary.architecture, 'aarch64');
});

test('failed evidence is not parsed as a valid metric or distribution', () => {
    const snapshot = demoSnapshot();
    snapshot.results.find((item) => item.id === 'memory')!.status = 'error';
    assert.equal(summarize(snapshot).memory.usedPercent, null);
    assert.equal(formatUptime(''), 'Unavailable');
    assert.equal(formatUptime('90061.5 0'), '1d 1h 1m');
    assert.equal(parseRelease('DISTRIB_DESCRIPTION="OpenWrt Custom"'), 'OpenWrt Custom');
});

test('connection boundary rejects invalid hosts, ports, credentials and auth modes', () => {
    const valid = { host: '192.168.1.1', port: 22, username: 'root', auth: 'password' as const };
    assert.equal(validateConnection(valid).host, valid.host);
    assert.equal(validateConnection({ ...valid, host: '::1' }).host, '::1');
    for (const input of [
        null,
        { ...valid, host: 'ssh://device' },
        { ...valid, port: 0 },
        { ...valid, port: 22.5 },
        { ...valid, port: 65536 },
        { ...valid, username: 'root; reboot' },
        { ...valid, password: {} },
        { ...valid, auth: 'agent' },
    ]) {
        assert.throws(() => validateConnection(input));
    }
});

test('unsupported capability and permission failure have distinct statuses', () => {
    assert.equal(classifyExit(127), 'unavailable');
    assert.equal(classifyExit(1), 'error');
    assert.equal(classifyExit(null), 'error');
    assert.equal(classifyExit(0), 'collected');
});

test('report retains source, exact commands and evidence without connection secrets', () => {
    const report = createReport(demoSnapshot());
    assert.equal(report.mode, 'demo');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.diagnostics.length, probes.length);
    assert.equal(report.diagnostics[0].command, probes[0].command);
    assert.equal('password' in report, false);
    assert.equal('privateKey' in report, false);
});

test('every read-only command parses as POSIX sh', { skip: process.platform === 'win32' }, () => {
    for (const probe of probes) execFileSync('/bin/sh', ['-n', '-c', probe.command]);
});

test('report import rejects duplicate IDs, invalid statuses, timestamps and oversized evidence', () => {
    const snapshot = demoSnapshot();
    assert.equal(parseReport(JSON.stringify(createReport(snapshot))).results.length, probes.length);
    assert.throws(() => parseReport('{broken'), /not valid JSON/);
    for (const mutate of [
        (data: typeof snapshot) => {
            data.results[1].id = data.results[0].id;
        },
        (data: typeof snapshot) => {
            data.results[0].status = 'error';
        },
        (data: typeof snapshot) => {
            data.capturedAt = 'not-a-date';
        },
        (data: typeof snapshot) => {
            data.results[0].stdout = 'x'.repeat(262145);
        },
    ]) {
        const data = structuredClone(snapshot);
        mutate(data);
        assert.throws(() => validateSnapshot(data));
    }
});

test('older reports keep their exact commands and mark newly added checks as not collected', () => {
    const snapshot = demoSnapshot();
    snapshot.results = snapshot.results.slice(0, 2);
    snapshot.results[0].command = 'uname -a # recorded by an earlier version';
    const imported = validateSnapshot(snapshot);
    assert.equal(imported.results[0].command, snapshot.results[0].command);
    assert.equal(imported.results.find((item) => item.id === 'flash')?.status, 'unavailable');
    assert.match(imported.results.find((item) => item.id === 'flash')!.stderr, /not collected/);
    assert.throws(() => validateSnapshot(snapshot, true));
});

test('Pages base paths handle project sites, account sites and a custom-domain override', () => {
    assert.equal(
        webBase('brucerry/embedded-linux-diagnostic-hub'),
        '/embedded-linux-diagnostic-hub/',
    );
    assert.equal(webBase('brucerry/brucerry.github.io'), '/');
    assert.equal(webBase(undefined), '/');
    assert.equal(webBase('owner/project', '/'), '/');
});

// Regression: CPU/Wi-Fi hwmon names alone must not count as current sensors.
test(
    'sensor names require a measurement channel and OpenWrt buttons have a DT fallback',
    { skip: process.platform === 'win32' },
    () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'hub-hardware-'));
        try {
            const sensor = path.join(directory, 'hwmon0');
            mkdirSync(sensor);
            writeFileSync(path.join(sensor, 'name'), 'cpu_thermal\n');
            const command = probes
                .find((probe) => probe.id === 'current')!
                .command.replaceAll('/sys/class/hwmon/hwmon*', `${directory}/hwmon*`);
            const absent = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
            assert.equal(absent.status, 127);
            assert.match(absent.stdout, /cpu_thermal/);
            writeFileSync(path.join(sensor, 'curr1_input'), '1300\n');
            const present = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
            assert.equal(present.status, 0);
            assert.match(present.stdout, /curr1_input=1300/);
            const keys = path.join(directory, 'gpio-keys', 'button-reset');
            mkdirSync(keys, { recursive: true });
            writeFileSync(path.join(keys, 'label'), 'reset\0');
            const buttons = probes
                .find((probe) => probe.id === 'buttons')!
                .command.replace('/proc/bus/input/devices', `${directory}/no-input`)
                .replace('/proc/bus/input/devices', `${directory}/no-input`)
                .replaceAll('/sys/firmware/devicetree/base', directory);
            const inventory = spawnSync('/bin/sh', ['-c', buttons], { encoding: 'utf8' });
            assert.equal(inventory.status, 0);
            assert.match(inventory.stdout, /label=reset\n/);
            assert.ok(!inventory.stdout.includes('\0'));
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    },
);

test('a cleared overview has no numeric readings, load averages or findings', () => {
    const summary = summarize(null);
    assert.equal(summary.memory.usedPercent, null);
    assert.deepEqual(summary.load, []);
    assert.deepEqual(summary.filesystems, []);
    assert.deepEqual(summary.findings, []);
    assert.equal(summary.uptime, 'Unavailable');
});
