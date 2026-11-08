import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseMemory,
    parseFilesystems,
    formatMemoryDetail,
    summarize,
} from '../shared/diagnostics/metrics';
import { graphReadings, evidenceTable } from '../shared/diagnostics/presentation';
import { createReport, parseReport } from '../shared/report';
import type { ProbeResult, Snapshot } from '../shared/types';

const header = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n';
const huge = '9'.repeat(400);
const unsafe = '9007199254740992';
const result = (
    id: string,
    stdout: string,
    status: ProbeResult['status'] = 'collected',
): ProbeResult => ({
    id,
    stdout,
    status,
    stderr: '',
    exitCode: status === 'collected' ? 0 : 127,
    durationMs: 1,
    collectedAt: '2026-11-04T00:00:00.000Z',
    truncated: false,
});
const report = (...results: ProbeResult[]) => ({ results }) as Snapshot;

test('ordinary meminfo counters preserve exact values, zero and MemAvailable-based usage', () => {
    const memory = parseMemory(
        'MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\nSwapTotal: 4096 kB\nSwapFree: 0 kB\n',
    );
    assert.deepEqual(memory, {
        total: 1000,
        available: 600,
        free: 100,
        usedPercent: 40,
        swapTotal: 4096,
        swapFree: 0,
    });
    assert.equal(
        parseMemory('MemTotal: 1000 kB\nMemFree: 100 kB').usedPercent,
        null,
        'MemFree must not substitute for missing MemAvailable in used percentage',
    );
    assert.equal(parseMemory('').usedPercent, null);
    assert.equal(parseMemory('MemTotal: 1000 kB\nMemAvailable: 0 kB').usedPercent, 100);
});

test('unrepresentable memory counters remain unknown while valid siblings survive', () => {
    for (const token of [huge, unsafe]) {
        const memory = parseMemory(
            `MemTotal: ${token} kB\nMemFree: 100 kB\nMemAvailable: ${token} kB\nSwapTotal: 4096 kB\nSwapFree: ${token} kB`,
        );
        assert.deepEqual(memory, {
            total: 0,
            available: null,
            free: 100,
            usedPercent: null,
            swapTotal: 4096,
            swapFree: null,
        });
        assert(Object.values(memory).every((v) => v === null || Number.isFinite(v)));
    }
    const memory = parseMemory('MemTotal: 9007199254740991 kB\nMemAvailable: 9007199254740991 kB');
    assert.equal(memory.total, Number.MAX_SAFE_INTEGER);
    assert.equal(
        memory.usedPercent,
        0,
        'The bound is numeric representation, not a hardware capacity limit',
    );
});

test('meminfo requires complete integer and kB unit tokens rather than accepting suffixes', () => {
    for (const line of [
        'MemTotal: 1000 kBjunk',
        'MemTotal: 1000 kB trailing',
        'MemTotal: 1e3 kB',
        'MemTotal: 0x10 kB',
        'MemTotal: +12 kB',
        'MemTotal: -1 kB',
        'MemTotal: 1.5 kB',
    ]) {
        const memory = parseMemory(line + '\nMemFree: 7 kB\n');
        assert.equal(memory.total, 0, line);
        assert.equal(memory.free, 7);
        assert.equal(memory.usedPercent, null);
    }
    assert.equal(parseMemory('MemTotal:\t001000\tkB  \r\n').total, 1000);
});

test('missing swap-free is not measured zero and does not invent a fully-used swap graph', () => {
    const missing = result('memory', 'SwapTotal: 4096 kB\n');
    assert.equal(parseMemory(missing.stdout).swapFree, null);
    assert.deepEqual(graphReadings('memory', missing), []);
    assert.deepEqual(
        graphReadings('memory', result('memory', missing.stdout + 'SwapFree: 0 kB')).map((r) => [
            r.key,
            r.value,
        ]),
        [
            ['swap:used', 4],
            ['swap:free', 0],
        ],
    );
});

