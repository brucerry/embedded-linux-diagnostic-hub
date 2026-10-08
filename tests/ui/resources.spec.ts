import { expect, test } from '@playwright/test';
import { demoSnapshot } from '../fixtures/snapshots';

const fixture = demoSnapshot('openwrt');

async function connectFixture(page: import('@playwright/test').Page) {
    const time = new Date('2026-10-06T00:00:00Z');
    // Leave a margin for real time spent between installing and pausing the clock.
    await page.clock.install({ time: new Date(time.getTime() - 3_600_000) });
    await page.clock.pauseAt(time);
    await page.addInitScript((data) => {
        let count = 0;
        const resources = (count: number) =>
            `HUB_PROCESS_RESOURCES_V1\nSystemCPU: ${1000 + count * 100}\nMemTotal: 102400 kB\nPID: 42\nName: sample-daemon\nState: S (sleeping)\nUid: 0 0 0 0\nVmRSS: 10240 kB\nVmSize: 20480 kB\nVmSwap: 2048 kB\nThreads: 2\n42 (sample-daemon) ${Array.from({ length: 22 }, (_, i) => (i === 0 ? 'S' : i === 1 ? 1 : i === 11 ? count * 10 : i === 19 ? 200 : 0)).join(' ')}\n`;
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
            openRepository: async () => {},
            openReleases: async () => {},
            copyText: async () => {},
            exportReport: async () => true,
            onDisconnected: () => () => {},
            collect: async () => {
                const snapshot = structuredClone(data);
                snapshot.mode = 'ssh';
                snapshot.capturedAt = new Date().toISOString();
                snapshot.results.find((r) => r.id === 'processes')!.stdout = resources(++count);
                return snapshot;
            },
        };
    }, fixture);
    await page.goto('/');
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
}

