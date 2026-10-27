import { expect, test, type Page } from '@playwright/test';
import { installSerial } from './fixtures/serial';
import { installDesktop } from './fixtures/desktop';
import { installSshStream } from './fixtures/ssh-stream';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const setup = (flow: import('@playwright/test').Locator, stage: string) =>
    flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(stage) })
        .click();

const output = async (page: Page, name: string, testInfo: import('@playwright/test').TestInfo) => {
    const file = process.env.HUB_FEATURE_EVIDENCE
        ? path.join(process.env.HUB_FEATURE_EVIDENCE, name)
        : testInfo.outputPath(name);
    await mkdir(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
};

test('Automation action icons and warning palette retain readable states and one complete Cancel action', async ({
    page,
}, testInfo) => {
    const ratio = (a: string, b: string) => {
        const luminance = (value: string) =>
            value
                .match(/[\d.]+/g)!
                .slice(0, 3)
                .map(Number)
                .map((v) => v / 255)
                .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
                .reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0);
        const x = luminance(a),
            y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const palette = (button: import('@playwright/test').Locator) =>
        button.evaluate((element) => {
            const style = getComputedStyle(element);
            let parent = element.parentElement;
            while (parent && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)')
                parent = parent.parentElement;
            return {
                text: style.color,
                background: style.backgroundColor,
                outline: style.outlineColor,
                opacity: style.opacity,
                adjacent: parent ? getComputedStyle(parent).backgroundColor : 'rgb(0, 0, 0)',
            };
        });
    const alignedIcon = async (button: import('@playwright/test').Locator) => {
        await expect(button.locator('svg')).toHaveCount(1);
        await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
        const geometry = await button.evaluate((element) => {
            const b = element.getBoundingClientRect(),
                icon = element.querySelector('svg')!.getBoundingClientRect();
            return {
                delta: Math.abs(b.top + b.height / 2 - (icon.top + icon.height / 2)),
                width: parseFloat(getComputedStyle(element.querySelector('svg')!).width),
                height: parseFloat(getComputedStyle(element.querySelector('svg')!).height),
            };
        });
        expect(geometry.delta).toBeLessThanOrEqual(1);
        expect(geometry.width).toBe(16);
        expect(geometry.height).toBe(16);
    };
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    const clear = flow.getByRole('button', { name: 'Clear retained results', exact: true });
    await expect(clear).toBeDisabled();
    await alignedIcon(clear);
    await expect(clear).toHaveCSS('background-color', 'rgb(150, 61, 72)');
    await clear.hover({ force: true });
    await expect(clear).toHaveCSS('background-color', 'rgb(150, 61, 72)');
    const disabled = await palette(clear);
    expect(disabled.opacity).toBe('0.5');
    await output(page, 'automation-clear-disabled.png', testInfo);
    await flow.getByLabel('Automation transport').selectOption('serial');
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('ls');
    await setup(flow, 'Connection');
    await flow.getByLabel('Serial completion prompt').fill('console# ');
    await setup(flow, 'Review');
    const start = flow.getByRole('button', { name: 'Start flow', exact: true });
    await expect(start).toBeEnabled();
    await alignedIcon(start);
    await expect(flow.getByText(/Cancel disarms queued steps and repetitions/)).toBeVisible();
    await start.click();
    await expect(flow.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible();
    await expect(flow.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(start).toBeDisabled();
    await alignedIcon(start);
    await expect(start).toHaveCSS('opacity', '0.5');
    await output(page, 'automation-running-cancel.png', testInfo);
    await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
    await expect(flow.getByRole('status')).toContainText('Commands already sent may continue');
    await expect(clear).toBeEnabled();
    await expect(start).toBeEnabled();
    const measurements: unknown[] = [
        { state: 'disabled', ...disabled, disabledContrastExempt: true },
    ];
    for (const colorScheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme });
        await page.mouse.move(0, 0);
        await expect(clear).toHaveCSS('color', 'rgb(255, 233, 233)');
        await expect(clear).toHaveCSS('background-color', 'rgb(150, 61, 72)');
        const normal = await palette(clear);
        expect(ratio(normal.text, normal.background)).toBeGreaterThanOrEqual(4.5);
        measurements.push({
            colorScheme,
            state: 'normal',
            ...normal,
            contrast: ratio(normal.text, normal.background),
        });
        await clear.hover();
        await expect(clear).toHaveCSS('background-color', 'rgb(176, 68, 83)');
        const hover = await palette(clear);
        expect(ratio(hover.text, hover.background)).toBeGreaterThanOrEqual(4.5);
        measurements.push({
            colorScheme,
            state: 'hover',
            ...hover,
            contrast: ratio(hover.text, hover.background),
        });
        await start.hover();
        const play = await palette(start);
        expect(ratio(play.text, play.background)).toBeGreaterThanOrEqual(4.5);
        await alignedIcon(start);
    }
    await output(page, 'automation-actions-hover.png', testInfo);
    await page.mouse.move(0, 0);
    await clear.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(clear).toBeFocused();
    await expect(clear).toHaveCSS('outline-style', 'solid');
    await expect(clear).toHaveCSS('outline-width', '3px');
    const focus = await palette(clear);
    expect(ratio(focus.outline, focus.adjacent)).toBeGreaterThanOrEqual(3);
    measurements.push({ state: 'focus', ...focus, contrast: ratio(focus.outline, focus.adjacent) });
    await output(page, 'automation-actions-focus.png', testInfo);
    await page.emulateMedia({ forcedColors: 'active' });
    const forced = await palette(clear);
    expect(ratio(forced.text, forced.background)).toBeGreaterThanOrEqual(4.5);
    await alignedIcon(clear);
    await testInfo.attach('automation-action-palettes', {
        body: JSON.stringify(measurements, null, 2),
        contentType: 'application/json',
    });
    await output(page, 'automation-actions-forced-colors.png', testInfo);
    expect(await flow.locator('tbody tr').count()).toBe(1); // Synthetic cancelled row was never cleared.
});
test('Serial flow edits remain deliberate, multiline bytes and QA exports use captured rows', async ({
    page,
}, testInfo) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByLabel('Automation transport').selectOption('serial');
    await setup(flow, 'Commands');
    await flow.getByLabel('Step 1 name (optional)').fill('Read console');
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('first line');
    await flow.getByLabel('Command 1 script').press('Enter');
    await flow.getByLabel('Command 1 script').pressSequentially('second line');
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(0);
    await setup(flow, 'Timing');
    await setup(flow, 'Connection');
    await flow.getByLabel('Serial completion prompt').fill('console# ');
    await flow.getByLabel('Serial automation line ending').selectOption('LF');
    await setup(flow, 'Review');
    await setup(flow, 'Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => String.fromCharCode(...window.serialTest.writes.flat())))
        .toBe('first line\nsecond line\n');
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('next draft');
    await page.evaluate(() => {
        window.serialTest.push([...new TextEncoder().encode('reply\r\n\x1b[32mcon')]);
        window.serialTest.push([...new TextEncoder().encode('sole# ')]);
    });
    await expect(flow.getByRole('status')).toContainText('Flow finished');
    await expect(flow.locator('tbody')).toContainText('prompt-observed');
    await expect(flow.locator('tbody')).toContainText('unavailable');
    const writes = await page.evaluate(() => window.serialTest.writes.length);
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        flow.getByRole('button', { name: 'Download QA results' }).click(),
    ]);
    const file = await download.path();
    const fs = await import('node:fs/promises');
    const data = JSON.parse(await fs.readFile(file!, 'utf8'));
    expect(data.captures).toHaveLength(1);
    const captured = data.captures[0];
    expect(captured.capture.header.command).toBe('first line\nsecond line');
    expect(captured.outcome.exitCode).toBeNull();
    expect(captured.capture.header.receiveTimeSource).toBe('local-client');
    expect(captured.outcome.execution.serial.timestampPrefix).toBe('');
    await expect(
        flow.getByRole('columnheader', { name: 'Host receive timestamps (UTC)' }),
    ).toBeVisible();
    await expect(flow.locator('tbody')).toContainText(captured.rawObservations[0].receivedAt);
    await expect(flow.locator('tbody')).toContainText('Receive source: local-client');
    await expect(
        flow.getByText('Host receive time is not device emission time.', { exact: false }),
    ).toBeVisible();
    await expect(flow.locator('tbody')).toContainText('reply');
    expect(
        Buffer.concat(
            captured.rawObservations.map((frame: { base64: string }) =>
                Buffer.from(frame.base64, 'base64'),
            ),
        ).toString(),
    ).toBe('reply\r\n\x1b[32mconsole# ');
    expect(captured.capture.header.requestBase64).toBe(
        Buffer.from('first line\nsecond line\n').toString('base64'),
    );
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(writes);
    await output(page, 'automation-serial.png', testInfo);
    await page.setViewportSize({ width: 412, height: 915 });
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    await output(page, 'automation-mobile.png', testInfo);
});
test('invalid scheduled dates, repeated local time and invalid delay keep draft and block arming', async ({
    page,
}) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByLabel('Automation transport').selectOption('serial');
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('explicit payload');
    await setup(flow, 'Timing');
    await setup(flow, 'Connection');
    await flow.getByLabel('Serial completion prompt').fill('# ');
    await setup(flow, 'Timing');
    await flow.getByLabel('Run mode', { exact: true }).selectOption('scheduled');
    await flow.getByLabel('Start timezone').selectOption('UTC');
    await flow.getByLabel('Scheduled start date', { exact: true }).fill('2020-02-29');
    await flow.getByLabel('Scheduled start time', { exact: true }).fill('12:00:00');
    await expect(flow.getByRole('alert')).toContainText('future');
    await expect(flow.getByLabel('Scheduled start date', { exact: true })).toHaveValue(
        '2020-02-29',
    );
    await setup(flow, 'Review');
    await expect(flow.getByRole('button', { name: 'Start flow', exact: true })).toBeDisabled();
    await setup(flow, 'Timing');
    await flow.getByLabel('Start timezone').selectOption('America/New_York');
    await flow.getByLabel('Scheduled start date', { exact: true }).fill('2026-11-01');
    await flow.getByLabel('Scheduled start time', { exact: true }).fill('01:30:00');
    await expect(flow.getByRole('alert')).toContainText('repeats');
    await flow.getByLabel('Repeated time occurrence').selectOption('-05:00');
    await flow.getByLabel('Command 1 delay').fill('Infinity');
    await expect(flow.getByRole('alert')).toContainText('delay');
    await expect(flow.getByLabel('Command 1 delay')).toHaveValue('Infinity');
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(0);
});
test('SSH flow uses separate API, retains drafts and genuine exits without terminal scraping', async ({
    page,
}, testInfo) => {
    await installDesktop(page);
    await installSshStream(page, {
        connection: 'synthetic-connected-001',
        stdout: 'synthetic SSH result',
        stderr: 'synthetic diagnostic error',
        exitCode: 7,
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('fixture first\nfixture second');
    await setup(flow, 'Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect(flow.locator('tbody')).toContainText('7');
    await expect(flow.locator('tbody')).toContainText('synthetic SSH result');
    expect(await page.evaluate(() => window.sshStreamTest.commands)).toEqual([
        'fixture first\nfixture second',
    ]);
    await expect.poll(() => page.evaluate(() => window.sshStreamTest.finalized)).toBe(1);
    expect(await page.evaluate(() => window.sshStreamTest.legacyCalls)).toBe(0);
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs)).toEqual([]);
    await output(page, 'automation-ssh.png', testInfo);
});

for (const transport of ['ssh', 'serial'] as const)
    test(
        transport + ' scheduled Run once honors start and preview without repetition',
        async ({ page }) => {
            if (transport === 'serial') await installSerial(page);
            else {
                await installDesktop(page);
                await installSshStream(page, {
                    connection: 'schedule-fixture-001',
                    stdout: 'scheduled fixture',
                    stderr: '',
                    exitCode: 0,
                });
            }
            await page.clock.install({ time: new Date('2028-02-29T11:59:00Z') });
            await page.goto('/');
            if (transport === 'serial') {
                await page.getByRole('button', { name: 'Serial', exact: true }).click();
                const serial = page.getByRole('region', { name: 'Local serial terminal' });
                await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
                await serial.getByRole('button', { name: 'Connect', exact: true }).click();
                await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
            } else {
                await page
                    .getByRole('button', { name: 'Connect device', exact: true })
                    .first()
                    .click();
                await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
                await expect(
                    page.getByRole('dialog', { name: 'Connect a Linux device' }),
                ).not.toBeVisible();
            }
            await page.getByRole('button', { name: 'Automation', exact: true }).click();
            const flow = page.getByRole('region', { name: 'Automation', exact: true });
            await flow.getByLabel('Automation transport').selectOption(transport);
            await setup(flow, 'Commands');
            await flow.getByLabel('Command 1 script').fill('scheduled fixture');
            await setup(flow, 'Timing');
            // Freeze after lazy pages and their controls are mounted; pausing before import stalls React retries.
            await page.clock.pauseAt(new Date('2028-02-29T12:00:00Z'));
            if (transport === 'serial') {
                await setup(flow, 'Connection');
                await flow.getByLabel('Serial completion prompt').fill('# ');
            }
            await setup(flow, 'Timing');
            await flow.getByLabel('Run mode', { exact: true }).selectOption('scheduled');
            await flow.getByLabel('Start timezone').selectOption('UTC');
            await flow.getByLabel('Scheduled start date', { exact: true }).fill('2028-02-29');
            await flow.getByLabel('Scheduled start time', { exact: true }).fill('12:00:05');
            await flow.getByLabel('Repeat completed flow').check();
            await setup(flow, 'Review');
            await expect(flow.locator('.automation-preview')).toContainText(
                '2028-02-29T12:00:05.000Z',
            );
            await expect(flow.locator('.automation-preview')).toContainText(
                'Run once executes one flow',
            );
            await flow
                .getByRole('button', { name: 'Run once at scheduled time', exact: true })
                .click();
            await expect(flow.getByRole('status')).toContainText('Armed start');
            const calls = () =>
                page.evaluate(
                    (t) =>
                        t === 'serial'
                            ? window.serialTest.writes.length
                            : window.sshStreamTest.commands.length,
                    transport,
                );
            expect(await calls()).toBe(0);
            await page.clock.runFor(4999);
            expect(await calls()).toBe(0);
            await page.clock.runFor(1);
            await expect.poll(calls).toBe(1);
            if (transport === 'serial') {
                await page.evaluate(() =>
                    window.serialTest.push([
                        ...new TextEncoder().encode('scheduled response\r\n# '),
                    ]),
                );
                await page.clock.runFor(250);
            }
            await expect(flow.getByRole('status')).toContainText('Flow finished');
            await page.clock.runFor(11000);
            expect(await calls()).toBe(1);
        },
    );

test('optional names, mouse and keyboard ordering, stable timing and fixed chosen instant', async ({
    page,
}, testInfo) => {
    await installSerial(page);
    await page.clock.install({ time: new Date('2028-01-01T12:00:00Z') });
    await page.goto('/');
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByLabel('Automation transport').selectOption('serial');
    await flow.getByLabel('Serial completion prompt').fill('# ');
    await setup(flow, 'Commands');
    await expect(flow.getByLabel('Step 1 name (optional)')).toHaveValue('');
    await expect(flow.getByLabel('Command 1 script')).toHaveValue('');
    await flow.getByLabel('Command 1 script').fill('first');
    await flow.getByRole('button', { name: 'Add command', exact: true }).click();
    await flow.getByLabel('Command 2 script').fill('second');
    await flow
        .locator('.automation-drag-handle')
        .first()
        .dragTo(flow.locator('.automation-steps li').last());
    await expect(flow.getByLabel('Command 1 script')).toHaveValue('second');
    const up = flow.getByRole('button', { name: 'Move command 2 up', exact: true });
    await up.focus();
    await page.keyboard.press('Enter');
    await expect(flow.getByLabel('Command 1 script')).toHaveValue('first');
    await setup(flow, 'Timing');
    const before = await flow.locator('.automation-settings').boundingBox();
    await flow.getByLabel('Run mode', { exact: true }).selectOption('scheduled');
    const after = await flow.locator('.automation-settings').boundingBox();
    expect(Math.abs(before!.height - after!.height)).toBeLessThan(2);
    await flow.getByLabel('Start timezone').selectOption('America/New_York');
    await flow.getByLabel('Scheduled start date', { exact: true }).fill('2028-07-01');
    await flow.getByLabel('Scheduled start time', { exact: true }).fill('09:15:00');
    await expect(flow.locator('.automation-offset')).toContainText('-04:00');
    const reference = await flow.getByLabel('Current time reference').innerText();
    await page.clock.runFor(2000);
    await expect(flow.getByLabel('Current time reference')).not.toHaveText(reference);
    await expect(flow.getByLabel('Scheduled start date', { exact: true })).toHaveValue(
        '2028-07-01',
    );
    await expect(flow.getByLabel('Scheduled start time', { exact: true })).toHaveValue('09:15:00');
    await output(page, 'automation-stable-timing.png', testInfo);
    await setup(flow, 'Review');
    await expect(flow.locator('.automation-preview')).toContainText('2028-07-01T13:15:00.000Z');
});

test('Enter-only Serial Automation shares one port and reader; local input annotations never become device results', async ({
    page,
}) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByLabel('Automation transport').selectOption('serial');
    await flow.getByLabel('Serial completion prompt').fill('console# ');
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 send Enter only').check();
    await setup(flow, 'Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.serialTest.writes)).toEqual([[13]]);
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    await expect(serial.locator('.xterm-screen')).toContainText('[Automation input, local] "\\r"');
    await page.getByLabel('Serial terminal input').focus();
    await page.keyboard.type('manual');
    expect(await page.evaluate(() => window.serialTest.writes)).toEqual([[13]]);
    await page.evaluate(() =>
        window.serialTest.push([...new TextEncoder().encode('actual reply\r\nconsole# ')]),
    );
    await expect(serial.locator('.xterm-screen')).toContainText('actual reply');
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    await expect(flow.getByRole('status')).toContainText('Flow finished');
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        flow.getByRole('button', { name: 'Download QA results' }).click(),
    ]);
    const fs = await import('node:fs/promises'),
        file = await download.path();
    const result = JSON.parse(await fs.readFile(file!, 'utf8'));
    expect(result.captures).toHaveLength(1);
    expect(
        Buffer.concat(
            result.captures[0].rawObservations.map((frame: { base64: string }) =>
                Buffer.from(frame.base64, 'base64'),
            ),
        ).toString(),
    ).toBe('actual reply\r\nconsole# ');
    expect(result.captures[0].capture.header.requestBase64).toBe('DQ==');
    expect(result.captures[0].outcome.completion).toBe('prompt-observed');
    expect(
        await page.evaluate(() => ({
            opens: window.serialTest.opens,
            readers: window.serialTest.readers,
            closes: window.serialTest.closes,
        })),
    ).toEqual({ opens: 1, readers: 1, closes: 0 });
});
test('card surface drag previews before drop, Escape restores identity, controls remain editable and edge scrolling stops on cancel', async ({
    page,
}, testInfo) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('first');
    await flow.getByRole('button', { name: 'Add command', exact: true }).click();
    await flow.getByLabel('Command 2 script').fill('second');
    const originalIds = await flow
        .locator('.automation-steps li')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-step-id')));
    const data = await page.evaluateHandle(() => new DataTransfer());
    await flow
        .locator('.automation-steps li')
        .first()
        .dispatchEvent('dragstart', { dataTransfer: data });
    const target = flow.locator('.automation-steps li').last();
    const targetBounds = await target.boundingBox();
    await target.dispatchEvent('dragover', {
        dataTransfer: data,
        clientY: targetBounds!.y + targetBounds!.height - 4,
    });
    await expect(flow.getByLabel('Command 1 script')).toHaveValue('second');
    for (let i = 0; i < 4; i++)
        await flow.locator('[data-step-id="' + originalIds[1] + '"]').dispatchEvent('dragover', {
            dataTransfer: data,
            clientY: targetBounds!.y + targetBounds!.height - 4,
        });
    await expect(flow.getByLabel('Command 1 script')).toHaveValue('second');
    await expect(flow.locator('.automation-drag-placeholder')).toHaveCount(1);
    expect(
        await flow
            .locator('.automation-drag-placeholder')
            .evaluate((node) => getComputedStyle(node).outlineStyle),
    ).toBe('dashed');
    await flow
        .locator('.automation-steps')
        .screenshot({ path: testInfo.outputPath('automation-drag-preview.png') });
    await page.keyboard.press('Escape');
    await expect(flow.getByLabel('Command 1 script')).toHaveValue('first');
    expect(
        await flow
            .locator('.automation-steps li')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-step-id'))),
    ).toEqual(originalIds);
    await flow.getByLabel('Command 1 script').click();
    expect(await flow.locator('.automation-steps li').first().getAttribute('draggable')).toBe(
        'false',
    );
    await flow.getByLabel('Command 1 script').fill('editing still works');
    await flow
        .locator('.automation-steps li')
        .first()
        .dispatchEvent('dragstart', { dataTransfer: data });
    await flow
        .locator('.automation-steps li')
        .last()
        .dispatchEvent('dragover', { dataTransfer: data, clientY: 400 });
    await expect(flow.getByLabel('Command 1 script')).toHaveValue('editing still works');
    for (let i = 0; i < 8; i++)
        await flow.getByRole('button', { name: 'Add command', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    const first = flow.locator('.automation-steps li').first();
    await first.evaluate((node) => {
        (node as HTMLElement).draggable = true;
    });
    await first.dispatchEvent('dragstart', { dataTransfer: data, clientY: 900 });
    const before = await page.evaluate(() => scrollY),
        edge = await page.evaluate(() => innerHeight - 4);
    await first.dispatchEvent('dragover', { dataTransfer: data, clientY: edge });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before);
    await page
        .locator('main')
        .first()
        .dispatchEvent('dragover', {
            dataTransfer: data,
            clientY: await page.evaluate(() => innerHeight / 2),
        });
    const awayFromEdge = await page.evaluate(() => scrollY);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => scrollY)).toBe(awayFromEdge);
    await page.keyboard.press('Escape');
    const cancelled = await page.evaluate(() => scrollY);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => scrollY)).toBe(cancelled);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const up = flow.getByRole('button', { name: 'Move command 2 up', exact: true });
    await up.focus();
    await page.keyboard.press('Enter');
    await expect(flow.getByLabel('Command 1 script')).toHaveValue('second');
});