test('contradictory free/available counters do not derive negative usage or replace valid siblings', () => {
    const memory = parseMemory(
        'MemTotal: 1000 kB\nMemAvailable: 1500 kB\nMemFree: 100 kB\nSwapTotal: 1000 kB\nSwapFree: 1500 kB',
    );
    assert.equal(memory.available, null);
    assert.equal(memory.usedPercent, null);
    assert.equal(memory.free, 100);
    assert.equal(memory.swapFree, null);
    assert.equal(
        parseMemory('MemTotal: 1000 kB\nMemFree: 1500 kB\nMemAvailable: 600 kB').free,
        null,
    );
    assert.equal(parseMemory('MemTotal: 1000 kB\nMemAvailable: 1000 kB').usedPercent, 0);
    assert.equal(
        parseMemory('MemFree: 100 kB').free,
        100,
        'A missing total does not discard an independent valid counter',
    );
});

test('memory detail distinguishes missing availability from literal measured zero', () => {
    assert.equal(
        formatMemoryDetail(parseMemory('MemTotal: 1024 kB')),
        'Availability unknown · 1 MiB total',
    );
    assert.equal(
        formatMemoryDetail(parseMemory('MemTotal: 1024 kB\nMemFree: 0 kB')),
        '0 MiB free of 1 MiB',
    );
    assert.equal(
        formatMemoryDetail(parseMemory('MemTotal: 4096 kB\nMemAvailable: 2048 kB')),
        '2 MiB available of 4 MiB',
    );
    assert.equal(formatMemoryDetail(parseMemory('')), 'Memory data unavailable');
});

test('ordinary POSIX df rows retain mount spaces and do not add a 100-percent clamp or accounting equality', () => {
    const values = parseFilesystems(
        header + '/dev/sda1 1000 850 100 85% /media/test drive\n/dev/root 1000 1100 0 110% /\n',
    );
    assert.equal(values.length, 2);
    assert.equal(values[0].mount, '/media/test drive');
    assert.equal(
        values[0].available,
        100,
        'Reserved blocks need not make used+available equal total',
    );
    assert.equal(values[1].percent, 110);
    assert.deepEqual(parseFilesystems(header + 'tmpfs 0 0 0 0% /empty'), [
        { name: 'tmpfs', total: 0, used: 0, available: 0, percent: 0, mount: '/empty' },
    ]);
});

test('unsafe df values in any numeric column omit only that derived row and retain valid siblings', () => {
    for (const token of [huge, unsafe])
        for (let column = 0; column < 4; column++) {
            const cells = ['1000', '850', '150', '85'];
            cells[column] = token;
            const text =
                header +
                `/dev/bad ${cells[0]} ${cells[1]} ${cells[2]} ${cells[3]}% /bad\n/dev/good 1000 100 900 10% /good\n`;
            const values = parseFilesystems(text);
            assert.equal(values.length, 1);
            assert.equal(values[0].mount, '/good');
            assert.deepEqual(values[0], {
                name: '/dev/good',
                total: 1000,
                used: 100,
                available: 900,
                percent: 10,
                mount: '/good',
            });
        }
});

test('malformed df numeric tokens cannot be partially parsed', () => {
    for (const token of ['1e3', '1000x', '+1000', '-1', '1.5'])
        assert.deepEqual(parseFilesystems(header + `/dev/root ${token} 1 2 3% /`), []);
    assert.deepEqual(parseFilesystems(header + '/dev/root 1000 1 2 3.5% /'), []);
    const values = parseFilesystems(header + '/dev/root 9007199254740991 0 0 0% /');
    assert.equal(values[0].total, Number.MAX_SAFE_INTEGER);
});

