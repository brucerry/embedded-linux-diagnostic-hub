import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const launcher = path.resolve('public/download-run.sh');

test(
    'Linux prerequisite installation requires explicit consent and rechecks libraries before launch',
    {
        skip:
            process.platform === 'win32' ||
            spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== 0,
    },
    async () => {
        for (const answer of ['n', 'y']) {
            const root = await mkdtemp(path.join(tmpdir(), 'hub-install-consent-'));
            try {
                const bin = path.join(root, 'bin');
                await mkdir(bin);
                const scripts = {
                    ldd: '[ -f "$HUB_TEST_ROOT/installed" ] || { echo "libnss3.so => not found"; exit 1; }',
                    sudo: 'exec "$@"',
                    'apt-get': 'printf "%s" "$*" > "$HUB_TEST_ROOT/installed"',
                };
                for (const [name, body] of Object.entries(scripts))
                    await writeFile(path.join(bin, name), '#!/bin/sh\n' + body + '\n', {
                        mode: 0o755,
                    });
                await writeFile(
                    path.join(root, 'diagnostic-hub'),
                    '#!/bin/sh\ntouch "$HUB_TEST_ROOT/launched"\n',
                    { mode: 0o755 },
                );
                const result = spawnSync(
                    'script',
                    ['-q', '-e', '-c', 'bash scripts/linux-launcher.sh', '/dev/null'],
                    {
                        input: answer + '\n',
                        encoding: 'utf8',
                        timeout: 10_000,
                        env: {
                            ...process.env,
                            PATH: bin + path.delimiter + process.env.PATH,
                            APPDIR: root,
                            HUB_TEST_ROOT: root,
                        },
                    },
                );
                assert.match(result.stdout, /Install these prerequisites now\? \[y\/N\]/);
                if (answer === 'y') {
                    assert.equal(result.status, 0, result.stdout + result.stderr);
                    assert.equal(
                        await readFile(path.join(root, 'installed'), 'utf8'),
                        'install libnss3',
                    );
                    await readFile(path.join(root, 'launched'));
                } else {
                    assert.notEqual(result.status, 0);
                    await assert.rejects(readFile(path.join(root, 'installed')));
                    await assert.rejects(readFile(path.join(root, 'launched')));
                }
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    },
);

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-download-test-'));
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const payload = '#!/usr/bin/env bash\nprintf "%s" "$*" > "$HUB_TEST_LAUNCH_MARKER"\n';
    await writeFile(path.join(root, 'payload'), payload);
    await writeFile(
        path.join(bin, 'uname'),
        '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo "${HUB_TEST_MACHINE:-x86_64}";; esac\n',
        { mode: 0o755 },
    );
    const hash = createHash('sha256').update(payload).digest('hex');
    await writeFile(
        path.join(bin, 'curl'),
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), url = args.at(-1), root = process.env.HUB_TEST_DOWNLOAD_ROOT;
fs.appendFileSync(root + '/requests', url + '\\n');
const name = 'Diagnostic-Hub-linux-x64.AppImage';
let content;
if (url.includes('/releases?')) {
    content = JSON.stringify([{prerelease:true, assets:[{browser_download_url:'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v0.1.0/' + name}]}]);
} else if (url.endsWith('.sha256')) {
    content = (process.env.HUB_TEST_CORRUPT ? '0'.repeat(64) : '${hash}') + '  ' + name + '\\n';
} else content = fs.readFileSync(root + '/payload');
if (args.includes('--output')) fs.writeFileSync(args[args.indexOf('--output') + 1], content);
else process.stdout.write(content);
`,
        { mode: 0o755 },
    );
    for (const tool of ['sudo', 'pkexec', 'su'])
        await writeFile(path.join(bin, tool), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    return {
        root,
        payload,
        run: (extra: string[] = [], env: Record<string, string> = {}) =>
            spawnSync('bash', [launcher, '--directory', path.join(root, 'download'), ...extra], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: bin + path.delimiter + process.env.PATH,
                    DISPLAY: ':99',
                    HUB_TEST_DOWNLOAD_ROOT: root,
                    HUB_TEST_LAUNCH_MARKER: path.join(root, 'launched'),
                    ...env,
                },
            }),
        close: () => rm(root, { recursive: true, force: true }),
    };
}

test(
    'Linux download-and-run selects engineering previews, verifies bytes, launches without elevation or FUSE',
    { skip: process.platform === 'win32' },
    async () => {
        const item = await fixture();
        try {
            const result = item.run();
            assert.equal(result.status, 0, result.stderr);
            assert.equal(
                await readFile(
                    path.join(item.root, 'download/Diagnostic-Hub-linux-x64.AppImage'),
                    'utf8',
                ),
                item.payload,
            );
            assert.equal(
                await readFile(path.join(item.root, 'launched'), 'utf8'),
                '--appimage-extract-and-run',
            );
            assert.match(result.stdout, /Verified v0.1.0/);
        } finally {
            await item.close();
        }
    },
);

test(
    'Linux downloader rejects corrupt bytes without replacing the last verified executable',
    { skip: process.platform === 'win32' },
    async () => {
        const item = await fixture();
        try {
            assert.equal(item.run(['--download-only']).status, 0);
            const result = item.run([], { HUB_TEST_CORRUPT: '1' });
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /checksum mismatch/);
            assert.equal(
                await readFile(
                    path.join(item.root, 'download/Diagnostic-Hub-linux-x64.AppImage'),
                    'utf8',
                ),
                item.payload,
            );
            await assert.rejects(readFile(path.join(item.root, 'launched')));
        } finally {
            await item.close();
        }
    },
);

test(
    'unsupported Linux architecture and unsafe version tags fail before network requests',
    { skip: process.platform === 'win32' },
    async () => {
        const item = await fixture();
        try {
            assert.notEqual(item.run(['--download-only'], { HUB_TEST_MACHINE: 'i686' }).status, 0);
            assert.notEqual(item.run(['--version', '../../escape', '--download-only']).status, 0);
            await assert.rejects(readFile(path.join(item.root, 'requests')));
        } finally {
            await item.close();
        }
    },
);

test(
    'Linux prerequisite launcher reports missing packages and does not install silently',
    { skip: process.platform === 'win32' },
    async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'hub-prerequisite-test-'));
        try {
            const bin = path.join(root, 'bin');
            await mkdir(bin);
            await writeFile(
                path.join(bin, 'ldd'),
                '#!/bin/sh\necho "libnss3.so => not found"; exit 1\n',
                { mode: 0o755 },
            );
            await writeFile(
                path.join(bin, 'apt-get'),
                '#!/bin/sh\necho "$*" > "$HUB_TEST_INSTALL_MARKER"\n',
                { mode: 0o755 },
            );
            await writeFile(
                path.join(bin, 'sudo'),
                '#!/bin/sh\necho forbidden > "$HUB_TEST_INSTALL_MARKER"; exit 99\n',
                { mode: 0o755 },
            );
            const result = spawnSync('bash', [path.resolve('scripts/linux-launcher.sh')], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: bin + path.delimiter + process.env.PATH,
                    APPDIR: root,
                    HUB_TEST_INSTALL_MARKER: path.join(root, 'installed'),
                },
            });
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /libnss3.so/);
            assert.match(result.stderr, /sudo apt-get install libnss3/);
            assert.match(
                result.stderr,
                /Only package installation may need administrator approval/,
            );
            await assert.rejects(readFile(path.join(root, 'installed')));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
