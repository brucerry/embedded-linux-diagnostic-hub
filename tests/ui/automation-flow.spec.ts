import { expect, test, type Page, type Locator, type CDPSession } from '@playwright/test';
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
    test.slow();
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
    const diagnosticEnabled = process.env.HUB_FLOW_HEARTBEAT_DIAGNOSTIC === '1';
    let cdp: CDPSession | undefined,
        profileStartIssued = false,
        profileStopIssued = false,
        profileBytes: Buffer | undefined,
        primaryFailed = false;
    const diagnostic = {
        enabled: diagnosticEnabled,
        qualification: false,
        observerAndSamplingOverheadIncluded: true,
        observerBufferLossUnmeasured: true,
        loafAttribution: 'entry-point-only; not necessarily the hot function',
        samplingIntervalUs: 5000,
        retentionLimitBytes: 4 * 1024 * 1024,
        profileBytesObserved: 0,
        profileOverflow: false,
        profileStatus: 'not-started',
        profileScope: 'second-window-plus-clear-start-show-clicks; no baseline or editor setup',
        clockAlignment: 'raw start/stop renderer brackets only; no assumed CDP clock equality',
        startBefore: null as { timeOrigin: number; now: number } | null,
        startAfter: null as { timeOrigin: number; now: number } | null,
        stopBefore: null as { timeOrigin: number; now: number } | null,
        stopAfter: null as { timeOrigin: number; now: number } | null,
        errors: [] as string[],
    };
    const clock = () =>
        page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now() }));
    const phase = async (value: string) => {
        if (diagnosticEnabled)
            await page.evaluate((value) => {
                const state = (window as any).flowHeartbeatDiagnostic;
                if (state) state.phase = value;
            }, value);
    };
    const stopProfile = async () => {
        if (!cdp || !profileStartIssued || profileStopIssued) return;
        profileStopIssued = true;
        try {
            diagnostic.stopBefore = await clock();
        } catch {
            diagnostic.errors.push('stop-before-clock');
        }
        try {
            const { profile } = await cdp.send('Profiler.stop');
            diagnostic.profileStatus = 'stopped';
            // CDP/SDK already materialize the reply. This is a retention cap, not a heap quota.
            const bytes = Buffer.from(JSON.stringify(profile));
            diagnostic.profileBytesObserved = bytes.length;
            if (bytes.length <= diagnostic.retentionLimitBytes) profileBytes = bytes;
            else diagnostic.profileOverflow = true;
        } catch {
            diagnostic.profileStatus = 'stop-unproved';
            diagnostic.errors.push('profiler-stop');
        }
        try {
            diagnostic.stopAfter = await clock();
        } catch {
            diagnostic.errors.push('stop-after-clock');
        }
    };
    const monitor = (label: 'baseline' | 'viewer') =>
        page.evaluate(
            ({ enabled, label }) => {
                const host = window as any;
                const history = enabled
                    ? (host.flowHeartbeatDiagnostic ??= {
                          phase: label,
                          monitors: [],
                          observers: [],
                          longtask: { supported: false, seen: 0, overflow: false, rows: [] },
                          loaf: { supported: false, seen: 0, overflow: false, rows: [] },
                          observerErrors: 0,
                          observerCleanupErrors: 0,
                          observersDisconnected: 0,
                      })
                    : undefined;
                if (history) history.phase = label;
                const sample = () => ({
                    phase: history.phase,
                    modalPresent: Boolean(
                        document.querySelector('[role="dialog"][aria-label="Automation flow"]'),
                    ),
                    noticePresent: Boolean(document.querySelector('.flow-export-notice')),
                });
                const state = {
                    last: performance.now(),
                    gap: 0,
                    phase: 'No viewer',
                    codecMax: 0,
                    ...(enabled
                        ? {
                              label,
                              timeOrigin: performance.timeOrigin,
                              startedAt: performance.now(),
                              stoppedAt: null,
                              stoppedBy: null,
                              previous: sample(),
                              worst: null,
                          }
                        : {}),
                } as any;
                host.flowHeartbeat = state;
                host.flowHeartbeatTimer = setInterval(() => {
                    const now = performance.now();
                    const after = enabled ? sample() : undefined;
                    if (now - state.last > state.gap) {
                        state.gap = now - state.last;
                        state.phase =
                            document.querySelector('.flow-export-notice')?.textContent ??
                            'No viewer';
                        if (enabled)
                            state.worst = {
                                start: state.last,
                                end: now,
                                before: state.previous,
                                after,
                            };
                    }
                    state.last = now;
                    if (enabled) state.previous = after;
                }, 20);
                if (!history) return;
                history.monitors.push({ state, timer: host.flowHeartbeatTimer });
                if (label !== 'viewer') return;
                const start = state.startedAt;
                const finite = (value: unknown) =>
                    typeof value === 'number' && Number.isFinite(value) ? value : null;
                const text = (value: unknown, limit: number) =>
                    typeof value === 'string' ? value.slice(0, limit) : '';
                const collect = (kind: 'longtask' | 'loaf', entries: PerformanceEntry[]) => {
                    for (const entry of entries) {
                        if (
                            entry.startTime + entry.duration < start ||
                            (state.stoppedAt !== null && entry.startTime > state.stoppedAt)
                        )
                            continue;
                        const value = entry as any,
                            bucket = history[kind];
                        bucket.seen++;
                        const row: any = {
                            startTime: finite(entry.startTime),
                            duration: finite(entry.duration),
                        };
                        if (kind === 'loaf') {
                            row.renderStart = finite(value.renderStart);
                            row.styleAndLayoutStart = finite(value.styleAndLayoutStart);
                            row.blockingDuration = finite(value.blockingDuration);
                            const scripts = Array.isArray(value.scripts) ? value.scripts : [];
                            row.scriptCount = scripts.length;
                            row.scriptsOverflow = scripts.length > 8;
                            row.scripts = scripts.slice(0, 8).map((script: any) => ({
                                startTime: finite(script.startTime),
                                duration: finite(script.duration),
                                executionStart: finite(script.executionStart),
                                forcedStyleAndLayoutDuration: finite(
                                    script.forcedStyleAndLayoutDuration,
                                ),
                                sourceURL: text(script.sourceURL, 256),
                                sourceFunctionName: text(script.sourceFunctionName, 128),
                                sourceCharPosition: finite(script.sourceCharPosition),
                                invoker: text(script.invoker, 128),
                                invokerType: text(script.invokerType, 64),
                            }));
                        }
                        // Keep the 32 longest per kind; explicit overflow preserves incompleteness.
                        bucket.rows.push(row);
                        bucket.rows.sort((a: any, b: any) => b.duration - a.duration);
                        if (bucket.rows.length > 32) {
                            bucket.rows.length = 32;
                            bucket.overflow = true;
                        }
                    }
                };
                for (const [kind, type] of [
                    ['longtask', 'longtask'],
                    ['loaf', 'long-animation-frame'],
                ] as const) {
                    if (
                        typeof PerformanceObserver === 'undefined' ||
                        !PerformanceObserver.supportedEntryTypes.includes(type)
                    )
                        continue;
                    history[kind].supported = true;
                    try {
                        const observer = new PerformanceObserver((list) => {
                            try {
                                collect(kind, list.getEntries());
                            } catch {
                                history.observerErrors++;
                            }
                        });
                        history.observers.push({ observer, kind, collect });
                        observer.observe({ type, buffered: true });
                    } catch {
                        history.observerErrors++;
                    }
                }
            },
            { enabled: diagnosticEnabled, label },
        );
    try {
        await monitor('baseline');
        await flow.getByRole('button', { name: 'Run once', exact: true }).click();
        await expect(flow.locator('.automation-state')).toContainText('Flow finished', {
            timeout: 15000,
        });
        const baseline = await page.evaluate(() => {
            clearInterval((window as any).flowHeartbeatTimer);
            const state = (window as any).flowHeartbeat;
            if (state.label) {
                state.stoppedAt = performance.now();
                state.stoppedBy = 'baseline-normal';
            }
            return state.gap;
        });
        // Arm the diagnostic in the idle gap. Preserve the original Show-flow → monitor
        // adjacency; the CPU profile also includes the Clear/Start/Show setup clicks, explicitly bracketed.
        if (diagnosticEnabled) {
            cdp = await page.context().newCDPSession(page);
            await cdp.send('Profiler.enable');
            await cdp.send('Profiler.setSamplingInterval', { interval: 5000 });
            diagnostic.startBefore = await clock();
            profileStartIssued = true;
            diagnostic.profileStatus = 'start-issued';
            await cdp.send('Profiler.start');
            diagnostic.profileStatus = 'started';
            diagnostic.startAfter = await clock();
        }
        await flow.getByRole('button', { name: 'Clear retained results', exact: true }).click();
        await flow.getByRole('button', { name: 'Start flow', exact: true }).click();
        await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
        await monitor('viewer');
        await phase('initial-png');
        await dialog.getByRole('button', { name: 'Export PNG', exact: true }).click();
        await expect(dialog.getByRole('status', { name: 'Flow export status' })).toContainText(
            'Allow PNG downscale',
        );
        await dialog.getByLabel('Allow PNG downscale', { exact: true }).check();
        await phase('downscaled-png');
        const png = await exportFile(page, dialog, 'PNG');
        expect(png.bytes.readUInt32BE(16) * png.bytes.readUInt32BE(20)).toBeLessThanOrEqual(
            8_000_000,
        );
        await phase('pdf');
        const pdf = await exportFile(page, dialog, 'PDF');
        await pdf.download.saveAs(`evidence/${info.project.name}-long.pdf`);
        await phase('closing-viewer');
        await page.keyboard.press('Escape');
        await phase('waiting-completions');
        await expect
            .poll(() => page.evaluate(() => (window as any).flowTest.completed), { timeout: 15000 })
            .toBeGreaterThanOrEqual(40);
        await phase('cancel-run');
        await flow.getByRole('button', { name: 'Cancel run', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).flowTest.active)).toBe(0);
        const result = await page.evaluate(() => {
            clearInterval((window as any).flowHeartbeatTimer);
            const state = (window as any).flowHeartbeat;
            if (state.label) {
                state.stoppedAt = performance.now();
                state.stoppedBy = 'viewer-normal';
            }
            return {
                gap: state.gap,
                phase: state.phase,
                commands: (window as any).flowTest.commands,
            };
        });
        await stopProfile();
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
    } catch (error) {
        primaryFailed = true;
        throw error;
    } finally {
        // Normal clear points above remain unchanged; this also owns aborted-measurement cleanup.
        let observation: unknown = null;
        try {
            const captured = await page.evaluate(() => {
                const host = window as any,
                    history = host.flowHeartbeatDiagnostic;
                clearInterval(host.flowHeartbeatTimer);
                if (!history) return null;
                for (const { state, timer } of history.monitors) {
                    clearInterval(timer);
                    if (state.stoppedAt === null) {
                        state.stoppedAt = performance.now();
                        state.stoppedBy = 'finally';
                    }
                }
                for (const { observer, kind, collect } of history.observers) {
                    try {
                        collect(kind, observer.takeRecords());
                    } catch {
                        history.observerErrors++;
                    }
                    try {
                        observer.disconnect();
                        history.observersDisconnected++;
                    } catch {
                        history.observerCleanupErrors++;
                    }
                }
                return {
                    timeOrigin: performance.timeOrigin,
                    monitors: history.monitors.map(({ state }: any) => state),
                    longtask: history.longtask,
                    loaf: history.loaf,
                    observerErrors: history.observerErrors,
                    observersCreated: history.observers.length,
                    observersDisconnected: history.observersDisconnected,
                    observerCleanupErrors: history.observerCleanupErrors,
                };
            });
            observation = captured;
            if (captured && captured.observerCleanupErrors > 0)
                diagnostic.errors.push('observer-disconnect');
        } catch {
            diagnostic.errors.push('observer-and-timer-cleanup');
        }
        await stopProfile();
        if (cdp) {
            try {
                await cdp.send('Profiler.disable');
            } catch {
                diagnostic.errors.push('profiler-disable');
            }
            try {
                await cdp.detach();
            } catch {
                diagnostic.errors.push('cdp-detach');
            }
        }
        if (diagnosticEnabled) {
            let body = Buffer.from(JSON.stringify({ diagnostic, observation }));
            if (body.length > 256 * 1024) {
                observation = { overflow: true, bytesObserved: body.length };
                body = Buffer.from(JSON.stringify({ diagnostic, observation }));
            }
            if (
                profileBytes &&
                profileBytes.length + body.length > diagnostic.retentionLimitBytes
            ) {
                diagnostic.profileOverflow = true;
                profileBytes = undefined; // never retain a truncated/invalid CPU profile.
                body = Buffer.from(JSON.stringify({ diagnostic, observation }));
            }
            try {
                await info.attach('flow-heartbeat-diagnostic', {
                    body,
                    contentType: 'application/json',
                });
            } catch {
                diagnostic.errors.push('diagnostic-attachment');
            }
            if (profileBytes) {
                try {
                    await info.attach('flow-main-isolate.cpuprofile', {
                        body: profileBytes,
                        contentType: 'application/json',
                    });
                } catch {
                    diagnostic.errors.push('profile-attachment');
                }
            }
        }
        if (!primaryFailed && diagnostic.errors.length)
            throw Error(
                'Flow diagnostic cleanup or capture failed: ' + diagnostic.errors.join(', '),
            );
    }
});

test('20-command full-scene exports are inert, paginated and release worker/URL resources', async ({
    page,
}, info) => {
    test.slow();
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
    test.slow();
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
    test.slow();
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
