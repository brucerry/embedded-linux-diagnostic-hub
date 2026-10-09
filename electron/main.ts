import {
    app,
    BrowserWindow,
    clipboard,
    dialog,
    ipcMain,
    net,
    protocol,
    session,
    shell,
} from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeviceMonitor } from '../backend/ssh/monitor';
import { validateConnection } from '../backend/ssh/session';
import { RELEASES_URL, REPOSITORY_URL } from '../shared/project';
import { createReport, validateSnapshot } from '../shared/report';
import type { Snapshot } from '../shared/types';
import type { TerminalOpen } from '../shared/terminal';
import { ReleaseUpdater } from './updates';
import { HostVerification } from './host-verification';
import { UpdateCoordinator } from './update-coordinator';
import { UpdateReports } from './update-reports';

const development = process.argv.includes('--dev') && !app.isPackaged;
const appUrl = development ? 'http://127.0.0.1:5173/' : 'app://bundle/index.html';
let window: BrowserWindow;
let keyPath: string | null = null;
let connecting = false;
let lastSnapshot: Snapshot | null = null;
let collectionTask: Promise<Snapshot> | null = null;
const hostVerification = new HostVerification((request) => {
    if (window && !window.isDestroyed()) window.webContents.send('hub:verify-host-key', request);
});
const ssh = new DeviceMonitor(() => {
    if (window && !window.isDestroyed()) window.webContents.send('hub:disconnected');
});

protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function registerHandler(name: string, handler: (...args: unknown[]) => unknown) {
    ipcMain.handle(name, (event, ...args) => {
        if (
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            event.senderFrame?.url !== appUrl
        ) {
            throw new Error('Untrusted application frame.');
        }
        return handler(...args);
    });
}

async function verifyHost(endpoint: string, received: string): Promise<boolean> {
    const file = path.join(app.getPath('userData'), 'known-hosts.json');
    let known: Record<string, string> = {};
    try {
        const data: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (
            !data ||
            Array.isArray(data) ||
            typeof data !== 'object' ||
            Object.values(data).some((value) => typeof value !== 'string')
        )
            throw new Error('Invalid host-key store.');
        known = data as Record<string, string>;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error(
                'Cannot read the trusted host-key store. Inspect known-hosts.json in the application data directory.',
            );
    }
    const changed = Object.hasOwn(known, endpoint);
    if (changed && known[endpoint] === received) return true;
    if (
        !(await hostVerification.request(endpoint, received, changed ? known[endpoint] : undefined))
    )
        return false;
    Object.defineProperty(known, endpoint, {
        value: received,
        enumerable: true,
        writable: true,
        configurable: true,
    });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(known, null, 2), { mode: 0o600 });
    return true;
}

