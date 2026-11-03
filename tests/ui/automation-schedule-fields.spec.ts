import { expect, test, type Locator, type Page } from '@playwright/test';
import { installSerial } from './fixtures/serial';
import { SCHEDULE_FIELDS as data } from './fixtures/schedule-fields-data';

const stage = (flow: Locator, name: string) =>
    flow.getByRole('navigation', { name: 'Automation setup steps' }).getByRole('button', { name: new RegExp(name) }).click();
async function fieldError(page: Page, field: Locator) {
    const id = await field.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    return page.locator('[id="' + id + '"]');
}

test('Automation schedule fields reject missing gap and unsupported clock inputs and preview both explicit fold instants without arming', async ({ page }, info) => {
    await installSerial(page);
    // Install a running deterministic date. Do not pause navigation or app timers.
    await page.clock.install({ time: new Date(data.anchor) });
    await page.goto('/');
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await expect(flow.getByRole('navigation', { name: 'Automation setup steps' })).toBeVisible();
    await flow.getByLabel('Automation transport', { exact: true }).selectOption('serial');
    await flow.getByLabel('Serial completion prompt', { exact: true }).fill('# ');
    await stage(flow, 'Commands');
    await flow.getByLabel('Command 1 script', { exact: true }).fill(data.command);
    await stage(flow, 'Timing');
    await flow.getByLabel('Run mode', { exact: true }).selectOption('scheduled');
    const date = flow.getByLabel('Scheduled start date', { exact: true });
    const time = flow.getByLabel('Scheduled start time', { exact: true });
    const next = flow.getByRole('button', { name: 'Next: Review & Run', exact: true });
    await next.click();
    await expect(date).toBeFocused();
    await expect(date).toHaveAttribute('aria-required', 'true');
    await expect(time).toHaveAttribute('aria-invalid', 'true');
    await expect(await fieldError(page, date)).toContainText('Choose a start date.');
    await expect(await fieldError(page, time)).toContainText('Choose a start time.');

    await flow.getByLabel('Start timezone', { exact: true }).selectOption(data.zone);
    await date.fill(data.gap.date);
    await time.fill(data.gap.time);
    await next.click();
    await expect(date).toBeFocused();
    await expect(await fieldError(page, date)).toContainText('This local time does not exist');
    await expect(await fieldError(page, time)).toContainText('This local time does not exist');
    await expect(date).toHaveValue(data.gap.date);
    await expect(time).toHaveValue(data.gap.time);

    await date.fill(data.fold.date);
    await time.fill(data.fold.time);
    const occurrence = flow.getByLabel('Repeated time occurrence', { exact: true });
    await next.click();
    await expect(occurrence).toBeFocused();
    await expect(occurrence).toHaveAttribute('aria-required', 'true');
    await expect(occurrence).toHaveAttribute('aria-invalid', 'true');
    await expect(await fieldError(page, occurrence)).toContainText('repeats');
    await expect(occurrence.locator('option')).toHaveText([
        'Choose if this time repeats', 'Earlier · UTC-04:00', 'Later · UTC-05:00',
    ]);
    await occurrence.selectOption(data.earlier.offset);
    await expect(occurrence).not.toHaveAttribute('aria-invalid', 'true');
    await next.click();
    await expect(flow.getByRole('heading', { name: 'Review & Run', exact: true })).toBeVisible();
    await expect(flow.locator('.automation-preview')).toContainText('Start ' + data.earlier.utc + ' · ' + data.zone + ' UTC' + data.earlier.offset + ' · local clock');
    await expect(flow.getByRole('button', { name: 'Fix required fields', exact: true })).toHaveCount(0);

    await stage(flow, 'Timing');
    await occurrence.selectOption(data.later.offset);
    await next.click();
    await expect(flow.locator('.automation-preview')).toContainText('Start ' + data.later.utc + ' · ' + data.zone + ' UTC' + data.later.offset + ' · local clock');
    await expect(flow.locator('.automation-preview')).not.toContainText(data.earlier.utc);
    await stage(flow, 'Timing');
    const clock = flow.getByLabel('Start clock', { exact: true });
    await clock.selectOption('device');
    await next.click();
    await expect(clock).toBeFocused();
    await expect(await fieldError(page, clock)).toContainText('Choose local time for Serial scheduling.');
    await expect(flow.getByRole('button', { name: 'Sample device clock', exact: true })).toBeDisabled();

    await clock.selectOption('local');
    const reference = await flow.getByLabel('Current time reference', { exact: true }).innerText();
    await page.clock.runFor(2100);
    await expect(flow.getByLabel('Current time reference', { exact: true })).not.toHaveText(reference);
    await expect(date).toHaveValue(data.fold.date);
    await expect(time).toHaveValue(data.fold.time);
    await expect(occurrence).toHaveValue(data.later.offset);
    await next.click();
    await expect(flow.locator('.automation-preview')).toContainText(data.later.utc);
    // Disconnected state is the reason execution controls remain disabled; this case never arms a runner.
    await expect(flow.getByRole('button', { name: 'Start flow', exact: true })).toBeDisabled();
    await expect(flow.getByRole('button', { name: 'Run once at scheduled time', exact: true })).toBeDisabled();
    const fakeSerial = await page.evaluate(() => ({
        opens: window.serialTest.opens, closes: window.serialTest.closes,
        readers: window.serialTest.readers, writes: window.serialTest.writes,
    }));
    expect(fakeSerial).toEqual({ opens: 0, closes: 0, readers: 0, writes: [] });
    await info.attach('schedule-fields-acceptance', {
        body: JSON.stringify({ missingFieldGuidance: true, gapRejected: true, foldPreviews: [data.earlier, data.later], serialClockGuidance: true, draftStableAfterClockAdvanceMs: 2100, runnerArmingRequested: false, fakeSerial, downloadsRequested: 0 }),
        contentType: 'application/json',
    });
});
