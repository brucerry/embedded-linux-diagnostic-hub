import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractFile } from '@electron/asar';
import { LINUX_ASSET, LINUX_ARCHIVE } from './lib/release-assets.mjs';

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
    for (const folder of ['dist/assets', 'dist-electron']) {
        for (const file of await readdir(folder)) {
            assert.ok(
                (await readFile(`${folder}/${file}`)).equals(
                    extractFile(archive, `${folder}/${file}`),
                ),
                `Stale packaged bundle: ${file}`,
            );
        }
    }
    for (const file of ['app-icon.svg', 'app-icon.png', 'app-icon.ico']) {
        assert.ok((await readFile(`public/${file}`)).equals(extractFile(archive, `dist/${file}`)));
    }
    const executable = await readFile(path.join(root, 'diagnostic-hub'));
    assert.equal(executable.subarray(0, 4).toString(), '\x7fELF');
    assert.equal(executable[4], 2, 'Executable must be ELF64.');
    assert.equal(executable.readUInt16LE(18), 62, 'Executable must be x86_64.');
}
try {
    if (existsSync(unpacked)) await verifyBundle(unpacked);
    const image = path.join(directory, LINUX_ASSET);
    const extraction = spawnSync(image, ['--appimage-extract'], {
        cwd: temporary,
        encoding: 'utf8',
    });
    assert.equal(extraction.status, 0, extraction.stderr);
    const appdir = path.join(temporary, 'squashfs-root');
    assert.ok(
        (await readFile(path.join(appdir, 'AppRun'))).equals(launcher),
        'AppImage launcher must match the reviewed launcher.',
    );
    await verifyBundle(appdir);
    const entries = spawnSync('tar', ['-tzf', path.join(directory, LINUX_ARCHIVE)], {
        encoding: 'utf8',
    });
    assert.equal(entries.status, 0, entries.stderr);
    for (const entry of entries.stdout.trim().split('\n')) {
        assert.ok(
            !entry.startsWith('/') && !entry.split('/').includes('..'),
            'Unsafe archive path.',
        );
    }
    const archiveDirectory = path.join(temporary, 'archive');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(archiveDirectory);
    const archiveExtraction = spawnSync(
        'tar',
        [
            '--no-same-owner',
            '--no-same-permissions',
            '-xzf',
            path.join(directory, LINUX_ARCHIVE),
            '-C',
            archiveDirectory,
        ],
        { encoding: 'utf8' },
    );
    assert.equal(archiveExtraction.status, 0, archiveExtraction.stderr);
    const candidates = [
        archiveDirectory,
        ...(await readdir(archiveDirectory)).map((file) => path.join(archiveDirectory, file)),
    ];
    const root = candidates.find((candidate) => {
        try {
            return Boolean(extractFile(path.join(candidate, 'resources/app.asar'), 'package.json'));
        } catch {
            return false;
        }
    });
    assert.ok(root, 'Missing application inside Linux archive.');
    await verifyBundle(root);
    console.log(
        'Linux AppImage/archive verified: current renderer/backend/icons, ELF64 architecture and sandbox-preserving launcher.',
    );
} finally {
    await rm(temporary, { recursive: true, force: true });
}
