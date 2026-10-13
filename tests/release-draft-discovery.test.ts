import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    listAllReleases,
    selectOwnedDraft,
    requireNewRelease,
} from '../scripts/lib/release-draft.mjs';
const context = {
    tag: 'v0.4.0',
    version: '0.4.0',
    commit: 'a'.repeat(40),
    tagCommit: 'a'.repeat(40),
    repository: { private: false },
};
const marker = requireNewRelease(context);
const draft = {
    id: 42,
    tag_name: context.tag,
    draft: true,
    target_commitish: context.commit,
    body: marker,
};
test('authenticated paginated listing discovers an owned draft that published tag lookup omits', async () => {
    const calls: number[] = [];
    const releases = await listAllReleases(async (page: number) => {
        calls.push(page);
        return page === 1
            ? Array.from({ length: 100 }, (_, i) => ({
                  ...draft,
                  id: i + 100,
                  tag_name: 'other-' + i,
                  draft: false,
              }))
            : [draft];
    });
    assert.deepEqual(calls, [1, 2]);
    assert.equal(selectOwnedDraft(releases, { ...context, marker }).id, 42);
    assert.throws(() =>
        selectOwnedDraft(
            releases.filter((r) => !r.draft),
            { ...context, marker },
        ),
    );
});
test('draft discovery rejects missing, duplicate, published and unrelated-source releases', () => {
    for (const releases of [
        [],
        [draft, draft],
        [{ ...draft, draft: false }],
        [{ ...draft, target_commitish: 'b'.repeat(40) }],
        [{ ...draft, body: 'unowned' }],
    ])
        assert.throws(() => selectOwnedDraft(releases, { ...context, marker }));
});
test('listing failures and invalid/bounded pagination never permit a draft mutation', async () => {
    await assert.rejects(
        listAllReleases(async () => {
            throw Error('authenticated HTTP 404');
        }),
    );
    await assert.rejects(listAllReleases(async () => ({})));
    await assert.rejects(
        listAllReleases(async () => Array(100).fill(draft)),
        /pagination limit/,
    );
});
