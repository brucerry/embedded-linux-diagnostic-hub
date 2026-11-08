import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LEGACY_RELEASE_PROFILE,
    includesWindowsSetup,
    releaseAssets,
    WINDOWS_SETUP_RELEASE_PROFILE,
    validateReleaseCatalogue,
} from './lib/release-assets.mjs';
import {
    WINDOWS_SETUP_ASSET,
    MAX_WINDOWS_SETUP_BYTES,
    MAX_WINDOWS_SETUP_INFO_BYTES,
    windowsSetupInfoName,
} from './lib/windows-setup-release.mjs';
import { MAC_ARCHES, macAsset, macManifest, validateMacManifest } from './lib/macos-release.mjs';
import { assertPublishedLinuxMetadataMode } from './lib/linux-build-record.mjs';

// Import is inert. Tests inject memory-backed files/digests; no release or installer is invoked.
export async function verifyReleaseAssets(
    { version, commit, profile = undefined, repository = 'brucerry/embedded-linux-diagnostic-hub' },
    io,
) {
    const files = await io.files();
    const assets = validateReleaseCatalogue({ version, profile, files, inventoryOnly: true });
    let setupExpected;
    for (const file of assets) {
        const measured = structuredClone(
            await io.hash(file, file === WINDOWS_SETUP_ASSET ? MAX_WINDOWS_SETUP_BYTES : Infinity),
        );
        const checksum = await io.read(
            file + '.sha256',
            file === WINDOWS_SETUP_ASSET ? 256 : Infinity,
        );
        if (file === WINDOWS_SETUP_ASSET)
            assert.ok(Buffer.byteLength(checksum) <= 256, 'Setup checksum exceeds its bound.');
        assert.equal(checksum, `${measured.sha256}  ${file}\n`);
        if (file === WINDOWS_SETUP_ASSET)
            setupExpected = {
                version,
                commit,
                asset: file,
                bytes: measured.bytes,
                sha256: measured.sha256,
            };
    }
    if (includesWindowsSetup(version)) {
        const bytes = await io.read(
            windowsSetupInfoName(WINDOWS_SETUP_ASSET),
            MAX_WINDOWS_SETUP_INFO_BYTES,
        );
        assert.ok(
            Buffer.byteLength(bytes) <= MAX_WINDOWS_SETUP_INFO_BYTES,
            'Setup descriptor exceeds its bound.',
        );
        const setupInfo = JSON.parse(bytes);
        validateReleaseCatalogue({ version, profile, files, setupInfo, setupExpected });
    }
    const info = JSON.parse((await io.read('build-info.json')).replace(/^\uFEFF/, ''));
    assert.equal(info.version, version);
    assert.equal(info.commit, commit);
    assert.ok(['Valid', 'NotSigned'].includes(info.signature));
    const linux = JSON.parse(await io.read('linux-build-info.json'));
    assertPublishedLinuxMetadataMode(linux);
    assert.equal(linux.version, version);
    assert.equal(linux.commit, commit);
    assert.equal(linux.platform, 'linux');
    assert.equal(linux.arch, 'x64');
    for (const [name, checksum] of Object.entries(linux.assets))
        assert.equal((await io.read(`${name}.sha256`)).split('  ')[0], checksum);
    assert.deepEqual(
        Object.keys(linux.assets).sort(),
        ['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz'].sort(),
    );
    for (const arch of MAC_ARCHES) {
        const mac = JSON.parse(await io.read(macManifest(arch)));
        const sha256 = (await io.read(macAsset(arch) + '.sha256')).split('  ')[0];
        validateMacManifest(mac, { arch, version, commit, sha256 });
    }
    const signing =
        info.signature === 'Valid'
            ? 'Windows Authenticode signature: valid.'
            : 'Unsigned build. Windows may show an unknown-publisher warning.';
    await io.notes(
        `Portable Windows and Linux x64 apps, native Intel and Apple Silicon Mac apps, website, and SSH gateway. Mac apps use ad-hoc integrity signatures and are not Developer ID signed or notarized. Mac updates are manual.\n\n${signing}\n\n[Downloads and setup](https://github.com/${repository}/blob/v${version}/docs/downloads.md). Commit: ${info.commit}\n`,
    );
    return {
        profile: includesWindowsSetup(version)
            ? WINDOWS_SETUP_RELEASE_PROFILE
            : LEGACY_RELEASE_PROFILE,
        assets,
        setupDescriptorVerified: includesWindowsSetup(version),
        nativeQualification: 'NOT_ESTABLISHED',
    };
}

export function releaseProfileFromArgs(argv, version) {
    const profiles = argv.filter((arg) => arg.startsWith('--profile='));
    assert.ok(profiles.length <= 1, 'Select at most one release profile.');
    assert.ok(
        argv.every((arg) => arg === '--assets' || arg.startsWith('--profile=')),
        'Unknown release argument.',
    );
    const expected = includesWindowsSetup(version)
        ? WINDOWS_SETUP_RELEASE_PROFILE
        : LEGACY_RELEASE_PROFILE;
    const profile = profiles.length ? profiles[0].slice('--profile='.length) : expected;
    assert.equal(
        profile,
        expected,
        'Profile cannot downgrade or alter the version-derived catalogue.',
    );
    assert.ok(
        !profiles.length || argv.includes('--assets'),
        'An explicit profile requires asset verification.',
    );
    return profile;
}

async function main() {
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, 'Use a semantic release version.');
    assert.equal(
        process.env.GITHUB_REF_NAME,
        `v${version}`,
        'Tag must match package.json version.',
    );
    const profile = releaseProfileFromArgs(process.argv.slice(2), version);
    if (process.argv.includes('--assets'))
        await verifyReleaseAssets(
            {
                version,
                commit: process.env.GITHUB_SHA,
                profile,
                repository: process.env.GITHUB_REPOSITORY,
            },
            {
                files: () => readdir('release'),
                async read(file, cap = Infinity) {
                    if (!Number.isFinite(cap)) return readFile(path.join('release', file), 'utf8');
                    let bytes = 0;
                    const chunks = [];
                    for await (const chunk of createReadStream(path.join('release', file), {
                        highWaterMark: Math.min(4096, cap + 1),
                    })) {
                        bytes += chunk.length;
                        assert.ok(bytes <= cap, 'Release metadata exceeds its bound.');
                        chunks.push(chunk);
                    }
                    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
                },
                async hash(file, limit) {
                    const hash = createHash('sha256');
                    let bytes = 0;
                    for await (const chunk of createReadStream(path.join('release', file))) {
                        bytes += chunk.length;
                        assert.ok(bytes <= limit, 'Release artifact exceeds its bound.');
                        hash.update(chunk);
                    }
                    return { bytes, sha256: hash.digest('hex') };
                },
                notes: (text) => writeFile('release/notes.md', text),
            },
        );
    console.log(`Release version verified: v${version}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
