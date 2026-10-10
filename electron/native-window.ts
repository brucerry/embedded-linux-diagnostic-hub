import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import koffi from 'koffi';
import path from 'node:path';

// No native message calls a Koffi JS callback or forwards Chromium through FFI.
export class NativeWindow {
    private readonly hwnd: bigint;
    private readonly message: number;
    private readonly detach: (...args: any[]) => any;
    private readonly toggle: (...args: any[]) => any;
    private readonly bypass: (...args: any[]) => any;
    private readonly setAttribute: (...args: any[]) => any;
    private detached = false;
    private suppressing = false;
    constructor(
        private readonly window: BrowserWindow,
        minimize: () => void,
    ) {
        this.hwnd = window.getNativeWindowHandle().readBigUInt64LE();
        const library = koffi.load(
            app.isPackaged
                ? path.join(
                      process.resourcesPath,
                      'app.asar.unpacked/dist-electron/native-window.dll',
                  )
                : path.join(__dirname, 'native-window.dll'),
        );
        this.detach = library.func('int32_t __stdcall HubDetach(void *)');
        this.toggle = library.func('int32_t __stdcall HubEnable(void *, int32_t)');
        this.bypass = library.func('int32_t __stdcall HubBypass(void *, int32_t)');
        const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
        this.setAttribute = koffi
            .load(path.join(system, 'dwmapi.dll'))
            .func('int32_t __stdcall DwmSetWindowAttribute(void *, uint32_t, int32_t *, uint32_t)');
        this.message = library.func('uint32_t __stdcall HubAttach(void *)')(this.hwnd);
        if (!this.message) throw Error('Cannot attach native window transitions.');
        try {
            window.hookWindowMessage(this.message, () =>
                setImmediate(() => {
                    if (!this.detached) minimize();
                }),
            );
        } catch (error) {
            this.detach(this.hwnd);
            throw error;
        }
    }
    enable(value: boolean) {
        if (!this.detached) this.toggle(this.hwnd, value ? 1 : 0);
    }
    nativeMinimize() {
        if (!this.detached) this.bypass(this.hwnd, 1);
        try {
            this.window.minimize();
        } finally {
            if (!this.detached) this.bypass(this.hwnd, 0);
        }
    }
    suppressMotion(value: boolean): boolean {
        if (!this.detached && this.suppressing !== value) {
            if (this.setAttribute(this.hwnd, 3, [value ? 1 : 0], 4) < 0) return false;
            this.suppressing = value;
        }
        return !this.detached;
    }
    dispose() {
        if (this.detached) return;
        this.suppressMotion(false);
        this.toggle(this.hwnd, 0);
        if (!this.window.isDestroyed()) this.window.unhookWindowMessage(this.message);
        this.detach(this.hwnd);
        this.detached = true;
    }
}
