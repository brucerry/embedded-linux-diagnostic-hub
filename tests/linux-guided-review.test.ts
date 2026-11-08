import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
    access,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';

const bash =
    process.platform === 'win32'
        ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe')
        : '/bin/bash';
const available = spawnSync(bash, ['--version'], { windowsHide: true }).status === 0;
const shellPath = (value: string) =>
    process.platform === 'win32'
        ? value.replace(/^[A-Za-z]:/, (value) => '/' + value[0].toLowerCase()).replaceAll('\\', '/')
        : value;
const helper = path.resolve('public/download-run.sh');
const source = readFileSync(helper, 'utf8');
function section(begin: string, end: string) {
    const first = source.indexOf(begin),
        last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first);
    return source.slice(first, last);
}
const jsonModule = section('# BEGIN LINUX METADATA', '# END LINUX METADATA');
const reviewModule = section('# BEGIN LINUX GUIDED REVIEW', '# END LINUX GUIDED REVIEW');
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const asset = 'Diagnostic-Hub-linux-x64.AppImage';
const commit = 'a'.repeat(40);

async function fixture(format = 'AppImage') {
    const asset = 'Diagnostic-Hub-linux-x64.' + format;
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hub-linux-guided-')));
    const bin = path.join(root, 'bin'),
        scratch = path.join(root, 'temporary'),
        output = path.join(
            root,
            process.platform === 'win32'
                ? "output ' 茶 & literal $(not-a-command)"
                : "output ' 茶 & <literal> $(not-a-command)",
        );
    await mkdir(bin);
    await mkdir(scratch);
    const payload = '#!/usr/bin/env bash\nprintf "%s" "$*" > "$HUB_LINUX_FIXTURE_ROOT/launched"\n';
    for (const [name, content] of Object.entries({
        payload,
        checksum: sha(payload) + '  ' + asset + '\n',
        release: JSON.stringify({ tag_name: 'v0.6.0', draft: false, target_commitish: commit }),
        metadata: JSON.stringify({
            version: '0.6.0',
            platform: 'linux',
            arch: 'x64',
            commit,
            assets: { [asset]: sha(payload) },
        }),
        listing: JSON.stringify([
            {
                prerelease: true,
                assets: [
                    {
                        browser_download_url:
                            'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v0.6.0/' +
                            asset,
                    },
                ],
            },
        ]),
        'json-module.sh': jsonModule,
        'review-module.sh': reviewModule,
        'review.txt': 'Literal review fixture',
    }))
        await writeFile(path.join(root, name), content);
    const shims = {
        uname: 'case "$1" in -s) printf Linux;; -m) printf "%s" "${HUB_LINUX_FIXTURE_MACHINE:-x86_64}";; esac',
        curl: [
            'output=""; url=""; write_status=0',
            'while [ "$#" -gt 0 ]; do case "$1" in --write-out) write_status=1; shift 2;; --output) output="$2"; shift 2;; https:*) url="$1"; shift;; *) shift;; esac; done',
            'printf "%s\\n" "$url" >> "$HUB_LINUX_FIXTURE_ROOT/requests"',
            'case "$url" in *releases[?]*) file=listing;; *releases/tags/*) file=release;; */linux-build-info.json) file=metadata;; *.sha256) file=checksum;; *) file=payload;; esac',
            'if [ "${HUB_LINUX_FIXTURE_MISSING:-none}" = "$file" ]; then [ "$write_status" != 1 ] || printf 404; exit 22; fi',
            'if [ "${HUB_LINUX_FIXTURE_DAMAGED:-none}" = "$file" ]; then printf partial > "$output"; [ "$write_status" != 1 ] || printf 200; exit 18; fi',
            'cp "$HUB_LINUX_FIXTURE_ROOT/$file" "$output"',
            '[ "$write_status" != 1 ] || printf 200',
        ].join('\n'),
        zenity: [
            'printf "%s\\n" "$@" > "$HUB_LINUX_FIXTURE_ROOT/zenity-args"',
            '[ "$HUB_LINUX_FIXTURE_CHANNEL" = zenity ] || exit 255',
            'if [ "${HUB_LINUX_FIXTURE_SWAP_PARENT:-0}" = 1 ]; then mv -- "$HUB_LINUX_FIXTURE_ROOT/reviewed-parent" "$HUB_LINUX_FIXTURE_ROOT/original-parent"; mkdir -- "$HUB_LINUX_FIXTURE_ROOT/reviewed-parent"; fi',
            'case "$HUB_LINUX_FIXTURE_CHOICE" in save) printf "Save portable package\\n";; open) printf "Save portable package and Open\\n";; cancel) exit 1;; timeout) exit 5;; *) exit 255;; esac',
        ].join('\n'),
        kdialog: [
            'printf "%s\\n" "$@" >> "$HUB_LINUX_FIXTURE_ROOT/kdialog-args"',
            '[ "$HUB_LINUX_FIXTURE_CHANNEL" = kdialog ] || exit 255',
            'for argument in "$@"; do if [ "$argument" = --textbox ]; then [ "$HUB_LINUX_FIXTURE_CHOICE" != cancel ]; exit $?; fi; done',
            'case "$HUB_LINUX_FIXTURE_CHOICE" in save|open) printf "%s\\n" "$HUB_LINUX_FIXTURE_CHOICE";; cancel) exit 1;; *) exit 255;; esac',
        ].join('\n'),
        // GUI shims terminate immediately; the outer spawn timeout bounds this portable unit fixture.
        timeout: '[ "${1#--kill-after=}" = "$1" ] || shift\nshift\nexec "$@"',
        ln: 'if [ "${HUB_LINUX_FIXTURE_DIRECTORY_TARGET:-0}" = 1 ]; then for target in "$@"; do :; done; mkdir -- "$target"; fi\nexec /usr/bin/ln "$@"',
        setsid: '[ "$1" != --wait ] || shift\nexec "$@"',
        sudo: 'printf forbidden > "$HUB_LINUX_FIXTURE_ROOT/sudo-called"; exit 99',
    };
    for (const [name, code] of Object.entries(shims))
        await writeFile(path.join(bin, name), '#!/bin/bash\nset -eu\n' + code + '\n', {
            mode: 0o700,
        });
    const env = {
        ...process.env,
        HUB_LINUX_FIXTURE_ROOT: shellPath(root),
        HUB_LINUX_FIXTURE_CHANNEL: 'zenity',
        HUB_LINUX_FIXTURE_CHOICE: 'save',
        DISPLAY: ':99',
        TMPDIR: shellPath(scratch),
    };
    const invoke = (
        code: string,
        args: string[] = [],
        extra: Record<string, string> = {},
        input = '',
        timeout = 60_000,
    ) =>
        spawnSync(
            bash,
            ['-c', 'PATH="$1:$PATH"\nshift\n' + code, 'hub-linux-test', shellPath(bin), ...args],
            { encoding: 'utf8', input, timeout, windowsHide: true, env: { ...env, ...extra } },
        );
    return {
        root,
        output,
        payload,
        asset,
        invoke,
        run(args: string[] = [], extra: Record<string, string> = {}, input = '') {
            return invoke(
                '[ "$(command -v curl)" = "$HUB_LINUX_FIXTURE_ROOT/bin/curl" ] || exit 98; [ "$(command -v uname)" = "$HUB_LINUX_FIXTURE_ROOT/bin/uname" ] || exit 98; source "$@"',
                [
                    shellPath(helper),
                    '--version',
                    'v0.6.0',
                    '--format',
                    format,
                    '--directory',
                    shellPath(output),
                    ...args,
                ],
                extra,
                input,
                120_000,
            );
        },
        review(
            choice: string,
            channel = 'zenity',
            allowed = true,
            requireNoTTY = false,
            input = '',
        ) {
            const body = [
                'set -euo pipefail',
                'source "$1"',
                'root="$2"; review_file="$root/review.txt"',
                'if [ "$4" = no-tty ] && { : </dev/tty; } 2>/dev/null; then exit 77; fi',
                'review_text="Literal <tag> & quoted path: $root"',
                'review_action="Save portable package"',
                'desktop_available=1; terminal_review=0; launch=0; launch_allowed="$3"',
                'base=https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v0.6.0',
                'asset=Diagnostic-Hub-linux-x64.AppImage; website=https://example.invalid/workspace',
                'if hub_linux_confirm; then printf "%s" "$launch" > "$root/confirmed"; else exit $?; fi',
            ].join('\n');
            return invoke(
                body,
                [
                    shellPath(path.join(root, 'review-module.sh')),
                    shellPath(root),
                    allowed ? '1' : '0',
                    requireNoTTY ? 'no-tty' : 'any',
                ],
                { HUB_LINUX_FIXTURE_CHANNEL: channel, HUB_LINUX_FIXTURE_CHOICE: choice },
                input,
                5000,
            );
        },
        async close() {
            assert.equal(path.dirname(path.resolve(root)), await realpath(tmpdir()));
            assert.match(path.basename(root), /^hub-linux-guided-/);
            assert.equal((await lstat(root)).isSymbolicLink(), false);
            await rm(root, { recursive: true, force: true });
        },
    };
}