app.whenReady().then(async () => {
    const updater = new ReleaseUpdater(
        app.getVersion(),
        path.join(app.getPath('userData'), 'updates'),
        process.platform,
        process.arch,
        app.isPackaged,
    );
    const reports = new UpdateReports(path.join(app.getPath('userData'), 'update-reports'));
    const update = new UpdateCoordinator(updater, reports, {
        isConnecting: () => connecting,
        isConnected: () => ssh.isConnected,
        waitForCollection: async () => {
            await collectionTask?.catch(() => {});
        },
        latestSnapshot: () => lastSnapshot,
        disconnect: () => {
            ssh.clear();
            window.webContents.send('hub:disconnected', 'update');
        },
        progress: (message) => window.webContents.send('hub:update-progress', message),
        restart: (execPath) => {
            app.relaunch({
                execPath,
                args: [
                    ...(process.platform === 'linux' ? ['--appimage-extract-and-run'] : []),
                    `--user-data-dir=${app.getPath('userData')}`,
                ],
            });
            setImmediate(() => app.quit());
        },
    });

    protocol.handle('app', (request) => {
        const url = new URL(request.url);
        const root = path.join(app.getAppPath(), 'dist');
        const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
        if (url.hostname !== 'bundle' || !file.startsWith(`${root}${path.sep}`))
            return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({
        icon: path.join(app.getAppPath(), 'dist', 'app-icon.png'),
        width: 1440,
        height: 960,
        minWidth: 980,
        minHeight: 720,
        title: 'Diagnostic Hub',
        backgroundColor: '#1d242d',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
        },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
        if (url !== appUrl) event.preventDefault();
    });
    window.on('closed', () => {
        hostVerification.clear();
        ssh.clear();
    });
    registerHandler('hub:confirm-host-key', (id, accepted) =>
        hostVerification.confirm(id, accepted),
    );
    registerHandler('hub:connect', async (input) => {
        if (update.active) throw new Error('An update is in progress. SSH remains disconnected.');
        if (connecting) throw new Error('A connection is already in progress.');
        const options = validateConnection(input);
        connecting = true;
        try {
            const privateKey =
                options.auth === 'key'
                    ? keyPath
                        ? await readFile(keyPath)
                        : undefined
                    : undefined;
            if (options.auth === 'key' && !privateKey)
                throw new Error('Select a private key first.');
            await ssh.configure(
                options,
                (key) => verifyHost(`${options.host}:${options.port}`, key),
                privateKey,
            );
        } finally {
            hostVerification.clear();
            connecting = false;
        }
    });
    registerHandler('hub:disconnect', () => {
        if (connecting || ssh.isCollecting)
            throw new Error('Wait for the current connection or collection to finish.');
        ssh.clear();
    });
    registerHandler('hub:terminal-open', (request) => {
        if (update.active || connecting)
            throw Error('Wait for the current connection or update to finish.');
        return ssh.openTerminal(request as TerminalOpen, (event) => {
            if (!window.isDestroyed()) window.webContents.send('hub:terminal-event', event);
        });
    });
    registerHandler('hub:terminal-input', (id, data) => {
        if (update.active || connecting)
            throw Error('Terminal input is paused for the connection or update.');
        return ssh.getTerminal(id).write(data);
    });
    registerHandler('hub:terminal-resize', (id, size) => ssh.getTerminal(id).resize(size));
    registerHandler('hub:terminal-ack', (id, sequence) =>
        ssh.getTerminal(id).acknowledge(sequence),
    );
    registerHandler('hub:terminal-close', (id) => ssh.getTerminal(id).close());
    registerHandler('hub:device-clock', () => {
        if (update.active || connecting)
            throw Error('Wait for the current connection or update to finish.');
        return ssh.readClock();
    });
    registerHandler('hub:collect', async () => {
        if (update.active) throw new Error('Live collection is paused for the update.');
        if (collectionTask) throw new Error('A collection is already running.');
        const pending = ssh.collect().then((snapshot) => {
            lastSnapshot = snapshot;
            return snapshot;
        });
        collectionTask = pending;
        try {
            return await pending;
        } finally {
            collectionTask = null;
        }
    });
    registerHandler('hub:pick-key', async () => {
        const choice = await dialog.showOpenDialog(window, {
            title: 'Select SSH private key',
            properties: ['openFile'],
        });
        if (choice.canceled) return null;
        keyPath = choice.filePaths[0];
        return path.basename(keyPath);
    });
    registerHandler('hub:check-updates', (includePrereleases) => {
        if (update.active) throw new Error('An update is already in progress.');
        return updater.check(includePrereleases as boolean);
    });
    registerHandler('hub:start-update', (request) => update.start(request));
    registerHandler('hub:read-update-report', () => reports.read());
    registerHandler('hub:clear-session-data', () => {
        if (update.active) throw new Error('Wait for the update to finish before resetting data.');
        if (connecting || collectionTask || ssh.isCollecting)
            throw new Error('Wait for the current connection or collection to finish.');
        lastSnapshot = null;
    });
    registerHandler('hub:acknowledge-update-report', (id) => {
        if (typeof id !== 'string') throw new Error('Invalid saved update report.');
        return reports.acknowledge(id);
    });
    registerHandler('hub:open-repository', () => shell.openExternal(REPOSITORY_URL));
    registerHandler('hub:open-releases', () => shell.openExternal(RELEASES_URL));
    registerHandler('hub:copy-text', (command) => {
        if (typeof command !== 'string' || command.length > 262144)
            throw new Error('Diagnostic text exceeds the clipboard limit.');
        return clipboard.writeText(command);
    });
    registerHandler('hub:read-clipboard', async () => {
        const text = await clipboard.readText();
        if (text.length > 262144) throw Error('Clipboard text exceeds the terminal paste limit.');
        return text;
    });
    registerHandler('hub:export', async (importedData) => {
        const snapshot = importedData !== undefined ? validateSnapshot(importedData) : lastSnapshot;
        if (!snapshot) throw new Error('Collect a diagnostic snapshot before exporting.');
        const choice = await dialog.showSaveDialog(window, {
            title: 'Export diagnostic evidence',
            defaultPath: `diagnostic-${snapshot.mode}-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`,
            filters: [{ name: 'JSON diagnostic report', extensions: ['json'] }],
        });
        if (choice.canceled || !choice.filePath) return false;
        await writeFile(choice.filePath, JSON.stringify(createReport(snapshot), null, 2), 'utf8');
        return true;
    });
    await window.loadURL(appUrl);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
    hostVerification.clear();
    ssh.clear();
});
