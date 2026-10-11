import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { anchorEdge, deform } from '../linux/gnome-genie/geometry.js';
import {
    createGeniePackage,
    genieAsset,
    validateGeniePackage,
} from '../scripts/lib/genie-package.mjs';
import { releaseAssets } from '../scripts/lib/release-assets.mjs';

const version = '1.2.3-test.1';
const commit = '1234567890abcdef1234567890abcdef12345678';
const root = process.cwd();
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('Genie geometry uses logical monitor coordinates and refuses missing or central anchors', () => {
    const monitor = { x: -1920, y: -120, width: 1920, height: 1080 };
    for (const [edge, x, y] of [
        ['left', -1910, 350],
        ['right', -74, 350],
        ['top', -1000, -110],
        ['bottom', -1000, 884],
    ] as const)
        assert.equal(anchorEdge({ x, y, width: 64, height: 64 }, [monitor]), edge);
    assert.equal(anchorEdge({ x: -1000, y: 300, width: 64, height: 64 }, [monitor]), null);
    assert.equal(anchorEdge({ x: 1000, y: 300, width: 64, height: 64 }, [monitor]), null);
    assert.equal(anchorEdge({ x: NaN, y: 300, width: 64, height: 64 }, [monitor]), null);
    assert.equal(anchorEdge(null, [monitor]), null);
});

test('all four deformations retain upright texture orientation and finish inside the icon', () => {
    const source = { x: -1600, y: 30, width: 1100, height: 700 };
    const target = { x: -1900, y: 300, width: 48, height: 48 };
    for (const edge of ['left', 'right', 'top', 'bottom']) {
        for (const [tx, ty] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
        ]) {
            const initial = deform(source, target, edge, 0, tx, ty);
            assert.ok(Math.abs(initial.x - tx * source.width) < 1e-9);
            assert.ok(Math.abs(initial.y - ty * source.height) < 1e-9);
            const end = deform(source, target, edge, 1, tx, ty);
            assert.ok(end.x + source.x >= target.x && end.x + source.x <= target.x + target.width);
            assert.ok(end.y + source.y >= target.y && end.y + source.y <= target.y + target.height);
        }
        const left = deform(source, target, edge, 0.65, 0, 0.5);
        const right = deform(source, target, edge, 0.65, 1, 0.5);
        const top = deform(source, target, edge, 0.65, 0.5, 0);
        const bottom = deform(source, target, edge, 0.65, 0.5, 1);
        assert.ok(left.x < right.x && top.y < bottom.y, edge);
    }
});

test('release-matched companion rejects archive attacks, corrupted bytes and stale identity', async () => {
    const { zip, build } = await createGeniePackage(root, version, commit);
    assert.deepEqual(validateGeniePackage(zip, version, commit), build);
    assert.throws(() => validateGeniePackage(zip, version, '0'.repeat(40)), /identity/);
    const files = unzipSync(zip);
    assert.throws(() =>
        validateGeniePackage(
            zipSync({ ...files, '../escape.js': files['extension.js'] }),
            version,
            commit,
        ),
    );
    assert.throws(() =>
        validateGeniePackage(
            zipSync({ ...files, 'unexpected.js': new Uint8Array() }),
            version,
            commit,
        ),
    );
    assert.throws(
        () =>
            validateGeniePackage(
                zipSync({
                    ...files,
                    'extension.js': [files['extension.js'], { attrs: 0xa1ff0000 }],
                }),
                version,
                commit,
            ),
        /Unsafe/,
    );
    assert.throws(
        () =>
            validateGeniePackage(
                zipSync({
                    ...files,
                    'extension.js': new TextEncoder().encode('Changed compositor code'),
                }),
                version,
                commit,
            ),
        /identity/,
    );
    const wrong = JSON.parse(Buffer.from(files['metadata.json']).toString());
    wrong.uuid = 'some-other-extension@example.com';
    assert.throws(
        () =>
            validateGeniePackage(
                zipSync({
                    ...files,
                    'metadata.json': new TextEncoder().encode(JSON.stringify(wrong)),
                }),
                version,
                commit,
            ),
        /identity/,
    );
    const badCrc = Buffer.from(zip);
    const central = badCrc.readUInt32LE(badCrc.length - 6);
    badCrc.writeUInt32LE((badCrc.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
    assert.throws(() => validateGeniePackage(badCrc, version, commit), /integrity/);
});

test('staged release gate requires matching app and companion assets at one source commit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hub-genie-release-'));
    try {
        await mkdir(path.join(directory, 'release'));
        await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version }));
        const { zip } = await createGeniePackage(root, version, commit);
        const legacy = await createGeniePackage(root, version, commit, 'legacy42');
        const assets: Record<string, string> = {};
        for (const name of releaseAssets(version)) {
            const bytes =
                name === genieAsset(version)
                    ? zip
                    : name === genieAsset(version, 'legacy42')
                      ? legacy.zip
                      : Buffer.from(`staged contract fixture ${name}`);
            await writeFile(path.join(directory, 'release', name), bytes);
            await writeFile(
                path.join(directory, 'release', name + '.sha256'),
                `${sha(bytes)}  ${name}\n`,
            );
            if (
                name === genieAsset(version) ||
                name === genieAsset(version, 'legacy42') ||
                name.endsWith('.AppImage') ||
                name === 'Diagnostic-Hub-linux-x64.tar.gz'
            )
                assets[name] = sha(bytes);
        }
        const linux = { version, commit, platform: 'linux', arch: 'x64', assets };
        await writeFile(
            path.join(directory, 'release/build-info.json'),
            JSON.stringify({ version, commit, signature: 'NotSigned' }),
        );
        await writeFile(
            path.join(directory, 'release/linux-build-info.json'),
            JSON.stringify(linux),
        );
        const run = () =>
            spawnSync(
                process.execPath,
                [path.join(root, 'scripts/verify-release.mjs'), '--assets'],
                {
                    cwd: directory,
                    encoding: 'utf8',
                    env: { ...process.env, GITHUB_REF_NAME: 'v' + version, GITHUB_SHA: commit },
                },
            );
        assert.equal(run().status, 0, run().stderr);
        await writeFile(
            path.join(directory, 'release/linux-build-info.json'),
            JSON.stringify({ ...linux, commit: '0'.repeat(40) }),
        );
        assert.notEqual(run().status, 0);
        await writeFile(
            path.join(directory, 'release/linux-build-info.json'),
            JSON.stringify(linux),
        );
        await rm(path.join(directory, 'release', genieAsset(version)));
        assert.notEqual(run().status, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test(
    'per-user setup contracts cover pending activation, rollback, collisions and both formats',
    { skip: process.platform !== 'linux' },
    async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'hub-genie-contract-zips-'));
        try {
            const oldPackage = await createGeniePackage(root, version, commit);
            const newPackage = await createGeniePackage(root, '1.2.4-test.1', 'f'.repeat(40));
            const oldFile = path.join(directory, 'old.zip');
            const newFile = path.join(directory, 'new.zip');
            await writeFile(oldFile, oldPackage.zip);
            await writeFile(newFile, newPackage.zip);
            const result = spawnSync(
                'python3',
                [
                    '-B',
                    'tests/fixtures/genie-setup-contract.py',
                    path.join(root, 'linux/gnome-genie/setup.py'),
                    oldFile,
                    newFile,
                ],
                {
                    encoding: 'utf8',
                    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
                },
            );
            assert.equal(result.status, 0, result.stdout + result.stderr);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
