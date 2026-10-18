import assert from 'node:assert/strict';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
    readFile,
    writeFile,
    mkdir,
    readdir,
    lstat,
    realpath,
    symlink,
    access,
} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {
    INSTALLATION_RECORD,
    INSTALLATION_MANIFEST,
    INSTALLATION_PRODUCT,
    validateInstallationManifest,
} from '../shared/installation';

async function main() {
    assert.equal(
        process.platform,
        'win32',
        'Run the packaged profile/lock qualification on native Windows.',
    );
    const ownedRoot = path.resolve(process.env.HUB_INSTALLATION_TEST_ROOT ?? '');
    assert.ok(process.env.HUB_INSTALLATION_TEST_ROOT && path.isAbsolute(ownedRoot));
    const bundle = path.join(ownedRoot, 'package', 'win-unpacked');
    const executable = path.join(bundle, 'Diagnostic Hub.exe');
    const portableExecutable = path.join(ownedRoot, 'package', 'Diagnostic-Hub.exe');
    const portableTemp = path.join(ownedRoot, 'portable extraction');
    assert.equal(await realpath(ownedRoot), ownedRoot, 'Fixture root must be canonical');
    await access(portableExecutable);
    await mkdir(portableTemp);
    const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    const profiles = path.join(ownedRoot, 'profiles', randomUUID());
    const primaryProfile = path.join(profiles, 'primary profile');
    const otherProfile = path.join(profiles, 'other profile');
    const portableProfile = path.join(profiles, 'portable profile');
    const alias = path.join(profiles, 'primary alias');
    await access(executable);
    await mkdir(primaryProfile, { recursive: true });
    await mkdir(otherProfile);
    await symlink(primaryProfile, alias, 'junction');
    const marker = path.join(primaryProfile, 'preservation-marker.json');
    const markerBytes = JSON.stringify({ test: 'private profile', id: randomUUID() });
    await writeFile(marker, markerBytes);
    const payload: { kind: 'file'; path: string; bytes: number; sha256: string }[] = [];
    async function inventory(directory: string) {
        for (const name of (await readdir(directory)).sort()) {
            if (name === INSTALLATION_RECORD || name === INSTALLATION_MANIFEST) continue;
            const file = path.join(directory, name);
            const stat = await lstat(file);
            assert.equal(
                stat.isSymbolicLink(),
                false,
                'Windows fixture must contain regular payload paths',
            );
            if (stat.isDirectory()) await inventory(file);
            else {
                assert.equal(stat.isFile(), true);
                payload.push({
                    kind: 'file',
                    path: path.relative(bundle, file).split(path.sep).join('/'),
                    bytes: stat.size,
                    sha256: hash(await readFile(file)),
                });
            }
        }
    }
    await inventory(bundle);
    const release = validateInstallationManifest({
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        layout: 'windows-nsis',
        platform: 'win32',
        arch: 'x64',
        version,
        sourceCommit: source,
        entryPoint: 'Diagnostic Hub.exe',
        files: payload,
    });
    const manifestBytes = JSON.stringify(release);
    const record = {
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        installationId: randomUUID(),
        manifestSHA256: hash(manifestBytes),
        profile: 'dedicated',
    };
    await writeFile(path.join(bundle, INSTALLATION_MANIFEST), manifestBytes, { flag: 'wx' });
    await writeFile(path.join(bundle, INSTALLATION_RECORD), JSON.stringify(record), { flag: 'wx' });
    await writeFile(
        path.join(ownedRoot, 'fixture-provenance.json'),
        JSON.stringify(
            {
                source,
                version,
                bundle,
                executable,
                payloadFiles: payload.length,
                manifestSHA256: record.manifestSHA256,
                asarSHA256: hash(await readFile(path.join(bundle, 'resources', 'app.asar'))),
                privateFixture: true,
                publishedAssetsModified: false,
            },
            null,
            2,
        ),
    );

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const ps = (command: string) =>
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 15000,
        }).trim();
    const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
    const children: ChildProcess[] = [];
    const identities = new Map<number, { created: string; path: string }>();
    const browsers: Browser[] = [];
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
                entry[1] !== undefined &&
                ![
                    'ELECTRON_RUN_AS_NODE',
                    'PORTABLE_EXECUTABLE_FILE',
                    'PORTABLE_EXECUTABLE_DIR',
                    'PORTABLE_EXECUTABLE_APP_FILENAME',
                ].includes(entry[0]),
        ),
    );
    function native(pid: number, expectedPath = executable) {
        assert.ok(
            path
                .resolve(expectedPath)
                .toLowerCase()
                .startsWith(ownedRoot.toLowerCase() + path.sep),
        );
        const observation = JSON.parse(
            ps(
                'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public static class InstallationWindow{[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);}\';' +
                    '$target=Get-Process -Id ' +
                    pid +
                    ' -ErrorAction Stop;if($target.Path -ne ' +
                    quote(expectedPath) +
                    "){throw 'Native process path mismatch'};" +
                    '$command=(Get-CimInstance Win32_Process -Filter ' +
                    quote('ProcessId=' + pid) +
                    ').CommandLine;' +
                    '$handle=$target.MainWindowHandle;[pscustomobject]@{pid=$target.Id;path=$target.Path;commandLine=$command;created=$target.StartTime.ToUniversalTime().ToString("o");observedAt=[DateTime]::UtcNow.ToString("o");handle=$handle.ToInt64();visible=[InstallationWindow]::IsWindowVisible($handle);minimized=[InstallationWindow]::IsIconic($handle)}|ConvertTo-Json -Compress',
            ),
        );
        const previous = identities.get(pid);
        if (previous) {
            assert.equal(observation.created, previous.created);
            assert.equal(observation.path.toLowerCase(), previous.path.toLowerCase());
        }
        identities.set(pid, { created: observation.created, path: observation.path });
        return observation;
    }
    const nativeAppData = ps('[Environment]::GetFolderPath("ApplicationData")');
    assert.ok(path.isAbsolute(nativeAppData));
    const defaultProfile = path.join(
        nativeAppData,
        'DiagnosticHub',
        'profiles',
        record.installationId,
    );
    await assert.rejects(access(defaultProfile), { code: 'ENOENT' });
    async function freePort() {
        return new Promise<number>((resolve, reject) => {
            const server = net.createServer();
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as net.AddressInfo).port;
                server.close(() => resolve(port));
            });
        });
    }
    function child(profile: string | undefined, port?: number, launcher = executable) {
        const spawned = spawn(
            launcher,
            [
                ...(profile ? ['--user-data-dir=' + profile] : []),
                ...(port
                    ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port]
                    : []),
            ],
            {
                env:
                    launcher === portableExecutable
                        ? { ...env, TEMP: portableTemp, TMP: portableTemp }
                        : env,
                windowsHide: false,
                stdio: 'ignore',
            },
        );
        children.push(spawned);
        spawned.on('error', (error) => console.error('Owned launch failed:', error.message));
        return spawned;
    }
    async function launch(profile: string | undefined, launcher = executable) {
        const port = await freePort();
        const began = performance.now();
        const spawned = child(profile, port, launcher);
        const initialObservationStartedMs = performance.now() - began;
        const initialNative = native(spawned.pid!, launcher);
        const initialObservationCompletedMs = performance.now() - began; // Record exact creation identity even if startup fails before CDP.
        const endpoint = 'http://127.0.0.1:' + port;
        const deadline = Date.now() + 45000;
        let connected = false;
        while (Date.now() < deadline && spawned.exitCode === null) {
            try {
                const response = await fetch(endpoint + '/json/version', {
                    signal: AbortSignal.timeout(500),
                });
                if (response.ok) {
                    connected = true;
                    break;
                }
            } catch {
                /* The owned app may not have initialized its local inspector yet. */
            }
            await delay(25);
        }
        assert.ok(connected, 'Owned installed app must expose its transient fixture inspector');
        const inspectorReadyObservedMs = performance.now() - began;
        const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
        browsers.push(browser);
        let page: Page | undefined;
        for (let attempt = 0; attempt < 200; attempt++) {
            page = browser
                .contexts()
                .flatMap((context) => context.pages())
                .find((candidate) => candidate.url() === 'app://bundle/index.html');
            if (page) break;
            await delay(25);
        }
        assert.ok(page);
        await page.waitForFunction(() => Boolean(window.diagnosticHub));
        const connect = page.getByRole('button', { name: 'Connect device', exact: true }).first();
        await expect(connect).toBeVisible();
        await connect.click();
        const input = page.getByRole('dialog').getByLabel('Hostname or IP address');
        await input.fill('installed-startup.invalid');
        await expect(input).toHaveValue('installed-startup.invalid');
        const usableInteractionObservedMs = performance.now() - began;
        const info = await page.evaluate(() => window.diagnosticHub!.readUpdateInfo!());
        assert.equal(info.currentVersion, version);
        assert.equal(info.currentPath, launcher);
        let actualPID = spawned.pid!,
            actualPath = executable;
        if (launcher === portableExecutable) {
            assert.equal(info.installation, undefined);
            const matches = JSON.parse(
                ps(
                    '$items=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith(' +
                        quote(portableTemp + path.sep) +
                        ',[System.StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine.Contains(' +
                        quote('--remote-debugging-port=' + port) +
                        ') -and $_.CommandLine -notmatch ' +
                        quote('--type=') +
                        '});ConvertTo-Json -InputObject $items -Compress',
                ),
            ) as { ProcessId: number; ExecutablePath: string }[];
            assert.equal(matches.length, 1, 'Identify exactly one owned portable main process');
            actualPID = matches[0].ProcessId;
            actualPath = matches[0].ExecutablePath;
            assert.notEqual(actualPath.toLowerCase(), executable.toLowerCase());
        } else {
            assert.equal(info.installation?.profilePath, await realpath(profile ?? defaultProfile));
            assert.equal(info.installation?.id, record.installationId);
            assert.equal(info.installation?.payloadIntegrity, 'not-checked');
            assert.equal(info.installation?.automaticUpdateQualified, false);
        }
        assert.equal(info.handoffConfirmed, false);
        const nativeObservationStartedMs = performance.now() - began;
        const view = native(actualPID, actualPath);
        const nativeVisibleConfirmationObservedMs = performance.now() - began;
        assert.ok(
            view.handle && view.visible && !view.minimized,
            'Owned launch must have a visible non-minimized native window',
        );
        if (profile)
            assert.ok(
                view.commandLine.includes('--user-data-dir=' + profile) ||
                    view.commandLine.includes('--user-data-dir="' + profile + '"'),
                'Native arguments retain the isolated requested profile',
            );
        else
            assert.ok(
                !view.commandLine.includes('--user-data-dir'),
                'Default dedicated profile must be chosen without a CLI override',
            );
        return {
            spawned,
            browser,
            page,
            info,
            native: view,
            actualPID,
            actualPath,
            profile: profile ?? defaultProfile,
            portable: launcher === portableExecutable,
            timings: {
                inspectorReadyObservedMs,
                usableInteractionObservedMs,
                initialObservationStartedMs,
                initialObservationCompletedMs,
                initialNative,
                nativeObservationStartedMs,
                nativeVisibleConfirmationObservedMs,
                qualification:
                    'Observed interaction and later native visibility bounds include harness/probe overhead; first presentation and cold-cache startup are not measured.',
            },
        };
    }
    async function recheck(app: Awaited<ReturnType<typeof launch>>, phase: string) {
        const input = app.page.getByRole('dialog').getByLabel('Hostname or IP address');
        await input.fill(phase + '.invalid');
        await expect(input).toHaveValue(phase + '.invalid');
        const info = await app.page.evaluate(() => window.diagnosticHub!.readUpdateInfo!());
        assert.equal(info.currentPath, app.info.currentPath);
        assert.equal(info.currentVersion, version);
        assert.equal(info.installation?.profilePath, app.info.installation?.profilePath);
        const view = native(app.actualPID, app.actualPath);
        assert.equal(view.created, app.native.created);
        assert.ok(view.visible && !view.minimized && view.handle);
        return { phase, interactive: true, rpcResponsive: true, native: view };
    }

    async function exited(spawned: ChildProcess) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && spawned.exitCode === null) await delay(50);
        assert.equal(
            spawned.exitCode,
            0,
            'Second process with the same canonical profile must exit without another writer',
        );
    }
    let result: Record<string, unknown> | undefined;
    try {
        const first = await launch(primaryProfile);
        const status = await first.page.evaluate(() => window.diagnosticHub!.checkUpdates(false));
        assert.equal(status.installable, false);
        assert.equal(status.release, null);
        assert.match(status.installationUnavailableReason ?? '', /installed delivery/);
        const refusal = await first.page.evaluate(async () => {
            try {
                await window.diagnosticHub!.startUpdate({ mode: 'clean' });
                return '';
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        });
        assert.match(refusal, /Automatic updates/);
        for (const name of ['updates', 'update-reports'])
            await assert.rejects(access(path.join(primaryProfile, name)));
        await exited(child(primaryProfile));
        await exited(child(alias));
        assert.equal(
            (await first.page.evaluate(() => window.diagnosticHub!.readUpdateInfo!())).installation
                ?.profilePath,
            await realpath(primaryProfile),
        );
        const other = await launch(otherProfile);
        const firstAfterOther = await recheck(first, 'first-after-other-profile');
        const defaultApp = await launch(undefined);
        const defaultMarker = path.join(defaultProfile, 'qualification-marker.json');
        const defaultMarkerBytes = JSON.stringify({
            fixture: ownedRoot,
            installationId: record.installationId,
        });
        await writeFile(defaultMarker, defaultMarkerBytes, { flag: 'wx' });
        await exited(child(undefined));
        assert.equal(await readFile(defaultMarker, 'utf8'), defaultMarkerBytes);
        const firstAfterDefault = await recheck(first, 'first-after-default-profile');
        const portableApp = await launch(portableProfile, portableExecutable);
        const afterPortable = {
            first: await recheck(first, 'first-after-portable'),
            other: await recheck(other, 'other-after-portable'),
            default: await recheck(defaultApp, 'default-after-portable'),
            portable: await recheck(portableApp, 'portable-after-installed'),
        };
        assert.notEqual(portableApp.info.currentPath, first.info.currentPath);
        assert.notEqual(portableApp.actualPath, first.actualPath);
        assert.notEqual(other.spawned.pid, first.spawned.pid);
        assert.notEqual(other.info.installation?.profilePath, first.info.installation?.profilePath);
        assert.equal(await readFile(marker, 'utf8'), markerBytes);
        result = {
            source,
            harnessSHA256: hash(await readFile('tests/native-installation-startup.ts')),
            version,
            platform: process.platform,
            osRelease: os.release(),
            firstAfterOther,
            firstAfterDefault,
            afterPortable,
            defaultDedicatedProfile: defaultApp.info.installation?.profilePath,
            defaultProfileChosenWithoutCLI: true,
            defaultSameProfileSecondWriterRefused: true,
            defaultProfileMarkerPreserved: true,
            defaultDedicatedProfileRetained: true,
            portableInstalledDistinctPaths: true,
            portableCurrentPath: portableApp.info.currentPath,
            portableInnerPath: portableApp.actualPath,
            portablePID: portableApp.actualPID,
            defaultPID: defaultApp.actualPID,
            timings: {
                first: first.timings,
                other: other.timings,
                default: defaultApp.timings,
                portable: portableApp.timings,
            },
            universalStartupTargetClaimed: false,
            firstNativePresentationMeasured: false,
            mainPID: first.spawned.pid,
            otherPID: other.spawned.pid,
            primaryProfile: first.info.installation?.profilePath,
            otherProfile: other.info.installation?.profilePath,
            currentPath: first.info.currentPath,
            nativeWindows: [first.native, other.native, defaultApp.native, portableApp.native],
            realPackagedProfileObserved: true,
            sameProfileSecondWriterRefused: true,
            aliasSecondWriterRefused: true,
            separateProfileCoexistence: true,
            installedCheckAndStartUpdateRefused: true,
            updateDirectoriesCreated: false,
            profileMarkerPreserved: true,
            fullPayloadIntegrityClaimedAtStartup: false,
            physicalPortsOpened: 0,
            sshConnections: 0,
            securitySettingsChanged: false,
            installerWizardQualified: false,
            linuxOrMacNativeQualified: false,
        };
        await writeFile(
            path.join(ownedRoot, 'native-startup-result.json'),
            JSON.stringify(result, null, 2),
        );
        console.log(JSON.stringify(result));
    } finally {
        for (const [pid, identity] of identities) {
            try {
                ps(
                    '$target=Get-Process -Id ' +
                        pid +
                        ' -ErrorAction Stop;if($target.Path -ne ' +
                        quote(identity.path) +
                        ' -or $target.StartTime.ToUniversalTime().ToString("o") -ne ' +
                        quote(identity.created) +
                        "){throw 'Owned cleanup identity mismatch'};$target.CloseMainWindow()|Out-Null",
                );
            } catch {
                /* A refused/exited owned process may already be gone. */
            }
        }
        for (const browser of browsers) await browser.close().catch(() => {});
        await delay(1000);
        for (const [pid, identity] of identities) {
            ps(
                '$target=Get-Process -Id ' +
                    pid +
                    ' -ErrorAction SilentlyContinue;if($target){if($target.Path -ne ' +
                    quote(identity.path) +
                    ' -or $target.StartTime.ToUniversalTime().ToString("o") -ne ' +
                    quote(identity.created) +
                    "){throw 'Cleanup PID reuse/path mismatch'};Stop-Process -Id $target.Id -Force -ErrorAction Stop};exit 0",
            );
        }
        const remaining = JSON.parse(
            ps(
                '$items=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and ($_.ExecutablePath -eq ' +
                    quote(executable) +
                    ' -or $_.ExecutablePath.StartsWith(' +
                    quote(portableTemp + path.sep) +
                    ',[System.StringComparison]::OrdinalIgnoreCase))});ConvertTo-Json -InputObject $items -Compress',
            ),
        ) as unknown[];
        assert.equal(remaining.length, 0, 'No owned fixture app process may remain');
        await writeFile(
            path.join(ownedRoot, 'process-cleanup-result.json'),
            JSON.stringify(
                {
                    ownedProcesses: [...identities].map(([pid, identity]) => ({
                        pid,
                        ...identity,
                    })),
                    remaining: 0,
                    exactIdentityChecked: true,
                    noUserProcessTerminated: true,
                    profileDataRetained: true,
                },
                null,
                2,
            ),
        );
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
