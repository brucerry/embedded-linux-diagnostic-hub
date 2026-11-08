import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { NativeCaptureHost } from '../../electron/capture-host';
import { trustedFrameHandler, trustedFrameReadyHandler } from '../../electron/trusted-ipc';
import { SshSession } from '../../backend/ssh/session';
import { streamRequest } from '../../shared/ssh-stream-rpc';

const root = process.env.HUB_SSH_ELECTRON_ROOT;
if (!root) throw Error('A private local SSH IPC fixture root is required.');
app.setName('Diagnostic Hub SSH IPC fixture');
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'profile'));
app.setPath('crashDumps', path.join(root, 'crash'));
app.setAppLogsPath(path.join(root, 'logs'));
if (!app.requestSingleInstanceLock()) app.exit(2);
void app.whenReady().then(async () => {
    const config = JSON.parse(await fs.readFile(path.join(root, 'connection.json'), 'utf8'));
    const host = await NativeCaptureHost.open(
        path.join(root, 'profile'),
        { profileOwned: true },
        async () => null,
    );
    const appUrl = pathToFileURL(path.join(root, 'index.html')).href;
    const window = new BrowserWindow({
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
    const ssh = new SshSession(() => {
        if (!window.isDestroyed()) window.webContents.send('hub:disconnected');
    });
    let epoch = 0;
    const handle = (name: string, fn: (...args: unknown[]) => unknown) =>
        ipcMain.handle(
            name,
            trustedFrameHandler(() => window, appUrl, fn),
        );
    handle('hub:connect', async (input) => {
        if (
            JSON.stringify(input) !== JSON.stringify(config.options) ||
            config.options.host !== '127.0.0.1'
        )
            throw Error('Only the owned loopback fixture can connect.');
        await ssh.connect(config.options, async (key) => key === config.pinned);
        return { ok: true, connection: ssh.automationConnection };
    });
    handle('hub:automation-stream', (input) => ssh.automationStream(streamRequest(input)));
    handle('hub:collect', () => ssh.collect());
    handle('hub:disconnect', () => ssh.disconnect());
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
    const reset = () => {
        epoch++;
        ssh.clearAutomationStream();
        void host.reset();
    };
    window.webContents.on('render-process-gone', () => {
        ssh.disconnect();
        reset();
    });
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, main) => {
        if (main) reset();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
        if (url !== appUrl) event.preventDefault();
    });
    let quitting = false;
    app.on('before-quit', (event) => {
        if (!quitting) {
            event.preventDefault();
            ssh.disconnect();
            void host.shutdown().finally(() => {
                quitting = true;
                app.quit();
            });
        }
    });
    app.on('window-all-closed', () => app.quit());
    await window.loadURL(appUrl);
});
