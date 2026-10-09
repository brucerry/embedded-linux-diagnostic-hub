import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createReport } from '../../shared/report';
import { demoSnapshot } from '../fixtures/snapshots';
import { gatewayFixture } from '../fixtures/gateway';

// Serve the production zip contents from an arbitrary nested path, without Vite or Node on the client.
test('portable production website works at a nested URL on desktop and mobile', async ({
    page,
}) => {
    const directory = path.resolve('dist-site');
    const prefix = '/any/nested/website/';
    const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
    };
    const server = createServer(async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!pathname.startsWith(prefix)) {
            res.writeHead(404).end();
            return;
        }
        const relative = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
        const file = path.resolve(directory, relative);
        if (!file.startsWith(directory + path.sep)) {
            res.writeHead(403).end();
            return;
        }
        try {
            const data = await readFile(file);
            res.writeHead(200, {
                'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
            }).end(data);
        } catch {
            res.writeHead(404).end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const port = (server.address() as { port: number }).port;
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${port}${prefix}`);
        await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Device time', exact: true })).toContainText(
            'No device connected',
        );
        await expect(page.locator('.metric-card')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Connect target device' })).toBeVisible();
        const workerFile = (await readdir(path.join(directory, 'assets'))).find((file) =>
            file.startsWith('history.worker-'),
        );
        expect(workerFile).toBeTruthy();
        const frame = await page.evaluate(
            ({ workerFile, snapshot }) =>
                new Promise<{ readings: Record<string, unknown[]> }>((resolve, reject) => {
                    const worker = new Worker(new URL(`assets/${workerFile}`, location.href), {
                        type: 'module',
                    });
                    worker.onmessage = (event) => {
                        worker.terminate();
                        if (event.data.error) reject(new Error(event.data.error));
                        else resolve(event.data.frame);
                    };
                    worker.onerror = () => {
                        worker.terminate();
                        reject(new Error('Portable history worker did not load.'));
                    };
                    worker.postMessage({ snapshot });
                }),
            { workerFile, snapshot: demoSnapshot() },
        );
        expect(frame.readings.memory.length).toBeGreaterThan(0);
        const report = createReport(demoSnapshot());
        await page.locator('input[type=file]').setInputFiles({
            name: 'fixture.json',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(report)),
        });
        await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Diagnostics 36' }).click();
        await page
            .getByRole('button')
            .filter({ has: page.getByRole('heading', { name: 'Board identity', exact: true }) })
            .click();
        await expect(
            page.getByRole('tab', { name: 'Standard output', exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
        await page.getByRole('tab', { name: 'Table view', exact: true }).click();
        await expect(page.locator('.evidence-table')).toContainText('model');
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
        const downloaded = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export report', exact: true }).click();
        expect((await downloaded).suggestedFilename()).toMatch(/\.json$/);
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByRole('textbox', { name: 'Search diagnostics' })).toBeVisible();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Connected device terminal' })).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Clear terminal', exact: true }),
        ).toBeDisabled();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
        expect(errors).toEqual([]);
        const gateway = await gatewayFixture(undefined, { origin: `http://127.0.0.1:${port}` });
        try {
            // The production CSP requires HTTPS. Bridge a mocked HTTPS origin to the loopback
            // fixture rather than relaxing the shipped policy for this test.
            await page.route('https://clock-gateway.test/**', async (route) => {
                const request = route.request();
                const pathname = new URL(request.url()).pathname;
                if (pathname.endsWith('/clock') || pathname.endsWith('/terminal')) {
                    await route.fulfill({
                        status: 404,
                        headers: { 'Access-Control-Allow-Origin': `http://127.0.0.1:${port}` },
                        contentType: 'application/json',
                        body: JSON.stringify({ error: 'Unknown gateway route.' }),
                    });
                    return;
                }
                const response = await gateway.request(
                    pathname,
                    request.method(),
                    request.postData() ? request.postDataJSON() : undefined,
                );
                await route.fulfill({
                    status: response.status,
                    headers: Object.fromEntries(response.headers),
                    body: await response.text(),
                });
            });
            await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
            const modal = page.getByRole('dialog');
            await modal.getByLabel('Gateway HTTPS address').fill('https://clock-gateway.test');
            await modal.getByLabel('Gateway access token').fill(gateway.token);
            await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
            await modal.getByLabel('Port', { exact: true }).fill(String(gateway.options.port));
            await modal.getByLabel('SSH username').fill(gateway.options.username);
            await modal.getByLabel('Password', { exact: true }).fill(gateway.options.password);
            await modal.getByRole('button', { name: 'Read fingerprint' }).click();
            await expect(modal.locator('.fingerprint-panel code')).toHaveText(gateway.pinned);
            await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
            await modal.getByRole('button', { name: 'Connect via SSH' }).click();
            await expect(modal).not.toBeVisible();
            await expect(
                page.getByRole('region', { name: 'Device time', exact: true }),
            ).toContainText('Device time unavailable');
            await page.getByRole('button', { name: 'Terminal', exact: true }).click();
            await expect(
                page.getByRole('region', { name: 'Connected device terminal' }),
            ).toContainText('This gateway does not support Terminal');
            await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            ).toBe(true);
            await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
            await expect(
                page.getByRole('region', { name: 'Device time', exact: true }),
            ).toContainText('No device connected');
        } finally {
            await page.goto('about:blank').catch(() => {});
            await gateway.close();
        }
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
});
