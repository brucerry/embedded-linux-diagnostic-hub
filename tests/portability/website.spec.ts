import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createReport } from '../../shared/report';
import { demoSnapshot } from '../fixtures/snapshots';

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
        await expect(page.locator('.metric-card')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Connect target device' })).toBeVisible();
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
        expect(errors).toEqual([]);
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
});
