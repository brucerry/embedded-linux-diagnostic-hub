import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { previousRelease, commitNotes } from '../scripts/lib/release-notes.mjs';

test('release baseline includes published prereleases and excludes drafts/current/unreleased tags', () => {
    assert.equal(
        previousRelease(
            [
                { tag_name: 'v0.1.0', draft: false, published_at: '2026-01-01', id: 1 },
                {
                    tag_name: 'v0.2.0-rc.1',
                    prerelease: true,
                    draft: false,
                    published_at: '2026-02-01',
                    id: 2,
                },
                { tag_name: 'v0.2.0-rc.2', draft: false, published_at: '2026-03-01', id: 3 },
                { tag_name: 'v0.3.0', draft: true, published_at: '2026-04-01', id: 4 },
            ],
            'v0.2.0-rc.2',
        ),
        'v0.2.0-rc.1',
    );
    assert.equal(previousRelease([], 'v0.1.0'), null);
});

test('release notes include all commits after the published baseline, including merged branches', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-release-notes-test-'));
    const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    async function commit(subject: string) {
        await writeFile(path.join(root, 'change.txt'), subject);
        git('add', '.');
        git('commit', '-m', subject);
        return git('rev-parse', 'HEAD');
    }
    try {
        git('init', '--initial-branch=main');
        git('config', 'user.name', 'Test Author');
        git('config', 'user.email', 'test@example.invalid');
        const old = await commit('chore: baseline');
        git('tag', 'v0.1.0');
        const first = await commit('feat: start updates');
        git('tag', 'v0.1.1'); // never published: not the requested baseline
        git('checkout', '-b', 'fix');
        const branch = await commit('fix: restore reports <safely>');
        git('checkout', 'main');
        git('merge', '--no-ff', 'fix', '-m', 'Merge report fix');
        const merge = git('rev-parse', 'HEAD');
        const last = await commit('docs: explain update modes');
        git('tag', 'v0.2.0-rc.1');
        const notes = commitNotes({
            repository: 'owner/repository',
            currentTag: 'v0.2.0-rc.1',
            previousTag: 'v0.1.0',
            cwd: root,
        });
        assert.match(notes, /4 commits included/);
        for (const hash of [first, branch, merge, last])
            assert.ok(notes.includes(`/commit/${hash}`));
        assert.ok(!notes.includes(`/commit/${old}`));
        assert.ok(notes.includes('compare/v0.1.0...v0.2.0-rc.1'));
        assert.match(notes, /Features/);
        assert.match(notes, /Fixes/);
        const initial = commitNotes({
            repository: 'owner/repository',
            currentTag: 'v0.1.0',
            previousTag: null,
            cwd: root,
        });
        assert.match(initial, /1 commit included/);
        assert.throws(() =>
            commitNotes({
                repository: 'owner/repository',
                currentTag: 'v0.1.0',
                previousTag: 'v0.2.0-rc.1',
                cwd: root,
            }),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
