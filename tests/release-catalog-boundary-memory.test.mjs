import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { releaseCatalog } from '../scripts/lib/release-assets.mjs';
import { verifyReleaseAssets, releaseProfileFromArgs } from '../scripts/verify-release.mjs';

// Independent current contract data, not a retained implementation or historical comparator.
function fixture(version, setup) {
    const payloads = [
        'Diagnostic-Hub.exe',
        'Diagnostic-Hub-linux-x64.AppImage',
        'Diagnostic-Hub-linux-x64.tar.gz',
        'Diagnostic-Hub-macos-x64.zip',
        'Diagnostic-Hub-macos-arm64.zip',
        `Diagnostic-Hub-Gateway-${version}.tar.gz`,
        `Diagnostic-Hub-Web-${version}.zip`,
        'download-run.ps1', 'download-run.sh', 'download-run-macos.sh',
        ...(setup ? ['Diagnostic-Hub-Windows-x64-Setup.exe'] : []),
    ];
    const metadata = ['build-info.json', 'linux-build-info.json',
        'macos-build-info-x64.json', 'macos-build-info-arm64.json',
        ...(setup ? ['Diagnostic-Hub-Windows-x64-Setup.exe.info.json'] : [])];
    const expected = [...payloads.flatMap((name) => [name, name + '.sha256']), ...metadata].sort();
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const files = new Map(), log = [], commit = 'a'.repeat(40);
    for (const name of payloads) {
        const bytes = Buffer.from('synthetic non-executable bytes: ' + name);
        files.set(name, bytes);
        files.set(name + '.sha256', Buffer.from(hash(bytes) + '  ' + name + '\n'));
    }
    const put = (name, value) => files.set(name, Buffer.from(JSON.stringify(value)));
    put('build-info.json', { version, commit, signature: 'NotSigned' });
    put('linux-build-info.json', { version, commit, platform: 'linux', arch: 'x64',
        assets: Object.fromEntries(['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz']
            .map((name) => [name, hash(files.get(name))])) });
    for (const arch of ['x64', 'arm64']) {
        const name = `Diagnostic-Hub-macos-${arch}.zip`;
        put(`macos-build-info-${arch}.json`, { version, commit, platform: 'darwin', arch,
            asset: name, sha256: hash(files.get(name)), asarSHA256: 'b'.repeat(64),
            bundleIdentifier: 'dev.diagnostichub.desktop', minimumMacOSVersion: '13.0.0',
            signature: 'ad-hoc', adHocIntegrityVerified: true, notarized: false,
            gatekeeperDownloadedAppQualified: false });
    }
    if (setup) {
        const asset = 'Diagnostic-Hub-Windows-x64-Setup.exe';
        put(asset + '.info.json', { schemaVersion: 1, product: 'dev.diagnostichub.desktop',
            platform: 'win32', arch: 'x64', version, commit, asset, bytes: files.get(asset).length,
            sha256: hash(files.get(asset)), payloadManifestSHA256: 'c'.repeat(64) });
    }
    const record = (kind, name) => { assert.ok(log.length < 128); log.push([kind, name]); };
    const io = {
        files: async () => [...files.keys()],
        hash: async (name, limit) => { record('hash', name); const b = files.get(name);
            assert.ok(b && b.length <= limit); return { bytes: b.length, sha256: hash(b) }; },
        read: async (name, limit = Infinity) => { record('read', name); const b = files.get(name);
            assert.ok(b && b.length <= limit); return b.toString(); },
        notes: async () => { record('notes', 'synthetic-memory-only'); },
    };
    return { files, log, io, expected, options: { version, commit } };
}

test('independent full catalog and memory verifier bind legacy24 and exact earliest setup27 names', async () => {
    for (const [version, setup] of [['0.5.99', false], ['0.6.0-0', true]]) {
        const f = fixture(version, setup), before = [...f.files].map(([name, b]) => [name, b.toString('base64')]);
        assert.equal(f.expected.length, setup ? 27 : 24);
        assert.deepEqual(releaseCatalog(version), f.expected);
        assert.deepEqual([...f.files.keys()].sort(), f.expected);
        assert.equal(releaseProfileFromArgs(['--assets'], version), setup ? 'windows-setup' : 'legacy');
        const result = await verifyReleaseAssets(f.options, f.io);
        assert.equal(result.setupDescriptorVerified, setup);
        assert.equal(result.nativeQualification, 'NOT_ESTABLISHED');
        assert.equal(f.log.filter(([kind]) => kind === 'notes').length, 1);
        assert.deepEqual([...f.files].map(([name, b]) => [name, b.toString('base64')]), before);
        if (setup) {
            const missing = fixture(version, true);
            missing.files.delete('Diagnostic-Hub-Windows-x64-Setup.exe.info.json');
            await assert.rejects(verifyReleaseAssets(missing.options, missing.io));
            assert.deepEqual(missing.log, [], 'Missing descriptor rejects before hash/read/notes callbacks');
        }
    }
});
