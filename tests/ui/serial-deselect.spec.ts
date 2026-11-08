import { expect, test, type Locator, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { installSerial } from './fixtures/serial';
import { installSerialCustody } from './fixtures/serial-custody';

const labels = ['Baud rate', 'Data bits', 'Parity', 'Stop bits', 'Flow control'];
const framing = ['57600', '7', 'even', '2', 'hardware'];
async function open(page: Page, heldClose: boolean) {
    await installDesktop(page);
    if (heldClose) await installSerialCustody(page);
    else await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal', exact: true });
    for (let i = 0; i < labels.length; i++)
        await serial.getByLabel(labels[i], { exact: true }).selectOption(framing[i]);
    const port = serial.getByLabel('Local serial port', { exact: true });
    await expect(port.locator('option')).toHaveCount(2);
    await port.selectOption('0');
    return { serial, port };
}
async function restored(serial: Locator, port: Locator) {
    await expect(serial.getByText('No local port selected', { exact: true })).toBeVisible();
    await expect(port).toBeEnabled();
    await expect(port).toHaveValue('-1');
    await expect(serial.getByRole('button', { name: /^Choose port/ })).toBeEnabled();
    await expect(serial.getByRole('button', { name: 'Deselect', exact: true })).toBeDisabled();
    await expect(serial.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    for (let i = 0; i < labels.length; i++) {
        await expect(serial.getByLabel(labels[i], { exact: true })).toBeEnabled();
        await expect(serial.getByLabel(labels[i], { exact: true })).toHaveValue(framing[i]);
    }
}

test('Serial selected-only Deselect restores framing controls without opening a port', async ({
    page,
}) => {
    const { serial, port } = await open(page, false);
    await expect(serial.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    await serial.getByRole('button', { name: 'Deselect', exact: true }).click();
    await restored(serial, port);
    expect(
        await page.evaluate(() => ({
            opens: window.serialTest.opens,
            closes: window.serialTest.closes,
            writes: window.serialTest.writes,
        })),
    ).toEqual({ opens: 0, closes: 0, writes: [] });
    await port.selectOption('0');
    await expect(serial.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(0);
    expect(await page.evaluate(() => window.desktopTest.clock.calls)).toBe(0);
});

test('Serial connected Deselect retains its selection until close acknowledgement then restores framing', async ({
    page,
}) => {
    const { serial, port } = await open(page, true);
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Device time', exact: true })).toContainText(
        'SSH disconnected',
    );
    await serial.getByRole('button', { name: 'Deselect', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.serialCustodyTest.closes)).toBe(1);
    let assertionFailed = false;
    try {
        await expect(port).toHaveValue('0');
        await expect(port).toBeDisabled();
        await expect(serial.getByRole('button', { name: 'Deselect', exact: true })).toBeDisabled();
        await expect(serial.getByRole('button', { name: /^Choose port/ })).toBeDisabled();
        for (let i = 0; i < labels.length; i++) {
            await expect(serial.getByLabel(labels[i], { exact: true })).toBeDisabled();
            await expect(serial.getByLabel(labels[i], { exact: true })).toHaveValue(framing[i]);
        }
        expect(
            await page.evaluate(() => ({
                opens: window.serialCustodyTest.opens,
                closes: window.serialCustodyTest.closes,
                closeAcks: window.serialCustodyTest.closeAcks,
                writes: window.serialCustodyTest.writes,
            })),
        ).toEqual({ opens: 1, closes: 1, closeAcks: 0, writes: [] });
    } catch (error) {
        assertionFailed = true;
        throw error;
    } finally {
        // Release only the test-owned fake acknowledgement, preserving any primary assertion error.
        try {
            await page.evaluate(() => window.serialCustodyTest.acknowledgeClose());
        } catch (error) {
            if (!assertionFailed) throw error;
        }
    }
    await restored(serial, port);
    expect(
        await page.evaluate(() => ({
            opens: window.serialCustodyTest.opens,
            closes: window.serialCustodyTest.closes,
            closeAcks: window.serialCustodyTest.closeAcks,
            readerCancels: window.serialCustodyTest.readerCancels,
            aborts: window.serialCustodyTest.aborts,
            writes: window.serialCustodyTest.writes,
        })),
    ).toEqual({ opens: 1, closes: 1, closeAcks: 1, readerCancels: 1, aborts: 1, writes: [] });
    expect(await page.evaluate(() => window.desktopTest.clock.calls)).toBe(0);
});
