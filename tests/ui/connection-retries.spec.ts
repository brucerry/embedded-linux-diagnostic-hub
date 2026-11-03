import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';

declare global {
    interface Window {
        retryBoundaryTest: {
            attempts: number;
            active: number;
            maxActive: number;
            attemptTimes: number[];
            cleanupIds: string[];
            cleanupAcknowledgedAt: number | null;
            acknowledgeCleanup(): void;
        };
    }
}

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

test('cleanup acknowledgement starts the exact three-second retry and Cancel fences the second handshake', async ({ page }) => {
    await installDesktop(page);
    await page.clock.install();
    await page.goto('/');
    // Freeze after initial rendering, before admission. All intervals below use this fake clock.
    await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 1000).toISOString()));
    await page.evaluate(() => {
        let cleanupAck: (() => void) | undefined, lateReady: (() => void) | undefined;
        const state = window.retryBoundaryTest = {
            attempts: 0, active: 0, maxActive: 0,
            attemptTimes: [] as number[], cleanupIds: [] as string[],
            cleanupAcknowledgedAt: null as number | null,
            acknowledgeCleanup() {
                if (!cleanupAck) throw Error('No pending synthetic cleanup.');
                const ack = cleanupAck;
                cleanupAck = undefined;
                state.cleanupAcknowledgedAt = Date.now();
                ack();
            },
        };
        window.diagnosticHub!.connect = async () => {
            window.desktopTest.connects++;
            state.attempts++;
            state.active++;
            state.maxActive = Math.max(state.maxActive, state.active);
            state.attemptTimes.push(Date.now());
            try {
                if (state.attempts === 1) throw Error('temporary network failure');
                if (state.attempts > 2) throw Error('Unexpected third synthetic attempt.');
                await new Promise<void>((resolve) => { lateReady = resolve; });
            } finally {
                state.active--;
            }
        };
        window.diagnosticHub!.cancelConnect = async (id) => {
            state.cleanupIds.push(id);
            if (state.cleanupIds.length === 1) {
                await new Promise<void>((resolve) => { cleanupAck = resolve; });
            } else {
                if (!lateReady) throw Error('No pending second synthetic handshake.');
                const ready = lateReady;
                lateReady = undefined;
                ready();
            }
        };
    });
    const modal = await openConnection(page);
    const connect = modal.getByRole('button', { name: 'Connect via SSH', exact: true });
    await connect.click();
    await expect.poll(() => page.evaluate(() => window.retryBoundaryTest.cleanupIds.length)).toBe(1);
    await expect(connect).toBeDisabled();
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
    await page.clock.runFor(6000);
    expect(await page.evaluate(() => window.retryBoundaryTest.attempts)).toBe(1);
    await expect(modal.getByRole('status')).not.toContainText('Retrying in 3 seconds');
    await page.evaluate(() => window.retryBoundaryTest.acknowledgeCleanup());
    await expect(modal.getByRole('status')).toContainText('Retrying in 3 seconds');
    await page.clock.runFor(2999);
    expect(await page.evaluate(() => window.retryBoundaryTest.attempts)).toBe(1);
    await page.clock.runFor(1);
    await expect.poll(() => page.evaluate(() => window.retryBoundaryTest.attempts)).toBe(2);
    expect(await page.evaluate(() => window.retryBoundaryTest.attemptTimes[1]
        - window.retryBoundaryTest.cleanupAcknowledgedAt!)).toBe(3000);
    await expect(modal.getByRole('status')).toContainText('attempt 2');
    await expect(connect).toBeDisabled();
    await page.clock.runFor(6000);
    expect(await page.evaluate(() => window.retryBoundaryTest.attempts)).toBe(2);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(modal).not.toBeVisible();
    await page.clock.runFor(10_000);
    await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({ attempts: window.retryBoundaryTest.attempts,
        active: window.retryBoundaryTest.active, maxActive: window.retryBoundaryTest.maxActive,
        cleanupCount: window.retryBoundaryTest.cleanupIds.length,
        uniqueCleanupIds: new Set(window.retryBoundaryTest.cleanupIds).size,
        collects: window.desktopTest.collects, terminalOpens: window.desktopTest.terminal!.opens })))
        .toEqual({ attempts: 2, active: 0, maxActive: 1, cleanupCount: 2,
            uniqueCleanupIds: 2, collects: 0, terminalOpens: 0 });
});
