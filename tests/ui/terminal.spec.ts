import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { gatewayFixture } from '../fixtures/gateway';
import { createReport } from '../../shared/report';
import { demoSnapshot } from '../fixtures/snapshots';

async function connectDesktop(page: Page) {
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Hostname or IP address').fill('active-device');
    await modal.getByLabel('SSH username').fill('engineer');
    await modal.getByLabel('Password', { exact: true }).fill('test-password');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
}

test('desktop terminal is embedded, keyboard accessible and retained across tabs, reset and reports', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    await expect(panel.getByRole('button', { name: 'Clear terminal', exact: true })).toBeDisabled();
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(panel).toContainText('engineer@active-device:22');
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    const input = page.getByLabel('Device terminal input');
    await input.focus();
    await page.keyboard.type('pwd');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Control+c');
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.terminal!.inputs.join('')))
        .toContain('pwd\r\x1b[A\x03');
    await page.keyboard.press('Control+Shift+Escape');
    await expect(panel.getByRole('button', { name: 'Clear terminal', exact: true })).toBeFocused();
    const opens = await page.evaluate(() => window.desktopTest.terminal!.opens);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(panel).not.toBeVisible();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(opens);
    await page.setViewportSize({ width: 1100, height: 850 });
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.terminal!.sizes.length))
        .toBeGreaterThan(1);
    await page.evaluate(() =>
        window.desktopTest.terminal!.emit(
            'TRANSCRIPT_ONLY_MARKER\r\n\x1b]52;c;ZXZpbA==\x07\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07<script>window.terminalInjected=true</script>',
        ),
    );
    await expect(panel.locator('.terminal-screen')).toContainText('TRANSCRIPT_ONLY_MARKER');
    expect(
        await page.evaluate(
            () => (window as unknown as { terminalInjected?: boolean }).terminalInjected,
        ),
    ).toBeUndefined();
    const before = await page.evaluate(() => window.desktopTest.terminal!.inputs.join(''));
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs.join(''))).toBe(before);
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Resetting session data' })).not.toBeVisible();
    await expect(panel.locator('.terminal-screen')).not.toContainText('TRANSCRIPT_ONLY_MARKER');
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs.join(''))).toBe(before);
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'report.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(createReport(demoSnapshot()))),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Clear terminal', exact: true })).toBeDisabled();
    await expect(panel).toContainText('No device connected');
    expect(await page.evaluate(() => window.desktopTest.terminal!.closes)).toBe(1);
});

test('desktop five-second live snapshots never enter terminal display or copied history', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await connectDesktop(page);
    await page.evaluate(() => {
        const original = window.diagnosticHub!.collect;
        window.diagnosticHub!.collect = async () => {
            const snapshot = await original();
            snapshot.results[0].stdout =
                'DIAGNOSTIC_STDOUT_ONLY\n[123.4] kernel: DIAGNOSTIC_KERNEL_ONLY';
            snapshot.results[0].stderr = 'DIAGNOSTIC_STDERR_ONLY';
            return snapshot;
        };
    });
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    await page.getByLabel('Device terminal input').focus();
    await page.keyboard.type('echo USER_TYPED_ONLY');
    await page.keyboard.press('Enter');
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.collects), { timeout: 12000 })
        .toBeGreaterThanOrEqual(2);
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await panel.getByRole('button', { name: 'Copy terminal text' }).click();
    const transcript = await page.evaluate(() => window.desktopTest.clipboard!);
    expect(transcript).toContain('USER_TYPED_ONLY');
    expect(transcript).not.toContain('DIAGNOSTIC_');
    await expect(panel.locator('.terminal-screen')).not.toContainText('DIAGNOSTIC_');
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(1);
});

