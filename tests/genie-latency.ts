import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Sample {
    direction: 'out' | 'in';
    requested: number;
    created?: number;
    loaded?: number;
    capture?: number;
    ready?: number;
    frames?: number[];
}

async function main() {
    if (process.platform !== 'win32') return;
    const profile = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-genie-latency-'));
    const desktop = await _electron.launch({
        executablePath: process.env.HUB_TEST_EXECUTABLE,
        args: [...(process.env.HUB_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${profile}`],
        env: Object.fromEntries(
            Object.entries(process.env).filter(
                ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
            ),
        ) as Record<string, string>,
    });
    try {
        const page = await desktop.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        const id = await desktop.evaluate(({ BrowserWindow, app, ipcMain }) => {
            const main = BrowserWindow.getAllWindows().find((w) =>
                w.webContents.getURL().endsWith('/index.html'),
            )!;
            const probe = { samples: [] as Sample[], current: null as Sample | null };
            (app as any).latencyProbe = probe;
            const capture = main.webContents.capturePage.bind(main.webContents);
            main.webContents.capturePage = async (...args) => {
                const start = performance.now();
                const result = await capture(...args);
                if (probe.current) probe.current.capture = performance.now() - start;
                return result;
            };
            app.on('browser-window-created', (_event, win) => {
                if (probe.current) probe.current.created = performance.now();
                win.webContents.once('dom-ready', () => {
                    if (probe.current) probe.current.loaded = performance.now();
                });
            });
            const handlers = (ipcMain as any)._invokeHandlers as Map<
                string,
                (...args: any[]) => any
            >;
            const ready = handlers.get('genie:ready')!;
            handlers.set('genie:ready', (...args) => {
                const accepted = ready(...args);
                if (accepted && probe.current) {
                    probe.current.ready = performance.now();
                    probe.samples.push(probe.current);
                }
                if (!accepted) return accepted;
                return args[0].sender
                    .executeJavaScript(
                        `(() => {
                    const native = window.requestAnimationFrame.bind(window);
                    window.frameIntervals = [];
                    let previous;
                    window.requestAnimationFrame = callback => native(now => {
                        if (previous !== undefined) window.frameIntervals.push(now - previous);
                        previous = now;
                        callback(now);
                    });
                })()`,
                    )
                    .then(() => accepted);
            });
            const done = handlers.get('genie:done')!;
            handlers.set('genie:done', async (...args) => {
                const intervals = await args[0].sender.executeJavaScript('window.frameIntervals');
                if (probe.current) probe.current.frames = intervals;
                return done(...args);
            });
            return main.id;
        });
        const state = () =>
            desktop.evaluate(({ BrowserWindow }, id) => {
                const main = BrowserWindow.fromId(id)!;
                return {
                    minimized: main.isMinimized(),
                    opacity: main.getOpacity(),
                    windows: BrowserWindow.getAllWindows().length,
                };
            }, id);
        const request = (direction: 'out' | 'in') =>
            desktop.evaluate(
                ({ BrowserWindow, app }, { id, direction }) => {
                    (app as any).latencyProbe.current = { direction, requested: performance.now() };
                    const main = BrowserWindow.fromId(id)!;
                    const ffi = process
                        .getBuiltinModule('module')
                        .createRequire(app.getAppPath() + '/package.json')('koffi');
                    ffi
                        .load('user32.dll')
                        .func(
                            'int32_t __stdcall PostMessageW(void *, uint32_t, uintptr_t, intptr_t)',
                        )(
                        main.getNativeWindowHandle().readBigUInt64LE(),
                        0x112,
                        direction === 'out' ? 0xf020 : 0xf120,
                        0,
                    );
                },
                { id, direction },
            );
        // Early native fallback is expected while shell metadata warms independently of page load.
        const deadline = Date.now() + 20_000;
        while (true) {
            await request('out');
            await expect
                .poll(state, { intervals: [20] })
                .toMatchObject({ minimized: true, windows: 1 });
            const animated = (await state()).opacity === 0;
            await request('in');
            await expect
                .poll(state, { intervals: [20] })
                .toMatchObject({ minimized: false, opacity: 1, windows: 1 });
            if (animated) break;
            if (Date.now() > deadline) throw Error('Native adapter did not initialize.');
        }
        await desktop.evaluate(({ app }) => {
            (app as any).latencyProbe.samples = [];
        });
        for (let cycle = 0; cycle < 12; cycle++) {
            await request('out');
            await expect
                .poll(state, { intervals: [20] })
                .toMatchObject({ minimized: true, opacity: 0, windows: 1 });
            await request('in');
            await expect
                .poll(state, { intervals: [20] })
                .toMatchObject({ minimized: false, opacity: 1, windows: 1 });
        }
        const samples: Sample[] = await desktop.evaluate(
            ({ app }) => (app as any).latencyProbe.samples,
        );
        assert.equal(samples.length, 24, 'Every native direction must animate.');
        for (const direction of ['out', 'in'] as const) {
            const matching = samples.filter((sample) => sample.direction === direction);
            const summary = (values: number[]) => {
                const sorted = values.sort((a, b) => a - b);
                return {
                    median: Math.round(sorted[Math.floor(sorted.length / 2)]),
                    p95: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
                };
            };
            const startDelay = summary(matching.map((s) => s.ready! - s.requested));
            const frameInterval = summary(matching.flatMap((s) => s.frames ?? []));
            assert.ok(
                matching.every((s) => (s.frames?.length ?? 0) >= 10),
                'Measure actual frames.',
            );
            console.log(
                direction,
                JSON.stringify({
                    startDelayMs: startDelay,
                    frameIntervalMs: frameInterval,
                    captureMs: summary(matching.map((s) => s.capture!)),
                    overlayLoadMs: summary(matching.map((s) => s.loaded! - s.created!)),
                }),
            );
            assert.ok(
                startDelay.p95 <= Number(process.env.HUB_GENIE_MAX_START_MS ?? 400),
                `${direction} preparation took too long: ${startDelay.p95} ms`,
            );
        }
    } finally {
        await desktop.close().catch(() => {});
        await rm(profile, { recursive: true, force: true, maxRetries: 5 });
    }
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
