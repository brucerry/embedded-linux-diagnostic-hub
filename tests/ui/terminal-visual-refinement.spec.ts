import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { installDesktop } from './fixtures/desktop';
import { installSerial } from './fixtures/serial';

async function captureFrame(page: Page, frame: Locator, path: string) {
    await frame.evaluate((el) => {
        const top = el.getBoundingClientRect().top + window.scrollY,
            header = document.querySelector('header')?.getBoundingClientRect().height ?? 0;
        window.scrollTo({ top: Math.max(0, top - header - 16), behavior: 'instant' });
    });
    const clip = (await frame.boundingBox())!;
    expect(clip.y).toBeGreaterThanOrEqual(
        await page.locator('header').evaluate((el) => el.getBoundingClientRect().bottom),
    );
    expect(clip.y + clip.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.screenshot({ path, clip });
}

test('Serial and SSH visual audit, fitted viewport and inert scenery at wide and narrow sizes', async ({
    page,
}, info) => {
    await installDesktop(page);
    await installSerial(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await expect(serial.locator('.serial-clouds path')).toHaveCount(3);
    await expect(serial.locator('.serial-foreground-palm')).toHaveCount(1);
    await expect(serial.locator('.serial-foreground-palm')).toHaveAttribute(
        'transform',
        /^translate\(570 /,
    );
    await expect(serial.locator('.serial-coconut')).toHaveCount(3);
    await expect(serial.locator('.serial-distant-island')).toHaveCount(2);
    await expect(serial.locator('.serial-crab')).toHaveCount(2);
    await expect(
        serial.locator('.serial-bird,.terminal-earth,.serial-volley-pig > path'),
    ).toHaveCount(0);
    await expect(serial.locator('.serial-sun-flame')).toHaveCount(8);
    await expect(serial.locator('.serial-volley-duck rect[fill="#e5bf75"]')).toHaveCount(0);
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.evaluate(() =>
        window.serialTest.push([
            ...new TextEncoder().encode(
                '\x1b[2J\x1b[HPlain serial output 日本語\r\n' +
                    Array.from({ length: 30 }, (_, i) => {
                        const color = i % 16;
                        return `\x1b[${color < 8 ? 30 + color : 90 + color - 8}mANSI ${i} device@board:~# \x1b[0m\r\n`;
                    }).join('') +
                    'device@board:~# ',
            ),
        ]),
    );
    await expect(serial.locator('.terminal-screen')).toContainText('Plain serial output');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Hostname or IP address').fill('visual-fixture');
    await modal.getByLabel('SSH username').fill('fixture');
    await modal.getByLabel('Password', { exact: true }).fill('synthetic');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.locator('.toast')).not.toBeVisible({ timeout: 15000 });
    const metrics = [];
    await mkdir('evidence/visual', { recursive: true });
    for (const [width, height] of [
        [1440, 1050],
        [412, 915],
    ]) {
        await page.setViewportSize({ width, height });
        for (const tab of ['Serial', 'Terminal']) {
            await page.getByRole('button', { name: tab, exact: true }).click();
            const panel =
                    tab === 'Serial'
                        ? serial
                        : page.getByRole('region', { name: 'Connected device terminal' }),
                frame = panel.locator('.terminal-frame');
            if (tab === 'Terminal') {
                await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
                await page.evaluate(() =>
                    window.desktopTest.terminal!.emit(
                        'SSH output remains separate\r\nfixture@host:~# ',
                    ),
                );
            }
            await frame.evaluate((el) => el.scrollIntoView({ block: 'center' }));
            await expect
                .poll(() =>
                    panel
                        .locator('.xterm-screen')
                        .evaluate((el) => el.getBoundingClientRect().width),
                )
                .toBeGreaterThan(100);
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
            await page.screenshot({
                path: `evidence/visual/${info.project.name}-${tab}-${width}-page.png`,
                fullPage: true,
            });
            await captureFrame(
                page,
                frame,
                `evidence/visual/${info.project.name}-${tab}-${width}-frame.png`,
            );
            if (tab === 'Serial' && width === 1440) {
                const box = await panel.locator('.xterm-screen').boundingBox();
                await page.getByLabel('Serial terminal input').focus();
                await page.mouse.move(box!.x + 1, box!.y + 7);
                await page.mouse.down();
                await page.mouse.move(box!.x + 185, box!.y + 7, { steps: 12 });
                await page.mouse.up();
                await frame.screenshot({
                    path: `evidence/visual/${info.project.name}-selection-active.png`,
                });
                await serial.getByRole('button', { name: 'Clear terminal', exact: true }).focus();
                await frame.screenshot({
                    path: `evidence/visual/${info.project.name}-selection-inactive.png`,
                });
            }
            const value = await frame.evaluate((el) => {
                const box = (s: string) => {
                    const n = el.querySelector(s);
                    if (!n) return null;
                    const b = n.getBoundingClientRect(),
                        f = el.getBoundingClientRect();
                    return { x: b.x - f.x, y: b.y - f.y, width: b.width, height: b.height };
                };
                return {
                    frame: { width: el.clientWidth, height: el.clientHeight },
                    screen: box('.xterm-screen'),
                    earth: box('.terminal-earth'),
                    landscape: box('.terminal-landscape'),
                    pointer: getComputedStyle(
                        el.querySelector('.serial-beach,.terminal-playground')!,
                    ).pointerEvents,
                };
            });
            expect(value.pointer).toBe('none');
            expect(value.screen!.height).toBeLessThanOrEqual(value.frame.height);
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            metrics.push({ tab, width, ...value });
        }
    }
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    await serial
        .locator('.serial-volley-duck')
        .screenshot({ path: `evidence/visual/${info.project.name}-duck.png` });
    await serial
        .locator('.serial-volley-pig')
        .screenshot({ path: `evidence/visual/${info.project.name}-pig.png` });
    const theme = await page.evaluate(async () => {
        const modulePath = '/src/features/serial/theme.ts';
        return (await import(modulePath)).serialTerminalOptions();
    });
    for (const width of [1440, 412]) {
        const s = metrics.find((m) => m.width === width && m.tab === 'Serial')!,
            t = metrics.find((m) => m.width === width && m.tab === 'Terminal')!;
        expect(t.frame).toEqual(s.frame);
        expect(t.screen).toEqual(s.screen);
        expect(t.earth!.y).toBeCloseTo(57, 3);
        expect(t.earth!.width).toBe(width === 1440 ? 76 : 48);
    }
    const renderedContrast = await page.evaluate(async (theme) => {
        const svg = document.querySelector('.serial-landscape')!.cloneNode(true) as SVGSVGElement;
        svg.setAttribute('width', '640');
        svg.setAttribute('height', '1200');
        const source = new XMLSerializer().serializeToString(svg),
            url = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(new Blob([source], { type: 'image/svg+xml' }));
            });
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 1200;
        const lum = (rgb: number[]) =>
            rgb
                .map((v) => v / 255)
                .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
                .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
        const parse = (s: string) =>
                s
                    .slice(1, 7)
                    .match(/../g)!
                    .map((v) => parseInt(v, 16)),
            ratio = (a: number[], b: number[]) =>
                (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(image, 0, 0, 640, 1200);
            const data = ctx.getImageData(0, 0, 640, 1200).data;
            let darkest = [255, 255, 255];
            for (let i = 0; i < data.length; i += 4)
                if (data[i + 3] === 255) {
                    const rgb = [data[i], data[i + 1], data[i + 2]];
                    if (lum(rgb) < lum(darkest)) darkest = rgb;
                }
            const keys = [
                'foreground',
                'black',
                'red',
                'green',
                'yellow',
                'blue',
                'magenta',
                'cyan',
                'white',
                'brightBlack',
                'brightRed',
                'brightGreen',
                'brightYellow',
                'brightBlue',
                'brightMagenta',
                'brightCyan',
                'brightWhite',
            ];
            const ink = Object.fromEntries(
                keys.map((key) => [key, ratio(parse(theme[key]), darkest)]),
            );
            return {
                darkest,
                ink,
                cursor: ratio(parse(theme.cursor), darkest),
                cursorAccent: ratio(parse(theme.cursor), parse(theme.cursorAccent)),
                activeSelection: ratio(
                    parse(theme.selectionForeground),
                    parse(theme.selectionBackground),
                ),
                inactiveSelection: ratio(
                    parse(theme.selectionForeground),
                    parse(theme.selectionInactiveBackground),
                ),
                focus: ratio([40, 103, 129], [213, 233, 238]),
            };
        } finally {
            canvas.width = canvas.height = 1;
        }
    }, theme.theme);
    for (const ratio of Object.values(renderedContrast.ink))
        expect(ratio).toBeGreaterThanOrEqual(4.5);
    for (const ratio of [
        renderedContrast.activeSelection,
        renderedContrast.inactiveSelection,
        renderedContrast.cursorAccent,
    ])
        expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(renderedContrast.cursor).toBeGreaterThanOrEqual(3);
    expect(renderedContrast.focus).toBeGreaterThanOrEqual(3);
    const receipt = {
        renderedContrast,
        metrics,
        theme,
        serialWrites: await page.evaluate(() => window.serialTest.writes),
        sshInputs: await page.evaluate(() => window.desktopTest.terminal!.inputs),
    };
    await writeFile(
        `evidence/visual/${info.project.name}-metrics.json`,
        JSON.stringify(receipt, null, 2),
    );
    await info.attach('visual-metrics', {
        body: JSON.stringify(receipt),
        contentType: 'application/json',
    });
});

