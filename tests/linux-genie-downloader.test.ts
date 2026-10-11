import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGeniePackage } from '../scripts/lib/genie-package.mjs';

const linux = process.platform === 'linux' && process.getuid?.() !== 0;
const uuid = 'diagnostic-hub-genie@diagnostichub.desktop';
const version = '1.2.3-test.1';
const commit = 'a'.repeat(40);
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture(
    options: {
        missingBus?: boolean;
        missingSudo?: boolean;
        legacy?: boolean;
        wrongFormat?: boolean;
    } = {},
) {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-genie-download-'));
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(
        path.join(root, 'os-release'),
        `ID=ubuntu\nVERSION_ID=${options.legacy ? '22.04' : '24.04'}\n`,
    );
    // Redirect only the OS release fixture, retaining the production flow and all guards.
    const source = await readFile('public/download-run.sh', 'utf8');
    assert.equal(source.match(/\/etc\/os-release/g)?.length, 2);
    await writeFile(
        path.join(root, 'download.sh'),
        source.replaceAll('/etc/os-release', path.join(root, 'os-release')),
    );
    const appName = 'Diagnostic-Hub-linux-x64.AppImage';
    const zipName = `Diagnostic-Hub-Genie${options.legacy ? '-Legacy42' : ''}-${version}.zip`;
    const payload = '#!/bin/bash\nprintf "%s" "$*" > "$HUB_TEST_ROOT/launched"\n';
    const packaged = await createGeniePackage(
        path.resolve('.'),
        version,
        commit,
        options.legacy && !options.wrongFormat ? 'legacy42' : 'modern',
    );
    await writeFile(path.join(root, appName), payload);
    await writeFile(path.join(root, zipName), packaged.zip);
    await writeFile(path.join(root, appName + '.sha256'), `${sha(payload)}  ${appName}\n`);
    await writeFile(path.join(root, zipName + '.sha256'), `${sha(packaged.zip)}  ${zipName}\n`);
    await writeFile(
        path.join(root, 'linux-build-info.json'),
        JSON.stringify({
            version,
            commit,
            assets: { [appName]: sha(payload), [zipName]: sha(packaged.zip) },
        }),
    );
    await writeFile(
        path.join(root, 'settings'),
        JSON.stringify({ enabled: ['other@fixture'], disabled: false }),
    );
    const script = async (name: string, body: string, node = false) =>
        writeFile(path.join(bin, name), `#!${node ? process.execPath : '/bin/bash'}\n${body}\n`, {
            mode: 0o755,
        });
    for (const tool of [
        'bash',
        'sha256sum',
        'mktemp',
        'mkdir',
        'cat',
        'chmod',
        'mv',
        'rm',
        'sort',
        'uname',
        'python3',
        'tar',
        'find',
        'dirname',
        'grep',
        'sed',
        'head',
    ]) {
        const executable = spawnSync('/bin/bash', ['-c', 'command -v "$1"', '_', tool], {
            encoding: 'utf8',
        }).stdout.trim();
        await symlink(executable, path.join(bin, tool));
    }
    await script(
        'curl',
        `const fs=require('node:fs'),path=require('node:path'); const args=process.argv.slice(2),url=args.at(-1),name=path.basename(url),root=process.env.HUB_TEST_ROOT;
fs.appendFileSync(root+'/requests',url+'\\n'); if(process.env.HUB_TEST_NETWORK_FAILURE && name.includes('Genie')) process.exit(22);
const content=fs.readFileSync(root+'/'+name); fs.writeFileSync(args[args.indexOf('--output')+1],content);`,
        true,
    );
    await script(
        'gsettings',
        `const fs=require('node:fs'),p=process.env.HUB_TEST_ROOT+'/settings',s=JSON.parse(fs.readFileSync(p)),a=process.argv.slice(2);if(a[0]==='get') console.log(a[2]==='disable-user-extensions'?String(s.disabled):JSON.stringify(s.enabled));else {if(a[2]!=='enabled-extensions')process.exit(99);s.enabled=JSON.parse(a[3].replaceAll("'",'"'));fs.writeFileSync(p,JSON.stringify(s));}`,
        true,
    );
    await script('gnome-extensions', 'printf "%s\\n" "$*" >> "$HUB_TEST_ROOT/extension-commands"');
    const bus = `if [[ "$*" == *ShellVersion* ]]; then printf "(<'%s.0'>,)\\n" "\${HUB_TEST_SHELL:-46}"; else exit 1; fi`;
    await writeFile(path.join(root, 'bus-script'), '#!/bin/bash\n' + bus + '\n', { mode: 0o755 });
    if (!options.missingBus) await symlink(path.join(root, 'bus-script'), path.join(bin, 'gdbus'));
    await script('gnome-shell', 'echo "GNOME Shell 46.0"');
    await script(
        'apt-get',
        'printf "%s" "$*" > "$HUB_TEST_ROOT/apt"; [[ ${HUB_TEST_APT_FAIL:-0} != 1 ]] || exit 1; [[ ${HUB_TEST_RECHECK_FAIL:-0} != 1 ]] || exit 0; ln -s "$HUB_TEST_ROOT/bus-script" "$HUB_TEST_ROOT/bin/gdbus"',
    );
    // ln is used only by the fake apt utility.
    await symlink('/bin/ln', path.join(bin, 'ln'));
    if (!options.missingSudo) await script('sudo', '[[ "$1" == apt-get ]] || exit 99; exec "$@"');
    const run = (args: string[] = [], answer?: string, extra: Record<string, string> = {}) => {
        const base = [
            'bash',
            path.join(root, 'download.sh'),
            '--version',
            'v' + version,
            '--directory',
            path.join(root, 'download'),
            ...args,
        ];
        return spawnSync(
            answer === undefined ? '/usr/bin/setsid' : '/usr/bin/script',
            answer === undefined
                ? ['--fork', '--wait', ...base]
                : [
                      '-q',
                      '-e',
                      '-c',
                      base.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' '),
                      '/dev/null',
                  ],
            {
                input: answer === undefined ? undefined : answer + '\n',
                encoding: 'utf8',
                timeout: 20_000,
                env: {
                    ...process.env,
                    PATH: bin,
                    HUB_TEST_ROOT: root,
                    XDG_DATA_HOME: path.join(root, 'data'),
                    XDG_CURRENT_DESKTOP: 'GNOME',
                    DISPLAY: ':99',
                    ...extra,
                },
            },
        );
    };
    return { root, zipName, run, close: () => rm(root, { recursive: true, force: true }) };
}

