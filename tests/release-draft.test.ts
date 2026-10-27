import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    requireNewRelease,
    requireOwnedDraft,
    requireAnonymousDenial,
} from '../scripts/lib/release-draft.mjs';
const context = {
    tag: 'v0.4.0',
    version: '0.4.0',
    commit: 'a'.repeat(40),
    tagCommit: 'a'.repeat(40),
    repository: { private: false },
};
test('release draft guards refuse old tags, unrelated sources and published releases', () => {
    const marker = requireNewRelease(context);
    for (const modified of [
        { tag: 'v0.3.1', version: '0.3.1' },
        { tagCommit: 'b'.repeat(40) },
        { repository: { private: true } },
        { tag: 'v0.4.1' },
    ]) {
        assert.throws(() => requireNewRelease({ ...context, ...modified }));
    }
    const draft = {
        id: 1,
        tag_name: context.tag,
        draft: true,
        target_commitish: context.commit,
        body: marker,
    };
    assert.equal(requireOwnedDraft(draft, { ...context, marker }), draft);
    for (const modified of [
        { draft: false },
        { tag_name: 'v0.3.1' },
        { target_commitish: 'main' },
        { body: 'unowned' },
    ])
        assert.throws(() => requireOwnedDraft({ ...draft, ...modified }, { ...context, marker }));
});
test('draft privacy accepts denial and rejects redirects or successful anonymous assets', async () => {
    for (const status of [404])
        await requireAnonymousDenial(
            'https://example.test',
            async () => new Response(null, { status }),
        );
    for (const status of [200, 302, 307, 401, 403, 500])
        await assert.rejects(
            requireAnonymousDenial(
                'https://example.test',
                async () => new Response(null, { status }),
            ),
        );
    await assert.rejects(
        requireAnonymousDenial('https://example.test', async () => {
            throw Error('network');
        }),
    );
});
