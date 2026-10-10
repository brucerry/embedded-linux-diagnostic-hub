import {
    BrowserWindow,
    ipcMain,
    nativeTheme,
    systemPreferences,
    screen,
    type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { genieGeometry, snapshotSize, type Rect } from './genie-geometry';
import type { GeniePayload } from './genie-contract';
import { TaskbarReader } from './taskbar-reader';
import { NativeWindow } from './native-window';

export type TransitionState =
    | 'visible'
    | 'preparing-minimize'
    | 'minimizing'
    | 'minimized'
    | 'preparing-restore'
    | 'restoring'
    | 'disposed';
export class WindowTransitions {
    state: TransitionState = 'visible';
    private overlay: BrowserWindow | null = null;
    private payload: GeniePayload | null = null;
    private delivery: {
        promise: Promise<GeniePayload | null>;
        resolve: (payload: GeniePayload | null) => void;
    } | null = null;
    private source: Rect | null = null;
    private generation = 0;
    private owned = false;
    private handoff = false;
    private ready = false;
    private direction: 'out' | 'in' = 'out';
    private deadline?: NodeJS.Timeout;
    private priming?: Promise<unknown>;
    private primed = false;
    private readonly reader: TaskbarReader | null;
    private native: NativeWindow | null = null;
    private readonly listeners: (() => void)[] = [];
    constructor(
        private readonly main: BrowserWindow,
        private readonly overlayUrl: string,
    ) {
        this.reader =
            process.platform === 'win32'
                ? new TaskbarReader('dev.diagnostichub.desktop', () => main.getTitle())
                : null;
        if (this.reader) {
            try {
                this.native = new NativeWindow(main, () => this.minimize());
            } catch {
                // Keep the ordinary native frame usable if the adapter is unavailable.
            }
        }
        const listen = (
            emitter: NodeJS.EventEmitter,
            event: string,
            callback: (...args: any[]) => void,
        ) => {
            emitter.on(event, callback);
            this.listeners.push(() => emitter.removeListener(event, callback));
        };
        listen(main, 'restore', () => {
            if (this.owned && this.supported()) {
                this.release();
                void this.animate('in');
            } else {
                this.recover(false);
                this.restored();
            }
        });
        listen(main, 'minimize', () => {
            if (this.handoff) return;
            this.recover(true);
        });
        listen(main, 'close', () => this.dispose());
        listen(main.webContents, 'did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
            if (isMainFrame && !inPlace) this.cancel();
        });
        listen(main.webContents, 'render-process-gone', () => this.cancel());
        const checkBounds = () => {
            // Windows can emit move without changing bounds when an overlay is created.
            // Minimization itself also produces move notifications; its saved bounds are intact.
            if (!this.source || main.isMinimized()) return;
            const current = main.getContentBounds();
            if (
                ['x', 'y', 'width', 'height'].some(
                    (key) => current[key as keyof Rect] !== this.source![key as keyof Rect],
                )
            )
                this.cancel();
        };
        listen(main, 'resize', checkBounds);
        listen(main, 'move', checkBounds);
        listen(screen, 'display-metrics-changed', () => {
            if (this.source) this.cancel();
        });
        listen(screen, 'display-removed', () => {
            if (this.source) this.cancel();
        });
        listen(nativeTheme, 'updated', () => {
            this.native?.enable(this.supported());
            if (!this.supported()) this.cancel();
        });
        for (const channel of ['payload', 'ready', 'done'] as const) {
            ipcMain.handle(`genie:${channel}`, (event, generation: unknown) => {
                if (!this.trusted(event, generation)) throw Error('Untrusted transition frame.');
                if (channel === 'payload') return this.payload ?? this.delivery?.promise ?? null;
                if (channel === 'ready') return this.start();
                if (!this.ready) throw Error('Transition has not started.');
                if (this.direction === 'in') this.main.setOpacity(1);
                if (generation !== this.generation) return;
                this.state = this.direction === 'out' ? 'minimized' : 'visible';
                if (this.direction === 'in') {
                    this.owned = false;
                    this.native?.suppressMotion(false);
                    this.restored();
                }
                // Let the IPC response reach the renderer before destroying its WebContents.
                const current = generation;
                setImmediate(() => {
                    if (current === this.generation) this.release();
                });
            });
            this.listeners.push(() => ipcMain.removeHandler(`genie:${channel}`));
        }
    }
    prime() {
        return (this.priming ??= (this.reader?.prime() ?? Promise.resolve()).then(() => {
            this.primed = true;
            this.native?.enable(this.supported());
        }));
    }
    supported() {
        return Boolean(
            this.reader &&
            this.native &&
            this.primed &&
            !systemPreferences.getAnimationSettings().prefersReducedMotion &&
            this.state !== 'disposed',
        );
    }
    refreshMotion() {
        this.native?.enable(this.supported());
        if (!this.supported()) this.cancel();
    }
    minimize() {
        if (
            this.state === 'disposed' ||
            this.main.isDestroyed() ||
            this.main.isMinimized() ||
            this.state === 'preparing-minimize' ||
            this.state === 'minimizing'
        )
            return;
        this.release();
        if (!this.supported()) return this.recover(true);
        this.owned = true;
        if (!this.native?.suppressMotion(true)) return this.recover(true);
        void this.animate('out');
    }
    private trusted(event: IpcMainInvokeEvent, generation: unknown) {
        return (
            this.overlay &&
            event.sender === this.overlay.webContents &&
            event.senderFrame === this.overlay.webContents.mainFrame &&
            event.senderFrame?.url === this.overlayUrl &&
            generation === this.generation &&
            Number.isSafeInteger(generation)
        );
    }
    private release() {
        this.generation++;
        clearTimeout(this.deadline);
        this.deadline = undefined;
        const overlay = this.overlay;
        this.overlay = null;
        this.delivery?.resolve(null);
        this.delivery = null;
        this.payload = null;
        this.source = null;
        this.ready = false;
        if (overlay && !overlay.isDestroyed()) overlay.destroy();
    }
    private recover(minimized: boolean) {
        if (this.state === 'disposed') return;
        const restoring = this.state === 'preparing-restore' || this.state === 'restoring';
        this.release();
        this.owned = false;
        if (!this.main.isDestroyed()) {
            this.main.setOpacity(1);
            this.handoff = true;
            try {
                if (minimized && !this.main.isMinimized()) this.applyMinimize();
            } finally {
                this.handoff = false;
            }
        }
        this.state = minimized ? 'minimized' : 'visible';
        this.native?.suppressMotion(false);
        if (restoring && !minimized) this.restored();
    }
    private restored() {
        if (!this.main.isDestroyed()) this.main.webContents.send('hub:window-restored');
    }
    private cancel() {
        if (this.state === 'disposed') return;
        const minimized =
            this.state === 'preparing-minimize' ||
            this.state === 'minimizing' ||
            this.main.isMinimized();
        this.recover(minimized);
    }
    private start() {
        if (!this.supported()) {
            this.cancel();
            return false;
        }
        if (this.ready || !this.overlay) return false;
        const generation = this.generation;
        this.ready = true;
        this.overlay.showInactive();
        if (generation !== this.generation) return false;
        if (this.direction === 'out') {
            this.main.setOpacity(0);
            if (generation !== this.generation) return false;
            this.handoff = true;
            try {
                this.applyMinimize();
            } finally {
                this.handoff = false;
            }
        }
        if (generation !== this.generation) return false;
        this.state = this.direction === 'out' ? 'minimizing' : 'restoring';
        return true;
    }
    private async animate(direction: 'out' | 'in') {
        this.direction = direction;
        this.state = direction === 'out' ? 'preparing-minimize' : 'preparing-restore';
        const generation = ++this.generation;
        this.deadline = setTimeout(() => this.recover(direction === 'out'), 2000);
        try {
            // A restore event can still be on the native window procedure's stack. Creating
            // another HWND there can reenter resize/restore and cancel this generation.
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (generation !== this.generation) return;
            const source = this.main.getContentBounds();
            this.source = source;
            let deliver!: (payload: GeniePayload | null) => void;
            this.delivery = {
                promise: new Promise((resolve) => {
                    deliver = resolve;
                }),
                resolve: (payload) => deliver(payload),
            };
            // Start the fresh renderer while shell lookup and capture run. It remains hidden,
            // waits for this generation's payload, and owns no persistent snapshot/window.
            const overlay = new BrowserWindow({
                ...source,
                show: false,
                frame: false,
                transparent: true,
                focusable: false,
                skipTaskbar: true,
                hasShadow: false,
                alwaysOnTop: true,
                webPreferences: {
                    preload: path.join(__dirname, 'genie-preload.cjs'),
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    webSecurity: true,
                    backgroundThrottling: false,
                    additionalArguments: [`--genie-generation=${generation}`],
                },
            });
            if (generation !== this.generation) {
                if (!overlay.isDestroyed()) overlay.destroy();
                return;
            }
            this.overlay = overlay;
            overlay.setIgnoreMouseEvents(true);
            overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            overlay.webContents.on('will-navigate', (event) => event.preventDefault());
            overlay.webContents.on('will-redirect', (event) => event.preventDefault());
            const failure = () => {
                if (generation === this.generation) this.recover(direction === 'out');
            };
            overlay.webContents.on('render-process-gone', failure);
            overlay.on('unresponsive', failure);
            overlay.on('closed', failure);
            const [taskbar, image] = await Promise.all([
                this.reader!.forWindow(source),
                this.main.webContents
                    .capturePage(undefined, { stayHidden: true })
                    .then((captured) => {
                        if (generation !== this.generation) return null;
                        const size = captured.getSize();
                        return captured.resize(snapshotSize(size.width, size.height)).toDataURL();
                    }),
                overlay.loadURL(this.overlayUrl),
            ]);
            if (generation !== this.generation) return;
            if (!taskbar || !image) throw Error('Missing transition geometry or image.');
            const geometry = genieGeometry(source, taskbar);
            overlay.setBounds(geometry.bounds);
            if (generation !== this.generation) return;
            this.payload = { ...geometry, generation, direction, image };
            this.delivery?.resolve(this.payload);
            this.delivery = null;
        } catch {
            if (generation === this.generation) this.recover(direction === 'out');
        }
    }
    private applyMinimize() {
        if (this.native) this.native.nativeMinimize();
        else this.main.minimize();
    }
    dispose() {
        if (this.state === 'disposed') return;
        this.release();
        if (!this.main.isDestroyed()) this.main.setOpacity(1);
        this.state = 'disposed';
        this.reader?.close();
        this.native?.dispose();
        this.listeners.splice(0).forEach((remove) => remove());
    }
}
