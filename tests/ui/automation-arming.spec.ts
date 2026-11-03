import { expect, test, type Page, type Locator } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { installSerial } from './fixtures/serial';
import { installSshStream } from './fixtures/ssh-stream';

declare global {
    interface Window {
        armingTest: {
            pending: { resolve(value: string): void; reject(error: Error): void }[];
            released: string[];
            executions: number;
            releaseOld?: () => void;
        };
    }
}

async function prepare(page: Page, transport: 'ssh' | 'serial', scheduled = false) {
    await installDesktop(page);
    if (transport === 'ssh')
        await installSshStream(page, {
            connection: 'delayed-lease-fixture',
            stdout: '',
            stderr: '',
            exitCode: 0,
            tracking: 'armingTest',
            allowCancel: true,
        });
    if (transport === 'serial') await installSerial(page);
    await page.addInitScript(() => {
        const state: Window['armingTest'] = { pending: [], released: [], executions: 0 };
        window.armingTest = state;
        const bridge = window.diagnosticHub!;
        bridge.acquireAutomationActivity = () =>
            new Promise<string>((resolve, reject) => state.pending.push({ resolve, reject }));
        bridge.releaseAutomationActivity = async (id) => {
            state.released.push(id);
        };
        bridge.automationConnection = () => 'delayed-lease-fixture';
        bridge.cancelAutomation = async () => {};
    });
    await page.clock.install({ time: new Date('2028-02-29T11:59:00Z') });
    await page.goto('/');
    if (transport === 'serial') {
        await page.getByRole('button', { name: 'Serial', exact: true }).click();
        const serial = page.getByRole('region', { name: 'Local serial terminal' });
        await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
        await serial.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    } else {
        await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
        await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
        await expect(
            page.getByRole('dialog', { name: 'Connect a Linux device' }),
        ).not.toBeVisible();
    }
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    const stage = (name: string) =>
        flow
            .getByRole('navigation', { name: 'Automation setup steps' })
            .getByRole('button', { name: new RegExp(name) })
            .click();
    await flow.getByLabel('Automation transport').selectOption(transport);
    if (transport === 'serial') await flow.getByLabel('Serial completion prompt').fill('# ');
    await stage('Commands');
    await flow.getByLabel('Command 1 script').fill('never send cancelled draft');
    await stage('Timing');
    await page.clock.pauseAt(new Date('2028-02-29T12:00:00Z'));
    await flow.getByLabel('Repeat completed flow').check();
    if (scheduled) {
        await flow.getByLabel('Run mode', { exact: true }).selectOption('scheduled');
        await flow.getByLabel('Start timezone').selectOption('UTC');
        await flow.getByLabel('Scheduled start date', { exact: true }).fill('2028-02-29');
        await flow.getByLabel('Scheduled start time', { exact: true }).fill('12:00:05');
    }
    await stage('Review');
    return flow;
}

