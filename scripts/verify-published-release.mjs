import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    validatePublishedRelease,
    readPublicAsset,
    validatePublishedFiles,
    selectedPublishedTag,
} from './lib/published-release.mjs';
import { listAllReleases } from './lib/release-draft.mjs';
import { previousRelease, releasePageNotes, meaningfulReleaseLinks } from './lib/release-notes.mjs';
const repository = process.env.GITHUB_REPOSITORY;
assert.equal(repository, 'brucerry/embedded-linux-diagnostic-hub');
const api = 'https://api.github.com/repos/' + repository;
async function read(url) {
    assert.ok(url.startsWith(api + '/releases'));
    const response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
            Accept: 'application/vnd.github+json',
            ...(process.env.GH_TOKEN ? { Authorization: 'Bearer ' + process.env.GH_TOKEN } : {}),
        },
        signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, 'Published metadata unavailable: ' + response.status);
    return response.json();
}
const selected = selectedPublishedTag(process.env.HUB_PUBLISHED_TAG ?? '');
const release = await read(api + '/releases/' + (selected ? 'tags/' + selected : 'latest'));
const tag = release.tag_name;
assert.ok(selectedPublishedTag(tag));
const commit = execFileSync('git', ['rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}'], {
    encoding: 'utf8',
}).trim();
function blob(name) {
    return execFileSync('git', ['show', tag + ':' + name], { maxBuffer: 32 * 1024 * 1024 });
}
const packageInfo = JSON.parse(blob('package.json').toString());
const context = {
    repository,
    tag,
    version: packageInfo.version,
    commit,
    allowPrerelease: Boolean(selected),
};
validatePublishedRelease(release, context);
if (!selected) {
    const latest = await read(api + '/releases/latest');
    assert.equal(latest.id, release.id, 'Latest selection changed during verification.');
}
const directory = await mkdtemp(path.join(tmpdir(), 'hub-published-audit-'));
await mkdir(path.join(directory, 'release'));
await writeFile(path.join(directory, 'package.json'), blob('package.json'));
const files = {};
for (const asset of release.assets) {
    const bytes = await readPublicAsset(asset);
    files[asset.name] = bytes;
    await writeFile(path.join(directory, 'release', asset.name), bytes);
    console.log('Verified public asset: ' + asset.name + '; ' + asset.digest);
}
validatePublishedFiles(
    files,
    { ...context, minimumMacOSVersion: packageInfo.build.mac.minimumSystemVersion },
    blob,
);
execFileSync(process.execPath, [path.resolve('scripts/verify-release.mjs'), '--assets'], {
    cwd: directory,
    env: { ...process.env, GITHUB_SHA: commit, GITHUB_REF_NAME: tag },
    stdio: 'inherit',
});
const releases = await listAllReleases((page) => read(api + '/releases?per_page=100&page=' + page));
let highlights = '';
for (const suffix of ['txt', 'md']) {
    try {
        highlights = blob('docs/releases/' + tag + '.' + suffix).toString();
        break;
    } catch {
        /* A source without highlights uses generated package notes. */
    }
}
const expectedNotes = releasePageNotes({
    repository,
    currentTag: tag,
    previousTag: previousRelease(releases, tag),
    highlights,
    packageNotes: await readFile(path.join(directory, 'release/notes.md'), 'utf8'),
});
assert.equal(
    meaningfulReleaseLinks(release.body).trim(),
    meaningfulReleaseLinks(expectedNotes).trim(),
    'Published notes differ from source-generated notes.',
);
const fresh = await read(api + '/releases/' + release.id);
validatePublishedRelease(fresh, context);
assert.equal(meaningfulReleaseLinks(fresh.body), meaningfulReleaseLinks(release.body));
assert.deepEqual(
    fresh.assets
        .map(({ id, name, size, digest }) => ({ id, name, size, digest }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    release.assets
        .map(({ id, name, size, digest }) => ({ id, name, size, digest }))
        .sort((a, b) => a.name.localeCompare(b.name)),
);
if (process.env.GITHUB_OUTPUT)
    await writeFile(
        process.env.GITHUB_OUTPUT,
        'tag=' +
            tag +
            '\ncommit=' +
            commit +
            '\nrelease-id=' +
            release.id +
            '\nasset-count=' +
            release.assets.length +
            '\n',
        { flag: 'a' },
    );
if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(
        process.env.GITHUB_STEP_SUMMARY,
        'Read-only audit of already published ' +
            tag +
            ': all ' +
            release.assets.length +
            ' public files, digests, sidecars, manifests, tag helpers and source notes verified. Consumer source: ' +
            commit +
            '. No publication/upload/tag mutation occurred. Historical failed publication runs remain unchanged.\n',
        { flag: 'a' },
    );
console.log(
    JSON.stringify({
        readOnlyPublishedAuditPassed: true,
        tag,
        source: commit,
        releaseId: release.id,
        verifiedFiles: release.assets.length,
        serverMutations: 0,
    }),
);