test('website terminal uses real gateway PTY, keeps shell state, clears display and handles disconnect', async ({
    page,
}) => {
    const gateway = await gatewayFixture(undefined, {
        probeDelayMs: 15,
        probeOutput: {
            stdout: 'DIAGNOSTIC_STDOUT_ONLY\n[123.4] kernel: DIAGNOSTIC_KERNEL_ONLY\n',
            stderr: 'DIAGNOSTIC_STDERR_ONLY\n',
        },
    });
    try {
        await page.goto('/');
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('Gateway HTTPS address').fill(gateway.url);
        await modal.getByLabel('Gateway access token').fill(gateway.token);
        await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
        await modal.getByLabel('Port', { exact: true }).fill(String(gateway.options.port));
        await modal.getByLabel('SSH username').fill('engineer');
        await modal.getByLabel('Password', { exact: true }).fill(gateway.options.password);
        await modal.getByRole('button', { name: 'Read fingerprint' }).click();
        await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(modal).not.toBeVisible({ timeout: 20000 });
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        const panel = page.getByRole('region', { name: 'Connected device terminal' });
        const attempts = gateway.authentications();
        await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
        await page.getByLabel('Live update interval').selectOption('5');
        const input = page.getByLabel('Device terminal input');
        await input.focus();
        await input.evaluate((element) => {
            const clipboard = new DataTransfer();
            clipboard.setData('text/plain', 'cd /tmp\npwd\nunicode\n');
            element.dispatchEvent(
                new ClipboardEvent('paste', {
                    clipboardData: clipboard,
                    bubbles: true,
                    cancelable: true,
                }),
            );
        });
        await expect(panel.locator('.terminal-screen')).toContainText('裝置✓');
        await expect
            .poll(() => gateway.probeExecutions(), { timeout: 12000 })
            .toBeGreaterThanOrEqual(72);
        await page.getByRole('switch', { name: 'Live updates' }).click();
        await expect(panel.locator('.terminal-screen')).not.toContainText('DIAGNOSTIC_');
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await panel.getByRole('button', { name: 'Copy terminal text' }).click();
        const transcript = await page.evaluate(() => navigator.clipboard.readText());
        expect(transcript).toContain('裝置✓');
        expect(transcript).not.toContain('DIAGNOSTIC_');
        await input.focus();
        expect(Buffer.concat(gateway.terminal.inputs).toString()).toContain(
            'cd /tmp\rpwd\runicode\r',
        );
        await page.keyboard.type('watch');
        await page.keyboard.press('Enter');
        await expect(panel.locator('.terminal-screen')).toContainText('watching');
        await page.keyboard.press('Control+c');
        await expect(panel.locator('.terminal-screen')).toContainText('^C');
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        await input.focus();
        await page.keyboard.type('pwd');
        await page.keyboard.press('Enter');
        await expect(panel.locator('.terminal-screen')).toContainText('/tmp');
        expect(gateway.terminal.opens).toBe(1);
        expect(gateway.authentications()).toBe(attempts);
        await expect(page.getByRole('button', { name: 'Export report', exact: true })).toHaveCount(
            0,
        );
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export report', exact: true }).click();
        const file = await downloadPromise;
        const stream = await file.createReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(chunk);
        const exported = Buffer.concat(chunks).toString();
        expect(exported).not.toContain('watching');
        expect(exported).toContain('DIAGNOSTIC_KERNEL_ONLY');
        expect(exported).toContain('DIAGNOSTIC_STDERR_ONLY');
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        await panel.getByRole('button', { name: 'Clear terminal', exact: true }).click();
        await expect(panel.locator('.terminal-screen')).not.toContainText('裝置✓');
        await expect(panel.locator('.xterm-accessibility-tree')).toContainText('/tmp $');
        await expect
            .poll(() =>
                panel
                    .locator('.xterm-accessibility-tree')
                    .evaluate((element) =>
                        [...element.children].map((row) => row.textContent!.trim()).filter(Boolean),
                    ),
            )
            .toEqual(['/tmp $']);
        await input.focus();
        await page.keyboard.press('Control+l');
        await expect(panel.locator('.xterm-accessibility-tree')).toContainText('/tmp $');
        await expect
            .poll(() => Buffer.concat(gateway.terminal.inputs).toString())
            .toContain('\x0c');
        expect(gateway.terminal.opens).toBe(1);
        await page.keyboard.type('exit');
        await page.keyboard.press('Enter');
        await expect(panel.locator('.terminal-screen')).toContainText('Shell restarted.');
        await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
        await expect(input).toBeFocused();
        expect(gateway.terminal.opens).toBe(2);
        expect(gateway.authentications()).toBe(attempts);
        await expect(panel.locator('.terminal-screen')).toContainText('/tmp $');
        await expect(panel.locator('.xterm-cursor').locator('..')).toContainText(
            '/home/engineer $',
        );
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await expect(
            panel.getByRole('button', { name: 'Clear terminal', exact: true }),
        ).toBeDisabled();
        await expect.poll(() => gateway.terminal.closes).toBe(2);
    } finally {
        await gateway.close();
    }
});

