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
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
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
const source = readFileSync('public/download-run-macos.sh', 'utf8');
const start = source.indexOf('# BEGIN GUARDED PATHS');
const end = source.indexOf('# END GUARDED PATHS');
assert.ok(start >= 0 && end > start);
const guards = source.slice(start, end);

async function fixture() {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hub-shell-guards-')));
    const module = path.join(root, 'guards.sh');
    await writeFile(module, guards);
    const run = (body: string) =>
        spawnSync(
            bash,
            [
                '-c',
                [
                    'set -euo pipefail',
                    'source "$1"',
                    'root="$2"',
                    // Only the native stat adapter changes in these Windows/Linux filesystem tests.
                    process.platform === 'darwin'
                        ? ':'
                        : 'hub_native_token() { stat -c "%d:%i" "$1"; }',
                    'directory="$root/destination"; download_parent="$root/downloads"',
                    body,
                ].join('\n'),
                'hub-guard-test',
                shellPath(module),
                shellPath(root),
            ],
            {
                encoding: 'utf8',
                windowsHide: true,
                timeout: process.platform === 'win32' ? 60_000 : 30_000,
            },
        );
    return {
        root,
        run,
        async close() {
            assert.equal(path.dirname(path.resolve(root)), await realpath(tmpdir()));
            assert.match(path.basename(root), /^hub-shell-guards-/);
            assert.equal((await lstat(root)).isSymbolicLink(), false);
            await rm(root, { recursive: true, force: true });
        },
    };
}

test(
    'reviewed ancestor substitution refuses before the first mkdir, including missing descendants',
    { skip: !available },
    async () => {
        const f = await fixture();
        try {
            await mkdir(path.join(f.root, 'parent'));
            const result = f.run(
                [
                    'requested="$root/parent/new/deep"',
                    'hub_track_directory_path "$requested"',
                    'command mv "$root/parent" "$root/original-parent"',
                    'command mkdir "$root/parent"',
                    'mkdir() { printf called >> "$root/mkdir-called"; command mkdir "$@"; }',
                    'if hub_make_directory_tree "$requested"; then exit 90; fi',
                    '[ "$hub_guard_failed" -eq 1 ]',
                ].join('\n'),
            );
            assert.equal(result.status, 0, result.stderr);
            await assert.rejects(access(path.join(f.root, 'mkdir-called')));
            await assert.rejects(access(path.join(f.root, 'parent/new')));
        } finally {
            await f.close();
        }
    },
);

test(
    'aliased reviewed parent refuses before creation and move, preserving outside sentinel',
    { skip: !available },
    async (context) => {
        const f = await fixture();
        try {
            await mkdir(path.join(f.root, 'parent'));
            await mkdir(path.join(f.root, 'foreign'));
            await mkdir(path.join(f.root, 'source'));
            await writeFile(path.join(f.root, 'foreign/sentinel'), 'retain outside bytes');
            try {
                await symlink(
                    path.join(f.root, 'foreign'),
                    path.join(f.root, 'prepared-alias'),
                    'junction',
                );
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                    context.skip(
                        'Task-owned alias creation unavailable; no host permission change.',
                    );
                    return;
                }
                throw error;
            }
            const result = f.run(
                [
                    'hub_track_directory_path "$root/parent/new"',
                    'hub_track_directory_path "$root/source"',
                    'command mv "$root/parent" "$root/original-parent"',
                    'command mv "$root/prepared-alias" "$root/parent"',
                    'mkdir() { printf called >> "$root/mkdir-called"; return 91; }',
                    'mv() { printf called >> "$root/move-called"; return 92; }',
                    'if hub_make_directory_tree "$root/parent/new"; then exit 90; fi',
                    'if hub_move_directory "$root/source" "$root/parent/new"; then exit 90; fi',
                ].join('\n'),
            );
            assert.equal(result.status, 0, result.stderr);
            for (const name of ['mkdir-called', 'move-called', 'foreign/new'])
                await assert.rejects(access(path.join(f.root, name)));
            assert.equal(
                await readFile(path.join(f.root, 'foreign/sentinel'), 'utf8'),
                'retain outside bytes',
            );
            await access(path.join(f.root, 'source'));
        } finally {
            await f.close();
        }
    },
);

