import { expect, test } from '@playwright/test';
import { demoSnapshot } from '../fixtures/snapshots';
import { installDesktop } from './fixtures/desktop';

test('RAM reset drains active collection, resumes live updates and keeps one SSH connection', async ({
    page,
}) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Reset session data' })).toBeDisabled();
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.evaluate(() => {
        window.desktopTest.holdNextCollection = true;
    });
    await page.getByLabel('Live update interval').selectOption('5');
    await page.clock.runFor(5100);
    await expect.poll(() => page.evaluate(() => window.desktopTest.collects)).toBe(2);
    await page.getByRole('button', { name: 'Reset session data' }).click();
    const overlay = page.getByRole('dialog', { name: 'Resetting session data' });
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Waiting for the current collection');
    await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(overlay).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Resetting session data…', includeHidden: true }),
    ).toBeDisabled();
    await expect(
        page.getByRole('switch', { name: 'Live updates', includeHidden: true }),
    ).toBeChecked();
    await expect(
        page.getByRole('button', { name: 'Disconnect device', exact: true, includeHidden: true }),
    ).toBeDisabled();
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(2);
    await page.evaluate(() => window.desktopTest.releaseCollection!());
    await expect.poll(() => page.evaluate(() => window.desktopTest.collects)).toBe(3);
    await expect(overlay).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset session data' })).toBeEnabled();
    await expect(page.getByRole('switch', { name: 'Live updates' })).toBeChecked();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
    expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(0);
    await page.getByRole('button', { name: 'Diagnostics 36' }).click();
    await page
        .locator('.probe-card')
        .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
        .click();
    await page.getByRole('dialog').getByRole('tab', { name: 'Graph view' }).click();
    // Only the first post-reset sample remains, one point for each used/free series.
    await expect(page.getByRole('dialog').locator('.live-graph circle')).toHaveCount(2);
});

