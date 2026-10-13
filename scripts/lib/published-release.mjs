import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { releaseAssets } from './release-assets.mjs';
import { MAC_ARCHES, macManifest, validateMacManifest, macAsset } from './macos-release.mjs';
import { SOURCE_SHA, MAC_DRAFT_ID, REUSED_MAC_ASSETS } from './release-recovery.mjs';

export function publishedCatalog(version) {
    return [
        ...releaseAssets(version).flatMap((name) => [name, name + '.sha256']),
        'build-info.json',
        'linux-build-info.json',
        ...MAC_ARCHES.map(macManifest),
    ].sort();
}
export function validatePublishedRelease(release, { repository, tag, version, commit }) {
    assert.equal(repository, 'brucerry/embedded-linux-diagnostic-hub');
    assert.match(tag, /^v\d+\.\d+\.\d+$/);
    assert.equal(tag, 'v' + version);
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.ok(Number.isSafeInteger(release.id));
    assert.equal(release.draft, false, 'Audit only an already published release.');
    assert.equal(
        release.prerelease,
        false,
        'The documented latest command requires a stable release.',
    );
    assert.equal(release.tag_name, tag);
    assert.equal(release.target_commitish, commit);
    assert.equal(release.name, tag);
    assert.equal(release.html_url, 'https://github.com/' + repository + '/releases/tag/' + tag);
    assert.deepEqual(release.assets.map((asset) => asset.name).sort(), publishedCatalog(version));
    assert.equal(new Set(release.assets.map((asset) => asset.id)).size, release.assets.length);
    for (const asset of release.assets) {
        assert.ok(Number.isSafeInteger(asset.id));
        assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size < 2 ** 31);
        assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
        assert.equal(
            asset.browser_download_url,
            'https://github.com/' + repository + '/releases/download/' + tag + '/' + asset.name,
        );
    }
    if (tag === 'v0.4.0') {
        assert.equal(commit, SOURCE_SHA);
        assert.equal(release.id, MAC_DRAFT_ID);
        for (const pinned of REUSED_MAC_ASSETS) {
            const asset = release.assets.find((candidate) => candidate.name === pinned.name);
            assert.equal(asset.id, pinned.id);
            assert.equal(asset.size, pinned.size);
            assert.equal(asset.digest, 'sha256:' + pinned.sha256);
        }
    }
    return release;
}
export async function readPublicAsset(asset, request = fetch) {
    let url = asset.browser_download_url;
    for (let redirects = 0; redirects <= 5; redirects++) {
        const parsed = new URL(url);
        assert.equal(parsed.protocol, 'https:');
        assert.ok(
            !parsed.username && !parsed.password,
            'Public redirects cannot include credentials.',
        );
        assert.ok(
            [
                'github.com',
                'release-assets.githubusercontent.com',
                'objects.githubusercontent.com',
            ].includes(parsed.hostname),
        );
        const response = await request(url, {
            method: 'GET',
            redirect: 'manual',
            headers: { Accept: 'application/octet-stream' },
            signal: AbortSignal.timeout(30000),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            url = new URL(response.headers.get('location'), url).href;
            continue;
        }
        assert.equal(response.status, 200, 'Anonymous public asset unavailable: ' + asset.name);
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length;
            assert.ok(length <= asset.size, 'Public download exceeds declared size.');
            chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, asset.size);
        assert.equal(
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
            asset.digest,
            'Public asset bytes changed: ' + asset.name,
        );
        return bytes;
    }
    throw Error('Public asset redirect limit exceeded.');
}
export function validatePublishedFiles(files, { version, commit, minimumMacOSVersion }, tagBlob) {
    for (const name of releaseAssets(version)) {
        const digest = createHash('sha256').update(files[name]).digest('hex');
        assert.equal(files[name + '.sha256'].toString(), digest + '  ' + name + '\n');
    }
    for (const name of ['download-run.ps1', 'download-run.sh', 'download-run-macos.sh'])
        assert.ok(
            files[name].equals(tagBlob('public/' + name)),
            'Published helper differs from tag: ' + name,
        );
    for (const arch of MAC_ARCHES) {
        const info = JSON.parse(files[macManifest(arch)].toString());
        validateMacManifest(info, {
            arch,
            version,
            commit,
            sha256: createHash('sha256').update(files[macAsset(arch)]).digest('hex'),
        });
        assert.equal(info.source, commit);
        assert.equal(info.minimumMacOSVersion, minimumMacOSVersion);
        assert.equal(info.packagedSourceMatches, true);
        assert.equal(info.distribution, true);
    }
}
