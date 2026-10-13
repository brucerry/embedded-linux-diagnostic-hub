import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { meaningfulReleaseLinks } from './lib/release-notes.mjs';
const repository = process.env.GITHUB_REPOSITORY;
assert.equal(repository, 'brucerry/embedded-linux-diagnostic-hub');
assert.ok(process.env.GH_TOKEN, 'Use only the existing job token.');
const authorizations = JSON.parse(
    await readFile('docs/releases/link-format-authorizations.json', 'utf8'),
);
const selected = process.env.HUB_LABEL_TAG?.trim();
const authorization = selected
    ? authorizations.find((entry) => entry.tag === selected)
    : authorizations[0];
assert.ok(authorization, 'Only a reviewed, explicitly authorized presentation change can run.');
const api = 'https://api.github.com/repos/' + repository + '/releases/' + authorization.id;
async function request(method = 'GET', body) {
    const response = await fetch(api, {
        method,
        redirect: 'error',
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer ' + process.env.GH_TOKEN,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, 'Authorized note format request failed: ' + response.status);
    return response.json();
}
function identity(value) {
    assert.equal(value.id, authorization.id);
    assert.equal(value.tag_name, authorization.tag);
    assert.equal(value.target_commitish, authorization.commit);
    assert.equal(value.name, authorization.tag);
    assert.equal(value.draft, false);
}
const before = await request();
identity(before);
const sha = (body) => createHash('sha256').update(body).digest('hex');
const formatted = meaningfulReleaseLinks(before.body);
assert.equal(sha(formatted), authorization.afterSHA256);
if (sha(before.body) === authorization.afterSHA256) {
    console.log('Authorized meaningful links are already present; no mutation.');
} else {
    assert.equal(
        sha(before.body),
        authorization.beforeSHA256,
        'Body changed outside reviewed formatting scope.',
    );
    const fresh = await request();
    identity(fresh);
    assert.equal(fresh.body, before.body);
    const updated = await request('PATCH', { body: formatted });
    identity(updated);
    assert.equal(updated.body, formatted);
}
const after = await request();
identity(after);
assert.equal(after.body, formatted);
for (const field of [
    'created_at',
    'published_at',
    'prerelease',
    'tag_name',
    'target_commitish',
    'name',
])
    assert.deepEqual(after[field], before[field]);
const assets = (release) =>
    release.assets
        .map(({ id, name, size, digest, created_at, updated_at, browser_download_url }) => ({
            id,
            name,
            size,
            digest,
            created_at,
            updated_at,
            browser_download_url,
        }))
        .sort((a, b) => a.id - b.id);
assert.deepEqual(
    assets(after),
    assets(before),
    'All asset identities/digests/timestamps must remain unchanged.',
);
console.log(
    JSON.stringify({
        authorizedBodyLinkFormattingPassed: true,
        tag: after.tag_name,
        source: after.target_commitish,
        assetsUnchanged: after.assets.length,
        bodySHA256: sha(after.body),
    }),
);
