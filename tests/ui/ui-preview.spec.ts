import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installSerial } from './fixtures/serial';
const capture = async (page: Page, name: string, locator?: import('@playwright/test').Locator) => {
    const root = process.env.HUB_FEATURE_EVIDENCE || path.dirname(test.info().outputPath(name));
    await mkdir(root, { recursive: true });
    if (locator) await locator.screenshot({ path: path.join(root, name) });
    else await page.screenshot({ path: path.join(root, name), fullPage: false });
};
const phase = (flow: import('@playwright/test').Locator, name: string) =>
    flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
test('Serial visual acceptance: full light scene, presets/custom, ANSI text and responsive framing', async ({
    page,
}) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' }),
        frame = serial.locator('.terminal-frame');
    await expect(serial.getByLabel('Baud rate', { exact: true })).toHaveValue('115200');
    await expect(serial.getByLabel('Baud rate', { exact: true }).locator('option')).toHaveCount(24);
    await serial.getByLabel('Baud rate', { exact: true }).selectOption('custom');
    await serial.getByLabel('Custom baud rate').fill('12345');
    await expect(serial.getByLabel('Custom baud rate')).toHaveValue('12345');
    await serial.getByLabel('Baud rate', { exact: true }).selectOption('115200');
    await expect(serial.locator('.serial-beach-veil')).toHaveCount(0);
    await expect(serial.locator('.terminal-earth')).toHaveCount(0);
    const layout = await frame.evaluate((el) => {
        const s = el.querySelector('.serial-landscape')!.getBoundingClientRect(),
            f = el.getBoundingClientRect();
        return { fill: s.height / f.height, background: getComputedStyle(el).backgroundColor };
    });
    expect(layout.fill).toBeGreaterThan(0.98);
    expect(layout.background).toBe('rgb(213, 233, 238)');
    await capture(page, 'serial-light-empty.png', frame);
    await serial.getByLabel('Baud rate', { exact: true }).click();
    await capture(page, 'serial-baud-popup.png');
    await page.keyboard.press('Escape');
    await capture(page, 'serial-controls.png', serial.locator('.serial-controls'));
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.evaluate(() =>
        window.serialTest.push([
            ...new TextEncoder().encode(
                Array.from(
                    { length: 45 },
                    (_, i) =>
                        '\x1b[' +
                        [31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97][i % 15] +
                        'm[DISPLAY FIXTURE] ' +
                        String(i).padStart(2, '0') +
                        ' kernel: link state UP · sample bytes 12345\x1b[0m\r\n',
                ).join('') +
                    '\x1b[38;2;255;255;255m[DISPLAY FIXTURE] true-color white, readable on light sky\x1b[0m\r\nfixture# ',
            ),
        ]),
    );
    await expect(serial.locator('.xterm-screen')).toContainText('true-color white');
    await capture(page, 'serial-light-dense.png', frame);
    const input = page.getByLabel('Serial terminal input');
    await input.focus();
    await page.keyboard.press('Control+Shift+Escape');
    await expect(serial.getByRole('button', { name: 'Clear terminal', exact: true })).toBeFocused();
    for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        expect(await serial.evaluate((el) => getComputedStyle(el).colorScheme)).toBe('light');
    }
    await page.setViewportSize({ width: 412, height: 915 });
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    await expect(page.locator('.page-scroll-controls')).toBeHidden();
    await serial.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await serial.getByLabel('Data bits').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    expect(
        await serial.getByLabel('Data bits').evaluate((el) => {
            const r = el.getBoundingClientRect();
            return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
        }),
    ).toBe(true);
    await capture(page, 'serial-controls-mobile.png');
    await capture(page, 'serial-light-mobile.png', frame);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
        await serial
            .locator('.serial-sun-surface')
            .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
});
test('Automation visual acceptance: four concise stages, back/edit, safe running controls and results', async ({
    page,
}) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await expect(
        flow.getByRole('navigation', { name: 'Automation setup steps' }).getByRole('button'),
    ).toHaveCount(4);
    await expect(flow.getByLabel('Command 1 script')).toBeHidden();
    expect(await flow.innerText()).not.toMatch(/connect .* first/i);
    await capture(page, 'automation-connection.png');
    await flow.getByLabel('Automation transport').selectOption('serial');
    await flow.getByLabel('Serial completion prompt').fill('fixture# ');
    await flow.getByLabel('Serial automation line ending').selectOption('LF');
    await phase(flow, 'Commands');
    await flow.getByLabel('Command 1 name').fill('Display sample');
    await flow.getByLabel('Command 1 script').fill('first line\nsecond line');
    await capture(page, 'automation-commands.png');
    await phase(flow, 'Timing');
    await expect(flow.getByLabel('Command 1 script')).toBeHidden();
    await capture(page, 'automation-timing.png');
    await phase(flow, 'Review');
    await expect(flow.locator('.automation-preview')).toContainText('first line\\nsecond line\\n');
    await capture(page, 'automation-review.png');
    await flow.getByRole('button', { name: 'Back', exact: true }).click();
    await phase(flow, 'Commands');
    await expect(flow.getByLabel('Command 1 script')).toHaveValue('first line\nsecond line');
    await phase(flow, 'Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => window.serialTest.writes.length))
        .toBeGreaterThan(0);
    await phase(flow, 'Commands');
    await expect(flow.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible();
    await flow.getByLabel('Command 1 script').fill('next draft');
    await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
    await expect(flow.getByRole('status')).toContainText('cancel');
    await flow.getByRole('button', { name: /Results ·/ }).click();
    await expect(flow.getByRole('heading', { name: 'Results', exact: true })).toBeFocused();
    await page.setViewportSize({ width: 412, height: 915 });
    await phase(flow, 'Commands');
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    await expect(page.locator('.page-scroll-controls')).toBeHidden();
    await flow
        .getByRole('button', { name: 'Next: Timing', exact: true })
        .evaluate((el) => el.scrollIntoView({ block: 'center' }));
    expect(
        await flow.getByRole('button', { name: 'Next: Timing', exact: true }).evaluate((el) => {
            const r = el.getBoundingClientRect();
            return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
        }),
    ).toBe(true);
    await capture(page, 'automation-guide-mobile.png');
});
