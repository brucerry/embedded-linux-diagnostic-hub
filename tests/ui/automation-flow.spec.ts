import { expect, test, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { installDesktop } from './fixtures/desktop';
import { installSshStream } from './fixtures/ssh-stream';

const setup = (flow: Locator, name: string) =>
    flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
async function prepare(page: Page, count = 3) {
    await installDesktop(page);
    await installSshStream(page, {
        connection: 'flow-viewer-synthetic-001',
        stdout: 'synthetic ACK',
        stderr: '',
        exitCode: 0,
        delayMs: 180,
        tracking: 'flowTest',
        allowCancel: true,
    });
    await page.addInitScript(() => {
        const counters = {
            workers: 0,
            urls: 0,
            commands: [] as string[],
            completed: 0,
            cancelled: 0,
            active: 0,
            maxActive: 0,
        };
        (window as any).flowTest = counters;
        const keys = new Set<EventListenerOrEventListenerObject>();
        const add = document.addEventListener.bind(document),
            remove = document.removeEventListener.bind(document);
        (document as any).addEventListener = (
            type: string,
            listener: EventListenerOrEventListenerObject,
            options: any,
        ) => {
            if (type === 'keydown') keys.add(listener);
            (counters as any).listeners = keys.size;
            add(type, listener, options);
        };
        (document as any).removeEventListener = (
            type: string,
            listener: EventListenerOrEventListenerObject,
            options: any,
        ) => {
            if (type === 'keydown') keys.delete(listener);
            (counters as any).listeners = keys.size;
            remove(type, listener, options);
        };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            ended = false;
            constructor(...args: ConstructorParameters<typeof Worker>) {
                super(...args);
                counters.workers++;
            }
            terminate() {
                if (!this.ended) {
                    this.ended = true;
                    counters.workers--;
                }
                super.terminate();
            }
        };
        const create = URL.createObjectURL.bind(URL),
            revoke = URL.revokeObjectURL.bind(URL);
        const urls = new Set<string>();
        URL.createObjectURL = (object) => {
            const url = create(object);
            urls.add(url);
            counters.urls = urls.size;
            return url;
        };
        URL.revokeObjectURL = (url) => {
            urls.delete(url);
            counters.urls = urls.size;
            revoke(url);
        };
        window.diagnosticHub!.automationConnection = () => 'flow-viewer-synthetic-001';
        window.diagnosticHub!.cancelAutomation = async () => {
            counters.cancelled++;
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await setup(flow, 'Commands');
    for (let i = 1; i <= count; i++) {
        if (i > 1) await flow.getByRole('button', { name: 'Add command', exact: true }).click();
        await flow.getByLabel(`Step ${i} name (optional)`).fill(`Inspect ${i}`);
        await flow.getByLabel(`Command ${i} script`).fill(`printf 'command ${i}'`);
    }
    return flow;
}
async function exportFile(page: Page, dialog: Locator, format: string) {
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        dialog.getByRole('button', { name: `Export ${format}`, exact: true }).click(),
    ]);
    await expect(dialog.getByRole('status', { name: 'Flow export status' })).toContainText(
        `${format} exported`,
    );
    return { download, bytes: await readFile((await download.path())!) };
}

test('lazy viewer supports ordered arrows, drag, keyboard, full details, focus and reduced motion', async ({
    page,
}, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    const flow = await prepare(page, 6);
    const command = '<script>hostile()</script> 日本語 😀\n' + 'long label '.repeat(100);
    await flow.getByLabel('Command 6 script').fill(command);
    expect(requests.some((url) => /FlowViewer\.tsx|export\.worker/.test(url))).toBe(false);
    const trigger = flow.getByRole('button', { name: 'Show flow', exact: true });
    const listeners = await page.evaluate(() => (window as any).flowTest.listeners);
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-flow-edge]')).toHaveCount(5);
    await expect(dialog.locator('[data-flow-node]')).toHaveCount(6);
    const first = dialog.locator('[data-ordinal="1"]'),
        last = dialog.locator('[data-ordinal="6"]');
    const before = await first.evaluate((e) => (e as HTMLElement).style.left);
    await first.focus();
    await first.press('ArrowRight');
    expect(await first.evaluate((e) => (e as HTMLElement).style.left)).not.toBe(before);
    await last.focus();
    await last.press('Enter');
    await expect(dialog.getByLabel('Full command 6')).toHaveText(command);
    const paths = await dialog
        .locator('[data-flow-edge]')
        .evaluateAll((nodes) => nodes.map((e) => e.getAttribute('d')));
    const box = (await last.boundingBox())!;
    await page.mouse.move(box.x + 35, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 90, { steps: 8 });
    await page.mouse.up();
    expect(
        await dialog
            .locator('[data-flow-edge]')
            .evaluateAll((nodes) => nodes.map((e) => e.getAttribute('d'))),
    ).not.toEqual(paths);
    await dialog.getByRole('button', { name: 'Fit graph' }).click();
    await dialog.getByRole('button', { name: 'Zoom in' }).click();
    await dialog.getByRole('group', { name: 'Flow canvas' }).focus();
    await page.keyboard.press('ArrowLeft');
    await dialog.getByRole('button', { name: 'Reset layout' }).click();
    await expect(dialog.locator('[data-ordinal="1"]')).toHaveCSS('left', '0px');
    await expect(page.locator('.toast')).not.toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: `evidence/${info.project.name}-wide.png` });
    await page.setViewportSize({ width: 412, height: 915 });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    await page.screenshot({ path: `evidence/${info.project.name}-narrow.png` });
    await first.focus();
    for (let i = 0; i < 60; i++) await first.press('Shift+ArrowLeft');
    await last.focus();
    for (let i = 0; i < 60; i++) await last.press('Shift+ArrowRight');
    await expect(first).toHaveCSS('left', '-2000px');
    await expect(last).toHaveCSS('left', '2000px');
    await dialog.getByRole('button', { name: 'Fit graph' }).click();
    const fitted = (await dialog.getByRole('group', { name: 'Flow canvas' }).boundingBox())!;
    for (const card of await dialog.locator('[data-flow-node]').all()) {
        const box = (await card.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(fitted.x);
        expect(box.x + box.width).toBeLessThanOrEqual(fitted.x + fitted.width);
    }
    await dialog.getByRole('button', { name: 'Reset layout' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => (window as any).flowTest.listeners)).toBe(listeners);
    await expect(flow.getByLabel('Command 6 script')).toHaveValue(command);
    expect(await page.evaluate(() => (window as any).flowTest.commands)).toEqual([]);
});

