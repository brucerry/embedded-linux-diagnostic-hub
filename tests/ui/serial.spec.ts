import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installSerial } from './fixtures/serial';
import { demoSnapshot } from '../fixtures/snapshots';
async function screenshot(
    page: import('@playwright/test').Page,
    name: string,
    testInfo: import('@playwright/test').TestInfo,
) {
    const output = process.env.HUB_FEATURE_EVIDENCE
        ? path.join(process.env.HUB_FEATURE_EVIDENCE, name)
        : testInfo.outputPath(name);
    await mkdir(path.dirname(output), { recursive: true });
    await page.screenshot({ path: output, fullPage: true });
}
test('local Serial uses explicit settings/open, byte input, retained reception and clean deselection', async ({
    page,
}, testInfo) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await expect(serial.getByText('Ports on this computer')).toBeVisible();
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(0);
    await expect(serial.getByLabel('Baud rate')).toHaveValue('115200');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.evaluate(() => {
        window.serialTest.push([0x65, 0x75, 0x72, 0x6f, 0x20, 0xe2, 0x82]);
        window.serialTest.push([0xac, 13, 10, 27, 91, 51, 50, 109, 111, 107, 27, 91, 48, 109]);
    });
    await expect(serial.locator('.xterm-screen')).toContainText('euro €');
    const input = page.getByLabel('Serial terminal input');
    await input.focus();
    await page.keyboard.type('help');
    await page.keyboard.press('Enter');
    await expect
        .poll(() => page.evaluate(() => String.fromCharCode(...window.serialTest.writes.flat())))
        .toContain('help\r');
    await page.keyboard.press('Control+Shift+Escape');
    await expect(serial.getByRole('button', { name: 'Clear terminal', exact: true })).toBeFocused();
    await screenshot(page, 'serial-desktop.png', testInfo);
    await page.getByRole('button', { name: /^Diagnostics \d+$/ }).click();
    expect(await page.evaluate(() => window.serialTest.closes)).toBe(0);
    await page.evaluate(() =>
        window.serialTest.push([...new TextEncoder().encode('hidden reception\r\n')]),
    );
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    await expect(serial.locator('.xterm-screen')).toContainText('hidden reception');
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'serial-independent.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(demoSnapshot())),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.serialTest.closes)).toBe(0);
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    await serial.getByRole('button', { name: 'Deselect', exact: true }).click();
    await expect(serial.getByText('No local port selected')).toBeVisible();
    expect(await page.evaluate(() => window.serialTest.closes)).toBe(1);
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(1);
});
test('Serial beach motion, reduced motion, resize and no pointer interception', async ({
    page,
}, testInfo) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const beach = page.locator('.serial-beach'),
        ball = page.locator('.serial-volleyball');
    await expect(beach).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.serial-page .terminal-earth')).toHaveCount(0);
    expect(
        await page
            .locator('.serial-sun-surface')
            .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('serial-solar-turn');
    expect(await beach.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    expect(await ball.evaluate((el) => getComputedStyle(el).animationName)).toBe(
        'serial-ball-volley',
    );
    const first = await ball.evaluate((el) => getComputedStyle(el).transform);
    await expect.poll(() => ball.evaluate((el) => getComputedStyle(el).transform)).not.toBe(first);
    await page.getByRole('button', { name: /^Diagnostics \d+$/ }).click();
    expect(await ball.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await ball.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await screenshot(page, 'serial-reduced-motion.png', testInfo);
    await page.setViewportSize({ width: 412, height: 915 });
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    const frame = await page.locator('.serial-page .terminal-frame').boundingBox();
    const screen = await page.locator('.serial-page .xterm-screen').boundingBox();
    expect(screen!.height).toBeLessThanOrEqual(frame!.height);
    await screenshot(page, 'serial-mobile.png', testInfo);
});
test('unplug and cancelled late open never reconnect or replay input', async ({ page }) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await page.evaluate(() => {
        window.serialTest.holdOpen = true;
    });
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await serial.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.evaluate(() => window.serialTest.releaseOpen?.());
    await expect.poll(() => page.evaluate(() => window.serialTest.closes)).toBe(1);
    await page.evaluate(() => {
        window.serialTest.holdOpen = false;
    });
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.evaluate(() => window.serialTest.unplug());
    await expect.poll(() => page.evaluate(() => window.serialTest.closes)).toBe(2);
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(2);
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(0);
});
test('Serial unavailable API is explicit without blocking other workspaces', async ({ page }) => {
    await page.addInitScript(() =>
        Object.defineProperty(navigator, 'serial', { value: undefined, configurable: true }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    await expect(
        page.getByText('Web Serial is unavailable in this runtime.', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose port…' })).toBeDisabled();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(
        page.getByRole('button', { name: 'Connect device', exact: true }).first(),
    ).toBeVisible();
});
