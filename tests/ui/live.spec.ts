import { expect, test } from '@playwright/test';
import { demoSnapshot } from '../fixtures/snapshots';

test('failed live update pauses polling and retains the last snapshot without repeated attempts', async ({
    page,
}) => {
    const fixture = { ...demoSnapshot(), mode: 'ssh' as const };
    await page.clock.install();
    await page.addInitScript((data) => {
        let collections = 0;
        (window as unknown as { liveTestCollections: () => number }).liveTestCollections = () =>
            collections;
        window.diagnosticHub = {
            connect: async () => {},
            disconnect: async () => {},
            pickKey: async () => null,
            openRepository: async () => {},
            copyText: async () => {},
            exportReport: async () => true,
            onDisconnected: () => () => {},
            collect: async () => {
                collections++;
                if (collections > 1) throw new Error('Test link unavailable');
                return data;
            },
        };
    }, fixture);
    await page.goto('/');
    await expect(page.getByRole('switch', { name: 'Live updates' })).toBeChecked();
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    const identity = await page.locator('.device-hero h2').textContent();
    await page.clock.runFor(5100);
    await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
    await expect(page.getByRole('alert')).toContainText('Live updates paused');
    await expect(page.locator('.device-hero h2')).toHaveText(identity!);
    await expect(page.getByRole('button', { name: 'Export report', exact: true })).toBeEnabled();
    await page.clock.runFor(20_000);
    expect(
        await page.evaluate(() =>
            (window as unknown as { liveTestCollections: () => number }).liveTestCollections(),
        ),
    ).toBe(2);
});