test('bounded maximum commands export with explicit downscale while timers and execution continue', async ({
    page,
}, info) => {
    const flow = await prepare(page, 20);
    const commands = Array.from(
        { length: 20 },
        (_, i) => `command ${i + 1} ` + 'abcdefghijklmnop'.repeat(165),
    );
    for (let i = 1; i <= 20; i++)
        await flow.getByLabel(`Command ${i} script`).fill(commands[i - 1]);
    await setup(flow, 'Timing');
    await flow.getByLabel('Repeat completed flow', { exact: true }).check();
    await flow.getByLabel('Repetition delay', { exact: true }).fill('1');
    await setup(flow, 'Review');
    const monitor = () =>
        page.evaluate(() => {
            const state = { last: performance.now(), gap: 0, phase: 'No viewer', codecMax: 0 };
            (window as any).flowHeartbeat = state;
            (window as any).flowHeartbeatTimer = setInterval(() => {
                const now = performance.now();
                if (now - state.last > state.gap) {
                    state.gap = now - state.last;
                    state.phase =
                        document.querySelector('.flow-export-notice')?.textContent ?? 'No viewer';
                }
                state.last = now;
            }, 20);
        });
    await monitor();
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect(flow.locator('.automation-state')).toContainText('Flow finished', {
        timeout: 15000,
    });
    const baseline = await page.evaluate(() => {
        clearInterval((window as any).flowHeartbeatTimer);
        return (window as any).flowHeartbeat.gap;
    });
    await flow.getByRole('button', { name: 'Clear retained results', exact: true }).click();
    await flow.getByRole('button', { name: 'Start flow', exact: true }).click();
    await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
    await monitor();
    await dialog.getByRole('button', { name: 'Export PNG', exact: true }).click();
    await expect(dialog.getByRole('status', { name: 'Flow export status' })).toContainText(
        'Allow PNG downscale',
    );
    await dialog.getByLabel('Allow PNG downscale', { exact: true }).check();
    const png = await exportFile(page, dialog, 'PNG');
    expect(png.bytes.readUInt32BE(16) * png.bytes.readUInt32BE(20)).toBeLessThanOrEqual(8_000_000);
    const pdf = await exportFile(page, dialog, 'PDF');
    await pdf.download.saveAs(`evidence/${info.project.name}-long.pdf`);
    await page.keyboard.press('Escape');
    await expect
        .poll(() => page.evaluate(() => (window as any).flowTest.completed), { timeout: 15000 })
        .toBeGreaterThanOrEqual(40);
    await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).flowTest.active)).toBe(0);
    const result = await page.evaluate(() => {
        clearInterval((window as any).flowHeartbeatTimer);
        return {
            gap: (window as any).flowHeartbeat.gap,
            phase: (window as any).flowHeartbeat.phase,
            commands: (window as any).flowTest.commands,
        };
    });
    await info.attach('maximum-flow-heartbeat', {
        body: JSON.stringify({
            baselineMaximumTimerGapMs: baseline,
            maximumTimerGapMs: result.gap,
            phaseAtMaximum: result.phase,
            commands: result.commands.length,
        }),
        contentType: 'application/json',
    });
    expect(baseline).toBeLessThan(500);
    expect(result.gap).toBeLessThan(500);
    expect(result.commands).toEqual(
        Array.from({ length: result.commands.length }, (_, i) => commands[i % 20]),
    );
});

