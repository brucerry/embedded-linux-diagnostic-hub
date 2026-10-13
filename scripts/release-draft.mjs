import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
    requireNewRelease,
    requireOwnedDraft,
    requireAnonymousDenial,
} from './lib/release-draft.mjs';
import { releaseAssets } from './lib/release-assets.mjs';
import { MAC_ARCHES, macAsset, macManifest } from './lib/macos-release.mjs';

const repo = process.env.GITHUB_REPOSITORY;
assert.equal(repo, 'brucerry/embedded-linux-diagnostic-hub');
const token = process.env.GH_TOKEN;
assert.ok(token, 'Use the current job token.');
const tag = process.env.GITHUB_REF_NAME;
const commit = process.env.GITHUB_SHA;
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const api = 'https://api.github.com/repos/' + repo;
const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
};
async function request(url, method = 'GET', body) {
    assert.ok(
        url.startsWith('https://api.github.com/') || url.startsWith('https://uploads.github.com/'),
    );
    const response = await fetch(url, {
        method,
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
    });
    if (!response.ok) throw Error('GitHub ' + method + ' failed: ' + response.status);
    return response.json();
}
const repository = await request(api);
const tagCommit = execFileSync('git', ['rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}'], {
    encoding: 'utf8',
}).trim();
const marker = requireNewRelease({ tag, version, commit, tagCommit, repository });
const endpoint = api + '/releases/tags/' + tag;
const context = { tag, commit, marker };
async function draft() {
    return requireOwnedDraft(await request(endpoint), context);
}
async function privateDraft(release) {
    await requireAnonymousDenial(endpoint);
    for (const asset of release.assets) {
        await requireAnonymousDenial(asset.browser_download_url);
    }
}
async function upload(release, file) {
    await draft();
    assert.ok(
        !release.assets.some((a) => a.name === file),
        'Asset already exists; refuse overwrite: ' + file,
    );
    const body = await readFile(path.join('release', file));
    const url = release.upload_url.split('{')[0] + '?name=' + encodeURIComponent(file);
    const response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body,
        redirect: 'error',
    });
    assert.equal(response.status, 201, 'Asset upload failed: ' + file);
    const asset = await response.json();
    assert.equal(asset.name, file);
    assert.equal(asset.size, body.length);
    assert.equal(
        asset.digest,
        'sha256:' + createHash('sha256').update(body).digest('hex'),
        'Uploaded asset digest mismatch.',
    );
    await requireAnonymousDenial(asset.browser_download_url);
}
const [mode, arch] = process.argv.slice(2);
if (mode === 'create') {
    const existing = await fetch(endpoint, { headers, redirect: 'error' });
    assert.equal(existing.status, 404, 'New release tag must have no existing release.');
    const created = await request(api + '/releases', 'POST', {
        tag_name: tag,
        target_commitish: commit,
        name: tag,
        body: marker,
        draft: true,
        prerelease: tag.includes('-'),
    });
    requireOwnedDraft(created, context);
    await privateDraft(created);
    console.log(
        'Created guarded unpublished draft ' +
            tag +
            ' at ' +
            commit +
            '; anonymous API access denied.',
    );
} else if (mode === 'stage') {
    assert.ok(MAC_ARCHES.includes(arch));
    for (const file of [macAsset(arch), macAsset(arch) + '.sha256', macManifest(arch)])
        await upload(await draft(), file);
    await privateDraft(await draft());
    console.log('Staged native ' + arch + ' assets; anonymous asset/API access denied.');
} else if (mode === 'download') {
    const release = await draft();
    await privateDraft(release);
    for (const architecture of MAC_ARCHES)
        for (const name of [
            macAsset(architecture),
            macAsset(architecture) + '.sha256',
            macManifest(architecture),
        ]) {
            const asset = release.assets.find((a) => a.name === name);
            assert.ok(asset, 'Missing Mac draft asset: ' + name);
            const response = await fetch(asset.url, {
                headers: { ...headers, Accept: 'application/octet-stream' },
                redirect: 'manual',
            });
            let downloaded = response;
            if (response.status !== 200) {
                assert.ok(
                    [302, 307].includes(response.status),
                    'Authenticated asset download failed.',
                );
                const location = new URL(response.headers.get('location'));
                assert.equal(location.protocol, 'https:');
                assert.ok(
                    [
                        'release-assets.githubusercontent.com',
                        'objects.githubusercontent.com',
                    ].includes(location.hostname),
                    'Unexpected asset host.',
                );
                downloaded = await fetch(location, { redirect: 'error' });
            }
            assert.equal(downloaded.status, 200);
            const bytes = Buffer.from(await downloaded.arrayBuffer());
            assert.equal(bytes.length, asset.size);
            assert.equal(
                asset.digest,
                'sha256:' + createHash('sha256').update(bytes).digest('hex'),
                'Downloaded draft digest mismatch.',
            );
            await writeFile(path.join('release', name), bytes);
        }
    console.log('Downloaded both native Mac draft payloads through authenticated API.');
} else if (mode === 'publish') {
    let release = await draft();
    await privateDraft(release);
    const expected = [
        ...releaseAssets(version).flatMap((file) => [file, file + '.sha256']),
        'build-info.json',
        'linux-build-info.json',
        ...MAC_ARCHES.map(macManifest),
    ].sort();
    for (const name of expected)
        if (!release.assets.some((a) => a.name === name)) {
            await upload(await draft(), name);
            release = await draft();
        }
    assert.deepEqual(release.assets.map((a) => a.name).sort(), expected);
    for (const asset of release.assets) {
        const bytes = await readFile(path.join('release', asset.name));
        assert.equal(asset.size, bytes.length);
        assert.equal(
            asset.digest,
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
            'Staged asset differs from validated bytes: ' + asset.name,
        );
    }
    await privateDraft(release);
    // Validation happened earlier in this job; validate again immediately before publication.
    execFileSync(process.execPath, ['scripts/verify-release.mjs', '--assets'], {
        stdio: 'inherit',
    });
    // verify-release rewrites package notes: regenerate the final four-section notes.
    execFileSync(process.execPath, ['scripts/release-notes.mjs'], { stdio: 'inherit' });
    const finalNotes = await readFile('release/notes.md', 'utf8');
    assert.ok(finalNotes.startsWith('Description:\n'));
    release = await draft();
    const published = await request(api + '/releases/' + release.id, 'PATCH', {
        draft: false,
        body: finalNotes,
        make_latest: tag.includes('-') ? 'false' : 'true',
    });
    assert.equal(published.draft, false);
    assert.equal(published.tag_name, tag);
    assert.equal(published.target_commitish, commit);
    console.log(
        'Published ' + published.html_url + ' with ' + expected.length + ' verified assets.',
    );
} else throw Error('Usage: release-draft.mjs create|stage ARCH|download|publish');
