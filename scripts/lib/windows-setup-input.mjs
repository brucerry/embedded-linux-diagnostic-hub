import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as nativeFS } from 'node:fs';
import { createHash } from 'node:crypto';

export function assertWindowsSetupOutput(root, output) {
    assert.ok(path.win32.isAbsolute(root) && path.win32.isAbsolute(output));
    const relative = path.win32.relative(root, output);
    assert.ok(
        relative &&
            (relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)),
        'Choose a setup output outside the payload root.',
    );
    assert.ok(!/["\r\n$]/.test(root + output), 'Choose an ordinary setup output path.');
}
const snapshot = (stat) => {
    assert.ok(
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
        'Setup input must be a single-link regular file.',
    );
    const value = {};
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink', 'mode']) {
        assert.ok(Number.isFinite(stat[key]), 'Setup file identity is unavailable.');
        value[key] = stat[key];
    }
    assert.ok(Number.isSafeInteger(value.size) && value.size >= 0);
    return value;
};
async function stableFile(file, limit, fs) {
    const before = snapshot(await fs.lstat(file));
    assert.ok(before.size <= limit, 'Setup input exceeds its bounds.');
    const handle = await fs.open(file, 'r');
    try {
        assert.deepEqual(
            snapshot(await handle.stat()),
            before,
            'Setup input identity changed before reading.',
        );
        const digest = createHash('sha256'),
            chunk = Buffer.alloc(65536);
        let bytes = 0;
        for (;;) {
            const { bytesRead } = await handle.read(
                chunk,
                0,
                Math.min(chunk.length, before.size - bytes + 1),
                null,
            );
            assert.ok(
                Number.isSafeInteger(bytesRead) && bytesRead >= 0 && bytesRead <= chunk.length,
            );
            if (!bytesRead) break;
            bytes += bytesRead;
            assert.ok(bytes <= before.size && bytes <= limit, 'Setup input grew while reading.');
            digest.update(chunk.subarray(0, bytesRead));
        }
        assert.equal(bytes, before.size, 'Setup input was truncated while reading.');
        assert.deepEqual(
            snapshot(await handle.stat()),
            before,
            'Setup input changed while reading.',
        );
        assert.deepEqual(
            snapshot(await fs.lstat(file)),
            before,
            'Setup input path changed while reading.',
        );
        return { bytes, sha256: digest.digest('hex'), identity: before };
    } finally {
        await handle.close(); // Only this producer-owned read handle; no deletion/process action.
    }
}

/** Existing bounded inventory, with injected filesystem for memory tests. @param {any} options */
export async function inventoryWindowsSetupInput(root, options) {
    const { fs = nativeFS, reservedNames, ownDescriptor = null } = options;
    const reserved = new Set(reservedNames.map((name) => name.toLowerCase()));
    const owned = ownDescriptor ? structuredClone(ownDescriptor) : null;
    const files = [],
        identities = [];
    let bytes = 0;
    let ownDescriptorSeen = false;
    async function walk(directory) {
        for (const name of (await fs.readdir(directory)).sort()) {
            const file = path.join(directory, name);
            if (directory === root && reserved.has(name.toLowerCase())) {
                assert.ok(
                    owned && name === owned.name,
                    'Reserved setup metadata already exists; preserve it and use fresh input.',
                );
                assert.deepEqual(
                    await stableFile(file, owned.bytes, fs),
                    owned.facts,
                    'New payload descriptor changed.',
                );
                ownDescriptorSeen = true;
                continue;
            }
            const stat = await fs.lstat(file);
            assert.ok(!stat.isSymbolicLink(), 'Windows setup input must not contain aliases.');
            if (stat.isDirectory()) await walk(file);
            else {
                assert.ok(files.length < 20000, 'Setup input exceeds its file count.');
                const facts = await stableFile(file, 2 * 1024 ** 3 - bytes, fs);
                bytes += facts.bytes;
                files.push({
                    kind: 'file',
                    path: path.relative(root, file).split(path.sep).join('/'),
                    bytes: facts.bytes,
                    sha256: facts.sha256,
                });
                identities.push({ path: files.at(-1).path, identity: facts.identity });
            }
        }
    }
    await walk(root);
    assert.ok(!owned || ownDescriptorSeen, 'New payload descriptor disappeared.');
    return { files, bytes, identities };
}

/** Exclusive creation preserves every existing file/link, including a raced-in collision. */
export async function writeSetupPayloadDescriptor(root, name, text, fs = nativeFS) {
    const bytes = Buffer.from(text);
    assert.equal(
        name,
        'diagnostic-hub-setup-payload.json',
        'Only the fixed setup payload descriptor may be created.',
    );
    assert.equal(path.basename(name), name);
    const file = path.join(root, name);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    const facts = await stableFile(file, bytes.length, fs);
    assert.equal(facts.sha256, createHash('sha256').update(bytes).digest('hex'));
    return { name, bytes: bytes.length, facts };
}

/** Recheck the same snapshot immediately before compiler submission; not an atomic lock. @param {any} options */
export async function revalidateWindowsSetupInput(root, initial, options) {
    const expected = structuredClone(initial);
    const current = await inventoryWindowsSetupInput(root, options);
    assert.deepEqual(current, expected, 'Setup payload changed before compiler submission.');
}
