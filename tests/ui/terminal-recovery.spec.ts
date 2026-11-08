import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';

// Isolated mocked recovery cohort; no gateway/server/device fixture import.
async function connectDesktop(page: Page) {
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Hostname or IP address').fill('active-device');
    await modal.getByLabel('SSH username').fill('engineer');
    await modal.getByLabel('Password', { exact: true }).fill('test-password');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
}

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
