import { expect, test } from '@playwright/test';
import { probes } from '../../shared/diagnostics/probes';
import { gatewayFixture } from '../fixtures/gateway';

test('website uses authenticated gateway, verifies fingerprint and collects real SSH evidence', async ({
    page,
}) => {
    const gateway = await gatewayFixture();
    try {
        await page.goto('/');
        await expect(page.getByText('Web workspace', { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('Gateway HTTPS address').fill(gateway.url);
        await modal.getByLabel('Gateway access token').fill(gateway.token);
        await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
        await modal.getByLabel('Port', { exact: true }).fill(String(gateway.options.port));
        await modal.getByLabel('SSH username').fill(gateway.options.username);
        await modal.getByLabel('Password', { exact: true }).fill(gateway.options.password);
        await expect(modal.getByRole('button', { name: 'Connect via SSH' })).toBeDisabled();
        const verification = modal.getByLabel('I verified this fingerprint with a trusted source.');
        await expect(verification).toBeDisabled();
        await expect(
            modal.getByText('First enter your gateway address and token', { exact: false }),
        ).toBeVisible();
        await modal.getByRole('button', { name: 'Read fingerprint' }).click();
        await expect(modal.locator('.fingerprint-panel code')).toHaveText(gateway.pinned);
        expect(gateway.authentications()).toBe(0);
        await expect(verification).toBeEnabled();
        await modal.locator('.checkbox-label').click();
        await expect(verification).toBeChecked();
        await verification.focus();
        await page.keyboard.press('Space');
        await expect(verification).not.toBeChecked();
        await page.keyboard.press('Space');
        await expect(verification).toBeChecked();
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
        await page.getByRole('button', { name: 'Memory', exact: true }).click();
        await page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
            .click();
        await page.getByRole('dialog').getByRole('tab', { name: 'Graph view' }).click();
        await expect(page.getByRole('dialog').locator('.live-graph circle')).not.toHaveCount(0);
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
        await expect(
            page.getByRole('dialog', { name: 'Connect a Linux device' }),
        ).not.toBeVisible();
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

test('website selects an encrypted private key and authenticates through the trusted gateway', async ({
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
        await modal.getByLabel('Authentication', { exact: true }).selectOption('key');
        await modal.getByLabel('SSH private key file').setInputFiles({
            name: 'id_rsa',
            mimeType: 'text/plain',
            buffer: Buffer.from(gateway.privateKey),
        });
        await modal.getByLabel('Key passphrase (optional)').fill(gateway.passphrase);
        await modal.getByRole('button', { name: 'Read fingerprint' }).click();
        await expect(modal.locator('.fingerprint-panel code')).toHaveText(gateway.pinned);
        expect(gateway.authentications()).toBe(0);
        await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
        await modal.getByLabel('Hostname or IP address').fill('localhost');
        await expect(
            modal.getByLabel('I verified this fingerprint with a trusted source.'),
        ).toBeDisabled();
        await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
        await modal.getByRole('button', { name: 'Read fingerprint' }).click();
        await expect(modal.locator('.fingerprint-panel code')).toHaveText(gateway.pinned);
        await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
        await modal.getByLabel('Key passphrase (optional)').fill('wrong-key-passphrase');
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(modal.getByRole('alert')).toBeVisible();
        // The same file can be selected again after an unsuccessful authentication.
        await modal.getByLabel('SSH private key file').setInputFiles({
            name: 'id_rsa',
            mimeType: 'text/plain',
            buffer: Buffer.from(gateway.privateKey),
        });
        await modal.getByLabel('Key passphrase (optional)').fill(gateway.passphrase);
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible({
            timeout: 20000,
        });
        expect(
            await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
        ).not.toContain(gateway.passphrase);
        expect(
            await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
        ).not.toContain('PRIVATE KEY');
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await expect(page.getByText('SAVED SNAPSHOT', { exact: true })).toBeVisible();
    } finally {
        await gateway.close();
    }
});

for (const enabled of [true, false]) {
    test(`website reconnect and RAM reset retain Live updates ${enabled ? 'On' : 'Off'}`, async ({
        page,
    }) => {
        const gateway = await gatewayFixture();
        try {
            await page.goto('/');
            const liveSwitch = page.getByRole('switch', { name: 'Live updates' });
            if (!enabled) await liveSwitch.click();
            const connect = async () => {
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
                await modal
                    .getByLabel('I verified this fingerprint with a trusted source.')
                    .check();
                await modal.getByRole('button', { name: 'Connect via SSH' }).click();
                await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
                await expect(
                    page.getByRole('dialog', { name: 'Connect a Linux device' }),
                ).not.toBeVisible();
            };
            await connect();
            await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
            await expect(
                page.getByRole('dialog', { name: 'Resetting session data' }),
            ).not.toBeVisible();
            await expect(liveSwitch).toBeChecked({ checked: enabled });
            if (!enabled) {
                const authentications = gateway.authentications();
                await page.getByRole('button', { name: 'Memory', exact: true }).click();
                await page.locator('.probe-card').first().click();
                await expect(
                    page.getByRole('dialog').getByRole('tab', { name: 'Standard output' }),
                ).toBeVisible();
                expect(gateway.authentications()).toBe(authentications);
                await page
                    .getByRole('dialog')
                    .getByRole('button', { name: 'Close dialog' })
                    .click();
            }
            await page.getByRole('button', { name: 'Memory', exact: true }).click();
            await page.locator('.probe-card').first().click();
            await page.getByRole('tab', { name: 'Graph view' }).click();
            const points = await page.getByRole('dialog').locator('.live-graph circle').count();
            await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
            await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
            await expect(
                page.getByRole('button', { name: 'Connect device', exact: true }),
            ).toBeVisible();
            await expect(liveSwitch).toBeChecked({ checked: enabled });
            await connect();
            await expect(liveSwitch).toBeChecked({ checked: enabled });
            await page.getByRole('button', { name: 'Memory', exact: true }).click();
            await page.locator('.probe-card').first().click();
            await page.getByRole('tab', { name: 'Graph view' }).click();
            await expect(page.getByRole('dialog').locator('.live-graph circle')).toHaveCount(
                points + 2,
            );
            expect((await (await gateway.request('/api/health')).json()).activeSessions).toBe(1);
        } finally {
            await gateway.close();
        }
    });
}
