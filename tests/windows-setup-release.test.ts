import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, link, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    WINDOWS_SETUP_ASSET,
    MAX_WINDOWS_SETUP_BYTES,
    MAX_WINDOWS_SETUP_INFO_BYTES,
    createWindowsSetupInfo,
    validateWindowsSetupInfo,
    windowsSetupInfoName,
    writeWindowsSetupInfo,
} from '../scripts/lib/windows-setup-release.mjs';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('synthetic setup bytes; never executable');
const identity = {
    version: '0.6.0',
    commit: 'a'.repeat(40),
    payloadManifestSHA256: digest('validated fixture payload manifest'),
};
const selected = {
    version: identity.version,
    commit: identity.commit,
    asset: WINDOWS_SETUP_ASSET,
    bytes: bytes.length,
    sha256: digest(bytes),
};
const example = () => createWindowsSetupInfo({ ...identity, ...selected });
async function fixture() {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hub-setup-info-')));
    const output = path.join(root, WINDOWS_SETUP_ASSET);
    await writeFile(output, bytes);
    return {
        root,
        output,
        async close() {
            assert.equal(path.dirname(root), await realpath(tmpdir()));
            assert.match(path.basename(root), /^hub-setup-info-/);
            assert.equal((await lstat(root)).isSymbolicLink(), false);
            await rm(root, { recursive: true, force: true });
        },
    };
}

test('setup build descriptor binds exact executable bytes, selected source and payload manifest without executing it', async () => {
    const f = await fixture();
    try {
        const { info, descriptor, checksum } = await writeWindowsSetupInfo(f.output, identity);
        assert.deepEqual(validateWindowsSetupInfo(info, selected), example());
        assert.deepEqual(JSON.parse(await readFile(descriptor, 'utf8')), info);
        assert.equal(
            await readFile(checksum, 'utf8'),
            `${selected.sha256}  ${WINDOWS_SETUP_ASSET}\n`,
        );
        assert.deepEqual(await readFile(f.output), bytes);
        assert.ok((await lstat(descriptor)).size <= MAX_WINDOWS_SETUP_INFO_BYTES);
    } finally {
        await f.close();
    }
});

test('setup descriptor refuses a different version/source/asset/hash/length and requires caller-selected identity', () => {
    const info = example();
    for (const [key, value] of Object.entries({
        version: '0.5.2',
        commit: 'b'.repeat(40),
        asset: 'Other.exe',
        sha256: 'b'.repeat(64),
        bytes: bytes.length + 1,
    }))
        assert.throws(
            () => validateWindowsSetupInfo({ ...info, [key]: value }, selected),
            /does not match/,
            key,
        );
    assert.throws(() => validateWindowsSetupInfo(info, undefined));
    assert.throws(() => validateWindowsSetupInfo({ ...info, publisherVerified: true }, selected));
    for (const update of [
        { schemaVersion: 2 },
        { platform: 'linux' },
        { arch: 'arm64' },
        { product: 'foreign.product' },
        { payloadManifestSHA256: 'not-a-hash' },
    ])
        assert.throws(() => validateWindowsSetupInfo({ ...info, ...update }, selected));
});

test('setup descriptor rejects unsafe filenames, malformed identities and unbounded sizes', () => {
    for (const name of [
        '../Setup.exe',
        'C:Setup.exe',
        'folder/Setup.exe',
        'folder\\Setup.exe',
        'Setup.exe:stream',
        'CON.exe',
        'com1.exe',
        'Setup <x>.exe',
        'Setup\n.exe',
    ])
        assert.throws(() => windowsSetupInfoName(name));
    for (const length of [0, -1, 1.5, MAX_WINDOWS_SETUP_BYTES + 1, Infinity])
        assert.throws(() => createWindowsSetupInfo({ ...identity, ...selected, bytes: length }));
    for (const update of [{ version: 'v0.6.0' }, { commit: 'main' }, { sha256: 'G'.repeat(64) }])
        assert.throws(() => createWindowsSetupInfo({ ...identity, ...selected, ...update }));
});

test('setup sidecar writer preserves existing descriptor or checksum without creating the other sidecar', async () => {
    for (const suffix of ['.info.json', '.sha256']) {
        const f = await fixture();
        try {
            const existing = f.output + suffix,
                other = f.output + (suffix === '.sha256' ? '.info.json' : '.sha256');
            await writeFile(existing, 'operator evidence');
            await assert.rejects(writeWindowsSetupInfo(f.output, identity), /already exists/);
            assert.equal(await readFile(existing, 'utf8'), 'operator evidence');
            await assert.rejects(access(other));
            assert.deepEqual(await readFile(f.output), bytes);
        } finally {
            await f.close();
        }
    }
});

test('setup sidecar writer refuses a hardlinked executable and retains both aliases unchanged', async () => {
    const f = await fixture();
    try {
        const alias = path.join(f.root, 'other.exe');
        await link(f.output, alias);
        await assert.rejects(writeWindowsSetupInfo(f.output, identity), /single-link/);
        assert.deepEqual(await readFile(f.output), bytes);
        assert.deepEqual(await readFile(alias), bytes);
        await assert.rejects(access(f.output + '.info.json'));
        await assert.rejects(access(f.output + '.sha256'));
    } finally {
        await f.close();
    }
});

test('invalid setup release identity refuses before writing any sidecar', async () => {
    const f = await fixture();
    try {
        await assert.rejects(writeWindowsSetupInfo(f.output, { ...identity, commit: 'main' }));
        await assert.rejects(access(f.output + '.info.json'));
        await assert.rejects(access(f.output + '.sha256'));
        assert.deepEqual(await readFile(f.output), bytes);
    } finally {
        await f.close();
    }
});
