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

export function selectOwnedDraft(releases, context) {
    assert.ok(Array.isArray(releases), 'Invalid authenticated releases listing.');
    const matches = releases.filter((release) => release.tag_name === context.tag);
    assert.equal(matches.length, 1, 'Expected exactly one existing release for this tag.');
    return requireOwnedDraft(matches[0], context);
}
export async function listAllReleases(readPage) {
    const releases = [];
    for (let page = 1; page <= 100; page++) {
        const batch = await readPage(page);
        assert.ok(Array.isArray(batch), 'Invalid releases page.');
        releases.push(...batch);
        if (batch.length < 100) return releases;
    }
    throw Error('Release listing exceeded the bounded pagination limit.');
}

export async function requireAnonymousDenial(url, request = fetch) {
    const resource = new URL(url);
    const metadata =
        resource.hostname === 'api.github.com' &&
        !/\/releases\/assets\/\d+$/.test(resource.pathname);
    const response = await request(url, {
        method: 'GET',
        redirect: 'manual',
        headers: metadata
            ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
            : { Accept: 'application/octet-stream', Range: 'bytes=0-0' },
    });
    await response.body?.cancel();
    assert.equal(
        response.status,
        404,
        'Expected anonymous draft denial; transport/rate-limit errors are not privacy evidence. Status: ' +
            response.status +
            ' at ' +
            resource.origin +
            resource.pathname,
    );
}