test('scene motion pauses on navigation and becomes stationary with reduced motion; Serial input stays exact', async ({
    page,
}, info) => {
    await installDesktop(page);
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    const input = page.getByLabel('Serial terminal input');
    await input.focus();
    await page.keyboard.type('VISUAL_INPUT');
    await page.keyboard.press('ArrowUp');
    await expect
        .poll(() =>
            page.evaluate(() =>
                new TextDecoder().decode(new Uint8Array(window.serialTest.writes.flat())),
            ),
        )
        .toBe('VISUAL_INPUT\x1b[A');
    const flame = page.locator('.serial-sun-flame').first();
    const first = await flame.evaluate((el) => el.getAnimations()[0].currentTime as number);
    await expect
        .poll(() => flame.evaluate((el) => el.getAnimations()[0].currentTime as number))
        .toBeGreaterThan(first);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    expect(await flame.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
    const star = page.locator('.terminal-star').first(),
        earth = page.locator('.terminal-earth-continents');
    await expect(star).toHaveCount(1);
    const starTime = await star.evaluate((el) => el.getAnimations()[0].currentTime as number);
    await expect
        .poll(() => star.evaluate((el) => el.getAnimations()[0].currentTime as number))
        .toBeGreaterThan(starTime);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    expect(await star.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const locator of [
        flame,
        star,
        earth,
        page.locator('.terminal-duck'),
        page.locator('.terminal-pig'),
    ])
        expect(await locator.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    await input.focus();
    await page.keyboard.type('B');
    await expect
        .poll(() =>
            page.evaluate(() =>
                new TextDecoder().decode(new Uint8Array(window.serialTest.writes.flat())),
            ),
        )
        .toBe('VISUAL_INPUT\x1b[AB');
    await input.press('Control+Shift+Escape');
    await expect(serial.getByRole('button', { name: 'Clear terminal', exact: true })).toBeFocused();
    await info.attach('motion-input-proof', {
        body: JSON.stringify({
            normalFlameAndStarProgress: true,
            hiddenPaused: true,
            reducedMotionStationary: true,
            exactSerialInput: 'VISUAL_INPUT\\x1b[AB',
        }),
        contentType: 'application/json',
    });
});