test('20-command full-scene exports are inert, paginated and release worker/URL resources', async ({
    page,
}, info) => {
    const flow = await prepare(page, 20);
    await flow
        .getByLabel('Command 20 script')
        .fill('<img src="https://no-fetch.invalid/">& 日本語 😀\nlast command');
    await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-flow-edge]')).toHaveCount(19);
    for (let i = 0; i < 3; i++) await dialog.getByRole('button', { name: 'Zoom in' }).click();
    const exported = await exportFile(page, dialog, 'SVG');
    const source = exported.bytes.toString();
    expect(source).toContain('20. Inspect 20');
    expect(source).toContain(
        '&lt;img src=&quot;https://no-fetch.invalid/&quot;&gt;&amp; 日本語 😀',
    );
    expect(source).not.toMatch(/<image|<foreignObject|<script|href=/);
    await exported.download.saveAs(`evidence/${info.project.name}-full.svg`);
    const png = await exportFile(page, dialog, 'PNG');
    expect(png.bytes.subarray(1, 4).toString()).toBe('PNG');
    const width = png.bytes.readUInt32BE(16),
        height = png.bytes.readUInt32BE(20);
    expect(width * height).toBeLessThanOrEqual(16_000_000);
    expect(height).toBeGreaterThan(2000);
    const pdf = await exportFile(page, dialog, 'PDF');
    expect(pdf.bytes.subarray(0, 8).toString()).toBe('%PDF-1.4');
    const count = Number(/\/Type \/Pages \/Count (\d+)/.exec(pdf.bytes.toString('latin1'))![1]);
    expect(count).toBeGreaterThan(3);
    await pdf.download.saveAs(`evidence/${info.project.name}-full.pdf`);
    await expect.poll(() => page.evaluate(() => (window as any).flowTest.workers)).toBe(0);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).flowTest.urls)).toBe(0);
    expect(await page.evaluate(() => (window as any).flowTest.commands)).toEqual([]);
});

