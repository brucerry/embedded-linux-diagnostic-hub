import assert from 'node:assert/strict';
import { _electron, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gatewayFixture } from './fixtures/gateway';
import { testingFixture } from './fixtures/testing';
import { sampleProfile } from '../shared/testing/simulation';
import { validateTestReport } from '../shared/testing/report';

async function main() {
    const root = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-board-smoke-')),
        testing = testingFixture(),
        fixture = await gatewayFixture(undefined, { exec: testing.exec });
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
        ),
    ) as Record<string, string>;
    const desktop = await _electron.launch({ args: ['.', `--user-data-dir=${root}`], env });
    try {
        await desktop.evaluate(({ dialog }, root) => {
            const testing = dialog as typeof dialog & { cancelled?: boolean };
            dialog.showSaveDialog = async (
                _window: Electron.BaseWindow | Electron.SaveDialogOptions,
                options?: Electron.SaveDialogOptions,
            ) => ({
                canceled: Boolean(testing.cancelled),
                filePath:
                    root +
                    '/report.' +
                    (options ?? (_window as Electron.SaveDialogOptions)).filters![0].extensions[0],
            });
        }, root);
        const page = await desktop.firstWindow();
        await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('Hostname or IP address').fill(fixture.options.host);
        await modal.getByLabel('Port', { exact: true }).fill(String(fixture.options.port));
        await modal.getByLabel('SSH username').fill('engineer');
        await modal.getByLabel('Password', { exact: true }).fill(fixture.options.password);
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await page.getByRole('button', { name: 'Trust device', exact: true }).click();
        await expect(modal).not.toBeVisible({ timeout: 20000 });
        await page.getByRole('switch', { name: 'Live updates' }).click();
        await page
            .locator('.primary-nav')
            .getByRole('button', { name: 'Tests', exact: true })
            .click();
        await expect(
            page.getByRole('heading', { name: 'Manufactural tests', exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Reports & evidence', exact: true }),
        ).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Import report', exact: true })).toHaveCount(
            0,
        );
        await expect(page.getByRole('button', { name: 'Export report', exact: true })).toHaveCount(
            0,
        );
        await page.getByRole('button', { name: 'Discover board' }).click();
        await page.getByLabel('Import board profile', { exact: true }).setInputFiles({
            name: 'profile.json',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(sampleProfile())),
        });
        await page.getByRole('button', { name: 'Validate & prepare tests' }).click();
        await expect(page.getByRole('checkbox', { name: 'Fixture / observer ready' })).toHaveCount(
            3,
        );
        for (const checkbox of await page
            .getByRole('checkbox', { name: 'Fixture / observer ready' })
            .all())
            await checkbox.check();
        await page.getByRole('checkbox', { name: /I reviewed the mappings/ }).check();
        await page.getByRole('button', { name: 'Run selected tests' }).click();
        const results = page.getByRole('region', { name: 'Test run results' });
        await expect(results).toContainText('Run review');
        await results.getByRole('button', { name: 'Yes, expected pattern' }).click();
        await expect(results).toContainText('Test results Pass');
        const toggle = page.getByRole('switch', { name: 'Simulation mode' });
        await toggle.click();
        await expect(results).toHaveCount(0);
        await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(
            sampleProfile().name,
        );
        await toggle.click();
        await expect(results).toContainText('Test results Pass');
        assert.equal(
            await page.evaluate(async () => (await window.diagnosticHub!.readTestRun!())?.phase),
            'complete',
        );
        assert.equal(
            await page.evaluate(() => window.diagnosticHub!.exportTestReport!('json')),
            true,
        );
        const report = await validateTestReport(
            JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8')),
        );
        assert.equal(report.run.mode, 'ssh');
        assert.equal(report.imported, false);
        assert.equal(report.run.verdict, 'Pass');
        assert.ok(!JSON.stringify(report).includes(fixture.options.password));
        assert.equal(
            await page.evaluate(() => window.diagnosticHub!.exportTestReport!('html')),
            true,
        );
        assert.match(await readFile(path.join(root, 'report.html'), 'utf8'), /SSH DEVICE EVIDENCE/);
        assert.equal(
            await page.evaluate(() => window.diagnosticHub!.exportTestReport!('pdf')),
            true,
        );
        assert.equal(
            (await readFile(path.join(root, 'report.pdf'))).subarray(0, 5).toString(),
            '%PDF-',
        );
        assert.equal(
            await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
            1,
        );
        const rejected = await desktop.evaluate(({ ipcMain }) => {
            const handlers = (
                ipcMain as unknown as {
                    _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
                }
            )._invokeHandlers;
            return [
                'discover',
                'prepare',
                'start',
                'run',
                'clear',
                'cancel',
                'confirm',
                'export',
            ].every((name) => {
                try {
                    handlers.get('hub:tests-' + name)!({ sender: null, senderFrame: null });
                    return false;
                } catch (error) {
                    return (error as Error).message === 'Untrusted application frame.';
                }
            });
        });
        assert.equal(rejected, true);
        const bad = structuredClone(report);
        bad.run.cases[1].evidence!.measured = '00';
        await expect(
            page.evaluate((report) => window.diagnosticHub!.exportTestReport!('json', report), bad),
        ).rejects.toThrow(/inconsistent/);
        await desktop.evaluate(({ dialog }) => {
            (dialog as typeof dialog & { cancelled?: boolean }).cancelled = true;
        });
        assert.equal(
            await page.evaluate(() => window.diagnosticHub!.exportTestReport!('json')),
            false,
        );
        await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
        await expect(results).not.toBeVisible({ timeout: 15000 });
        assert.equal(await page.evaluate(() => window.diagnosticHub!.readTestRun!()), null);
        console.log(
            'Native board workspace, trusted IPC, backend-owned JSON/HTML/PDF, cancelled save and reset verified.',
        );
    } finally {
        await desktop.close();
        await fixture.close();
        assert.equal(path.dirname(root), path.resolve(tmpdir()));
        assert.ok(path.basename(root).startsWith('diagnostic-hub-board-smoke-'));
        await rm(root, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
