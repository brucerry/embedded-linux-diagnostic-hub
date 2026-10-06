import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { graphReadings, historyFrame } from '../shared/diagnostics/presentation';
import {
    PROCESS_COMMAND,
    processResources,
    processSample,
    processTable,
} from '../shared/diagnostics/processes';
import { searchDiagnostics } from '../shared/diagnostics/search';
import type { Probe, ProbeResult } from '../shared/types';
import { demoSnapshot } from './fixtures/snapshots';
const result = (stdout: string): ProbeResult => ({
    id: 'processes',
    status: 'collected',
    stdout,
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    collectedAt: '2026-10-06T00:00:00Z',
    truncated: false,
});
export const processFixture = (total: number, ticks: number, start = 200) =>
    `HUB_PROCESS_RESOURCES_V1\nSystemCPU: ${total}\nMemTotal: 102400 kB\nPID: 42\nName: daemon ) x\nState: S (sleeping)\nUid: 0 1000 0 0\nVmRSS: 10240 kB\nVmSize: 20480 kB\nVmSwap: 2048 kB\nThreads: 2\n42 (daemon ) x) ${Array.from({ length: 22 }, (_, i) => (i === 0 ? 'S' : i === 1 ? 1 : i === 11 ? ticks : i === 19 ? start : 0)).join(' ')}\nPID: 43\nName: kworker\nState: I (idle)\nUid: 0 0 0 0\nThreads: 1\n`;

test('process tables preserve kernel resource units and CPU sampling excludes PID reuse and missing fields', () => {
    const previous = processSample(result(processFixture(1000, 20)))!;
    const current = result(processFixture(1100, 30));
    const table = processTable(current, previous)!;
    assert.deepEqual(table.rows[0], [
        '42',
        'daemon ) x',
        '1000',
        'S (sleeping)',
        '10.00',
        '20.00',
        '10.00',
        '2.00',
        '2',
        '10.00',
    ]);
    assert.equal(table.rows[1][4], '');
    assert.equal(table.rows[1][9], '');
    assert.equal(processTable(current)!.rows[0][9], '');
    assert.equal(processTable(result(processFixture(1100, 30, 999)), previous)!.rows[0][9], '');
    assert.equal(processTable(result(processFixture(900, 30)), previous)!.rows[0][9], '');
    assert.equal(processTable(result(processFixture(1100, 10)), previous)!.rows[0][9], '');
    assert.equal(processResources(result('PID USER COMMAND\n1 root init')), undefined);
});

test(
    'the fixed procfs resource collector runs on Linux without extra tools or process control',
    { skip: process.platform === 'win32' },
    () => {
        const stdout = execFileSync('/bin/sh', ['-c', PROCESS_COMMAND], {
            encoding: 'utf8',
            timeout: 12000,
            maxBuffer: 262144,
        });
        const parsed = processResources(result(stdout))!;
        assert(parsed.totalTicks! > 0);
        assert(parsed.memoryTotal! > 0);
        const thisProcess = parsed.records.find((r) => r.pid === process.pid)!;
        assert(thisProcess.rss! > 0);
        assert(thisProcess.virtual! >= thisProcess.rss!);
        assert(thisProcess.ticks! >= 0);
        assert(thisProcess.start! > 0);
    },
);

test('used/free graph pairs share units, retain available memory and do not invent raw flash allocation', () => {
    const ram = graphReadings(
        'memory',
        result(
            'MemTotal: 10240 kB\nMemFree: 2048 kB\nMemAvailable: 6144 kB\nSwapTotal: 4096 kB\nSwapFree: 1024 kB',
        ),
    );
    assert.deepEqual(
        ram.map((r) => [r.key, r.value, r.unit]),
        [
            ['ram:used', 8, 'MiB'],
            ['ram:free', 2, 'MiB'],
            ['available', 6, 'MiB'],
            ['swap:used', 3, 'MiB'],
            ['swap:free', 1, 'MiB'],
        ],
    );
    assert.equal(graphReadings('memory', result('MemTotal: 1024 kB\nMemFree: 2048 kB')).length, 0);
    assert.equal(graphReadings('flash', result('/sys/class/mtd/mtd0/size=1048576')).length, 0);
    const snapshot = demoSnapshot('openwrt');
    const flash = snapshot.results.find((r) => r.id === 'flash')!;
    assert(graphReadings('flash', flash, snapshot).some((r) => r.series === 'free'));
    const frame = historyFrame(snapshot);
    assert.equal(frame.readings.storage[0].unit, 'MiB');
    assert.equal(frame.readings.storage[0].group, frame.readings.storage[1].group);
});

test('diagnostic search ranks exact, partial, related and weak matches and supports Unicode, synonyms, words and typos', () => {
    const make = (id: string, title: string): Probe => ({
        id,
        title,
        category: 'hardware',
        description: 'Registered attributes',
        command: 'true',
    });
    const items = [
        make('memori', 'Memori controller'),
        make('ddr', 'DRAM ECC'),
        make('memory-check', 'Memory check'),
        make('memory', 'Memory overview'),
    ];
    assert.deepEqual(
        searchDiagnostics(items, ' MEMORY ').map((r) => r.rank),
        [0, 1, 2, 3],
    );
    assert(
        searchDiagnostics(items, 'ram').some(
            (r) => r.probe.id === 'memory' && r.kind === 'Related match',
        ),
    );
    assert.equal(
        searchDiagnostics([make('i2c', 'I²C adapters & devices')], 'I2C')[0].kind,
        'Exact match',
    );
    assert.equal(searchDiagnostics(items, 'memroy').at(-1)?.kind, 'Very less match');
    assert.equal(searchDiagnostics(items, 'memory check')[0].probe.id, 'memory-check');
    assert.equal(searchDiagnostics(items, 'unrelated nonsense xyz').length, 0);
    assert.deepEqual(
        searchDiagnostics(items, '').map((r) => r.probe),
        items,
    );
});

test('process graphs plot explicit memory and interval CPU, retain process identities and skip missing readings', () => {
    const current = result(processFixture(1100, 30));
    const initial = graphReadings('processes', current);
    assert.deepEqual(
        initial.map((r) => [r.key, r.value, r.unit]),
        [
            ['process:42:200:rss', 10, 'MiB'],
            ['process:42:200:virtual', 20, 'MiB'],
            ['process:42:200:swap', 2, 'MiB'],
        ],
    );
    const first = historyFrame({ ...demoSnapshot(), results: [result(processFixture(1000, 20))] });
    const second = historyFrame({ ...demoSnapshot(), results: [current] }, first);
    assert.equal(second.readings.processes.find((r) => r.key.endsWith(':cpu'))?.value, 10);
    const reused = graphReadings(
        'processes',
        result(processFixture(1100, 30, 999)),
        undefined,
        first.processes,
    );
    assert(reused.every((r) => r.key.startsWith('process:42:999:')));
    assert(!reused.some((r) => r.key.endsWith(':cpu')));
    assert.equal(graphReadings('processes', { ...current, status: 'error' }).length, 0);
});
