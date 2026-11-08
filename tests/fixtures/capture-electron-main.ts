import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeCaptureHost } from '../../electron/capture-host';
import { trustedFrameReadyHandler } from '../../electron/trusted-ipc';

const root = process.env.HUB_CAPTURE_ELECTRON_ROOT;
if (!root) throw Error('A private generated capture IPC fixture directory is required.');
app.setName('Diagnostic Hub capture IPC fixture');
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'profile'));
app.setPath('crashDumps', path.join(root, 'crash'));
app.setAppLogsPath(path.join(root, 'logs'));
if (!app.requestSingleInstanceLock()) app.exit(2);
void app.whenReady().then(async () => {
    const host = await NativeCaptureHost.open(
            path.join(root, 'profile'),
            { profileOwned: true },
            async () => path.join(root, 'native-export.json'),
        ),
        appUrl = pathToFileURL(path.join(root, 'index.html')).href,
        window = new BrowserWindow({
            show: false,
            width: 1000,
            height: 700,
            webPreferences: {
                preload: path.join(root, 'preload.cjs'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
    let epoch = 0;
    ipcMain.handle(
        'hub:capture',
        trustedFrameReadyHandler(
            () => window,
            appUrl,
            () => epoch,
            async () => host,
            (ready, request) => ready.dispatch(request),
        ),
    );
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
        if (url !== appUrl) event.preventDefault();
    });
    window.webContents.on('render-process-gone', () => {
        epoch++;
        void host.reset();
    });
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMain) => {
        if (isMain) {
            epoch++;
            void host.reset();
        }
    });
    let quitting = false;
    app.on('before-quit', (event) => {
        if (!quitting) {
            event.preventDefault();
            void host.shutdown().finally(() => {
                quitting = true;
                app.quit();
            });
        }
    });
    app.on('window-all-closed', () => app.quit());
    await window.loadURL(appUrl);
});