test('Linux and Mac embed the same reviewed path guards except their native stat adapter', () => {
    const mac = readFileSync('public/download-run-macos.sh', 'utf8');
    const macGuards = mac.slice(
        mac.indexOf('# BEGIN GUARDED PATHS'),
        mac.indexOf('# END GUARDED PATHS'),
    );
    const linuxGuards = section('# BEGIN GUARDED PATHS', '# END GUARDED PATHS');
    assert.equal(linuxGuards.replace("stat -c '%d:%i'", "stat -f '%d:%i'"), macGuards);
    assert.ok(
        source.indexOf('hub_make_directory_tree "$directory"') >
            source.indexOf('if hub_linux_confirm; then'),
    );
    assert.match(source, /Permanent managed\/folder setup remains unavailable/);
    assert.doesNotMatch(source, /--no-sandbox|sudo apt|chown|chmod \+s/);
});

test(
    'Linux bounded metadata parser rejects duplicate/nested/confusable keys, malformed JSON and trailing data',
    { skip: !available },
    async () => {
        const f = await fixture();
        try {
            const cases = [
                ['{"commit":"a","other":[{"x":true}]}', true],
                ['{"commit":"a","commit":"b"}', false],
                ['{"commit":"a","\\u0063ommit":"b"}', false],
                ['{"nested":{"commit":"a"}}', false],
                ['{"commit":"a"} trailing', false],
                ['{"commit":"bad\\q"}', false],
                ['{"commit":"unterminated}', false],
                ['{"commit":"a",}', false],
                ['{"commit":"a","n":01}', false],
                ['{"commit":"a","n":NaN}', false],
                ['{"commit":"a","nested":{"x":1,"x":2}}', false],
                ['[]', false],
            ] as const;
            for (const [json, valid] of cases) {
                await writeFile(path.join(f.root, 'probe.json'), json);
                const result = f.invoke(
                    'source "$1"; hub_json_string "$2" commit',
                    [
                        shellPath(path.join(f.root, 'json-module.sh')),
                        shellPath(path.join(f.root, 'probe.json')),
                    ],
                    {},
                    '',
                    5000,
                );
                assert.equal(result.status === 0, valid, result.stderr + json);
                if (valid) assert.equal(result.stdout, 'a');
            }
            await writeFile(
                path.join(f.root, 'probe.json'),
                '{"assets/commit":"bad","assets":{"commit":"good"}}',
            );
            const nested = f.invoke(
                'source "$1"; hub_json_string "$2" assets/commit',
                [
                    shellPath(path.join(f.root, 'json-module.sh')),
                    shellPath(path.join(f.root, 'probe.json')),
                ],
                {},
                '',
                5000,
            );
            assert.equal(nested.status, 0, nested.stderr);
            assert.equal(nested.stdout, 'good');
        } finally {
            await f.close();
        }
    },
);

