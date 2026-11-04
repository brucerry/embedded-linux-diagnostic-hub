import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { installCleanupFault, type CleanupFault } from './fixtures/ssh-cleanup-fault';

async function arm(page: Page, mode: CleanupFault) {
    await installDesktop(page);
    await installCleanupFault(page, mode);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    const navigation = flow.getByRole('navigation', { name: 'Automation setup steps' });
    await navigation.getByRole('button', { name: /Commands/ }).click();
    await flow.getByLabel('Step 1 name (optional)').fill('First owned command');
    await flow.getByLabel('Command 1 script').fill('one');
    await flow.getByRole('button', { name: 'Add command', exact: true }).click();
    await flow.getByLabel('Step 2 name (optional)').fill('Must remain disarmed');
    await flow.getByLabel('Command 2 script').fill('never');
    await navigation.getByRole('button', { name: /Review/ }).click();
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    return flow;
}
for (const mode of ['rejected-finalize', 'lost-finalize'] as const) {
    test(`SSH ${mode} requires explicit acknowledged cleanup without command replay`, async ({ page }, info) => {
        const flow = await arm(page, mode);
        await expect(flow.getByRole('status')).toContainText('SSH cleanup remains pending');
        await expect(flow.getByRole('button', { name: 'Run once', exact: true })).toBeDisabled();
        expect(await page.evaluate(() => window.cleanupFaultTest.finalizes)).toBe(1);
        const rows = flow.getByLabel('Stored SSH captures', { exact: true }).locator('tbody tr');
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText('synthetic complete output');
        const retained = await rows.first().textContent();
        expect(await page.evaluate(() => window.sshStreamTest.commands)).toEqual(['one']);
        await flow.getByRole('button', { name: 'Retry cleanup', exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.cleanupFaultTest.pendingRetry)).toBe(true);
        await expect(flow.getByRole('button', { name: 'Run once', exact: true })).toBeDisabled();
        expect(await page.evaluate(() => window.cleanupFaultTest.finalizes)).toBe(2);
        expect(await page.evaluate(() => window.sshStreamTest.commands)).toEqual(['one']);
        await page.evaluate(() => window.cleanupFaultTest.releaseRetry());
        await expect(flow.getByRole('status')).toContainText('SSH cleanup acknowledged');
        await expect(flow.getByRole('button', { name: 'Run once', exact: true })).toBeEnabled();
        await expect(rows).toHaveCount(1);
        expect(await rows.first().textContent()).toBe(retained);
        expect(await page.evaluate(() => window.sshStreamTest.commands)).toEqual(['one']);
        expect(await page.evaluate(() => window.sshStreamTest.finalized)).toBe(1);
        expect(await page.evaluate(() => window.sshStreamTest.legacyCalls)).toBe(0);
        await info.attach('production-fix-observation', { body: JSON.stringify({ schema: 1,
            productionSource: '96a56cdbb462320c54fe74022d7436e665a31d31', case: mode,
            starts: 1, finalizeRequests: 2, acknowledgedHostModelRetirements: 1,
            explicitRetryHeld: true, replayedCommands: 0, retainedRows: 1 }), contentType: 'application/json' });
    });
}

test('SSH uncertain start remains blocked and incomplete without replay or fabricated cleanup', async ({ page }, info) => {
    const flow = await arm(page, 'uncertain-start');
    await expect(flow.getByRole('status')).toContainText('SSH cleanup remains pending');
    await expect(flow.getByRole('status')).toContainText('uncertain');
    await expect(flow.getByRole('button', { name: 'Run once', exact: true })).toBeDisabled();
    const rows = flow.getByLabel('Stored SSH captures', { exact: true }).locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('incomplete', { ignoreCase: true });
    const retained = await rows.first().textContent();
    await flow.getByRole('button', { name: 'Retry cleanup', exact: true }).click();
    await expect(flow.getByRole('alert')).toContainText('start outcome is uncertain');
    await expect(flow.getByRole('button', { name: 'Run once', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => ({ starts: window.cleanupFaultTest.starts,
        finalizes: window.cleanupFaultTest.finalizes, commands: window.sshStreamTest.commands,
        retired: window.sshStreamTest.finalized }))).toEqual({ starts: 1, finalizes: 0, commands: ['one'], retired: 0 });
    expect(await rows.first().textContent()).toBe(retained);
    await info.attach('production-fix-observation', { body: JSON.stringify({ schema: 1,
        productionSource: '96a56cdbb462320c54fe74022d7436e665a31d31', case: 'uncertain-start',
        starts: 1, finalizeRequests: 0, replayedCommands: 0, incompleteRows: 1,
        syntheticOwnerStillHeld: true, realHostOwnershipQualified: false }), contentType: 'application/json' });
});
