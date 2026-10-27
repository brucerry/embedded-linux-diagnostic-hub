import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
    releaseAssets,
    validateReleaseCatalogue,
    LEGACY_RELEASE_PROFILE,
    WINDOWS_SETUP_RELEASE_PROFILE,
    includesWindowsSetup,
    releaseMetadata,
    releaseCatalog,
} from '../scripts/lib/release-assets.mjs';
import { releaseAssets as frozenAssets } from '../../basis/scripts/lib/release-assets.mjs';
import {
    WINDOWS_SETUP_ASSET,
    createWindowsSetupInfo,
} from '../scripts/lib/windows-setup-release.mjs';
import { verifyReleaseAssets, releaseProfileFromArgs } from '../scripts/verify-release.mjs';
const sha = (text) => createHash('sha256').update(text).digest('hex');
function fixture(version = '0.6.0', profile = undefined) {
    const commit = 'a'.repeat(40),
        files = new Map(),
        log = [];
    for (const asset of releaseAssets(version, profile)) {
        const bytes = Buffer.from('synthetic non-executable ' + asset);
        files.set(asset, bytes);
        files.set(asset + '.sha256', Buffer.from(sha(bytes) + '  ' + asset + '\n'));
    }
    const json = (file, value) => files.set(file, Buffer.from(JSON.stringify(value)));
    json('build-info.json', { version, commit, signature: 'NotSigned' });
    const linuxNames = ['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz'];
    json('linux-build-info.json', {
        version,
        commit,
        platform: 'linux',
        arch: 'x64',
        assets: Object.fromEntries(linuxNames.map((n) => [n, sha(files.get(n))])),
    });
    for (const arch of ['x64', 'arm64']) {
        const asset = `Diagnostic-Hub-macos-${arch}.zip`;
        json(`macos-build-info-${arch}.json`, {
            version,
            commit,
            platform: 'darwin',
            arch,
            asset,
            sha256: sha(files.get(asset)),
            asarSHA256: 'c'.repeat(64),
            bundleIdentifier: 'dev.diagnostichub.desktop',
            minimumMacOSVersion: '13.0.0',
            signature: 'ad-hoc',
            adHocIntegrityVerified: true,
            notarized: false,
            gatekeeperDownloadedAppQualified: false,
        });
    }
    let expected, info;
    if (includesWindowsSetup(version)) {
        expected = {
            version,
            commit,
            asset: WINDOWS_SETUP_ASSET,
            bytes: files.get(WINDOWS_SETUP_ASSET).length,
            sha256: sha(files.get(WINDOWS_SETUP_ASSET)),
        };
        info = createWindowsSetupInfo({ ...expected, payloadManifestSHA256: 'd'.repeat(64) });
        json(WINDOWS_SETUP_ASSET + '.info.json', info);
    }
    const io = {
        files: async () => [...files.keys()],
        read: async (file, cap = Infinity) => {
            log.push(['read', file]);
            const bytes = files.get(file);
            assert(bytes && bytes.length <= cap);
            return bytes.toString();
        },
        hash: async (file, cap) => {
            log.push(['hash', file]);
            const bytes = files.get(file);
            assert(bytes && bytes.length <= cap);
            return { bytes: bytes.length, sha256: sha(bytes) };
        },
        notes: async (text) => log.push(['notes', text]),
    };
    return { files, log, io, json, expected, info, options: { version, commit, profile } };
}
const noNotes = (f) => assert(!f.log.some(([kind]) => kind === 'notes'));
test('legacy catalogue is byte-equivalent to retained implementation for historical current and preview versions', () => {
    for (const version of ['0.1.0', '0.5.2', '0.6.0', '0.6.0-rc.1', '1.0.0']) {
        assert.deepEqual(releaseAssets(version), frozenAssets(version));
        assert.deepEqual(
            releaseAssets(
                version,
                includesWindowsSetup(version)
                    ? WINDOWS_SETUP_RELEASE_PROFILE
                    : LEGACY_RELEASE_PROFILE,
            ),
            frozenAssets(version),
        );
    }
});
test('version-derived setup default remains frozen; matching profile only asserts that contract', () => {
    assert.deepEqual(releaseAssets('0.6.0', WINDOWS_SETUP_RELEASE_PROFILE), frozenAssets('0.6.0'));
    assert(releaseAssets('0.6.0').includes(WINDOWS_SETUP_ASSET));
    assert(
        releaseAssets('0.6.0-rc.1', WINDOWS_SETUP_RELEASE_PROFILE).includes(WINDOWS_SETUP_ASSET),
    );
});
test('profile and version selection reject historical setup unknown profiles malformed versions and implicit flags', () => {
    for (const v of ['0.5.2', 'v0.6.0', 'bad'])
        assert.throws(() => releaseAssets(v, WINDOWS_SETUP_RELEASE_PROFILE));
    assert.throws(() => releaseAssets('0.6.0', 'automatic'));
    assert.equal(releaseProfileFromArgs(['--assets'], '0.5.2'), LEGACY_RELEASE_PROFILE);
    assert.equal(
        releaseProfileFromArgs(['--assets', '--profile=windows-setup'], '0.6.0'),
        WINDOWS_SETUP_RELEASE_PROFILE,
        includesWindowsSetup,
        releaseMetadata,
        releaseCatalog,
    );
    for (const args of [
        ['--profile=windows-setup'],
        ['--profile=automatic'],
        ['--assets', '--profile=legacy', '--profile=windows-setup'],
        ['--publish'],
    ])
        assert.throws(() => releaseProfileFromArgs(args, '0.6.0'));
});
test('valid setup catalogue verifies descriptor against independently hashed synthetic executable without qualification', async () => {
    const f = fixture();
    const result = await verifyReleaseAssets(f.options, f.io);
    assert.equal(result.setupDescriptorVerified, true);
    assert.equal(result.nativeQualification, 'NOT_ESTABLISHED');
    assert.equal(f.log.filter(([kind]) => kind === 'notes').length, 1);
});
test('legacy verifier still accepts historical complete assets and unchanged notes wording', async () => {
    const f = fixture('0.5.2', LEGACY_RELEASE_PROFILE);
    const r = await verifyReleaseAssets(f.options, f.io);
    assert.equal(r.setupDescriptorVerified, false);
    assert.deepEqual(r.assets, frozenAssets('0.5.2'));
    assert.equal(
        f.log.at(-1)[1],
        `Portable Windows and Linux x64 apps, native Intel and Apple Silicon Mac apps, website, and SSH gateway. Mac apps use ad-hoc integrity signatures and are not Developer ID signed or notarized. Mac updates are manual.\n\nUnsigned build. Windows may show an unknown-publisher warning.\n\n[Downloads and setup](https://github.com/brucerry/embedded-linux-diagnostic-hub/blob/v0.5.2/docs/downloads.md). Commit: ${f.options.commit}\n`,
    );
});
for (const missing of [
    WINDOWS_SETUP_ASSET,
    WINDOWS_SETUP_ASSET + '.sha256',
    WINDOWS_SETUP_ASSET + '.info.json',
])
    test('missing setup material refuses before hashes/notes: ' + missing, async () => {
        const f = fixture();
        f.files.delete(missing);
        await assert.rejects(verifyReleaseAssets(f.options, f.io));
        assert.equal(f.log.length, 0);
        noNotes(f);
    });
