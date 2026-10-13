import { expect, test, type Page } from '@playwright/test';
import { installSerial } from './fixtures/serial';
import { installDesktop } from './fixtures/desktop';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const setup = (flow: import('@playwright/test').Locator, stage: string) =>
    flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(stage) })
        .click();

const output = async (page: Page, name: string, testInfo: import('@playwright/test').TestInfo) => {
    const file = process.env.HUB_FEATURE_EVIDENCE
        ? path.join(process.env.HUB_FEATURE_EVIDENCE, name)
        : testInfo.outputPath(name);
    await mkdir(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
};
test('Serial flow edits remain deliberate, multiline bytes and QA exports use captured rows', async ({
    page,
}, testInfo) => {
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
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 name').fill('Read console');
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('first line');
    await flow.getByLabel('Command 1 script').press('Enter');
    await flow.getByLabel('Command 1 script').pressSequentially('second line');
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(0);
    await setup(flow, 'Timing');
    await setup(flow, 'Connection');
    await flow.getByLabel('Serial completion prompt').fill('console# ');
    await flow.getByLabel('Serial automation line ending').selectOption('LF');
    await setup(flow, 'Review');
    await setup(flow, 'Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => String.fromCharCode(...window.serialTest.writes.flat())))
        .toBe('first line\nsecond line\n');
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('next draft');
    await page.evaluate(() => {
        window.serialTest.push([...new TextEncoder().encode('reply\r\n\x1b[32mcon')]);
        window.serialTest.push([...new TextEncoder().encode('sole# ')]);
    });
    await expect(flow.getByRole('status')).toContainText('Flow finished');
    await expect(flow.locator('tbody')).toContainText('prompt-observed');
    await expect(flow.locator('tbody')).toContainText('Unavailable');
    const writes = await page.evaluate(() => window.serialTest.writes.length);
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        flow.getByRole('button', { name: 'Download QA results' }).click(),
    ]);
    const file = await download.path();
    const fs = await import('node:fs/promises');
    const data = JSON.parse(await fs.readFile(file!, 'utf8'));
    expect(data.records[0].command).toBe('first line\nsecond line');
    expect(data.records[0].exitCode).toBeNull();
    expect(data.records[0].requestBytes).toBe(
        Buffer.from('first line\nsecond line\n').toString('base64'),
    );
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(writes);
    await output(page, 'automation-serial.png', testInfo);
    await page.setViewportSize({ width: 412, height: 915 });
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    await output(page, 'automation-mobile.png', testInfo);
});
test('invalid scheduled dates, repeated local time and invalid delay keep draft and block arming', async ({
    page,
}) => {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByLabel('Automation transport').selectOption('serial');
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('explicit payload');
    await setup(flow, 'Timing');
    await setup(flow, 'Connection');
    await flow.getByLabel('Serial completion prompt').fill('# ');
    await setup(flow, 'Timing');
    await flow.getByLabel('Schedule wall-clock start').check();
    await flow.getByLabel('Start timezone').fill('UTC');
    await flow.getByLabel('Scheduled start date and time').fill('2027-02-29T12:00:00');
    await expect(flow.getByRole('alert')).toContainText('does not exist');
    await expect(flow.getByLabel('Scheduled start date and time')).toHaveValue(
        '2027-02-29T12:00:00',
    );
    await setup(flow, 'Review');
    await expect(flow.getByRole('button', { name: 'Start flow', exact: true })).toBeDisabled();
    await setup(flow, 'Timing');
    await flow.getByLabel('Start timezone').fill('America/New_York');
    await flow.getByLabel('Scheduled start date and time').fill('2026-11-01T01:30:00');
    await expect(flow.getByRole('alert')).toContainText('repeats');
    await flow.getByLabel('Start UTC offset').fill('-05:00');
    await flow.getByLabel('Command 1 delay').fill('Infinity');
    await expect(flow.getByRole('alert')).toContainText('delay');
    await expect(flow.getByLabel('Command 1 delay')).toHaveValue('Infinity');
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(0);
});
test('SSH flow uses separate API, retains drafts and genuine exits without terminal scraping', async ({
    page,
}, testInfo) => {
    await installDesktop(page);
    await page.addInitScript(() => {
        const api = window.diagnosticHub!;
        const state = { commands: [] as string[] };
        (window as unknown as { automationTest: typeof state }).automationTest = state;
        api.automationConnection = () => 'synthetic-connected-001';
        api.cancelAutomation = async () => {};
        api.runAutomation = async (request) => {
            state.commands.push(request.command);
            return {
                stdout: 'synthetic SSH result',
                stderr: 'synthetic diagnostic error',
                exitCode: 7,
                completion: 'exit',
                truncated: false,
                chunks: [],
            };
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await setup(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('fixture first\nfixture second');
    await setup(flow, 'Review');
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect(flow.locator('tbody')).toContainText('7');
    await expect(flow.locator('tbody')).toContainText('synthetic SSH result');
    expect(
        await page.evaluate(
            () =>
                (window as unknown as { automationTest: { commands: string[] } }).automationTest
                    .commands,
        ),
    ).toEqual(['fixture first\nfixture second']);
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs)).toEqual([]);
    await output(page, 'automation-ssh.png', testInfo);
});

for (const transport of ['ssh', 'serial'] as const)
    test(
        transport + ' scheduled Run once honors start and preview without repetition',
        async ({ page }) => {
            if (transport === 'serial') await installSerial(page);
            else {
                await installDesktop(page);
                await page.addInitScript(() => {
                    let calls = 0;
                    (window as unknown as { scheduledCalls: () => number }).scheduledCalls = () =>
                        calls;
                    const bridge = window.diagnosticHub!;
                    bridge.automationConnection = () => 'schedule-fixture-001';
                    bridge.cancelAutomation = async () => {};
                    bridge.runAutomation = async () => {
                        calls++;
                        return {
                            stdout: 'scheduled fixture',
                            stderr: '',
                            exitCode: 0,
                            completion: 'exit',
                            truncated: false,
                            chunks: [],
                        };
                    };
                });
            }
            await page.clock.install({ time: new Date('2028-02-29T11:59:00Z') });
            await page.goto('/');
            if (transport === 'serial') {
                await page.getByRole('button', { name: 'Serial', exact: true }).click();
                const serial = page.getByRole('region', { name: 'Local serial terminal' });
                await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
                await serial.getByRole('button', { name: 'Connect', exact: true }).click();
                await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
            } else {
                await page
                    .getByRole('button', { name: 'Connect device', exact: true })
                    .first()
                    .click();
                await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
                await expect(
                    page.getByRole('dialog', { name: 'Connect a Linux device' }),
                ).not.toBeVisible();
            }
            await page.getByRole('button', { name: 'Automation', exact: true }).click();
            const flow = page.getByRole('region', { name: 'Automation', exact: true });
            await flow.getByLabel('Automation transport').selectOption(transport);
            await setup(flow, 'Commands');
            await flow.getByLabel('Command 1 script').fill('scheduled fixture');
            await setup(flow, 'Timing');
            // Freeze after lazy pages and their controls are mounted; pausing before import stalls React retries.
            await page.clock.pauseAt(new Date('2028-02-29T12:00:00Z'));
            if (transport === 'serial') {
                await setup(flow, 'Connection');
                await flow.getByLabel('Serial completion prompt').fill('# ');
            }
            await setup(flow, 'Timing');
            await flow.getByLabel('Schedule wall-clock start').check();
            await flow.getByLabel('Start timezone').fill('UTC');
            await flow.getByLabel('Scheduled start date and time').fill('2028-02-29T12:00:05');
            await flow.getByLabel('Repeat completed flow').check();
            await setup(flow, 'Review');
            await expect(flow.locator('.automation-preview')).toContainText(
                '2028-02-29T12:00:05.000Z',
            );
            await expect(flow.locator('.automation-preview')).toContainText(
                'Run once executes one flow',
            );
            await flow
                .getByRole('button', { name: 'Run once at scheduled time', exact: true })
                .click();
            await expect(flow.getByRole('status')).toContainText('Armed start');
            const calls = () =>
                page.evaluate(
                    (t) =>
                        t === 'serial'
                            ? window.serialTest.writes.length
                            : (
                                  window as unknown as { scheduledCalls: () => number }
                              ).scheduledCalls(),
                    transport,
                );
            expect(await calls()).toBe(0);
            await page.clock.runFor(4999);
            expect(await calls()).toBe(0);
            await page.clock.runFor(1);
            await expect.poll(calls).toBe(1);
            if (transport === 'serial') {
                await page.evaluate(() =>
                    window.serialTest.push([
                        ...new TextEncoder().encode('scheduled response\r\n# '),
                    ]),
                );
                await page.clock.runFor(250);
            }
            await expect(flow.getByRole('status')).toContainText('Flow finished');
            await page.clock.runFor(11000);
            expect(await calls()).toBe(1);
        },
    );
