import { expect, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function nativeWindowCycles(desktop: ElectronApplication, cycles: number) {
    const isolated = process.env.HUB_GNOME_ISOLATED === '1';
    const pid = await desktop.evaluate(() => process.pid);
    const observations: unknown[] = [];
    let previousObservation: { phase: string; signature: string } | undefined;
    const started = Date.now();
    await desktop.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const trace: unknown[] = [];
        (globalThis as unknown as { nativeStateEvents: unknown[] }).nativeStateEvents = trace;
        for (const event of [
            'maximize',
            'unmaximize',
            'minimize',
            'restore',
            'show',
            'hide',
            'resize',
        ]) {
            window.on(event as 'minimize', () => {
                trace.push({
                    event,
                    at: Date.now(),
                    minimized: window.isMinimized(),
                    maximized: window.isMaximized(),
                    visible: window.isVisible(),
                    bounds: window.getBounds(),
                });
                if (trace.length > 2000) trace.shift();
            });
        }
    });
    async function state(phase: string) {
        const native = await desktop.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            return {
                minimized: window.isMinimized(),
                maximized: window.isMaximized(),
                visible: window.isVisible(),
                bounds: window.getBounds(),
            };
        });
        let compositor: number | undefined;
        let compositorAnimating: boolean | undefined;
        let compositorFrame: { x: number; y: number; width: number; height: number } | undefined;
        if (isolated) {
            // Numeric JSON avoids nested GVariant quoting and keeps state/geometry independently visible.
            const expression = `(()=>{const actors=global.get_window_actors().filter(actor=>actor.meta_window.get_pid()===${pid});if(actors.length!==1)return [];const actor=actors[0],window=actor.meta_window,rect=window.get_frame_rect();const moving=['x','y','width','height','scale-x','scale-y','translation-x','translation-y','opacity'].some(name=>actor.get_transition(name)?.is_playing());return [Number(window.minimized)|(window.maximized_horizontally?2:0)|(window.maximized_vertically?4:0),Number(moving),rect.x,rect.y,rect.width,rect.height];})()`;
            const raw = execFileSync(
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
                    expression,
                ],
                { encoding: 'utf8', timeout: 5000 },
            ).trim();
            const match = /^\(true, ['"](\[[\d, .-]*\])['"]\)$/.exec(raw);
            if (!match) throw Error(`Cannot read compositor state: ${raw}`);
            const values: number[] = JSON.parse(match[1]);
            expect(values).toHaveLength(6);
            expect(values.every(Number.isFinite)).toBe(true);
            [compositor] = values;
            compositorAnimating = values[1] !== 0;
            compositorFrame = { x: values[2], y: values[3], width: values[4], height: values[5] };
        }
        const signature = JSON.stringify({
            ...native,
            compositor,
            compositorAnimating,
            compositorFrame,
        });
        const settled =
            !compositorAnimating &&
            previousObservation?.phase === phase &&
            previousObservation.signature === signature;
        previousObservation = { phase, signature };
        const composite = isolated
            ? { compositor, compositorAnimating, compositorFrame, settled }
            : {};
        observations.push({ phase, elapsedMs: Date.now() - started, ...native, ...composite });
        return { ...native, ...composite };
    }
    async function confirmed(
        phase: string,
        minimized: boolean,
        maximized: boolean,
        size?: { width: number; height: number },
    ) {
        const expected = {
            minimized,
            maximized,
            ...(isolated
                ? {
                      compositor: (minimized ? 1 : 0) | (maximized ? 6 : 0),
                      compositorAnimating: false,
                      settled: true,
                  }
                : {}),
            ...(size ? { bounds: size } : {}),
        };
        await expect.poll(() => state(phase)).toMatchObject(expected);
    }
    try {
        // Retain exact native/compositor checks; isolated desktops must also finish animations
        // and report unchanged geometry on consecutive observations before the next request.
        await desktop.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].unmaximize(),
        );
        await confirmed('normal-preflight', false, false);
        const resizeTarget = await desktop.evaluate(({ BrowserWindow, screen }) => {
            const window = BrowserWindow.getAllWindows()[0];
            const display = screen.getDisplayMatching(window.getBounds());
            const [minWidth, minHeight] = window.getMinimumSize();
            const [maxWidth, maxHeight] = window.getMaximumSize();
            // AppKit constrains windows to the display; the hosted Mac display can be shorter
            // than the fixture's 900 DIP request. Keep an exact, independently selected target.
            const size =
                process.platform === 'darwin'
                    ? {
                          width: Math.max(minWidth, Math.min(1200, display.workArea.width)),
                          height: Math.max(minHeight, Math.min(900, display.workArea.height)),
                      }
                    : { width: 1200, height: 900 };
            return {
                size,
                workArea: display.workArea,
                minimum: { minWidth, minHeight },
                maximum: { maxWidth, maxHeight },
            };
        });
        expect(resizeTarget.size.width).toBeGreaterThan(0);
        expect(resizeTarget.size.height).toBeGreaterThan(0);
        console.log('Native resize target:', JSON.stringify(resizeTarget));
        const smallerMacSize = {
            width: resizeTarget.minimum.minWidth,
            height: resizeTarget.minimum.minHeight,
        };
        if (process.platform === 'darwin') expect(smallerMacSize).not.toEqual(resizeTarget.size);
        for (let cycle = 0; cycle < cycles; cycle++) {
            if (cycle % 10 === 0) {
                const current = await state(`cycle-${cycle}:before-resize`);
                const size =
                    process.platform === 'darwin' &&
                    current.bounds.width === resizeTarget.size.width &&
                    current.bounds.height === resizeTarget.size.height
                        ? smallerMacSize
                        : resizeTarget.size;
                if (process.platform === 'darwin')
                    expect({
                        width: current.bounds.width,
                        height: current.bounds.height,
                    }).not.toEqual(size);
                await desktop.evaluate(
                    ({ BrowserWindow }, size) =>
                        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
                    size,
                );
                await confirmed(`cycle-${cycle}:resized`, false, false, size);
                await desktop.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0].maximize(),
                );
                await confirmed(`cycle-${cycle}:maximized`, false, true);
                await desktop.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0].unmaximize(),
                );
                await confirmed(`cycle-${cycle}:unmaximized`, false, false);
            }
            await desktop.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0].minimize(),
            );
            await confirmed(`cycle-${cycle}:minimized`, true, false);
            if (isolated) {
                // GNOME owns native desktop restoration; client restore requests can clear
                // Electron's local flag without unminimizing the actual Wayland surface.
                const restore = `(()=>{const windows=global.get_window_actors().map(actor=>actor.meta_window).filter(window=>window.get_pid()===${pid});if(windows.length!==1||windows[0].get_wm_class()?.toLowerCase()!=='diagnostic-hub-native')return false;windows[0].unminimize();windows[0].activate(global.get_current_time());return true;})()`;
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
                        restore,
                    ],
                    { encoding: 'utf8', timeout: 5000 },
                ).trim();
                expect(result).toMatch(/^\(true, ['"]true['"]\)$/);
            } else {
                await desktop.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0].restore(),
                );
            }
            await confirmed(`cycle-${cycle}:restored`, false, false);
        }
        console.log(
            `Native window state confirmed: ${cycles} cycles, ${Date.now() - started}ms, backend ${process.env.HUB_GNOME_BACKEND ?? process.platform}.`,
        );
    } catch (error) {
        console.error('Native window state observations:', JSON.stringify(observations.slice(-12)));
        throw error;
    } finally {
        const events = await desktop
            .evaluate(
                () => (globalThis as unknown as { nativeStateEvents: unknown[] }).nativeStateEvents,
            )
            .catch(() => []);
        const directory = process.env.HUB_GNOME_EVIDENCE ?? 'test-results';
        await mkdir(directory, { recursive: true });
        await writeFile(
            path.join(directory, `native-window-${cycles}-${pid}-state.json`),
            JSON.stringify(
                {
                    pid,
                    cycles,
                    backend: process.env.HUB_GNOME_BACKEND ?? process.platform,
                    observations,
                    events,
                },
                null,
                2,
            ),
        );
    }
}
