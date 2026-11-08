import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const bash =
    process.platform === 'win32'
        ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
        : '/bin/bash';
const available = spawnSync(bash, ['--version'], { windowsHide: true }).status === 0;
const shellPath = (value: string) =>
    process.platform === 'win32'
        ? value.replace(/^[A-Za-z]:/, (drive) => '/' + drive[0].toLowerCase()).replaceAll('\\', '/')
        : value;
const helper = path.resolve('public/download-run-macos.sh');
const source = readFileSync(helper, 'utf8');
const start = source.indexOf('# BEGIN GUIDED REVIEW');
const end = source.indexOf('# END GUIDED REVIEW');
assert.ok(start > 0 && end > start);
const moduleSource = source.slice(start, end);

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-mac-guided-'));
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const module = path.join(root, 'review.sh');
    await writeFile(module, moduleSource);
    await writeFile(
        path.join(bin, 'osascript'),
        [
            '#!/bin/bash',
            'cat >/dev/null',
            'printf "%s\\n" "$@" > "$HUB_REVIEW_FIXTURE_ARGS"',
            'if [ "$HUB_REVIEW_FIXTURE_RESPONSE" = command-error ]; then exit 1; fi',
            'printf "%s\\n" "$HUB_REVIEW_FIXTURE_RESPONSE"',
        ].join('\n') + '\n',
        { mode: 0o700 },
    );
    const marker = path.join(root, 'confirmed');
    const target = path.join(root, "Applications ' 文 $(not-a-command)", 'Diagnostic Hub.app');
    const script = [
        'set -euo pipefail',
        'source "$1"',
        'PATH="$2:$PATH"',
        'version=0.6.0; arch=arm64; tag=v0.6.0; installed_version=None; asset=Diagnostic-Hub-macos-arm64.zip',
        'target="$3"; review_action=Install; launch=0',
        'launch_allowed="$5"; terminal_review="$6"',
        'base=https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v0.6.0',
        // Test runners must not consume the operator's actual controlling terminal.
        'if [ "$7" = no-tty-required ] && { : </dev/tty; } 2>/dev/null; then exit 77; fi',
        'if hub_confirm_review; then printf "%s" "$launch" > "$4"; else exit $?; fi',
    ].join('\n');
    return {
        root,
        marker,
        target,
        argsFile: path.join(root, 'gui-args'),
        run(response: string, allowed = true, terminal = false, requireNoTTY = false, input = '') {
            return spawnSync(
                bash,
                [
                    '-c',
                    script,
                    'hub-review-test',
                    shellPath(module),
                    shellPath(bin),
                    shellPath(target),
                    shellPath(marker),
                    allowed ? '1' : '0',
                    terminal ? '1' : '0',
                    requireNoTTY ? 'no-tty-required' : 'any',
                ],
                {
                    encoding: 'utf8',
                    input,
                    timeout: 5000,
                    windowsHide: true,
                    env: {
                        ...process.env,
                        HUB_REVIEW_FIXTURE_RESPONSE: response,
                        HUB_REVIEW_FIXTURE_ARGS: shellPath(path.join(root, 'gui-args')),
                    },
                },
            );
        },
        async close() {
            assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
            assert.match(path.basename(root), /^hub-mac-guided-/);
            assert.equal((await lstat(root)).isSymbolicLink(), false);
            await rm(root, { recursive: true, force: true });
        },
    };
}

test('Mac source verifies before review and cannot create an application location before confirmation', () => {
    assert.equal(source.split('# BEGIN GUIDED REVIEW').length - 1, 1);
    const review = source.indexOf('if hub_confirm_review; then');
    assert.ok(source.indexOf('verify_bundle "$app"') < review);
    assert.ok(source.indexOf('hub_make_directory_tree "$directory"') > review);
    assert.ok(source.indexOf('install_stage="$(mktemp') > review);
    assert.ok(
        source.indexOf('verify_bundle "$install_stage/extracted/Diagnostic Hub.app"') <
            source.indexOf('hub_move_directory "$target" "$stage/previous.app"'),
    );
    assert.match(source, /--version[\s\S]*--directory[\s\S]*--no-launch[\s\S]*--terminal/);
    assert.match(source, /if \[ -n "\$tag" \]; then api="\$api\/tags\/\$tag"/);
    assert.match(source, /Release tag mismatch/);
    assert.match(source, /Release source commit mismatch/);
    assert.doesNotMatch(moduleSource, /read[^\n]*\s-u\s+0|readarray|mapfile|declare -A/);
    assert.match(moduleSource, /read -r -t 120 -u 3/);
});

test(
    'Mac native review defaults launch off and passes literal Unicode/quoted paths as arguments',
    { skip: !available },
    async () => {
        const item = await fixture();
        try {
            const result = item.run('install');
            assert.equal(result.status, 0, result.stderr);
            assert.equal(await readFile(item.marker, 'utf8'), '0');
            const args = await readFile(item.argsFile, 'utf8');
            assert.ok(args.includes(shellPath(item.target)));
            assert.match(args, /release v0\.6\.0/);
            assert.match(args, /not Developer ID signed or notarized/);
            assert.match(args, /Launch is off unless/);
            await assert.rejects(access(item.target));
        } finally {
            await item.close();
        }
    },
);

test(
    'Mac native review requires an explicit Open choice and cancellation creates no confirmed marker',
    { skip: !available },
    async () => {
        for (const response of ['open', 'cancel']) {
            const item = await fixture();
            try {
                const result = item.run(response);
                assert.equal(result.status, response === 'open' ? 0 : 1, result.stderr);
                if (response === 'open') assert.equal(await readFile(item.marker, 'utf8'), '1');
                else await assert.rejects(access(item.marker));
                await assert.rejects(access(item.target));
            } finally {
                await item.close();
            }
        }
    },
);

test(
    'Mac headless review rejects piped consent, unsupported GUI responses and Open with --no-launch',
    { skip: !available },
    async (context) => {
        for (const [response, allowed, terminal] of [
            ['unavailable', true, false],
            ['command-error', true, false],
            ['open', false, false],
            ['install', true, true],
        ] as const) {
            const item = await fixture();
            try {
                const result = item.run(response, allowed, terminal, true, 'i\no\nyes\n');
                if (result.status === 77) {
                    context.skip(
                        'Runner has a controlling terminal; no personal terminal input was read.',
                    );
                    return;
                }
                assert.equal(result.status, 3, result.stderr);
                assert.match(result.stderr, /No usable setup dialog or controlling terminal/);
                assert.match(result.stderr, /Piped stdin is not installation consent/);
                assert.match(result.stderr, /releases\/download\/v0\.6\.0/);
                await assert.rejects(access(item.marker));
                await assert.rejects(access(item.target));
            } finally {
                await item.close();
            }
        }
    },
);

test(
    'Mac helper help and Bash syntax remain usable without platform mutations',
    { skip: !available },
    () => {
        const syntax = spawnSync(bash, ['-n', shellPath(helper)], {
            encoding: 'utf8',
            windowsHide: true,
        });
        assert.equal(syntax.status, 0, syntax.stderr);
        const result = spawnSync(bash, [shellPath(helper), '--help'], {
            encoding: 'utf8',
            windowsHide: true,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(
            result.stdout,
            /--version.*--directory.*--no-launch.*--terminal.*-- APP_ARGUMENTS/,
        );
    },
);
