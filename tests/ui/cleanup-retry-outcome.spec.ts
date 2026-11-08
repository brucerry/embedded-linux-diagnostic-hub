import { expect, test } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import type { createCleanupRetryBoundary as createBoundary } from './fixtures/cleanup-retry';

test('explicit console cleanup retry preserves acknowledged evidence failure in Automation status without replay', async ({
    page,
}, info) => {
    await installDesktop(page);
    await page.goto('/');
    // Install after navigation so this cannot depend on init-script ordering.
    await page.evaluate(async () => {
        const source = '/tests/ui/fixtures/cleanup-retry.ts';
        const { createCleanupRetryBoundary } = (await import(source)) as {
            createCleanupRetryBoundary: typeof createBoundary;
        };
        const host = createCleanupRetryBoundary();
        window.cleanupRetryTest = host;
        const api = window.diagnosticHub!;
        api.automationConnection = () => 'cleanup-retry-connection-001';
        api.runAutomation = async () => {
            throw Error('No legacy command execution admitted.');
        };
        api.automationConsole = (request) => host.rpc(request);
        api.consoleStorage = (request) => host.archive(request);
        api.acquireAutomationActivity = host.acquireActivity;
        api.releaseAutomationActivity = host.releaseActivity;
    });
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    const snapshot = () => page.evaluate(() => window.cleanupRetryTest.snapshot());
    try {
        await flow.getByLabel('SSH execution mode', { exact: true }).selectOption('console');
        await flow.getByLabel('SSH shell prompt alternatives', { exact: true }).fill('fixture# ');
        const stage = (name: string) =>
            flow
                .getByRole('navigation', { name: 'Automation setup steps' })
                .getByRole('button', { name: new RegExp(name) })
                .click();
        await stage('Commands');
        await flow.getByLabel('Step 1 name (optional)').fill('Failing evidence');
        await flow.getByLabel('Command 1 script').fill('FAIL_ONCE');
        await flow.getByRole('button', { name: 'Add command', exact: true }).click();
        await flow.getByLabel('Step 2 name (optional)').fill('Never replay');
        await flow.getByLabel('Command 2 script').fill('NEVER_SEND');
        await stage('Review');
        const start = flow.getByRole('button', { name: 'Run once', exact: true });
        await expect(start).toBeEnabled();
        await start.click();
        await expect(flow.locator('.automation-state')).toContainText(
            'Console cleanup remains pending',
        );
        await expect(start).toBeDisabled();
        await expect
            .poll(async () => ({
                finishes: (await snapshot()).finishes,
                leaseHeld: (await snapshot()).leaseHeld,
            }))
            .toEqual({ finishes: 1, leaseHeld: true });
        const retry = flow.getByRole('button', { name: 'Retry cleanup', exact: true });
        await retry.click();
        await expect.poll(async () => (await snapshot()).retryPending).toBe(true);
        expect(await snapshot()).toMatchObject({
            commands: ['FAIL_ONCE'],
            finishes: 2,
            ownerReleased: 0,
            activityAcquires: 1,
            activityReleases: 0,
            leaseHeld: true,
        });
        await expect(start).toBeDisabled();
        await expect(flow.locator('.automation-state')).not.toContainText('cleanup acknowledged');
        await page.evaluate(() => window.cleanupRetryTest.acknowledgeRetry());
        await expect(flow.locator('.automation-state')).toHaveText(
            'Console stopped with incomplete or unacknowledged evidence: ' +
                'Synthetic retained console evidence could not be acknowledged. ' +
                'Flow paused; arm explicitly to resume.',
        );
        await expect(start).toBeEnabled();
        await expect(retry).toHaveCount(0);
        await expect(flow.locator('.automation-state')).not.toContainText('Flow finished');
        await expect.poll(snapshot).toMatchObject({
            reads: 2,
            opens: 1,
            commands: ['FAIL_ONCE'],
            finishes: 2,
            retryPending: false,
            retryAcknowledged: true,
            ownerReleased: 1,
            activityAcquires: 1,
            activityReleases: 1,
            leaseHeld: false,
        });
    } finally {
        // Failure evidence is retained too; this releases only the synthetic Promise gate.
        // It never claims unobserved product cleanup. SDK/runner disposal is separate.
        await page.evaluate(() => window.cleanupRetryTest.acknowledgeRetry());
        const summary = await snapshot();
        const body = Buffer.from(
            JSON.stringify({ schema: 1, boundary: 'mock-local-client', ...summary }),
        );
        if (body.length > 4096) throw Error('Cleanup retry summary exceeds its bound.');
        await info.attach('cleanup-retry-summary', { body, contentType: 'application/json' });
    }
});
