import { expect, test, type Page } from '@playwright/test';
import type {} from '../../shared/types';
import { REPORT_IMPORT_A, REPORT_IMPORT_B, invalidReportImports } from './fixtures/report-import-data';

async function importContent(page: Page, content: string) {
    // Reuse the same filename to exercise the real input-reset contract.
    const input = page.getByLabel('Import diagnostic report', { exact: true });
    await input.setInputFiles({ name: 'replacement.json', mimeType: 'application/json', buffer: Buffer.from(content) });
    await expect(input).toHaveValue('');
}
async function inspectIdentity(page: Page) {
    await page.locator('.primary-nav').getByRole('button', { name: /^Diagnostics \d+$/ }).click();
    await page.locator('.probe-card').filter({ has: page.getByRole('heading', { name: 'Kernel & architecture', exact: true }) }).click();
    const dialog = page.getByRole('dialog', { name: 'Kernel & architecture', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Imported evidence', { exact: true })).toBeVisible();
    return dialog;
}

test('historical report import rejects malformed replacements preserves current evidence and admits a later valid report', async ({ page }, info) => {
    await page.goto('/');
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
    await importContent(page, JSON.stringify(REPORT_IMPORT_A));
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
    await expect(page.getByText('Snapshot: ' + REPORT_IMPORT_A.endpoint, { exact: true })).toBeVisible();
    await expect(page.getByText('Historical SSH evidence opened locally. No device connection or upload.', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Live updates', exact: true })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Live updates', exact: true })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('button', { name: 'Refresh snapshot', exact: true })).toBeDisabled();
    let dialog = await inspectIdentity(page);
    await expect(dialog.getByRole('tab', { name: 'Standard output', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(await dialog.locator('.evidence-output').textContent()).toBe(REPORT_IMPORT_A.results[0].stdout);
    await expect(dialog.getByText('Output was truncated. This report contains only the retained output.', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/256 KiB/)).toHaveCount(0);
    await dialog.getByText('Collection command', { exact: true }).click();
    expect(await dialog.locator('.command-code').textContent()).toBe(REPORT_IMPORT_A.results[0].command);
    await dialog.getByRole('tab', { name: 'Standard error', exact: true }).click();
    expect(await dialog.locator('.evidence-output').textContent()).toBe(REPORT_IMPORT_A.results[0].stderr);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    const rejected: string[] = [];
    for (const invalid of invalidReportImports()) {
        await importContent(page, invalid.content);
        await expect(page.locator('.error-banner[role=alert]')).toContainText(invalid.reason);
        // Invalid input must preserve the active diagnostics view, accepted snapshot and export availability.
        await expect(page.getByRole('textbox', { name: 'Search diagnostics', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Collect snapshot', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Export report', exact: true })).toBeEnabled();
        await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
        dialog = await inspectIdentity(page);
        await dialog.getByRole('tab', { name: 'Standard output', exact: true }).click();
        expect(await dialog.locator('.evidence-output').textContent()).toBe(REPORT_IMPORT_A.results[0].stdout);
        await expect(dialog.getByText('Output was truncated. This report contains only the retained output.', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        rejected.push(invalid.kind);
    }

    await importContent(page, JSON.stringify(REPORT_IMPORT_B));
    await expect(page.locator('.error-banner[role=alert]')).toHaveCount(0);
    await expect(page.getByText('Snapshot: ' + REPORT_IMPORT_B.endpoint, { exact: true })).toBeVisible();
    await expect(page.getByText('Snapshot: ' + REPORT_IMPORT_A.endpoint, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Live updates', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Refresh snapshot', exact: true })).toBeDisabled();
    dialog = await inspectIdentity(page);
    await dialog.getByRole('tab', { name: 'Standard output', exact: true }).click();
    expect(await dialog.locator('.evidence-output').textContent()).toBe(REPORT_IMPORT_B.results[0].stdout);
    await expect(dialog.getByText('Output was truncated. This report contains only the retained output.', { exact: true })).toHaveCount(0);
    await dialog.getByText('Collection command', { exact: true }).click();
    expect(await dialog.locator('.command-code').textContent()).toBe(REPORT_IMPORT_B.results[0].command);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    for (const name of ['Tests', 'Genie', 'Report & Evidence', 'Reports & evidence', 'Reports & Evidence']) {
        await expect(page.locator('.primary-nav').getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    expect(await page.evaluate(() => typeof window.diagnosticHub)).toBe('undefined');
    await info.attach('report-import-acceptance', { body: JSON.stringify({ acceptedReports: 2, rejectedKinds: rejected, snapshotPreservedAcrossRejections: true, replacementAccepted: true, importedReadOnlyControls: true, deviceConnectionActionsRequested: 0, nativeBridgeAbsent: true, downloadsRequested: 0 }), contentType: 'application/json' });
});