test('shell recovery preserves history, discards pending input, resets modes and ignores stale events', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    const input = page.getByLabel('Device terminal input');
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    const oldId = await page.evaluate(() => window.desktopTest.terminal!.id);
    await page.evaluate(async () => {
        const terminal = window.desktopTest.terminal!;
        await terminal.emit('\r\nHISTORY_BEFORE_EXIT\r\n\x1b[?1049h\x1b[?1;2004h');
        document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!.focus();
        // Queue paste and end the shell in the same task, before the 20 ms input batch.
        const clipboard = new DataTransfer();
        clipboard.setData('text/plain', 'QUEUED_ONLY');
        document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!.dispatchEvent(
            new ClipboardEvent('paste', {
                clipboardData: clipboard,
                bubbles: true,
                cancelable: true,
            }),
        );
        await terminal.end();
    });
    await expect.poll(() => page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(2);
    await expect(panel.locator('.terminal-screen')).toContainText('HISTORY_BEFORE_EXIT');
    await expect(panel.locator('.terminal-screen')).toContainText('Shell restarted.');
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs)).toEqual([]);
    await page.evaluate((id) => window.desktopTest.terminal!.end('closed', id), oldId);
    await page.keyboard.press('ArrowUp');
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.terminal!.inputs.join('')))
        .toBe('\x1b[A');
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(2);
    await page.evaluate(async () => {
        await window.desktopTest.terminal!.emit(
            '\r\nHISTORY_BEFORE_SECOND_EXIT\r\n/home/engineer $ ',
        );
        await window.desktopTest.terminal!.end();
    });
    await expect.poll(() => page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(3);
    await expect(panel.locator('.terminal-screen')).toContainText('HISTORY_BEFORE_EXIT');
    await expect(panel.locator('.terminal-screen')).toContainText('HISTORY_BEFORE_SECOND_EXIT');
    await expect(input).toBeFocused();
});

test('recovery pauses behind a modal, does not steal hidden-tab focus and cancels on disconnect', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await page.evaluate(() => window.desktopTest.terminal!.end());
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(1);
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    await expect.poll(() => page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(2);
    await expect(page.getByLabel('Device terminal input')).toBeFocused();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.evaluate(() => window.desktopTest.terminal!.end());
    await expect.poll(() => page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(3);
    await expect(page.getByLabel('Device terminal input')).not.toBeFocused();
    await page.evaluate(async () => {
        await window.desktopTest.terminal!.end();
        window.desktopTest.closeConnection!();
    });
    await expect(
        page.getByRole('button', { name: 'Disconnect device', exact: true }),
    ).not.toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(3);
});

test('shell recovery stops on refusal, stream errors and repeated rapid closure', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
        window.desktopTest.terminal!.refuseNextOpen = true;
        await window.desktopTest.terminal!.end();
    });
    await expect(panel.getByRole('alert')).toContainText('refused');
    await expect(panel.getByText('Unavailable', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(2);
    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    await page.evaluate(() => window.desktopTest.terminal!.end('error'));
    await expect(panel.getByRole('alert')).toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(3);
    await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    for (let opens = 5; opens <= 7; opens++) {
        await page.evaluate(() => window.desktopTest.terminal!.end());
        await expect
            .poll(() => page.evaluate(() => window.desktopTest.terminal!.opens))
            .toBe(opens);
        await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    }
    await page.evaluate(() => window.desktopTest.terminal!.end());
    await expect(panel.getByRole('alert')).toContainText('keeps ending');
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(7);
    await expect(
        page.getByRole('button', { name: 'Disconnect device', exact: true }),
    ).toBeVisible();
});