test('reset clears disconnected/imported data and does not enable paused live updates', async ({
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
    await page.getByRole('button', { name: 'Reset session data' }).click();
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset session data' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(0);
    expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(0);
});

test('paused reset keeps the overview cards, clears readings and does not insert a fresh-record section', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page.evaluate(() => {
        window.diagnosticHub!.clearSessionData = () =>
            new Promise<void>((resolve) => {
                (window as any).finishReset = resolve;
            });
    });
    await page.getByRole('button', { name: 'Reset session data' }).click();
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).toBeVisible();
    await expect(page.locator('.metric-card')).toHaveCount(4);
    await page.evaluate(() => (window as any).finishReset());
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    await expect(page.locator('.connection-start')).toHaveCount(0);
    await expect(page.locator('.metric-card')).toHaveCount(4);
    await expect(page.getByRole('heading', { name: 'Identity not collected' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export report', exact: true })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
    await page.getByRole('button', { name: 'Refresh snapshot', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reset session data' })).toBeEnabled();
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(2);
    expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(0);
});

test('reset cover remains through fresh collection while keeping the current page and graph availability', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.evaluate(() => {
        window.desktopTest.holdNextCollection = true;
        window.diagnosticHub!.clearSessionData = () =>
            new Promise<void>((resolve) => {
                (window as any).finishReset = resolve;
            });
    });
    await page.getByRole('button', { name: 'Reset session data' }).click();
    const overlay = page.getByRole('dialog', { name: 'Resetting session data' });
    await expect(overlay).toContainText('Clearing the snapshot and graph history');
    await expect(
        page.getByRole('heading', { name: 'Memory', exact: true, includeHidden: true }),
    ).toBeVisible();
    await page.keyboard.press('Tab');
    expect(await overlay.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.evaluate(() => (window as any).finishReset());
    await expect.poll(() => page.evaluate(() => window.desktopTest.collects)).toBe(2);
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Collecting the first snapshot');
    await expect(
        page.getByRole('switch', { name: 'Live updates', includeHidden: true }),
    ).toBeChecked();
    await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
    await expect(
        page.getByRole('heading', { name: 'Memory', exact: true, includeHidden: true }),
    ).toBeVisible();
    await page.evaluate(() => window.desktopTest.releaseCollection!());
    await expect(overlay).not.toBeVisible();
    await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
    await expect(page.getByRole('button', { name: 'Reset session data' })).toBeEnabled();
    await page.locator('.probe-card').click();
    await page.getByRole('tab', { name: 'Graph view' }).click();
    await expect(page.locator('.live-graph circle')).toHaveCount(2);
    expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(0);
});

test('failed reset releases the overlay, retains evidence and restores normal controls', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.evaluate(() => {
        window.diagnosticHub!.clearSessionData = async () => {
            throw Error('Test reset failure');
        };
    });
    await page.getByRole('button', { name: 'Reset session data' }).click();
    await expect(page.getByRole('alert')).toContainText('Could not reset session data');
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    await expect(page.getByRole('switch', { name: 'Live updates' })).toBeChecked();
    await expect(page.locator('.metric-card').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset session data' })).toBeEnabled();
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(1);
});

test('collection failure during reset stays paused instead of immediately retrying', async ({
    page,
}) => {
    await installDesktop(page);
    await page.addInitScript(() => {
        const collect = window.diagnosticHub!.collect;
        window.diagnosticHub!.collect = async () => {
            const snapshot = await collect();
            if (window.desktopTest.collects === 2) throw Error('Device stopped responding');
            return snapshot;
        };
    });
    await page.clock.install();
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.evaluate(() => {
        window.desktopTest.holdNextCollection = true;
    });
    await page.getByLabel('Live update interval').selectOption('5');
    await page.clock.runFor(5100);
    await expect.poll(() => page.evaluate(() => window.desktopTest.collects)).toBe(2);
    await page.getByRole('button', { name: 'Reset session data' }).click();
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).toBeVisible();
    await page.evaluate(() => window.desktopTest.releaseCollection!());
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
    await expect(page.getByRole('alert')).toContainText('Device stopped responding');
    await page.clock.runFor(10_100);
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(2);
});

test('overview stays mounted beneath the cover until fresh readings replace the old record', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    // SSH can become connected before the first snapshot finishes rendering.
    await expect(page.locator('.metric-card')).toHaveCount(4);
    await page.evaluate(() => {
        (window as any).originalMetric = document.querySelector('.metric-card');
        window.desktopTest.holdNextCollection = true;
    });
    await page.getByRole('button', { name: 'Reset session data' }).click();
    const overlay = page.getByRole('dialog', { name: 'Resetting session data' });
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Collecting the first snapshot');
    await page.screenshot({ path: 'test-results/reset-cover.png' });
    await expect(page.locator('.metric-card')).toHaveCount(4);
    await expect(page.locator('.connection-start')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(overlay).toBeVisible();
    await page.evaluate(() => window.desktopTest.releaseCollection!());
    await expect(overlay).not.toBeVisible();
    expect(
        await page.evaluate(
            () => document.querySelector('.metric-card') === (window as any).originalMetric,
        ),
    ).toBe(true);
    await expect(page.locator('.connection-start')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reset session data' })).toBeEnabled();
});

test('fresh collection failure releases the cover with cleared cards instead of a fresh-record section', async ({
    page,
}) => {
    await installDesktop(page);
    await page.addInitScript(() => {
        const collect = window.diagnosticHub!.collect;
        window.diagnosticHub!.collect = async () => {
            const snapshot = await collect();
            if (window.desktopTest.collects > 1) throw Error('Fresh collection failed');
            return snapshot;
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reset session data' }).click();
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Fresh collection failed');
    await expect(page.locator('.connection-start')).toHaveCount(0);
    await expect(page.locator('.metric-card')).toHaveCount(4);
    await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Export report', exact: true })).toBeDisabled();
});

test('cleared disconnected cards guide connection consistently in overview and diagnostics', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
    const tile = page.locator('.hardware-tile').first();
    await expect(tile).toBeEnabled();
    await tile.click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Hardware diagnostics', exact: true }).click();
    await page.locator('.probe-card').first().click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(1);
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
});

for (const section of ['overview', 'memory']) {
    test(`connected paused ${section} cards collect cleared evidence without opening login`, async ({
        page,
    }) => {
        await installDesktop(page);
        await page.goto('/');
        await page.getByRole('switch', { name: 'Live updates' }).click();
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
        await expect(
            page.getByRole('dialog', { name: 'Connect a Linux device' }),
        ).not.toBeVisible();
        await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
        await expect(
            page.getByRole('dialog', { name: 'Resetting session data' }),
        ).not.toBeVisible();
        if (section === 'memory') {
            await page.getByRole('button', { name: 'Memory', exact: true }).click();
            await expect(page.locator('.context-note')).toContainText('SSH is connected');
        }
        const card = page
            .locator(section === 'overview' ? '.hardware-tile' : '.probe-card')
            .first();
        await expect(card).toContainText(section === 'overview' ? 'Collect snapshot' : 'Collect');
        await page.evaluate(() => {
            window.desktopTest.holdNextCollection = true;
        });
        await card.click();
        await expect.poll(() => page.evaluate(() => window.desktopTest.collects)).toBe(2);
        await expect(card).toBeDisabled();
        await expect(
            page.getByRole('dialog', { name: 'Connect a Linux device' }),
        ).not.toBeVisible();
        await page.evaluate(() => window.desktopTest.releaseCollection!());
        await expect(
            page.getByRole('dialog').getByRole('tab', { name: 'Standard output' }),
        ).toBeVisible();
        await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
        await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
        await expect(
            page.getByRole('button', { name: 'Disconnect device', exact: true }),
        ).toBeEnabled();
        expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
        expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(0);
    });
}

test('failed card collection keeps SSH open and does not leave an invisible evidence dialog', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    await page.evaluate(() => {
        const collect = window.diagnosticHub!.collect;
        window.diagnosticHub!.collect = async () => {
            window.diagnosticHub!.collect = collect;
            throw new Error('Temporary read failure');
        };
    });
    await page.locator('.hardware-tile').first().click();
    await expect(page.getByRole('alert')).toContainText('Temporary read failure');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Scroll to top' })).toBeEnabled();
    await page.locator('.hardware-tile').first().click();
    await expect(
        page.getByRole('dialog').getByRole('tab', { name: 'Standard output' }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
    expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(0);
});
