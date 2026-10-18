/** Proposed production App UI regression. Explicit invocation; no Electron, PTY or native store. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import { exerciseProductSerial } from './fixtures/memory-product-ui';
import { produceAggregateCrossPage } from './fixtures/memory-product-aggregate-workloads';

const root = process.env.HUB_PRODUCT_EVIDENCE;
assert.ok(root && path.isAbsolute(root), 'Use an explicitly owned private evidence directory.');
await fs.mkdir(root, { recursive: true });
const emit = async (stage: string, data: unknown) => {
    await fs.appendFile(path.join(root, 'timeline.jsonl'), JSON.stringify({ stage, data }) + '\n');
};
let host: Awaited<ReturnType<typeof createProductBrowser>> | undefined;
try {
    host = await createProductBrowser({
        profile: path.join(root, 'profile'),
        gcMode: 'normal',
        engine: 'chromium',
        emit,
    });
    const page = host.page,
        ordinal = 200000,
        query = 'native-aggregate-' + ordinal;
    await page.evaluate((tail) => window.memoryProduct.serial.configure({ tail }), query);
    const serial = await exerciseProductSerial(page, {
        ordinal,
        payloadBytes: 65536,
        viewer: false,
        faults: true,
    });
    const primary = serial.catalog
        .filter((row) => row.command === 'product-qualification-' + ordinal)
        .sort((a, b) => a.sequence - b.sequence);
    assert.equal(primary.length, 2);
    assert.ok(serial.catalog.length > 2, 'Real fault captures must remain in the catalog.');
    for (const required of [
        'cancel-start',
        'cancel-append',
        'cancel-seal',
        'cancel-outcome',
        'quota-before-begin',
        'quota-append',
    ])
        assert.ok(serial.coverage.includes(required));
    await produceAggregateCrossPage(page, ordinal + 1, 1);
    const all = await page.evaluate(() => window.memoryProduct.catalog());
    const expected = primary.map((row) => row.id);
    const view = page
        .getByRole('region', { name: 'Automation', exact: true })
        .locator('[aria-label="Stored Serial captures"]');
    const ids = () =>
        view
            .locator('tbody tr[data-capture-id]')
            .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-capture-id')!));
    await view.getByLabel('Search automation results', { exact: true }).fill(query);
    try {
        await expect.poll(ids, { timeout: 5000 }).toEqual(expected);
    } catch (error) {
        await emit('search-isolation-regression-failed', {
            query,
            inputValue: await view
                .getByLabel('Search automation results', { exact: true })
                .inputValue(),
            expectedIds: expected,
            actualIds: await ids(),
            catalog: all,
        });
        throw error;
    }
    await expect(view.locator('.automation-results')).toHaveAttribute('aria-busy', 'false');
    // Exercise the actual production export through its browser worker and stored filter.
    await view.getByLabel('Export scope', { exact: true }).selectOption('filtered');
    await view.getByLabel('Export format', { exact: true }).selectOption('json');
    const downloading = page.waitForEvent('download');
    await view.getByRole('button', { name: 'Download QA results', exact: true }).click();
    const download = await downloading;
    assert.equal(await download.failure(), null);
    const reportPath = path.join(root, 'filtered-results.json');
    await download.saveAs(reportPath);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.deepEqual(
        report.captures.map((row: any) => row.capture.id),
        expected,
    );
    await view.getByLabel('Search automation results', { exact: true }).fill('');
    await expect.poll(ids, { timeout: 5000 }).toEqual(all.map((row) => row.id));
    assert.deepEqual(await page.evaluate(() => window.memoryProduct.catalog()), all);
    await emit('search-isolation-regression-passed', {
        expectedIds: expected,
        retainedIds: all.map((row) => row.id),
        coverage: serial.coverage,
        boundary: 'actual production App/input/table/export; synthetic Serial only',
    });
} finally {
    if (host) {
        await host.close();
        await host.assertExited();
    }
}
