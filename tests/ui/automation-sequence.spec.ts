import { expect, test, type Locator } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { installSerial } from './fixtures/serial';
import { installSshStream } from './fixtures/ssh-stream';

const stage = (flow: Locator, name: string) => flow
    .getByRole('navigation', { name: 'Automation setup steps' })
    .getByRole('button', { name: new RegExp(name) }).click();

test('Serial three-step Script Enter Script keeps armed bytes while the next draft changes', async ({ page }) => {
    await installDesktop(page);
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
    await flow.getByLabel('Serial automation line ending').selectOption('CR');
    await stage(flow, 'Commands');
    await flow.getByLabel('Step 1 name (optional)').fill('Script One');
    await flow.getByLabel('Command 1 script').fill('FIRST');
    await flow.getByRole('button', { name: 'Add command', exact: true }).click();
    await flow.getByLabel('Step 2 name (optional)').fill('Blank Enter');
    await flow.getByLabel('Command 2 send Enter only').check();
    await flow.getByRole('button', { name: 'Add command', exact: true }).click();
    await flow.getByLabel('Step 3 name (optional)').fill('Script Two');
    await flow.getByLabel('Command 3 script').fill('SECOND');
    await stage(flow, 'Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    const writes = () => page.evaluate(() => window.serialTest.writes);
    await expect.poll(writes).toEqual([[70, 73, 82, 83, 84, 13]]);
    // Hold completion at the actual synthetic reader; no timing-based delay is needed.
    await stage(flow, 'Commands');
    await flow.getByLabel('Command 3 script').fill('DRAFT_ONLY');
    expect(await writes()).toEqual([[70, 73, 82, 83, 84, 13]]);
    await page.evaluate(() => window.serialTest.push([...new TextEncoder().encode('one\r\nconsole# ')]));
    await expect.poll(writes).toEqual([[70, 73, 82, 83, 84, 13], [13]]);
    await page.evaluate(() => window.serialTest.push([...new TextEncoder().encode('enter reply\r\nconsole# ')]));
    await expect.poll(writes).toEqual([[70, 73, 82, 83, 84, 13], [13], [83, 69, 67, 79, 78, 68, 13]]);
    await page.evaluate(() => window.serialTest.push([...new TextEncoder().encode('two\r\nconsole# ')]));
    await expect(flow.getByRole('status')).toContainText('Flow finished');
    const results = flow.getByLabel('Stored Serial captures', { exact: true });
    const rows = results.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: 'Script One' })).toContainText('one');
    await expect(rows.filter({ hasText: 'Blank Enter' })).toContainText('enter reply');
    await expect(rows.filter({ hasText: 'Script Two' })).toContainText('two');
    await expect(results.locator('tbody')).not.toContainText('DRAFT_ONLY');
    expect(await writes()).toHaveLength(3);
    expect(await page.evaluate(() => ({ opens: window.serialTest.opens, readers: window.serialTest.readers })))
        .toEqual({ opens: 1, readers: 1 });
});

test('SSH three independent commands retain order and repeated command rows without terminal scraping', async ({ page }) => {
    await installDesktop(page);
    await installSshStream(page, { connection: 'sequence-fixture', stdout: 'sequence response', stderr: '', exitCode: 0 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await stage(flow, 'Commands');
    for (let index = 1; index <= 3; index++) {
        if (index > 1) await flow.getByRole('button', { name: 'Add command', exact: true }).click();
        await flow.getByLabel(`Step ${index} name (optional)`).fill(`SSH Step ${index}`);
        await flow.getByLabel(`Command ${index} script`).fill(index === 1 ? 'first command' : 'repeat command');
    }
    await stage(flow, 'Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect(flow.getByRole('status')).toContainText('Flow finished');
    expect(await page.evaluate(() => window.sshStreamTest.commands))
        .toEqual(['first command', 'repeat command', 'repeat command']);
    await expect.poll(() => page.evaluate(() => window.sshStreamTest.finalized)).toBe(3);
    const rows = flow.getByLabel('Stored SSH captures', { exact: true }).locator('tbody tr');
    await expect(rows).toHaveCount(3);
    for (let index = 0; index < 3; index++) await expect(rows.filter({ hasText: `SSH Step ${index + 1}` })).toHaveCount(1);
    expect(await page.evaluate(() => window.sshStreamTest.legacyCalls)).toBe(0);
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs)).toEqual([]);
});