test('summary health findings use valid readings and never nonfinite or contradictory metrics', () => {
    const invalid = report(
        result('memory', `MemTotal: ${huge} kB\nMemAvailable: ${huge} kB`),
        result('storage', header + `/dev/root 1000 850 150 ${huge}% /`),
    );
    const summary = summarize(invalid);
    assert.equal(summary.memory.usedPercent, null);
    assert.deepEqual(summary.filesystems, []);
    assert.deepEqual(summary.findings, []);
    const valid = summarize(
        report(
            result('memory', 'MemTotal: 1000 kB\nMemAvailable: 100 kB'),
            result('storage', header + '/dev/root 1000 850 150 85% /'),
        ),
    );
    assert.equal(valid.memory.usedPercent, 90);
    assert.deepEqual(
        valid.findings.map((f) => f.probe),
        ['storage', 'memory'],
    );
});

test('normal RAM/swap graph units and OpenWrt overlay finding isolation remain unchanged', () => {
    assert.deepEqual(
        graphReadings(
            'memory',
            result(
                'memory',
                'MemTotal: 10240 kB\nMemFree: 2048 kB\nMemAvailable: 6144 kB\nSwapTotal: 4096 kB\nSwapFree: 1024 kB',
            ),
        ).map((r) => [r.key, r.value, r.unit]),
        [
            ['ram:used', 8, 'MiB'],
            ['ram:free', 2, 'MiB'],
            ['available', 6, 'MiB'],
            ['swap:used', 3, 'MiB'],
            ['swap:free', 1, 'MiB'],
        ],
    );
    const summary = summarize(
        report(
            result(
                'storage',
                header +
                    '/dev/rom 1000 950 50 95% /rom\noverlay 1000 900 100 90% /\n/dev/data 1000 900 100 90% /overlay',
            ),
        ),
    );
    assert.deepEqual(
        summary.findings.map((f) => f.title),
        ['Low space on /overlay'],
    );
});

test('derived rejection preserves exact raw evidence, string table values and useful siblings', () => {
    const memory = result('memory', `MemTotal: ${huge} kB\nMemFree: 100 kB`);
    const storage = result(
        'storage',
        header + `/dev/bad ${huge} 1 1 50% /bad\n/dev/good 1000 100 900 10% /good`,
    );
    const snapshot = report(
        memory,
        storage,
        result('identity', 'Linux\nretained-host\nkernel\narm64'),
    );
    const before = JSON.stringify(snapshot),
        summary = summarize(snapshot);
    assert.equal(summary.hostname, 'retained-host');
    assert.equal(summary.memory.free, 100);
    assert.equal(summary.filesystems[0].mount, '/good');
    assert(
        evidenceTable('memory', memory).rows.some(
            (row) => row[0] === 'MemTotal' && row[1] === huge,
        ),
    );
    graphReadings('memory', memory);
    graphReadings('storage', storage);
    assert.equal(JSON.stringify(snapshot), before);
    assert.equal(
        summarize(report(result('memory', memory.stdout, 'error'))).memory.usedPercent,
        null,
    );
});

test('JSON report round trips preserve raw evidence and schema while recomputing nullable derived summary', () => {
    const snapshot: Snapshot = {
        schemaVersion: 1,
        mode: 'ssh',
        endpoint: 'synthetic-device',
        username: 'tester',
        capturedAt: '2026-11-04T00:00:00.000Z',
        results: [result('memory', `MemTotal: ${huge} kB\nSwapTotal: 4096 kB`)],
    };
    const before = JSON.stringify(snapshot),
        exported = createReport(snapshot);
    assert.equal(exported.summary.memory.swapFree, null);
    const restored = parseReport(JSON.stringify(exported));
    assert.equal(restored.schemaVersion, 1);
    assert.equal(
        restored.results.find((r) => r.id === 'memory')?.stdout,
        snapshot.results[0].stdout,
    );
    const legacy = { ...exported, summary: { memory: { swapFree: 0 } } };
    const restoredLegacy = parseReport(JSON.stringify(legacy));
    assert.equal(
        createReport(restoredLegacy).summary.memory.swapFree,
        null,
        'Imported raw evidence, not a historical false-zero summary, remains authoritative',
    );
    assert.equal(JSON.stringify(snapshot), before);
});
