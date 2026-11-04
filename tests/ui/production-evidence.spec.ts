import { expect, test } from '@playwright/test';
import { createReport } from '../../shared/report';
import { demoSnapshot } from '../fixtures/snapshots';

const RAW = '{"u64":18446744073709551615,"overflow":1e309,"negative":-1e309,"safe":7,"quoted":"18446744073709551615","nested":{"fraction":1.25}}\n';
const UNKNOWN = 'Number exceeds exact display range; inspect Standard output.';

test('unsafe numeric evidence stays unknown in structured views and exact in Standard output', async ({ page }, info) => {
    const snapshot = demoSnapshot();
    for (const id of ['board', 'services']) Object.assign(snapshot.results.find(r => r.id === id)!, {
        stdout: RAW, stderr: '', status: 'collected', exitCode: 0,
    });
    await page.goto('/');
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'synthetic-numeric-evidence.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(createReport(snapshot))),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Diagnostics 36', exact: true }).click();
    for (const [title, view] of [['Board identity', 'Table view'], ['Service inventory', 'Tree view']] as const) {
        await page.locator('.probe-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.locator('.evidence-output')).toHaveText(RAW, { useInnerText: false });
        expect(await dialog.locator('.evidence-output').textContent()).toBe(RAW);
        await dialog.getByRole('tab', { name: view, exact: true }).click();
        if (view === 'Tree view') await dialog.getByRole('button', { name: 'Expand all', exact: true }).click();
        const values = view === 'Table view' ? dialog.locator('tbody td:nth-child(2)') : dialog.locator('.tree-value');
        await expect(values.filter({ hasText: UNKNOWN })).toHaveCount(3);
        await expect(values.filter({ hasText: /^7$/ })).toHaveCount(1);
        await expect(values.filter({ hasText: /^1\.25$/ })).toHaveCount(1);
        await expect(values.filter({ hasText: view === 'Table view' ? /^18446744073709551615$/ : /^"18446744073709551615"$/ })).toHaveCount(1);
        await expect(values.filter({ hasText: /18446744073709552000|^null$/ })).toHaveCount(0);
        await dialog.getByRole('tab', { name: 'Standard output', exact: true }).click();
        await expect(dialog.locator('.evidence-output')).toHaveText(RAW, { useInnerText: false });
        expect(await dialog.locator('.evidence-output').textContent()).toBe(RAW);
        await page.keyboard.press('Escape');
    }
    await info.attach('production-fix-observation', { body: JSON.stringify({ schema: 1,
        productionSource: '96a56cdbb462320c54fe74022d7436e665a31d31', case: 'evidence',
        structuredViews: 2, unknownValuesPerView: 3, rawViewsVerified: 4, safeControlsPerView: 3 }), contentType: 'application/json' });
});
