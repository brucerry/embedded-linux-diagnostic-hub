import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
    unlinkOwnedFile,
    removeOwnedDirectory,
    moveOwnedDirectory,
    replaceOwnedMetadata,
    ensurePlainDirectory,
    writeOwnedFile,
    copyOwnedFile,
} from '../electron/setup-paths';
test('shared mutation boundaries reject intermediate parent aliases for unlink/rmdir/move/replace/create/write/copy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hub-parent-boundary-')),
        outside = await mkdtemp(path.join(os.tmpdir(), 'hub-parent-outside-'));
    await mkdir(path.join(outside, 'branch'));
    await writeFile(path.join(outside, 'branch', 'sentinel.txt'), 'external owned-by-operator');
    await symlink(
        outside,
        path.join(root, 'alias'),
        process.platform === 'win32' ? 'junction' : 'dir',
    );
    const target = path.join(root, 'alias', 'branch', 'sentinel.txt'),
        source = path.join(root, 'temporary.json'),
        directory = path.join(root, 'source-directory');
    await writeFile(source, 'owned temporary');
    await mkdir(directory);
    await assert.rejects(unlinkOwnedFile(target), /parent alias/);
    await assert.rejects(removeOwnedDirectory(path.join(root, 'alias', 'branch')), /parent alias/);
    await assert.rejects(
        moveOwnedDirectory(directory, path.join(root, 'alias', 'moved')),
        /parent alias/,
    );
    await access(directory);
    await assert.rejects(replaceOwnedMetadata(source, target), /parent alias/);
    assert.equal(await readFile(source, 'utf8'), 'owned temporary');
    await assert.rejects(
        ensurePlainDirectory(path.join(root, 'alias', 'new-dir')),
        /plain directory|alias/,
    );
    await assert.rejects(
        writeOwnedFile(path.join(root, 'alias', 'branch', 'new.json'), 'new data'),
        /parent alias/,
    );
    await assert.rejects(
        copyOwnedFile(source, path.join(root, 'alias', 'branch', 'copied.json')),
        /parent alias/,
    );
    assert.equal(
        await readFile(path.join(outside, 'branch', 'sentinel.txt'), 'utf8'),
        'external owned-by-operator',
    );
    await access(path.join(outside, 'branch'));
    for (const name of ['new-dir', 'branch/new.json', 'branch/copied.json', 'moved'])
        await assert.rejects(access(path.join(outside, ...name.split('/'))), { code: 'ENOENT' });
});
test('exclusive staging refuses an existing plain directory and copy refuses an existing regular destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hub-exclusive-boundary-')),
        directory = path.join(root, 'existing'),
        source = path.join(root, 'source.txt'),
        destination = path.join(root, 'destination.txt');
    await mkdir(directory);
    await writeFile(source, 'source');
    await writeFile(destination, 'operator destination');
    await assert.rejects(ensurePlainDirectory(directory, true), /existing setup directory/);
    await assert.rejects(copyOwnedFile(source, destination));
    assert.equal(await readFile(destination, 'utf8'), 'operator destination');
});
