import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, type Locator } from '@playwright/test';
import type { createProductNative } from './memory-product-native-host';

/** Actual Results UI -> IPC -> NativeCaptureHost. Only the private trusted Save selector is held. */
export async function exerciseNativeSaveCases(
    page: Page,
    view: Locator,
    host: Awaited<ReturnType<typeof createProductNative>>,
    emit: (stage: string, data: unknown) => Promise<void>,
) {
    const before = await page.evaluate(() => window.memoryProduct.catalog());
    const results = [];
    await view.getByLabel('Export format', { exact: true }).selectOption('json');
    await view.getByLabel('Export scope', { exact: true }).selectOption('all');
    const button = view.getByRole('button', { name: 'Download QA results', exact: true });
    for (const decision of ['cancel', 'save'] as const) {
        const file = await host.prepareHeldReport();
        const sentinel = Buffer.from('existing private destination must survive stream failure\n');
        if (decision === 'save') await fs.writeFile(file, sentinel, { flag: 'wx' });
        try {
            await button.click();
            await expect.poll(async () => (await host.reportStatus())?.pending).toBe(true);
            await expect(button).toBeDisabled();
            const held = await host.snapshot();
            assert.ok(
                held.capture.owners.export > 0 && held.capture.owners.pin > 0,
                'Actual native export and snapshot pin must remain owned at Save.',
            );
            if (decision === 'save') await host.readFault.arm('quota');
            await host.releaseReport(decision);
            await expect(button).toBeEnabled();
            await expect(view.getByRole(decision === 'cancel' ? 'status' : 'alert')).toContainText(
                decision === 'cancel' ? 'Export cancelled.' : host.readFault.quotaMessage,
            );
            await expect.poll(async () => (await host.snapshot()).capture.owners.export).toBe(0);
            const after = await host.snapshot();
            for (const kind of ['reader', 'pin', 'export'])
                assert.equal(after.capture.owners[kind], 0);
            const receipt = await host.finishReport();
            assert.equal(receipt?.decision, decision);
            if (decision === 'cancel') await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
            else {
                assert.equal(
                    (await host.readFault.status()).entered,
                    true,
                    'Actual native stream read failure did not enter.',
                );
                assert.deepEqual(
                    await fs.readFile(file),
                    sentinel,
                    'Failed Save replaced the existing destination.',
                );
                await host.readFault.clear();
                const siblings = await fs.readdir(path.dirname(file));
                assert.ok(
                    !siblings.some((name) => name.startsWith('.diagnostic-hub-export-')),
                    'Failed export left a temporary destination.',
                );
                await fs.unlink(file);
            }
            assert.deepEqual(
                await page.evaluate(() => window.memoryProduct.catalog()),
                before,
                'Cancel/failure changed retained capture metadata.',
            );
            const result = {
                decision,
                receipt,
                held,
                after,
                destinationPreserved: decision === 'save',
                noSuccessfulFile: true,
            };
            await emit('actual-native-save-control', result);
            results.push(result);
        } finally {
            await host.releaseQualificationHolds();
        }
    }
    return results;
}
