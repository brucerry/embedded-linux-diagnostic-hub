import { expect, test } from '@playwright/test';
import { demoSnapshot } from '../fixtures/snapshots';
import { installDesktop } from './fixtures/desktop';

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
            checkUpdates: async () => ({
                currentVersion: '0.1.0',
                installable: true,
                release: null,
            }),
            startUpdate: async () => {},
            readUpdateReport: async () => null,
            acknowledgeUpdateReport: async () => {},
            clearSessionData: async () => {},
            connect: async () => {},
            disconnect: async () => {},
            pickKey: async () => null,
            openReleases: async () => {},
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
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.locator('.probe-card').first().click();
    const graphTab = page.getByRole('tab', { name: 'Graph view' });
    await graphTab.click();
    await page.clock.runFor(5100);
    await expect(graphTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('dialog').locator('.live-graph circle').first()).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
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

for (const enabled of [true, false]) {
    test(`live preference ${enabled ? 'On' : 'Off'} survives reset and reconnect`, async ({
        page,
    }) => {
        await installDesktop(page);
        await page.clock.install();
        await page.goto('/');
        const liveSwitch = page.getByRole('switch', { name: 'Live updates' });
        if (!enabled) await liveSwitch.click();
        await page.getByLabel('Live update interval').selectOption('5');
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
        await expect(
            page.getByRole('dialog', { name: 'Resetting session data' }),
        ).not.toBeVisible();
        await expect(liveSwitch).toBeChecked({ checked: enabled });
        if (!enabled) {
            await page.getByRole('button', { name: 'Refresh snapshot', exact: true }).click();
            await expect(page.getByRole('button', { name: 'Reset session data' })).toBeEnabled();
        }
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await expect(
            page.getByRole('button', { name: 'Connect device', exact: true }),
        ).toBeVisible();
        await expect(liveSwitch).toBeChecked({ checked: enabled });
        const disconnectedCount = await page.evaluate(() => window.desktopTest.collects);
        await page.clock.runFor(6000);
        expect(await page.evaluate(() => window.desktopTest.collects)).toBe(disconnectedCount);
        // Clearing retained evidence while disconnected also keeps the selection.
        await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
        await expect(
            page.getByRole('dialog', { name: 'Resetting session data' }),
        ).not.toBeVisible();
        await expect(liveSwitch).toBeChecked({ checked: enabled });
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        await expect(liveSwitch).toBeChecked({ checked: enabled });
        const reconnectedCount = await page.evaluate(() => window.desktopTest.collects);
        await page.clock.runFor(5100);
        await expect
            .poll(() => page.evaluate(() => window.desktopTest.collects))
            .toBe(reconnectedCount + (enabled ? 1 : 0));
        expect(await page.evaluate(() => window.desktopTest.connects)).toBe(2);
    });

    test(`unexpected SSH close retains live preference ${enabled ? 'On' : 'Off'}`, async ({
        page,
    }) => {
        await installDesktop(page);
        await page.goto('/');
        const liveSwitch = page.getByRole('switch', { name: 'Live updates' });
        if (!enabled) await liveSwitch.click();
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        await page.evaluate(() => window.desktopTest.closeConnection!());
        await expect(
            page.getByRole('button', { name: 'Connect device', exact: true }),
        ).toBeVisible();
        await expect(liveSwitch).toBeChecked({ checked: enabled });
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        await expect(liveSwitch).toBeChecked({ checked: enabled });
    });
}

test('reconnecting after a collection failure restores the last user selection', async ({
    page,
}) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.evaluate(() => {
        const collect = window.diagnosticHub!.collect;
        window.diagnosticHub!.collect = async () => {
            window.diagnosticHub!.collect = collect;
            throw new Error('Temporary collection failure');
        };
    });
    await page.clock.runFor(5100);
    const liveSwitch = page.getByRole('switch', { name: 'Live updates' });
    await expect(liveSwitch).not.toBeChecked();
    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await expect(liveSwitch).toBeChecked();
    const collections = await page.evaluate(() => window.desktopTest.collects);
    await page.clock.runFor(5100);
    await expect.poll(() => page.evaluate(() => window.desktopTest.collects)).toBe(collections + 1);
});

test('disconnect retains graph history without polling and reset removes the retained data', async ({
    page,
}) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.clock.runFor(5100);
    await expect.poll(() => page.evaluate(() => window.desktopTest.collects)).toBe(2);
    const inspectMemory = async () => {
        await page.getByRole('button', { name: 'Memory', exact: true }).click();
        await page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
            .click();
    };
    await inspectMemory();
    const graphTab = page.getByRole('tab', { name: 'Graph view' });
    await graphTab.click();
    const points = await page.getByRole('dialog').locator('.live-graph circle').count();
    expect(points).toBeGreaterThan(2);
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Live updates' })).toBeChecked();
    const collections = await page.evaluate(() => window.desktopTest.collects);
    await page.clock.runFor(6000);
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(collections);
    await inspectMemory();
    await graphTab.click();
    await expect(page.getByRole('dialog').locator('.live-graph circle')).toHaveCount(points);
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    // Pausing keeps recorded graphs available, including after disconnect.
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await inspectMemory();
    await graphTab.click();
    await expect(page.getByRole('dialog').locator('.live-graph circle')).toHaveCount(points);
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    await inspectMemory();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).toBeVisible();
    await expect(graphTab).toHaveCount(0);
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(collections);
});

test('an imported report plots its recorded snapshot with Live updates Off and no SSH session', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'report.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(demoSnapshot())),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.locator('.probe-card').first().click();
    await page.getByRole('tab', { name: 'Graph view' }).click();
    await expect(page.getByRole('dialog').locator('.live-graph circle')).toHaveCount(2);
    await expect(page.getByRole('dialog').locator('.graph-summary')).toContainText('1 sample');
    await expect(page.getByRole('dialog')).not.toContainText('Waiting for a live sample');
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(0);
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(0);
});

test('a missing latest reading retains earlier graph points and does not invent new samples', async ({
    page,
}) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.locator('.probe-card').first().click();
    const dialog = page.getByRole('dialog');
    const graphTab = dialog.getByRole('tab', { name: 'Graph view' });
    await graphTab.click();
    const points = await dialog.locator('.live-graph circle').count();
    await page.evaluate(() => {
        const collect = window.diagnosticHub!.collect;
        window.diagnosticHub!.collect = async () => {
            const data = await collect();
            return {
                ...data,
                results: data.results.map((result) =>
                    result.id === 'memory'
                        ? {
                              ...result,
                              status: 'unavailable' as const,
                              exitCode: 127,
                              stdout: '',
                              stderr: 'Memory reading unavailable',
                          }
                        : result,
                ),
            };
        };
    });
    await page.clock.runFor(5100);
    await expect(dialog).toContainText(
        'This snapshot has no numeric readings. Showing retained samples.',
    );
    await expect(graphTab).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator('.live-graph circle')).toHaveCount(points);
});
