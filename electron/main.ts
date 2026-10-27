import { trustedFrameHandler, trustedFrameReadyHandler } from './trusted-ipc';
import { NativeCaptureHost } from './capture-host';
import { NativeConsoleService } from './console-service';
import { storageError } from '../shared/capture-store';
import { consoleRpcRequest } from '../shared/console-rpc';
import { setupWorkerMain } from './setup-worker';
import { acknowledgeSetupBoot } from './installation-maintenance';
import { configureSerial } from './serial';
import { AutomationActivity } from './automation-activity';
import { streamRequest } from '../shared/ssh-stream-rpc';
import {
    app,
    BrowserWindow,
    clipboard,
    dialog,
    ipcMain,
    net,
    protocol,
    powerMonitor,
    session,
    shell,
} from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ConnectionFailure, connectionFailure, connectionAttemptId } from '../shared/connection';
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
import { UpdateReceipts } from './update-receipt';
import { canonicalProfilePath, selectDesktopStartup } from './installation-startup';
import {
    LINUX_DESKTOP_NAME,
    withNativeLinuxWindow,
    withInstalledLinuxWindow,
} from './linux-window-identity';

if (process.argv.includes('--diagnostic-hub-setup-worker')) {
    void setupWorkerMain(app, shell, dialog)
        .then((code) => app.exit(code))
        .catch((error) => {
            console.error('Setup worker refused:', error);
            app.exit(1);
        });
} else {
    const development = process.argv.includes('--dev') && !app.isPackaged;
    const appUrl = development ? 'http://127.0.0.1:5173/' : 'app://bundle/index.html';
    let window: BrowserWindow;
    let startup: ReturnType<typeof selectDesktopStartup>;
    let ownsProfile = true;
    try {
        startup = selectDesktopStartup({
            platform: process.platform,
            arch: process.arch,
            packaged: app.isPackaged,
            executable: process.execPath,
            version: app.getVersion(),
            environment: process.env,
            appData: app.getPath('appData'),
            profileOverride: app.commandLine.getSwitchValue('user-data-dir') || undefined,
        });
        const profile = canonicalProfilePath(startup.profilePath || app.getPath('userData'));
        app.setPath('userData', profile);
        app.setPath('sessionData', profile);
        ownsProfile = app.requestSingleInstanceLock();
        if (!ownsProfile) app.quit();
    } catch (error) {
        ownsProfile = false;
        dialog.showErrorBox(
            'Diagnostic Hub could not start',
            (error instanceof Error ? error.message : String(error)) +
                '\nUse verified setup to repair the app or choose an available per-user profile.',
        );
        app.exit(1);
        startup = { delivery: 'unavailable', currentPath: null };
    }
    app.on('second-instance', () => {
        if (window && !window.isDestroyed()) {
            if (window.isMinimized()) window.restore();
            window.focus();
        }
    });

    if (process.platform === 'win32') app.setAppUserModelId('dev.diagnostichub.desktop');
    if (process.platform === 'linux') app.setDesktopName(LINUX_DESKTOP_NAME);
    let keyPath: string | null = null;
    let connecting = false;
    let currentConnectionAttempt = '';
    let pendingConnection:
        { id: string; controller: AbortController; done: Promise<void> } | undefined;
    let lastSnapshot: Snapshot | null = null;
    let collectionTask: Promise<Snapshot> | null = null;
    const hostVerification = new HostVerification((request) => {
        if (window && !window.isDestroyed())
            window.webContents.send('hub:verify-host-key', request);
    });
    const ssh = new DeviceMonitor(() => {
        if (window && !window.isDestroyed()) window.webContents.send('hub:disconnected');
    });

    protocol.registerSchemesAsPrivileged([
        { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ]);

    let captureHostPromise: Promise<NativeCaptureHost> | undefined;
    const consoleService = new NativeConsoleService(app.getPath('userData'), async (format) => {
        const extensions = { json: 'json', csv: 'csv', markdown: 'md', text: 'txt' };
        const result = await dialog.showSaveDialog(window, {
            title: 'Export stored console captures',
            defaultPath: 'console-results.' + extensions[format],
            filters: [{ name: format.toUpperCase(), extensions: [extensions[format]] }],
            properties: ['showOverwriteConfirmation'],
        });
        return result.canceled ? null : (result.filePath ?? null);
    });
    let captureShutdown: Promise<void> | undefined;
    let captureShutdownComplete = false;
    let captureRendererEpoch = 0;
    const captureHost = () =>
        (captureHostPromise ??= NativeCaptureHost.open(
            app.getPath('userData'),
            { profileOwned: true },
            async (format) => {
                const extensions = { json: 'json', csv: 'csv', markdown: 'md', text: 'txt' };
                const result = await dialog.showSaveDialog(window, {
                    title: 'Export stored command captures',
                    defaultPath: 'automation-results.' + extensions[format],
                    filters: [{ name: format.toUpperCase(), extensions: [extensions[format]] }],
                    properties: ['showOverwriteConfirmation'],
                });
                return result.canceled ? null : (result.filePath ?? null);
            },
        ).catch((error) => {
            captureHostPromise = undefined;
            throw error;
        }));
    const resetCaptureRenderer = () => {
        captureRendererEpoch++;
        void consoleService
            .reset()
            .catch((error) => console.error('Console reader cleanup:', String(error)));
        void captureHostPromise
            ?.then((host) => host.reset())
            .catch((error) => console.error('Capture cleanup:', String(error)));
    };

    function registerHandler(name: string, handler: (...args: unknown[]) => unknown) {
        ipcMain.handle(
            name,
            trustedFrameHandler(() => window, appUrl, handler),
        );
    }

    async function verifyHost(
        endpoint: string,
        received: string,
        signal?: AbortSignal,
    ): Promise<boolean> {
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
        if (signal?.aborted) return false;
        const changed = Object.hasOwn(known, endpoint);
        if (changed && known[endpoint] === received) return true;
        if (
            !(await hostVerification.request(
                endpoint,
                received,
                changed ? known[endpoint] : undefined,
            ))
        )
            return false;
        if (signal?.aborted) return false;
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
        if (!ownsProfile) return;
        const updater = new ReleaseUpdater(
            app.getVersion(),
            path.join(app.getPath('userData'), 'updates'),
            process.platform,
            process.arch,
            app.isPackaged,
            undefined,
            startup.delivery,
        );
        const reports = new UpdateReports(path.join(app.getPath('userData'), 'update-reports'));
        const receipts = new UpdateReceipts(
            path.join(app.getPath('userData'), 'updates'),
            process.platform,
        );
        const runningExecutable = startup.currentPath;
        let serial: ReturnType<typeof configureSerial>;
        let activity: AutomationActivity | undefined;
        const update = new UpdateCoordinator(updater, reports, {
            isConnecting: () => connecting,
            quiesceSerial: async () => {
                activity?.interrupt('Update started. Arm explicitly after reconnecting.');
                ssh.clearAutomationStream();
                await serial.quiesce();
                await consoleService.reset();
                await ssh.shutdownConsole();
            },
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
            restart: async (execPath) => {
                const info = updater.handoffInfo();
                if (info.executable !== execPath)
                    throw Error('Update executable changed before restart.');
                await receipts.write({ ...info, state: 'verified' });
                try {
                    await receipts.write({ ...info, state: 'restart-requested' });
                    app.relaunch({
                        execPath,
                        args: [
                            ...(process.platform === 'linux' ? ['--appimage-extract-and-run'] : []),
                            `--user-data-dir=${app.getPath('userData')}`,
                        ],
                    });
                    setImmediate(() => app.quit());
                } catch (error) {
                    await receipts.write({ ...info, state: 'restart-failed' });
                    throw error;
                }
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
        const createWindow = () =>
            new BrowserWindow({
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
        window =
            process.platform === 'linux'
                ? startup.installation?.manifest.layout === 'linux-folder'
                    ? withInstalledLinuxWindow(
                          (name) => app.setDesktopName(name),
                          startup.installation.record.installationId,
                          createWindow,
                      )
                    : withNativeLinuxWindow((name) => app.setDesktopName(name), createWindow)
                : createWindow();
        activity = new AutomationActivity(
            (enabled) => {
                if (!window.isDestroyed()) window.webContents.setBackgroundThrottling(enabled);
            },
            (reason) => {
                if (!window.isDestroyed())
                    window.webContents.send('hub:automation-interrupted', reason);
            },
            () => update.active,
        );
        ipcMain.handle(
            'hub:capture',
            trustedFrameReadyHandler(
                () => window,
                appUrl,
                () => captureRendererEpoch,
                captureHost,
                (host, request) => host.dispatch(request),
            ),
        );
        registerHandler('hub:automation-activity-acquire', () => activity!.acquire());
        registerHandler('hub:automation-activity-release', (id) => activity!.release(id));
        powerMonitor.on('suspend', () => {
            activity!.suspend();
            ssh.clearAutomationStream();
        });
        powerMonitor.on('resume', () => activity!.resume());
        window.webContents.on('render-process-gone', () => {
            resetCaptureRenderer();
            activity!.clear();
            ssh.clear();
        });
        window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
            if (isMainFrame) {
                ssh.clearAutomationStream();
                activity!.clear();
                resetCaptureRenderer();
            }
        });
        window.on('closed', () => {
            activity!.clear();
            ssh.clearAutomationStream();
            resetCaptureRenderer();
        });
        serial = configureSerial(window, appUrl, () => update.active);
        registerHandler('hub:serial-select', (id, portId) => serial.select(id, portId));
        registerHandler('hub:serial-cleanup-ack', (id) => serial.acknowledge(id));
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event, url) => {
            if (url !== appUrl) event.preventDefault();
        });
        window.on('restore', () => window.webContents.send('hub:window-restored'));
        window.on('closed', () => {
            hostVerification.clear();
            ssh.clear();
        });
        registerHandler('hub:confirm-host-key', (id, accepted) =>
            hostVerification.confirm(id, accepted),
        );
        registerHandler('hub:connect', async (input, requestedId) => {
            let id = '';
            try {
                if (update.active)
                    throw new ConnectionFailure(
                        'policy',
                        'An update is in progress. SSH remains disconnected.',
                    );
                if (connecting)
                    throw new ConnectionFailure('policy', 'A connection is already in progress.');
                id =
                    requestedId === undefined
                        ? randomUUID().replaceAll('-', '')
                        : connectionAttemptId(requestedId);
                let options;
                try {
                    options = validateConnection(input);
                } catch {
                    throw new ConnectionFailure(
                        'policy',
                        'Invalid connection settings. Correct them and connect again.',
                    );
                }
                const controller = new AbortController();
                connecting = true;
                currentConnectionAttempt = id;
                const done = (async () => {
                    let privateKey: Buffer | undefined;
                    try {
                        if (options.auth === 'key') {
                            if (!keyPath)
                                throw new ConnectionFailure(
                                    'policy',
                                    'Select a private key first.',
                                );
                            try {
                                privateKey = await readFile(keyPath);
                            } catch {
                                throw new ConnectionFailure(
                                    'policy',
                                    'Cannot read the selected private key. Select it again.',
                                );
                            }
                        }
                        if (controller.signal.aborted)
                            throw new ConnectionFailure('cancelled', 'Connection cancelled.');
                        await ssh.configure(
                            options,
                            (key) =>
                                verifyHost(
                                    `${options.host}:${options.port}`,
                                    key,
                                    controller.signal,
                                ),
                            privateKey,
                            controller.signal,
                        );
                    } finally {
                        privateKey?.fill(0);
                        options.password = undefined;
                        options.passphrase = undefined;
                    }
                })();
                const pending = { id, controller, done };
                pendingConnection = pending;
                try {
                    await done;
                } finally {
                    if (pendingConnection === pending) pendingConnection = undefined;
                    hostVerification.clear();
                    connecting = false;
                }
                return { ok: true, connection: ssh.automationConnection };
            } catch (error) {
                if (currentConnectionAttempt === id) currentConnectionAttempt = '';
                const failure = connectionFailure(error);
                return { ok: false, code: failure.code, message: failure.message };
            }
        });
        registerHandler('hub:cancel-connect', async (input) => {
            const id = connectionAttemptId(input);
            const pending = pendingConnection?.id === id ? pendingConnection : undefined;
            if (pending) {
                pending.controller.abort();
                hostVerification.clear();
            }
            if (currentConnectionAttempt === id) {
                currentConnectionAttempt = '';
                ssh.clear();
            }
            await pending?.done.catch(() => {});
        });
        registerHandler('hub:disconnect', async () => {
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
        registerHandler('hub:automation-run', (request) => {
            if (update.active || connecting)
                throw Error('Automation is paused for the connection or update.');
            return ssh.runAutomation(request as import('../shared/automation').AutomationRequest);
        });
        registerHandler('hub:automation-stream', (request) => {
            const checked = streamRequest(request);
            if (checked.action === 'start' && (connecting || update.active))
                throw Error('Automation is paused for the connection or update.');
            return ssh.automationStream(checked);
        });
        registerHandler('hub:automation-console', (request) => {
            const checked = consoleRpcRequest(request);
            if (['open', 'step'].includes(checked.action) && (connecting || update.active))
                throw Error('Automation is paused for the connection or update.');
            return ssh.automationConsole(checked, consoleService.createWriter);
        });
        registerHandler('hub:console-storage', async (request) => {
            try {
                return { ok: true, value: await consoleService.dispatch(request) };
            } catch (error) {
                const failure = storageError(error);
                return {
                    ok: false,
                    error: { code: failure.code, message: failure.message.slice(0, 512) },
                };
            }
        });
        registerHandler('hub:automation-cancel', (id, connection) =>
            ssh.cancelAutomation(id as string, connection as string),
        );
        registerHandler('hub:device-clock', (connection) => {
            if (connection !== undefined && connection !== ssh.automationConnection)
                throw Error('Device clock connection changed.');
            if (update.active || connecting)
                throw Error('Wait for the current connection or update to finish.');
            return ssh.readClock();
        });
        registerHandler('hub:collect', async (options) => {
            if (update.active) throw new Error('Live collection is paused for the update.');
            if (collectionTask) throw new Error('A collection is already running.');
            const pending = ssh
                .collect(options as import('../shared/diagnostics/network/evidence').CollectOptions)
                .then((snapshot) => {
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
        registerHandler('hub:start-update', async (request) => {
            if (update.active) throw Error('An update is already in progress.');
            try {
                return await update.start(request);
            } finally {
                serial.release();
            }
        });
        registerHandler('hub:read-update-info', async () => {
            if (
                startup.installation &&
                startup.profilePath &&
                window.isVisible() &&
                !window.isMinimized()
            ) {
                await acknowledgeSetupBoot({
                    root: startup.installation.root,
                    installationId: startup.installation.record.installationId,
                    manifestSHA256: startup.installation.record.manifestSHA256,
                    version: app.getVersion(),
                    profile: startup.profilePath,
                    nativeExecutable: process.execPath,
                    processCreationMs: process.getCreationTime(),
                }).catch((error) =>
                    console.warn('Setup acknowledgement unavailable:', String(error)),
                );
            }
            return startup.delivery === 'installed'
                ? {
                      currentVersion: app.getVersion(),
                      currentPath: runningExecutable,
                      receipt: null,
                      handoffConfirmed: false,
                      installation: {
                          id: startup.installation!.record.installationId,
                          layout: startup.installation!.manifest.layout,
                          profilePath: app.getPath('userData'),
                          payloadIntegrity: 'not-checked',
                          automaticUpdateQualified: false,
                      },
                  }
                : receipts.info(app.getVersion(), runningExecutable);
        });
        const selectedUpdatePath = async (target: unknown) => {
            if (startup.delivery !== 'installed')
                return receipts.selectedPath(target, runningExecutable);
            if (target !== 'current')
                throw Error(
                    'Automatic installed update destinations are not qualified. Use verified setup.',
                );
            const observed = selectDesktopStartup({
                platform: process.platform,
                arch: process.arch,
                packaged: app.isPackaged,
                executable: process.execPath,
                version: app.getVersion(),
                environment: process.env,
                appData: app.getPath('appData'),
                profileOverride: app.getPath('userData'),
            });
            if (observed.delivery !== 'installed' || !observed.currentPath)
                throw Error('The installed application location changed.');
            return observed.currentPath;
        };
        registerHandler('hub:open-update-folder', async (target) =>
            shell.showItemInFolder(await selectedUpdatePath(target)),
        );
        registerHandler('hub:copy-update-path', async (target) =>
            clipboard.writeText(await selectedUpdatePath(target)),
        );
        registerHandler('hub:read-update-report', () => reports.read());
        registerHandler('hub:clear-session-data', () => {
            if (update.active)
                throw new Error('Wait for the update to finish before resetting data.');
            if (connecting || collectionTask || ssh.isCollecting)
                throw new Error('Wait for the current connection or collection to finish.');
            lastSnapshot = null;
            ssh.clearNetworkCache();
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
            if (text.length > 262144)
                throw Error('Clipboard text exceeds the terminal paste limit.');
            return text;
        });
        registerHandler('hub:export', async (importedData) => {
            const snapshot =
                importedData !== undefined ? validateSnapshot(importedData) : lastSnapshot;
            if (!snapshot) throw new Error('Collect a diagnostic snapshot before exporting.');
            const choice = await dialog.showSaveDialog(window, {
                title: 'Export diagnostic evidence',
                defaultPath: `diagnostic-${snapshot.mode}-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`,
                filters: [{ name: 'JSON diagnostic report', extensions: ['json'] }],
            });
            if (choice.canceled || !choice.filePath) return false;
            await writeFile(
                choice.filePath,
                JSON.stringify(createReport(snapshot), null, 2),
                'utf8',
            );
            return true;
        });
        await window.loadURL(appUrl);
    });

    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', (event) => {
        hostVerification.clear();
        ssh.clear();
        if (
            (captureHostPromise || ssh.hasResources || consoleService.hasResources) &&
            !captureShutdownComplete
        ) {
            event.preventDefault();
            captureShutdown ??= Promise.all([
                consoleService
                    .reset()
                    .then(() => ssh.shutdownConsole())
                    .then(() => ssh.joinCleanup())
                    .then(() => consoleService.shutdown()),
                captureHostPromise?.then((host) => host.shutdown()),
            ])
                .then(() => {})
                .catch((error) => console.error('Capture shutdown:', String(error)))
                .finally(() => {
                    captureShutdownComplete = true;
                    app.quit();
                });
        }
    });
}