test('terminal starts on connection and supports animated copy, selection menu, paste and xterm keymap', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await connectDesktop(page);
    await expect.poll(() => page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(1);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /(?:Open|Close) terminal/ })).toHaveCount(0);
    await expect(panel.locator('.terminal-prompt-color').first()).toBeAttached();
    await expect(panel.locator('.terminal-duck')).toBeVisible();
    await expect(panel.locator('.terminal-pig')).toBeVisible();
    await expect(panel.locator('.terminal-trees')).toBeVisible();
    await expect(panel.locator('.terminal-earth')).toBeVisible();
    const earth = page.locator('.terminal-earth-continents');
    expect(await earth.evaluate((element) => getComputedStyle(element).animationDuration)).toBe(
        '1s',
    );
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    expect(await earth.evaluate((element) => getComputedStyle(element).animationPlayState)).toBe(
        'paused',
    );
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    expect(await earth.evaluate((element) => getComputedStyle(element).animationPlayState)).toBe(
        'running',
    );
    expect(
        await panel
            .locator('.terminal-duck')
            .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('duck-play');
    await panel.getByRole('button', { name: 'Copy terminal text' }).click();
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.clipboard))
        .toBe('/home/engineer $ ');
    await expect(panel.getByText('Copied!', { exact: true })).toBeVisible();
    expect(
        await panel
            .locator('.copy-feedback')
            .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('copied-rise');
    const screen = await panel.locator('.xterm-screen').boundingBox();
    await page.mouse.move(screen!.x + 1, screen!.y + 8);
    await page.mouse.down();
    await page.mouse.move(screen!.x + 90, screen!.y + 8, { steps: 10 });
    await page.mouse.up();
    const menu = panel.getByRole('menu', { name: 'Terminal clipboard' });
    await expect(menu).not.toBeVisible();
    await expect(panel.locator('.xterm-selection div').first()).toBeVisible();
    await page.mouse.click(screen!.x + 60, screen!.y + 8, { button: 'right' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await expect(menu).not.toBeVisible();
    const selection = await page.evaluate(() => window.desktopTest.clipboard!);
    expect(selection).toContain('/home');
    const input = page.getByLabel('Device terminal input');
    await input.focus();
    const before = await page.evaluate(() => window.desktopTest.terminal!.inputs.join(''));
    await page.keyboard.press('Control+c');
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs.join(''))).toBe(before);
    expect(await page.evaluate(() => window.desktopTest.clipboard)).toBe(selection);
    await panel.getByRole('button', { name: 'Clear terminal', exact: true }).click();
    await expect(input).toBeFocused();
    await page.evaluate(() => {
        window.desktopTest.clipboard = 'echo PASTE_FROM_CLIPBOARD\npwd\n';
    });
    await page.keyboard.press('Control+v');
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.terminal!.inputs.join('')))
        .toContain('echo PASTE_FROM_CLIPBOARD\rpwd\r');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+e');
    await page.keyboard.press('Control+u');
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Control+r');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+c');
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.terminal!.inputs.join('')))
        .toContain('\x01\x05\x15\x0b\x12\x1b[D\x1b[C\x03');
    await panel.locator('.terminal-screen').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.evaluate(() => {
        window.desktopTest.clipboard = 'echo MENU_PASTE\r';
    });
    await menu.getByRole('menuitem', { name: 'Paste', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.terminal!.inputs.join('')))
        .toContain('echo MENU_PASTE\r');
    await page.screenshot({ path: 'validation/terminal-refinements-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.locator('.terminal-duck')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
        true,
    );
    await page.screenshot({ path: 'validation/terminal-refinements-mobile.png', fullPage: true });
});