test(
    'optional Genie consent, activation preferences and repeat setup use the verified release',
    { skip: !linux },
    async () => {
        const item = await fixture();
        try {
            const declined = item.run([], 'n');
            assert.equal(declined.status, 0, declined.stdout + declined.stderr);
            assert.match(declined.stdout, /Set up Genie\? \[y\/N\]/);
            await assert.rejects(
                readFile(path.join(item.root, 'data/gnome-shell/extensions', uuid, 'managed.json')),
            );
            const accepted = item.run([], 'y');
            assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
            assert.match(accepted.stdout, /pending activation/);
            const record = JSON.parse(
                await readFile(
                    path.join(item.root, 'data/gnome-shell/extensions', uuid, 'managed.json'),
                    'utf8',
                ),
            );
            assert.equal(record.build.commit, commit);
            const settings = JSON.parse(await readFile(path.join(item.root, 'settings'), 'utf8'));
            assert.deepEqual(settings.enabled, ['other@fixture', uuid]);
            const repeat = item.run([], 'y');
            assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
            assert.doesNotMatch(repeat.stdout, /Set up Genie/);
            await writeFile(
                path.join(item.root, 'settings'),
                JSON.stringify({ enabled: ['other@fixture'], disabled: false }),
            );
            assert.match(item.run().stdout, /disabled by your preference/);
            const removed = item.run(['--remove-genie']);
            assert.equal(removed.status, 0, removed.stderr);
            assert.match(removed.stdout, /removed/);
            await readFile(path.join(item.root, 'download/Diagnostic-Hub-linux-x64.AppImage'));
            assert.deepEqual(
                JSON.parse(await readFile(path.join(item.root, 'settings'), 'utf8')).enabled,
                ['other@fixture'],
            );
        } finally {
            await item.close();
        }
    },
);

