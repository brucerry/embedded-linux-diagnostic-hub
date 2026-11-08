import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const available = spawnSync(bash, ['--version'], { windowsHide: true }).status === 0;
const shellPath = (p: string) =>
    process.platform === 'win32'
        ? p.replace(/^([A-Za-z]):/, (_, d: string) => '/' + d.toLowerCase()).replaceAll('\\', '/')
        : p;
const source = readFileSync('public/download-run.sh', 'utf8');
const guards = source.slice(
    source.indexOf('# BEGIN GUARDED PATHS'),
    source.indexOf('# END GUARDED PATHS'),
);
const inventory = source.slice(
    source.indexOf('hub_bounded_tar_listing() {'),
    source.indexOf('\ndesktop_available=0'),
);
function archive(entries: { name: string; type?: string; mode?: string }[]) {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
        const header = Buffer.alloc(512);
        header.write(entry.name, 0, 100);
        header.write(entry.mode || '0000755\0', 100);
        header.write('0000000\0', 108);
        header.write('0000000\0', 116);
        header.write('00000000000\0', 124);
        header.write('00000000000\0', 136);
        header.fill(32, 148, 156);
        header.write(entry.type || '0', 156);
        if (entry.type === '2') header.write('../outside', 157);
        header.write('ustar\0', 257);
        header.write('00', 263);
        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(header);
    }
    return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test(
    'Linux portable tar inventory accepts plain files and rejects links, escaping paths, duplicate names, devices and special modes',
    { skip: !available || process.platform === 'darwin' },
    async () => {
        for (const [name, entries, valid] of [
            [
                'plain',
                [
                    { name: 'bundle/', type: '5' },
                    { name: 'bundle/AppRun' },
                    { name: 'bundle/diagnostic-hub' },
                ],
                true,
            ],
            ['link', [{ name: 'bundle/AppRun', type: '2' }], false],
            ['parent', [{ name: '../escape' }], false],
            ['absolute', [{ name: '/absolute' }], false],
            ['duplicate', [{ name: 'bundle/AppRun' }, { name: 'bundle/AppRun' }], false],
            ['device', [{ name: 'device', type: '3' }], false],
            ['setuid', [{ name: 'bundle/AppRun', mode: '0004755\0' }], false],
        ] as const) {
            const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hub-linux-tar-')));
            try {
                await writeFile(path.join(root, 'module.sh'), guards + '\n' + inventory);
                await writeFile(path.join(root, 'payload.tar.gz'), archive([...entries]));
                const result = spawnSync(
                    bash,
                    [
                        '-c',
                        'set -euo pipefail; source "$1/module.sh"; staged="$1"; asset=payload.tar.gz; hub_track_directory_path "$staged"; hub_validate_portable_tar',
                        'tar-test',
                        shellPath(root),
                    ],
                    { encoding: 'utf8', timeout: 15000, windowsHide: true },
                );
                assert.equal(
                    result.status === 0,
                    valid,
                    name + ': ' + result.stdout + result.stderr,
                );
            } finally {
                assert.equal(path.dirname(root), await realpath(tmpdir()));
                assert.match(path.basename(root), /^hub-linux-tar-/);
                assert.equal((await lstat(root)).isSymbolicLink(), false);
                await rm(root, { recursive: true, force: true });
            }
        }
    },
);
