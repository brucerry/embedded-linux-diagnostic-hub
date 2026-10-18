import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { distributable, releaseAssets, includesWindowsSetup } from './lib/release-assets.mjs';
import {
    WINDOWS_SETUP_ASSET,
    validateWindowsSetupInfo,
    windowsSetupInfoName,
} from './lib/windows-setup-release.mjs';
import { MAC_ARCHES, macAsset, macManifest, validateMacManifest } from './lib/macos-release.mjs';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, 'Use a semantic release version.');
assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Tag must match package.json version.');
if (process.argv.includes('--assets')) {
    const files = (await readdir('release')).filter(distributable).sort();
    assert.deepEqual(files, releaseAssets(version));
    for (const file of files) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path.join('release', file))) hash.update(chunk);
        assert.equal(
            await readFile(`release/${file}.sha256`, 'utf8'),
            `${hash.digest('hex')}  ${file}\n`,
        );
    }
    const info = JSON.parse(
        (await readFile('release/build-info.json', 'utf8')).replace(/^\uFEFF/, ''),
    );
    assert.equal(info.version, version);
    assert.equal(info.commit, process.env.GITHUB_SHA);
    assert.ok(['Valid', 'NotSigned'].includes(info.signature));
    if (includesWindowsSetup(version)) {
        const bytes = await readFile(path.join('release', WINDOWS_SETUP_ASSET));
        validateWindowsSetupInfo(
            JSON.parse(
                await readFile(
                    path.join('release', windowsSetupInfoName(WINDOWS_SETUP_ASSET)),
                    'utf8',
                ),
            ),
            {
                version,
                commit: process.env.GITHUB_SHA,
                asset: WINDOWS_SETUP_ASSET,
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            },
        );
    }
    const linux = JSON.parse(await readFile('release/linux-build-info.json', 'utf8'));
    assert.equal(linux.version, version);
    assert.equal(linux.commit, process.env.GITHUB_SHA);
    assert.equal(linux.platform, 'linux');
    assert.equal(linux.arch, 'x64');
    for (const [name, checksum] of Object.entries(linux.assets)) {
        assert.equal((await readFile(`release/${name}.sha256`, 'utf8')).split('  ')[0], checksum);
    }
    assert.deepEqual(
        Object.keys(linux.assets).sort(),
        ['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz'].sort(),
    );
    for (const arch of MAC_ARCHES) {
        const mac = JSON.parse(await readFile(path.join('release', macManifest(arch)), 'utf8'));
        const sha256 = (
            await readFile(path.join('release', macAsset(arch) + '.sha256'), 'utf8')
        ).split('  ')[0];
        validateMacManifest(mac, { arch, version, commit: process.env.GITHUB_SHA, sha256 });
    }
    const signing =
        info.signature === 'Valid'
            ? 'Windows Authenticode signature: valid.'
            : 'Unsigned build. Windows may show an unknown-publisher warning.';
    await writeFile(
        'release/notes.md',
        `Portable Windows and Linux x64 apps, native Intel and Apple Silicon Mac apps, website, and SSH gateway. Mac apps use ad-hoc integrity signatures and are not Developer ID signed or notarized. Mac updates are manual.\n\n${signing}\n\n[Downloads and setup](https://github.com/${process.env.GITHUB_REPOSITORY ?? 'brucerry/embedded-linux-diagnostic-hub'}/blob/v${version}/docs/downloads.md). Commit: ${info.commit}\n`,
    );
}
console.log(`Release version verified: v${version}`);
