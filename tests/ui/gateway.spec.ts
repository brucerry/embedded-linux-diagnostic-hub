import { expect, test } from '@playwright/test';
import { probes } from '../../shared/diagnostics/probes';
import { gatewayFixture } from '../fixtures/gateway';

test('website uses authenticated gateway, verifies fingerprint and collects real SSH evidence', async ({
    page,
}) => {
    const gateway = await gatewayFixture();
    try {
        await page.goto('/');
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('Gateway HTTPS address').fill(gateway.url);
        await modal.getByLabel('Gateway access token').fill(gateway.token);
        await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
        await modal.getByLabel('Port', { exact: true }).fill(String(gateway.options.port));
        await modal.getByLabel('SSH username').fill(gateway.options.username);
        await modal.getByLabel('Password', { exact: true }).fill(gateway.options.password);
        await expect(modal.getByRole('button', { name: 'Connect via SSH' })).toBeDisabled();
        await modal.getByRole('button', { name: 'Read fingerprint' }).click();
        await expect(modal.locator('.fingerprint-panel code')).toHaveText(gateway.pinned);
        expect(gateway.authentications()).toBe(0);
        await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(modal).not.toBeVisible({ timeout: 20_000 });
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        await expect(page.getByText('Gateway SSH connected.', { exact: false })).toBeVisible();
        expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
            gateway.token,
        );
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export report', exact: true }).click();
        const download = await downloadPromise;
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(chunk);
        const report = JSON.parse(Buffer.concat(chunks).toString());
        expect(report.mode).toBe('ssh');
        expect(report.diagnostics).toHaveLength(probes.length);
        expect(report.endpoint).toBe(`${gateway.options.host}:${gateway.options.port}`);
        expect(JSON.stringify(report)).not.toContain(gateway.options.password);
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await expect(page.getByText('SAVED SNAPSHOT', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Refresh snapshot' })).toBeDisabled();
    } finally {
        await gateway.close();
    }
});

test('website heartbeat preserves paused sessions and page exit releases SSH', async ({ page }) => {
    const gateway = await gatewayFixture();
    try {
        await page.clock.install();
        await page.goto('/');
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('Gateway HTTPS address').fill(gateway.url);
        await modal.getByLabel('Gateway access token').fill(gateway.token);
        await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
        await modal.getByLabel('Port', { exact: true }).fill(String(gateway.options.port));
        await modal.getByLabel('SSH username').fill(gateway.options.username);
        await modal.getByLabel('Password', { exact: true }).fill(gateway.options.password);
        await modal.getByRole('button', { name: 'Read fingerprint' }).click();
        await expect(modal.locator('.fingerprint-panel code')).toHaveText(gateway.pinned);
        await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        await page.getByRole('switch', { name: 'Live updates' }).click();
        const authenticationCount = gateway.authentications();
        const heartbeat = page.waitForRequest(
            (request) => request.url().endsWith('/heartbeat') && request.method() === 'POST',
        );
        await page.clock.runFor(61_000);
        await heartbeat;
        expect((await (await gateway.request('/api/health')).json()).activeSessions).toBe(1);
        expect(gateway.authentications()).toBe(authenticationCount);
        await page.goto('about:blank');
        await expect
            .poll(async () => (await (await gateway.request('/api/health')).json()).activeSessions)
            .toBe(0);
    } finally {
        await gateway.close();
    }
});