test(
    'cleanup refuses a replaced stage root with the same permitted basename and preserves both trees',
    { skip: !available },
    async () => {
        const f = await fixture();
        try {
            const parent = path.join(f.root, 'downloads');
            const stage = path.join(parent, 'DiagnosticHub-download.12345678');
            await mkdir(stage, { recursive: true });
            await mkdir(path.join(f.root, 'replacement'));
            await writeFile(path.join(stage, 'original'), 'owned artifact retained');
            await writeFile(path.join(f.root, 'replacement/sentinel'), 'foreign bytes retained');
            const result = f.run(
                [
                    'owned="$download_parent/DiagnosticHub-download.12345678"',
                    'hub_track_directory_path "$owned"',
                    'token="$(hub_directory_token "$owned")"',
                    'command mv "$owned" "$root/original-stage"',
                    'command mv "$root/replacement" "$owned"',
                    'rm() { printf called >> "$root/remove-called"; return 0; }',
                    'if hub_remove_owned_stage "$owned" "$token"; then exit 90; fi',
                    '[ "$hub_guard_failed" -eq 1 ]',
                ].join('\n'),
            );
            assert.equal(result.status, 0, result.stderr);
            await assert.rejects(access(path.join(f.root, 'remove-called')));
            assert.equal(
                await readFile(path.join(stage, 'sentinel'), 'utf8'),
                'foreign bytes retained',
            );
            assert.equal(
                await readFile(path.join(f.root, 'original-stage/original'), 'utf8'),
                'owned artifact retained',
            );
        } finally {
            await f.close();
        }
    },
);

test(
    'cleanup refuses an aliased parent even when the stage inode itself is unchanged',
    { skip: !available },
    async (context) => {
        const f = await fixture();
        try {
            const stage = path.join(f.root, 'downloads/DiagnosticHub-download.12345678');
            await mkdir(stage, { recursive: true });
            await writeFile(path.join(stage, 'original'), 'retain exact artifact');
            // The alias points at the location the original parent will occupy after rename.
            try {
                await symlink(
                    path.join(f.root, 'saved-downloads'),
                    path.join(f.root, 'prepared-alias'),
                    'junction',
                );
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                    context.skip('Task-owned alias unavailable; no permission change.');
                    return;
                }
                throw error;
            }
            const result = f.run(
                [
                    'owned="$download_parent/DiagnosticHub-download.12345678"',
                    'hub_track_directory_path "$owned"',
                    'token="$(hub_directory_token "$owned")"',
                    'command mv "$download_parent" "$root/saved-downloads"',
                    'command mv "$root/prepared-alias" "$download_parent"',
                    'rm() { printf called >> "$root/remove-called"; return 0; }',
                    'if hub_remove_owned_stage "$owned" "$token"; then exit 90; fi',
                ].join('\n'),
            );
            assert.equal(result.status, 0, result.stderr);
            await assert.rejects(access(path.join(f.root, 'remove-called')));
            assert.equal(
                await readFile(
                    path.join(f.root, 'saved-downloads/DiagnosticHub-download.12345678/original'),
                    'utf8',
                ),
                'retain exact artifact',
            );
        } finally {
            await f.close();
        }
    },
);

