import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import koffi from 'koffi';

async function main() {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-genie-stress-'));
    const desktop = await _electron.launch({
        executablePath: process.env.HUB_TEST_EXECUTABLE,
        args: [...(process.env.HUB_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${root}`],
        env: Object.fromEntries(
            Object.entries(process.env).filter(
                ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
            ),
        ) as Record<string, string>,
    });
    const nativeProcess = desktop.process();
    nativeProcess.stderr?.on('data', (data) => {
        const message = String(data);
        if (/fatal|exception|crash|koffi/i.test(message)) process.stderr.write(message);
    });
    try {
        const page = await desktop.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        const id = await desktop.evaluate(
            ({ BrowserWindow }) =>
                BrowserWindow.getAllWindows().find((w) =>
                    w.webContents.getURL().endsWith('/index.html'),
                )!.id,
        );
        const hwnd = BigInt(
            await desktop.evaluate(
                ({ BrowserWindow }, id) =>
                    BrowserWindow.fromId(id)!.getNativeWindowHandle().readBigUInt64LE().toString(),
                id,
            ),
        );
        const resize = koffi
            .load('user32.dll')
            .func('bool __stdcall SetWindowPos(void *, void *, int, int, int, int, uint32_t)');
        await desktop.evaluate(({ app }) => {
            (app as any).stressOverlays = 0;
            app.on('browser-window-created', () => {
                (app as any).stressOverlays++;
            });
            process.getBuiltinModule('v8').setFlagsFromString('--expose-gc');
        });
        const state = () =>
            desktop.evaluate(({ BrowserWindow, app }, id) => {
                const main = BrowserWindow.fromId(id)!;
                return {
                    minimized: main.isMinimized(),
                    opacity: main.getOpacity(),
                    windows: BrowserWindow.getAllWindows().length,
                    overlays: (app as any).stressOverlays,
                };
            }, id);
        const post = (command = 0xf020, burst = 1) =>
            desktop.evaluate(
                ({ BrowserWindow, app }, { id, command, burst }) => {
                    const ffi = process
                        .getBuiltinModule('module')
                        .createRequire(app.getAppPath() + '/package.json')('koffi');
                    const send = ffi
                        .load('user32.dll')
                        .func('bool __stdcall PostMessageW(void *, uint32_t, uintptr_t, intptr_t)');
                    const hwnd = BrowserWindow.fromId(id)!
                        .getNativeWindowHandle()
                        .readBigUInt64LE();
                    for (let i = 0; i < burst; i++) send(hwnd, 0x112, command, 0);
                    for (let i = 0; i < 100; i++) send(hwnd, 0, 0, 0);
                },
                { id, command, burst },
            );
        const restore = () => post(0xf120);
        // Wait for one complete effect without requiring startup metadata to delay the page.
        const deadline = Date.now() + 20_000;
        while (true) {
            await post();
            await expect.poll(state).toMatchObject({ minimized: true, windows: 1 });
            const animated = (await state()).opacity === 0;
            await restore();
            await expect.poll(state).toMatchObject({ minimized: false, opacity: 1, windows: 1 });
            if (animated) break;
            if (Date.now() > deadline) throw Error('Native adapter did not become ready.');
        }
        const cycles = Number(process.env.HUB_GENIE_CYCLES ?? 100);
        for (let cycle = 0; cycle < cycles; cycle++) {
            const before = await state();
            await post();
            if (cycle % 4 === 0) {
                await expect
                    .poll(state, { intervals: [20] })
                    .toMatchObject({ minimized: true, windows: 2 });
            } else {
                await expect
                    .poll(state, { intervals: [20] })
                    .toMatchObject({ minimized: true, opacity: 0, windows: 1 });
            }
            await restore();
            if (cycle % 6 === 0 && cycle % 7 !== 0) {
                await expect
                    .poll(state, { intervals: [20] })
                    .toMatchObject({ minimized: false, windows: 2 });
                assert.ok(resize(hwnd, null, 0, 0, 1180 + (cycle % 4) * 10, 780, 0x16));
            } else if (cycle % 7 === 0) {
                await expect
                    .poll(state, { intervals: [20] })
                    .toMatchObject({ minimized: false, windows: 2 });
                await post();
                await expect.poll(state).toMatchObject({ minimized: true, windows: 1 });
                await restore();
            }
            await expect.poll(state).toMatchObject({ minimized: false, opacity: 1, windows: 1 });
            assert.ok(
                (await state()).overlays >= before.overlays + 2,
                'Both native directions must animate.',
            );
            // Drive native resize from outside Electron, without a main-isolate JS call stack.
            for (let step = 0; step < 8; step++)
                assert.ok(
                    resize(
                        hwnd,
                        null,
                        0,
                        0,
                        1100 + ((cycle + step) % 8) * 10,
                        740 + ((cycle + step) % 8) * 10,
                        0x16,
                    ),
                );
            // Real main-isolate collection exercises native callback lifetime and reentrancy.
            await desktop.evaluate(() => process.getBuiltinModule('vm').runInNewContext('gc')());
            if ((cycle + 1) % 10 === 0)
                console.log(`Native Genie stress: ${cycle + 1}/${cycles} cycles passed.`);
        }
        const closed = desktop.waitForEvent('close');
        await desktop.evaluate(({ BrowserWindow, app }, id) => {
            const ffi = process
                .getBuiltinModule('module')
                .createRequire(app.getAppPath() + '/package.json')('koffi');
            ffi
                .load('user32.dll')
                .func('bool __stdcall PostMessageW(void *, uint32_t, uintptr_t, intptr_t)')(
                BrowserWindow.fromId(id)!.getNativeWindowHandle().readBigUInt64LE(),
                0x10,
                0,
                0,
            );
        }, id);
        await closed;
        await expect.poll(() => nativeProcess.exitCode).toBe(0);
        console.log('Native transitions, external resizing, forced GC and clean shutdown passed.');
    } finally {
        await desktop.close().catch(() => {});
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
