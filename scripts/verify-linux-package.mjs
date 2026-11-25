import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listPackage, extractFile } from '@electron/asar';
import { validateLinuxReviewCapability, reviewBundleHash } from './lib/linux-review-package.mjs';
import { LINUX_ASSET, LINUX_ARCHIVE } from './lib/release-assets.mjs';
import { verifyDesktopPackageBundles } from './lib/desktop-package-bundles.mjs';
import {
    readLinuxTarPermanentMembers,
    verifyLinuxPermanentDirectoryModes,
} from './lib/linux-permanent-member-modes.mjs';

// The isolated build controller consumes only these fixed markers and keeps raw output private.
const reportPhases = process.env.DIAGNOSTIC_HUB_LINUX_VERIFY_PHASES === '1';
function mark(condition) {
    if (reportPhases) process.stdout.write(`HUB_LINUX_VERIFY_PHASE ${condition}\n`);
}

mark('prepare');
const directory = path.resolve(process.argv[2] ?? 'release');
const temporary = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-linux-package-'));
const unpacked = path.join(directory, 'linux-unpacked');
const launcher = await readFile('scripts/linux-launcher.sh');

async function verifyBundle(root) {
    assert.ok(
        (await readFile(path.join(root, 'AppRun'))).equals(launcher),
        'Production launcher must match the reviewed source.',
    );
    const archive = path.join(root, 'resources/app.asar');
    const reviewEntry = await readFile('dist-electron/linux-setup-review.cjs');
    const physicalReview = await readFile(path.join(root, 'resources/linux-setup-review.cjs'));
    const appPackage = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
    const reviewMetadata = validateLinuxReviewCapability(
        JSON.parse(
            (await readFile(path.join(root, 'resources/linux-setup-review.json'))).toString('utf8'),
        ),
        appPackage.version,
    );
    assert.ok(reviewEntry.equals(physicalReview), 'Stale physical read-only review entry.');
    assert.equal(reviewMetadata.bytes, physicalReview.length);
    assert.equal(reviewMetadata.sha256, reviewBundleHash(physicalReview));

    assert.ok(
        !listPackage(archive).some((file) =>
            /(?:genie|native-window|taskbar-query|koffi)/i.test(file),
        ),
        'Retired motion asset is packaged.',
    );
    await verifyDesktopPackageBundles({
        readBuild: (file) => readFile(file),
        readPackaged: (file) => extractFile(archive, file),
    });
    assert.ok(
        reviewEntry.equals(extractFile(archive, 'dist-electron/linux-setup-review.cjs')),
        'Stale packaged bundle: linux-setup-review.cjs',
    );
    for (const file of await readdir('dist/assets'))
        assert.ok(
            (await readFile(`dist/assets/${file}`)).equals(
                extractFile(archive, `dist/assets/${file}`),
            ),
            `Stale packaged bundle: ${file}`,
        );
    for (const file of ['app-icon.svg', 'app-icon.png', 'app-icon.ico']) {
        assert.ok((await readFile(`public/${file}`)).equals(extractFile(archive, `dist/${file}`)));
    }
    const executable = await readFile(path.join(root, 'diagnostic-hub'));
    assert.equal(executable.subarray(0, 4).toString(), '\x7fELF');
    assert.equal(executable[4], 2, 'Executable must be ELF64.');
    assert.equal(executable.readUInt16LE(18), 62, 'Executable must be x86_64.');
}
try {
    mark('staged_bundle');
    if (existsSync(unpacked)) {
        await verifyLinuxPermanentDirectoryModes(unpacked);
        await verifyBundle(unpacked);
    }
    mark('tar_headers');
    await readLinuxTarPermanentMembers(path.join(directory, LINUX_ARCHIVE), {
        async consume(archiveFd, archiveRoot) {
            mark('tar_extract');
            const archiveDirectory = path.join(temporary, 'archive');
            await mkdir(archiveDirectory);
            const extraction = spawnSync(
                'tar',
                ['--no-same-owner', '--no-same-permissions', '-xzf', '-', '-C', archiveDirectory],
                { stdio: [archiveFd, 'pipe', 'pipe'], encoding: 'utf8' },
            );
            assert.equal(extraction.status, 0, extraction.stderr);
            mark('tar_contents');
            await verifyBundle(path.join(archiveDirectory, archiveRoot));
            mark('tar_final_identity');
        },
    });
    mark('appimage_extract');
    const image = path.join(directory, LINUX_ASSET);
    const extraction = spawnSync(image, ['--appimage-extract'], {
        cwd: temporary,
        encoding: 'utf8',
    });
    assert.equal(extraction.status, 0, extraction.stderr);
    mark('appimage_contents');
    const appdir = path.join(temporary, 'squashfs-root');
    assert.ok(
        (await readFile(path.join(appdir, 'AppRun'))).equals(launcher),
        'AppImage launcher must match the reviewed launcher.',
    );
    await verifyLinuxPermanentDirectoryModes(appdir);
    await verifyBundle(appdir);
    console.log(
        'Linux AppImage/archive verified: current renderer/backend/icons, ELF64 architecture, permanent-installer modes and sandbox-preserving launcher.',
    );
    mark('inner_cleanup');
} finally {
    await rm(temporary, { recursive: true, force: true });
}
mark('complete');
