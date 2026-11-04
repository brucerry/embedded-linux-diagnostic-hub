import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { terminalId, terminalSize } from '../../shared/terminal';
import { installDesktop } from './fixtures/desktop';
import { installTerminalResizeOwner } from './fixtures/terminal-resize-owner';

async function connect(page: Page) {
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Hostname or IP address').fill('active-device');
    await dialog.getByLabel('SSH username').fill('engineer');
    await dialog.getByLabel('Password', { exact: true }).fill('test-password');
    await dialog.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(dialog).not.toBeVisible();
}
async function paste(page: Page) {
    const panel = page.getByRole('region', { name: 'Connected device terminal' });
    await panel.locator('.terminal-screen').click({ button: 'right' });
    await panel.getByRole('menu', { name: 'Terminal clipboard' })
        .getByRole('menuitem', { name: 'Paste', exact: true }).click();
}
async function observation(page: Page) {
    return page.evaluate(() => {
        const state = window.terminalResizeOwnerTest, host = window.desktopTest;
        return {
            calls: state.calls.map(value => ({ ...value })), held: state.held,
            pending: state.pending, armed: state.armed, rejected: state.rejected,
            staleAlertSeen: state.staleAlertSeen, observationEvents: state.observationEvents,
            observing: state.observing, currentId: host.terminal!.id,
            opens: host.terminal!.opens, closes: host.terminal!.closes,
            inputBytes: host.terminal!.inputs.join('').length,
            connects: host.connects, disconnects: host.disconnects,
        };
    });
}
async function attach(page: Page, info: TestInfo) {
    const body = JSON.stringify(await observation(page));
    if (Buffer.byteLength(body) > 4096) throw Error('Synthetic resize observation exceeds 4 KiB.');
    await info.attach('terminal-resize-owner-observation', {
        body: Buffer.from(body), contentType: 'application/json',
    });
}

test('old resize failure cannot replace a reconnected terminal diagnostic', async ({ page }, info) => {
    await installDesktop(page);
    await page.goto('/');
    await installTerminalResizeOwner(page);
    try {
        await connect(page);
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        const panel = page.getByRole('region', { name: 'Connected device terminal' });
        await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
        const before = await page.evaluate(() => ({
            id: window.desktopTest.terminal!.id,
            size: window.desktopTest.terminal!.sizes.at(-1)!,
        }));
        terminalId(before.id); terminalSize(before.size);
        await page.evaluate(({ id, size }) => window.terminalResizeOwnerTest.arm(id, size), before);
        await page.setViewportSize({ width: 1100, height: 850 });
        // Observe actual fit/debounce admission, not a guessed delay or fabricated resize event.
        await expect.poll(async () => (await observation(page)).pending).toBe(true);
        const held = (await observation(page)).held!;
        expect(held.id).toBe(before.id); terminalSize(held);
        expect(held.cols !== before.size.cols || held.rows !== before.size.rows).toBe(true);
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await expect(panel).toContainText('No device connected');
        await connect(page);
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
        const replacement = (await observation(page)).currentId;
        terminalId(replacement); expect(replacement).not.toBe(before.id);

        // Establish a real, visible current-session error that valid paste does not clear.
        await page.evaluate(() => { window.desktopTest.clipboard = 'x'.repeat(256 * 1024 + 1); });
        await paste(page);
        const currentError = 'Clipboard text exceeds the terminal paste limit.';
        await expect(panel.getByRole('alert')).toHaveText(currentError);
        await page.evaluate(() => {
            window.terminalResizeOwnerTest.observeAlerts();
            window.terminalResizeOwnerTest.rejectHeld();
        });
        // Positive new-session queue acknowledgement after rejecting the old request.
        // This follows the existing clipboard regression's public UI/queue barrier.
        await page.evaluate(() => { window.desktopTest.clipboard = 'CURRENT_RESIZE_SESSION\r'; });
        await paste(page);
        await expect.poll(() => page.evaluate(() =>
            window.desktopTest.terminal!.inputs.join(''))).toBe('CURRENT_RESIZE_SESSION\r');
        await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
        await expect(panel.getByRole('alert')).toHaveText(currentError);
        const final = await observation(page);
        expect(final).toMatchObject({ pending: false, armed: false, rejected: 1,
            staleAlertSeen: false, observing: true, currentId: replacement,
            opens: 2, closes: 1, connects: 2, disconnects: 1, inputBytes: 23 });
        expect(final.calls.length).toBeLessThanOrEqual(32);
        expect(final.held!.id).toBe(before.id);
        await page.evaluate(() => window.terminalResizeOwnerTest.stopObserving());
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await expect(panel).toContainText('No device connected');
        expect(await observation(page)).toMatchObject({ observing: false, pending: false,
            rejected: 1, staleAlertSeen: false, opens: 2, closes: 2, disconnects: 2 });
        await attach(page, info);
    } catch (error) {
        // Keep the assertion and any pending gate truthful; no auto-reject or fake teardown.
        try { await attach(page, info); } catch {}
        throw error;
    }
});
