import { expect, test } from '@playwright/test';
import { demoSnapshot } from '../fixtures/snapshots';
import { installDesktop } from './fixtures/desktop';

test('unsupported-platform update UI keeps the release link and does not claim a compatible update or offer installation', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.evaluate(() => {
        window.diagnosticHub!.checkUpdates = async () => ({
            currentVersion: '0.2.0',
            installable: false,
            release: null,
            installationUnavailableReason:
                'Automatic updates are unavailable on this platform. Check GitHub releases for manually supported downloads.',
        });
    });
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Application updates' });
    await expect(modal).toContainText('Automatic updates are unavailable');
    await expect(modal.getByText('No newer compatible release is available.')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Start update' })).toHaveCount(0);
    await modal.getByRole('link', { name: 'GitHub releases (opens in your browser)' }).click();
    expect(await page.evaluate(() => window.desktopTest.releasesOpened)).toBe(1);
});

for (const [mode, label] of [
    ['clean', 'Update without saving'],
    ['preserve', 'Save report & update'],
    ['smart', 'Save, update & reopen report'],
] as const) {
    test(`${mode} update offers explicit choice, disconnects and never reconnects`, async ({
        page,
    }) => {
        await installDesktop(page);
        await page.goto('/');
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        await expect(
            page.getByRole('dialog', { name: 'Connect a Linux device' }),
        ).not.toBeVisible();
        await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
        const modal = page.getByRole('dialog', { name: 'Application updates' });
        await expect(modal.getByLabel('Include prereleases')).toBeChecked();
        await modal.getByRole('radio', { name: label }).check();
        await expect(modal.getByRole('button', { name: 'Start update' })).toBeEnabled();
        await modal.getByRole('button', { name: 'Start update' }).click();
        await expect.poll(() => page.evaluate(() => window.desktopTest.requests.length)).toBe(1);
        expect(await page.evaluate(() => window.desktopTest.requests[0].mode)).toBe(mode);
        await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
        expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
        expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(1);
    });
}

test('cancel leaves the connection, live updates and report intact', async ({ page }) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel update' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await expect(page.getByRole('switch', { name: 'Live updates' })).toBeChecked();
    expect(await page.evaluate(() => window.desktopTest.requests.length)).toBe(0);
    expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(0);
});

for (const mode of ['preserve', 'smart'] as const) {
    test(`${mode} recovery opens offline and acknowledges only after loading`, async ({ page }) => {
        const id = '12345678-1234-1234-1234-123456789012';
        await installDesktop(page, {
            id,
            mode,
            reportPath: '/user/update-reports/report.json',
            ...(mode === 'smart' ? { snapshot: demoSnapshot() } : {}),
        });
        await page.goto('/');
        await expect(
            page.getByText(
                mode === 'smart' ? 'Report reopened after update' : 'Report saved before update',
                { exact: true },
            ),
        ).toBeVisible();
        await expect(
            page.getByText(mode === 'smart' ? 'IMPORTED REPORT' : 'NOT CONNECTED', { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Copy saved report path' })).toBeVisible();
        await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
        await expect
            .poll(() => page.evaluate(() => window.desktopTest.acknowledgements))
            .toEqual([id]);
        expect(await page.evaluate(() => window.desktopTest.connects)).toBe(0);
        expect(await page.evaluate(() => window.desktopTest.collects)).toBe(0);
    });
}

test('empty report choices and offline retry work; update controls are absent from the website', async ({
    page,
}) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Check for updates', exact: true })).toHaveCount(
        0,
    );
    await installDesktop(page);
    await page.addInitScript(() => {
        let attempts = 0;
        const original = window.diagnosticHub!.checkUpdates;
        window.diagnosticHub!.checkUpdates = async (include) => {
            if (++attempts === 1) throw Error('Network unavailable');
            return original(include);
        };
    });
    await page.reload();
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('alert')).toHaveText('Network unavailable');
    await modal.getByRole('button', { name: 'Check again' }).click();
    await expect(modal).toContainText('No report is available to save');
    await modal.getByLabel('Include prereleases').uncheck();
    await expect(modal).toContainText('v0.3.0');
    await modal.getByRole('radio', { name: 'Save, update & reopen report' }).check();
    await modal.getByRole('button', { name: 'Start update' }).click();
    expect(await page.evaluate(() => window.desktopTest.requests[0].snapshot)).toBeUndefined();
});

