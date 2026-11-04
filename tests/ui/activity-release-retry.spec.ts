import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { installSerial } from './fixtures/serial';
import { installActivityReleaseRetry } from './fixtures/activity-release-retry';

async function observation(page: Page) {
    return page.evaluate(() => {
        const state = window.activityReleaseRetryTest;
        return { acquireRequests: state.acquireRequests, grants: [...state.grants],
            releaseRequests: [...state.releaseRequests], acknowledged: [...state.acknowledged],
            hostEffects: state.hostEffects, hostLease: state.hostLease,
            grantPending: state.grantPending, retryPending: state.retryPending,
            opens: window.serialTest.opens, closes: window.serialTest.closes,
            writes: window.serialTest.writes.length, sshConnects: window.desktopTest.connects };
    });
}
async function attachObservation(page: Page, info: TestInfo) {
    const body = JSON.stringify(await observation(page));
    if (Buffer.byteLength(body) > 4096) throw Error('Synthetic observation exceeds 4 KiB.');
    await info.attach('activity-release-retry-observation', { body: Buffer.from(body), contentType: 'application/json' });
}

test('cancelled Serial pre-arm release failure stays recoverable until explicit retry acknowledgement', async ({ page }, info) => {
    await installDesktop(page);
    await installSerial(page);
    await page.goto('/');
    await installActivityReleaseRetry(page);
    const a = '10000000-0000-4000-8000-000000000217';
    const b = '20000000-0000-4000-8000-000000000217';
    try {
        await page.getByRole('button', { name: 'Serial', exact: true }).click();
        const serial = page.getByRole('region', { name: 'Local serial terminal' });
        await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
        await serial.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        const flow = page.getByRole('region', { name: 'Automation', exact: true });
        const navigation = flow.getByRole('navigation', { name: 'Automation setup steps' });
        await expect(navigation).toBeVisible();
        await flow.getByLabel('Automation transport').selectOption('serial');
        await flow.getByLabel('Serial completion prompt').fill('memory# ');
        await navigation.getByRole('button', { name: /Commands/ }).click();
        await flow.getByLabel('Command 1 script').fill('NEVER_SEND');
        await navigation.getByRole('button', { name: /Review/ }).click();
        const start = flow.getByRole('button', { name: 'Start flow', exact: true });
        const cancel = flow.getByRole('button', { name: 'Cancel run', exact: true });
        const status = flow.getByRole('status');
        await start.click();
        await expect.poll(async () => (await observation(page)).acquireRequests).toBe(1);
        await expect(cancel).toBeVisible();
        await cancel.click();
        await expect(status).toContainText('Flow cancelled before arming.');
        await expect(start).toBeEnabled();
        // A cancelled acquisition still owns the real header admission fence.
        await start.click();
        await expect(flow.getByText('Wait for the current clock reader admission.', { exact: true })).toBeVisible();
        expect((await observation(page)).acquireRequests).toBe(1);
        await page.evaluate(() => window.activityReleaseRetryTest.grant());
        const retry = flow.getByRole('button', { name: 'Retry cleanup', exact: true });
        await expect(retry).toBeVisible();
        await expect(status).toContainText('Background execution cleanup remains pending:');
        await expect(status).toContainText('Synthetic host release reply lost after effect.');
        await expect(status).toContainText('Previous flow: Flow cancelled before arming.');
        await expect(start).toBeDisabled();
        expect(await observation(page)).toMatchObject({ acquireRequests: 1, grants: [a],
            releaseRequests: [a], acknowledged: [], hostEffects: 1, hostLease: null,
            grantPending: false, retryPending: false, opens: 1, closes: 0, writes: 0, sshConnects: 0 });
        await retry.click();
        await expect.poll(async () => (await observation(page)).retryPending).toBe(true);
        await retry.click();
        await expect(start).toBeDisabled();
        await expect(status).toContainText('Synthetic host release reply lost after effect.');
        expect(await observation(page)).toMatchObject({ acquireRequests: 1, releaseRequests: [a, a],
            acknowledged: [], hostEffects: 1, retryPending: true, writes: 0 });
        await page.evaluate(() => window.activityReleaseRetryTest.acknowledgeRetry());
        await expect(retry).toHaveCount(0);
        await expect(start).toBeEnabled();
        await expect(status).not.toContainText('Background execution cleanup remains pending:');
        expect((await observation(page)).acknowledged).toEqual([a]);
        // New acquisition, not a disconnected header read, is positive readmission evidence.
        await start.click();
        await expect.poll(async () => (await observation(page)).acquireRequests).toBe(2);
        await expect(cancel).toBeVisible();
        await cancel.click();
        await page.evaluate(() => window.activityReleaseRetryTest.grant());
        await expect.poll(async () => (await observation(page)).acknowledged).toEqual([a, b]);
        await expect(start).toBeEnabled();
        await expect(flow.locator('.automation-results tbody tr')).toHaveCount(0);
        await page.getByRole('button', { name: 'Serial', exact: true }).click();
        await serial.getByRole('button', { name: 'Disconnect', exact: true }).click();
        await expect(serial.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
        expect(await observation(page)).toEqual({ acquireRequests: 2, grants: [a, b],
            releaseRequests: [a, a, b], acknowledged: [a, b], hostEffects: 2, hostLease: null,
            grantPending: false, retryPending: false, opens: 1, closes: 1, writes: 0, sshConnects: 0 });
        await attachObservation(page, info);
    } catch (error) {
        // Diagnostic collection must not replace the primary assertion or pretend to retire a gate.
        try { await attachObservation(page, info); } catch {}
        throw error;
    }
});