test('prompt color follows split redraws, remote colors, clear, continuation and resize', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    const renderedPrompt = (text: string) =>
        panel.locator('.xterm-rows > div').filter({ hasText: text }).last();
    const colors = async (text: string) =>
        renderedPrompt(text)
            .locator('span')
            .evaluateAll(
                (spans, length) =>
                    spans
                        .flatMap((span) =>
                            [...span.textContent!].map(() => getComputedStyle(span).color),
                        )
                        .slice(0, length),
                text.length,
            );
    const mint = 'rgb(131, 217, 176)';
    const emit = (text: string) =>
        page.evaluate((data) => window.desktopTest.terminal!.emit(data), text);
    const check = (text: string) =>
        expect.poll(() => colors(text)).toEqual(Array(text.length).fill(mint));
    await check('/home/engineer $ ');
    await emit('\r\x1b[2Kdev $ ');
    await check('dev $ ');
    await emit('\r\x1b[2Kengineer@board:/usr/local');
    await expect(panel.locator('.terminal-prompt-color')).toHaveCount(0);
    await emit('/bin $ ');
    await check('engineer@board:/usr/local/bin $ ');
    await emit('\r\x1b[2K\x1b[38;2;210;140;240mremote $ \x1b[0m');
    await expect.poll(() => colors('remote $ ')).toEqual(Array(9).fill('rgb(210, 140, 240)'));
    await expect(panel.locator('.terminal-prompt-color')).toHaveCount(0);
    await emit('\r\x1b[2Kplain $ \r\n> ');
    await check('> ');
    await emit('\x1b[H\x1b[2J> ');
    await check('> ');
    await panel.getByRole('button', { name: 'Clear terminal', exact: true }).click();
    await check('> ');
    await emit('\r\x1b[2Kboard:/tmp $ ');
    await check('board:/tmp $ ');
    await emit('\x1b[?1049h\x1b[HALT_SCREEN');
    await expect.poll(() => colors('ALT_SCREEN')).toEqual(Array(10).fill('rgb(231, 237, 244)'));
    await emit('\x1b[?1049l');
    await check('board:/tmp $ ');
    await page.setViewportSize({ width: 390, height: 844 });
    await check('board:/tmp $ ');
    await emit(
        '\r\n' + Array.from({ length: 400 }, (_, i) => `history-${i}\r\n`).join('') + 'final $ ',
    );
    await check('final $ ');
    await panel.locator('.terminal-frame').scrollIntoViewIfNeeded();
    await page.getByLabel('Device terminal input').focus();
    for (let i = 0; i < 25; i++) await page.keyboard.press('Shift+PageUp');
    await check('board:/tmp $ ');
});

test('connection form drag selection released on backdrop stays open; direct backdrop click dismisses', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect a Linux device' });
    const field = dialog.getByLabel('Hostname or IP address');
    await field.fill('drag-selection-device');
    const box = await field.boundingBox();
    await page.mouse.move(box!.x + 24, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(5, 5, { steps: 15 });
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    await expect(field).toHaveValue('drag-selection-device');
    await page.mouse.click(5, 5);
    await expect(dialog).not.toBeVisible();
});

test('terminal shows a scrollbar only for real scrollback, including startup and clear', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    const viewport = panel.locator('.xterm-viewport');
    const scrollbar = panel.locator('.xterm-scrollable-element > .scrollbar.vertical');
    const nativeGutter = () =>
        viewport.evaluate((element) => (element as HTMLElement).offsetWidth - element.clientWidth);
    await expect(viewport).not.toHaveCSS('overflow-y', 'scroll');
    await expect.poll(nativeGutter).toBe(0);
    await panel.locator('.xterm-screen').hover();
    await expect(scrollbar).toHaveCSS('opacity', '0');
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    await expect(panel.locator('.xterm-rows')).toContainText('/home/engineer $');
    await panel.locator('.xterm-screen').hover();
    await expect.poll(nativeGutter).toBe(0);
    await expect(scrollbar).toHaveCSS('opacity', '0');
    await page.evaluate(() =>
        window.desktopTest.terminal!.emit(
            '\r\n' +
                Array.from({ length: 400 }, (_, i) => `scrollbar-output-${i}\r\n`).join('') +
                '/home/engineer $ ',
        ),
    );
    await expect(panel.locator('.xterm-rows')).toContainText('scrollbar-output-399');
    await panel.locator('.xterm-screen').hover();
    await expect(scrollbar).toHaveCSS('opacity', '1');
    await expect.poll(nativeGutter).toBe(0);
    await panel.getByRole('button', { name: 'Clear terminal', exact: true }).click();
    await expect(page.getByLabel('Device terminal input')).toBeFocused();
    await panel.locator('.xterm-screen').hover();
    await expect(scrollbar).toHaveCSS('opacity', '0');
    await expect.poll(nativeGutter).toBe(0);
});

