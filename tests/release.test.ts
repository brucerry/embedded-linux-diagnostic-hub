import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { releaseAssets } from '../scripts/lib/release-assets.mjs';

const checker = path.resolve('scripts/verify-release.mjs');

async function releaseFixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-release-test-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    await mkdir(path.join(root, 'release'));
    const assets = releaseAssets('0.1.0');
    for (const asset of assets) {
        const bytes = Buffer.from(`test-only ${asset}`);
        await writeFile(path.join(root, 'release', asset), bytes);
        await writeFile(
            path.join(root, 'release', asset + '.sha256'),
            `${createHash('sha256').update(bytes).digest('hex')}  ${asset}\n`,
        );
    }
    await writeFile(
        path.join(root, 'release/build-info.json'),
        JSON.stringify({ version: '0.1.0', commit: 'fixture-commit', signature: 'NotSigned' }),
    );
    await writeFile(
        path.join(root, 'release/linux-build-info.json'),
        JSON.stringify({
            version: '0.1.0',
            commit: 'fixture-commit',
            platform: 'linux',
            arch: 'x64',
        }),
    );
    return {
        root,
        check: (tag = 'v0.1.0', commit = 'fixture-commit', assets = true) =>
            spawnSync(process.execPath, [checker, ...(assets ? ['--assets'] : [])], {
                cwd: root,
                env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_SHA: commit },
                encoding: 'utf8',
            }),
        close: () => rm(root, { recursive: true, force: true }),
    };
}

test('release rejects mismatched tags and source commits before publishing', async () => {
    const fixture = await releaseFixture();
    try {
        assert.notEqual(fixture.check('v0.2.0', 'fixture-commit', false).status, 0);
        assert.notEqual(fixture.check('v0.1.0', 'another-commit').status, 0);
        assert.equal(fixture.check().status, 0);
        const notes = await readFile(path.join(fixture.root, 'release/notes.md'), 'utf8');
        assert.match(notes, /Unsigned engineering preview/);
        assert.match(notes, /fixture-commit/);
    } finally {
        await fixture.close();
    }
});

test('release detects modified executable bytes and unexpected distributables', async () => {
    const fixture = await releaseFixture();
    try {
        await writeFile(path.join(fixture.root, 'release/extra.exe'), 'unexpected');
        assert.notEqual(fixture.check().status, 0);
        await rm(path.join(fixture.root, 'release/extra.exe'));
        await writeFile(path.join(fixture.root, 'release/Diagnostic-Hub.exe'), 'modified');
        assert.notEqual(fixture.check().status, 0);
    } finally {
        await fixture.close();
    }
});

test('release requires Linux source identity and every platform asset', async () => {
    const fixture = await releaseFixture();
    try {
        const metadata = path.join(fixture.root, 'release/linux-build-info.json');
        const original = await readFile(metadata, 'utf8');
        await writeFile(metadata, original.replace('fixture-commit', 'different-linux-commit'));
        assert.notEqual(fixture.check().status, 0);
        await writeFile(metadata, original);
        await rm(path.join(fixture.root, 'release/Diagnostic-Hub-linux-x64.AppImage'));
        assert.notEqual(fixture.check().status, 0);
    } finally {
        await fixture.close();
    }
});
