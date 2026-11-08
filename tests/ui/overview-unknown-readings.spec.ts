import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';

// Reuse the real App collection -> history preparation -> Overview render path.
// Only the existing desktop bridge is fake. No device commands, downloads or
// existing user storage operations are requested by this case.
const validMemory = 'MemTotal: 102400 kB\nMemAvailable: 51200 kB\nMemFree: 25600 kB\n';

async function setReadings(page: Page, uptime: string, memory: string) {
    await page.evaluate(
        ({ uptime, memory }) => {
            for (const [id, stdout] of [
                ['uptime', uptime],
                ['memory', memory],
            ]) {
                const result = window.desktopTest.snapshot!.results.find((item) => item.id === id);
                if (!result) throw Error('Missing synthetic Overview probe.');
                result.status = 'collected';
                result.stdout = stdout;
                result.stderr = '';
            }
        },
        { uptime, memory },
    );
}

async function refresh(page: Page, uptime: string, memory: string) {
    const before = await page.evaluate(() => window.desktopTest.collects);
    await setReadings(page, uptime, memory);
    const button = page.getByRole('button', { name: 'Refresh snapshot', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect.poll(() => page.evaluate(() => window.desktopTest.collects)).toBe(before + 1);
    await expect(button).toBeEnabled();
}

async function readings(page: Page, uptime: string, memoryValue: string, memoryDetail: string) {
    const memory = page
        .locator('.metric-card')
        .filter({ has: page.getByText('Memory usage', { exact: true }) });
    const clock = page
        .locator('.metric-card')
        .filter({ has: page.getByText('Device uptime', { exact: true }) });
    await expect(memory).toHaveCount(1);
    await expect(clock).toHaveCount(1);
    await expect(clock.locator('.metric-value')).toHaveText(uptime);
    await expect(memory.locator('.metric-value')).toHaveText(memoryValue);
    await expect(memory.locator('.metric-detail')).toHaveText(memoryDetail);
    await expect(page.locator('.metric-grid')).not.toContainText(/NaN|Infinity/);
}

test('Overview renders unknown uptime and memory without false zero and recovers genuine values', async ({
    page,
}, testInfo) => {
    await installDesktop(page);
    await page.goto('/');
    const live = page.getByRole('switch', { name: 'Live updates', exact: true });
    await expect(live).toHaveAttribute('aria-checked', 'true');
    await live.click();
    await expect(live).toHaveAttribute('aria-checked', 'false');
    await setReadings(page, '100.00 0', validMemory);
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog', { name: 'Connect a Linux device', exact: true });
    await modal.getByLabel('Hostname or IP address').fill('overview-fixture');
    await modal.getByLabel('SSH username').fill('engineer');
    await modal.getByLabel('Password', { exact: true }).fill('synthetic-password');
    await modal.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    // SSH also mounts its persistent terminal while Overview remains visible.
    await expect.poll(() => page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(1);
    await readings(page, '0h 1m', '50%', '50 MiB available of 100 MiB');
    const phases = ['valid'];

    await refresh(
        page,
        '9'.repeat(400) + ' 0',
        'MemTotal: 102400 kB\nMemAvailable: ' + '9'.repeat(400) + ' kB\n',
    );
    await readings(page, 'Unavailable', '—', 'Availability unknown · 100 MiB total');
    phases.push('overflow');

    await refresh(page, ' \t\r\n', 'MemTotal: 102400 kB\n');
    await readings(page, 'Unavailable', '—', 'Availability unknown · 100 MiB total');
    phases.push('missing-availability');

    await refresh(
        page,
        '1e309 0',
        'MemTotal: 102400 kB\nMemAvailable: 204800 kB\nMemFree: 204800 kB\n',
    );
    await readings(page, 'Unavailable', '—', 'Availability unknown · 100 MiB total');
    phases.push('malformed-contradictory');

    await refresh(page, '', '');
    await readings(page, 'Unavailable', '—', 'Memory data unavailable');
    phases.push('empty');

    await refresh(page, '0.00 0', 'MemTotal: 102400 kB\nMemAvailable: 0 kB\nMemFree: 0 kB\n');
    await readings(page, '0h 0m', '100%', '0 MiB available of 100 MiB');
    phases.push('genuine-zero');

    await refresh(page, '3661.50 0', validMemory);
    await readings(page, '1h 1m', '50%', '50 MiB available of 100 MiB');
    phases.push('recovered');
    await expect(live).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(7);

    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await expect(
        page.getByRole('button', { name: 'Connect device', exact: true }).first(),
    ).toBeEnabled();
    await expect
        .poll(() =>
            page.evaluate(() => ({
                opens: window.desktopTest.terminal!.opens,
                closes: window.desktopTest.terminal!.closes,
                ownerEmpty: window.desktopTest.terminal!.id === '',
            })),
        )
        .toEqual({ opens: 1, closes: 1, ownerEmpty: true });
    const observation = await page.evaluate(() => ({
        schema: 1,
        boundary: 'mock-desktop-overview',
        connects: window.desktopTest.connects,
        disconnects: window.desktopTest.disconnects,
        collects: window.desktopTest.collects,
        terminalOpens: window.desktopTest.terminal!.opens,
        terminalCloses: window.desktopTest.terminal!.closes,
        terminalInputs: window.desktopTest.terminal!.inputs.length,
        terminalOwnerEmpty: window.desktopTest.terminal!.id === '',
        captureExports: window.desktopTest.captureExports.length,
        updateRequests: window.desktopTest.requests.length,
        clockHeld: window.desktopTest.clock.hold,
        collectionHeld: Boolean(window.desktopTest.holdNextCollection),
    }));
    expect(observation).toEqual({
        schema: 1,
        boundary: 'mock-desktop-overview',
        connects: 1,
        disconnects: 1,
        collects: 7,
        terminalOpens: 1,
        terminalCloses: 1,
        terminalInputs: 0,
        terminalOwnerEmpty: true,
        captureExports: 0,
        updateRequests: 0,
        clockHeld: false,
        collectionHeld: false,
    });
    const body = Buffer.from(JSON.stringify({ ...observation, phases }));
    if (body.length > 4096) throw Error('Overview observation exceeded its bound.');
    await testInfo.attach('overview-readings-observation', {
        body,
        contentType: 'application/json',
    });
});
