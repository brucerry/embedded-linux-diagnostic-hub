import assert from 'node:assert/strict';
import test from 'node:test';
import { ReleaseUpdater } from '../electron/updates';

for (const arch of ['x64', 'arm64']) {
    test(`macOS ${arch} explicitly denies automatic updates without fetching or installing a Windows/Linux artifact`, async () => {
        let requests = 0;
        const request: typeof fetch = async () => {
            requests++;
            throw Error('Unexpected download');
        };
        const updater = new ReleaseUpdater(
            '0.2.0',
            'unused-mac-update-directory',
            'darwin',
            arch,
            true,
            request,
        );
        const status = await updater.check(true);
        assert.equal(status.installable, false);
        assert.equal(status.release, null);
        assert.match(status.installationUnavailableReason!, /Automatic updates are unavailable/);
        assert.throws(() => updater.assertCanDownload(), /Automatic updates are unavailable/);
        assert.equal(status.manualUpdate?.architecture, arch);
        assert.equal(status.manualUpdate?.defaultDestination, '~/Applications/Diagnostic Hub.app');
        assert.equal(
            status.manualUpdate!.verificationCommand,
            'shasum -a 256 -c download-run-macos.sh.sha256',
        );
        await assert.rejects(() => updater.download(), /Automatic updates are unavailable/);
        assert.equal(requests, 0);
    });
}
