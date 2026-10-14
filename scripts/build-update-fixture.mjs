import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inc } from 'semver';
assert.ok(
    ['win32', 'linux'].includes(process.platform) && process.arch === 'x64',
    'Automatic handoff fixture requires Windows/Linux x64.',
);
const { version: baseVersion } = JSON.parse(await readFile('package.json', 'utf8'));
const nextVersion = inc(baseVersion, 'patch');
assert.ok(nextVersion);
const output = path.resolve(process.env.HUB_UPDATE_OUTPUT ?? 'release/update-fixture');
const args = [
    'node_modules/electron-builder/cli.js',
    ...(process.platform === 'win32' ? ['--win', 'portable'] : ['--linux', 'AppImage']),
    '--x64',
    '--publish',
    'never',
    '--config.directories.output=' + output,
    '--config.extraMetadata.version=' + nextVersion,
];
const built = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
assert.equal(built.status, 0, 'Future packaged fixture build failed.');
const futureExecutable = path.join(
    output,
    process.platform === 'win32' ? 'Diagnostic-Hub.exe' : 'Diagnostic-Hub-linux-x64.AppImage',
);
await stat(futureExecutable);
const defaultBaseExecutable = path.resolve(
    'release',
    process.platform === 'win32'
        ? 'win-unpacked/Diagnostic Hub.exe'
        : 'Diagnostic-Hub-linux-x64.AppImage',
);
const baseExecutable = path.resolve(
    process.env.HUB_UPDATE_BASE_EXECUTABLE ?? defaultBaseExecutable,
);
await stat(baseExecutable);
const metadataPath = path.resolve(
    process.env.HUB_UPDATE_FIXTURE ?? 'validation/update-handoff/fixture.json',
);
await mkdir(path.dirname(metadataPath), { recursive: true });
await writeFile(
    metadataPath,
    JSON.stringify(
        {
            platform: process.platform,
            baseVersion,
            nextVersion,
            baseExecutable,
            futureExecutable,
            sourceFixture: true,
            rendererVersion: baseVersion,
        },
        null,
        2,
    ) + '\n',
);
console.log(
    JSON.stringify({
        baseVersion,
        nextVersion,
        futureExecutable,
        sourceFixture: true,
        publicReleaseMutated: false,
    }),
);