test('full terminal viewport contains the last prompt and wheel input at both scrollback boundaries', async ({
    page,
}) => {
    await installDesktop(page);
    await page.goto('/');
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
    await page.evaluate(() =>
        window.desktopTest.terminal!.emit(
            '\r\n' +
                Array.from({ length: 400 }, (_, i) => `output-${i}\r\n`).join('') +
                '/home/engineer $ ',
        ),
    );
    const input = page.getByLabel('Device terminal input');
    await input.focus();
    await panel.locator('.terminal-frame').scrollIntoViewIfNeeded();
    await expect(panel.locator('.xterm-cursor')).toBeAttached();
    const bounds = await panel.locator('.terminal-frame').boundingBox();
    const screen = await panel.locator('.xterm-screen').boundingBox();
    const cursor = await panel.locator('.xterm-cursor').boundingBox();
    expect(screen!.y + screen!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height - 8);
    expect(cursor!.y + cursor!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height - 8);
    const before = await page.evaluate(() => scrollY);
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.wheel(0, 800);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(before);
    for (let i = 0; i < 25; i++) await page.keyboard.press('Shift+PageUp');
    await expect(panel.locator('.xterm-rows')).toContainText('output-0');
    await panel.locator('.xterm-screen').hover();
    await page.mouse.wheel(0, -800);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(before);
    for (let i = 0; i < 25; i++) await page.keyboard.press('Shift+PageDown');
    await expect(panel.locator('.xterm-rows')).toContainText('output-399');
    await page.mouse.wheel(0, 800);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(before);
    await panel.getByRole('button', { name: 'Clear terminal' }).click();
    await expect(input).toBeFocused();
    await expect
        .poll(() =>
            panel
                .locator('.xterm-accessibility-tree')
                .evaluate((element) =>
                    [...element.children].map((row) => row.textContent!.trim()).filter(Boolean),
                ),
        )
        .toEqual(['/home/engineer $']);
    await page.evaluate(() => window.scrollTo(0, 0));
    const short = await panel.locator('.terminal-screen').boundingBox();
    await page.mouse.move(short!.x + 50, short!.y + 30);
    const inputs = await page.evaluate(() => window.desktopTest.terminal!.inputs.join(''));
    await page.mouse.wheel(0, 200);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs.join(''))).toBe(inputs);
    // A full-screen application still owns wheel input even without normal-buffer history.
    await page.evaluate(() => window.desktopTest.terminal!.emit('\x1b[?1049h\x1b[?1h'));
    const alt = await panel.locator('.terminal-screen').boundingBox();
    await page.mouse.move(alt!.x + 50, alt!.y + 30);
    const position = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 200);
    await expect
        .poll(() => page.evaluate(() => window.desktopTest.terminal!.inputs.join('')))
        .toContain('\x1bOB');
    expect(await page.evaluate(() => scrollY)).toBe(position);
});

