import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { gatewayFixture } from '../fixtures/gateway';

test('actual gateway SSH flow stores complete output, searches/exports beyond preview, survives reload and clears explicitly', async ({
    page,
}) => {
    const gateway = await gatewayFixture(undefined, {
        exec: (command, channel) => {
            if (command !== 'fixture-ui-large') return false;
            channel.on('error', () => {});
            channel.on('end', () => channel.close());
            channel.resume();
            void (async () => {
                for (let i = 0; i < 10; i++)
                    await new Promise<void>((resolve, reject) =>
                        channel.write(Buffer.alloc(16384, 65), (error) =>
                            error ? reject(error) : resolve(),
                        ),
                    );
                await new Promise<void>((resolve, reject) =>
                    channel.write('SSH-BEYOND-PREVIEW\r\n', (error) =>
                        error ? reject(error) : resolve(),
                    ),
                );
                channel.exit(0);
                channel.end();
            })().catch(() => channel.close());
            return true;
        },
    });
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
        await modal.getByRole('button', { name: 'Read fingerprint' }).click();
        await expect(modal.locator('.fingerprint-panel code')).toHaveText(gateway.pinned);
        await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(modal).not.toBeVisible({ timeout: 20000 });
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        let flow = page.getByRole('region', { name: 'Automation', exact: true });
        const stage = (name: string) =>
            flow
                .getByRole('navigation', { name: 'Automation setup steps' })
                .getByRole('button', { name: new RegExp(name) })
                .click();
        await stage('Commands');
        await flow.getByLabel('Command 1 script').fill('fixture-ui-large');
        await flow.getByLabel('Step 1 name (optional)').fill('Gateway full capture');
        await stage('Review');
        await flow.getByRole('button', { name: 'Run once', exact: true }).click();
        await expect(flow.locator('.automation-state')).toContainText('Flow finished', {
            timeout: 30000,
        });
        await expect(flow.locator('tbody tr')).toHaveCount(1);
        await expect(flow.getByRole('heading', { name: 'Stored SSH results' })).toBeVisible();
        await expect(flow.locator('tbody')).toContainText('First 8 KiB');
        await flow.getByLabel('Search automation results').fill('ssh-beyond-preview');
        await expect(flow.locator('tbody tr')).toHaveCount(1);
        await expect(flow.locator('tbody')).not.toContainText('SSH-BEYOND-PREVIEW');
        const pending = page.waitForEvent('download');
        await flow.getByRole('button', { name: 'Download QA results', exact: true }).click();
        const file = await pending;
        expect(await file.failure()).toBeNull();
        const data = JSON.parse(await fs.readFile((await file.path())!, 'utf8'));
        expect(data.captures).toHaveLength(1);
        const capture = data.captures[0];
        const bytes = Buffer.concat(
            capture.rawObservations.map((f: { base64: string }) => Buffer.from(f.base64, 'base64')),
        );
        expect(bytes.length).toBe(163860);
        expect(bytes.toString()).toContain('SSH-BEYOND-PREVIEW');
        expect(capture.capture.header.transport).toBe('ssh');
        expect(capture.capture.header.receiveTimeSource).toBe('gateway');
        expect(capture.outcome.exitCode).toBe(0);
        await stage('Connection');
        await flow.getByLabel('Automation transport').selectOption('serial');
        await flow.getByLabel('Automation transport').selectOption('ssh');
        await expect(flow.locator('tbody tr')).toHaveCount(1);
        await page.reload();
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        flow = page.getByRole('region', { name: 'Automation', exact: true });
        await expect(flow.locator('tbody tr')).toHaveCount(1);
        await flow.getByRole('button', { name: 'Clear retained results', exact: true }).click();
        await flow
            .getByRole('button', { name: 'Delete all stored SSH captures', exact: true })
            .click();
        await expect(flow.locator('tbody tr')).toHaveCount(0);
    } finally {
        await gateway.close();
    }
});
