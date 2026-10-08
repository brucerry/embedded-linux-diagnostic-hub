import { expect, test, type Page } from '@playwright/test';
import { probes } from '../../shared/diagnostics/probes';
import { createReport } from '../../shared/report';
import { demoSnapshot } from '../fixtures/snapshots';
const sample = demoSnapshot();
const collectionLabel = `${sample.results.filter((item) => item.status === 'collected').length} of ${probes.length} checks collected`;

async function openFixture(page: Page, id = 'openwrt') {
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'fixture.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(createReport(demoSnapshot(id)))),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
}

test('first launch guides connection without fabricated readings or exports', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
    await expect(
        page.getByRole('heading', { name: 'Connect your target device', exact: true }),
    ).toBeVisible();
    await expect(
        page.locator('.metric-card, .device-hero, .coverage-summary, .findings-list'),
    ).toHaveCount(0);
    await expect(page.getByText('DEMO MODE', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Sample device')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export report', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Reports & evidence', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No diagnostic report yet' })).toBeVisible();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('button', { name: 'Connect target device', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
});

test('explicitly imported evidence retains source labels and findings', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
    await openFixture(page);
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
    await expect(page.getByText(collectionLabel)).toBeVisible();
    await expect(page.getByText('Low space on /overlay', { exact: true })).toBeVisible();
    await expect(page.getByText('Low space on /rom')).toHaveCount(0);
    await page.getByRole('button', { name: /Low space on \/overlay/ }).click();
    const modal = page.getByRole('dialog', { name: 'Mounted filesystems' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Imported evidence', { exact: true })).toBeVisible();
    await expect(modal.getByRole('tab', { name: 'Standard output' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await modal.getByRole('tab', { name: 'Standard output' }).click();
    await expect(modal.locator('.evidence-output')).toContainText('/dev/ubi0_1');
    await modal.getByRole('tab', { name: 'Standard error' }).click();
    await expect(modal.locator('.evidence-output')).toContainText('No standard error captured.');
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
    expect(errors).toEqual([]);
});

test('uncollected diagnostics remain searchable and prompt a connection', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: `Diagnostics ${probes.length}` }).click();
    await page.getByRole('textbox', { name: 'Search diagnostics' }).fill('routes');
    await expect(page.locator('.probe-card')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Routing table' })).toBeVisible();
    await expect(
        page.locator('.probe-card').getByText('Not collected', { exact: true }),
    ).toBeVisible();
    await page.locator('.probe-card').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search diagnostics' }).fill('no-such-check');
    await expect(page.getByText(/No diagnostics match/)).toBeVisible();
    await page.getByRole('button', { name: 'Clear search', exact: true }).first().click();
    await expect(page.locator('.probe-card')).toHaveCount(probes.length);
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await expect(page.getByText('No diagnostic evidence collected')).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Collect snapshot', exact: true }),
    ).toBeDisabled();
});

test('report export requires evidence and website requires verified gateway configuration', async ({
    page,
}) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByLabel('Gateway HTTPS address')).toBeVisible();
    await expect(modal.getByLabel('Gateway access token')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Connect via SSH' })).toBeDisabled();
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Export report', exact: true })).toBeDisabled();
    await openFixture(page);
    await page.getByRole('button', { name: 'Reports & evidence', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export diagnostic report', exact: true }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    const report = JSON.parse(Buffer.concat(chunks).toString());
    expect(report.mode).toBe('demo');
    expect(report.diagnostics).toHaveLength(probes.length);
    expect(report.diagnostics[0].command).toContain('uname');
    expect(report.summary.findings).toHaveLength(1);
});

test('mobile preview remains navigable without horizontal page overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: `Diagnostics ${probes.length}` }).click();
    await expect(page.locator('.probe-card')).toHaveCount(probes.length);
});

test('report import stays local, labels historical evidence and prevents collection', async ({
    page,
}) => {
    await page.goto('/');
    const report = createReport(demoSnapshot('debian'));
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'report.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(report)),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'controller-03' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh snapshot' })).toBeDisabled();
    await page.getByRole('button', { name: 'Hardware diagnostics', exact: true }).click();
    await expect(page.locator('.probe-card')).toHaveCount(23);
    await page
        .locator('.probe-card')
        .filter({ has: page.getByRole('heading', { name: 'LEDs', exact: true }) })
        .click();
    await expect(
        page.getByRole('dialog').getByText('Imported evidence', { exact: true }),
    ).toBeVisible();
});

test('invalid report import preserves the current workspace and shows the reason', async ({
    page,
}) => {
    await page.goto('/');
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'invalid.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{broken'),
    });
    await expect(page.getByRole('alert')).toContainText('not valid JSON');
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export report', exact: true })).toBeDisabled();
});
