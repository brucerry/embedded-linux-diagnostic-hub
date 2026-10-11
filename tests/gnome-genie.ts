import assert from 'node:assert/strict';
import { StringDecoder } from 'node:string_decoder';
import { _electron, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TerminalEvent } from '../shared/terminal';
import { sampleProfile } from '../shared/testing/simulation';
import type { TestReport } from '../shared/testing/types';

async function pageWaitForCancellation(desktop: Awaited<ReturnType<typeof _electron.launch>>) {
    await (await desktop.firstWindow()).waitForTimeout(1000);
}

async function main() {
    assert.equal(process.platform, 'linux');
    assert.equal(
        process.env.HUB_GNOME_ISOLATED,
        '1',
        'Run through tests/gnome-session.sh; never use a personal desktop.',
    );
    assert.ok(process.env.HUB_TEST_EXECUTABLE && process.env.HUB_TEST_LINUX_CONNECTION);
    const root = await mkdtemp(path.join(tmpdir(), 'hub-gnome-app-'));
    const output = path.resolve(process.env.HUB_GNOME_EVIDENCE || 'validation/gnome');
    await mkdir(output, { recursive: true });
    const evaluate = (source: string) => {
        const result = execFileSync(
            'gdbus',
            [
                'call',
                '--session',
                '--dest',
                'org.gnome.Shell',
                '--object-path',
                '/org/gnome/Shell',
                '--method',
                'org.gnome.Shell.Eval',
                JSON.stringify(source),
            ],
            { encoding: 'utf8', timeout: 5000 },
        );
        assert.match(result, /^\(true,/, result);
        return result;
    };
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
        ),
    ) as Record<string, string>;
    const launch = (control: boolean) =>
        _electron.launch({
            executablePath: process.env.HUB_TEST_EXECUTABLE,
            chromiumSandbox: true,
            env: environment,
            args: [
                `--ozone-platform=${process.env.HUB_GNOME_BACKEND || 'wayland'}`,
                `--user-data-dir=${path.join(root, control ? 'control' : 'target')}`,
                ...(control ? ['--class=hub-control'] : []),
                ...(process.env.HUB_TEST_APPIMAGE ? ['--appimage-extract-and-run'] : []),
            ],
            timeout: 40_000,
        });
    const stress = process.env.HUB_GNOME_STRESS === '1';
    const responsiveness: number[] = [];
    const failures: string[] = [];
    const traceBounds = process.env.HUB_GNOME_TRACE_BOUNDS === '1';
    if (traceBounds) environment.WAYLAND_DEBUG = 'client';
    const protocol: Array<{ timeMs: number; line: string }> = [];
    let flushProtocol = () => {};
    let protocolTraceState: Record<string, number> = {};
    const resourceSamples: Array<unknown> = [];
    const runtimeEvents: Array<unknown> = [];
    const runtimeStderr: string[] = [];
    let stderrCharacters = 0;
    const stderrLimit = 2 * 1024 * 1024;
    const recordResources = () => {
        const sample: Record<string, unknown> = { timeMs: Number(process.hrtime.bigint()) / 1e6 };
        try {
            const shared = statfsSync('/dev/shm');
            sample.sharedMemory = {
                capacityBytes: shared.bsize * shared.blocks,
                availableBytes: shared.bsize * shared.bavail,
                usedBytes: shared.bsize * (shared.blocks - shared.bfree),
            };
        } catch (error) {
            sample.sharedMemoryError = String(error);
        }
        for (const name of ['memory.current', 'memory.max', 'memory.events']) {
            try {
                sample[name] = readFileSync('/sys/fs/cgroup/' + name, 'utf8')
                    .slice(0, 2048)
                    .trim();
            } catch (error) {
                sample[name] = String(error);
            }
        }
        resourceSamples.push(sample);
        if (resourceSamples.length > 600) resourceSamples.shift();
    };
    const captureStderr = (data: Buffer) => {
        const text = data.toString().slice(-stderrLimit);
        runtimeStderr.push(text);
        stderrCharacters += text.length;
        while (stderrCharacters > stderrLimit) stderrCharacters -= runtimeStderr.shift()!.length;
    };
    recordResources();
    const resourceTimer = setInterval(recordResources, 1000);
    resourceTimer.unref();
    const saveRuntimeDiagnostics = async () => {
        clearInterval(resourceTimer);
        recordResources();
        try {
            await writeFile(
                path.join(output, 'runtime-resource-profile.json'),
                JSON.stringify(
                    {
                        clock: 'Linux CLOCK_MONOTONIC ms',
                        resourceSamples,
                        runtimeEvents,
                        stderrRetainedCharacters: stderrCharacters,
                        stderrLimitCharacters: stderrLimit,
                    },
                    null,
                    2,
                ),
            );
            await writeFile(path.join(output, 'runtime-stderr.log'), runtimeStderr.join(''));
        } catch (error) {
            console.error('Could not retain runtime diagnostics: ' + String(error));
        }
    };
    let desktop: Awaited<ReturnType<typeof launch>>;
    try {
        desktop = await launch(false);
    } catch (error) {
        runtimeEvents.push({ type: 'launch-error', error: String(error) });
        await saveRuntimeDiagnostics();
        throw error;
    }
    desktop.process().stderr?.on('data', captureStderr);
    if (traceBounds) {
        const decoder = new StringDecoder('utf8');
        let pending = '';
        let protocolDroppedRows = 0;
        let truncatedPartialLines = 0;
        const protocolLimitRows = 20000;
        const recordProtocolLine = (line: string) => {
            if (
                /xdg_(toplevel|surface).*?(configure|ack_configure|set_window_geometry|set_min_size|set_maximized|unset_maximized|set_minimized)|wl_surface.*?(attach|commit|frame|set_buffer_scale)|wl_shm_pool.*create_buffer|zwp_linux_buffer_params.*create|wl_buffer.*destroy/.test(
                    line,
                )
            ) {
                protocol.push({ timeMs: Number(process.hrtime.bigint()) / 1e6, line });
                if (protocol.length > protocolLimitRows) {
                    protocol.splice(0, 500);
                    protocolDroppedRows += 500;
                }
            }
        };
        const consumeProtocol = (data: Buffer) => {
            pending += decoder.write(data);
            const lines = pending.split('\n');
            pending = lines.pop()!;
            if (pending.length > 65536) {
                pending = pending.slice(-65536);
                truncatedPartialLines++;
            }
            for (const line of lines) recordProtocolLine(line);
        };
        desktop.process().stderr?.on('data', consumeProtocol);
        desktop.process().stderr?.once('end', () => {
            pending += decoder.end();
            if (pending) recordProtocolLine(pending);
            pending = '';
        });
        // Flush a final partial line at the evidence boundary, without timed-cycle I/O.
        flushProtocol = () => {
            if (pending) recordProtocolLine(pending);
            protocolTraceState = {
                droppedRows: protocolDroppedRows,
                truncatedPartialLines,
                pendingCharacters: pending.length,
                limitRows: protocolLimitRows,
            };
        };
        await desktop
            .evaluate(({ BrowserWindow, app, screen }) => {
                const rows: Array<unknown> = [];
                (app as typeof app & { boundsTrace: Array<unknown> }).boundsTrace = rows;
                const w = BrowserWindow.getAllWindows()[0];
                for (const name of [
                    'resize',
                    'resized',
                    'move',
                    'moved',
                    'minimize',
                    'restore',
                    'maximize',
                    'unmaximize',
                ]) {
                    (w as import('node:events').EventEmitter).on(name, () => {
                        rows.push({
                            event: name,
                            timeMs: Number(process.hrtime.bigint()) / 1e6,
                            bounds: w.getBounds(),
                            normal: w.getNormalBounds(),
                            content: w.getContentBounds(),
                            minimized: w.isMinimized(),
                            maximized: w.isMaximized(),
                            displays: screen.getAllDisplays().map((d) => ({
                                id: d.id,
                                scaleFactor: d.scaleFactor,
                                bounds: d.bounds,
                                workArea: d.workArea,
                            })),
                        });
                        if (rows.length > 5000) rows.shift();
                    });
                }
                rows.push({
                    event: 'trace-start',
                    timeMs: Number(process.hrtime.bigint()) / 1e6,
                    bounds: w.getBounds(),
                    normal: w.getNormalBounds(),
                    content: w.getContentBounds(),
                    displays: screen.getAllDisplays().map((d) => ({
                        id: d.id,
                        scaleFactor: d.scaleFactor,
                        bounds: d.bounds,
                        workArea: d.workArea,
                    })),
                });
            })
            .catch(async (error: unknown) => {
                runtimeEvents.push({ type: 'trace-setup-error', error: String(error) });
                await saveRuntimeDiagnostics();
                desktop.process().stderr?.off('data', captureStderr);
                await desktop.close();
                if (process.env.HUB_GNOME_PRESERVE_PROFILE !== '1')
                    await rm(root, { recursive: true, force: true });
                else await writeFile(path.join(output, 'profile-path.txt'), root + '\n');
                throw error;
            });
        assert.ok(
            (await desktop.evaluate(
                ({ app }) =>
                    (app as typeof app & { boundsTrace: Array<unknown> }).boundsTrace.length,
            )) > 0,
            'client trace was not installed',
        );
    }
    desktop.process().on('exit', (code, signal) => {
        runtimeEvents.push({
            type: 'process-exit',
            timeMs: Number(process.hrtime.bigint()) / 1e6,
            code,
            signal,
        });
        failures.push(`unexpected app exit ${code}/${signal}`);
    });
    const title = await desktop
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
        .catch(async (error: unknown) => {
            runtimeEvents.push({ type: 'window-setup-error', error: String(error) });
            await saveRuntimeDiagnostics();
            throw error;
        });
    const control = spawn('gjs', ['-m', 'tests/fixtures/gnome-control.js', title], {
        env: environment,
        stdio: 'ignore',
    });
    try {
        const page = await desktop.firstWindow();
        page.on('crash', () =>
            runtimeEvents.push({
                type: 'renderer-crash',
                timeMs: Number(process.hrtime.bigint()) / 1e6,
            }),
        );
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        await desktop.evaluate(({ app, ipcMain }) => {
            const counts: Record<string, number> = {};
            const events: Array<unknown> = [];
            (app as typeof app & { qualificationEvents: Array<unknown> }).qualificationEvents =
                events;
            (
                app as typeof app & { qualificationCounts: Record<string, number> }
            ).qualificationCounts = counts;
            const handlers = (
                ipcMain as typeof ipcMain & {
                    _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
                }
            )._invokeHandlers;
            for (const name of [
                'connect',
                'disconnect',
                'terminal-open',
                'terminal-close',
                'collect',
                'device-clock',
                'tests-start',
            ]) {
                const original = handlers.get('hub:' + name)!;
                handlers.set('hub:' + name, (...args) => {
                    counts[name] = (counts[name] || 0) + 1;
                    const started = Number(process.hrtime.bigint()) / 1e6;
                    events.push({ event: 'request-start', name, timeMs: started });
                    const result = original(...args);
                    Promise.resolve(result).then(
                        () =>
                            events.push({
                                event: 'request-end',
                                name,
                                timeMs: Number(process.hrtime.bigint()) / 1e6,
                                durationMs: Number(process.hrtime.bigint()) / 1e6 - started,
                            }),
                        () =>
                            events.push({
                                event: 'request-failed',
                                name,
                                timeMs: Number(process.hrtime.bigint()) / 1e6 - started,
                            }),
                    );
                    return result;
                });
            }
        });
        const connection = JSON.parse(
            await readFile(process.env.HUB_TEST_LINUX_CONNECTION!, 'utf8'),
        );
        assert.equal(
            connection.fixture,
            'gnome-software-continuity-v1',
            'Use the owned software fixture; never a hardware endpoint.',
        );
        assert.equal(connection.host, '127.0.0.1');
        assert.equal(connection.port, 22223);
        await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('Hostname or IP address').fill(connection.host);
        await modal.getByLabel('Port', { exact: true }).fill(String(connection.port));
        await modal.getByLabel('SSH username').fill(connection.username);
        await modal.getByLabel('Password', { exact: true }).fill(connection.password);
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await page.getByRole('button', { name: 'Trust device', exact: true }).click();
        await expect(modal).not.toBeVisible({ timeout: 25_000 });
        await page.getByLabel('Live update interval').selectOption('5');
        if (
            (await page
                .getByRole('switch', { name: 'Live updates' })
                .getAttribute('aria-checked')) !== 'true'
        )
            await page.getByRole('switch', { name: 'Live updates' }).click();
        await page.evaluate(() => {
            const gaps: number[] = [];
            let previous = performance.now();
            (window as typeof window & { qualificationLoopGaps: number[] }).qualificationLoopGaps =
                gaps;
            setInterval(() => {
                const now = performance.now();
                gaps.push(now - previous);
                previous = now;
            }, 50);
        });
        await page.evaluate(() => {
            const state = {
                ids: [] as string[],
                sequences: [] as number[],
                output: '',
                states: [] as string[],
            };
            (window as typeof window & { nativeTerminal: typeof state }).nativeTerminal = state;
            window.diagnosticHub!.onTerminalEvent!((event: TerminalEvent) => {
                state.ids.push(event.id);
                if (event.type === 'data') {
                    state.sequences.push(event.sequence);
                    state.output += atob(event.data);
                } else state.states.push(event.state);
            });
        });
        await page
            .locator('.primary-nav')
            .getByRole('button', { name: 'Terminal', exact: true })
            .click();
        await expect(page.locator('.xterm-helper-textarea')).toBeAttached();
        await page.locator('.xterm-helper-textarea').focus();
        // The real remote Bash PTY emits for 42 seconds, exceeding the 30-second stall deadline.
        await page.keyboard.type(
            'printf \'HUB-PTY:%s:%s\\n\' $$ "$(tty)"; for i in {1..42}; do printf \'HUB-TICK:%s\\n\' "$i"; sleep 1; done; printf \'HUB-END:%s:%s\\n\' $$ "$(tty)"',
        );
        await page.keyboard.press('Enter');
        await page.waitForTimeout(800);
        const reportFile = path.join(output, 'native.json');
        await rm(reportFile, { force: true });
        const fixture = (await readFile('tests/fixtures/gnome-native.js', 'utf8'))
            .replace("'__TRACE_BOUNDS__'", JSON.stringify(traceBounds ? '1' : '0'))
            .replace(
                "'__PRIVATE_LAYER__'",
                JSON.stringify(process.env.HUB_GNOME_PRIVATE_LAYER === '1' ? '1' : '0'),
            )
            .replace(
                "'__KEEP_PRIVATE_LAYER__'",
                JSON.stringify(process.env.HUB_GNOME_PRIVATE_LAYER === '1' ? '1' : '0'),
            )
            .replace("'__REPORT_PATH__'", JSON.stringify(reportFile))
            .replace(
                "'__STRESS_ENABLED__'",
                JSON.stringify(process.env.HUB_GNOME_STRESS === '1' ? '1' : '0'),
            );
        evaluate('void ' + fixture);
        let overlappingRunId: string | undefined;
        if (stress) {
            await page.waitForTimeout(2500);
            const liveSwitch = page.getByRole('switch', { name: 'Live updates' });
            if ((await liveSwitch.getAttribute('aria-checked')) === 'true')
                await liveSwitch.click();
            await expect(
                page.getByRole('button', { name: 'Disconnect device', exact: true }),
            ).toBeEnabled({ timeout: 20000 });
            overlappingRunId = await page.evaluate(async (profile) => {
                const target = window.diagnosticHub!;
                await target.discoverTests!();
                const plan = await target.prepareTests!(profile);
                const id = profile.tests.find((test) => test.adapter === 'i2c.identity')!.id;
                const run = await target.startTests!({
                    profile,
                    inventoryId: plan.inventory.id,
                    testIds: [id],
                    sequence: '',
                    readiness: {
                        reviewed: true,
                        fixtures: { [id]: { ready: true, identity: 'Software fixture' } },
                    },
                });
                return run.id;
            }, sampleProfile());
            await expect
                .poll(() => page.evaluate(() => window.diagnosticHub!.readTestRun!()), {
                    timeout: 15000,
                })
                .toMatchObject({ id: overlappingRunId, phase: 'complete', verdict: 'Pass' });
            if ((await liveSwitch.getAttribute('aria-checked')) !== 'true')
                await liveSwitch.click();
        }
        let native:
            | {
                  ok: boolean;
                  error?: string;
                  cycles: number;
                  frames: unknown[];
                  checks: string[];
                  privateLayer?: { added: number };
              }
            | undefined;
        for (
            let attempt = 0;
            attempt < (process.env.HUB_GNOME_STRESS === '1' ? 600 : 400);
            attempt++
        ) {
            try {
                native = JSON.parse(await readFile(reportFile, 'utf8'));
                break;
            } catch {
                const started = performance.now();
                await page.evaluate(() => document.visibilityState);
                responsiveness.push(performance.now() - started);
                await page.waitForTimeout(500);
            }
            if (attempt % 60 === 59)
                console.log('Real GNOME native qualification is still running.');
        }
        assert.ok(native, 'native qualification exceeded its bounded 200/300-second deadline');
        console.log('Native qualification result: ' + JSON.stringify(native));
        assert.equal(native.ok, true, native.error);
        assert.equal(failures.length, 0, failures.join('; '));
        const summarize = (values: number[]) => {
            const sorted = [...values].sort((a, b) => a - b);
            return {
                samples: sorted.length,
                p50: sorted[Math.floor(sorted.length * 0.5)],
                p95: sorted[Math.floor(sorted.length * 0.95)],
                max: sorted.at(-1),
            };
        };
        const responseMetrics = summarize(responsiveness);
        assert.ok(responseMetrics.max! < 2000, 'renderer roundtrip exceeded 2 seconds');
        const rendererLoop = summarize(
            await page.evaluate(
                () =>
                    (window as typeof window & { qualificationLoopGaps: number[] })
                        .qualificationLoopGaps,
            ),
        );
        await writeFile(
            path.join(output, 'responsiveness.json'),
            JSON.stringify(
                {
                    responseMetrics,
                    rendererLoop,
                    overlappingRunId,
                    unexpectedAppExits: failures,
                    criteria: { roundtripMaxMs: 2000 },
                    scope: 'isolated software compositor and board fixture',
                },
                null,
                4,
            ),
        );
        await expect
            .poll(
                () =>
                    page.evaluate(
                        () =>
                            (
                                window as typeof window & { nativeTerminal: { output: string } }
                            ).nativeTerminal.output.match(/HUB-END:\d+:\/dev\/pts\/\d+/) !== null,
                    ),
                { timeout: 50_000 },
            )
            .toBe(true);
        const terminal = await page.evaluate(
            () =>
                (
                    window as typeof window & {
                        nativeTerminal: {
                            ids: string[];
                            sequences: number[];
                            output: string;
                            states: string[];
                        };
                    }
                ).nativeTerminal,
        );
        assert.equal(new Set(terminal.ids).size, 1, 'PTY channel changed');
        assert.deepEqual(
            terminal.sequences,
            [...new Set(terminal.sequences)].sort((a, b) => a - b),
            'output was replayed or reordered',
        );
        const ticks = [...terminal.output.matchAll(/HUB-TICK:(\d+)\r?\n/g)].map((match) =>
            Number(match[1]),
        );
        assert.deepEqual(
            ticks,
            Array.from({ length: 42 }, (_, i) => i + 1),
        );
        const before = terminal.output.match(/HUB-PTY:(\d+):(\/dev\/pts\/\d+)/);
        const after = terminal.output.match(/HUB-END:(\d+):(\/dev\/pts\/\d+)/);
        assert.ok(before && after);
        assert.deepEqual(before.slice(1), after.slice(1), 'remote Bash PID or PTY changed');
        assert.ok(!terminal.states.includes('closed') && !terminal.states.includes('error'));
        // In stress mode the last intentional UI action resumed live updates; preserve that control's focus.
        await expect(
            stress
                ? page.getByRole('switch', { name: 'Live updates' })
                : page.locator('.xterm-helper-textarea'),
        ).toBeFocused();
        // The production testing engine uses the existing real SSH connection with a fixed
        // software inventory/read response. This does not qualify a physical board.
        const continuityCycles: unknown[] = [];
        const nativeCycle = async () => {
            const file = path.join(output, 'continuity-cycle.json');
            await rm(file, { force: true });
            const source = (await readFile('tests/fixtures/gnome-continuity-cycle.js', 'utf8'))
                .replace("'__REPORT_PATH__'", JSON.stringify(file))
                .replace(
                    "'__PRIVATE_LAYER__'",
                    JSON.stringify(process.env.HUB_GNOME_PRIVATE_LAYER === '1' ? '1' : '0'),
                )
                .replace("'__STRESS_ENABLED__'", JSON.stringify(stress ? '1' : '0'));
            evaluate('void ' + source);
            await expect
                .poll(
                    async () => {
                        try {
                            return JSON.parse(await readFile(file, 'utf8'));
                        } catch {
                            return null;
                        }
                    },
                    { timeout: 6000 },
                )
                .toMatchObject({ ok: true, minimized: true, focused: true });
            continuityCycles.push(JSON.parse(await readFile(file, 'utf8')));
            await writeFile(
                path.join(output, 'continuity-cycles.json'),
                JSON.stringify(continuityCycles, null, 2),
            );
        };
        await page
            .locator('.primary-nav')
            .getByRole('button', { name: 'Tests', exact: true })
            .click();
        await page.getByRole('button', { name: 'JSON', exact: true }).click();
        const profile = sampleProfile();
        const testId = profile.tests.find((test) => test.adapter === 'i2c.identity')!.id;
        const request = JSON.stringify({ profile, testIds: [testId] });
        const editor = page.getByLabel('Run request JSON', { exact: true });
        await editor.fill(request);
        await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
        await expect
            .poll(
                () =>
                    page.evaluate(async () => {
                        try {
                            return await window.diagnosticHub!.readTestRun!();
                        } catch (error) {
                            if (String(error).includes('Test preparation is still running'))
                                return null;
                            throw error;
                        }
                    }),
                { timeout: 15000 },
            )
            .toMatchObject({ mode: 'ssh', phase: 'running' });
        const connectedRun = await page.evaluate(() => window.diagnosticHub!.readTestRun!());
        assert.ok(connectedRun);
        const cancel = page.getByRole('button', { name: 'Cancel tests', exact: true });
        // The JSON input is intentionally disabled while a run is active. Establish an
        // eligible active control before motion, then observe focus without repairing it.
        await cancel.focus();
        await nativeCycle();
        await expect(cancel).toBeFocused();
        await expect
            .poll(() => page.evaluate(() => window.diagnosticHub!.readTestRun!()))
            .toMatchObject({
                id: connectedRun.id,
                mode: 'ssh',
                phase: 'complete',
                verdict: 'Pass',
            });
        await expect(editor).toHaveValue(request);
        const resultEditor = page.getByLabel('Result report JSON', { exact: true });
        await expect(resultEditor).toBeVisible();
        const connectedReport = JSON.parse(await resultEditor.inputValue()) as TestReport;
        assert.equal(connectedReport.run.id, connectedRun.id);
        await nativeCycle();
        assert.deepEqual(JSON.parse(await resultEditor.inputValue()), connectedReport);
        await page.getByRole('switch', { name: 'Simulation mode' }).click();
        await page.getByRole('button', { name: 'JSON', exact: true }).click();
        await editor.fill(request);
        await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
        await nativeCycle();
        await expect(resultEditor).toBeVisible();
        const simulatedReport = JSON.parse(await resultEditor.inputValue()) as TestReport;
        assert.equal(simulatedReport.run.mode, 'simulated');
        assert.equal(simulatedReport.run.phase, 'complete');
        assert.equal(simulatedReport.run.verdict, 'Pass');
        assert.notEqual(simulatedReport.run.id, connectedRun.id);
        // Simulation lasts only 650 ms. Check retained identity/evidence and eligible
        // editor focus in a second native cycle after its completion.
        await editor.focus();
        await nativeCycle();
        await expect(editor).toBeFocused();
        assert.deepEqual(JSON.parse(await resultEditor.inputValue()), simulatedReport);
        await expect(editor).toHaveValue(request);
        const counts = await desktop.evaluate(
            ({ app }) =>
                (app as typeof app & { qualificationCounts: Record<string, number> })
                    .qualificationCounts,
        );
        await writeFile(path.join(output, 'activity-counts.json'), JSON.stringify(counts, null, 4));
        assert.equal(counts.connect, 1);
        assert.equal(counts['terminal-open'], 1);
        assert.equal(counts.disconnect || 0, 0);
        assert.equal(counts['terminal-close'] || 0, 0);
        assert.ok(counts.collect >= 3, 'live collection stopped');
        assert.ok(counts['device-clock'] >= 2, 'device clock did not refresh');
        assert.equal(
            counts['tests-start'],
            stress ? 2 : 1,
            'Connected run was duplicated or simulation sent SSH work',
        );
        evaluate(`void (async () => {
            let legacyConfig;
            try { legacyConfig = imports.misc.config; } catch {}
            const legacy = legacyConfig?.PACKAGE_VERSION?.startsWith('42.');
            const Main = legacy ? imports.ui.main : await import('resource:///org/gnome/shell/ui/main.js');
            Main.extensionManager._callExtensionDisable('diagnostic-hub-genie@diagnostichub.desktop');
            const layer = global.hubQualificationPrivateLayer;
            if (layer) {
                const {default:Gio} = await import('gi://Gio');
                Gio.File.new_for_path(${JSON.stringify(path.join(output, 'private-layer-final.json'))}).replace_contents(
                    JSON.stringify(layer.snapshot()), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                layer.restore();
            }
        })()`);
        const disabledApi = execFileSync(
            'gdbus',
            [
                'introspect',
                '--session',
                '--dest',
                'org.gnome.Shell',
                '--object-path',
                '/dev/diagnostichub/Genie',
            ],
            { encoding: 'utf8' },
        );
        assert.doesNotMatch(
            disabledApi,
            /dev\.diagnostichub\.Genie1/,
            'disabled endpoint remained exported',
        );
        if (process.env.HUB_GNOME_PRIVATE_LAYER === '1') {
            const finalLayer = JSON.parse(
                await readFile(path.join(output, 'private-layer-final.json'), 'utf8'),
            );
            assert.ok(native.privateLayer, 'Candidate native layer statistics missing');
            assert.equal(finalLayer.remaining, 0);
            assert.equal(finalLayer.added, finalLayer.removed);
            assert.equal(finalLayer.added, native.privateLayer.added + continuityCycles.length * 2);
        }
        // Actor callbacks alone cannot certify visible deformation. In particular, a running
        // headless devkit can report successful transactions while its outer output is black.
        const images: string[] = [];
        for (let index = 0; index < native.frames.length; index++) {
            const frame = await readFile(`${reportFile}.${index}.xwd`);
            assert.ok(frame.length >= 100, 'truncated external frame');
            const header = frame.readUInt32BE(0);
            const colors = frame.readUInt32BE(19 * 4);
            const pixels = frame.subarray(header + colors * 12);
            assert.ok(pixels.length > 0, 'external frame contains no pixels');
            assert.ok(
                new Set(pixels).size >= 16,
                'external frame is blank; visual qualification is pending',
            );
            images.push(createHash('sha256').update(pixels).digest('hex'));
        }
        assert.ok(new Set(images).size >= 2, 'external output did not change during native motion');
        // A full success artifact must never precede the visible-frame gate.
        await writeFile(
            path.join(output, 'continuity.json'),
            JSON.stringify(
                {
                    ok: true,
                    ticks: ticks.length,
                    samePty: true,
                    counts,
                    shell: native,
                    automaticFocus: true,
                    candidateLayerWholeContinuity: process.env.HUB_GNOME_PRIVATE_LAYER === '1',
                    continuityCycles,
                    connectedRunId: connectedReport.run.id,
                    simulatedRunId: simulatedReport.run.id,
                    boardEvidence: 'software fixture',
                },
                null,
                4,
            ),
        );
        console.log(
            `GNOME production companion passed ${native.cycles} native cycles and real Bash PTY/collection continuity.`,
        );
    } finally {
        await saveRuntimeDiagnostics();
        desktop.process().stderr?.off('data', captureStderr);
        // Stop owned asynchronous actor operations before closing their real windows.
        try {
            evaluate('void global.hubQualificationCancel?.()');
            await pageWaitForCancellation(desktop);
            evaluate('void global.hubQualificationPrivateLayer?.restore()');
        } catch {
            /* Shell failure remains in the original error and compositor log. */
        }
        try {
            const ipcEvents = await desktop.evaluate(
                ({ app }) =>
                    (app as typeof app & { qualificationEvents: Array<unknown> })
                        .qualificationEvents,
            );
            await writeFile(
                path.join(output, 'ipc-event-profile.json'),
                JSON.stringify(ipcEvents, null, 2),
            );
        } catch (error) {
            await writeFile(path.join(output, 'ipc-profile-error.txt'), String(error));
        }
        if (traceBounds) {
            flushProtocol();
            let client: unknown[] = [];
            let clientError: string | undefined;
            try {
                client = await desktop.evaluate(
                    ({ app }) => (app as typeof app & { boundsTrace: unknown[] }).boundsTrace,
                );
            } catch (error) {
                clientError = String(error);
            }
            await writeFile(
                path.join(output, 'client-bounds-events.json'),
                JSON.stringify(
                    {
                        clock: 'Linux CLOCK_MONOTONIC ms',
                        client,
                        clientError,
                        protocol,
                        protocolTraceState,
                    },
                    null,
                    2,
                ),
            );
        }
        control.kill('SIGTERM');
        await desktop.close();
        if (process.env.HUB_GNOME_PRESERVE_PROFILE !== '1')
            await rm(root, { recursive: true, force: true });
        else await writeFile(path.join(output, 'profile-path.txt'), root + '\n');
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
