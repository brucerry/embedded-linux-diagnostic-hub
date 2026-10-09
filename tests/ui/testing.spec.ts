import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { sampleProfile } from '../../shared/testing/simulation';

const nav = (page: Page, name: string) =>
    page.locator('.primary-nav').getByRole('button', { name, exact: true });
async function sample(page: Page) {
    await page.goto('/');
    await nav(page, 'Tests').click();
    await page.getByRole('switch', { name: 'Simulation mode' }).click();
    await expect(page.getByText('SIMULATED BOARD', { exact: true })).toBeVisible();
}
async function connectTesting(page: Page, options: { incomplete?: boolean; lost?: boolean } = {}) {
    await installDesktop(page);
    await page.goto('/');
    await page.evaluate(async ({ incomplete, lost }) => {
        const url = '/shared/testing/simulation.ts',
            module = await import(/* @vite-ignore */ url),
            target = module.createSimulation({ delayMs: 1 });
        if (incomplete) {
            const discover = target.discoverTests;
            target.discoverTests = async () => ({
                ...(await discover()),
                complete: false,
                issues: ['Discovery fixture incomplete.'],
            });
        }
        if (lost) {
            const start = target.startTests;
            target.startTests = async (request: unknown) => {
                await start(request);
                while (
                    ['running', 'preparing', 'cleaning'].includes(
                        (await target.readTestRun())?.phase,
                    )
                )
                    await new Promise((r) => setTimeout(r, 5));
                throw Error('Direct start response was lost.');
            };
        }
        Object.assign(window.diagnosticHub!, target);
    }, options);
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Hostname or IP address').fill('testing-device');
    await modal.getByLabel('SSH username').fill('engineer');
    await modal.getByLabel('Password', { exact: true }).fill('fixture');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
    await nav(page, 'Tests').click();
}
async function prepare(page: Page) {
    await page.getByRole('button', { name: 'Validate & prepare tests' }).click();
    await page.getByRole('checkbox', { name: /I reviewed the mappings/ }).check();
}