test(
    'guarded same-volume activation/rollback updates directory identities and cleans only its created stage',
    { skip: !available },
    async () => {
        const f = await fixture();
        try {
            const app = path.join(f.root, 'destination/Diagnostic Hub.app');
            await mkdir(app, { recursive: true });
            await writeFile(path.join(app, 'payload'), 'original');
            const result = f.run(
                [
                    'target="$directory/Diagnostic Hub.app"',
                    'hub_track_directory_path "$target"',
                    'stage="$directory/.DiagnosticHub-stage.12345678"',
                    'hub_make_new_directory "$stage"',
                    'token="$(hub_directory_token "$stage")"',
                    'hub_make_new_directory "$stage/candidate.app"',
                    'printf candidate > "$stage/candidate.app/payload"',
                    'hub_move_directory "$target" "$stage/previous.app"',
                    'hub_move_directory "$stage/candidate.app" "$target"',
                    'hub_move_directory "$target" "$stage/failed.app"',
                    'hub_move_directory "$stage/previous.app" "$target"',
                    // Refuse any accidental test cleanup outside the newly created fixture stage.
                    'rm() { local last arg; for arg in "$@"; do last="$arg"; done; [ "$last" = "$stage" ] || return 93; command rm "$@"; }',
                    'hub_remove_owned_stage "$stage" "$token"',
                    'hub_assert_existing_directory "$target"',
                ].join('\n'),
            );
            assert.equal(result.status, 0, result.stderr);
            assert.equal(await readFile(path.join(app, 'payload'), 'utf8'), 'original');
            await assert.rejects(
                access(path.join(f.root, 'destination/.DiagnosticHub-stage.12345678')),
            );
        } finally {
            await f.close();
        }
    },
);

test(
    'actual post-review Mac creation phase refuses a substituted parent before any mkdir',
    { skip: !available },
    async () => {
        const f = await fixture();
        try {
            await mkdir(path.join(f.root, 'parent'));
            const begin = source.indexOf('# Only the confirmed operation can create');
            const end = source.indexOf('check_reviewed_target() {', begin);
            assert.ok(begin >= 0 && end > begin);
            await writeFile(path.join(f.root, 'creation-phase.sh'), source.slice(begin, end));
            const result = f.run(
                [
                    'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
                    'directory="$root/parent/new/deep"',
                    'hub_track_directory_path "$directory"',
                    'command mv "$root/parent" "$root/original-parent"',
                    'command mkdir "$root/parent"',
                    'mkdir() { printf called >> "$root/mkdir-called"; return 91; }',
                    'source "$root/creation-phase.sh"',
                ].join('\n'),
            );
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, /ancestry changed before directory creation/);
            await assert.rejects(access(path.join(f.root, 'mkdir-called')));
            await assert.rejects(access(path.join(f.root, 'parent/new')));
        } finally {
            await f.close();
        }
    },
);

test(
    'actual cleanup trap preserves all artifacts after destination-parent substitution',
    { skip: !available },
    async () => {
        const f = await fixture();
        try {
            await mkdir(path.join(f.root, 'parent'));
            const stage = path.join(f.root, 'downloads/DiagnosticHub-download.12345678');
            await mkdir(stage, { recursive: true });
            await writeFile(path.join(stage, 'artifact'), 'retain for recovery');
            const begin = source.indexOf('cleanup() {');
            const end = source.indexOf('trap cleanup EXIT', begin);
            assert.ok(begin >= 0 && end > begin);
            await writeFile(path.join(f.root, 'cleanup-phase.sh'), source.slice(begin, end));
            const result = f.run(
                [
                    'directory="$root/parent/new"; target="$directory/Diagnostic Hub.app"',
                    'hub_track_directory_path "$target"',
                    'download_stage="$download_parent/DiagnosticHub-download.12345678"',
                    'hub_track_directory_path "$download_stage"',
                    'download_stage_token="$(hub_directory_token "$download_stage")"',
                    'install_stage=""; install_stage_token=""; committed=0',
                    'source "$root/cleanup-phase.sh"',
                    'command mv "$root/parent" "$root/original-parent"',
                    'command mkdir "$root/parent"',
                    'rm() { printf called >> "$root/remove-called"; return 0; }',
                    'mv() { printf called >> "$root/move-called"; return 0; }',
                    ':; cleanup',
                ].join('\n'),
            );
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, /no cleanup or recovery move attempted/);
            await assert.rejects(access(path.join(f.root, 'remove-called')));
            await assert.rejects(access(path.join(f.root, 'move-called')));
            assert.equal(
                await readFile(path.join(stage, 'artifact'), 'utf8'),
                'retain for recovery',
            );
        } finally {
            await f.close();
        }
    },
);
