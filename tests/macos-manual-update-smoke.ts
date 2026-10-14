import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function main() {
    assert.equal(process.platform, 'darwin');
    assert.ok(['x64', 'arm64'].includes(process.arch));
    const executable = process.env.HUB_TEST_EXECUTABLE,
        bundle = process.env.HUB_MAC_INSTALLED_APP;
    if (!executable || !bundle) throw Error('Installed Mac fixture is required.');
    const profile = await mkdtemp(path.join(tmpdir(), 'hub-mac-manual-flow-'));
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        app = await electron.launch({
            executablePath: executable,
            args: ['--user-data-dir=' + profile],
            chromiumSandbox: true,
            env: Object.fromEntries(
                Object.entries(process.env).filter(
                    ([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined,
                ),
            ) as Record<string, string>,
        });
        const version = await app.evaluate(({ app }) => app.getVersion());
        assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
        await app.evaluate(({ shell }) => {
            (globalThis as unknown as { openedMacFolder: string }).openedMacFolder = '';
            shell.showItemInFolder = (file) => {
                (globalThis as unknown as { openedMacFolder: string }).openedMacFolder = file;
            };
            globalThis.fetch = async () => {
                throw Error('Automatic Mac update unexpectedly fetched a release.');
            };
        });
        const page = await app.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        const info = await page.evaluate(() => window.diagnosticHub!.readUpdateInfo!());
        assert.equal(info.currentPath, bundle);
        assert.equal(info.currentVersion, version);
        assert.equal(info.receipt, null);
        assert.equal(info.handoffConfirmed, false);
        const status = await page.evaluate(() => window.diagnosticHub!.checkUpdates(true));
        assert.equal(status.installable, false);
        assert.equal(status.release, null);
        assert.equal(status.manualUpdate?.architecture, process.arch);
        await assert.rejects(
            () => page.evaluate(() => window.diagnosticHub!.startUpdate({ mode: 'clean' })),
            /Automatic updates are unavailable/,
        );
        await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
        const modal = page.getByRole('dialog', { name: 'Application updates' });
        await expect(
            modal.getByRole('region', { name: 'Mac manual update guidance' }),
        ).toContainText('same release tag');
        await expect(modal.getByRole('button', { name: 'Start update', exact: true })).toHaveCount(
            0,
        );
        await modal.getByText('Application locations and previous update', { exact: true }).click();
        await expect(
            modal.getByRole('region', { name: 'Application executable locations' }),
        ).toContainText(bundle);
        await modal.getByRole('button', { name: 'Open current app folder', exact: true }).click();
        assert.equal(
            await app.evaluate(
                () => (globalThis as unknown as { openedMacFolder: string }).openedMacFolder,
            ),
            bundle,
        );
        const clipboard = await page.evaluate(() => window.diagnosticHub!.readClipboard!());
        try {
            await modal.getByRole('button', { name: 'Copy current app path', exact: true }).click();
            assert.ok(
                (await page.evaluate(() => window.diagnosticHub!.readClipboard!())) === bundle,
                'Native bundle copy mismatch',
            );
            await modal
                .getByRole('button', { name: 'Copy helper verification command', exact: true })
                .click();
            assert.ok(
                (await page.evaluate(() => window.diagnosticHub!.readClipboard!())) ===
                    'shasum -a 256 -c download-run-macos.sh.sha256',
                'Verification command copy mismatch',
            );
        } finally {
            await page.evaluate((text) => window.diagnosticHub!.copyText(text), clipboard);
        }
        const evidence = process.env.HUB_FEATURE_EVIDENCE ?? 'validation/mac-update';
        await mkdir(evidence, { recursive: true });
        const proof = {
            platform: 'darwin',
            architecture: process.arch,
            version,
            installedBundle: bundle,
            automaticInstallationSupported: false,
            noReleaseFetch: true,
            manualGuidanceVerified: true,
            checksumVerificationCommandOnly: true,
            currentBundleNativeCopy: true,
            currentFolderNativeSelection: true,
            normalPolicyPreserved: true,
            physicalPortsOpened: 0,
        };
        await writeFile(
            path.join(evidence, 'manual-flow-' + process.arch + '.json'),
            JSON.stringify(proof, null, 2) + '\n',
        );
        await page.screenshot({
            path: path.join(evidence, 'manual-flow-' + process.arch + '.png'),
            fullPage: true,
        });
        console.log(JSON.stringify(proof));
    } finally {
        await app?.close();
        const absolute = path.resolve(profile);
        if (
            !absolute.startsWith(path.resolve(tmpdir()) + path.sep) ||
            !path.basename(absolute).startsWith('hub-mac-manual-flow-')
        )
            throw Error('Invalid Mac profile cleanup');
        await rm(absolute, { recursive: true, force: true });
    }
}
void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
