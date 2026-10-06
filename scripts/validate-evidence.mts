import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    evidencePresentation,
    LOG_COLUMNS,
    type EvidenceNode,
} from '../shared/diagnostics/evidence';
import { processResources, processTable } from '../shared/diagnostics/processes';
import { parseReport } from '../shared/report';

const file = process.argv[2];
if (!file)
    throw new Error(
        'Usage: npx tsx scripts/validate-evidence.mts /path/to/real-device-report.json',
    );
const snapshot = parseReport(await readFile(file, 'utf8'));
let tables = 0,
    trees = 0,
    raw = 0;
for (const result of snapshot.results) {
    const view = evidencePresentation(result.id, result);
    const preferred = view.tree ? 'tree' : view.table ? 'table' : 'raw';
    if (view.table) {
        tables++;
        assert(view.table.rows.every((row) => row.length === view.table!.columns.length));
    } else if (view.tree) trees++;
    else raw++;
    if (result.status !== 'collected') assert.equal(preferred, 'raw');
    console.log(
        `${result.id}: ${preferred}${view.table ? ` (${view.table.rows.length} rows)` : view.tree ? ` (${view.tree.length} groups)` : ''}`,
    );
}
const board = snapshot.results.find((r) => r.id === 'board');
if (board?.status === 'collected' && board.stdout.trim().startsWith('{')) {
    const parsed = JSON.parse(board.stdout);
    const rows = evidencePresentation('board', board).table!.rows;
    if (parsed.release?.version)
        assert(
            rows.some(
                ([key, value]) => key === 'release.version' && value === parsed.release.version,
            ),
        );
    if (parsed.model)
        assert(rows.some(([key, value]) => key === 'model' && value === parsed.model));
}
const services = snapshot.results.find((r) => r.id === 'services');
const processes = snapshot.results.find((r) => r.id === 'processes');
if (processes && processResources(processes)) {
    const parsed = processResources(processes)!;
    const table = processTable(processes)!;
    assert.equal(table.rows.length, parsed.records.length);
    assert(table.columns.includes('Resident MiB'));
    assert(parsed.records.some((r) => r.rss !== undefined && r.rss > 0));
    assert(parsed.records.some((r) => r.ticks !== undefined && r.start !== undefined));
    console.log(
        `Validated ${parsed.records.length} process resource records with kernel memory and CPU counters.`,
    );
}
if (services?.status === 'collected' && services.stdout.trim().startsWith('{')) {
    const tree = evidencePresentation('services', services).tree!;
    const keys = (nodes: EvidenceNode[]): string[] =>
        nodes.flatMap((node) => [node.key, ...keys(node.children ?? [])]);
    const paths = keys(tree);
    assert.equal(new Set(paths).size, paths.length);
    assert(tree.some((node) => node.children));
}
const logs = snapshot.results.find((r) => r.id === 'logs');
if (
    logs?.status === 'collected' &&
    /^\w{3} \w{3} +\d+ \d{2}:\d{2}:\d{2} \d{4} /m.test(logs.stdout)
) {
    const parsed = evidencePresentation('logs', logs).table!;
    assert.deepEqual(parsed.columns, LOG_COLUMNS);
    const actual = logs.stdout.trimEnd().split('\n');
    assert.equal(parsed.rows.length, actual.filter((line) => !/^\s+/.test(line)).length);
    for (const row of parsed.rows) {
        assert(row[0] || row[6] || row[7]);
        if (row[0]) assert.match(row[0], /^\d{4}-\d{2}-\d{2}$/);
        if (row[5]) assert.match(row[5], /^\d+$/);
    }
    console.log(
        `Validated ${parsed.rows.length} real OpenWrt log rows; ${parsed.rows.filter((row) => row[4]).length} program tags; ${parsed.rows.filter((row) => row[5]).length} explicit PIDs.`,
    );
}
console.log(
    `Evidence review passed: ${tables} tables, ${trees} trees, ${raw} raw/unavailable results.`,
);