test('update note opens the fixed GitHub releases page through the desktop bridge', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    const link = page.getByRole('link', { name: 'GitHub releases (opens in your browser)' });
    await expect(link).toHaveAttribute(
        'href',
        'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases',
    );
    await expect(link.locator('svg')).toBeVisible();
    await link.click();
    expect(await page.evaluate(() => window.desktopTest.releasesOpened)).toBe(1);
    await expect(page.getByRole('dialog', { name: 'Application updates' })).toBeVisible();
});

test('truthful download/stage progress, cancel icon and durable native path actions', async ({
    page,
}, testInfo) => {
    await installDesktop(page);
    await page.addInitScript(() => {
        const bridge = window.diagnosticHub!;
        let emit: (p: import('../../shared/types').UpdateProgress | string) => void = () => {};
        let fail: ((e: Error) => void) | undefined;
        const state = {
            opened: [] as string[],
            copied: [] as string[],
            emit: (value: import('../../shared/types').UpdateProgress) => emit(value),
            fail: () => fail?.(new Error('Checksum failed. No update was installed.')),
        };
        (window as unknown as { updateProgressTest: typeof state }).updateProgressTest = state;
        bridge.onUpdateProgress = (callback) => {
            emit = callback;
            return () => {
                emit = () => {};
            };
        };
        bridge.readUpdateInfo = async () => ({
            currentVersion: '0.5.0',
            currentPath: 'C:\\Original\\Diagnostic-Hub.exe',
            handoffConfirmed: false,
            receipt: {
                previousVersion: '0.5.0',
                version: '0.5.1',
                executable: 'C:\\Profile\\updates\\0.5.1\\Diagnostic-Hub.exe',
                hash: 'a'.repeat(64),
                state: 'restart-requested',
                updatedAt: '2026-10-14T00:00:00Z',
            },
        });
        bridge.openUpdateFolder = async (target) => {
            state.opened.push(target);
        };
        bridge.copyUpdatePath = async (target) => {
            state.copied.push(target);
        };
        bridge.startUpdate = () =>
            new Promise((_resolve, reject) => {
                fail = reject;
            });
    });
    await page.goto('/');
    await expect(page.locator('.update-receipt-notice')).toContainText(
        'successful handoff is not confirmed',
    );
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Application updates' });
    await expect(
        modal.getByRole('button', { name: 'Cancel update', exact: true }).locator('svg'),
    ).toBeVisible();
    await modal.getByText('Application locations and previous update', { exact: true }).click();
    await modal.getByRole('button', { name: 'Open update folder', exact: true }).click();
    await modal.getByRole('button', { name: 'Copy update path', exact: true }).click();
    expect(
        await page.evaluate(
            () =>
                (
                    window as unknown as {
                        updateProgressTest: { opened: string[]; copied: string[] };
                    }
                ).updateProgressTest.opened,
        ),
    ).toEqual(['verified']);
    await modal.getByRole('button', { name: 'Start update', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Cancel update', exact: true })).toBeDisabled();
    const emit = async (value: import('../../shared/types').UpdateProgress) =>
        page.evaluate(
            (p) =>
                (
                    window as unknown as {
                        updateProgressTest: {
                            emit(v: import('../../shared/types').UpdateProgress): void;
                        };
                    }
                ).updateProgressTest.emit(p),
            value,
        );
    await emit({
        stage: 'download',
        message: 'Downloading release bytes…',
        receivedBytes: 25,
        totalBytes: 100,
        stagingPath: 'C:\\Profile\\updates\\0.5.1\\Diagnostic-Hub.exe.fixture.part',
    });
    await expect(
        modal.getByRole('progressbar', { name: 'Release download progress' }),
    ).toHaveAttribute('value', '25');
    await expect(modal).toContainText('25%');
    await expect(modal).toContainText('Temporary staging file');
    const directory = process.env.HUB_FEATURE_EVIDENCE;
    const screenshot = async (name: string) => {
        const file = directory
            ? require('node:path').join(directory, name)
            : testInfo.outputPath(name);
        await require('node:fs/promises').mkdir(require('node:path').dirname(file), {
            recursive: true,
        });
        await page.screenshot({ path: file, fullPage: true });
    };
    await screenshot('updater-measured-download.png');
    await emit({
        stage: 'download',
        message: 'Downloading with unknown total…',
        receivedBytes: 40,
    });
    await expect(
        modal.getByRole('progressbar', { name: 'Release download progress' }),
    ).not.toHaveAttribute('value');
    await expect(modal).not.toContainText('25%');
    await emit({ stage: 'verify', message: 'Verifying checksum…' });
    await expect(
        modal.getByRole('progressbar', { name: 'Current update stage progress' }),
    ).not.toHaveAttribute('value');
    await expect(modal).not.toContainText('100%');
    await screenshot('updater-verification.png');
    await page.evaluate(() =>
        (window as unknown as { updateProgressTest: { fail(): void } }).updateProgressTest.fail(),
    );
    await expect(modal.getByRole('alert')).toContainText('Checksum failed');
    await expect(modal.getByRole('button', { name: 'Cancel update', exact: true })).toBeEnabled();
    await page.setViewportSize({ width: 412, height: 915 });
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    await screenshot('updater-path-mobile.png');
});
test('reopened new app shows observed handoff version and location', async ({ page }) => {
    await installDesktop(page);
    await page.addInitScript(() => {
        window.diagnosticHub!.readUpdateInfo = async () => ({
            currentVersion: '0.5.1',
            currentPath: '/profile/updates/0.5.1/Diagnostic-Hub-linux-x64.AppImage',
            handoffConfirmed: true,
            receipt: {
                previousVersion: '0.5.0',
                version: '0.5.1',
                executable: '/profile/updates/0.5.1/Diagnostic-Hub-linux-x64.AppImage',
                hash: 'a'.repeat(64),
                state: 'confirmed',
                updatedAt: '2026-10-14T00:00:00Z',
            },
        });
    });
    await page.goto('/');
    await expect(page.locator('.update-receipt-notice')).toContainText(
        'New version confirmed running',
    );
    await expect(page.locator('.update-receipt-notice')).toContainText('v0.5.0');
    await expect(page.locator('.update-receipt-notice')).toContainText('v0.5.1');
});

for (const architecture of ['x64', 'arm64'] as const)
    test(
        'Mac ' +
            architecture +
            ' manual guidance verifies downloaded helper and never offers automatic install',
        async ({ page }) => {
            await installDesktop(page);
            await page.addInitScript((arch) => {
                window.diagnosticHub!.checkUpdates = async () => ({
                    currentVersion: '0.5.0',
                    installable: false,
                    release: null,
                    installationUnavailableReason: 'Automatic updates are unavailable on macOS.',
                    manualUpdate: {
                        platform: 'darwin',
                        architecture: arch,
                        defaultDestination: '~/Applications/Diagnostic Hub.app',
                        verificationCommand: 'shasum -a 256 -c download-run-macos.sh.sha256',
                    },
                });
                window.diagnosticHub!.readUpdateInfo = async () => ({
                    currentVersion: '0.5.0',
                    currentPath: '/Applications/Diagnostic Hub.app',
                    receipt: null,
                    handoffConfirmed: false,
                });
            }, architecture);
            await page.goto('/');
            await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
            const modal = page.getByRole('dialog', { name: 'Application updates' });
            const guidance = modal.getByRole('region', { name: 'Mac manual update guidance' });
            await expect(guidance).toContainText(
                architecture === 'arm64' ? 'Apple Silicon arm64' : 'Intel x64',
            );
            await expect(guidance).toContainText('same release tag');
            await expect(guidance).toContainText('not confirmation of a running app');
            await expect(
                modal.getByRole('button', { name: 'Start update', exact: true }),
            ).toHaveCount(0);
            await expect(modal.getByLabel('Include prereleases')).toBeDisabled();
            await guidance
                .getByRole('button', { name: 'Copy helper verification command', exact: true })
                .click();
            expect(await page.evaluate(() => window.desktopTest.clipboard)).toBe(
                'shasum -a 256 -c download-run-macos.sh.sha256',
            );
        },
    );
