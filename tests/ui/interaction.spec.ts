import { expect, test, type Page } from '@playwright/test';
import { demoSnapshot } from '../fixtures/snapshots';

async function connectFixture(page: Page) {
    const clockTime = new Date('2026-10-06T00:00:00Z');
    // Leave a margin for real time spent between installing and pausing the clock.
    await page.clock.install({ time: new Date(clockTime.getTime() - 3_600_000) });
    await page.clock.pauseAt(clockTime);
    const fixture = { ...demoSnapshot(), mode: 'ssh' as const };
    fixture.results.find((r) => r.id === 'memory')!.stderr = 'diagnostic note: test stderr\n';
    await page.addInitScript((data) => {
        const state = {
            collections: 0,
            disconnects: 0,
            copied: [] as string[],
            hold: false,
            complete: () => {},
        };
        (window as unknown as { interaction: typeof state }).interaction = state;
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
            disconnect: async () => {
                state.disconnects++;
            },
            pickKey: async () => null,
            openRepository: async () => {},
            openReleases: async () => {},
            copyText: async (text) => {
                state.copied.push(text);
            },
            exportReport: async () => true,
            onDisconnected: () => () => {},
            collect: async () => {
                state.collections++;
                const snapshot = structuredClone(data);
                snapshot.capturedAt = new Date(Date.now()).toISOString();
                snapshot.results.forEach((r) => {
                    r.collectedAt = snapshot.capturedAt;
                });
                if (state.hold)
                    await new Promise<void>((resolve) => {
                        state.complete = resolve;
                    });
                return snapshot;
            },
        };
    }, fixture);
    await page.goto('/');
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    return fixture;
}

test('connection button reflects plug state and blocks disconnect/manual collection during live collection', async ({
    page,
}) => {
    await connectFixture(page);
    const connection = page.locator('.connection-button');
    await expect(connection).toHaveText('Disconnect device');
    await expect(connection.locator('.lucide-plug')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Connect device', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh snapshot' })).toBeDisabled();
    await page.getByRole('button', { name: 'Diagnostics 36' }).click();
    await expect(page.getByRole('button', { name: 'Collect snapshot' })).toBeDisabled();
    await page.evaluate(() => {
        (window as any).interaction.hold = true;
    });
    await page.clock.runFor(5100);
    await expect(connection).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Collecting…' })).toBeDisabled();
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await expect(connection).toBeDisabled();
    expect(await page.evaluate(() => (window as any).interaction.disconnects)).toBe(0);
    await page.evaluate(() => {
        (window as any).interaction.hold = false;
        (window as any).interaction.complete();
    });
    await expect(page.getByRole('button', { name: 'Collect snapshot' })).toBeEnabled();
    await expect(connection).toBeEnabled();
    const collectionsBeforeManual = await page.evaluate(
        () => (window as any).interaction.collections,
    );
    await page.getByRole('button', { name: 'Collect snapshot' }).click();
    expect(await page.evaluate(() => (window as any).interaction.collections)).toBe(
        collectionsBeforeManual + 1,
    );
    await connection.click();
    await expect(connection).toHaveText('Connect device');
    await expect(connection.locator('.lucide-unplug')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).interaction.disconnects)).toBe(1);
    await expect(page.getByRole('button', { name: 'Collect snapshot' })).toBeDisabled();
});

