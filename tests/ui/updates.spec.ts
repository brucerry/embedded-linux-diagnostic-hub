import { expect, test } from '@playwright/test';
import { demoSnapshot } from '../fixtures/snapshots';
import { installDesktop } from './fixtures/desktop';

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
