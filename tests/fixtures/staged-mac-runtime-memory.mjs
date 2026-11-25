// Test-only synthetic paths, bytes and hashes. This stage never installs or runs a Mac binary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    readStagedMacRuntimeBinding,
    recordStagedMacInstallMarker,
} from '../../scripts/lib/staged-mac-runtime.mjs';
import { macAsset, macManifest } from '../../scripts/lib/macos-release.mjs';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const fixtureMacBundle =
    '/private/var/tmp/hub-model/Applications with spaces/Diagnostic Hub.app';
const payload = {
    schemaVersion: 1,
    inventorySHA256: 'b'.repeat(64),
    entries: 6,
    files: 3,
    bytes: 7,
    executableSHA256: 'd'.repeat(64),
    asarSHA256: 'e'.repeat(64),
};
export const fixtureMacRuntime = {
    executable: fixtureMacBundle + '/Contents/MacOS/Diagnostic Hub',
    asar: fixtureMacBundle + '/Contents/Resources/app.asar',
    executableSHA256: payload.executableSHA256,
    asarSHA256: payload.asarSHA256,
};
export const fixtureMacMarker = Buffer.from(
    'HUB_TEST_EXECUTABLE=' +
        fixtureMacRuntime.executable +
        '\nHUB_MAC_INSTALLED_APP=' +
        fixtureMacBundle +
        '\n',
);
export async function stageMacRuntimeFixture(t, expected, receipt) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hub-mac-staged-marker-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const release = path.join(root, 'release'),
        output = path.join(root, 'evidence'),
        arch = expected.lane.slice('darwin-'.length),
        manifestFile = path.join(release, macManifest(arch)),
        markerFile = path.join(output, expected.lane, 'installed-environment.txt');
    await mkdir(release);
    await mkdir(path.dirname(markerFile), { recursive: true });
    const zip = expected.artifacts.find((record) => record.name === macAsset(arch)),
        manifestRef = expected.artifacts.find((record) => record.name === macManifest(arch));
    assert.ok(zip && manifestRef);
    const info = {
        platform: 'darwin',
        arch,
        version: expected.version,
        commit: expected.sourceCommit,
        asset: zip.name,
        sha256: zip.sha256,
        asarSHA256: payload.asarSHA256,
        payloadIdentity: { ...payload },
        bundleIdentifier: 'dev.diagnostichub.desktop',
        minimumMacOSVersion: '13.0.0',
        signature: 'ad-hoc',
        adHocIntegrityVerified: true,
        notarized: false,
        gatekeeperDownloadedAppQualified: false,
    };
    const setManifest = async (value) => {
        const bytes = Buffer.isBuffer(value)
            ? value
            : Buffer.from(JSON.stringify(value, null, 2) + '\n');
        await writeFile(manifestFile, bytes);
        Object.assign(manifestRef, { bytes: bytes.length, sha256: digest(bytes) });
    };
    await setManifest(info);
    await writeFile(markerFile, fixtureMacMarker);
    const marker = await recordStagedMacInstallMarker(output, expected);
    const helper = receipt.cases.find((item) => item.id === 'bundle-helper-installer');
    assert.ok(helper);
    helper.evidence.push(marker);
    return {
        release,
        output,
        manifestFile,
        markerFile,
        marker,
        info,
        setManifest,
        readBinding: () => readStagedMacRuntimeBinding(release, output, receipt, expected),
    };
}
