import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installSerial } from './fixtures/serial';
import { installDesktop } from './fixtures/desktop';
import type { LocalSerial, LocalSerialPort, SerialChooser } from '../../shared/serial';
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
function contrast(left: string, right: string) {
    const luminance = (color: string) =>
        color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const a = luminance(left),
        b = luminance(right);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
async function readableSecondary(button: import('@playwright/test').Locator, hover: boolean) {
    await expect(button).toHaveCSS('color', 'rgb(32, 55, 67)');
    await expect(button).toHaveCSS(
        'background-color',
        hover ? 'rgb(228, 238, 235)' : 'rgb(247, 250, 246)',
    );
    const colors = await button.evaluate((element) => ({
        text: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
    }));
    expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
}

for (const connected of [false, true]) {
    test(`Deselect restores controls and retains framing after ${connected ? 'connected' : 'selected-only'} Serial while SSH stays disconnected`, async ({
        page,
    }, testInfo) => {
        await installDesktop(page);
        await installSerial(page);
        await page.goto('/');
        await page.getByRole('button', { name: 'Serial', exact: true }).click();
        const serial = page.getByRole('region', { name: 'Local serial terminal' });
        const framing = connected
            ? ['57600', '7', 'even', '2', 'hardware']
            : ['115200', '8', 'none', '1', 'none'];
        const labels = ['Baud rate', 'Data bits', 'Parity', 'Stop bits', 'Flow control'];
        for (let index = 0; index < labels.length; index++)
            await serial.getByLabel(labels[index], { exact: true }).selectOption(framing[index]);
        const port = serial.getByLabel('Local serial port', { exact: true });
        await port.selectOption('0');
        if (connected) {
            await serial.getByRole('button', { name: 'Connect', exact: true }).click();
            await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
            await expect(
                page.getByRole('region', { name: 'Device time', exact: true }),
            ).toContainText('SSH disconnected');
            expect(await page.evaluate(() => window.desktopTest.clock.calls)).toBe(0);
        }
        await serial.getByRole('button', { name: 'Deselect', exact: true }).click();
        await expect(serial.getByText('No local port selected')).toBeVisible();
        await expect(port).toBeEnabled();
        await expect(port).toHaveValue('-1');
        await expect(serial.getByRole('button', { name: /^Choose port/ })).toBeEnabled();
        for (let index = 0; index < labels.length; index++) {
            await expect(serial.getByLabel(labels[index], { exact: true })).toBeEnabled();
            await expect(serial.getByLabel(labels[index], { exact: true })).toHaveValue(
                framing[index],
            );
        }
        await expect(serial.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
        expect(await page.evaluate(() => window.serialTest.opens)).toBe(connected ? 1 : 0);
        expect(await page.evaluate(() => window.serialTest.closes)).toBe(connected ? 1 : 0);
        await screenshot(
            page,
            `serial-deselected-${connected ? 'connected' : 'selected-only'}.png`,
            testInfo,
        );
        await port.selectOption('0');
        await expect(serial.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
        expect(await page.evaluate(() => window.serialTest.opens)).toBe(connected ? 1 : 0);
    });
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
    await expect(beach.locator('.serial-bird')).toHaveCount(0);
    await expect(beach.locator('.serial-distant-island')).toHaveCount(2);
    await expect(beach.locator('.serial-crab')).toHaveCount(2);
    const ocean = await beach.locator('.serial-ocean').boundingBox();
    expect(ocean).not.toBeNull();
    for (const island of await beach.locator('.serial-distant-island').all()) {
        const bounds = await island.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.y + bounds!.height).toBeLessThan(ocean!.y + ocean!.height * 0.42);
    }
    await expect(page.locator('.serial-page .terminal-earth')).toHaveCount(0);
    expect(
        await page
            .locator('.serial-sun-surface')
            .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
    await expect(page.locator('.serial-sun-flame')).toHaveCount(8);
    await expect(page.locator('.serial-volley-pig > path')).toHaveCount(0);
    const flame = page.locator('.serial-sun-flame').first();
    const initialFlame = await flame.evaluate((el) => getComputedStyle(el).transform);
    await expect
        .poll(() => flame.evaluate((el) => getComputedStyle(el).transform))
        .not.toBe(initialFlame);
    expect(await beach.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    expect(await ball.evaluate((el) => getComputedStyle(el).animationName)).toBe(
        'serial-ball-volley',
    );
    const first = await ball.evaluate((el) => getComputedStyle(el).transform);
    await expect.poll(() => ball.evaluate((el) => getComputedStyle(el).transform)).not.toBe(first);
    await page.getByRole('button', { name: /^Diagnostics \d+$/ }).click();
    expect(await ball.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
    expect(await flame.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await ball.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    expect(await flame.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await screenshot(page, 'serial-reduced-motion.png', testInfo);
    await page.setViewportSize({ width: 412, height: 915 });
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    const expectFittedTerminal = async (direction: string, previousHeight?: number) => {
        let geometry:
            | {
                  frameHeight: number;
                  containerHeight: number;
                  screenHeight: number;
              }
            | undefined;
        try {
            // ResizeObserver delivery can follow viewport/page-width settlement.
            // Read both rectangles together and retain the exact containment limit.
            await expect
                .poll(
                    async () => {
                        geometry = await page.locator('.serial-page').evaluate((element) => ({
                            frameHeight: element
                                .querySelector('.terminal-frame')!
                                .getBoundingClientRect().height,
                            containerHeight: element
                                .querySelector('.terminal-screen')!
                                .getBoundingClientRect().height,
                            screenHeight: element
                                .querySelector('.xterm-screen')!
                                .getBoundingClientRect().height,
                        }));
                        return {
                            contained:
                                geometry.screenHeight > 0 &&
                                geometry.screenHeight <= geometry.frameHeight,
                            expanded:
                                previousHeight === undefined ||
                                geometry.screenHeight > previousHeight,
                        };
                    },
                    { message: 'Serial terminal fits after ' + direction },
                )
                .toEqual({ contained: true, expanded: true });
        } finally {
            await testInfo.attach('serial-' + direction + '-geometry', {
                body: JSON.stringify(geometry ?? { unavailable: true }, null, 2),
                contentType: 'application/json',
            });
        }
        return geometry!;
    };
    const mobile = await expectFittedTerminal('shrink');
    await screenshot(page, 'serial-mobile.png', testInfo);
    await page.setViewportSize({ width: 1440, height: 1050 });
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    await expectFittedTerminal('expand', mobile.screenHeight);
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

test('desktop chooser reaches every metadata-optional COM identity with bounded rows and accurate labels', async ({
    page,
}, testInfo) => {
    await installDesktop(page);
    await installSerial(page);
    await page.addInitScript(() => {
        const api = (navigator as Navigator & { serial: LocalSerial }).serial;
        const original = api.getPorts.bind(api);
        let listener: (chooser: SerialChooser | null) => void = () => {};
        let complete: ((port: LocalSerialPort) => void) | undefined;
        let known: LocalSerialPort[] = [];
        const ports: SerialChooser['ports'] = Array.from({ length: 129 }, (_, index) => ({
            id: 'os-' + index,
            name: 'COM' + (index + 1),
            displayName: index === 10 ? 'USB-Serial Controller' : undefined,
        }));
        ports.push(
            { id: 'builtin', name: '/dev/ttyS0' },
            { id: 'usb', name: '/dev/ttyUSB0' },
            { id: 'virtual', name: 'COM4096' },
            { id: 'mac', name: '/dev/cu.driver' },
        );
        let chooser = { id: 'native-fixture-request', ports };
        (window as unknown as { shrinkSerialChooser(shrink: boolean): void }).shrinkSerialChooser =
            (shrink) => {
                chooser = {
                    ...chooser,
                    ports: shrink ? [{ id: 'os-128', name: 'COM129' }] : ports,
                };
                listener(chooser);
            };
        api.getPorts = async () => known;
        api.requestPort = () =>
            new Promise<LocalSerialPort>((resolve) => {
                complete = resolve;
                listener(chooser);
            });
        window.diagnosticHub!.onSerialChooser = (callback) => {
            listener = callback;
            return () => {
                listener = () => {};
            };
        };
        window.diagnosticHub!.selectSerialPort = async (id, portId) => {
            if (id !== chooser.id || (portId !== '' && !ports.some((port) => port.id === portId)))
                throw Error('Unattested fixture selection');
            listener(null);
            if (!portId) return;
            const port = (await original())[0];
            port.getInfo = () => ({});
            const other = Object.create(port) as LocalSerialPort;
            other.getInfo = () => ({});
            known = [port, other];
            complete!(port);
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const sshCancel = page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true });
    await expect(sshCancel).toHaveCSS('color', 'rgb(236, 239, 245)');
    await expect(sshCancel).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await sshCancel.hover();
    await expect(sshCancel).toHaveCSS('background-color', 'rgb(38, 43, 53)');
    await expect(sshCancel).toHaveCSS('color', 'rgb(236, 239, 245)');
    await sshCancel.click();
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const choose = page.getByRole('button', { name: 'Choose port…', exact: true });
    await page.mouse.move(0, 0);
    await readableSecondary(choose, false);
    await choose.hover();
    await readableSecondary(choose, true);
    await choose.click();
    const modal = page.getByRole('dialog', { name: 'Choose a local serial port' });
    await expect(modal.locator('.serial-chooser-list button')).toHaveCount(64);
    const previous = modal.getByRole('button', { name: 'Previous ports', exact: true });
    await expect(previous).toBeDisabled();
    await previous.hover({ force: true });
    await expect(previous).toHaveCSS('color', 'rgb(99, 119, 128)');
    await expect(previous).toHaveCSS('background-color', 'rgb(233, 239, 235)');
    await screenshot(page, 'serial-chooser-disabled.png', testInfo);
    await page.keyboard.press('Tab');
    await expect(modal.getByLabel('Find serial port')).toBeFocused();
    await page.keyboard.press('Tab');
    const firstChoice = modal.getByRole('button', { name: 'COM1', exact: true });
    await expect(firstChoice).toBeFocused();
    await expect(firstChoice).toHaveCSS('outline-color', 'rgb(155, 215, 235)');
    expect(
        contrast(
            await firstChoice.evaluate((el) => getComputedStyle(el).outlineColor),
            await modal.evaluate((el) => getComputedStyle(el).backgroundColor),
        ),
    ).toBeGreaterThanOrEqual(3);
    await screenshot(page, 'serial-chooser-keyboard-focus.png', testInfo);
    const com11 = modal.getByRole('button', { name: 'COM11 · USB-Serial Controller', exact: true });
    await page.mouse.move(0, 0);
    await readableSecondary(com11, false);
    await screenshot(page, 'serial-chooser-normal.png', testInfo);
    await com11.hover();
    await readableSecondary(com11, true);
    await screenshot(page, 'serial-chooser-com11-hover.png', testInfo);
    const next = modal.getByRole('button', { name: 'Next ports', exact: true });
    await next.hover();
    await readableSecondary(next, true);
    await next.click();
    await modal.getByRole('button', { name: 'Next ports', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'COM129', exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'COM4096', exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: '/dev/ttyS0', exact: true })).toBeVisible();
    await modal.getByLabel('Find serial port').fill('COM11');
    await expect(com11).toBeVisible();
    await screenshot(page, 'serial-chooser-com11.png', testInfo);
    await page.evaluate(() =>
        (window as unknown as { shrinkSerialChooser(shrink: boolean): void }).shrinkSerialChooser(
            true,
        ),
    );
    await expect(modal.getByLabel('Find serial port')).toBeVisible();
    await expect(modal.locator('.serial-chooser-list button')).toHaveCount(0);
    await modal.getByLabel('Find serial port').fill('');
    await expect(modal.getByRole('button', { name: 'COM129', exact: true })).toBeVisible();
    await page.evaluate(() =>
        (window as unknown as { shrinkSerialChooser(shrink: boolean): void }).shrinkSerialChooser(
            false,
        ),
    );
    await modal.getByLabel('Find serial port').fill('COM11');
    await modal.getByLabel('Find serial port').focus();
    await page.keyboard.press('Tab');
    await expect(com11).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(modal).not.toBeVisible();
    const selected = page.getByLabel('Local serial port', { exact: true });
    await expect(selected.locator('option')).toHaveCount(3);
    await expect(selected.locator('option').filter({ hasText: /^COM11$/ })).toHaveCount(1);
    await expect(selected.locator('option').filter({ hasText: /Authorized port/ })).toHaveCount(1);
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(0);
    await page.getByRole('button', { name: 'Deselect', exact: true }).click();
    await expect(selected).toBeEnabled();
    await expect(choose).toBeEnabled();
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(0);
});

test('recoverable target break keeps local Serial connected and its shared clipboard menu accessible', async ({
    page,
}) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await expect(serial.getByRole('button', { name: 'Forget permission' })).toHaveCount(0);
    await expect(serial.getByRole('option', { name: /Authorized port/ })).toHaveCount(1);
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.evaluate(() => window.serialTest.recoverBreak());
    await page.evaluate(() =>
        window.serialTest.push([...new TextEncoder().encode('boot resumed\r\n')]),
    );
    await expect(serial.locator('.xterm-screen')).toContainText('boot resumed');
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(1);
    expect(await page.evaluate(() => window.serialTest.closes)).toBe(0);
    await serial.locator('.terminal-screen').click({ button: 'right' });
    const menu = serial.getByRole('menu', { name: 'Terminal clipboard' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByLabel('Serial terminal input')).toBeFocused();
    await expect(serial.locator('.serial-bird')).toHaveCount(0);
    await expect(serial.locator('.serial-distant-island')).toHaveCount(2);
    await expect(serial.locator('.serial-crab')).toHaveCount(2);
    await expect(serial.locator('.serial-coconut')).toHaveCount(3);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
        await serial
            .locator('.serial-crab')
            .first()
            .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe('none');
});