for (const duplicate of [
    WINDOWS_SETUP_ASSET,
    WINDOWS_SETUP_ASSET + '.sha256',
    WINDOWS_SETUP_ASSET + '.info.json',
])
    test('duplicate catalogue entry refuses before IO effects: ' + duplicate, async () => {
        const f = fixture();
        f.io.files = async () => [...f.files.keys(), duplicate];
        await assert.rejects(verifyReleaseAssets(f.options, f.io));
        assert.equal(f.log.length, 0);
    });
for (const extra of ['Unexpected.exe', 'Unexpected.exe.sha256', 'Unexpected.exe.info.json'])
    test('unexpected release asset/sidecar refuses: ' + extra, async () => {
        const f = fixture();
        f.files.set(extra, Buffer.from('not adopted'));
        await assert.rejects(verifyReleaseAssets(f.options, f.io));
        noNotes(f);
    });
for (const [key, value] of Object.entries({
    version: '0.5.2',
    commit: 'b'.repeat(40),
    asset: 'Other.exe',
    bytes: 999,
    sha256: 'b'.repeat(64),
    platform: 'linux',
    arch: 'arm64',
    payloadManifestSHA256: 'bad',
}))
    test('descriptor mismatch refuses without notes: ' + key, async () => {
        const f = fixture();
        f.json(WINDOWS_SETUP_ASSET + '.info.json', { ...f.info, [key]: value });
        await assert.rejects(verifyReleaseAssets(f.options, f.io));
        noNotes(f);
    });
