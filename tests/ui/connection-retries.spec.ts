import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';

async function openConnection(page: Page) {
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    return page.getByRole('dialog', { name: 'Connect a Linux device' });
}

test('initial diagnostic failure leaves authenticated SSH and terminal available without re-login', async ({
    page,
}) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await page.evaluate(() => {
        window.diagnosticHub!.collect = async () => {
            throw Error('fixture collection failure');
        };
    });
    const modal = await openConnection(page);
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
        'SSH is connected, but diagnostic collection failed',
    );
    await page.clock.runFor(6000);
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
    expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(0);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(1);
});

test('temporary failure displays retry status and Cancel removes the pending attempt timer', async ({
    page,
}) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await page.evaluate(() => {
        window.diagnosticHub!.connect = async () => {
            window.desktopTest.connects++;
            throw Error('temporary network failure');
        };
    });
    const modal = await openConnection(page);
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal.getByRole('status')).toContainText('Retrying in 3 seconds');
    await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(modal).not.toBeVisible();
    await page.clock.runFor(10_000);
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
});

test('native authentication failure pauses for password correction rather than timer retries', async ({
    page,
}) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    await page.evaluate(() => {
        const connect = window.diagnosticHub!.connect;
        window.diagnosticHub!.connect = async (options) => {
            if (options.password !== 'corrected') {
                window.desktopTest.connects++;
                throw Error('HUB_CONNECTION_FAILURE:authentication');
            }
            return connect(options);
        };
    });
    const modal = await openConnection(page);
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal.getByRole('alert')).toContainText('Correct the credentials');
    await page.clock.runFor(10_000);
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(1);
    await modal.getByLabel('Password', { exact: true }).fill('corrected');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.connects)).toBe(2);
});

test('Cancel during an active handshake rejects its late ready completion', async ({ page }) => {
    await installDesktop(page);
    await page.goto('/');
    await page.evaluate(() => {
        let lateReady: () => void = () => {};
        window.diagnosticHub!.connect = () =>
            new Promise<void>((resolve) => {
                lateReady = resolve;
            });
        window.diagnosticHub!.cancelConnect = async () => {
            window.desktopTest.disconnects++;
            lateReady();
        };
    });
    const modal = await openConnection(page);
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal.getByRole('status')).toContainText('attempt 1');
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.desktopTest.disconnects)).toBe(1);
    expect(await page.evaluate(() => window.desktopTest.terminal!.opens)).toBe(0);
});
