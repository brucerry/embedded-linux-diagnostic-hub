import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { valid } from 'semver';

export const WINDOWS_SETUP_ASSET = 'Diagnostic-Hub-Windows-x64-Setup.exe';
export const MAX_WINDOWS_SETUP_BYTES = 2 * 1024 ** 3;
export const MAX_WINDOWS_SETUP_INFO_BYTES = 16 * 1024;
const fields = [
    'schemaVersion',
    'product',
    'platform',
    'arch',
    'version',
    'commit',
    'asset',
    'bytes',
    'sha256',
    'payloadManifestSHA256',
];

export function windowsSetupInfoName(asset) {
    assert.equal(typeof asset, 'string', 'Setup asset name is required.');
    assert.match(
        asset,
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.exe$/,
        'Use an ordinary setup EXE basename.',
    );
    assert.doesNotMatch(
        asset,
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i,
        'Reserved setup filename.',
    );
    return asset + '.info.json';
}

/** Bind metadata to independently selected release identity and verified setup bytes. Not publisher authentication. */
export function validateWindowsSetupInfo(info, expected) {
    assert.ok(
        info && typeof info === 'object' && !Array.isArray(info),
        'Invalid setup descriptor.',
    );
    assert.deepEqual(
        Object.keys(info).sort(),
        [...fields].sort(),
        'Unexpected or missing setup descriptor fields.',
    );
    assert.equal(info.schemaVersion, 1);
    assert.equal(info.product, 'dev.diagnostichub.desktop');
    assert.equal(info.platform, 'win32');
    assert.equal(info.arch, 'x64');
    assert.equal(typeof info.version, 'string');
    assert.equal(valid(info.version), info.version, 'Invalid setup version.');
    assert.match(info.commit, /^[a-f0-9]{40}$/);
    windowsSetupInfoName(info.asset);
    assert.ok(
        Number.isSafeInteger(info.bytes) && info.bytes > 0 && info.bytes <= MAX_WINDOWS_SETUP_BYTES,
        'Setup size exceeds its bound.',
    );
    assert.match(info.sha256, /^[a-f0-9]{64}$/);
    assert.match(info.payloadManifestSHA256, /^[a-f0-9]{64}$/);
    assert.ok(expected && typeof expected === 'object', 'Selected release identity is required.');
    for (const key of ['version', 'commit', 'asset', 'bytes', 'sha256'])
        assert.equal(info[key], expected[key], `Setup ${key} does not match the selected release.`);
    return info;
}

export function createWindowsSetupInfo({
    version,
    commit,
    asset,
    bytes,
    sha256,
    payloadManifestSHA256,
}) {
    const info = {
        schemaVersion: 1,
        product: 'dev.diagnostichub.desktop',
        platform: 'win32',
        arch: 'x64',
        version,
        commit,
        asset,
        bytes,
        sha256,
        payloadManifestSHA256,
    };
    validateWindowsSetupInfo(info, { version, commit, asset, bytes, sha256 });
    assert.ok(
        Buffer.byteLength(JSON.stringify(info)) <= MAX_WINDOWS_SETUP_INFO_BYTES,
        'Setup descriptor exceeds its bound.',
    );
    return info;
}

/** Build output only: exclusive sidecars, no installer execution or release adoption. */
export async function writeWindowsSetupInfo(output, { version, commit, payloadManifestSHA256 }) {
    const before = await lstat(output);
    assert.ok(
        before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
        'Setup output must be a regular single-link file.',
    );
    assert.ok(
        before.size > 0 && before.size <= MAX_WINDOWS_SETUP_BYTES,
        'Setup size exceeds its bound.',
    );
    const asset = path.basename(output);
    windowsSetupInfoName(asset);
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(output)) {
        bytes += chunk.length;
        assert.ok(bytes <= MAX_WINDOWS_SETUP_BYTES, 'Setup size exceeds its bound.');
        digest.update(chunk);
    }
    const after = await lstat(output);
    assert.ok(
        after.isFile() &&
            !after.isSymbolicLink() &&
            after.nlink === 1 &&
            after.dev === before.dev &&
            after.ino === before.ino &&
            after.size === bytes &&
            after.size === before.size &&
            after.mtimeMs === before.mtimeMs &&
            after.ctimeMs === before.ctimeMs,
        'Setup output changed while recording identity.',
    );
    const info = createWindowsSetupInfo({
        version,
        commit,
        asset,
        bytes,
        sha256: digest.digest('hex'),
        payloadManifestSHA256,
    });
    const descriptor = path.join(path.dirname(output), windowsSetupInfoName(asset));
    const checksum = output + '.sha256';
    for (const target of [descriptor, checksum]) {
        try {
            await lstat(target);
            throw Error('Setup sidecar already exists; preserve it and choose fresh build output.');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    const text = JSON.stringify(info, null, 2) + '\n';
    assert.ok(Buffer.byteLength(text) <= MAX_WINDOWS_SETUP_INFO_BYTES);
    await writeFile(descriptor, text, { flag: 'wx' });
    await writeFile(checksum, `${info.sha256}  ${asset}\n`, { flag: 'wx' });
    return { info, descriptor, checksum };
}

/** Check actual embedded app identity before assigning setup labels; no source-build proof. */
export function validateWindowsPayloadPackage(bytes, expectedVersion) {
    assert.equal(typeof expectedVersion, 'string', 'Selected payload version is required.');
    assert.equal(valid(expectedVersion), expectedVersion, 'Invalid selected payload version.');
    assert.ok(
        Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 65536,
        'Payload package metadata exceeds its bound.',
    );
    const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assert.ok(
        info && typeof info === 'object' && !Array.isArray(info),
        'Invalid payload package metadata.',
    );
    assert.equal(
        info.name,
        'embedded-linux-diagnostic-hub',
        'Payload product does not match Diagnostic Hub.',
    );
    assert.equal(
        info.version,
        expectedVersion,
        'Payload version does not match the selected setup version.',
    );
    return { name: info.name, version: info.version };
}