test('details reopen on Standard output and live memory/filesystem/flash graphs plot used and free together', async ({
    page,
}) => {
    await connectFixture(page);
    await page.getByRole('button', { name: 'Diagnostics 36' }).click();
    for (const title of ['Memory overview', 'Mounted filesystems', 'NAND / NOR flash']) {
        const card = page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
        await card.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('tab', { name: 'Standard output' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await dialog.getByRole('tab', { name: 'Graph view' }).click();
        await expect(dialog.locator('g[data-series="used"]')).toHaveCount(1);
        await expect(dialog.locator('g[data-series="free"]')).toHaveCount(1);
        await expect(dialog.locator('.graph-summary')).toContainText('Used');
        await expect(dialog.locator('.graph-summary')).toContainText('Free');
        const before = await dialog.locator('.live-graph circle').count();
        await page.clock.runFor(5100);
        await expect
            .poll(() => dialog.locator('.live-graph circle').count())
            .toBeGreaterThan(before);
        await page.keyboard.press('Escape');
        await card.click();
        await expect(dialog.getByRole('tab', { name: 'Standard output' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await page.keyboard.press('Escape');
    }
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page
        .locator('.probe-card')
        .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
        .click();
    await page.getByRole('tab', { name: 'Graph view' }).click();
    await expect(page.getByRole('dialog').locator('.live-graph circle').first()).toBeVisible();
});

test('process table shows real resource fields and computes CPU only after a second sample', async ({
    page,
}) => {
    await connectFixture(page);
    await page.getByRole('button', { name: 'Processes', exact: true }).click();
    await page.locator('.probe-card').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Table view' }).click();
    await expect(dialog.locator('thead')).toContainText('Resident MiB');
    await expect(dialog.locator('thead')).toContainText('CPU % (system)');
    const row = dialog.locator('tbody tr').first();
    expect(
        await row
            .locator('td')
            .nth(1)
            .evaluate((el) => getComputedStyle(el).whiteSpace),
    ).toBe('nowrap');
    await expect(row.locator('td').nth(4)).toHaveText('10.00');
    await expect(row.locator('td').nth(5)).toHaveText('20.00');
    await expect(row.locator('td').last()).toHaveText('');
    await page.clock.runFor(5100);
    await expect(row.locator('td').last()).toHaveText('10.00');
    await expect(dialog.getByRole('tab', { name: 'Table view' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await page.clock.runFor(1000);
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Processes', exact: true }).click();
    await page.locator('.probe-card').click();
    await dialog.getByRole('tab', { name: 'Table view' }).click();
    // Retained samples must not become a CPU baseline for a new SSH connection.
    await expect(row.locator('td').last()).toHaveText('');
    await dialog.getByRole('tab', { name: 'Graph view' }).click();
    await expect(dialog.locator('.live-graph circle')).toHaveCount(3);
    await expect(dialog.getByLabel('Graph reading').locator('option[value$=":cpu"]')).toHaveCount(
        0,
    );
    await page.clock.runFor(5100);
    await expect(dialog.getByLabel('Graph reading').locator('option[value$=":cpu"]')).toHaveCount(
        1,
    );
    await dialog.getByLabel('Graph reading').selectOption('process:42:200:cpu');
    await expect(dialog.locator('.graph-summary')).toContainText('10 %');
});

test('ranked search supports exact names, aliases and typos while sticky header and page buttons remain accessible', async ({
    page,
}) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Diagnostics 36' }).click();
    const search = page.getByRole('textbox', { name: 'Search diagnostics' });
    await search.fill('memory');
    await expect(page.locator('.probe-card').first().getByRole('heading')).toHaveText(
        'Memory overview',
    );
    const ranks = await page
        .locator('.probe-card')
        .evaluateAll((cards) => cards.map((c) => Number(c.getAttribute('data-match-rank'))));
    expect(ranks).toEqual([...ranks].sort());
    await search.fill('ram');
    await expect(
        page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) }),
    ).toContainText('Related match');
    await search.fill('memroy');
    await expect(page.locator('.probe-card').first()).toContainText('Very less match');
    await search.fill('');
    const top = page.getByRole('button', { name: 'Scroll to top', exact: true }),
        bottom = page.getByRole('button', { name: 'Scroll to bottom', exact: true });
    expect((await top.boundingBox())!.y).toBeLessThan((await bottom.boundingBox())!.y);
    await bottom.click();
    await expect
        .poll(() =>
            page.evaluate(() =>
                Math.abs(
                    window.scrollY + window.innerHeight - document.documentElement.scrollHeight,
                ),
            ),
        )
        .toBeLessThan(2);
    expect((await page.locator('.site-header').boundingBox())!.y).toBe(0);
    await top.click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    const icon = page.locator('link[rel="icon"]');
    const href = await icon.getAttribute('href');
    expect(href).toContain('app-icon.svg');
    expect(
        await page.locator('.brand-mark img').evaluate((img) => (img as HTMLImageElement).src),
    ).toBe(await icon.evaluate((link) => (link as HTMLLinkElement).href));
    const response = await page.request.get(href!);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/svg+xml');
    await page.setViewportSize({ width: 390, height: 844 });
    await bottom.click();
    expect((await page.locator('.site-header').boundingBox())!.y).toBe(0);
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
});

test('process graphs expose memory then CPU, highlight hovered samples and scroll dense history without moving the view', async ({
    page,
}) => {
    await connectFixture(page);
    await page.getByRole('button', { name: 'Processes', exact: true }).click();
    await page.locator('.probe-card').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Graph view' }).click();
    const reading = dialog.getByRole('combobox', { name: 'Graph reading' });
    await expect(reading).toHaveValue('process:42:200:rss');
    await expect(dialog.locator('.graph-summary')).toContainText('10 MiB');
    await page.clock.runFor(5100);
    await reading.selectOption('process:42:200:cpu');
    await expect(dialog.locator('.graph-summary')).toContainText('10 %');
    await reading.selectOption('process:42:200:rss');
    const svg = dialog.locator('.graph-viewport svg');
    await svg.focus();
    await page.keyboard.press('Home');
    await expect(dialog.locator('.graph-hover-values')).toContainText(
        'sample-daemon (PID 42) · Resident memory: 10 MiB',
    );
    await expect(dialog.locator('.graph-point.active')).toHaveCount(1);
    await expect(dialog.locator('.graph-crosshair')).toHaveCount(1);
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + 710, box.y + 260);
    await expect(dialog.locator('.graph-hover-values time')).toBeVisible();
    for (let i = 0; i < 35; i++) {
        const count = await svg.locator('circle').count();
        await page.clock.runFor(5100);
        // Worker preparation runs independently of the mocked page clock.
        await expect.poll(() => svg.locator('circle').count()).toBeGreaterThan(count);
    }
    const viewport = dialog.locator('.graph-viewport');
    expect(await viewport.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await viewport.evaluate((el) => {
        el.scrollLeft = 180;
    });
    await dialog.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
    });
    const positions = () =>
        page.evaluate(() => ({
            main: window.scrollY,
            dialog: document.querySelector('.modal')!.scrollTop,
            graph: document.querySelector('.graph-viewport')!.scrollLeft,
        }));
    const before = await positions();
    const count = await svg.locator('circle').count();
    await page.clock.runFor(5100);
    await expect.poll(() => svg.locator('circle').count()).toBeGreaterThan(count);
    expect(await positions()).toEqual(before);
});

test('paired graph hover reports both values at the same timestamp', async ({ page }) => {
    await connectFixture(page);
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page
        .locator('.probe-card')
        .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
        .click();
    await page.getByRole('tab', { name: 'Graph view' }).click();
    await page.locator('.graph-viewport svg').focus();
    await page.keyboard.press('End');
    await expect(page.locator('.graph-point.active')).toHaveCount(2);
    await expect(page.locator('.graph-hover-values')).toContainText('Used:');
    await expect(page.locator('.graph-hover-values')).toContainText('Free:');
});

test('fixed computer and chip transfer bits smoothly from the chip and finish in-flight trips after collection', async ({
    page,
}) => {
    await connectFixture(page);
    const art = page.locator('.bits-art');
    await expect(art).toHaveAttribute('data-transfer', 'idle');
    const box = (await art.boundingBox())!;
    await page.evaluate(() => {
        const previous = window.diagnosticHub!.collect;
        (window as any).finishCollection = () => {};
        window.diagnosticHub!.collect = async () => {
            const snapshot = await previous();
            await new Promise<void>((resolve) => {
                (window as any).finishCollection = resolve;
            });
            return snapshot;
        };
    });
    await page.clock.runFor(5100);
    await expect(art).toHaveAttribute('data-transfer', 'active');
    expect((await art.boundingBox())!.x).toBe(box.x);
    expect((await art.boundingBox())!.y).toBe(box.y);
    expect((await art.boundingBox())!.width).toBe(box.width);
    await expect(art.locator('.transfer-computer')).toBeVisible();
    await expect(art.locator('.transfer-chip')).toBeVisible();
    await expect(art.locator('.transfer-bit')).toHaveCount(6);
    const timing = await art.locator('.transfer-bit').evaluateAll((bits) =>
        bits.map((bit) => ({
            duration: getComputedStyle(bit).animationDuration,
            delay: getComputedStyle(bit).animationDelay,
        })),
    );
    expect(new Set(timing.map((t) => t.duration)).size).toBeGreaterThan(1);
    expect(new Set(timing.map((t) => t.delay)).size).toBeGreaterThan(1);
    expect(timing.every((t) => parseFloat(t.delay) >= 0)).toBe(true);
    const journeys = await art.locator('.transfer-bit').evaluateAll((bits) =>
        bits.map((bit) => {
            const animation = bit.getAnimations()[0];
            animation.pause();
            const { duration, delay } = animation.effect!.getTiming();
            const sample = (time: number) => {
                animation.currentTime = time;
                return new DOMMatrixReadOnly(getComputedStyle(bit).transform).m41;
            };
            const initial = sample(0);
            const positions = [0, 0.25, 0.5, 0.75, 0.99].map((progress) =>
                sample(Number(delay) + Number(duration) * progress),
            );
            const restart = sample(Number(delay) + Number(duration));
            animation.play();
            return { initial, positions, restart, arrival: Number(delay) + Number(duration) };
        }),
    );
    for (const journey of journeys) {
        expect(journey.initial).toBeCloseTo(0, 2);
        journey.positions.forEach((position, i) =>
            expect(position).toBeCloseTo(-231 * [0, 0.25, 0.5, 0.75, 0.99][i], 1),
        );
        expect(journey.restart).toBeCloseTo(0, 2);
    }
    expect(Math.min(...journeys.map((journey) => journey.arrival))).toBeLessThanOrEqual(300);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
        await art
            .locator('.transfer-bit')
            .first()
            .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('chip-bits-transfer');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.screenshot({ path: 'validation/2026-10-06/transfer-artwork/collecting.png' });
    // Hold launched bits halfway through their trips and leave the last bit unlaunched.
    const beforeDrain = await art.locator('.transfer-bit').evaluateAll((bits) =>
        bits.map((bit, i) => {
            const animation = bit.getAnimations()[0];
            animation.pause();
            const timing = animation.effect!.getTiming();
            animation.currentTime =
                i === bits.length - 1
                    ? 0
                    : Number(timing.delay ?? 0) + Number(timing.duration) * 0.5;
            return new DOMMatrixReadOnly(getComputedStyle(bit).transform).m41;
        }),
    );
    await page.evaluate(() => (window as any).finishCollection());
    await expect(art).toHaveAttribute('data-transfer', 'draining');
    const draining = await art.locator('.transfer-bit').evaluateAll((bits) =>
        bits.map((bit) => ({
            position: new DOMMatrixReadOnly(getComputedStyle(bit).transform).m41,
            iterations: bit.getAnimations()[0]?.effect!.getTiming().iterations ?? 0,
        })),
    );
    draining.forEach((bit, i) => {
        expect(bit.position).toBeCloseTo(beforeDrain[i], 2);
        expect(bit.iterations).toBe(i === 5 ? 0 : 1);
    });
    const arrivals = await art.locator('.transfer-bit').evaluateAll((bits) =>
        bits.slice(0, -1).map((bit) => {
            const animation = bit.getAnimations()[0],
                timing = animation.effect!.getTiming();
            animation.currentTime = Number(timing.delay ?? 0) + Number(timing.duration) * 0.99;
            const position = new DOMMatrixReadOnly(getComputedStyle(bit).transform).m41;
            animation.finish();
            return position;
        }),
    );
    arrivals.forEach((position) => expect(position).toBeCloseTo(-231 * 0.99, 1));
    await expect(art).toHaveAttribute('data-transfer', 'idle');
    expect((await art.boundingBox())!.x).toBe(box.x);
    await expect(art.locator('.transfer-bit')).toHaveCount(0);
    await expect(art.locator('.art-caption')).toHaveCount(0);
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await expect(art).toHaveAttribute('data-transfer', 'idle');
    const computer = (await art.locator('.transfer-computer').boundingBox())!,
        chip = (await art.locator('.transfer-chip').boundingBox())!;
    const spacing = await art.evaluate((el) => {
        const computer = el.querySelector('.transfer-computer')!.getBoundingClientRect(),
            chip = el.querySelector('.transfer-chip')!;
        const transformed = chip.getBoundingClientRect();
        const transform = chip.getAttribute('transform')!;
        chip.removeAttribute('transform');
        const original = chip.getBoundingClientRect();
        chip.setAttribute('transform', transform);
        return {
            gap: transformed.left - computer.right,
            originalGap: original.left - computer.right,
            computer: { left: computer.left, right: computer.right },
            chip: { left: transformed.left, originalLeft: original.left },
        };
    });
    expect(computer.x + computer.width).toBeLessThan(chip.x);
    expect(spacing.gap).toBeCloseTo(spacing.originalGap * 4, 0);
    await page.screenshot({
        path: 'validation/2026-10-06/transfer-artwork/idle.png',
        fullPage: true,
    });
    // Start a second collection while a previous journey is still draining.
    await page.getByRole('button', { name: 'Refresh snapshot', exact: true }).click();
    await expect(art).toHaveAttribute('data-transfer', 'active');
    await art.locator('.transfer-bit').evaluateAll((bits) =>
        bits.forEach((bit) => {
            const animation = bit.getAnimations()[0];
            animation.pause();
            const timing = animation.effect!.getTiming();
            animation.currentTime = Number(timing.delay ?? 0) + Number(timing.duration) * 0.5;
        }),
    );
    await page.evaluate(() => (window as any).finishCollection());
    await expect(art).toHaveAttribute('data-transfer', 'draining');
    await page.getByRole('button', { name: 'Refresh snapshot', exact: true }).click();
    await expect(art).toHaveAttribute('data-transfer', 'active');
    const fresh = await art.locator('.transfer-bit').evaluateAll((bits) =>
        bits.map((bit) => {
            const animation = bit.getAnimations()[0];
            animation.pause();
            animation.currentTime = 0;
            return {
                iterations: animation.effect!.getTiming().iterations,
                position: new DOMMatrixReadOnly(getComputedStyle(bit).transform).m41,
            };
        }),
    );
    fresh.forEach((bit) => {
        expect(bit.iterations).toBe(Infinity);
        expect(bit.position).toBe(0);
    });
    await page.evaluate(() => (window as any).finishCollection());
    await expect(art).toHaveAttribute('data-transfer', 'idle');
});

test('device-file controls are absent from the diagnostic workspace', async ({ page }) => {
    await connectFixture(page);
    await expect(page.getByRole('button', { name: 'Device files', exact: true })).toHaveCount(0);
});

test('glass header stays readable over scrolled cards and keeps the page stable', async ({
    page,
}) => {
    await connectFixture(page);
    await page.evaluate(() =>
        window.scrollTo(
            0,
            document.querySelector('.device-hero')!.getBoundingClientRect().top +
                window.scrollY -
                25,
        ),
    );
    const header = page.locator('.site-header');
    expect((await header.boundingBox())!.y).toBe(0);
    const style = await header.evaluate((el) => ({
        background: getComputedStyle(el).backgroundColor,
        blur: getComputedStyle(el).backdropFilter,
        opacity: getComputedStyle(el).opacity,
    }));
    const background = style.background.match(/[\d.]+/g)!.map(Number),
        alpha = background[3];
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
    expect(style.blur).not.toBe('none');
    expect(style.opacity).toBe('1');
    const luminance = (rgb: number[]) =>
        rgb
            .map((v) => {
                const s = v / 255;
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    // Check readable controls even against a bright backdrop through the glass.
    const composite = luminance(background.slice(0, 3).map((v) => v * alpha + 255 * (1 - alpha)));
    for (const element of await header
        .locator('.brand, .nav-item, .edition-label, .version-label')
        .all()) {
        const rgb = (await element.evaluate((el) => getComputedStyle(el).color))
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
        expect((luminance(rgb) + 0.05) / (composite + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
    await expect(header.getByRole('button', { name: 'Diagnostic Hub home' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();
    await page.screenshot({ path: 'validation/2026-10-06/transfer-artwork/scrolled-header.png' });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    expect(await header.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        'rgb(29, 36, 45)',
    );
    expect(await header.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await header.boundingBox())!.y).toBe(0);
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
});
