import { DesktopConnectionAttempts } from './connection-attempts';
import {
    createQuitController,
    quitAllowsIpc,
    runQuitCleanup,
    settleConnectionAttempt,
} from '../shared/quit-cleanup';
import { trustedFrameHandler, trustedFrameReadyHandler } from './trusted-ipc';
import { NativeCaptureHost } from './capture-host';
import { NativeConsoleService } from './console-service';
import { NativeReportExports } from './report-export';
import * as reportFileSystem from 'node:fs/promises';
import { storageError } from '../shared/capture-store';
import { consoleRpcRequest } from '../shared/console-rpc';
import { setupWorkerMain } from './setup-worker';
import { acknowledgeSetupBoot } from './installation-maintenance';
import { observeLinuxSetupReadiness } from './linux-setup-readiness';
import {
    createLinuxNativeSetupReadback,
    LINUX_SETUP_READBACK_ENV,
    LINUX_SETUP_QUIT_ENV,
} from './linux-setup-readback-native';
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
import { validateSnapshot } from '../shared/report';
import type { Snapshot } from '../shared/types';
import type { TerminalOpen } from '../shared/terminal';
import { UpdateOwnership, updateErrors } from './update-ownership';
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

import { createLaunchTimingRecorder, type LaunchTimingSnapshot } from '../shared/launch-timing';

// This origin is AFTER all static imports, not process creation or launcher start.
const launchTiming =
    process.env.HUB_LAUNCH_TIMING === '1' && !process.argv.includes('--diagnostic-hub-setup-worker')
        ? createLaunchTimingRecorder('main-module-body', () => performance.now())
        : undefined;
