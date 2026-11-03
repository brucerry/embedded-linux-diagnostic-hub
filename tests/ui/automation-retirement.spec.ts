import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { installSerialCustody } from './fixtures/serial-custody';

async function prepare(page: Page) {
    await installDesktop(page);
    await installSerialCustody(page);
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
    await flow.getByLabel('Serial automation line ending').selectOption('CR');
    const stage = (name: string) => flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) }).click();
    await stage('Commands');
    await flow.getByLabel('Step 1 name (optional)').fill('Held command');
    await flow.getByLabel('Command 1 script').fill('FIRST');
    await flow.getByRole('button', { name: 'Add command', exact: true }).click();
    await flow.getByLabel('Step 2 name (optional)').fill('Never sent');
    await flow.getByLabel('Command 2 script').fill('NEVER_SEND');
    await stage('Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.serialCustodyTest.writes))
        .toEqual([[70, 73, 82, 83, 84, 13]]);
    return { flow, serial, start: flow.getByRole('button', { name: 'Run once', exact: true }) };
}

const custody = (page: Page) => page.evaluate(() => {
    const s = window.serialCustodyTest;
    return { writeAcks: s.writeAcks, closes: s.closes, closeAcks: s.closeAcks,
        releases: s.releases, leases: s.leases, writes: s.writes.length };
});

test('Serial Cancel after dispatch joins the pending write and port close before releasing its lease', async ({ page }) => {
    const { flow, start } = await prepare(page);
    await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
    await expect(start).toBeDisabled();
    await expect(flow.getByRole('status')).toContainText('Finishing Serial input retirement');
    expect(await custody(page)).toEqual({ writeAcks: 0, closes: 0, closeAcks: 0,
        releases: [], leases: ['serial-custody-1'], writes: 1 });
    await page.evaluate(() => window.serialCustodyTest.acknowledgeWrite());
    await expect.poll(async () => (await custody(page)).closes).toBe(1);
    expect(await custody(page)).toEqual({ writeAcks: 1, closes: 1, closeAcks: 0,
        releases: [], leases: ['serial-custody-1'], writes: 1 });
    await expect(start).toBeDisabled();
    await page.evaluate(() => window.serialCustodyTest.acknowledgeClose());
    await expect.poll(async () => (await custody(page)).releases).toEqual(['serial-custody-1']);
    await expect(flow.getByRole('status')).toContainText('Flow cancelled');
    const rows = flow.getByLabel('Stored Serial captures', { exact: true }).locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Held command');
    await expect(rows).toContainText('cancelled');
    expect((await custody(page)).writes).toBe(1);
});

test('Serial recoverable break retains the port while explicit Disconnect joins held write and close acknowledgements', async ({ page }) => {
    const { flow, serial, start } = await prepare(page);
    await page.evaluate(() => window.serialCustodyTest.push('retained output\r\n'));
    // Observe the real fixture repository append acknowledgement, not catalog refresh timing.
    await expect.poll(() => page.evaluate(() => window.serialCustodyTest.appendAcks)).toBe(1);
    await page.evaluate(() => window.serialCustodyTest.recoverBreak());
    await expect.poll(() => page.evaluate(() => window.serialCustodyTest.readers)).toBe(2);
    expect(await custody(page)).toEqual({ writeAcks: 0, closes: 0, closeAcks: 0,
        releases: [], leases: ['serial-custody-1'], writes: 1 });
    await expect(start).toBeDisabled();
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    await expect(serial.getByRole('alert')).toContainText('Port retained; input blocked');
    const disconnect = serial.getByRole('button', { name: 'Disconnect', exact: true });
    await expect(disconnect).toBeEnabled();
    await disconnect.click();
    await expect(disconnect).toBeDisabled();
    expect((await custody(page)).closes).toBe(0);
    await page.evaluate(() => window.serialCustodyTest.acknowledgeWrite());
    await expect.poll(async () => (await custody(page)).closes).toBe(1);
    expect((await custody(page)).releases).toEqual([]);
    expect((await custody(page)).closeAcks).toBe(0);
    await page.evaluate(() => window.serialCustodyTest.acknowledgeClose());
    await expect.poll(async () => (await custody(page)).releases).toEqual(['serial-custody-1']);
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    await expect(flow.getByRole('status')).toContainText('UART BreakError');
    await expect(flow.getByRole('status')).toContainText('Requested port cleanup acknowledged');
    const rows = flow.getByLabel('Stored Serial captures', { exact: true }).locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('retained output');
    await expect(rows).toContainText('transport-error');
    expect(await page.evaluate(() => ({ opens: window.serialCustodyTest.opens,
        writes: window.serialCustodyTest.writes })))
        .toEqual({ opens: 1, writes: [[70, 73, 82, 83, 84, 13]] });
});
