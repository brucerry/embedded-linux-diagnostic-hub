import { linuxReviewArguments, runLinuxGuidedReview, finishLinuxReview } from './linux-setup-ui';
import { linuxGuiPrompt, linuxTerminalPrompt } from './linux-setup-prompts';
import { reviewLinuxAppDir, linuxReviewSourceRoot } from './linux-setup-review';
import { physicalFS } from './physical-fs';
import {
    unlinkOwnedFile,
    removeOwnedDirectory,
    assertPlainAncestors,
    ensurePlainDirectory,
} from './setup-paths';
import { matchesSetupSuccessor } from './setup-successor';
import { setupChannel } from './setup-channel';
import type { App, Shell, Dialog } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
const { readFile, writeFile, mkdir, mkdtemp, lstat, realpath } = physicalFS.promises;
import path from 'node:path';
import os from 'node:os';
import {
    SetupTransaction,
    type SetupContext,
    type SetupIntegration,
    type SetupOptions,
} from './setup-transaction';
import { SETUP_UNINSTALLER } from './installation-maintenance';

const product = 'DiagnosticHub';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const ps = (script: string) =>
    execFileSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;' +
                script,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    ).trim();
const digest = async (file: string) =>
    createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
const same = (a: string, b: string) =>
    path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function key(id: string) {
    if (!uuid.test(id)) throw Error('Invalid registration identity.');
    return 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DiagnosticHub-' + id;
}
function identity(pid: number) {
    if (!Number.isInteger(pid) || pid < 1) throw Error('Invalid native process identity.');
    return JSON.parse(
        ps(
            'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public static class SetupWindow{[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);}\';' +
                '$owned=Get-Process -Id ' +
                pid +
                ' -ErrorAction SilentlyContinue;if(!$owned){Write-Output null;exit 0};' +
                '$module=$owned.MainModule;[pscustomobject]@{pid=$owned.Id;executable=$owned.Path;createdAt=$owned.StartTime.ToUniversalTime().ToString("o");handle=$owned.MainWindowHandle.ToInt64();visible=[SetupWindow]::IsWindowVisible($owned.MainWindowHandle);minimized=[SetupWindow]::IsIconic($owned.MainWindowHandle);title=$owned.MainWindowTitle;version=$module.FileVersionInfo.ProductVersion}|ConvertTo-Json -Compress;exit 0',
        ),
    ) as null | {
        pid: number;
        executable: string;
        createdAt: string;
        handle: number;
        visible: boolean;
        minimized: boolean;
        title: string;
        version: string;
    };
}
function readRegistration(id: string) {
    return JSON.parse(
        ps(
            '$owned=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(' +
                quote(key(id)) +
                ');if(!$owned){Write-Output null;exit 0};$values=@{};foreach($name in $owned.GetValueNames()){$values[$name]=[string]$owned.GetValue($name)};$owned.Close();ConvertTo-Json -InputObject $values -Compress;exit 0',
        ),
    ) as Record<string, string> | null;
}
async function currentFile(file: string) {
    try {
        await assertPlainAncestors(file);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
            throw Error('Unsafe owned shortcut.');
        return await digest(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}
function readRequest(text: string) {
    if (Buffer.byteLength(text) > 16384 || /\0/.test(text))
        throw Error('Setup request exceeds its bounds.');
    const fields: Record<string, string> = {};
    let section = false;
    for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (line === '[setup]') {
            if (section) throw Error('Repeated setup section.');
            section = true;
            continue;
        }
        const match = /^([A-Za-z]+)=(.*)$/.exec(line);
        if (!section || !match || fields[match[1]] !== undefined)
            throw Error('Malformed setup request.');
        fields[match[1]] = match[2];
    }
    if (
        Object.keys(fields).some(
            (name) =>
                ![
                    'operation',
                    'root',
                    'token',
                    'consent',
                    'startMenu',
                    'desktop',
                    'launch',
                    'uninstaller',
                ].includes(name),
        )
    )
        throw Error('Unknown setup request field.');
    if (
        ![
            'probe',
            'install',
            'repair',
            'update',
            'rollback',
            'remove',
            'finishremove',
            'launch',
            'finalize',
        ].includes(fields.operation) ||
        !fields.root ||
        fields.root.length > 240
    )
        throw Error('Choose a valid setup operation and location.');
    for (const name of ['consent', 'startMenu', 'desktop', 'launch'])
        if (fields[name] !== undefined && !['0', '1'].includes(fields[name]))
            throw Error('Invalid setup choice.');
    return fields;
}
export async function setupWorkerMain(
    app: App,
    shell: Shell,
    dialog?: Pick<Dialog, 'showMessageBox'>,
): Promise<number> {
    if (process.platform === 'linux') {
        // Separate read-only front door: never parse a Windows channel, start Electron UI,
        // invoke PowerShell, or turn a review into unattended installation.
        const reviewRoot = app.commandLine.getSwitchValue('linux-review-root'),
            installRoot = app.commandLine.getSwitchValue('install-directory');
        if (reviewRoot && installRoot && reviewRoot !== installRoot)
            throw Error('Conflicting Linux review locations.');
        const root = reviewRoot || installRoot;
        if (!root || !process.getuid || !process.geteuid)
            throw Error('Linux setup currently supports only explicit read-only AppDir review.');
        if (app.commandLine.hasSwitch('linux-guided-review')) {
            const args = ['--install-directory', root, '--version', app.getVersion()];
            if (app.commandLine.hasSwitch('menu')) args.push('--menu');
            if (app.commandLine.hasSwitch('no-menu')) args.push('--no-menu');
            if (app.commandLine.hasSwitch('terminal')) args.push('--terminal');
            const requested = app.commandLine.getSwitchValue('operation');
            if (requested) args.push('--operation', requested);
            const choices = linuxReviewArguments(args);
            const host = {
                platform: process.platform,
                arch: process.arch,
                uid: process.getuid(),
                euid: process.geteuid(),
                home: app.getPath('home'),
                appData: app.getPath('appData'),
                sourceRoot: linuxReviewSourceRoot(process.execPath),
                version: app.getVersion(),
            };
            const gui = dialog
                ? linuxGuiPrompt(
                      app,
                      dialog,
                      Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
                  )
                : {
                      review: async () => ({ status: 'unavailable' as const }),
                      hasPending: () => false,
                  };
            const terminal = linuxTerminalPrompt();
            const result = await runLinuxGuidedReview(
                host,
                choices,
                process.env.XDG_DATA_HOME || path.posix.join(host.home, '.local/share'),
                {
                    inspect: (location) => reviewLinuxAppDir(host, location),
                    gui,
                    terminal,
                    now: () => performance.now(),
                    newId: randomUUID,
                },
            );
            return finishLinuxReview(result, {
                write: (text) => {
                    console.log(text.trimEnd());
                },
                hasPending: () => gui.hasPending() || terminal.hasPending(),
                hold: () => {
                    setInterval(() => {}, 60000);
                    return new Promise<never>(() => {});
                },
            });
        }
        const review = await reviewLinuxAppDir(
            {
                platform: process.platform,
                arch: process.arch,
                uid: process.getuid(),
                euid: process.geteuid(),
                home: app.getPath('home'),
                appData: app.getPath('appData'),
                sourceRoot: linuxReviewSourceRoot(process.execPath),
                version: app.getVersion(),
            },
            root,
        );
        const result = JSON.stringify(review);
        if (Buffer.byteLength(result) > 8192) throw Error('Linux review result exceeds its bound.');
        console.log(result);
        return 0;
    }
    const requestPath = app.commandLine.getSwitchValue('request'),
        responsePath = app.commandLine.getSwitchValue('response');
    const channel = await setupChannel(requestPath, responsePath);
    const request = readRequest(channel.request);
    const respond = channel.write;
    try {
        if (process.platform !== 'win32' || process.arch !== 'x64')
            throw Error('This setup requires Windows x64.');
        const elevated = ps(
            '$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent());$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
        );
        if (elevated.toLowerCase() !== 'false')
            throw Error('Run setup as your ordinary user, without administrator elevation.');
        const appData = await realpath(app.getPath('appData')),
            home = await realpath(app.getPath('home')),
            desktop = app.getPath('desktop');
        await assertPlainAncestors(path.join(path.dirname(requestPath), 'worker-state-'));
        const scratch = await mkdtemp(path.join(path.dirname(requestPath), 'worker-state-'));
        if (!['probe', 'launch'].includes(request.operation)) {
            // Use the already-qualified native per-profile singleton for per-root setup serialization.
            // This setup-only namespace never reuses a normal app/report profile.
            const lockKey = createHash('sha256')
                .update(path.resolve(request.root).toLowerCase())
                .digest('hex');
            const lockProfile = path.join(appData, 'DiagnosticHub', 'setup-locks', lockKey);
            await ensurePlainDirectory(lockProfile);
            app.setPath('userData', lockProfile);
            if (!app.requestSingleInstanceLock())
                throw Error('Another setup worker is using this installation.');
        } else app.setPath('userData', scratch);
        app.setPath('sessionData', scratch);
        await app.whenReady();
        const warnings: string[] = [];
        const shortcuts = (id: string) => ({
            startMenu: path.join(
                appData,
                'Microsoft',
                'Windows',
                'Start Menu',
                'Programs',
                'Diagnostic Hub',
                'Diagnostic Hub (' + id.slice(0, 8) + ').lnk',
            ),
            desktop: path.join(desktop, 'Diagnostic Hub (' + id.slice(0, 8) + ').lnk'),
        });
        const validateIntegration = (root: string, id: string, item: SetupIntegration) => {
            const locations = shortcuts(id);
            if (item.kind === 'shortcut') {
                if (
                    ![locations.startMenu, locations.desktop].some((file) =>
                        same(file, item.path),
                    ) ||
                    !item.sha256 ||
                    !/^\w{64}$/.test(item.sha256)
                )
                    throw Error('Shortcut ownership is invalid.');
            } else if (item.kind === 'registry') {
                if (item.path !== key(id) || !item.values || item.values.InstallLocation !== root)
                    throw Error('Registration ownership is invalid.');
            } else throw Error('Unknown owned integration.');
        };
        const removeIntegrations: SetupContext['removeIntegrations'] = async (
            root,
            id,
            records,
        ) => {
            for (const item of records) {
                validateIntegration(root, id, item);
                if (item.kind === 'shortcut') {
                    const hash = await currentFile(item.path);
                    if (hash === item.sha256) await unlinkOwnedFile(item.path);
                    else if (hash) warnings.push('A customized shortcut was retained.');
                } else {
                    const current = readRegistration(id);
                    if (
                        current &&
                        Object.keys(current).length === Object.keys(item.values!).length &&
                        Object.entries(item.values!).every(
                            ([name, value]) => current[name] === value,
                        )
                    )
                        ps(
                            '[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey(' +
                                quote(key(id)) +
                                ',$false);exit 0',
                        );
                    else if (current)
                        warnings.push('Modified uninstall registration was retained.');
                }
            }
            try {
                await removeOwnedDirectory(path.dirname(shortcuts(id).startMenu));
            } catch (error) {
                if (
                    !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
                        (error as NodeJS.ErrnoException).code ?? '',
                    )
                )
                    throw error;
            }
        };
        const context: SetupContext = {
            sourceRoot: path.dirname(process.execPath),
            home,
            appData,
            version: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            busy: async (root) => {
                const items = JSON.parse(
                    ps(
                        '$owned=@(Get-CimInstance Win32_Process -Filter ' +
                            quote("Name='Diagnostic Hub.exe'") +
                            ' | Select-Object ProcessId,ExecutablePath);ConvertTo-Json -InputObject $owned -Compress;exit 0',
                    ),
                ) as { ProcessId: number; ExecutablePath: string | null }[];
                if (items.some((item) => !item.ExecutablePath))
                    throw Error(
                        'A Diagnostic Hub process cannot be inspected; close it before setup.',
                    );
                return items.some((item) =>
                    same(item.ExecutablePath!, path.join(root, 'Diagnostic Hub.exe')),
                );
            },
            ownerAlive: async (owner) => {
                const current = identity(owner.pid);
                return Boolean(
                    current &&
                    same(current.executable, owner.executable) &&
                    current.createdAt === owner.createdAt,
                );
            },
            processIdentity: async () => {
                const current = identity(process.pid);
                if (!current) throw Error('Cannot attest setup process.');
                return current;
            },
            successorObserved: async (root, expected, version) =>
                matchesSetupSuccessor(root, expected, version, identity(expected.pid)),
            launch: async (root) => {
                const environment = { ...process.env };
                for (const name of [
                    'ELECTRON_RUN_AS_NODE',
                    'PORTABLE_EXECUTABLE_FILE',
                    'PORTABLE_EXECUTABLE_DIR',
                    'PORTABLE_EXECUTABLE_APP_FILENAME',
                ])
                    delete environment[name];
                const launched = spawn(path.join(root, 'Diagnostic Hub.exe'), [], {
                    cwd: root,
                    env: environment,
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: false,
                });
                await new Promise<void>((resolve, reject) => {
                    launched.once('spawn', resolve);
                    launched.once('error', reject);
                });
                launched.unref();
            },
            validateIntegrations: (root, id, records) => {
                for (const item of records) validateIntegration(root, id, item);
            },
            removeIntegrations,
            integrate: async (root, id, version, selected, previous, save) => {
                for (const item of previous) validateIntegration(root, id, item);
                const owned: SetupIntegration[] = [],
                    locations = shortcuts(id);
                for (const name of ['startMenu', 'desktop'] as const) {
                    const filename = locations[name],
                        prior = previous.find(
                            (item) => item.kind === 'shortcut' && same(item.path, filename),
                        );
                    if (!selected[name] && !prior) continue;
                    const current = await currentFile(filename);
                    if (!selected[name]) {
                        if (prior && current === prior.sha256) await unlinkOwnedFile(filename);
                        else if (current && prior) {
                            owned.push(prior);
                            warnings.push('A customized shortcut was retained.');
                        }
                        continue;
                    }
                    if (current && (!prior || prior.sha256 !== current)) {
                        if (prior) owned.push(prior);
                        warnings.push('An existing customized shortcut was retained.');
                        continue;
                    }
                    await ensurePlainDirectory(path.dirname(filename));
                    await assertPlainAncestors(filename);
                    if (
                        !shell.writeShortcutLink(filename, current ? 'update' : 'create', {
                            target: path.join(root, 'Diagnostic Hub.exe'),
                            cwd: root,
                            description: 'Embedded Linux diagnostics',
                            icon: path.join(root, 'Diagnostic Hub.exe'),
                            appUserModelId: 'dev.diagnostichub.desktop',
                        })
                    )
                        throw Error('Could not create the selected user shortcut.');
                    owned.push({
                        kind: 'shortcut',
                        path: filename,
                        sha256: await digest(filename),
                    });
                    await save([...owned]);
                }
                const existing = readRegistration(id);
                if (existing && existing.InstallLocation !== root)
                    throw Error('The user uninstall registration belongs to a different location.');
                const values = {
                    DisplayName: 'Diagnostic Hub ' + version + ' (' + id.slice(0, 8) + ')',
                    DisplayVersion: version,
                    Publisher: 'Diagnostic Hub contributors',
                    InstallLocation: root,
                    DisplayIcon: path.join(root, 'Diagnostic Hub.exe'),
                    UninstallString:
                        '"' + path.join(root, SETUP_UNINSTALLER) + '" /ROOT="' + root + '"',
                    NoModify: '1',
                    NoRepair: '1',
                };
                ps(
                    '$owned=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(' +
                        quote(key(id)) +
                        ');' +
                        Object.entries(values)
                            .map(
                                ([name, value]) =>
                                    '$owned.SetValue(' +
                                    quote(name) +
                                    ',' +
                                    quote(value) +
                                    ',[Microsoft.Win32.RegistryValueKind]::String);',
                            )
                            .join('') +
                        '$owned.Close();exit 0',
                );
                owned.push({ kind: 'registry', path: key(id), values });
                await save([...owned]);
                return owned;
            },
        };
        const engine = new SetupTransaction(context);
        if (request.operation === 'probe') {
            const probe = await engine.probe(request.root);
            await respond({
                ok: 1,
                ...probe,
                actions: probe.actions.join(','),
                ...Object.fromEntries(
                    [
                        'install',
                        'launch',
                        'repair',
                        'update',
                        'rollback',
                        'finalize',
                        'finishremove',
                    ].map((action) => ['can' + action, Number(probe.actions.includes(action))]),
                ),
                startMenu: Number(probe.options.startMenu),
                desktop: Number(probe.options.desktop),
                launch: 0,
                message:
                    probe.state === 'recovery'
                        ? 'A previous setup needs confirmation or recovery.'
                        : probe.installedVersion
                          ? 'Existing install ' + probe.installedVersion
                          : 'Ready for a new current-user installation.',
            });
            return 0;
        }
        let result: Record<string, unknown>;
        if (['install', 'repair', 'update'].includes(request.operation))
            result = await engine.install(
                request.root,
                request.operation as 'install' | 'repair' | 'update',
                {
                    startMenu: request.startMenu === '1',
                    desktop: request.desktop === '1',
                    launch: request.launch === '1',
                },
                request.token ?? '',
                request.consent === '1',
                request.uninstaller ?? '',
            );
        else if (request.operation === 'rollback')
            result = await engine.rollback(
                request.root,
                request.token ?? '',
                request.consent === '1',
            );
        else if (['remove', 'finishremove'].includes(request.operation))
            result = await engine.remove(
                request.root,
                request.token ?? '',
                request.consent === '1',
            );
        else if (request.operation === 'finalize') result = await engine.finalize(request.root);
        else result = await engine.launch(request.root);
        if (request.launch === '1' && ['install', 'repair', 'update'].includes(request.operation)) {
            await engine.launch(request.root);
            result.launchRequested = true;
            const deadline = Date.now() + 20000;
            let confirmed = false;
            while (Date.now() < deadline) {
                try {
                    const completion = await engine.finalize(request.root);
                    if (completion.confirmed) {
                        confirmed = true;
                        break;
                    }
                } catch {
                    /* Native UI acknowledgement may still be pending. */
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            result.successorObserved = confirmed;
            if (!confirmed)
                warnings.push(
                    'Launch was requested; the new native window has not yet been confirmed. Recovery copy was retained.',
                );
        }
        await respond({
            ok: 1,
            ...result,
            message: ['remove', 'finishremove'].includes(request.operation)
                ? 'Application removed. Settings and reports retained.'
                : 'Operation completed.',
            warnings: warnings.join(' '),
        });
        return 0;
    } catch (error) {
        await respond({ ok: 0, message: error instanceof Error ? error.message : String(error) });
        return 1;
    }
}