test('simulation switch keeps JSON and input mode private across repeated toggles', async ({
    page,
}) => {
    await sample(page);
    const toggle = page.getByRole('switch', { name: 'Simulation mode' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const json = page.getByLabel('Run request JSON', { exact: true });
    await expect(json).not.toHaveValue('');
    await json.fill('{"simulation-only":');
    await expect(page.getByRole('button', { name: 'Run JSON', exact: true })).toBeDisabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('button', { name: 'Setup', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(
        page.getByText('Simulated board only. No hardware commands will be sent.'),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    await expect(json).toHaveValue('');
    await json.fill('{"connected-only":');
    for (let i = 0; i < 2; i++) {
        await toggle.click();
        await expect(json).toHaveValue('{"simulation-only":');
        await expect(page.getByRole('button', { name: 'Run JSON', exact: true })).toBeDisabled();
        await toggle.click();
        await expect(json).toHaveValue('{"connected-only":');
    }
    await toggle.focus();
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

test('connected and simulated profiles, editor, readiness, selection and results stay independent', async ({
    page,
}) => {
    await connectTesting(page);
    await page.getByRole('button', { name: 'Discover board' }).click();
    const live = sampleProfile();
    live.name = 'Connected bench profile';
    await page.getByLabel('Import board profile', { exact: true }).setInputFiles({
        name: 'live.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(live)),
    });
    await page.getByRole('button', { name: 'Show advanced JSON editor' }).click();
    await prepare(page);
    await page.getByLabel('Test or sequence', { exact: true }).selectOption('test-i2c-3');
    await page.getByRole('checkbox', { name: 'Fixture / observer ready' }).check();
    await page.getByLabel('Fixture identity (optional)', { exact: true }).fill('Connected fixture');
    await page.evaluate(() => {
        const cancel = window.diagnosticHub!.cancelTests!;
        const state = window as typeof window & { testSourceCancels: number };
        state.testSourceCancels = 0;
        window.diagnosticHub!.cancelTests = async (id) => {
            state.testSourceCancels++;
            return cancel(id);
        };
    });
    await page.getByRole('button', { name: 'Run selected tests' }).click();
    const results = page.getByRole('region', { name: 'Test run results' });
    await expect(results).toContainText('Run complete');
    const toggle = page.getByRole('switch', { name: 'Simulation mode' });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(
        sampleProfile().name,
    );
    await expect(page.getByRole('button', { name: 'Show advanced JSON editor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '3. Review & run' })).toHaveCount(0);
    await expect(results).toHaveCount(0);
    await page.getByLabel('Profile name', { exact: true }).fill('Simulation bench profile');
    await page.getByRole('button', { name: 'Validate & prepare tests' }).click();
    await expect(page.getByRole('checkbox', { name: /I reviewed the mappings/ })).not.toBeChecked();
    await page.getByLabel('Test or sequence', { exact: true }).selectOption('test-uart-2');
    await page.getByRole('checkbox', { name: 'Fixture / observer ready' }).uncheck();
    await page
        .getByLabel('Fixture identity (optional)', { exact: true })
        .fill('Simulation fixture');
    await toggle.click();
    await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(live.name);
    await expect(page.getByRole('button', { name: 'Hide advanced JSON editor' })).toBeVisible();
    await expect(page.getByLabel('Test or sequence', { exact: true })).toHaveValue('test-i2c-3');
    await expect(page.getByRole('checkbox', { name: /I reviewed the mappings/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Fixture / observer ready' })).toBeChecked();
    await expect(page.getByLabel('Fixture identity (optional)', { exact: true })).toHaveValue(
        'Connected fixture',
    );
    await expect(results).toContainText('Run complete');
    await toggle.click();
    await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(
        'Simulation bench profile',
    );
    await expect(page.getByRole('button', { name: 'Show advanced JSON editor' })).toBeVisible();
    await expect(page.getByLabel('Test or sequence', { exact: true })).toHaveValue('test-uart-2');
    await expect(page.getByRole('checkbox', { name: /I reviewed the mappings/ })).not.toBeChecked();
    await expect(
        page.getByRole('checkbox', { name: 'Fixture / observer ready' }),
    ).not.toBeChecked();
    await expect(page.getByLabel('Fixture identity (optional)', { exact: true })).toHaveValue(
        'Simulation fixture',
    );
    await expect(results).toHaveCount(0);
    expect(
        await page.evaluate(
            () => (window as typeof window & { testSourceCancels: number }).testSourceCancels,
        ),
    ).toBe(0);
});

test('simulation switch locks during execution and pending observation, then releases after review', async ({
    page,
}) => {
    await sample(page);
    await prepare(page);
    await page.getByRole('button', { name: 'Run selected tests' }).click();
    const toggle = page.getByRole('switch', { name: 'Simulation mode' });
    await expect(toggle).toBeDisabled();
    const results = page.getByRole('region', { name: 'Test run results' });
    await expect(results).toContainText('Run review');
    await expect(toggle).toBeDisabled();
    await results.getByRole('button', { name: 'Yes, expected pattern' }).click();
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(results).toHaveCount(0);
    await toggle.click();
    await expect(results).toContainText('Test results Pass');
});

test('unconfirmed backend execution keeps the source switch locked until disconnection', async ({
    page,
}) => {
    await connectTesting(page);
    await page.evaluate(() => {
        const target = window.diagnosticHub!,
            start = target.startTests!,
            read = target.readTestRun!;
        let started = false;
        target.startTests = async (request) => {
            await start(request);
            started = true;
            throw Error('Start response lost.');
        };
        target.readTestRun = async () => {
            if (started) throw Error('Run status unreachable.');
            return read();
        };
    });
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    await page
        .getByLabel('Run request JSON', { exact: true })
        .fill(JSON.stringify(sampleProfile()));
    await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Run status could not be confirmed.');
    const toggle = page.getByRole('switch', { name: 'Simulation mode' });
    await expect(toggle).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Run JSON', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Setup', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(
        sampleProfile().name,
    );
});

test('disconnect rejects late discovery replies and reconnect leaves simulation intact; reset clears both', async ({
    page,
}) => {
    await connectTesting(page);
    await page.evaluate(() => {
        const discover = window.diagnosticHub!.discoverTests!;
        window.diagnosticHub!.discoverTests = () =>
            new Promise((resolve) => {
                (
                    window as typeof window & { releaseTestDiscovery(): Promise<void> }
                ).releaseTestDiscovery = async () => {
                    resolve(await discover());
                    window.diagnosticHub!.discoverTests = discover;
                };
            });
    });
    await page.getByRole('button', { name: 'Discover board' }).click();
    const toggle = page.getByRole('switch', { name: 'Simulation mode' });
    await expect(toggle).toBeDisabled();
    await page.evaluate(() => window.desktopTest.closeConnection?.());
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(
        sampleProfile().name,
    );
    await page.evaluate(() =>
        (
            window as typeof window & { releaseTestDiscovery(): Promise<void> }
        ).releaseTestDiscovery(),
    );
    await toggle.click();
    await expect(page.getByRole('heading', { name: '2. Project profile' })).toHaveCount(0);
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    await expect(page.getByLabel('Run request JSON', { exact: true })).toHaveValue('');
    await toggle.click();
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const request = JSON.stringify({ profile: sampleProfile(), testIds: ['test-i2c-3'] });
    await page.getByLabel('Run request JSON', { exact: true }).fill(request);
    await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
    const results = page.getByRole('region', { name: 'Test run results' });
    await expect(results).toContainText('Run complete');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Hostname or IP address').fill('replacement-device');
    await modal.getByLabel('SSH username').fill('engineer');
    await modal.getByLabel('Password', { exact: true }).fill('fixture');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
    await nav(page, 'Tests').click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Run request JSON', { exact: true })).toHaveValue(request);
    await expect(results).toContainText('Run complete');
    await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Setup', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(results).toHaveCount(0);
    await toggle.click();
    await expect(page.getByRole('heading', { name: '2. Project profile' })).toHaveCount(0);
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    await expect(page.getByLabel('Run request JSON', { exact: true })).toHaveValue('');
});
test('simulation persists across navigation, supports observation, cancellation, JSON/HTML/PDF and historical import', async ({
    page,
}) => {
    await sample(page);
    await prepare(page);
    await page.getByRole('button', { name: 'Run selected tests' }).click();
    await nav(page, 'Overview').click();
    await nav(page, 'Tests').click();
    const results = page.getByRole('region', { name: 'Test run results' });
    await expect(results).toContainText('review', { timeout: 10000 });
    await expect(results).toContainText('Inconclusive');
    await results.getByRole('button', { name: 'Yes, expected pattern', exact: true }).click();
    await expect(results).toContainText('Test results Pass');
    const downloadPromise = page.waitForEvent('download');
    await results.getByRole('button', { name: 'Export JSON', exact: true }).click();
    const downloaded = await downloadPromise;
    expect(downloaded.suggestedFilename()).toContain('simulated');
    const file = await downloaded.path();
    await page.getByLabel('Import test JSON report', { exact: true }).setInputFiles(file!);
    await expect(results).toContainText('HISTORICAL');
    await results.getByRole('button', { name: 'Print / Save PDF' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Save as PDF');
    await expect(dialog.locator('iframe')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    const htmlPromise = page.waitForEvent('download');
    await results.getByRole('button', { name: 'Export HTML', exact: true }).click();
    expect((await htmlPromise).suggestedFilename()).toMatch(/\.html$/);
    await page.getByRole('checkbox', { name: /Simulate UART/ }).check();
    await prepare(page);
    await page.getByRole('button', { name: 'Run selected tests' }).click();
    await page.getByRole('button', { name: 'Cancel tests' }).click();
    await expect(results).toContainText('cancelled');
    await expect(results).toContainText('Skipped');
    await page.getByLabel('Import test JSON report', { exact: true }).setInputFiles({
        name: 'bad.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{'),
    });
    await expect(page.getByRole('alert')).toContainText('valid JSON');
    await expect(results).toContainText('cancelled');
});
test('profile edits invalidate review and workspace stays inside desktop and mobile widths', async ({
    page,
}) => {
    await sample(page);
    await prepare(page);
    await page.getByRole('button', { name: 'Show advanced JSON editor' }).click();
    await page.getByLabel('Profile JSON', { exact: true }).fill('{');
    await expect(page.getByRole('button', { name: 'Run selected tests' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Validate & prepare tests' })).toBeDisabled();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByLabel('Profile JSON', { exact: true }).fill(JSON.stringify(sampleProfile()));
    await prepare(page);
    for (const width of [1440, 1100, 850, 390, 320]) {
        await page.setViewportSize({ width, height: 950 });
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
        await expect(nav(page, 'Tests')).toBeVisible();
    }
    await page.screenshot({ path: '.codex/board-tests-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.screenshot({ path: '.codex/board-tests-desktop.png', fullPage: true });
});
test('connected testing pauses five-second collection and input while leaving PTY output and device clock available', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.evaluate(async () => {
        const moduleUrl = '/shared/testing/simulation.ts';
        const { createSimulation } = await import(/* @vite-ignore */ moduleUrl);
        Object.assign(window.diagnosticHub!, createSimulation({ delayMs: 2500 }));
    });
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Hostname or IP address').fill('active-device');
    await modal.getByLabel('SSH username').fill('engineer');
    await modal.getByLabel('Password', { exact: true }).fill('test-password');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
    await page.getByRole('combobox', { name: 'Live update interval' }).selectOption('5');
    await nav(page, 'Tests').click();
    await page.getByRole('button', { name: /Discover/ }).click();
    await page.getByLabel('Import board profile', { exact: true }).setInputFiles({
        name: 'sample.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(sampleProfile())),
    });
    await prepare(page);
    for (const box of await page.getByRole('checkbox', { name: 'Fixture / observer ready' }).all())
        await box.check();
    await page.getByRole('button', { name: 'Run selected tests' }).click();
    const count = await page.evaluate(() => window.desktopTest.collects);
    await nav(page, 'Terminal').click();
    await expect(page.getByText(/Terminal input is paused/)).toBeVisible();
    await page.locator('.xterm-helper-textarea').press('a');
    await page.evaluate(() => window.desktopTest.terminal!.emit('PTY-OUTPUT-DURING-TEST\r\n'));
    await expect(page.locator('.xterm-screen')).toContainText('PTY-OUTPUT-DURING-TEST');
    await page.waitForTimeout(5100);
    expect(await page.evaluate(() => window.desktopTest.collects)).toBe(count);
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs.join(''))).not.toContain(
        'a',
    );
    await page.evaluate(async () => {
        await window.diagnosticHub!.readDeviceClock!();
    });
    expect(await page.evaluate(() => window.desktopTest.clock.calls)).toBeGreaterThan(1);
    await nav(page, 'Tests').click();
    await expect(page.getByRole('region', { name: 'Test run results' })).toContainText('review', {
        timeout: 10000,
    });
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.collects), { timeout: 8000 })
        .toBeGreaterThan(count);
});
test('a lost start response recovers an already finished backend run for operator review', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.evaluate(async () => {
        const url = '/shared/testing/simulation.ts',
            module = await import(/* @vite-ignore */ url),
            target = module.createSimulation({ delayMs: 1 }),
            start = target.startTests;
        target.startTests = async (request: unknown) => {
            await start(request);
            while (
                ['running', 'preparing', 'cleaning'].includes((await target.readTestRun())?.phase)
            )
                await new Promise((r) => setTimeout(r, 5));
            throw Error('Start response was lost.');
        };
        Object.assign(window.diagnosticHub!, target);
    });
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Hostname or IP address').fill('active-device');
    await modal.getByLabel('SSH username').fill('engineer');
    await modal.getByLabel('Password', { exact: true }).fill('test-password');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
    await nav(page, 'Tests').click();
    await page.getByRole('button', { name: 'Discover board' }).click();
    await page.getByLabel('Import board profile', { exact: true }).setInputFiles({
        name: 'profile.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(sampleProfile())),
    });
    await prepare(page);
    for (const box of await page.getByRole('checkbox', { name: 'Fixture / observer ready' }).all())
        await box.check();
    await page.getByRole('button', { name: 'Run selected tests' }).click();
    const results = page.getByRole('region', { name: 'Test run results' });
    await expect(results).toContainText('Run review');
    await expect(page.getByText(/Backend run recovered/)).toBeVisible();
    await results.getByRole('button', { name: 'Yes, expected pattern' }).click();
    await expect(results).toContainText('Test results Pass');
});

test('guided setup gates steps, stacks full-width panels, synchronizes JSON and highlights correctable fields', async ({
    page,
    context,
}) => {
    await page.goto('/');
    await nav(page, 'Tests').click();
    await expect(page.getByRole('heading', { name: '2. Project profile' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '3. Review & run' })).toHaveCount(0);
    await page.getByRole('switch', { name: 'Simulation mode' }).click();
    await expect(page.getByRole('button', { name: 'Discover board' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Generate draft profile' })).toHaveCount(0);
    const board = await page
        .getByRole('heading', { name: '1. Board & resources' })
        .locator('..')
        .locator('..')
        .boundingBox();
    const project = await page
        .getByRole('heading', { name: '2. Project profile' })
        .locator('..')
        .locator('..')
        .boundingBox();
    expect(project!.y).toBeGreaterThanOrEqual(board!.y + board!.height);
    expect(project!.width).toBeCloseTo(board!.width, 0);
    await page.getByRole('button', { name: 'Show advanced JSON editor' }).click();
    const json = page.getByLabel('Profile JSON', { exact: true });
    const changed = sampleProfile();
    changed.name = 'JSON edited board';
    await json.fill(JSON.stringify(changed));
    await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(changed.name);
    await page.getByLabel('Profile name', { exact: true }).fill('Form edited board');
    expect(JSON.parse(await json.inputValue()).name).toBe('Form edited board');
    await page.getByLabel('Cycles', { exact: true }).fill('21');
    const cycles = page.getByLabel(/^Cycles/);
    await expect(cycles).toHaveAttribute('aria-invalid', 'true');
    await expect(cycles).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Validate & prepare tests' })).toBeDisabled();
    await cycles.fill('3');
    await expect(cycles).toHaveAttribute('aria-invalid', 'false');
    await page
        .getByRole('textbox', { name: 'Fixture / observer requirement', exact: true })
        .first()
        .fill('');
    await expect(page.getByLabel(/^Fixture \/ observer requirement/).first()).toHaveAttribute(
        'aria-invalid',
        'true',
    );
    await page
        .getByLabel(/^Fixture \/ observer requirement/)
        .first()
        .fill(changed.tests[0].fixture);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy profile JSON', exact: true }).click();
    await expect(page.getByText('Copied!', { exact: true })).toBeVisible();
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(
        await json.inputValue(),
    );
    await json.focus();
    await json.press('Control+a');
    await json.press('Control+c');
    await json.press('Control+v');
    await expect(json).toHaveValue(
        (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'),
    );
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.screenshot({ path: '.codex/board-tests-guided-refined.png', fullPage: true });
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    expect(
        JSON.parse(await page.getByLabel('Run request JSON', { exact: true }).inputValue()).name,
    ).toBe('Form edited board');
});

test('complete discovery fills a fresh draft and incomplete discovery hides later sections', async ({
    page,
}) => {
    await connectTesting(page);
    await page.getByRole('button', { name: 'Discover board' }).click();
    await expect(page.getByRole('heading', { name: '2. Project profile' })).toBeVisible();
    await expect(page.getByLabel(/^Fixture \/ observer requirement/).first()).toHaveAttribute(
        'aria-invalid',
        'true',
    );
    await page.getByLabel('Profile name', { exact: true }).fill('Custom draft');
    await page.getByRole('button', { name: 'Discover board' }).click();
    await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(
        'Simulated engineering board',
    );
    await page.evaluate(() => {
        const discover = window.diagnosticHub!.discoverTests!;
        window.diagnosticHub!.discoverTests = async () => ({
            ...(await discover()),
            complete: false,
            issues: ['Incomplete discovery.'],
        });
    });
    await page.getByRole('button', { name: 'Discover board' }).click();
    await expect(page.getByText('Incomplete discovery.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '2. Project profile' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '3. Review & run' })).toHaveCount(0);
});

test('direct JSON runs without agreements, finalizes unobserved LEDs, exports and reruns selected tests', async ({
    page,
}) => {
    await sample(page);
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: /I reviewed/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Discover board' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
    const results = page.getByRole('region', { name: 'Test run results' });
    await expect(results).toContainText('Run complete', { timeout: 10000 });
    await expect(results).toContainText('Test results Inconclusive');
    await expect(results.getByRole('button', { name: 'Yes, expected pattern' })).toHaveCount(0);
    const report = JSON.parse(
        await page.getByLabel('Result report JSON', { exact: true }).inputValue(),
    );
    expect(report.run.cases[0].feedback.value).toBe('unobserved');
    expect(report.run.cases[1].verdict).toBe('Pass');
    for (const name of ['Export JSON', 'Export HTML', 'Print / Save PDF'])
        await expect(results.getByRole('button', { name, exact: true }).locator('svg')).toHaveCount(
            1,
        );
    const download = page.waitForEvent('download');
    await results.getByRole('button', { name: 'Export JSON', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/simulated/);
    const json = page.getByLabel('Run request JSON', { exact: true });
    await json.fill('{');
    await expect(json).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: 'Run JSON', exact: true })).toBeDisabled();
    await json.fill(
        JSON.stringify({ profile: sampleProfile(), testIds: ['test-uart-2', 'test-i2c-3'] }),
    );
    await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
    await expect(results).toContainText('Test results Pass', { timeout: 10000 });
    for (const width of [1440, 850, 390, 320]) {
        await page.setViewportSize({ width, height: 950 });
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
    }
    await page.screenshot({ path: '.codex/board-tests-direct-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.screenshot({ path: '.codex/board-tests-direct-desktop.png', fullPage: true });
});

test('connected direct JSON automatically discovers and recovers a finished lost response without prompting', async ({
    page,
}) => {
    await connectTesting(page, { lost: true });
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    await page
        .getByLabel('Run request JSON', { exact: true })
        .fill(JSON.stringify(sampleProfile()));
    await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
    const results = page.getByRole('region', { name: 'Test run results' });
    await expect(results).toContainText('Run complete', { timeout: 10000 });
    await expect(page.getByText(/Backend run recovered/)).toBeVisible();
    await expect(results).toContainText('Operator observation: unobserved');
    const oldId = JSON.parse(
        await page.getByLabel('Result report JSON', { exact: true }).inputValue(),
    ).run.id;
    await page.evaluate(() => {
        window.diagnosticHub!.startTests = async () => {
            throw Error('Rejected before starting.');
        };
    });
    await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Rejected before starting.');
    await expect(page.getByText(/Backend run recovered/)).toHaveCount(0);
    expect(
        JSON.parse(await page.getByLabel('Result report JSON', { exact: true }).inputValue()).run
            .id,
    ).toBe(oldId);
    await expect(page.getByRole('button', { name: 'Run JSON', exact: true })).toBeEnabled();
});

test('direct simulation produces failure, blocked and cancellation reports without follow-up prompts', async ({
    page,
}) => {
    await sample(page);
    await page.getByRole('checkbox', { name: /Simulate UART/ }).check();
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const json = page.getByLabel('Run request JSON', { exact: true });
    const request = { profile: sampleProfile(), testIds: ['test-uart-2'] };
    await json.fill(JSON.stringify(request));
    await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
    const results = page.getByRole('region', { name: 'Test run results' });
    await expect(results).toContainText('Test results Fail', { timeout: 10000 });
    await json.fill(
        JSON.stringify({
            ...request,
            fixtures: { 'test-uart-2': { ready: false, identity: 'Not attached' } },
        }),
    );
    await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
    await expect(results).toContainText('Test results Blocked', { timeout: 10000 });
    await json.fill(JSON.stringify(sampleProfile()));
    await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel tests', exact: true }).click();
    await expect(results).toContainText('Run cancelled');
    await expect(results).toContainText('Skipped');
    await expect(results.getByRole('button', { name: 'Yes, expected pattern' })).toHaveCount(0);
});