test('open, drag, export and close preserve exact bytes/count/order during active repetition', async ({
    page,
}, info) => {
    const flow = await prepare(page, 20),
        expected = Array.from({ length: 20 }, (_, i) => `printf 'command ${i + 1}'`);
    await setup(flow, 'Timing');
    await flow.getByLabel('Repeat completed flow', { exact: true }).check();
    await flow.getByLabel('Repetition delay', { exact: true }).fill('1');
    await setup(flow, 'Review');
    await flow.getByRole('button', { name: 'Start flow', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => (window as any).flowTest.commands.length))
        .toBeGreaterThanOrEqual(1);
    await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
    await expect(dialog.locator('.flow-kind')).toHaveText('Active snapshot');
    await dialog.locator('[data-ordinal="2"]').focus();
    await page.keyboard.press('ArrowDown');
    await dialog.getByRole('button', { name: 'Zoom in' }).click();
    await exportFile(page, dialog, 'SVG');
    await exportFile(page, dialog, 'PNG');
    await exportFile(page, dialog, 'PDF');
    await page.keyboard.press('Escape');
    await expect
        .poll(() => page.evaluate(() => (window as any).flowTest.completed), { timeout: 15000 })
        .toBeGreaterThanOrEqual(40);
    await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
    await expect(flow.locator('.automation-state')).toContainText(/finished|stopped|cancelled/);
    await expect.poll(() => page.evaluate(() => (window as any).flowTest.active)).toBe(0);
    const counters = await page.evaluate(() => (window as any).flowTest);
    expect(counters.maxActive).toBe(1);
    expect(counters.cancelled).toBeLessThanOrEqual(1); // One in-flight command may be cancelled explicitly.
    expect(counters.commands).toEqual(
        Array.from({ length: counters.commands.length }, (_, i) => expected[i % 20]),
    );
    expect(counters.completed + counters.cancelled).toBe(counters.commands.length);
    const cutoff = counters.commands.length;
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as any).flowTest.commands.length)).toBe(cutoff);
    await page.screenshot({ path: `evidence/${info.project.name}-continuity.png` });
});

test('scheduled and delayed execution matches the same baseline with the viewer; active snapshot survives draft edits', async ({
    page,
}) => {
    const traces: string[][] = [];
    for (const show of [false, true]) {
        const flow = await prepare(page, 3);
        await setup(flow, 'Timing');
        await flow.getByLabel('Command 2 delay', { exact: true }).fill('0.2');
        await flow.getByLabel('Run mode', { exact: true }).selectOption('scheduled');
        await flow.getByLabel('Start timezone', { exact: true }).selectOption('UTC');
        const start = new Date(await page.evaluate(() => Date.now() + 7000)).toISOString();
        await flow.getByLabel('Scheduled start date', { exact: true }).fill(start.slice(0, 10));
        await flow.getByLabel('Scheduled start time', { exact: true }).fill(start.slice(11, 19));
        await setup(flow, 'Review');
        await flow.getByRole('button', { name: 'Run once at scheduled time', exact: true }).click();
        if (show) {
            await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
            await expect(dialog.locator('.flow-summary')).toContainText('waiting');
            await exportFile(page, dialog, 'PDF');
            await page.keyboard.press('Escape');
            await setup(flow, 'Commands');
            await flow.getByLabel('Command 1 script').fill('next-run draft only');
            await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
            await expect(dialog.getByLabel('Full command 1')).toHaveText("printf 'command 1'");
            await page.keyboard.press('Escape');
        }
        await expect(flow.locator('.automation-state')).toContainText('Flow finished', {
            timeout: 15000,
        });
        traces.push(await page.evaluate(() => (window as any).flowTest.commands));
    }
    expect(traces[1]).toEqual(traces[0]);
    expect(traces[1]).toEqual(["printf 'command 1'", "printf 'command 2'", "printf 'command 3'"]);
});

test('disconnect, pointer cancellation and closing during export release only viewer resources', async ({
    page,
}) => {
    const flow = await prepare(page, 3);
    await setup(flow, 'Timing');
    await flow.getByLabel('Repeat completed flow', { exact: true }).check();
    await flow.getByLabel('Repetition delay', { exact: true }).fill('1');
    await setup(flow, 'Review');
    await flow.getByRole('button', { name: 'Start flow', exact: true }).click();
    await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
    const canvas = dialog.getByRole('group', { name: 'Flow canvas' });
    await canvas.dispatchEvent('pointercancel', { pointerId: 1 });
    await dialog.getByRole('button', { name: 'Export PDF', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as any).flowTest.workers)).toBe(0);
    await expect.poll(() => page.evaluate(() => (window as any).flowTest.urls)).toBe(0);
    await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
    await page.evaluate(() => window.desktopTest.closeConnection?.());
    await expect(dialog.locator('.flow-summary')).toContainText(/paused|disconnected/i, {
        timeout: 5000,
    });
    await page.keyboard.press('Escape');
    const sent = await page.evaluate(() => (window as any).flowTest.commands.length);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as any).flowTest.commands.length)).toBe(sent);
    expect(await page.evaluate(() => window.desktopTest.terminal!.inputs)).toEqual([]);
});