test(
    'Linux GUI choices are explicit, default to save, preserve markup data, and enforce disabled Open',
    { skip: !available },
    async (context) => {
        for (const channel of ['zenity', 'kdialog']) {
            for (const choice of ['save', 'open', 'cancel']) {
                const f = await fixture();
                try {
                    const result = f.review(choice, channel);
                    assert.equal(result.status, choice === 'cancel' ? 1 : 0, result.stderr);
                    if (choice === 'cancel')
                        await assert.rejects(access(path.join(f.root, 'confirmed')));
                    else
                        assert.equal(
                            await readFile(path.join(f.root, 'confirmed'), 'utf8'),
                            choice === 'open' ? '1' : '0',
                        );
                    if (channel === 'zenity' && choice === 'save')
                        assert.match(
                            await readFile(path.join(f.root, 'zenity-args'), 'utf8'),
                            /&lt;tag&gt; &amp;/,
                        );
                } finally {
                    await f.close();
                }
            }
        }
        const f = await fixture();
        try {
            const denied = f.review('open', 'zenity', false, true, 'i\no\nyes\n');
            if (denied.status === 77) {
                context.skip('Controlling terminal exists; personal input was not read.');
                return;
            }
            assert.equal(denied.status, 3, denied.stderr);
            assert.match(denied.stderr, /Piped stdin is not consent/);
            await assert.rejects(access(path.join(f.root, 'confirmed')));
        } finally {
            await f.close();
        }
    },
);

