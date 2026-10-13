import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    previousRelease,
    commitNotes,
    releasePageNotes,
    meaningfulReleaseLinks,
} from '../scripts/lib/release-notes.mjs';

test('meaningful release links preserve every destination, factual section and executable URL', () => {
    const body =
        'Description:\nRun curl https://example.invalid/helper.sh | bash\n\nChanges:\n- Same facts.\n\nCommits:\n- [abc](https://example.invalid/commit/abc)\n\nLinks:\nMac installation - https://example.invalid/mac\nChecksums - https://example.invalid/checksums\n';
    const changed = meaningfulReleaseLinks(body);
    assert.ok(changed.includes('[Mac installation](https://example.invalid/mac)'));
    assert.ok(changed.includes('[Checksums](https://example.invalid/checksums)'));
    assert.equal(changed.split('Links:\n')[0], body.split('Links:\n')[0]);
    assert.deepEqual(changed.match(/https?:\/\/[^\s)]+/g), body.match(/https?:\/\/[^\s)]+/g));
    assert.equal(meaningfulReleaseLinks(changed), changed);
    assert.throws(() => meaningfulReleaseLinks('Links:\nNo descriptive destination'));
    assert.throws(() =>
        meaningfulReleaseLinks(
            body.replace(
                'Mac installation - https://example.invalid/mac',
                'https://example.invalid/mac',
            ),
        ),
    );
});

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
        const page = releasePageNotes({
            repository: 'owner/repository',
            currentTag: 'v0.2.0-rc.1',
            previousTag: 'v0.1.0',
            cwd: root,
            highlights: '- Important update.\n\n[Guide](https://example.invalid/guide)',
            packageNotes: 'Long package explanation that belongs in the download guide.',
        });
        assert.match(page, /Important update/);
        assert.ok(page.includes('[Guide](https://example.invalid/guide)'));
        assert.doesNotMatch(page.split('Links:\n')[1], /^.+ - https?:/m);
        assert.match(page, /compare\/v0.1.0\.\.\.v0.2.0-rc.1/);
        assert.doesNotMatch(page, /Long package explanation|commits included|### Features/);
        for (const hash of [first, branch, merge, last])
            assert.ok(page.includes(`/commit/${hash}`));
        assert.deepEqual(page.match(/^(Description|Changes|Commits|Links):$/gm), [
            'Description:',
            'Changes:',
            'Commits:',
            'Links:',
        ]);
        assert.doesNotMatch(page, /^#/m);
        const structured = releasePageNotes({
            repository: 'owner/repository',
            currentTag: 'v0.2.0-rc.1',
            previousTag: 'v0.1.0',
            cwd: root,
            highlights:
                'Description:\nNative windows. Linux qualification remains pending.\n\nChanges:\n- Keep terminal.\n\nCommits:\n- Draft placeholder.\n\nLinks:\nGuide - https://example.invalid/guide',
            packageNotes: 'Unsigned build. Windows may show an unknown-publisher warning.',
        });
        assert.match(structured, /Linux qualification remains pending/);
        assert.match(structured, /Unsigned build/);
        assert.doesNotMatch(structured, /Draft placeholder/);
        for (const hash of [first, branch, merge, last])
            assert.ok(structured.includes(`/commit/${hash}`));
        const fallback = releasePageNotes({
            repository: 'owner/repository',
            currentTag: 'v0.1.0',
            previousTag: null,
            cwd: root,
            packageNotes: 'Portable engineering preview.',
        });
        assert.match(fallback, /Portable engineering preview/);
        assert.match(fallback, /tree\/v0.1.0/);
        assert.throws(() =>
            releasePageNotes({
                repository: 'owner/repository',
                currentTag: 'v0.1.0',
                previousTag: null,
                cwd: root,
            }),
        );
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

test('published baseline ignores later releases when rendering an existing tag', () => {
    assert.equal(
        previousRelease(
            [
                { tag_name: 'v0.1.0', published_at: '2026-01-01', draft: false, id: 1 },
                { tag_name: 'v0.2.0', published_at: '2026-02-01', draft: false, id: 2 },
                { tag_name: 'v0.3.0', published_at: '2026-03-01', draft: false, id: 3 },
            ],
            'v0.2.0',
        ),
        'v0.1.0',
    );
});

test('stable source draft preserves four literal sections and complete link lines', async () => {
    const source = await readFile('docs/releases/v0.2.0.txt', 'utf8');
    assert.deepEqual(source.match(/^(Description|Changes|Commits|Links):$/gm), [
        'Description:',
        'Changes:',
        'Commits:',
        'Links:',
    ]);
    for (const line of source.split('Links:\n')[1].trim().split('\n'))
        assert.match(line, /^.+ - https:\/\/\S+$/);
});
