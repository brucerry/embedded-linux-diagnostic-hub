import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sha256 } from './memory-resource-identity';

/** Fail closed before any SSH transport starts. Never loads an ambient optional binary. */
export async function sshQualificationProfile() {
    const require = createRequire(import.meta.url);
    const profile = process.env.HUB_MEMORY_SSH_PROFILE;
    if (profile) {
        const manifestPath = path.resolve(profile);
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        const { id, ...core } = manifest;
        assert.equal(manifest.schema, 1);
        assert.equal(manifest.kind, 'ssh2-js-bundle');
        assert.equal(sha256(JSON.stringify(core)), id, 'Qualification manifest identity changed.');
        assert.deepEqual(Object.keys(manifest.files).sort(), ['preload.cjs', 'ssh2.cjs']);
        for (const [name, hash] of Object.entries(manifest.files))
            assert.equal(
                sha256(await fs.readFile(path.join(path.dirname(manifestPath), name))),
                hash,
            );
        const entry = path.join(path.dirname(manifestPath), 'ssh2.cjs');
        assert.equal(require.resolve('ssh2'), entry, 'Qualification module hook is not active.');
        const actual = require('ssh2').__memoryQualification;
        assert.equal(actual?.bindingAvailable, false, 'Optional native SSH binding was loaded.');
        return {
            kind: manifest.kind,
            id,
            manifestPath,
            manifestSHA256: sha256(await fs.readFile(manifestPath)),
            sshEntry: entry,
            bindingAvailable: false,
            runtimeAddonExcluded: true,
            originalInstallBinaryAbsence: 'not asserted; installed dependencies are unchanged',
            manifest,
        };
    }
    const sshRoot = path.dirname(require.resolve('ssh2/package.json'));
    await assert.rejects(
        fs.lstat(path.join(sshRoot, 'lib/protocol/crypto/build/Release/sshcrypto.node')),
        { code: 'ENOENT' },
        'Unprofiled native SSH binary is unsupported.',
    );
    assert.equal(require(path.join(sshRoot, 'lib/protocol/crypto.js')).bindingAvailable, false);
    return {
        kind: 'legacy-js-only-tree',
        sshEntry: require.resolve('ssh2'),
        nativeBinaryAbsent: true,
        bindingAvailable: false,
        sshManifestSHA256: sha256(await fs.readFile(path.join(sshRoot, 'package.json'))),
        cryptoSHA256: sha256(await fs.readFile(path.join(sshRoot, 'lib/protocol/crypto.js'))),
    };
}