test(
    'Linux cancellation and absent UI/TTY do not create a destination, despite piped consent',
    { skip: !available || process.platform === 'darwin' },
    async (context) => {
        for (const choice of ['cancel', 'unavailable']) {
            const f = await fixture();
            try {
                if (choice === 'unavailable') {
                    const probe = f.invoke('if { : </dev/tty; } 2>/dev/null; then exit 77; fi');
                    if (probe.status === 77) {
                        context.skip('Controlling terminal exists; no personal input read.');
                        return;
                    }
                }
                const result = f.run(
                    [],
                    {
                        HUB_LINUX_FIXTURE_CHOICE: choice,
                        HUB_LINUX_FIXTURE_CHANNEL: choice === 'cancel' ? 'zenity' : 'none',
                    },
                    'i\nyes\n',
                );
                assert.equal(result.status, choice === 'cancel' ? 0 : 1, result.stderr);
                if (choice === 'cancel') assert.match(result.stdout, /Setup cancelled/);
                else assert.match(result.stderr, /Piped stdin is not consent/);
                await assert.rejects(access(f.output));
                await assert.rejects(access(path.join(f.root, 'launched')));
                await assert.rejects(access(path.join(f.root, 'sudo-called')));
            } finally {
                await f.close();
            }
        }
    },
);

test(
    'Linux explicit download-only saves verified bytes/source without GUI or launch and refuses foreign overwrite',
    { skip: !available || process.platform === 'darwin' },
    async () => {
        const f = await fixture();
        try {
            const result = f.run(['--download-only'], { DISPLAY: '' });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.equal(await readFile(path.join(f.output, asset), 'utf8'), f.payload);
            assert.ok(result.stdout.includes(commit));
            await assert.rejects(access(path.join(f.root, 'zenity-args')));
            await assert.rejects(access(path.join(f.root, 'launched')));
            await writeFile(path.join(f.output, asset), 'operator bytes');
            const refused = f.run(['--download-only']);
            assert.notEqual(refused.status, 0);
            assert.match(refused.stderr, /differs from the verified release/);
            assert.equal(await readFile(path.join(f.output, asset), 'utf8'), 'operator bytes');
        } finally {
            await f.close();
        }
    },
);

test(
    'Linux source/checksum mismatch is refused before review or destination mutation',
    { skip: !available || process.platform === 'darwin' },
    async () => {
        const f = await fixture();
        try {
            await writeFile(
                path.join(f.root, 'metadata'),
                JSON.stringify({
                    version: '0.6.0',
                    platform: 'linux',
                    arch: 'x64',
                    commit: 'b'.repeat(40),
                    assets: { [asset]: sha(f.payload) },
                }),
            );
            const result = f.run(['--download-only']);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /source\/checksum mismatch/);
            await assert.rejects(access(f.output));
            await assert.rejects(access(path.join(f.root, 'zenity-args')));
        } finally {
            await f.close();
        }
    },
);

test(
    'Linux full helper ordinary Save and explicit Open preserve verified bytes and launch only by choice',
    { skip: !available || process.platform === 'darwin' },
    async () => {
        for (const choice of ['save', 'open']) {
            const f = await fixture();
            try {
                const result = f.run([], { HUB_LINUX_FIXTURE_CHOICE: choice });
                assert.equal(result.status, 0, result.stdout + result.stderr);
                assert.equal(await readFile(path.join(f.output, f.asset), 'utf8'), f.payload);
                assert.ok(result.stdout.includes(commit));
                if (choice === 'open')
                    assert.equal(
                        await readFile(path.join(f.root, 'launched'), 'utf8'),
                        '--appimage-extract-and-run',
                    );
                else await assert.rejects(access(path.join(f.root, 'launched')));
                await assert.rejects(access(path.join(f.root, 'sudo-called')));
            } finally {
                await f.close();
            }
        }
    },
);

