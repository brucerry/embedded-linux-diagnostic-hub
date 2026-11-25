import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkVendorArchives, sha512RegularFile } from '../scripts/ci/linux-package-lane/check-inputs.mjs';

test('ordinary archive digests match a direct SHA-512 across multiple read chunks', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-lane-digest-'));
    t.after(() => rm(root, { recursive: true }));
    const bytes = Buffer.alloc(265_010, 42);
    const file = path.join(root, 'archive.tgz');
    await writeFile(file, bytes);
    assert.equal(await sha512RegularFile(file), 'sha512-' + createHash('sha512').update(bytes).digest('base64'));
});

test('unavailable Linux dependencies remain missing without altering the shared project', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-lane-inputs-'));
    t.after(() => rm(root, { recursive: true }));
    const entries = await checkVendorArchives(root);
    assert.equal(entries.length, 8);
    assert.equal(new Set(entries.map(entry => entry.name)).size, 8);
    assert.ok(entries.every(entry => entry.status === 'missing'));
    await mkdir(path.join(root, 'vendor'));
    await writeFile(path.join(root, 'vendor', entries[0].name), 'placeholder; not the pinned archive');
    const after = await checkVendorArchives(root);
    assert.equal(after[0].status, 'digest-mismatch');
    assert.deepEqual(after.slice(1), entries.slice(1));
});
