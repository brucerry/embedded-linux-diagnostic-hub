import { expect, test, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { installSshStream } from './fixtures/ssh-stream';
import { clockOutput } from '../fixtures/device-clock';
import { parseDeviceClock } from '../../shared/diagnostics/device-clock';

declare global {
    interface Window {
        headerOwnershipTest: { readPending: boolean; releaseCommand(): void };
    }
}
const clock = (page: Page) => page.getByRole('region', { name: 'Device time', exact: true });
const calls = (page: Page) => page.evaluate(() => window.desktopTest.clock.calls);
const fresh = {
    status: 'available' as const,
    sample: parseDeviceClock(clockOutput('2026-10-10', '17:36:00', '+0800', 'CST')),
};

async function activeFlow(page: Page) {
    await installDesktop(page);
    await installSshStream(page, {
        connection: 'header-clock-fixture',
        stdout: 'owned output',
        stderr: '',
        exitCode: 0,
    });
    await page.clock.install();
    await page.goto('/');
    // Gate one actual streaming read after navigation; do not rely on init-script ordering.
    await page.evaluate(() => {
        const stream = window.diagnosticHub!.automationStream!;
        let held = false,
            release: (() => void) | undefined;
        const state = (window.headerOwnershipTest = {
            readPending: false as boolean,
            releaseCommand() {
                if (!release) throw Error('No pending synthetic stream read.');
                const ack = release;
                release = undefined;
                state.readPending = false;
                ack();
            },
        });
        window.diagnosticHub!.automationStream = async (request) => {
            if ((request as { action?: string }).action === 'read' && !held) {
                held = true;
                state.readPending = true;
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
            }
            return stream(request);
        };
    });
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await expect(clock(page)).toHaveClass(/device-clock-current/);
    await expect(clock(page)).toContainText('16:35');
    await expect.poll(() => calls(page)).toBe(1);
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    const navigation = flow.getByRole('navigation', { name: 'Automation setup steps' });
    await expect(navigation).toBeVisible();
    const stage = (name: string) =>
        navigation.getByRole('button', { name: new RegExp(name) }).click();
    await stage('Commands');
    await flow.getByLabel('Command 1 script').fill('header ownership fixture');
    await stage('Timing');
    await flow.getByLabel('Command timeout', { exact: true }).fill('300');
    await stage('Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.headerOwnershipTest.readPending)).toBe(true);
    expect(await page.evaluate(() => window.sshStreamTest.commands)).toEqual([
        'header ownership fixture',
    ]);
    await expect(clock(page)).toHaveClass(/device-clock-stale/);
    await expect(clock(page)).toContainText('Stale');
    await expect(clock(page)).toContainText('16:35');
    // Let lazy route loading and admission settle before freezing application timers.
    await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 1000).toISOString()));
    await page.clock.runFor(60_000);
    expect(await calls(page)).toBe(1);
    await expect(clock(page)).toContainText('Stale');
    expect(await page.evaluate(() => window.sshStreamTest.finalized)).toBe(0);
    return flow;
}

test('Automation holds the header stale through release and a pending refresh until valid success', async ({
    page,
}) => {
    const flow = await activeFlow(page);
    await page.evaluate((response) => {
        window.desktopTest.clock.response = response;
        window.desktopTest.clock.hold = true;
        window.headerOwnershipTest.releaseCommand();
    }, fresh);
    await expect(flow.getByRole('status')).toContainText('Flow finished');
    await expect.poll(() => calls(page)).toBe(2);
    await expect(clock(page)).toHaveClass(/device-clock-stale/);
    await expect(clock(page)).toContainText('Stale');
    await expect(clock(page)).toContainText('16:35');
    await expect(clock(page)).not.toContainText('17:36');
    await page.evaluate(() => window.desktopTest.clock.release!());
    await expect(clock(page)).toHaveClass(/device-clock-current/);
    await expect(clock(page)).toContainText('2026-10-10');
    await expect(clock(page)).toContainText('17:36');
    await expect(clock(page)).not.toContainText('Stale');
    expect(await page.evaluate(() => window.sshStreamTest.finalized)).toBe(1);
    expect(await page.evaluate(() => window.sshStreamTest.commands)).toHaveLength(1);
});

test('A failed post-Automation refresh retains stale time until a later valid minute read', async ({
    page,
}) => {
    const flow = await activeFlow(page);
    await page.evaluate(() => {
        window.desktopTest.clock.fail = true;
        window.headerOwnershipTest.releaseCommand();
    });
    await expect(flow.getByRole('status')).toContainText('Flow finished');
    await expect.poll(() => calls(page)).toBe(2);
    await expect(clock(page)).toHaveClass(/device-clock-stale/);
    await expect(clock(page)).toContainText('Stale');
    await expect(clock(page)).toContainText('16:35');
    await expect(clock(page)).not.toContainText('Device time unavailable');
    await page.evaluate((response) => {
        window.desktopTest.clock.response = response;
        window.desktopTest.clock.fail = false;
    }, fresh);
    await page.clock.runFor(60_000);
    await expect.poll(() => calls(page)).toBe(3);
    await expect(clock(page)).toHaveClass(/device-clock-current/);
    await expect(clock(page)).toContainText('17:36');
    await expect(clock(page)).not.toContainText('Stale');
    expect(await page.evaluate(() => window.sshStreamTest.finalized)).toBe(1);
    expect(await page.evaluate(() => window.sshStreamTest.legacyCalls)).toBe(0);
});
