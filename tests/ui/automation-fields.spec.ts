import { expect, test, type Locator, type Page } from '@playwright/test';
import { installSerial } from './fixtures/serial';
const stage = (flow: Locator, name: string) =>
    flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
async function errorText(page: Page, field: Locator) {
    const id = await field.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    return page.locator('[id="' + id + '"]');
}
async function open(page: Page) {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    return page.getByRole('region', { name: 'Automation', exact: true });
}
test('Next validates commands and numeric fields with associated errors, stable geometry and first-invalid focus', async ({
    page,
}) => {
    const flow = await open(page);
    await stage(flow, 'Commands');
    const command = flow.getByLabel('Command 1 script');
    await expect(command).not.toHaveAttribute('aria-invalid', 'true');
    await expect(command).toHaveAttribute('aria-required', 'true');
    const before = await command.boundingBox();
    const beforePageTop = before!.y + (await page.evaluate(() => scrollY));
    await flow.getByRole('button', { name: 'Next: Timing', exact: true }).focus();
    await flow.getByRole('button', { name: 'Next: Timing', exact: true }).press('Enter');
    await expect(command).toBeFocused();
    await expect(command).toHaveAttribute('aria-invalid', 'true');
    await expect(await errorText(page, command)).toContainText('Enter a command');
    const after = await command.boundingBox();
    expect(after!.height).toBe(before!.height);
    expect(after!.y + (await page.evaluate(() => scrollY))).toBe(beforePageTop);
    await command.fill('echo fixture');
    await expect(command).not.toHaveAttribute('aria-invalid', 'true');
    await flow.getByRole('button', { name: 'Next: Timing', exact: true }).click();
    const timeout = flow.getByLabel('Command timeout');
    await timeout.fill('');
    await timeout.press('Tab');
    await expect(timeout).toHaveAttribute('aria-invalid', 'true');
    await expect(await errorText(page, timeout)).toContainText('1–300');
    await timeout.fill('301');
    const delay = flow.getByLabel('Command 1 delay');
    await delay.fill('Infinity');
    await flow.getByRole('button', { name: 'Next: Review & Run', exact: true }).click();
    await expect(timeout).toBeFocused();
    await timeout.fill('60');
    await flow.getByRole('button', { name: 'Next: Review & Run', exact: true }).click();
    await expect(delay).toBeFocused();
    await expect(await errorText(page, delay)).toContainText('Step delay');
    await delay.fill('0.0000001');
    await expect(delay).not.toHaveAttribute('aria-invalid', 'true');
    await flow.getByLabel('Repeat completed flow').check();
    const repeat = flow.getByLabel('Repetition delay');
    await repeat.fill('0');
    await flow.getByRole('button', { name: 'Next: Review & Run', exact: true }).click();
    await expect(repeat).toBeFocused();
    await repeat.fill('1');
    await expect(repeat).not.toHaveAttribute('aria-invalid', 'true');
    await stage(flow, 'Commands');
    const enabled = flow.getByLabel('Enabled', { exact: true });
    await enabled.uncheck();
    await flow.getByRole('button', { name: 'Next: Timing', exact: true }).click();
    await expect(enabled).toBeFocused();
    await expect(enabled).toHaveAttribute('aria-invalid', 'true');
    await expect(await errorText(page, enabled)).toContainText('Enable at least one');
    await enabled.check();
    await expect(enabled).not.toHaveAttribute('aria-invalid', 'true');
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(0);
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(0);
});
test('Serial required prompt and optional prefix correct accessibly; Review opens advanced field and Enter-only needs framing', async ({
    page,
}) => {
    const flow = await open(page);
    await flow.getByLabel('Automation transport').selectOption('serial');
    const prompt = flow.getByLabel('Serial completion prompt');
    await flow.getByRole('button', { name: 'Next: Commands', exact: true }).click();
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveAttribute('aria-required', 'true');
    await expect(await errorText(page, prompt)).toContainText('prompt');
    await prompt.fill('# ');
    await expect(prompt).not.toHaveAttribute('aria-invalid', 'true');
    await flow.getByText('Advanced device timestamp extraction', { exact: true }).click();
    const prefix = flow.getByLabel('Serial timestamp prefix');
    await expect(prefix).not.toHaveAttribute('aria-required', 'true');
    await prefix.fill('');
    await prefix.press('Tab');
    await expect(prefix).not.toHaveAttribute('aria-invalid', 'true');
    await prefix.fill('x'.repeat(129));
    await prefix.press('Tab');
    await expect(prefix).toHaveAttribute('aria-invalid', 'true');
    await flow.getByText('Advanced device timestamp extraction', { exact: true }).click();
    await stage(flow, 'Review');
    await expect(flow.getByRole('button', { name: 'Start flow', exact: true })).toBeDisabled();
    await flow.getByRole('button', { name: 'Fix required fields', exact: true }).click();
    await expect(prefix).toBeFocused();
    await expect(prefix).toBeVisible();
    await expect(await errorText(page, prefix)).toContainText('128');
    await prefix.fill('');
    await flow.getByRole('button', { name: 'Next: Commands', exact: true }).click();
    await flow.getByLabel('Command 1 send Enter only').check();
    await stage(flow, 'Connection');
    await flow.getByLabel('Serial automation line ending').selectOption('none');
    await flow.getByRole('button', { name: 'Next: Commands', exact: true }).click();
    await expect(flow.getByLabel('Serial automation line ending')).toBeFocused();
    await expect(
        await errorText(page, flow.getByLabel('Serial automation line ending')),
    ).toContainText('CR');
    await flow.getByLabel('Serial automation line ending').selectOption('CR');
    await expect(flow.getByLabel('Serial automation line ending')).not.toHaveAttribute(
        'aria-invalid',
        'true',
    );
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(0);
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(0);
});
