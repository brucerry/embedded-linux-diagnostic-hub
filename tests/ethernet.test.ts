import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { evidencePresentation } from '../shared/diagnostics/evidence';
import { summarize } from '../shared/diagnostics/metrics';
import { graphReadings } from '../shared/diagnostics/presentation';
import { probes } from '../shared/diagnostics/probes';
import { demoSnapshot } from './fixtures/snapshots';

test(
    'LAN invalid-argument reads preserve valid down/up interface evidence and warn without a failed probe',
    { skip: process.platform === 'win32' },
    () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'hub-lan-'));
        try {
            mkdirSync(path.join(directory, 'bin'));
            for (const [name, state] of [
                ['lan0', 'up'],
                ['lan1', 'down'],
            ]) {
                const device = path.join(directory, 'net', name);
                mkdirSync(path.join(device, 'statistics'), { recursive: true });
                writeFileSync(path.join(device, 'operstate'), state + '\n');
                writeFileSync(path.join(device, 'carrier'), '1\n');
                writeFileSync(path.join(device, 'statistics/rx_packets'), '123\n');
            }
            writeFileSync(
                path.join(directory, 'bin/cat'),
                '#!/bin/sh\ncase "$1" in */lan1/carrier) printf "cat: %s: %s\\n" "$1" "${HUB_TEST_READ_ERROR:-Invalid argument}" >&2; exit 1;; *) exec /bin/cat "$@";; esac\n',
                { mode: 0o700 },
            );
            const command = probes
                .find((p) => p.id === 'ethernet')!
                .command.replace('/sys/class/net/*', `${directory}/net/*`);
            const env = { ...process.env, PATH: `${directory}/bin:${process.env.PATH}` };
            const output = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env });
            assert.equal(output.status, 0);
            assert.match(output.stderr, /Warning: .*lan1\/carrier.*Invalid argument/);
            assert.ok(!output.stdout.includes('lan1/carrier='));
            assert.match(output.stdout, /lan0\/carrier=1\n/);
            assert.match(output.stdout, /lan1\/operstate=down\n/);
            const snapshot = demoSnapshot();
            const result = snapshot.results.find((r) => r.id === 'ethernet')!;
            Object.assign(result, {
                status: 'collected',
                exitCode: 0,
                stdout: output.stdout,
                stderr: output.stderr,
            });
            const table = evidencePresentation('ethernet', result).table!;
            assert.ok(
                table.rows.some((row) => row[0].endsWith('lan1/operstate') && row[1] === 'down'),
            );
            assert.equal(
                graphReadings('ethernet', result).filter((r) => r.key.endsWith('rx_packets'))
                    .length,
                2,
            );
            const finding = summarize(snapshot).findings.find((f) => f.probe === 'ethernet')!;
            assert.equal(finding.level, 'warning');
            assert.equal(finding.title, 'LAN: some attributes unavailable');
            // Unexpected permission/runtime errors must not be silently reclassified as success.
            const denied = spawnSync('/bin/sh', ['-c', command], {
                encoding: 'utf8',
                env: { ...env, HUB_TEST_READ_ERROR: 'Permission denied' },
            });
            assert.equal(denied.status, 1);
            assert.match(denied.stderr, /Permission denied/);
            rmSync(path.join(directory, 'net/lan0'), { recursive: true });
            rmSync(path.join(directory, 'net/lan1/operstate'));
            rmSync(path.join(directory, 'net/lan1/statistics'), { recursive: true });
            const none = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env });
            assert.equal(none.status, 127);
            assert.equal(none.stdout, '');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    },
);
