import { expect, test, type Locator, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { installSshStream } from './fixtures/ssh-stream';

const stage = (flow: Locator, name: string) => flow
    .getByRole('navigation', { name: 'Automation setup steps' })
    .getByRole('button', { name: new RegExp(name) }).click();
const rows = (flow: Locator) => flow.locator('.automation-steps > li');
const state = (flow: Locator) => rows(flow).evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-step-id'),
    name: node.querySelector<HTMLInputElement>('input[placeholder="Step name (optional)"]')!.value,
    command: node.querySelector<HTMLTextAreaElement>('textarea')!.value,
    enabled: node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
})));

async function setup(page: Page, count: number) {
    await installDesktop(page);
    await installSshStream(page, {
        connection: 'reorder-fixture-owner', stdout: 'reorder response', stderr: '', exitCode: 0,
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await expect(flow.getByRole('navigation', { name: 'Automation setup steps' })).toBeVisible();
    await stage(flow, 'Commands');
    for (let index = 1; index <= count; index++) {
        if (index > 1) await flow.getByRole('button', { name: 'Add command', exact: true }).click();
        await flow.getByLabel(`Step ${index} name (optional)`).fill(`Named ${index}`);
        await flow.getByLabel(`Command ${index} script`).fill(`command ${index}`);
    }
    return flow;
}

test('Automation drag cancellation restores identities and command editing cannot start a row drag', async ({ page }) => {
    const flow = await setup(page, 2);
    const original = await state(flow);
    expect(new Set(original.map((item) => item.id)).size).toBe(2);
    expect(original.every((item) => item.id)).toBe(true);
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    try {
        // Exercise actual DOM handlers; this does not claim a native OS drag gesture.
        await rows(flow).first().getByRole('img').dispatchEvent('pointerdown', {
            pointerId: 1, pointerType: 'mouse', button: 0,
        });
        await rows(flow).first().dispatchEvent('dragstart', { dataTransfer: transfer, clientY: 300 });
        await rows(flow).last().dispatchEvent('dragover', { dataTransfer: transfer, clientY: 300 });
        await expect.poll(() => state(flow)).toEqual([original[1], original[0]]);
        await expect(flow.locator('.automation-drag-placeholder')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect.poll(() => state(flow)).toEqual(original);
        await expect(flow.locator('.automation-drag-placeholder')).toHaveCount(0);
        await expect(flow.locator('.automation-reorder-notice')).toHaveText('Reordering cancelled.');

        await flow.getByLabel('Command 1 script').click();
        await expect(rows(flow).first()).toHaveAttribute('draggable', 'false');
        await flow.getByLabel('Command 1 script').fill('edited without dragging');
        const edited = [{ ...original[0], command: 'edited without dragging' }, original[1]];
        await rows(flow).first().dispatchEvent('dragstart', { dataTransfer: transfer, clientY: 300 });
        await rows(flow).last().dispatchEvent('dragover', { dataTransfer: transfer, clientY: 300 });
        await expect.poll(() => state(flow)).toEqual(edited);
        await expect(flow.locator('.automation-drag-placeholder')).toHaveCount(0);
        expect(await page.evaluate(() => window.sshStreamTest.commands)).toEqual([]);
    } finally {
        await transfer.dispose();
    }
});

test('Automation drag and keyboard reorder preserve disabled row identity through Review and execution', async ({ page }) => {
    const flow = await setup(page, 3);
    await rows(flow).nth(1).getByRole('checkbox', { name: 'Enabled', exact: true }).uncheck();
    const original = await state(flow);
    expect(original.map((item) => item.enabled)).toEqual([true, false, true]);
    expect(new Set(original.map((item) => item.id)).size).toBe(3);
    await rows(flow).first().getByRole('img').dragTo(rows(flow).last());
    await expect.poll(() => state(flow)).toEqual([original[1], original[2], original[0]]);
    await expect(flow.locator('.automation-drag-placeholder')).toHaveCount(0);
    await expect(flow.locator('.automation-reorder-notice')).toHaveText('Step order updated.');
    await flow.getByRole('button', { name: 'Move command 2 up', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => state(flow)).toEqual([original[2], original[1], original[0]]);
    await expect(flow.locator('.automation-reorder-notice')).toHaveText('Step moved to position 1');
    expect(await page.evaluate(() => window.sshStreamTest.commands)).toEqual([]);
    await stage(flow, 'Review');
    const preview = flow.locator('.automation-preview');
    await expect(preview.locator('pre')).toHaveText(['"command 3"', '"command 1"']);
    await expect(preview).not.toContainText('Named 2');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect(flow.getByRole('status')).toContainText('Flow finished');
    expect(await page.evaluate(() => window.sshStreamTest.commands)).toEqual(['command 3', 'command 1']);
    await expect.poll(() => page.evaluate(() => window.sshStreamTest.finalized)).toBe(2);
    const results = flow.getByLabel('Stored SSH captures', { exact: true }).locator('tbody tr');
    await expect(results).toHaveCount(2);
    await expect(results.filter({ hasText: 'Named 3' })).toHaveCount(1);
    await expect(results.filter({ hasText: 'Named 1' })).toHaveCount(1);
    await expect(results.filter({ hasText: 'Named 2' })).toHaveCount(0);
    expect(await page.evaluate(() => window.sshStreamTest.legacyCalls)).toBe(0);
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs)).toEqual([]);
});
