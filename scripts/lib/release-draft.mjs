import assert from 'node:assert/strict';

export function requireNewRelease({ tag, version, commit, tagCommit, repository }) {
    assert.equal(repository.private, false, 'Mac release staging requires a public repository.');
    assert.equal(tag, 'v' + version);
    assert.match(tag, /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    assert.ok(!['v0.2.0', 'v0.3.0', 'v0.3.1'].includes(tag), 'Preserve prior releases.');
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal(tagCommit, commit, 'Tag must point to the qualified source.');
    return 'Diagnostic Hub guarded draft; source=' + commit + '; tag=' + tag;
}
export function requireOwnedDraft(release, { tag, commit, marker }) {
    assert.equal(release.tag_name, tag);
    assert.equal(release.draft, true, 'Never modify a published release.');
    assert.equal(release.target_commitish, commit);
    assert.ok(release.body.includes(marker), 'Draft does not belong to this source.');
    assert.ok(Number.isSafeInteger(release.id));
    return release;
}
export async function requireAnonymousDenial(url, request = fetch) {
    const response = await request(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/octet-stream', Range: 'bytes=0-0' },
    });
    await response.body?.cancel();
    assert.equal(
        response.status,
        404,
        'Expected anonymous draft denial; transport/rate-limit errors are not privacy evidence. Status: ' +
            response.status,
    );
}
