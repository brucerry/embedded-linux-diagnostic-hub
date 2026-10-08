import { expect, test, type Page } from '@playwright/test';
import { demoSnapshot } from '../fixtures/snapshots';
import { installDesktop } from './fixtures/desktop';

async function connect(page: Page, host?: string) {
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect a Linux device' });
    if (host) await dialog.getByLabel('Hostname or IP address').fill(host);
    await dialog.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
}

async function inspectMemory(page: Page) {
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.locator('.probe-card').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Graph view' }).click();
    return dialog;
}

for (const enabled of [true, false]) {
    test(`repeated reconnects append retained samples with Live updates ${enabled ? 'On' : 'Off'}`, async ({
        page,
    }) => {
        test.setTimeout(60_000);
        await installDesktop(page);
        await page.clock.install();
        await page.goto('/');
        const live = page.getByRole('switch', { name: 'Live updates' });
        if (!enabled) await live.click();
        await page.getByLabel('Live update interval').selectOption('5');
        await connect(page);
        await page.clock.runFor(enabled ? 5100 : 1000);
        if (!enabled) {
            await page.getByRole('button', { name: 'Refresh snapshot', exact: true }).click();
        }
        await expect.poll(() => page.evaluate(() => window.desktopTest.collects)).toBe(2);
        let dialog = await inspectMemory(page);
        const originalPoints = await dialog.locator('.live-graph circle title').allTextContents();
        expect(originalPoints).toHaveLength(4);
        await dialog.getByRole('button', { name: 'Close dialog' }).click();

        for (let attempt = 1; attempt <= 2; attempt++) {
            await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
            await page.clock.runFor(1000);
            if (attempt === 1) {
                await page.evaluate(() => {
                    const original = window.diagnosticHub!.connect;
                    window.diagnosticHub!.connect = async (options) => {
                        window.diagnosticHub!.connect = original;
                        throw new Error('Temporary authentication failure');
                    };
                });
                await page.getByRole('button', { name: 'Connect device', exact: true }).click();
                const login = page.getByRole('dialog', { name: 'Connect a Linux device' });
                await login.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
                await expect(login.getByRole('alert')).toContainText(
                    'Temporary authentication failure',
                );
                await login.getByRole('button', { name: 'Close dialog' }).click();
                dialog = await inspectMemory(page);
                expect(await dialog.locator('.live-graph circle title').allTextContents()).toEqual(
                    originalPoints,
                );
                await dialog.getByRole('button', { name: 'Close dialog' }).click();
            }
            await connect(page);
            await expect(live).toBeChecked({ checked: enabled });
            dialog = await inspectMemory(page);
            await expect(dialog.locator('.live-graph circle')).toHaveCount(4 + attempt * 2);
            const retained = await dialog.locator('.live-graph circle title').allTextContents();
            for (const point of originalPoints) expect(retained).toContain(point);
            // A disconnected interval is not drawn as a continuous measurement.
            await expect(dialog.locator('.live-graph polyline')).toHaveCount((attempt + 1) * 2);
            await dialog.getByRole('button', { name: 'Close dialog' }).click();
        }

        await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
        await expect(
            page.getByRole('dialog', { name: 'Resetting session data' }),
        ).not.toBeVisible();
        // With Live updates Off, inspecting a connected empty card collects over existing SSH.
        dialog = await inspectMemory(page);
        await expect(dialog.locator('.live-graph circle')).toHaveCount(2);
        await expect(dialog.locator('.live-graph polyline')).toHaveCount(2);
        await expect(live).toBeChecked({ checked: enabled });
    });
}

test('switching target preserves earlier graphs under their collection source', async ({
    page,
}) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page.evaluate(() => {
        const originalConnect = window.diagnosticHub!.connect;
        const originalCollect = window.diagnosticHub!.collect;
        let endpoint = '';
        window.diagnosticHub!.connect = async (options) => {
            endpoint = `${options.host}:${options.port}`;
            await originalConnect(options);
        };
        window.diagnosticHub!.collect = async () => ({ ...(await originalCollect()), endpoint });
    });
    await connect(page, '192.168.1.1');
    let dialog = await inspectMemory(page);
    const originalPoints = await dialog.locator('.live-graph circle title').allTextContents();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await page.clock.runFor(1000);
    await connect(page, '192.168.1.42');
    dialog = await inspectMemory(page);
    const source = dialog.getByLabel('Graph collection source');
    await expect(source).toHaveValue('192.168.1.42:22');
    await expect(dialog.locator('.live-graph circle')).toHaveCount(2);
    await source.selectOption('192.168.1.1:22');
    expect(await dialog.locator('.live-graph circle title').allTextContents()).toEqual(
        originalPoints,
    );
    await source.selectOption('192.168.1.42:22');
    await expect(dialog.locator('.live-graph circle')).toHaveCount(2);
});

test('importing a report preserves the live record and reconnect appends to it', async ({
    page,
}) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await connect(page);
    let dialog = await inspectMemory(page);
    const originalPoints = await dialog.locator('.live-graph circle title').allTextContents();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    const report = demoSnapshot('ubuntu');
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'report.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(report)),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
    dialog = await inspectMemory(page);
    await expect(dialog.getByLabel('Graph collection source')).toHaveValue(report.endpoint);
    await dialog.getByLabel('Graph collection source').selectOption('192.168.1.1:22');
    expect(await dialog.locator('.live-graph circle title').allTextContents()).toEqual(
        originalPoints,
    );
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.clock.runFor(1000);
    await connect(page);
    dialog = await inspectMemory(page);
    await expect(dialog.getByLabel('Graph collection source')).toHaveValue('192.168.1.1:22');
    await expect(dialog.locator('.live-graph circle')).toHaveCount(4);
    await dialog.getByLabel('Graph collection source').selectOption(report.endpoint);
    await expect(dialog.locator('.live-graph circle')).toHaveCount(2);
});
