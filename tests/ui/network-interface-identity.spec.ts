import { expect, test, type Locator, type Page } from '@playwright/test';
import { networkIdentityReport } from '../fixtures/network-identity';

const metric = (page: Page, summary: Locator, label: string) =>
    summary.locator('.network-metric').filter({ has: page.getByText(label, { exact: true }) }).locator('strong');
async function openAddress(summary: Locator, address: string) {
    const details = summary.locator('.network-detail').filter({ hasText: 'Address ' + address });
    if (!(await details.evaluate(node => node.hasAttribute('open'))))
        await details.locator('summary').click();
}

test('LAN selector distinguishes repeated interface names by reported index and keeps selected facts and raw evidence aligned', async ({ page }, info) => {
    const report = networkIdentityReport();
    const raw = report.results[0].networkEvidence.sections[0].stdout;
    await page.goto('/');
    await page.getByLabel('Import diagnostic report', { exact: true }).setInputFiles({
        name: 'synthetic-network-identities.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(report)),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /LAN \/ Ethernet/ }).click();
    const dialog = page.getByRole('dialog');
    const summary = dialog.getByRole('region', { name: 'LAN summary', exact: true });
    await expect(dialog.getByRole('tab', { name: 'Summary', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(summary).toContainText('Historical imported evidence');
    const select = summary.getByLabel('Network interface', { exact: true });
    const labels = ['eth0 · ifindex 7', 'eth0 · ifindex 19', 'eth1'];
    await expect(select.locator('option')).toHaveText(labels);
    await select.selectOption({ label: labels[0] });
    await expect(select).toHaveValue('["eth0",7]');
    await expect(metric(page, summary, 'MTU')).toHaveText('1500');
    await expect(metric(page, summary, 'Operating state')).toHaveText('UP');
    await openAddress(summary, '192.0.2.7');
    await expect(summary.getByText('192.0.2.7/24', { exact: true })).toBeVisible();

    await select.selectOption({ label: labels[1] });
    await expect(select).toHaveValue('["eth0",19]');
    await expect(metric(page, summary, 'MTU')).toHaveText('9000');
    await expect(metric(page, summary, 'Operating state')).toHaveText('DOWN');
    await expect(summary.getByText('192.0.2.7/24', { exact: true })).toHaveCount(0);
    await openAddress(summary, '192.0.2.19');
    await expect(summary.getByText('192.0.2.19/24', { exact: true })).toBeVisible();
    await expect(summary.getByRole('status').filter({ hasText: 'interface identity changed during collection; conflicting records kept separate.' })).toBeVisible();

    await select.selectOption({ label: labels[2] });
    await expect(select).toHaveValue('["eth1",null]');
    await expect(metric(page, summary, 'MTU')).toHaveText('1200');
    await expect(metric(page, summary, 'Operating state')).toHaveText('UNKNOWN');
    await summary.getByText('Command evidence and collection limits', { exact: true }).click();
    const command = summary.locator('.network-command').filter({ hasText: 'ip-link-json' });
    await command.locator('summary').click();
    expect(await command.locator('pre').nth(1).textContent()).toBe(raw);
    await expect(select).toHaveValue('["eth1",null]');
    const observed = {
        labels: await select.locator('option').allTextContents(),
        finalValue: await select.inputValue(),
        rawEvidenceCharacters: raw.length,
    };
    expect(new Set(observed.labels).size).toBe(3);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await info.attach('network-interface-identity-acceptance', {
        body: JSON.stringify({ observed, importedHistoricalEvidence: true, liveCollectionRequested: false, downloadsRequested: 0 }),
        contentType: 'application/json',
    });
});
