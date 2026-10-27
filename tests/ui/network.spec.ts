import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { networkSnapshot } from '../fixtures/network';
import { demoSnapshot } from '../fixtures/snapshots';
async function importSnapshot(page: import('@playwright/test').Page, snapshot = networkSnapshot()) {
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'network.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(snapshot)),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
}
async function screenshot(
    page: import('@playwright/test').Page,
    name: string,
    testInfo: import('@playwright/test').TestInfo,
) {
    const output = process.env.HUB_FEATURE_EVIDENCE
        ? path.join(process.env.HUB_FEATURE_EVIDENCE, name)
        : testInfo.outputPath(name);
    await mkdir(path.dirname(output), { recursive: true });
    await page.screenshot({ path: output, fullPage: true });
}
test('WLAN defaults to readable state and separate noise/power/capabilities with raw evidence', async ({
    page,
}, testInfo) => {
    await page.goto('/');
    await importSnapshot(page);
    await page.getByRole('button', { name: /WLAN \/ Wi-Fi/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: 'Summary', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(
        dialog.locator('.network-metrics').getByText('Beach lab', { exact: true }),
    ).toBeVisible();
    await expect(
        dialog.locator('.network-metrics').getByText('-45 dBm', { exact: true }),
    ).toBeVisible();
    await expect(
        dialog.locator('.network-metrics').getByText('-95 dBm', { exact: true }),
    ).toBeVisible();
    await expect(
        dialog.locator('.network-metrics').getByText('23.00 dBm', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText('Historical imported evidence', { exact: false })).toBeVisible();
    await dialog
        .locator('.network-detail')
        .filter({ hasText: 'Channels and restrictions · phy0' })
        .locator('summary')
        .click();
    await expect(
        dialog
            .locator('.network-detail')
            .filter({ hasText: 'Channels and restrictions · phy0' })
            .locator('dd')
            .filter({ hasText: 'radar detection' }),
    ).toBeVisible();
    await expect(
        dialog
            .locator('.network-detail')
            .filter({ hasText: 'Channels and restrictions · phy0' })
            .locator('dd')
            .filter({ hasText: 'disabled' }),
    ).toBeVisible();
    await dialog.evaluate((el) => {
        el.scrollTop = 0;
    });
    await screenshot(page, 'wlan-summary.png', testInfo);
    await dialog.getByRole('tab', { name: 'Standard output', exact: true }).click();
    await expect(dialog.locator('.evidence-output')).toContainText('phy#0');
    await dialog.getByRole('tab', { name: 'Tree view', exact: true }).click();
    await expect(dialog.locator('.evidence-tree')).toBeVisible();
});
test('LAN summary preserves link/physical/address/route/counter semantics on desktop and mobile', async ({
    page,
}, testInfo) => {
    await page.goto('/');
    await importSnapshot(page);
    await page.getByRole('button', { name: /LAN \/ Ethernet/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: 'Summary', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(dialog.getByText('1000Mb/s', { exact: true }).first()).toBeVisible();
    await dialog
        .locator('.network-detail')
        .filter({ hasText: 'Address 192.0.2.2' })
        .locator('summary')
        .click();
    await expect(dialog.getByText('192.0.2.2/24', { exact: true })).toBeVisible();
    await dialog
        .locator('.network-detail')
        .filter({ hasText: 'Neighbor 192.0.2.1' })
        .locator('summary')
        .click();
    await expect(dialog.getByText('STALE', { exact: true })).toBeVisible();
    await dialog.evaluate((el) => {
        el.scrollTop = 0;
    });
    await screenshot(page, 'lan-summary.png', testInfo);
    await page.setViewportSize({ width: 412, height: 915 });
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    await dialog.evaluate((el) => {
        el.scrollTop = 0;
    });
    await screenshot(page, 'lan-mobile.png', testInfo);
    await dialog.getByRole('tab', { name: 'Graph view', exact: true }).click();
    await expect(dialog.locator('.live-graph')).toBeVisible();
});
test('legacy network reports have readable partial summaries and explicit uncollected detail', async ({
    page,
}) => {
    await page.goto('/');
    await importSnapshot(page, demoSnapshot());
    await page.getByRole('button', { name: /WLAN \/ Wi-Fi/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(
        dialog.getByText('Additional network commands were not collected', { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByText('Not applicable to this mode', { exact: true })).toBeVisible();
    await expect(
        dialog.locator('.network-metric').filter({ hasText: 'Current-channel noise' }),
    ).toContainText('Not reported');
    await expect(dialog.getByRole('button', { name: 'Refresh capabilities' })).toHaveCount(0);
});

test('live WLAN summary keeps selected interface, expanded details and focused controls', async ({
    page,
}) => {
    const { installDesktop } = await import('./fixtures/desktop');
    await installDesktop(page);
    await page.clock.install();
    const first = networkSnapshot();
    const wireless = first.results.find((r) => r.id === 'wireless')!;
    wireless.stdout +=
        'phy#1\n\tInterface wlan1\n\t\tifindex 5\n\t\ttype monitor\n\t\tchannel 11 (2462 MHz), width: 20 MHz\n';
    await page.goto('/');
    await page.evaluate((snapshot) => {
        window.desktopTest.snapshot = snapshot;
    }, first);
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: /WLAN \/ Wi-Fi/ }).click();
    const dialog = page.getByRole('dialog'),
        select = dialog.getByLabel('Network interface');
    await select.selectOption('phy1/wlan1');
    const summary = dialog
        .locator('details.network-detail')
        .filter({ has: page.locator('summary', { hasText: 'Current radio/interface' }) })
        .first();
    await summary.locator('summary').click();
    await select.focus();
    const next = structuredClone(first);
    next.results.find((r) => r.id === 'wireless')!.stdout = next.results
        .find((r) => r.id === 'wireless')!
        .stdout.replace('channel 11 (2462 MHz)', 'channel 6 (2437 MHz)');
    await page.evaluate((snapshot) => {
        window.desktopTest.snapshot = snapshot;
    }, next);
    await page.clock.runFor(5300);
    await expect(select).toHaveValue('phy1/wlan1');
    await expect(select).toBeFocused();
    await expect(summary).toHaveAttribute('open', '');
    await expect(dialog.getByRole('region', { name: 'Wi-Fi summary' })).toContainText('2437 MHz');
});