test('catalogue content validation cannot omit descriptor or independent selected identity', () => {
    const f = fixture();
    for (const values of [{}, { setupInfo: f.info }, { setupExpected: f.expected }])
        assert.throws(() =>
            validateReleaseCatalogue({ ...f.options, files: [...f.files.keys()], ...values }),
        );
});
test('modified executable or malformed oversized metadata cannot produce verified notes', async () => {
    for (const change of [
        (f) => f.files.set(WINDOWS_SETUP_ASSET, Buffer.from('different synthetic bytes')),
        (f) => f.files.set(WINDOWS_SETUP_ASSET + '.info.json', Buffer.from('not json')),
        (f) => f.files.set(WINDOWS_SETUP_ASSET + '.info.json', Buffer.alloc(16385, 32)),
        (f) => f.files.set(WINDOWS_SETUP_ASSET + '.sha256', Buffer.alloc(257, 32)),
    ]) {
        const f = fixture();
        change(f);
        await assert.rejects(verifyReleaseAssets(f.options, f.io));
        noNotes(f);
    }
});
test('setup inputs cannot be adopted under legacy profile', async () => {
    const f = fixture();
    await assert.rejects(
        verifyReleaseAssets({ ...f.options, profile: LEGACY_RELEASE_PROFILE }, f.io),
    );
    noNotes(f);
});

test('later adapter callback cannot rewrite previously measured setup digest', async () => {
    const f = fixture();
    const originalHash = f.io.hash,
        originalRead = f.io.read;
    let borrowed;
    f.io.hash = async (file, cap) => {
        const value = await originalHash(file, cap);
        if (file === WINDOWS_SETUP_ASSET) borrowed = value;
        return value;
    };
    f.io.read = async (file, cap) => {
        if (file === WINDOWS_SETUP_ASSET + '.sha256') {
            borrowed.sha256 = 'b'.repeat(64);
            return borrowed.sha256 + '  ' + WINDOWS_SETUP_ASSET + '\n';
        }
        return originalRead(file, cap);
    };
    await assert.rejects(verifyReleaseAssets(f.options, f.io));
    noNotes(f);
});

test('all four frozen catalogue exports keep exact historical preview stable and published contracts', async () => {
    const frozen = await import('../../basis/scripts/lib/release-assets.mjs');
    const { publishedCatalog } = await import('../scripts/lib/published-release.mjs');
    const { laneFiles, PLATFORM_LANES } = await import('../scripts/lib/staged-artifact-gate.mjs');
    for (const version of ['0.5.2', '0.5.99', '0.6.0-0', '0.6.0-rc.1', '0.6.0', '1.0.0']) {
        for (const [actual, old] of [
            [releaseAssets, frozen.releaseAssets],
            [releaseMetadata, frozen.releaseMetadata],
            [releaseCatalog, frozen.releaseCatalog],
            [includesWindowsSetup, frozen.includesWindowsSetup],
        ])
            assert.deepEqual(actual(version), old(version));
        const catalog = releaseCatalog(version);
        assert.equal(catalog.length, includesWindowsSetup(version) ? 27 : 24);
        assert.deepEqual(publishedCatalog(version), catalog);
        for (const lane of PLATFORM_LANES)
            for (const file of laneFiles(version, lane.id)) assert(catalog.includes(file));
        assert.equal(
            laneFiles(version, 'win32-x64').includes(WINDOWS_SETUP_ASSET),
            includesWindowsSetup(version),
        );
    }
});
test('no-flag verifier defaults require setup-era triplet and never invent historical setup', async () => {
    for (const version of ['0.5.2', '0.5.99', '0.6.0-0', '0.6.0-rc.1', '0.6.0']) {
        const f = fixture(version);
        const result = await verifyReleaseAssets(f.options, f.io);
        assert.equal(result.setupDescriptorVerified, includesWindowsSetup(version));
        assert.equal(
            releaseProfileFromArgs(['--assets'], version),
            includesWindowsSetup(version) ? WINDOWS_SETUP_RELEASE_PROFILE : LEGACY_RELEASE_PROFILE,
        );
    }
});
test('legacy override cannot turn a reduced24file v0.6 release into a complete catalogue', async () => {
    const f = fixture();
    for (const suffix of ['', '.sha256', '.info.json'])
        f.files.delete(WINDOWS_SETUP_ASSET + suffix);
    assert.equal(f.files.size, 24);
    for (const options of [f.options, { ...f.options, profile: LEGACY_RELEASE_PROFILE }])
        await assert.rejects(verifyReleaseAssets(options, f.io));
    assert.throws(() => releaseProfileFromArgs(['--assets', '--profile=legacy'], '0.6.0'));
    noNotes(f);
});