test('pixel ball reaches each front foot at the shared kick times', async ({ page }) => {
    await installDesktop(page);
    await page.goto('/');
    await connectDesktop(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const frame = page.locator('.terminal-frame');
    const contacts = await frame.evaluate((element) => {
        const duck = element.querySelector<SVGGraphicsElement>('.terminal-duck')!;
        const pig = element.querySelector<SVGGraphicsElement>('.terminal-pig')!;
        const ball = element.querySelector<SVGGraphicsElement>('.terminal-play-ball')!;
        const sprites = [duck, pig, ball];
        const animations = sprites.map((sprite) => sprite.getAnimations()[0]);
        animations.forEach((animation) => animation.pause());
        const scale =
            element.querySelector('.terminal-landscape')!.getBoundingClientRect().width / 320;
        const sample = (progress: number) => {
            animations.forEach((animation) => {
                animation.currentTime = 7000 * progress;
            });
            const d = duck.getBoundingClientRect(),
                p = pig.getBoundingClientRect(),
                b = ball.getBoundingClientRect();
            // Front feet occupy x=18..24 on duck and x=10..16 on pig in local SVG units.
            return {
                duckGap: (b.left - (d.left + 24 * scale)) / scale,
                pigGap: (p.left + 10 * scale - b.right) / scale,
                bottom: b.bottom,
                duckBottom: d.bottom,
                pigBottom: p.bottom,
            };
        };
        const result = [sample(0), sample(0.5)];
        animations.forEach((animation) => animation.play());
        return result;
    });
    expect(Math.abs(contacts[0].duckGap)).toBeLessThanOrEqual(3);
    expect(Math.abs(contacts[1].pigGap)).toBeLessThanOrEqual(3);
    expect(contacts[0].bottom).toBeGreaterThan(contacts[0].duckBottom - 4);
    expect(contacts[1].bottom).toBeGreaterThan(contacts[1].pigBottom - 4);
});

test('actual Bash PTY handles continuations, subshells, loops and Ctrl+L cursor redraw', async ({
    page,
}) => {
    test.skip(
        !process.env.HUB_BASH_PTY_TEST,
        'Opt-in local Bash PTY qualification needs the local demo adapter.',
    );
    const adapter = await import(`${process.cwd()}/.codex/bash-shell.cjs`);
    const gateway = await gatewayFixture(undefined, { attachShell: adapter.attachBashShell });
    try {
        await page.goto('/');
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('Gateway HTTPS address').fill(gateway.url);
        await modal.getByLabel('Gateway access token').fill(gateway.token);
        await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
        await modal.getByLabel('Port', { exact: true }).fill(String(gateway.options.port));
        await modal.getByLabel('SSH username').fill('engineer');
        await modal.getByLabel('Password', { exact: true }).fill(gateway.options.password);
        await modal.getByRole('button', { name: 'Read fingerprint' }).click();
        await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(modal).not.toBeVisible({ timeout: 20000 });
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        const panel = page.getByRole('region', { name: 'Connected device terminal' });
        await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
        const rows = panel.locator('.xterm-rows');
        const input = page.getByLabel('Device terminal input');
        await input.focus();
        const enter = async (command: string) => {
            await page.keyboard.type(command);
            await page.keyboard.press('Enter');
        };
        await enter('cd /tmp');
        await expect(rows).toContainText('/tmp $');
        await enter("printf 'CONT_%s\\n' \\");
        await expect(panel.locator('.xterm-cursor').locator('..')).toContainText('> ');
        await page.keyboard.press('Control+l');
        // Cursor and continuation prompt must occupy the same actual rendered row after redraw.
        await expect(panel.locator('.xterm-cursor').locator('..')).toContainText('> ');
        await enter('OK');
        await expect(rows).toContainText('CONT_OK');
        await enter('(');
        await expect(panel.locator('.xterm-cursor').locator('..')).toContainText('> ');
        await enter('echo SUBSHELL_OK');
        await enter(')');
        await expect(rows).toContainText('SUBSHELL_OK');
        await enter('for word in one two; do');
        await expect(panel.locator('.xterm-cursor').locator('..')).toContainText('> ');
        await enter('printf \'LOOP_%s\\n\' "$word"');
        await enter('done');
        await expect(rows).toContainText('LOOP_one');
        await expect(rows).toContainText('LOOP_two');
        await page.keyboard.type('echo EDIT_ME');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Control+l');
        await expect(panel.locator('.xterm-cursor').locator('..')).toContainText(
            '/tmp $ echo EDIT_ME',
        );
        await page.keyboard.press('Control+c');
        await expect
            .poll(() => panel.locator('.xterm-cursor').locator('..').textContent())
            .toMatch(/^\/tmp \$ /);
        await enter("printf 'ROW_%s\\n' {1..80}");
        await expect(rows).toContainText('ROW_80');
        await page.keyboard.press('Control+l');
        await expect
            .poll(() =>
                rows
                    .locator(':scope > div')
                    .evaluateAll((elements) =>
                        elements.map((row) => row.textContent!.trim()).filter(Boolean),
                    ),
            )
            .toEqual(['/tmp $']);
        await expect(panel.locator('.xterm-cursor').locator('..')).toContainText('/tmp $');
        await panel.getByRole('button', { name: 'Clear terminal' }).click();
        await expect(input).toBeFocused();
        await page.screenshot({ path: 'validation/terminal-bash-redraw.png', fullPage: true });
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
    } finally {
        await gateway.close();
    }
});