if (launchTiming) {
    (
        globalThis as typeof globalThis & {
            __hubLaunchTiming?: () => LaunchTimingSnapshot;
        }
    ).__hubLaunchTiming = launchTiming.snapshot;
    launchTiming.mark('main-module-body');
}

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
    let linuxSetupReadback: ReturnType<typeof createLinuxNativeSetupReadback> | null = null;
    try {
        launchTiming?.mark('main-startup-selection-start');
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
        launchTiming?.mark('main-startup-selection-returned');
        const profile = canonicalProfilePath(startup.profilePath || app.getPath('userData'));
        app.setPath('userData', profile);
        app.setPath('sessionData', profile);
        ownsProfile = app.requestSingleInstanceLock();
        launchTiming?.mark('main-profile-lock-returned');
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
    // Own an opted-in inherited channel before quit registration or readiness/window awaits.
    linuxSetupReadback = createLinuxNativeSetupReadback(
        {
            enabled:
                ownsProfile &&
                process.platform === 'linux' &&
                startup.installation?.manifest.layout === 'linux-folder' &&
                app.isPackaged &&
                process.env[LINUX_SETUP_READBACK_ENV] === '1',
            platform: process.platform,
            layout: startup.installation?.manifest.layout,
            packaged: app.isPackaged,
            uid: process.getuid?.() ?? -1,
            euid: process.geteuid?.() ?? -1,
            cooperativeQuit: process.env[LINUX_SETUP_QUIT_ENV] === '1',
        },
        undefined,
        () => {
            app.quit();
        },
    );
    app.on('second-instance', () => {
        if (window && !window.isDestroyed()) {
            if (window.isMinimized()) window.restore();
            window.focus();
        }
    });

    if (process.platform === 'win32') app.setAppUserModelId('dev.diagnostichub.desktop');
    if (process.platform === 'linux') app.setDesktopName(LINUX_DESKTOP_NAME);
    let keyPath: string | null = null;
    let lastSnapshot: Snapshot | null = null;
    let collectionTask: Promise<Snapshot> | null = null;
    const hostVerification = new HostVerification((request) => {
        if (window && !window.isDestroyed())
            window.webContents.send('hub:verify-host-key', request);
    });
    const ssh = new DeviceMonitor(() => {
        if (window && !window.isDestroyed()) window.webContents.send('hub:disconnected');
    });
    const connectionAttempts = new DesktopConnectionAttempts(ssh);

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
    let quitConnectionFailure: ConnectionFailure | null = null;
    const reportExports = new NativeReportExports({
        fs: reportFileSystem,
        random: randomUUID,
        choose: (filename) =>
            dialog.showSaveDialog(window, {
                title: 'Export diagnostic evidence',
                defaultPath: filename,
                filters: [{ name: 'JSON diagnostic report', extensions: ['json'] }],
            }),
        notify: (status) => {
            if (window && !window.isDestroyed())
                window.webContents.send('hub:report-export-status', status);
        },
    });
    const updateOwnership = new UpdateOwnership(() => {
        const message = updateOwnership.describe();
        if (message && window && !window.isDestroyed())
            window.webContents.send('hub:update-progress', { stage: 'failed', message });
    });
    const quit = createQuitController(
        (snapshot: {
            connection: typeof connectionAttempts.snapshot;
            capture: typeof captureHostPromise;
        }) =>
            runQuitCleanup({
                joinUpdate: () => updateOwnership.shutdown(),
                cancelConnection: () => snapshot.connection?.controller.abort(),
                clearHostVerification: () => hostVerification.clear(),
                disconnect: () => ssh.clear(),
                prepareConsole: () => consoleService.prepareShutdown(),
                joinConnection: async () => {
                    quitConnectionFailure = await settleConnectionAttempt(
                        snapshot.connection?.done,
                    );
                },
                joinSsh: () => ssh.joinCleanup(),
                finishConsole: () => consoleService.finishShutdown(),
                shutdownCapture: async () => {
                    const host = await snapshot.capture;
                    await host?.shutdown();
                },
                shutdownReports: () => reportExports.shutdown(),
                shutdownLinuxSetupReadback: async () => {
                    await linuxSetupReadback?.joinClosure();
                },
            }),
    );
    const assertNotQuitting = () => {
        if (quit.phase !== 'idle') throw Error('Diagnostic Hub is shutting down.');
    };
    const reportBlockedQuit = (error: unknown) => {
        // Reporting cannot authorize quit or replace the retained controller outcome.
        try {
            console.error('Quit cleanup blocked:', error);
        } catch {}
        try {
            dialog.showErrorBox(
                'Diagnostic Hub could not finish quitting',
                'Cleanup did not complete successfully. The application remains running ' +
                    'to preserve resources whose closure was not confirmed.',
            );
        } catch {}
    };
    let captureRendererEpoch = 0;
    const captureHost = () => {
        assertNotQuitting();
        return (captureHostPromise ??= NativeCaptureHost.open(
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
    };
    const resetCaptureRenderer = () => {
        if (quit.phase !== 'idle') return;
        captureRendererEpoch++;
        void consoleService
            .reset()
            .catch((error) => console.error('Console reader cleanup:', String(error)));
        void captureHostPromise
            ?.then((host) => host.reset())
            .catch((error) => console.error('Capture cleanup:', String(error)));
    };

    function registerHandler(
        name: string,
        handler: (...args: unknown[]) => unknown,
        operation?: (input: unknown) => string,
    ) {
        ipcMain.handle(
            name,
            trustedFrameHandler(
                () => window,
                appUrl,
                (...args) => {
                    if (quit.phase !== 'idle' && !quitAllowsIpc(name, operation?.(args[0])))
                        assertNotQuitting();
                    return handler(...args);
                },
            ),
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

    launchTiming?.mark('main-ready-handler-registration');
    app.whenReady().then(async () => {
        launchTiming?.mark('main-ready-callback');
        if (!ownsProfile || quit.phase !== 'idle') return;
        const updater = new ReleaseUpdater(
            app.getVersion(),
            path.join(app.getPath('userData'), 'updates'),
            process.platform,
            process.arch,
            app.isPackaged,
            undefined,
            startup.delivery,
            updateOwnership,
        );
        const reports = new UpdateReports(
            path.join(app.getPath('userData'), 'update-reports'),
            updateOwnership,
        );
        const receipts = new UpdateReceipts(
            path.join(app.getPath('userData'), 'updates'),
            process.platform,
            updateOwnership,
        );
        const runningExecutable = startup.currentPath;
        let serial: ReturnType<typeof configureSerial>;
        let activity: AutomationActivity | undefined;
        const update = new UpdateCoordinator(updater, reports, {
            isConnecting: () => connectionAttempts.busy,
            isReportExporting: () => Boolean(reportExports.retainedAttempt),
            quiesceSerial: async () => {
                const drainage = updateOwnership.hold('Serial and console update drain', serial);
                try {
                    activity?.interrupt('Update started. Arm explicitly after reconnecting.');
                    ssh.clearAutomationStream();
                    await serial.quiesce();
                    await consoleService.reset();
                    await ssh.shutdownConsole();
                    drainage.acknowledge();
                } catch (error) {
                    drainage.blocked(error);
                    throw error;
                }
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
            progress: (message) => {
                const blocked = updateOwnership.describe();
                // Losing a renderer cannot interrupt native unwind or custody.
                try {
                    window.webContents.send(
                        'hub:update-progress',
                        blocked ? { stage: 'failed', message: blocked } : message,
                    );
                } catch {}
            },
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
                    const cleanup: unknown[] = [];
                    try {
                        await receipts.write({ ...info, state: 'restart-failed' });
                    } catch (receiptError) {
                        cleanup.push(receiptError);
                    }
                    updateErrors({ failed: true, error }, cleanup);
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
        launchTiming?.mark('main-window-construction-start');
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
                    ...(launchTiming ? { additionalArguments: ['--hub-launch-timing'] } : {}),
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
        launchTiming?.mark('main-window-construction-returned');

        if (launchTiming) {
            // show defaults to true; the initial show may precede this listener.
            // This is a main-process visibility observation, not compositor proof.
            if (window.isVisible()) launchTiming.mark('main-window-visible-observed');
            else window.once('show', () => launchTiming.mark('main-window-visible-observed'));
            window.once('ready-to-show', () => launchTiming.mark('main-ready-to-show'));
        }
        activity = new AutomationActivity(
            (enabled) => {
                if (!window.isDestroyed()) window.webContents.setBackgroundThrottling(enabled);
            },
            (reason) => {
                if (!window.isDestroyed())
                    window.webContents.send('hub:automation-interrupted', reason);
            },
            () => update.active || updateOwnership.active,
        );
        ipcMain.handle(
            'hub:capture',
            trustedFrameReadyHandler(
                () => window,
                appUrl,
                () => captureRendererEpoch,
                captureHost,
                (host, request) => {
                    assertNotQuitting();
                    return host.dispatch(request);
                },
            ),
        );
        registerHandler('hub:automation-activity-acquire', () => activity!.acquire());
        registerHandler('hub:automation-activity-release', (id) => activity!.release(id));
        powerMonitor.on('suspend', () => {
            activity!.suspend();
            if (quit.phase === 'idle') ssh.clearAutomationStream();
        });
        powerMonitor.on('resume', () => activity!.resume());
        window.webContents.on('render-process-gone', () => {
            resetCaptureRenderer();
            activity!.clear();
            if (quit.phase === 'idle') ssh.clear();
        });
        window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
            if (isMainFrame && quit.phase === 'idle') {
                ssh.clearAutomationStream();
                activity!.clear();
                resetCaptureRenderer();
            }
        });
        window.on('closed', () => {
            activity!.clear();
            if (quit.phase === 'idle') {
                ssh.clearAutomationStream();
                resetCaptureRenderer();
            }
        });
        serial = configureSerial(window, appUrl, () => update.active || updateOwnership.active);
        registerHandler('hub:serial-select', (id, portId) => serial.select(id, portId));
        registerHandler('hub:serial-cleanup-ack', (id) => serial.acknowledge(id));
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event, url) => {
            if (url !== appUrl) event.preventDefault();
        });
        window.on('restore', () => window.webContents.send('hub:window-restored'));
        window.on('closed', () => {
            if (quit.phase === 'idle') {
                hostVerification.clear();
                ssh.clear();
            }
        });
        registerHandler('hub:confirm-host-key', (id, accepted) =>
            hostVerification.confirm(id, accepted),
        );
        registerHandler('hub:connect', async (input, requestedId) => {
            let id = '';
            let credentials: ReturnType<typeof validateConnection> | undefined;
            try {
                if (update.active || updateOwnership.active)
                    throw new ConnectionFailure(
                        'policy',
                        'An update is in progress. SSH remains disconnected.',
                    );
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
                credentials = options;
                await connectionAttempts.connect(id, async (signal) => {
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
                        if (signal.aborted)
                            throw new ConnectionFailure('cancelled', 'Connection cancelled.');
                        await ssh.configure(
                            options,
                            (key) => verifyHost(`${options.host}:${options.port}`, key, signal),
                            privateKey,
                            signal,
                        );
                    } finally {
                        privateKey?.fill(0);
                        options.password = undefined;
                        options.passphrase = undefined;
                        hostVerification.clear();
                    }
                });
                return { ok: true, connection: ssh.automationConnection };
            } catch (error) {
                const failure = connectionFailure(error);
                return { ok: false, code: failure.code, message: failure.message };
            } finally {
                if (credentials) {
                    credentials.password = undefined;
                    credentials.passphrase = undefined;
                }
            }
        });
        registerHandler('hub:cancel-connect', async (input) => {
            const id = connectionAttemptId(input);
            if (connectionAttempts.snapshot?.id === id) hostVerification.clear();
            await connectionAttempts.cancel(id);
        });
        registerHandler('hub:disconnect', async () => {
            if (connectionAttempts.busy || ssh.isCollecting)
                throw new Error('Wait for the current connection or collection to finish.');
            ssh.clear();
        });
        registerHandler('hub:terminal-open', (request) => {
            if (update.active || updateOwnership.active || connectionAttempts.busy)
                throw Error('Wait for the current connection or update to finish.');
            return ssh.openTerminal(request as TerminalOpen, (event) => {
                if (!window.isDestroyed()) window.webContents.send('hub:terminal-event', event);
            });
        });
        registerHandler('hub:terminal-input', (id, data) => {
            if (update.active || updateOwnership.active || connectionAttempts.busy)
                throw Error('Terminal input is paused for the connection or update.');
            return ssh.getTerminal(id).write(data);
        });
        registerHandler('hub:terminal-resize', (id, size) => ssh.getTerminal(id).resize(size));
        registerHandler('hub:terminal-ack', (id, sequence) =>
            ssh.getTerminal(id).acknowledge(sequence),
        );
        registerHandler('hub:terminal-close', (id) => ssh.getTerminal(id).close());
        registerHandler('hub:automation-run', (request) => {
            if (update.active || updateOwnership.active || connectionAttempts.busy)
                throw Error('Automation is paused for the connection or update.');
            return ssh.runAutomation(request as import('../shared/automation').AutomationRequest);
        });
        registerHandler(
            'hub:automation-stream',
            (request) => {
                const checked = streamRequest(request);
                if (
                    checked.action === 'start' &&
                    (connectionAttempts.busy || update.active || updateOwnership.active)
                )
                    throw Error('Automation is paused for the connection or update.');
                return ssh.automationStream(checked);
            },
            (input) => streamRequest(input).action,
        );
        registerHandler(
            'hub:automation-console',
            (request) => {
                const checked = consoleRpcRequest(request);
                if (
                    ['open', 'step'].includes(checked.action) &&
                    (connectionAttempts.busy || update.active || updateOwnership.active)
                )
                    throw Error('Automation is paused for the connection or update.');
                return ssh.automationConsole(checked, consoleService.createWriter);
            },
            (input) => consoleRpcRequest(input).action,
        );
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
            if (update.active || updateOwnership.active || connectionAttempts.busy)
                throw Error('Wait for the current connection or update to finish.');
            return ssh.readClock();
        });
        registerHandler('hub:collect', async (options) => {
            if (update.active || updateOwnership.active)
                throw new Error('Live collection is paused for the update.');
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
            if (update.active || updateOwnership.exclusive)
                throw new Error('An update is already in progress.');
            return updateOwnership.observe(() => updater.check(includePrereleases as boolean));
        });
        registerHandler('hub:start-update', async (request) => {
            if (update.active || updateOwnership.active)
                throw Error('An update is already in progress.');
            try {
                return await updateOwnership.start(() => update.start(request));
            } finally {
                if (!updateOwnership.held) serial.release();
            }
        });
        registerHandler('hub:read-update-info', async () => {
            const observeCurrentLinuxReadiness = async () =>
                process.platform === 'linux' &&
                startup.installation?.manifest.layout === 'linux-folder' &&
                startup.profilePath
                    ? await observeLinuxSetupReadiness(
                          {
                              platform: process.platform,
                              arch: process.arch,
                              layout: startup.installation.manifest.layout,
                              packaged: app.isPackaged,
                              root: startup.installation.root,
                              installationId: startup.installation.record.installationId,
                              manifestSHA256: startup.installation.record.manifestSHA256,
                              version: app.getVersion(),
                              profile: startup.profilePath,
                              executable: process.execPath,
                              pid: process.pid,
                              uid: process.getuid?.() ?? -1,
                              euid: process.geteuid?.() ?? -1,
                              processCreationMs: process.getCreationTime(),
                              appUrl,
                          },
                          () => {
                              if (window.isDestroyed() || window.webContents.isDestroyed())
                                  return null;
                              return {
                                  window,
                                  contents: window.webContents,
                                  frame: window.webContents.mainFrame,
                                  frameUrl: window.webContents.mainFrame.url,
                                  electronId: window.id,
                                  nativeHandle: window.getNativeWindowHandle(),
                                  visible: window.isVisible(),
                                  minimized: window.isMinimized(),
                                  loading: window.webContents.isLoadingMainFrame(),
                                  profile: app.getPath('userData'),
                                  ownsProfile,
                                  quitting: quit.phase !== 'idle',
                                  nowMs: Date.now(),
                                  generation: captureRendererEpoch,
                              };
                          },
                      )
                    : null;
            const linuxSetupReadiness = await observeCurrentLinuxReadiness();
            linuxSetupReadback?.offer(linuxSetupReadiness, observeCurrentLinuxReadiness);
            if (
                process.platform !== 'linux' &&
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
                          ...(process.platform === 'linux' ? { linuxSetupReadiness } : {}),
                      },
                  }
                : updateOwnership.observe(() => receipts.info(app.getVersion(), runningExecutable));
        });
        const selectedUpdatePath = async (target: unknown) => {
            if (startup.delivery !== 'installed')
                return updateOwnership.observe(() =>
                    receipts.selectedPath(target, runningExecutable),
                );
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
        registerHandler('hub:read-update-report', () =>
            updateOwnership.observe(() => reports.read()),
        );
        registerHandler('hub:clear-session-data', () => {
            if (update.active || updateOwnership.active)
                throw new Error('Wait for the update to finish before resetting data.');
            if (connectionAttempts.busy || collectionTask || ssh.isCollecting)
                throw new Error('Wait for the current connection or collection to finish.');
            lastSnapshot = null;
            ssh.clearNetworkCache();
        });
        registerHandler('hub:acknowledge-update-report', (id) => {
            if (typeof id !== 'string') throw new Error('Invalid saved update report.');
            return updateOwnership.observe(() => reports.acknowledge(id));
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
        registerHandler('hub:cancel-report-export', (id) => {
            if (typeof id !== 'string') throw Error('Invalid report export identity.');
            reportExports.cancel(id);
        });
        registerHandler('hub:report-export-status', () => reportExports.status());
        registerHandler('hub:export', (importedData, id) => {
            if (update.active || updateOwnership.active)
                throw Error('Wait for the update to finish before exporting a report.');
            const snapshot =
                importedData !== undefined ? validateSnapshot(importedData) : lastSnapshot;
            if (!snapshot) throw new Error('Collect a diagnostic snapshot before exporting.');
            if (typeof id !== 'string') throw Error('Invalid report export identity.');
            return reportExports.start(id, snapshot);
        });
        launchTiming?.mark('main-load-url-start');
        await window.loadURL(appUrl);
        launchTiming?.mark('main-load-url-resolved');
    });

    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', (event) => {
        if (quit.phase === 'ready') return;
        event.preventDefault();
        if (quit.phase !== 'idle') return;
        const snapshot = { connection: connectionAttempts.snapshot, capture: captureHostPromise };
        // Invalidate privileged capture calls already waiting for initialization.
        captureRendererEpoch++;
        void quit.begin(snapshot).then((outcome) => {
            if (quitConnectionFailure) {
                // Keep the original operation error; only ownership joins establish closure.
                try {
                    console.warn('Connection attempt ended before quit:', quitConnectionFailure);
                } catch {}
            }
            if (outcome.status === 'ready') app.quit();
            else reportBlockedQuit(outcome.error);
        });
    });
}