test(
    'optional setup falls back without desktop changes on skipped, unsupported, corrupt and unavailable releases',
    { skip: !linux },
    async () => {
        for (const scenario of [
            'no-tty',
            'no-genie',
            'download-only',
            'old-shell',
            'network',
            'corrupt',
        ]) {
            const item = await fixture();
            try {
                if (scenario === 'corrupt')
                    await writeFile(path.join(item.root, item.zipName), 'corrupt');
                const args =
                    scenario === 'no-genie'
                        ? ['--no-genie']
                        : scenario === 'download-only'
                          ? ['--download-only']
                          : [];
                const extra: Record<string, string> =
                    scenario === 'old-shell'
                        ? { HUB_TEST_SHELL: '42' }
                        : scenario === 'network'
                          ? { HUB_TEST_NETWORK_FAILURE: '1' }
                          : {};
                const result = item.run(args, scenario === 'no-tty' ? undefined : 'y', extra);
                assert.equal(result.status, 0, scenario + result.stdout + result.stderr);
                assert.doesNotMatch(result.stdout, /Set up Genie/);
                await assert.rejects(
                    readFile(
                        path.join(item.root, 'data/gnome-shell/extensions', uuid, 'managed.json'),
                    ),
                );
                if (scenario !== 'download-only')
                    assert.equal(
                        await readFile(path.join(item.root, 'launched'), 'utf8'),
                        '--appimage-extract-and-run',
                    );
            } finally {
                await item.close();
            }
        }
    },
);

test(
    'missing optional packages need consent, bounded elevation and a successful utility recheck',
    { skip: !linux },
    async () => {
        for (const scenario of [
            'accepted',
            'declined',
            'no-sudo',
            'apt-failed',
            'recheck-failed',
        ]) {
            const item = await fixture({ missingBus: true, missingSudo: scenario === 'no-sudo' });
            try {
                const result = item.run(
                    [],
                    scenario === 'declined' ? 'n' : 'y',
                    scenario === 'apt-failed'
                        ? { HUB_TEST_APT_FAIL: '1' }
                        : scenario === 'recheck-failed'
                          ? { HUB_TEST_RECHECK_FAIL: '1' }
                          : {},
                );
                assert.equal(result.status, 0, scenario + result.stdout + result.stderr);
                await readFile(path.join(item.root, 'launched'));
                if (scenario === 'accepted') {
                    assert.equal(
                        await readFile(path.join(item.root, 'apt'), 'utf8'),
                        'install -y libglib2.0-bin',
                    );
                    await readFile(
                        path.join(item.root, 'data/gnome-shell/extensions', uuid, 'managed.json'),
                    );
                } else
                    await assert.rejects(
                        readFile(
                            path.join(
                                item.root,
                                'data/gnome-shell/extensions',
                                uuid,
                                'managed.json',
                            ),
                        ),
                    );
                if (scenario === 'declined' || scenario === 'no-sudo')
                    await assert.rejects(readFile(path.join(item.root, 'apt')));
            } finally {
                await item.close();
            }
        }
    },
);

test(
    'ordinary GNOME 42 setup offers and verifies the legacy ZIP, repeats without another prompt',
    { skip: !linux },
    async () => {
        const item = await fixture({ legacy: true });
        try {
            const installed = item.run([], 'y', { HUB_TEST_SHELL: '42' });
            assert.equal(installed.status, 0, installed.stdout + installed.stderr);
            const record = JSON.parse(
                await readFile(
                    path.join(item.root, 'data/gnome-shell/extensions', uuid, 'managed.json'),
                    'utf8',
                ),
            );
            assert.equal(record.build.format, 'legacy42');
            assert.match(installed.stdout, /Set up Genie/);
            const repeat = item.run([], 'y', { HUB_TEST_SHELL: '42' });
            assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
            assert.doesNotMatch(repeat.stdout, /Set up Genie/);
            assert.deepEqual(
                JSON.parse(
                    await readFile(
                        path.join(item.root, 'data/gnome-shell/extensions', uuid, 'managed.json'),
                        'utf8',
                    ),
                ),
                record,
            );
            assert.match(
                await readFile(path.join(item.root, 'requests'), 'utf8'),
                /Genie-Legacy42/,
            );
        } finally {
            await item.close();
        }
        const wrong = await fixture({ legacy: true, wrongFormat: true });
        try {
            const result = wrong.run([], 'y', { HUB_TEST_SHELL: '42' });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stdout + result.stderr, /identity mismatch/);
            await assert.rejects(
                readFile(
                    path.join(wrong.root, 'data/gnome-shell/extensions', uuid, 'managed.json'),
                ),
            );
            assert.ok(
                (await readFile(path.join(wrong.root, 'launched'), 'utf8')).includes(
                    '--appimage-extract-and-run',
                ),
            );
        } finally {
            await wrong.close();
        }
    },
);
