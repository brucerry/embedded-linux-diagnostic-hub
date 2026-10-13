import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
    publishedCatalog,
    validatePublishedRelease,
    readPublicAsset,
    validatePublishedFiles,
} from '../scripts/lib/published-release.mjs';
import { releaseAssets } from '../scripts/lib/release-assets.mjs';
import { SOURCE_SHA, MAC_DRAFT_ID, REUSED_MAC_ASSETS } from '../scripts/lib/release-recovery.mjs';

test('qualified v0.4.0 identity and existing uploaded Mac IDs remain mandatory', () => {
    const audit = { ...context, tag: 'v0.4.0', version: '0.4.0', commit: SOURCE_SHA };
    const release = {
        ...fixture(),
        id: MAC_DRAFT_ID,
        name: audit.tag,
        tag_name: audit.tag,
        target_commitish: SOURCE_SHA,
        html_url: 'https://github.com/' + audit.repository + '/releases/tag/' + audit.tag,
        assets: publishedCatalog(audit.version).map((name, index) => {
            const pin = REUSED_MAC_ASSETS.find((asset) => asset.name === name);
            return {
                name,
                id: pin?.id ?? index + 1,
                size: pin?.size ?? 3,
                digest: 'sha256:' + (pin?.sha256 ?? 'b'.repeat(64)),
                browser_download_url:
                    'https://github.com/' +
                    audit.repository +
                    '/releases/download/' +
                    audit.tag +
                    '/' +
                    name,
            };
        }),
    };
    validatePublishedRelease(release, audit);
    assert.throws(() => validatePublishedRelease({ ...release, id: MAC_DRAFT_ID + 1 }, audit));
    const mac = release.assets.find((asset) => asset.name === 'Diagnostic-Hub-macos-x64.zip')!;
    mac.id++;
    assert.throws(() => validatePublishedRelease(release, audit));
});
test('downloaded file controls reject changed sidecars, helpers and manifest source/version claims', () => {
    const body = Buffer.from('app');
    const digest = createHash('sha256').update(body).digest('hex');
    function files() {
        const data: Record<string, Buffer> = {};
        for (const name of releaseAssets(context.version)) {
            data[name] = body;
            data[name + '.sha256'] = Buffer.from(digest + '  ' + name + '\n');
        }
        for (const arch of ['x64', 'arm64'])
            data['macos-build-info-' + arch + '.json'] = Buffer.from(
                JSON.stringify({
                    platform: 'darwin',
                    arch,
                    version: context.version,
                    commit: context.commit,
                    source: context.commit,
                    asset: 'Diagnostic-Hub-macos-' + arch + '.zip',
                    sha256: digest,
                    asarSHA256: 'a'.repeat(64),
                    bundleIdentifier: 'dev.diagnostichub.desktop',
                    minimumMacOSVersion: '13.0.0',
                    signature: 'ad-hoc',
                    adHocIntegrityVerified: true,
                    packagedSourceMatches: true,
                    distribution: true,
                    notarized: false,
                    gatekeeperDownloadedAppQualified: false,
                }),
            );
        return data;
    }
    const options = { ...context, minimumMacOSVersion: '13.0.0' };
    validatePublishedFiles(files(), options, () => body);
    for (const name of ['Diagnostic-Hub.exe.sha256', 'download-run-macos.sh']) {
        const data = files();
        data[name] = Buffer.from('changed');
        assert.throws(() => validatePublishedFiles(data, options, () => body));
    }
    for (const change of [
        { source: 'b'.repeat(40) },
        { version: '0.6.0' },
        { minimumMacOSVersion: '12.0.0' },
        { packagedSourceMatches: false },
    ]) {
        const data = files();
        const name = 'macos-build-info-arm64.json';
        data[name] = Buffer.from(
            JSON.stringify({ ...JSON.parse(data[name].toString()), ...change }),
        );
        assert.throws(() => validatePublishedFiles(data, options, () => body));
    }
});

const context = {
    repository: 'brucerry/embedded-linux-diagnostic-hub',
    tag: 'v0.5.0',
    version: '0.5.0',
    commit: 'a'.repeat(40),
};
function fixture() {
    return {
        id: 100,
        tag_name: context.tag,
        target_commitish: context.commit,
        name: context.tag,
        draft: false,
        prerelease: false,
        immutable: false,
        html_url: 'https://github.com/' + context.repository + '/releases/tag/' + context.tag,
        assets: publishedCatalog(context.version).map((name, index) => ({
            name,
            id: index + 1,
            size: 3,
            digest: 'sha256:' + 'b'.repeat(64),
            browser_download_url:
                'https://github.com/' +
                context.repository +
                '/releases/download/' +
                context.tag +
                '/' +
                name,
        })),
    };
}
test('published audit accepts a complete stable source-bound catalog without assuming GitHub-enforced immutability', () => {
    assert.equal(validatePublishedRelease(fixture(), context).assets.length, 24);
});
test('published audit rejects drafts, source drift, missing/extra/duplicate assets and invalid digests or download origins', () => {
    for (const change of [
        { draft: true },
        { prerelease: true },
        { target_commitish: 'b'.repeat(40) },
        { tag_name: 'v0.4.0' },
        { name: 'renamed' },
    ])
        assert.throws(() => validatePublishedRelease({ ...fixture(), ...change }, context));
    const value = fixture();
    for (const assets of [
        value.assets.slice(1),
        [...value.assets, value.assets[0]],
        [{ ...value.assets[0], digest: 'unavailable' }, ...value.assets.slice(1)],
        [
            { ...value.assets[0], browser_download_url: 'https://attacker.test/file' },
            ...value.assets.slice(1),
        ],
    ])
        assert.throws(() => validatePublishedRelease({ ...value, assets }, context));
});
test('published v0.4.0 audit retains qualified source and pinned Mac asset identities', () => {
    assert.throws(() =>
        validatePublishedRelease(
            { ...fixture(), tag_name: 'v0.4.0', name: 'v0.4.0' },
            { ...context, tag: 'v0.4.0', version: '0.4.0' },
        ),
    );
});
test('public download follows only HTTPS approved hosts, sends only GET without credentials, and checks actual bytes', async () => {
    const body = Buffer.from('app');
    const asset = {
        name: 'app.zip',
        size: body.length,
        digest: 'sha256:' + createHash('sha256').update(body).digest('hex'),
        browser_download_url: 'https://github.com/example/repo/releases/download/v0.5.0/app.zip',
    };
    const calls: { url: string; method: string | undefined; headers: Headers }[] = [];
    const output = await readPublicAsset(asset, async (url: unknown, options?: RequestInit) => {
        calls.push({
            url: String(url),
            method: options?.method,
            headers: new Headers(options?.headers),
        });
        return calls.length === 1
            ? new Response(null, {
                  status: 302,
                  headers: {
                      location:
                          'https://release-assets.githubusercontent.com/file?signature=private-query',
                  },
              })
            : new Response(body);
    });
    assert.ok(output.equals(body));
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.method === 'GET' && !call.headers.has('authorization')));
    for (const location of [
        'http://release-assets.githubusercontent.com/file',
        'https://attacker.test/file',
    ])
        await assert.rejects(
            readPublicAsset(
                asset,
                async () => new Response(null, { status: 302, headers: { location } }),
            ),
        );
    for (const response of [
        new Response(null, { status: 403 }),
        new Response('bad'),
        new Response('longer'),
    ])
        await assert.rejects(readPublicAsset(asset, async () => response));
});
