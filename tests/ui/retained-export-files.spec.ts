import { expect, test, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { installSerial } from './fixtures/serial';
import { readFlowDownload as readOwnedDownload, FLOW_COHORT_READ_BYTES } from './fixtures/flow-download';

async function showStored(page: Page) {
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await expect(flow.getByRole('navigation', { name: 'Automation setup steps' })).toBeVisible();
    await flow.getByLabel('Automation transport', { exact: true }).selectOption('serial');
    const results = flow.getByLabel('Stored Serial captures', { exact: true });
    await expect(results.getByRole('button', { name: 'Refresh stored results', exact: true })).toBeEnabled();
    return results;
}

test('retained browser results export off-page identities and complete beyond-preview JSON Markdown without deleting captures', async ({ page }, info) => {
    await installSerial(page);
    await page.goto('/');
    let results = await showStored(page);
    const ids = await page.evaluate(async () => {
        const storeSource = '/src/features/automation/capture/indexeddb-store.ts';
        const writerSource = '/shared/capture-writer.ts';
        const dataSource = '/tests/ui/fixtures/retained-export-data.ts';
        const { IndexedDbCaptureStore } = await import(storeSource) as typeof import('../../src/features/automation/capture/indexeddb-store');
        const { CaptureWriter } = await import(writerSource) as typeof import('../../shared/capture-writer');
        const { retainedExportRow, RETAINED_EXPORT_ROWS, RETAINED_EXPORT_TIME } = await import(dataSource) as typeof import('./fixtures/retained-export-data');
        const store = await IndexedDbCaptureStore.open();
        const ids: string[] = [];
        let failed = false;
        try {
            for (let index = 0; index < RETAINED_EXPORT_ROWS; index++) {
                const row = retainedExportRow(index);
                const writer = await CaptureWriter.begin(store, row.header);
                await writer.append(new TextEncoder().encode(row.text), RETAINED_EXPORT_TIME, 'serial');
                const capture = await writer.finish('prompt-observed');
                await store.record(capture.id, row.outcome);
                ids.push(capture.id);
            }
            return ids;
        } catch (error) {
            failed = true;
            throw error;
        } finally {
            try { await store.close(); }
            catch (error) { if (!failed) throw error; }
        }
    });
    expect(ids).toHaveLength(21);
    expect(new Set(ids).size).toBe(21);
    await results.getByRole('button', { name: 'Refresh stored results', exact: true }).click();
    await expect(results.locator('tbody tr')).toHaveCount(20);
    await results.locator(`tr[data-capture-id="${ids[0]}"] input[type=checkbox]`).check();
    await results.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(results.locator('tbody tr')).toHaveCount(1);
    await results.locator(`tr[data-capture-id="${ids[20]}"] input[type=checkbox]`).check();
    const expectedIds = [ids[0], ids[20]];
    const expectedRaw = 'X'.repeat(9000) + '\r\n~~~\r\nEXPORT-BEYOND-PREVIEW | <raw> α\r\n';
    const evidence: { format: string; scope: string; bytes: number; sha256: string; captures: number }[] = [];
    let readBytes = 0;
    const exportFile = async (results: Locator, format: string, scope: string) => {
        await results.getByLabel('Export scope', { exact: true }).selectOption(scope);
        await results.getByLabel('Export format', { exact: true }).selectOption(format);
        const button = results.getByRole('button', { name: 'Download QA results', exact: true });
        await expect(button).toBeEnabled();
        const pending = page.waitForEvent('download');
        await button.click();
        const bytes = await readOwnedDownload(await pending, FLOW_COHORT_READ_BYTES - readBytes);
        readBytes += bytes.length;
        await expect(button).toBeEnabled({ timeout: 10_000 });
        evidence.push({ format, scope, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), captures: 2 });
        return bytes;
    };
    const verifyJson = (bytes: Buffer) => {
        const report = JSON.parse(bytes.toString('utf8'));
        expect(report.schemaVersion).toBe(3);
        expect(report.captures.map((row: any) => row.capture.id)).toEqual(expectedIds);
        expect(report.summary).toMatchObject({ captures: 2, complete: 2, incomplete: 0, verifiedCommittedBytes: 2 * Buffer.byteLength(expectedRaw) });
        for (const [index, row] of report.captures.entries()) {
            const raw = Buffer.concat(row.rawObservations.map((frame: any) => Buffer.from(frame.base64, 'base64')));
            expect(raw.equals(Buffer.from(expectedRaw))).toBe(true);
            expect(row.captureComplete).toBe(true);
            expect(row.capture.header).toMatchObject({ transport: 'serial', receiveTimeSource: 'local-client', command: 'printf "same | <raw> ~~~"', runId: 'retained-export-run-' + (index === 0 ? 0 : 20) });
            expect(row.capture.firstReceivedAt).toBe('2026-10-15T00:00:00.000Z');
            expect(row.capture.lastReceivedAt).toBe('2026-10-15T00:00:00.000Z');
            expect(row.rawObservations.every((frame: any) => frame.stream === 'serial' && frame.receivedAt === '2026-10-15T00:00:00.000Z')).toBe(true);
            expect(row.outcome).toMatchObject({ completion: 'prompt-observed', exitCode: null, deviceTime: null, truncated: false });
        }
        return report;
    };
    const selected = verifyJson(await exportFile(results, 'json', 'selected'));
    expect(selected.scope.ids).toEqual(expectedIds);
    const markdown = (await exportFile(results, 'markdown', 'selected')).toString('utf8');
    expect(markdown).toContain(expectedRaw);
    expect(markdown.split('EXPORT-BEYOND-PREVIEW')).toHaveLength(3);
    expect(markdown).toContain('~~~~text\n');
    expect(markdown).toContain('&lt;raw&gt;');
    for (const id of expectedIds) expect(markdown).toContain('**Capture ID:** ' + id);
    await results.getByLabel('Search automation results', { exact: true }).fill('export-beyond-preview');
    await expect(results.locator('tbody tr')).toHaveCount(2);
    await expect(results.locator('tbody')).not.toContainText('EXPORT-BEYOND-PREVIEW');
    const filtered = verifyJson(await exportFile(results, 'json', 'filtered'));
    expect(filtered.scope.filter.query).toBe('export-beyond-preview');
    await page.reload();
    results = await showStored(page);
    await expect(results.locator('tbody tr')).toHaveCount(20);
    await results.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(results.locator('tbody tr')).toHaveCount(1);
    expect(await page.evaluate(() => ({ opens: window.serialTest.opens, writes: window.serialTest.writes }))).toEqual({ opens: 0, writes: [] });
    expect(evidence).toHaveLength(3);
    await info.attach('retained-export-file-integrity', { body: JSON.stringify({ seededCaptures: 21, selectedCaptures: 2, rawBytesPerSelectedCapture: Buffer.byteLength(expectedRaw), retainedAfterReload: 21, readBytes, exports: evidence }), contentType: 'application/json' });
});