async function expectClockAdmissionBlocked(page: Page, flow: Locator) {
    const start = flow.getByRole('button', { name: 'Start flow', exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(flow.getByText('Wait for the current clock reader admission.', { exact: true }))
        .toBeVisible();
    expect(await page.evaluate(() => window.armingTest.pending.length)).toBe(1);
    await expect(start).toBeEnabled();
    await expect(flow.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0);
}

async function expectHeaderResumed(page: Page, previousReads: number) {
    // This real hook read begins only after its matching reservation is returned.
    await expect.poll(() => page.evaluate(() => window.desktopTest.clock.calls))
        .toBeGreaterThan(previousReads);
}

for (const transport of ['ssh', 'serial'] as const) {
    test(`${transport} cancelled lease release fences repeated Starts until acknowledged`, async ({
        page,
    }) => {
        const flow = await prepare(page, transport),
            start = flow.getByRole('button', { name: 'Start flow', exact: true });
        await page.evaluate(() => {
            window.diagnosticHub!.releaseAutomationActivity = async (id) => {
                window.armingTest.released.push(id);
                if (id === 'old-release')
                    await new Promise<void>((resolve) => {
                        window.armingTest.releaseOld = resolve;
                    });
            };
        });
        await start.click();
        await expect.poll(() => page.evaluate(() => window.armingTest.pending.length)).toBe(1);
        await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
        await page.evaluate(() => window.armingTest.pending[0].resolve('old-release'));
        await expect.poll(() => page.evaluate(() => Boolean(window.armingTest.releaseOld)))
            .toBe(true);
        await expectClockAdmissionBlocked(page, flow);
        await expectClockAdmissionBlocked(page, flow);
        const reads = await page.evaluate(() => window.desktopTest.clock.calls);
        await page.evaluate(() => window.armingTest.releaseOld!());
        await expectHeaderResumed(page, reads);
        await start.click();
        await expect.poll(() => page.evaluate(() => window.armingTest.pending.length)).toBe(2);
        await expect(start).toBeDisabled();
        await expect(flow.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible();
        await expect(flow).not.toContainText('Wait for the current clock reader admission.');
        await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
        await page.evaluate(() => window.armingTest.pending[1].resolve('new-cancelled-release'));
        await expect.poll(() => page.evaluate(() => window.armingTest.released))
            .toEqual(['old-release', 'new-cancelled-release']);
        await expect(start).toBeEnabled();
        await page.clock.runFor(31000);
        expect(await page.evaluate((mode) => mode === 'serial'
            ? window.serialTest.writes.length : window.armingTest.executions, transport)).toBe(0);
    });
    for (const scheduled of [false, true]) {
        test(`${transport} Cancel during pending lease prevents ${scheduled ? 'scheduled' : 'immediate'} sends and repetition`, async ({
            page,
        }) => {
            const flow = await prepare(page, transport, scheduled);
            const start = flow.getByRole('button', { name: 'Start flow', exact: true });
            await start.click();
            await expect.poll(() => page.evaluate(() => window.armingTest.pending.length)).toBe(1);
            await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
            await page.evaluate(() => window.armingTest.pending[0].resolve('cancelled-lease'));
            await expect
                .poll(() => page.evaluate(() => window.armingTest.released))
                .toEqual(['cancelled-lease']);
            await expect(flow.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(
                0,
            );
            await expect(start).toBeEnabled();
            await page.clock.runFor(31000);
            expect(
                await page.evaluate(
                    (mode) =>
                        mode === 'serial'
                            ? window.serialTest.writes.length
                            : window.armingTest.executions,
                    transport,
                ),
            ).toBe(0);
            await expect(flow.locator('.automation-results tbody tr')).toHaveCount(0);
            await expect(
                flow.getByRole('button', { name: 'Clear retained results', exact: true }),
            ).toBeDisabled();
        });
    }
    for (const outcome of ['grant', 'reject'] as const) {
        test(`${transport} cancelled lease ${outcome} fences rearming and preserves later pending admission`, async ({
            page,
        }) => {
            const flow = await prepare(page, transport);
            const start = flow.getByRole('button', { name: 'Start flow', exact: true });
            await start.click();
            await expect.poll(() => page.evaluate(() => window.armingTest.pending.length)).toBe(1);
            await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
            await expectClockAdmissionBlocked(page, flow);
            const reads = await page.evaluate(() => window.desktopTest.clock.calls);
            await page.evaluate((result) => {
                const pending = window.armingTest.pending[0];
                if (result === 'grant') pending.resolve('stale-lease');
                else pending.reject(Error('stale lease failure must stay hidden'));
            }, outcome);
            if (outcome === 'grant')
                await expect.poll(() => page.evaluate(() => window.armingTest.released))
                    .toEqual(['stale-lease']);
            await expectHeaderResumed(page, reads);
            await expect(flow).not.toContainText('stale lease failure');
            await start.click();
            await expect.poll(() => page.evaluate(() => window.armingTest.pending.length)).toBe(2);
            await expect(start).toBeDisabled();
            await expect(flow.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible();
            await expect(flow).not.toContainText('Wait for the current clock reader admission.');
            expect(await page.evaluate(() => window.armingTest.executions)).toBe(0);
            await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
            await page.evaluate(() => window.armingTest.pending[1].resolve('new-cancelled-lease'));
            await expect.poll(() => page.evaluate(() => window.armingTest.released.includes('new-cancelled-lease')))
                .toBe(true);
            await page.clock.runFor(31000);
            expect(await page.evaluate((mode) => mode === 'serial'
                ? window.serialTest.writes.length : window.armingTest.executions, transport)).toBe(0);
            await expect(start).toBeEnabled();
        });
        test(`${transport} cancelled lease ${outcome} preserves later active flow after acknowledged retirement`, async ({
            page,
        }) => {
            const flow = await prepare(page, transport);
            const start = flow.getByRole('button', { name: 'Start flow', exact: true });
            const calls = () => page.evaluate((mode) => mode === 'serial'
                ? window.serialTest.writes.length : window.armingTest.executions, transport);
            await start.click();
            await expect.poll(() => page.evaluate(() => window.armingTest.pending.length)).toBe(1);
            await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
            await expectClockAdmissionBlocked(page, flow);
            const reads = await page.evaluate(() => window.desktopTest.clock.calls);
            await page.evaluate((result) => {
                const pending = window.armingTest.pending[0];
                if (result === 'grant') pending.resolve('late-old-lease');
                else pending.reject(Error('stale active failure must stay hidden'));
            }, outcome);
            if (outcome === 'grant')
                await expect.poll(() => page.evaluate(() => window.armingTest.released))
                    .toEqual(['late-old-lease']);
            await expectHeaderResumed(page, reads);
            await expect(flow).not.toContainText('stale active failure');
            await start.click();
            await expect.poll(() => page.evaluate(() => window.armingTest.pending.length)).toBe(2);
            await page.evaluate(() => window.armingTest.pending[1].resolve('active-new-lease'));
            await expect.poll(calls).toBe(1);
            await expect(start).toBeDisabled();
            await expect(flow.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible();
            await expect(flow).not.toContainText('stale active failure');
            await expect(flow).not.toContainText('Wait for the current clock reader admission.');
            expect(await calls()).toBe(1);
            await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.armingTest.released.includes('active-new-lease')))
                .toBe(true);
            await expect(start).toBeEnabled();
            await page.clock.runFor(31000);
            expect(await calls()).toBe(1);
        });
    }
}
