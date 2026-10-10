import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gatewayFixture } from './fixtures/gateway';
import { testingFixture } from './fixtures/testing';
import { sampleProfile } from '../shared/testing/simulation';
import { TaskbarReader } from '../electron/taskbar-reader';
import { genieGeometry } from '../electron/genie-geometry';
import { configureGenieTest, diagnoseGenieTaskbar } from './fixtures/genie';

async function main() {
    const root = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-genie-'));
    const testing = testingFixture();
    const fixture = await gatewayFixture(undefined, { exec: testing.exec });
    fixture.terminal.streamDurationMs = 35_000;
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
        ),
    ) as Record<string, string>;
    const desktop = await _electron.launch({
        executablePath: process.env.HUB_TEST_EXECUTABLE,
        args: [
            ...(process.env.HUB_TEST_EXECUTABLE ? [] : ['.']),
            `--user-data-dir=${root}`,
            ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        ],
        env,
    });
    try {
        const page = await desktop.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        await configureGenieTest(desktop);
        const id = await desktop.evaluate(
            ({ BrowserWindow }) =>
                BrowserWindow.getAllWindows().find((w) =>
                    w.webContents.getURL().endsWith('/index.html'),
                )!.id,
        );
        const state = () =>
            desktop.evaluate(({ BrowserWindow }, id) => {
                const main = BrowserWindow.fromId(id)!;
                return {
                    minimized: main.isMinimized(),
                    opacity: main.getOpacity(),
                    windows: BrowserWindow.getAllWindows().length,
                };
            }, id);
        const restore = async () => {
            await desktop.evaluate(({ BrowserWindow, app }, id) => {
                const main = BrowserWindow.fromId(id)!;
                if (process.platform !== 'win32') return main.restore();
                const ffi = process
                    .getBuiltinModule('module')
                    .createRequire(app.getAppPath() + '/package.json')('koffi');
                ffi
                    .load('user32.dll')
                    .func('int32_t __stdcall PostMessageW(void *, uint32_t, uintptr_t, intptr_t)')(
                    main.getNativeWindowHandle().readBigUInt64LE(),
                    0x112,
                    0xf120,
                    0,
                );
            }, id);
            await expect.poll(state).toEqual({ minimized: false, opacity: 1, windows: 1 });
        };
        if (process.platform !== 'win32') {
            await expect(page.getByRole('button', { name: 'Minimize', exact: true })).toHaveCount(
                0,
            );
            await desktop.evaluate(
                ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.minimize(),
                id,
            );
            await restore();
            console.log('Unsupported-platform native fallback passed.');
            return;
        }
        await expect(page.getByRole('button', { name: 'Minimize', exact: true })).toHaveCount(0);
        assert.equal(await page.evaluate(() => 'windowControls' in window.diagnosticHub!), false);
        const requestMinimize = () =>
            desktop.evaluate(({ BrowserWindow, app }, id) => {
                const ffi = process
                    .getBuiltinModule('module')
                    .createRequire(app.getAppPath() + '/package.json')('koffi');
                ffi
                    .load('user32.dll')
                    .func('bool __stdcall PostMessageW(void *, uint32_t, uintptr_t, intptr_t)')(
                    BrowserWindow.fromId(id)!.getNativeWindowHandle().readBigUInt64LE(),
                    0x112,
                    0xf020,
                    0,
                );
            }, id);
        // Capture only geometry and authorization results; never persist or log snapshot pixels.
        await desktop.evaluate(({ app, ipcMain }) => {
            const observations: unknown[] = [];
            (app as typeof app & { genieObservations: unknown[] }).genieObservations = observations;
            app.on('browser-window-created', (_event, win) => {
                win.webContents.once('dom-ready', () => {
                    if (!win.webContents.getURL().endsWith('/genie.html')) return;
                    void win.webContents
                        .executeJavaScript(
                            `(async () => {
                        const {image,...geometry} = await window.genie.payload();
                        return { geometry, noHub: !window.diagnosticHub };
                    })()`,
                        )
                        .then((result) => {
                            const handlers = (
                                ipcMain as unknown as {
                                    _invokeHandlers: Map<
                                        string,
                                        (event: unknown, generation?: unknown) => unknown
                                    >;
                                }
                            )._invokeHandlers;
                            let denied = true;
                            for (const check of [
                                { name: 'hub:collect', frame: win.webContents.mainFrame },
                                {
                                    name: 'genie:done',
                                    frame: win.webContents.mainFrame,
                                    generation: result.geometry.generation - 1,
                                },
                                {
                                    name: 'genie:done',
                                    frame: { url: win.webContents.getURL() },
                                    generation: result.geometry.generation,
                                },
                            ]) {
                                try {
                                    handlers.get(check.name)!(
                                        { sender: win.webContents, senderFrame: check.frame },
                                        check.generation,
                                    );
                                    denied = false;
                                } catch {}
                            }
                            observations.push({ ...result, denied });
                        })
                        .catch((error) => observations.push({ error: String(error) }));
                });
            });
        });
        const minimize = async () => {
            // The native control remains immediate while the metadata adapter initializes.
            const deadline = Date.now() + 15_000;
            while (true) {
                await requestMinimize();
                await expect.poll(state).toMatchObject({ minimized: true, windows: 1 });
                if ((await state()).opacity === 0) break;
                await restore();
                if (Date.now() > deadline) {
                    await diagnoseGenieTaskbar();
                    throw Error('Native Genie adapter did not initialize.');
                }
            }
        };
        const originalBounds = await desktop.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(),
            id,
        );
        await minimize();
        await restore();
        assert.deepEqual(
            await desktop.evaluate(
                ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(),
                id,
            ),
            originalBounds,
        );
        const observations = await desktop.evaluate(
            ({ app }) =>
                (
                    app as typeof app & {
                        genieObservations: {
                            geometry: { direction: string };
                            noHub: boolean;
                            denied: boolean;
                        }[];
                    }
                ).genieObservations,
        );
        assert.deepEqual(
            observations.filter((o) => o.geometry).map((o) => o.geometry.direction),
            ['out', 'in'],
        );
        assert.ok(observations.every((o) => o.noHub && o.denied));

        // Check actual app-button anchoring on every available display, including physical-to-DIP conversion.
        const displays = await desktop.evaluate(({ screen }) =>
            screen.getAllDisplays().map((d) => ({
                bounds: d.bounds,
                workArea: d.workArea,
                scaleFactor: d.scaleFactor,
            })),
        );
        for (const display of displays) {
            await desktop.evaluate(
                ({ BrowserWindow }, data) =>
                    BrowserWindow.fromId(data.id)!.setBounds({
                        x: data.work.x + 80,
                        y: data.work.y + 80,
                        width: 1100,
                        height: 750,
                    }),
                { id, work: display.workArea },
            );
            await expect
                .poll(() => page.evaluate(() => devicePixelRatio))
                .toBe(display.scaleFactor);
            await page.evaluate(
                () =>
                    new Promise<void>((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    ),
            );
            const native = new TaskbarReader('dev.diagnostichub.desktop', () => 'Diagnostic Hub');
            let physical;
            try {
                physical = await native.prime();
            } finally {
                native.close();
            }
            const bar = await desktop.evaluate(
                ({ screen }, data) => {
                    const bar = data.physical.find(
                        (bar) =>
                            screen.screenToDipRect(null, bar.monitor).x === data.bounds.x &&
                            bar.button,
                    );
                    return bar?.button
                        ? {
                              edge: bar.edge,
                              bounds: screen.screenToDipRect(null, bar.bounds),
                              monitor: screen.screenToDipRect(null, bar.monitor),
                              button: screen.screenToDipRect(null, bar.button),
                          }
                        : null;
                },
                { physical, bounds: display.bounds },
            );
            if (!bar) {
                console.log(
                    'Physical app-button qualification unavailable on this display: ' +
                        JSON.stringify(display),
                );
                continue;
            }
            const bounds = await desktop.evaluate(
                ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(),
                id,
            );
            const button = bar!.button;
            const fallback = genieGeometry(bounds, { ...bar!, button: undefined });
            const fallbackPoint = {
                x: fallback.bounds.x + fallback.target.x + fallback.target.width / 2,
                y: fallback.bounds.y + fallback.target.y + fallback.target.height / 2,
            };
            let precise = 0;
            // An independent lookup cannot guarantee that each later request exposes a button.
            // Accept only the documented center fallback, and still qualify the precise path.
            for (let attempt = 0; attempt < 3 && precise === 0; attempt++) {
                await minimize();
                await restore();
                const anchors = await desktop.evaluate(({ app }) =>
                    (
                        app as typeof app & {
                            genieObservations: {
                                geometry: {
                                    bounds: Electron.Rectangle;
                                    target: Electron.Rectangle;
                                };
                            }[];
                        }
                    ).genieObservations
                        .slice(-2)
                        .map(({ geometry: p }) => ({
                            x: p.bounds.x + p.target.x + p.target.width / 2,
                            y: p.bounds.y + p.target.y + p.target.height / 2,
                        })),
                );
                assert.equal(anchors.length, 2);
                for (const point of anchors) {
                    const exact =
                        Math.abs(point.x - button.x - button.width / 2) < 1 &&
                        Math.abs(point.y - button.y - button.height / 2) < 1;
                    const center =
                        Math.abs(point.x - fallbackPoint.x) < 1 &&
                        Math.abs(point.y - fallbackPoint.y) < 1;
                    assert.ok(
                        exact || center,
                        'Taskbar anchor is neither the app button nor its documented fallback: ' +
                            JSON.stringify({ point, button, fallbackPoint, display }),
                    );
                    if (exact) precise++;
                }
            }
            assert.ok(precise > 0, 'Qualify at least one precise app-button anchor per display.');
            assert.deepEqual(
                await desktop.evaluate(
                    ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(),
                    id,
                ),
                bounds,
            );
        }
        await desktop.evaluate(
            ({ BrowserWindow }, data) => BrowserWindow.fromId(data.id)!.setBounds(data.bounds),
            { id, bounds: originalBounds },
        );

        // Capture failure and renderer failure must yield usable native state.
        await desktop.evaluate(({ BrowserWindow }, id) => {
            const contents = BrowserWindow.fromId(id)!.webContents;
            const capture = contents.capturePage.bind(contents);
            contents.capturePage = async () => {
                contents.capturePage = capture;
                throw Error('Injected capture failure');
            };
        }, id);
        await requestMinimize();
        await expect.poll(state).toEqual({ minimized: true, opacity: 1, windows: 1 });
        await restore();
        await minimize();
        await desktop.evaluate(({ app }) => {
            app.once('browser-window-created', (_event, win) => {
                win.webContents.once('dom-ready', () => win.webContents.forcefullyCrashRenderer());
            });
        });
        await restore();

        // Native creation can reenter main resize before the new HWND is assigned to the
        // controller. Both directions must discard that canceled surface, even before load.
        for (const direction of ['out', 'in']) {
            if (direction === 'in') await minimize();
            await desktop.evaluate(({ app, BrowserWindow }, id) => {
                app.once('browser-window-created', () => {
                    const main = BrowserWindow.fromId(id)!;
                    const bounds = main.getBounds();
                    main.setBounds({ ...bounds, width: bounds.width - 40 });
                });
            }, id);
            if (direction === 'out') {
                await requestMinimize();
                await expect.poll(state).toEqual({ minimized: true, opacity: 1, windows: 1 });
            }
            await restore();
            await desktop.evaluate(
                ({ BrowserWindow }, data) => BrowserWindow.fromId(data.id)!.setBounds(data.bounds),
                { id, bounds: originalBounds },
            );
        }

        // A capture that never resolves exercises the independent two-second deadline.
        await desktop.evaluate(({ BrowserWindow }, id) => {
            const contents = BrowserWindow.fromId(id)!.webContents;
            const capture = contents.capturePage.bind(contents);
            contents.capturePage = () => {
                contents.capturePage = capture;
                return new Promise(() => {});
            };
        }, id);
        const started = Date.now();
        await requestMinimize();
        await expect.poll(state).toEqual({ minimized: true, opacity: 1, windows: 1 });
        assert.ok(Date.now() - started < 3000);
        await restore();

        // Repeated requests coalesce, and an early restore cancels the outgoing surface.
        await Promise.all([requestMinimize(), requestMinimize()]);
        await expect
            .poll(state, { intervals: [20] })
            .toMatchObject({ minimized: true, opacity: 0, windows: 2 });
        await restore();

        // Missing renderer completion must not strand either native window state.
        await desktop.evaluate(({ ipcMain, app }) => {
            const handlers = (
                ipcMain as unknown as {
                    _invokeHandlers: Map<string, (event: unknown, generation?: unknown) => unknown>;
                }
            )._invokeHandlers;
            (app as typeof app & { genieDone: unknown }).genieDone = handlers.get('genie:done');
            handlers.set('genie:done', () => undefined);
        });
        await requestMinimize();
        await expect.poll(state).toEqual({ minimized: true, opacity: 1, windows: 1 });
        await restore();
        await desktop.evaluate(({ ipcMain, app }) => {
            const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })
                ._invokeHandlers;
            handlers.set('genie:done', (app as typeof app & { genieDone: unknown }).genieDone);
        });

        // Query the system motion preference, without changing this PC's settings.
        await desktop.evaluate(({ systemPreferences, app }) => {
            (app as typeof app & { normalAnimation: unknown }).normalAnimation =
                systemPreferences.getAnimationSettings;
            systemPreferences.getAnimationSettings = () => ({
                prefersReducedMotion: true,
                shouldRenderRichAnimation: false,
                scrollAnimationsEnabledBySystem: false,
            });
        });
        await requestMinimize();
        await expect.poll(state).toEqual({ minimized: true, opacity: 1, windows: 1 });
        await restore();
        await desktop.evaluate(({ systemPreferences, app }) => {
            systemPreferences.getAnimationSettings = (
                app as typeof app & {
                    normalAnimation: typeof systemPreferences.getAnimationSettings;
                }
            ).normalAnimation;
        });

        // Reload during restoration cancels the temporary surface into a visible native window.
        await minimize();
        await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.restore(), id);
        await page.reload();
        await expect.poll(state).toEqual({ minimized: false, opacity: 1, windows: 1 });
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();

        // Electron's minimize API also reaches the owned native system-command hook.
        await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.minimize(), id);
        await expect.poll(state).toEqual({ minimized: true, opacity: 0, windows: 1 });
        await restore();
        // ShowWindow paths that bypass SC_MINIMIZE retain a usable native fallback.
        await desktop.evaluate(({ BrowserWindow, app }, id) => {
            const ffi = process
                .getBuiltinModule('module')
                .createRequire(app.getAppPath() + '/package.json')('koffi');
            ffi.load('user32.dll').func('bool __stdcall ShowWindow(void *, int32_t)')(
                BrowserWindow.fromId(id)!.getNativeWindowHandle().readBigUInt64LE(),
                6,
            );
        }, id);
        await expect.poll(state).toEqual({ minimized: true, opacity: 1, windows: 1 });
        await restore();
        await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.maximize(), id);
        await minimize();
        await restore();
        assert.equal(
            await desktop.evaluate(
                ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isMaximized(),
                id,
            ),
            true,
        );
        await desktop.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.unmaximize(),
            id,
        );

        // Real loopback SSH/PTY continuity beyond the 30-second consumer deadline.
        await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('Hostname or IP address').fill(fixture.options.host);
        await modal.getByLabel('Port', { exact: true }).fill(String(fixture.options.port));
        await modal.getByLabel('SSH username').fill('engineer');
        await modal.getByLabel('Password', { exact: true }).fill(fixture.options.password);
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await page.getByRole('button', { name: 'Trust device', exact: true }).click();
        await expect(modal).not.toBeVisible({ timeout: 20_000 });
        await page.getByRole('combobox', { name: 'Live update interval' }).selectOption('5');
        const authentications = fixture.authentications();
        await page
            .locator('.primary-nav')
            .getByRole('button', { name: 'Terminal', exact: true })
            .click();
        await expect(page.locator('.xterm-helper-textarea')).toBeVisible();
        await expect.poll(() => fixture.terminal.opens).toBe(1);
        await page.locator('.xterm-helper-textarea').focus();
        await page.keyboard.type('stream');
        await page.keyboard.press('Enter');
        await expect.poll(() => fixture.terminal.streamed ?? 0).toBeGreaterThan(0);
        await requestMinimize();
        await expect.poll(state).toEqual({ minimized: true, opacity: 0, windows: 1 });
        console.log('Checking sustained PTY output while genuinely minimized for 35 seconds...');
        const hiddenSince = Date.now();
        const collectionsBefore = fixture.probeExecutions();
        const clockBefore = fixture.clock.calls;
        await expect
            .poll(() => fixture.terminal.streamFinished, { timeout: 40_000, intervals: [1000] })
            .toBe(true);
        assert.ok(Date.now() - hiddenSince > 30_000);
        assert.ok((fixture.terminal.streamed ?? 0) > 100);
        await restore();
        assert.ok(fixture.probeExecutions() > collectionsBefore);
        await expect.poll(() => fixture.clock.calls).toBeGreaterThan(clockBefore);
        assert.equal(fixture.authentications(), authentications);
        assert.equal(fixture.terminal.opens, 1);
        assert.equal(fixture.terminal.closes, 0);
        assert.equal(
            Buffer.concat(fixture.terminal.inputs).toString().split('stream').length - 1,
            1,
        );
        await desktop.evaluate(({ clipboard, app }) => {
            clipboard.writeText = async (text) => {
                (app as typeof app & { terminalText: string }).terminalText = text;
            };
        });
        await page.getByRole('button', { name: 'Copy terminal text', exact: true }).click();
        await expect
            .poll(() =>
                desktop.evaluate(
                    ({ app }) => (app as typeof app & { terminalText: string }).terminalText,
                ),
            )
            .toContain('STREAM FINISHED');

        // A real connected test keeps its run identity and evidence across both directions.
        testing.state.delayMs = 2500;
        await page
            .locator('.primary-nav')
            .getByRole('button', { name: 'Tests', exact: true })
            .click();
        const profile = sampleProfile();
        const testId = profile.tests.find((t) => t.adapter === 'i2c.identity')!.id;
        await page.getByRole('button', { name: 'JSON', exact: true }).click();
        const request = JSON.stringify({ profile, testIds: [testId] });
        await page.getByLabel('Run request JSON', { exact: true }).fill(request);
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
            .toMatchObject({ phase: 'running' });
        const run = await page.evaluate(() => window.diagnosticHub!.readTestRun!());
        await minimize();
        await restore();
        await expect
            .poll(() => page.evaluate(() => window.diagnosticHub!.readTestRun!()))
            .toMatchObject({ id: run!.id, phase: 'complete' });
        await expect(page.getByLabel('Run request JSON', { exact: true })).toHaveValue(request);
        await expect(page.getByRole('region', { name: 'Test run results' })).toContainText(
            'Test results Pass',
        );
        assert.equal(testing.state.calls.filter((c) => c === 'i2c').length, 1);
        assert.equal(fixture.authentications(), authentications);

        // The simulated workspace also keeps its execution and JSON edits through a transition.
        await page.getByRole('switch', { name: 'Simulation mode' }).click();
        await page.getByRole('button', { name: 'JSON', exact: true }).click();
        await page.getByLabel('Run request JSON', { exact: true }).fill(request);
        await page.getByRole('button', { name: 'Run JSON', exact: true }).click();
        await requestMinimize();
        await expect.poll(state).toEqual({ minimized: true, opacity: 0, windows: 1 });
        await restore();
        await expect(page.getByRole('region', { name: 'Test run results' })).toContainText(
            'Run complete',
        );
        await expect(page.getByRole('region', { name: 'Test run results' })).toContainText(
            'SIMULATED EVIDENCE',
        );
        await expect(page.getByLabel('Run request JSON', { exact: true })).toHaveValue(request);

        // Modal input, page scroll and focus survive an app-owned handoff without a remount.
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
        await modal.getByLabel('Hostname or IP address').fill('preserved.example');
        await minimize();
        await restore();
        await expect(modal.getByLabel('Hostname or IP address')).toHaveValue('preserved.example');
        await expect(modal.getByLabel('Hostname or IP address')).toBeFocused();
        await page.keyboard.press('Escape');
        console.log(
            'Genie geometry/security/recovery, native/maximized paths and SSH/PTY/test continuity passed.',
        );
    } finally {
        await desktop.close();
        await fixture.close();
        await rm(root, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