test('snippet icon copies exact command/stdout/stderr and dialog locks background scroll', async ({
    page,
}) => {
    const fixture = await connectFixture(page);
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page
        .locator('.probe-card')
        .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
        .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Copy command' })).not.toBeVisible();
    await dialog.getByText('Collection command', { exact: true }).click();
    for (const [label, tab] of [
        ['Copy command', null],
        ['Copy standard output', 'Standard output'],
        ['Copy standard error', 'Standard error'],
    ] as const) {
        if (tab) await dialog.getByRole('tab', { name: tab }).click();
        const button = dialog.getByRole('button', { name: label, exact: true });
        await expect(button).toHaveText('');
        expect(await button.evaluate((el) => !!el.closest('.snippet'))).toBe(true);
        await button.click();
        const feedback = button.locator('..').getByRole('status');
        await expect(feedback).toHaveText('Copied!');
        expect(await feedback.evaluate((el) => getComputedStyle(el).animationDuration)).toBe('1s');
        expect(await feedback.evaluate((el) => getComputedStyle(el).color)).toBe(
            'rgb(143, 225, 184)',
        );
        await page.clock.runFor(1100);
        await expect(feedback).toHaveCount(0);
    }
    const memory = fixture.results.find((r) => r.id === 'memory')!;
    expect(await page.evaluate(() => (window as any).interaction.copied)).toEqual([
        memory.command,
        memory.stdout,
        memory.stderr,
    ]);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.move(8, 8);
    await page.mouse.wheel(0, 500);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    await expect(page.getByRole('button', { name: 'Import report', exact: true })).toBeVisible();
    await expect(
        page
            .getByRole('button', { name: 'Import report', exact: true })
            .locator('.lucide-file-input'),
    ).toHaveCount(1);
    await expect(
        page
            .getByRole('button', { name: 'Export report', exact: true })
            .locator('.lucide-file-output'),
    ).toHaveCount(1);
});

test('live graph and evidence updates preserve focus and every scroll position', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1000, height: 650 });
    await connectFixture(page);
    await page.evaluate(() => window.scrollTo(0, 450));
    const mainY = await page.evaluate(() => window.scrollY);
    await page.clock.runFor(5100);
    expect(await page.evaluate(() => window.scrollY)).toBe(mainY);
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page
        .locator('.probe-card')
        .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
        .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Collection command', { exact: true }).click();
    await dialog.getByRole('tab', { name: 'Graph view' }).click();
    await dialog.locator('.graph-viewport').evaluate((el) => {
        el.scrollLeft = 80;
    });
    await dialog.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
    });
    const position = () =>
        page.evaluate(() => ({
            main: window.scrollY,
            modal: document.querySelector('.modal')!.scrollTop,
            graph: document.querySelector('.graph-viewport')!.scrollLeft,
            focus: document.activeElement?.id,
        }));
    const before = await position();
    const samples = await dialog.locator('.live-graph circle').count();
    await page.clock.runFor(5100);
    await expect.poll(() => dialog.locator('.live-graph circle').count()).toBeGreaterThan(samples);
    expect(await position()).toEqual(before);
    await dialog.getByRole('tab', { name: 'Standard output' }).click();
    await dialog.locator('.evidence-output').focus();
    await dialog.locator('.evidence-output').evaluate((el) => {
        el.scrollTop = 40;
    });
    const outputTop = await dialog.locator('.evidence-output').evaluate((el) => el.scrollTop);
    const modalTop = await dialog.evaluate((el) => el.scrollTop);
    await page.clock.runFor(5100);
    expect(await dialog.locator('.evidence-output').evaluate((el) => el.scrollTop)).toBe(outputTop);
    expect(await dialog.evaluate((el) => el.scrollTop)).toBe(modalTop);
    expect(
        await dialog.locator('.evidence-output').evaluate((el) => document.activeElement === el),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
});

test('soft dark layout stays readable and animated on desktop/mobile under system reduced motion', async ({
    page,
}) => {
    await connectFixture(page);
    await page.screenshot({
        path: 'validation/2026-10-06/interactions/desktop-overview.png',
        fullPage: true,
    });
    expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarWidth),
    ).toBe('thin');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page
        .locator('.probe-card')
        .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
        .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Graph view' }).click();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(await dialog.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe('thin');
    await page.screenshot({ path: 'validation/2026-10-06/interactions/mobile-graph.png' });
    await dialog.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
    });
    const mobileScroll = await dialog.evaluate((el) => el.scrollTop);
    await page.clock.runFor(5100);
    expect(await dialog.evaluate((el) => el.scrollTop)).toBe(mobileScroll);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
        await page.locator('#evidence-panel').evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('evidence-enter');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.screenshot({
        path: 'validation/2026-10-06/interactions/mobile-overview.png',
        fullPage: true,
    });
});
