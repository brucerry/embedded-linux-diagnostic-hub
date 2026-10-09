import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { clockOutput } from '../fixtures/device-clock';
import { parseDeviceClock } from '../../shared/diagnostics/device-clock';
import { createReport } from '../../shared/report';
import { demoSnapshot } from '../fixtures/snapshots';
import { gatewayFixture } from '../fixtures/gateway';

test.use({ timezoneId: 'America/Los_Angeles' });

const clock = (page: Page) => page.getByRole('region', { name: 'Device time', exact: true });
const calls = (page: Page) => page.evaluate(() => window.desktopTest.clock.calls);
async function connect(page: Page, hostname = 'active-device') {
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Hostname or IP address').fill(hostname);
    await modal.getByLabel('SSH username').fill('engineer');
    await modal.getByLabel('Password', { exact: true }).fill('test-password');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
}
async function paused(page: Page) {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await connect(page);
    await expect(clock(page)).toContainText('16:35');
    await page.getByRole('switch', { name: 'Live updates' }).click();
}

test('device clock is global, accessible and responsive independently of browser timezone', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await paused(page);
    await expect(clock(page)).toContainText('2026-10-09');
    await expect(clock(page)).toContainText('CST · UTC+08:00');
    await expect(clock(page).locator('.device-clock-art')).toHaveAttribute('aria-hidden', 'true');
    expect(await clock(page).getAttribute('aria-live')).toBeNull();
    expect((await clock(page).boundingBox())!.height).toBeLessThanOrEqual(50);
    expect((await page.locator('.site-header').boundingBox())!.height).toBeLessThanOrEqual(80);
    const date = (await clock(page).locator('.device-clock-date').boundingBox())!;
    const zone = (await clock(page).locator('.device-clock-zone').boundingBox())!;
    const time = (await clock(page).locator('.device-clock-time').boundingBox())!;
    expect(zone.y).toBeGreaterThan(date.y);
    expect(time.x).toBeGreaterThanOrEqual(Math.max(date.x + date.width, zone.x + zone.width));
    await page.screenshot({ path: '.codex/device-clock-compact-design-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.codex/device-clock-compact-design-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 950 });
    for (const name of ['Diagnostics 36', 'Tests', 'Terminal', 'Overview']) {
        await page.locator('.primary-nav').getByRole('button', { name, exact: true }).click();
        await expect(clock(page)).toBeVisible();
    }
    for (const item of await page.locator('.insight-nav button').all()) {
        await item.click();
        await expect(clock(page)).toContainText('CST · UTC+08:00');
    }
    const response = {
        status: 'available' as const,
        sample: parseDeviceClock(
            clockOutput(
                '2026-10-09',
                '16:35:00',
                '+0545',
                'Long_Device_Timezone_Label_For_Compact_Layouts',
            ),
        ),
    };
    await page.evaluate((response) => {
        window.desktopTest.clock.response = response;
    }, response);
    await page.clock.fastForward(60_000);
    await expect(clock(page)).toContainText('UTC+05:45');
    for (const width of [1440, 1100, 850, 600, 390, 320]) {
        await page.setViewportSize({ width, height: 950 });
        await expect(clock(page)).toBeVisible();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
        const bounds = await clock(page).boundingBox();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    expect(await calls(page)).toBe(2);
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.screenshot({ path: '.codex/device-clock-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.codex/device-clock-mobile.png' });
});

test('seven-segment digits and pixel hands follow device time with an orange disconnect action', async ({
    page,
}) => {
    await paused(page);
    const region = clock(page);
    const display = region.locator('.device-clock-time');
    await expect(display.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    const minuteHand = region.locator('.device-clock-minute-hand');
    const hourHand = region.locator('.device-clock-hour-hand');
    const masks = [
        'abcdef',
        'bc',
        'abdeg',
        'abcdg',
        'bcfg',
        'acdfg',
        'acdefg',
        'abc',
        'abcdefg',
        'abcdfg',
    ];
    let previousMinute = await minuteHand.getAttribute('d');
    let previousHour = await hourHand.getAttribute('d');
    for (const time of ['13:50:00', '07:48:00', '09:26:00', '00:01:00']) {
        const response = {
            status: 'available' as const,
            sample: parseDeviceClock(clockOutput('2026-10-09', time, '+0800', 'CST')),
        };
        await page.evaluate((response) => {
            window.desktopTest.clock.response = response;
        }, response);
        await page.clock.fastForward(60_000);
        await expect(display).toHaveText(time.slice(0, 5));
        for (const [index, digit] of [...time.slice(0, 5)].entries()) {
            const group = display.locator('svg > g').nth(index);
            if (digit === ':') {
                await expect(group.locator('path')).toHaveCount(1);
                continue;
            }
            const lit = await group
                .locator('path')
                .evaluateAll((paths) => paths.map((path) => path.getAttribute('opacity') === '1'));
            expect(lit).toEqual(
                [...'abcdefg'].map((segment) => masks[Number(digit)].includes(segment)),
            );
        }
        expect(await minuteHand.getAttribute('d')).not.toBe(previousMinute);
        expect(await hourHand.getAttribute('d')).not.toBe(previousHour);
        previousMinute = await minuteHand.getAttribute('d');
        previousHour = await hourHand.getAttribute('d');
    }
    await page.evaluate(() => {
        window.desktopTest.clock.fail = true;
    });
    await page.clock.fastForward(60_000);
    await expect(region).toContainText('Stale');
    await expect(minuteHand).toHaveAttribute('d', previousMinute!);
    await expect(hourHand).toHaveAttribute('d', previousHour!);
    const disconnect = page.getByRole('button', { name: 'Disconnect device', exact: true });
    await expect(disconnect).toHaveCSS('background-color', 'rgb(244, 165, 83)');
    await disconnect.hover();
    await expect(disconnect).toHaveCSS('background-color', 'rgb(255, 193, 122)');
    await disconnect.click();
    await expect(region).toContainText('No device connected');
    await expect(region.locator('.device-clock-hour-hand')).toHaveCount(0);
    const connectButton = page.getByRole('button', { name: 'Connect device', exact: true }).first();
    await connectButton.hover();
    await expect(connectButton).toHaveCSS('background-color', 'rgb(180, 208, 255)');
});

test('minute polling is independent of paused and five-second live diagnostics', async ({
    page,
}) => {
    await paused(page);
    const collections = await page.evaluate(() => window.desktopTest.collects);
    await page.clock.fastForward(60_000);
    await expect.poll(() => calls(page)).toBe(2);
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(collections);
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('switch', { name: 'Live updates' }).click();
    for (let index = 0; index < 12; index++) {
        const before = await page.evaluate(() => window.desktopTest.collects);
        await page.clock.fastForward(5000);
        await expect
            .poll(() => page.evaluate(() => window.desktopTest.collects))
            .toBeGreaterThan(before);
        await expect(
            page.getByRole('button', { name: 'Disconnect device', exact: true }),
        ).toBeEnabled();
    }
    expect(await calls(page)).toBe(3);
});

test('clock requests coalesce, become stale on failure and recover atomically', async ({
    page,
}) => {
    await paused(page);
    await page.evaluate(() => {
        window.desktopTest.clock.hold = true;
    });
    await page.clock.fastForward(60_000);
    await expect.poll(() => calls(page)).toBe(2);
    await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
    });
    await page.clock.fastForward(60_000);
    expect(await calls(page)).toBe(2);
    await page.evaluate(() => window.desktopTest.clock.release?.());
    await expect.poll(() => calls(page)).toBe(3);
    await page.evaluate(() => {
        window.desktopTest.clock.fail = true;
    });
    await page.clock.fastForward(60_000);
    await expect(clock(page)).toContainText('Stale');
    await expect(clock(page)).toContainText('16:35');
    const response = {
        status: 'available' as const,
        sample: parseDeviceClock(clockOutput('2026-10-10', '00:02:00', '-0400', 'EDT')),
    };
    await page.evaluate((response) => {
        window.desktopTest.clock.fail = false;
        window.desktopTest.clock.response = response;
    }, response);
    await page.clock.fastForward(60_000);
    await expect(clock(page)).toContainText('2026-10-10');
    await expect(clock(page)).toContainText('00:02');
    await expect(clock(page)).toContainText('EDT · UTC-04:00');
    await expect(clock(page)).not.toContainText('Stale');
    await page.evaluate(() => {
        if (window.desktopTest.clock.response.status === 'available') {
            window.desktopTest.clock.response.sample.utcOffsetMinutes = null;
            window.desktopTest.clock.response.sample.zone = null;
        }
    });
    await page.clock.fastForward(60_000);
    await expect(clock(page)).toContainText('Timezone unknown');
});

test('resume, reset and reboot evidence refresh without duplicate minute loops', async ({
    page,
}) => {
    await paused(page);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(180_000);
    expect(await calls(page)).toBe(1);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => calls(page)).toBe(2);
    await page.getByRole('button', { name: 'Reset session data' }).click();
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    await expect.poll(() => calls(page)).toBe(3);
    await page.getByRole('button', { name: 'Refresh snapshot', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh snapshot', exact: true })).toBeEnabled();
    await page.evaluate(() => {
        window.desktopTest.snapshot!.results.find((result) => result.id === 'uptime')!.stdout =
            '1.50 0.50';
    });
    await page.getByRole('button', { name: 'Refresh snapshot', exact: true }).click();
    await expect.poll(() => calls(page)).toBe(4);
    await page.clock.fastForward(60_000);
    await expect.poll(() => calls(page)).toBe(5);
    await page.evaluate(() => {
        const result = window.desktopTest.clock.response;
        if (result.status === 'available') {
            result.sample.bootId = '22222222-2222-4222-8222-222222222222';
            result.sample.uptimeSeconds = 2;
            result.sample.date = '2026-10-12';
        }
    });
    await page.clock.fastForward(60_000);
    await expect(clock(page)).toContainText('2026-10-12');
    expect(await calls(page)).toBe(6);
    await page.clock.fastForward(60_000);
    await expect.poll(() => calls(page)).toBe(7);
});

test('failed resume retains the last device sample as stale and reset discards a late read', async ({
    page,
}) => {
    await paused(page);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.evaluate(() => {
        window.desktopTest.clock.fail = true;
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(clock(page)).toContainText('Stale');
    await expect(clock(page)).toContainText('16:35');
    await page.evaluate(() => {
        window.desktopTest.clock.fail = false;
        window.desktopTest.clock.hold = true;
    });
    await page.clock.fastForward(60_000);
    await expect.poll(() => calls(page)).toBe(3);
    await page.getByRole('button', { name: 'Reset session data' }).click();
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    const response = {
        status: 'available' as const,
        sample: parseDeviceClock(clockOutput('2026-10-11', '09:04:00', '+0000', 'UTC')),
    };
    await page.evaluate((response) => {
        window.desktopTest.clock.response = response;
        window.desktopTest.clock.release?.();
    }, response);
    await expect(clock(page)).toContainText('2026-10-11');
    await expect(clock(page)).not.toContainText('2026-10-09');
    expect(await calls(page)).toBe(4);
});

test('late old-device results are discarded and page reload samples only after fresh authentication', async ({
    page,
}) => {
    await paused(page);
    await page.evaluate(() => {
        window.desktopTest.clock.hold = true;
    });
    await page.clock.fastForward(60_000);
    await expect.poll(() => calls(page)).toBe(2);
    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await expect(clock(page)).toContainText('No device connected');
    const response = {
        status: 'available' as const,
        sample: parseDeviceClock(
            clockOutput(
                '2026-11-01',
                '01:03:00',
                '-0500',
                'EST',
                '22222222-2222-4222-8222-222222222222',
                '2.5',
            ),
        ),
    };
    await page.evaluate((response) => {
        window.desktopTest.clock.response = response;
    }, response);
    await connect(page, 'new-device');
    await page.evaluate(() => window.desktopTest.clock.release?.());
    await expect(clock(page)).toContainText('2026-11-01');
    await expect(clock(page)).toContainText('EST · UTC-05:00');
    expect(await calls(page)).toBe(3);
    await page.reload();
    await expect(clock(page)).toContainText('No device connected');
    expect(await calls(page)).toBe(0);
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(0);
    await connect(page);
    await expect(clock(page)).toContainText('16:35');
    expect(await calls(page)).toBe(1);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-password');
});

test('missing bridge support, unavailable reads, report import and update keep honest clock states', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.evaluate(() => {
        window.diagnosticHub!.readDeviceClock = undefined;
    });
    await connect(page);
    await expect(clock(page)).toContainText('Device time unavailable');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'report.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(createReport(demoSnapshot()))),
    });
    await expect(clock(page)).toContainText('No device connected');
    await page.reload();
    await page.evaluate(() => {
        window.desktopTest.clock.fail = true;
    });
    await connect(page);
    await expect(clock(page)).toContainText('Device time unavailable');
    await page.evaluate(() => window.desktopTest.closeConnection?.());
    await expect(clock(page)).toContainText('No device connected');
});

test('website clock supports native gateway data and older/malformed routes without losing SSH', async ({
    page,
}) => {
    const gateway = await gatewayFixture();
    let mode: 'unsupported' | 'malformed' | 'normal' = 'unsupported';
    await page.route('**/api/sessions/*/clock', async (route) => {
        if (mode === 'normal') return route.continue();
        await route.fulfill({
            status: mode === 'unsupported' ? 404 : 200,
            contentType: 'application/json',
            body: JSON.stringify(
                mode === 'unsupported'
                    ? { error: 'Unknown gateway route.' }
                    : { status: 'available', sample: {} },
            ),
        });
    });
    try {
        await page.clock.install();
        await page.goto('/');
        const open = async () => {
            await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
            const modal = page.getByRole('dialog');
            await modal.getByLabel('Gateway HTTPS address').fill(gateway.url);
            await modal.getByLabel('Gateway access token').fill(gateway.token);
            await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
            await modal.getByLabel('Port', { exact: true }).fill(String(gateway.options.port));
            await modal.getByLabel('SSH username').fill(gateway.options.username);
            await modal.getByLabel('Password', { exact: true }).fill(gateway.options.password);
            await modal.getByRole('button', { name: 'Read fingerprint' }).click();
            await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
            await modal.getByRole('button', { name: 'Connect via SSH' }).click();
            await expect(modal).not.toBeVisible();
        };
        await open();
        await expect(clock(page)).toContainText('Device time unavailable');
        await page.getByRole('switch', { name: 'Live updates' }).click();
        await page.clock.fastForward(60_000);
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        await expect(page.getByText('Ready', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        mode = 'malformed';
        await open();
        await expect(clock(page)).toContainText('Device time unavailable');
        mode = 'normal';
        await page.clock.fastForward(60_000);
        await expect(clock(page)).toContainText('CST · UTC+08:00');
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    } finally {
        await page.goto('about:blank');
        await gateway.close();
    }
});