test(
    'Linux explicit tar.gz download-only saves opaque verified bytes without interpreting or launching the archive',
    { skip: !available || process.platform === 'darwin' },
    async () => {
        const f = await fixture('tar.gz');
        try {
            const result = f.run(['--download-only']);
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.equal(await readFile(path.join(f.output, f.asset), 'utf8'), f.payload);
            await assert.rejects(access(path.join(f.root, 'zenity-args')));
            await assert.rejects(access(path.join(f.root, 'launched')));
        } finally {
            await f.close();
        }
    },
);

test(
    'Linux full helper refuses a parent replaced during Review before creating any descendants and preserves scratch',
    { skip: !available || process.platform === 'darwin' },
    async () => {
        const f = await fixture();
        try {
            const parent = path.join(f.root, 'reviewed-parent');
            await mkdir(parent);
            const result = f.run(
                ['--directory', shellPath(path.join(parent, 'missing', 'child'))],
                { HUB_LINUX_FIXTURE_SWAP_PARENT: '1' },
            );
            assert.notEqual(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stderr, /ancestry changed|identity changed/);
            await assert.rejects(access(path.join(parent, 'missing')));
            assert.deepEqual(await readdir(parent), []);
            assert.deepEqual(await readdir(path.join(f.root, 'original-parent')), []);
            assert.ok((await readdir(path.join(f.root, 'temporary'))).length > 0);
            await assert.rejects(access(path.join(f.root, 'launched')));
        } finally {
            await f.close();
        }
    },
);

test(
    'Linux activation refuses a destination directory substituted after the guard without linking inside it',
    { skip: !available || process.platform === 'darwin' },
    async () => {
        const f = await fixture();
        try {
            const result = f.run(['--download-only'], { HUB_LINUX_FIXTURE_DIRECTORY_TARGET: '1' });
            assert.notEqual(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stderr, /Exclusive final-file creation failed/);
            assert.deepEqual(await readdir(path.join(f.output, f.asset)), []);
            await assert.rejects(access(path.join(f.output, f.asset, f.asset)));
            await assert.rejects(access(path.join(f.root, 'launched')));
        } finally {
            await f.close();
        }
    },
);

test(
    'Linux validates every fetched metadata document even when the other fetch is missing',
    { skip: !available || process.platform === 'darwin' },
    async () => {
        for (const missing of ['release', 'metadata']) {
            const f = await fixture();
            try {
                await writeFile(
                    path.join(f.root, missing === 'metadata' ? 'release' : 'metadata'),
                    '{}',
                );
                const result = f.run(['--download-only'], { HUB_LINUX_FIXTURE_MISSING: missing });
                assert.notEqual(result.status, 0, result.stdout + result.stderr);
                assert.match(
                    result.stderr,
                    /Invalid selected release metadata|Missing Linux build version/,
                );
                await assert.rejects(access(f.output));
                await assert.rejects(access(path.join(f.root, 'launched')));
            } finally {
                await f.close();
            }
        }
    },
);

test(
    'Linux checksum-only fallback accepts a genuinely missing document but refuses partial metadata transfer',
    { skip: !available || process.platform === 'darwin' },
    async () => {
        for (const damaged of [false, true]) {
            const f = await fixture();
            try {
                const result = f.run(
                    ['--download-only'],
                    damaged
                        ? { HUB_LINUX_FIXTURE_DAMAGED: 'metadata' }
                        : { HUB_LINUX_FIXTURE_MISSING: 'metadata' },
                );
                assert.equal(result.status === 0, !damaged, result.stdout + result.stderr);
                if (damaged) {
                    assert.match(result.stderr, /Metadata request failed or was incomplete/);
                    await assert.rejects(access(f.output));
                } else {
                    assert.equal(await readFile(path.join(f.output, f.asset), 'utf8'), f.payload);
                    assert.match(
                        result.stdout,
                        /Checksum verified; source metadata was unavailable/,
                    );
                }
            } finally {
                await f.close();
            }
        }
    },
);
