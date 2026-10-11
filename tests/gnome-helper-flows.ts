// Actual app launches/settings under an isolated GNOME bus, using local release transport fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { createGeniePackage, genieAsset } from '../scripts/lib/genie-package.mjs';

async function main() {
    assert.equal(process.platform, 'linux');
    assert.equal(process.env.HUB_GNOME_ISOLATED, '1');
    assert.notEqual(process.getuid!(), 0);
    assert.ok(process.env.XDG_DATA_HOME && process.env.HUB_GNOME_EVIDENCE);
    const persistent = process.env.HUB_GNOME_PERSISTENT_PROFILE;
    if (persistent) assert.ok(persistent.startsWith('/home/hubengineer/qualification/evidence/'));
    const root = persistent
        ? path.join(persistent, 'helper-fixture')
        : await mkdtemp(path.join(tmpdir(), 'hub-gnome-helper-'));
    await mkdir(root, { recursive: true });
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const major = Number(
        execFileSync('gnome-shell', ['--version'], { encoding: 'utf8' }).match(/(\d+)\./)![1],
    );
    const format = major === 42 ? 'legacy42' : 'modern';
    const mirror = path.join(root, 'mirror');
    const bin = path.join(root, 'bin');
    const uuid = 'diagnostic-hub-genie@diagnostichub.desktop';
    const data = process.env.XDG_DATA_HOME!;
    const extension = path.join(data, 'gnome-shell/extensions', uuid);
    const desktop = path.join(data, 'applications/diagnostic-hub.desktop');
    const icon = path.join(data, 'icons/hicolor/256x256/apps/diagnostic-hub.png');
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const evaluate = (source: string) =>
        execFileSync(
            'gdbus',
            [
                'call',
                '--session',
                '--dest',
                'org.gnome.Shell',
                '--object-path',
                '/org/gnome/Shell',
                '--method',
                'org.gnome.Shell.Eval',
                JSON.stringify(source),
            ],
            { encoding: 'utf8', timeout: 5000 },
        );
    const target = `global.get_window_actors().filter(a => a.meta_window.get_wm_class()?.toLowerCase() === 'diagnostic-hub')`;
    const present = () => /^\(true, ['"]true['"]\)/.test(evaluate(`${target}.length === 1`));
    const close = () =>
        evaluate(`${target}.forEach(a => a.meta_window.delete(global.get_current_time()))`);
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const runningVersion = async (releaseVersion: string) => {
        const reply = evaluate(`${target}[0].meta_window.get_pid()`);
        const pid = Number(reply.match(/['"]([0-9]+)['"]/)?.[1]);
        assert.ok(Number.isInteger(pid) && pid > 0, 'Actual mapped app PID unavailable');
        assert.equal((await stat(`/proc/${pid}`)).uid, process.getuid!());
        const executable = await readlink(`/proc/${pid}/exe`);
        const archive = path.join(path.dirname(executable), 'resources/app.asar');
        const actual = JSON.parse(extractFile(archive, 'package.json').toString());
        const expected = process.env.HUB_GNOME_UPDATE_RELEASE_DIR ? releaseVersion : version;
        assert.equal(actual.version, expected, 'Running helper app embedded version mismatch');
        return { pid, executable, archive, version: actual.version };
    };
    const observations: unknown[] = [];
    const identityRuns: unknown[] = [];
    const shellBoolean = (source: string) => /^\(true, ['"]true['"]\)/.test(evaluate(source));
    evaluate(`void (async () => {
        global.hubHelperMain = ${major === 42 ? 'imports.ui.main' : "await import('resource:///org/gnome/shell/ui/main.js')"};
    })()`);
    await expect
        .poll(() => shellBoolean('Boolean(global.hubHelperMain)'), { timeout: 5000 })
        .toBe(true);
    const desktopState = () => ({
        overviewVisible: shellBoolean('Boolean(global.hubHelperMain.overview.visible)'),
        overviewTarget: shellBoolean('Boolean(global.hubHelperMain.overview.visibleTarget)'),
        windowGroupMapped: shellBoolean('Boolean(global.window_group?.mapped)'),
    });
    const startupBefore = desktopState();
    // Fresh isolated GNOME can start in Overview, where the real window group is unmapped.
    // Ordinary setup starts from a desktop terminal. Normalize only this owned test session.
    const holdOverviewUntilWindow = process.env.HUB_GNOME_HOLD_OVERVIEW_UNTIL_WINDOW === '1';
    if (!holdOverviewUntilWindow) {
        if (startupBefore.overviewVisible) evaluate('global.hubHelperMain.overview.hide()');
        await expect.poll(() => desktopState().overviewVisible, { timeout: 8000 }).toBe(false);
    }
    await writeFile(
        path.join(process.env.HUB_GNOME_EVIDENCE!, 'helper-startup.json'),
        JSON.stringify(
            {
                shell: major,
                before: startupBefore,
                after: desktopState(),
                action: holdOverviewUntilWindow
                    ? 'diagnostic-hold-until-window'
                    : startupBefore.overviewVisible
                      ? 'hide-owned-test-overview'
                      : 'none',
            },
            null,
            4,
        ),
    );
    await mkdir(bin, { recursive: true });
    await mkdir(mirror, { recursive: true });
    // The real helper retains its URL/checksum/metadata checks. Only transport is mirrored.
    await writeFile(
        path.join(bin, 'curl'),
        `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),url=new URL(args.at(-1));
const prefix='/brucerry/embedded-linux-diagnostic-hub/releases/download/';
if(url.origin!=='https://github.com'||!url.pathname.startsWith(prefix))process.exit(22);
const parts=url.pathname.slice(prefix.length).split('/');
if(parts.length!==2||!/^v[0-9A-Za-z.-]+$/.test(parts[0])||!/^Diagnostic-Hub-[0-9A-Za-z.-]+(?:\\.sha256)?$|^linux-build-info\\.json$/.test(parts[1]))process.exit(22);
fs.copyFileSync(path.join(process.env.HUB_GNOME_RELEASE_MIRROR,...parts),args[args.indexOf('--output')+1]);
`,
        { mode: 0o700 },
    );
    const stage = async (releaseVersion: string) => {
        const directory = path.join(mirror, 'v' + releaseVersion);
        await mkdir(directory, { recursive: true });
        const assets: Record<string, string> = {};
        const genuine =
            releaseVersion !== version && process.env.HUB_GNOME_UPDATE_RELEASE_DIR
                ? JSON.parse(
                      await readFile(
                          path.join(
                              process.env.HUB_GNOME_UPDATE_RELEASE_DIR,
                              'linux-build-info.json',
                          ),
                          'utf8',
                      ),
                  )
                : null;
        if (genuine) {
            assert.equal(genuine.version, releaseVersion);
            assert.equal(genuine.actualPackagedVersion, releaseVersion);
            assert.equal(genuine.commit, commit);
        }
        for (const name of [
            'Diagnostic-Hub-linux-x64.AppImage',
            'Diagnostic-Hub-linux-x64.tar.gz',
        ]) {
            const source =
                releaseVersion !== version && process.env.HUB_GNOME_UPDATE_RELEASE_DIR
                    ? process.env.HUB_GNOME_UPDATE_RELEASE_DIR
                    : 'release';
            const stagedAsset = path.join(directory, name);
            const sourceAsset = path.resolve(source, name);
            try {
                // The local fixture reads immutable release bytes; avoid duplicate large mirrors.
                await link(sourceAsset, stagedAsset);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                assert.equal(hash(await readFile(stagedAsset)), hash(await readFile(sourceAsset)));
            }
            assets[name] = hash(await readFile(path.join(directory, name)));
            if (genuine)
                assert.equal(assets[name], genuine.assets[name], 'Genuine app asset mismatch');
        }
        for (const companionFormat of ['modern', 'legacy42']) {
            const packaged = await createGeniePackage(
                process.cwd(),
                releaseVersion,
                commit,
                companionFormat,
            );
            const name = genieAsset(releaseVersion, companionFormat);
            await writeFile(path.join(directory, name), packaged.zip);
            assets[name] = hash(packaged.zip);
            if (genuine)
                assert.equal(
                    assets[name],
                    genuine.assets[name],
                    'Genuine companion source mismatch',
                );
        }
        for (const [name, checksum] of Object.entries(assets))
            await writeFile(path.join(directory, name + '.sha256'), `${checksum}  ${name}\n`);
        await writeFile(
            path.join(directory, 'linux-build-info.json'),
            JSON.stringify({ version: releaseVersion, commit, assets }),
        );
    };
    const remove = () =>
        execFileSync('python3', ['-B', 'linux/gnome-genie/setup.py', '--remove'], {
            encoding: 'utf8',
        });
    const record = async () =>
        JSON.parse(await readFile(path.join(extension, 'managed.json'), 'utf8'));
    const owned = async () => {
        const current = await record();
        return {
            record: current,
            desktop: hash(await readFile(desktop)),
            icon: hash(await readFile(icon)),
            files: await Promise.all(
                Object.keys(current.files).map(async (name) => [
                    name,
                    hash(await readFile(path.join(extension, name))),
                ]),
            ),
        };
    };
    const run = async (appFormat: string, releaseVersion: string, download: string) => {
        assert.equal(
            present(),
            false,
            'Another target window could interfere with this isolated fixture',
        );
        const command = [
            'bash',
            'public/download-run.sh',
            '--version',
            'v' + releaseVersion,
            '--format',
            appFormat,
            '--directory',
            download,
        ]
            .map(quote)
            .join(' ');
        const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
            env: {
                ...process.env,
                PATH: bin + ':' + process.env.PATH,
                HUB_GNOME_RELEASE_MIRROR: mirror,
                // Real desktop logins provide this; nested qualification must supply it.
                XDG_SESSION_TYPE: process.env.HUB_GNOME_BACKEND === 'x11' ? 'x11' : 'wayland',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (bytes) => {
            output += bytes;
        });
        child.stderr.on('data', (bytes) => {
            output += bytes;
        });
        const ended = new Promise<number | null>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
        });
        child.stdin.end('y\n');
        try {
            await expect.poll(present, { timeout: 25000 }).toBe(true);
            const started = performance.now();
            let identityPhase = 'helper';
            const samples: {
                elapsedMs: number;
                phase: string;
                matched: boolean;
                native: string;
            }[] = [];
            const identity = {
                appFormat,
                releaseVersion,
                samples,
                matchedWithinMs: 0,
                helperExitedBeforeShortcut: false,
                shortcutMatchedWithinMs: 0,
                actualHelperApp: undefined as
                    Awaited<ReturnType<typeof runningVersion>> | undefined,
                actualShortcutApp: undefined as
                    Awaited<ReturnType<typeof runningVersion>> | undefined,
                overviewWindowBefore: desktopState(),
                overviewWindowAfter: desktopState(),
            };
            identityRuns.push(identity);
            const expectedClientType = process.env.HUB_GNOME_BACKEND === 'x11' ? 'X11' : 'WAYLAND';
            const expectedIdentity = () => {
                const matched = /^\(true, ['"]true['"]\)/.test(
                    evaluate(`(() => {
                        const actors = ${target};
                        return actors.length === 1 && actors[0].mapped &&
                            actors[0].meta_window.get_client_type() === imports.gi.Meta.WindowClientType.${expectedClientType} &&
                            imports.gi.Shell.WindowTracker.get_default()
                            .get_window_app(actors[0].meta_window)?.get_id() === 'diagnostic-hub.desktop';
                    })()`),
                );
                const native = evaluate(`JSON.stringify(${target}.map(a => {
                    const w = a.meta_window, frame = w.get_frame_rect();
                    return {
                        class: w.get_wm_class(), classInstance: w.get_wm_class_instance?.(),
                        gtkApplicationId: w.get_gtk_application_id?.(), clientType: w.get_client_type?.(),
                        clientTypeName: w.get_client_type() === imports.gi.Meta.WindowClientType.WAYLAND
                            ? 'wayland' : w.get_client_type() === imports.gi.Meta.WindowClientType.X11 ? 'x11' : 'unknown',
                        appId: imports.gi.Shell.WindowTracker.get_default().get_window_app(w)?.get_id(),
                        registeredAppId: imports.gi.Shell.AppSystem.get_default()
                            .lookup_app('diagnostic-hub.desktop')?.get_id(),
                        desktopFile: imports.gi.Gio.DesktopAppInfo.new('diagnostic-hub.desktop')?.get_filename(),
                        mapped: a.mapped, visible: a.visible, paintOpacity: a.get_paint_opacity(),
                        overviewVisible: global.hubHelperMain?.overview.visible,
                        parentMapped: a.get_parent()?.mapped, parentVisible: a.get_parent()?.visible,
                        minimized: w.minimized, hidden: w.is_hidden?.(),
                        workspace: w.get_workspace()?.index(), showingOnWorkspace: w.showing_on_its_workspace?.(),
                        pid: w.get_pid(),
                        frame: [frame.x, frame.y, frame.width, frame.height],
                    };
                }))`);
                samples.push({
                    elapsedMs: performance.now() - started,
                    phase: identityPhase,
                    matched,
                    native,
                });
                return matched;
            };
            if (holdOverviewUntilWindow && desktopState().overviewVisible) {
                expectedIdentity(); // Preserve this same native window before the desktop action.
                identity.overviewWindowBefore = desktopState();
                evaluate('global.hubHelperMain.overview.hide()');
                await expect
                    .poll(() => desktopState().overviewVisible, { timeout: 8000 })
                    .toBe(false);
                identity.overviewWindowAfter = desktopState();
            }
            try {
                // Window mapping can precede the shell's desktop-file monitor/app association.
                // Observe exact identity readiness; a fixed sleep would conceal a persistent failure.
                await expect
                    .poll(expectedIdentity, { timeout: 8000, intervals: [50, 100, 200, 500] })
                    .toBe(true);
                identity.actualHelperApp = await runningVersion(releaseVersion);
                identity.matchedWithinMs = performance.now() - started;
            } finally {
                await writeFile(
                    path.join(process.env.HUB_GNOME_EVIDENCE!, 'helper-identity.json'),
                    JSON.stringify(
                        {
                            shell: major,
                            exactExpectedAppId: 'diagnostic-hub.desktop',
                            identityRuns,
                        },
                        null,
                        4,
                    ),
                );
            }
            close();
            const code = await Promise.race([
                ended,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(Error('Helper app did not close')), 15000).unref(),
                ),
            ]);
            assert.equal(code, 0, output);
            await expect.poll(present).toBe(false);
            identity.helperExitedBeforeShortcut = true;
            // The helper has exited and cleaned its temporary extraction. Launch the actual
            // managed desktop file now, proving it points at the retained verified download.
            identityPhase = 'managed-desktop-after-extraction-close';
            const shortcutStarted = performance.now();
            const shortcut = spawn('gio', ['launch', desktop], {
                env: {
                    ...process.env,
                    XDG_SESSION_TYPE: process.env.HUB_GNOME_BACKEND === 'x11' ? 'x11' : 'wayland',
                },
                stdio: 'ignore',
            });
            const shortcutEnded = new Promise<number | null>((resolve, reject) => {
                shortcut.on('error', reject);
                shortcut.on('close', resolve);
            });
            try {
                await expect.poll(present, { timeout: 25000 }).toBe(true);
                await expect
                    .poll(expectedIdentity, { timeout: 8000, intervals: [50, 100, 200, 500] })
                    .toBe(true);
                identity.actualShortcutApp = await runningVersion(releaseVersion);
                identity.shortcutMatchedWithinMs = performance.now() - shortcutStarted;
                close();
                await expect.poll(present).toBe(false);
                assert.equal(await shortcutEnded, 0, 'Managed desktop launch failed');
            } finally {
                await writeFile(
                    path.join(process.env.HUB_GNOME_EVIDENCE!, 'helper-identity.json'),
                    JSON.stringify(
                        {
                            shell: major,
                            exactExpectedAppId: 'diagnostic-hub.desktop',
                            identityRuns,
                        },
                        null,
                        4,
                    ),
                );
                if (shortcut.exitCode === null) shortcut.kill('SIGTERM');
            }
            return output;
        } catch (error) {
            await writeFile(
                path.join(process.env.HUB_GNOME_EVIDENCE!, 'helper-failure.json'),
                JSON.stringify(
                    { appFormat, releaseVersion, output, error: String(error) },
                    null,
                    4,
                ),
            );
            throw error;
        } finally {
            if (present()) close();
            if (child.exitCode === null) child.kill('SIGTERM');
        }
    };
    try {
        await stage(version);
        const updateVersion = process.env.HUB_GNOME_UPDATE_VERSION || version + '-qualification.1';
        if (process.env.HUB_GNOME_UPDATE_RELEASE_DIR) {
            const build = JSON.parse(
                await readFile(
                    path.join(process.env.HUB_GNOME_UPDATE_RELEASE_DIR, 'linux-build-info.json'),
                    'utf8',
                ),
            );
            assert.equal(build.actualPackagedVersion, updateVersion);
            assert.notEqual(
                build.assets['Diagnostic-Hub-linux-x64.AppImage'],
                hash(await readFile('release/Diagnostic-Hub-linux-x64.AppImage')),
            );
        }
        await stage(updateVersion);
        for (const appFormat of process.env.HUB_GNOME_UPDATE_FORMAT
            ? [process.env.HUB_GNOME_UPDATE_FORMAT]
            : ['AppImage', 'tar.gz']) {
            const download = path.join(root, 'download with spaces', appFormat);
            if (process.env.HUB_GNOME_LOGIN_PHASE === 'verify') {
                const prior = await record();
                assert.equal(prior.build.version, updateVersion);
                const launched = await run(appFormat, updateVersion, download);
                assert.doesNotMatch(launched, /Set up Genie\?/);
                assert.match(launched, /Genie: active for Diagnostic Hub/);
                assert.deepEqual(await record(), prior);
                await writeFile(
                    path.join(process.env.HUB_GNOME_EVIDENCE!, 'helper-login.json'),
                    JSON.stringify(
                        {
                            ok: true,
                            appFormat,
                            newSession: true,
                            actualPackagedVersion: updateVersion,
                            localTransportFixture: true,
                            recordUnchanged: true,
                            status: launched.match(/Genie: [^\r\n]+/g),
                        },
                        null,
                        4,
                    ),
                );
                return;
            }
            remove();
            const first = await run(appFormat, version, download);
            assert.match(first, /Set up Genie\?/);
            const initial = await record();
            assert.equal(initial.build.format, format);
            assert.equal(initial.appimage, appFormat === 'AppImage');
            assert.equal(initial.app, path.join(download, 'Diagnostic-Hub-linux-x64.' + appFormat));
            const repeat = await run(appFormat, version, download);
            assert.doesNotMatch(repeat, /Set up Genie\?/);
            assert.deepEqual(await record(), initial);
            const updated = await run(appFormat, updateVersion, download);
            assert.match(updated, /Set up Genie\?/);
            assert.equal((await record()).build.version, updateVersion);
            if (persistent) {
                assert.match(updated, /Genie: pending activation/);
                await writeFile(
                    path.join(process.env.HUB_GNOME_EVIDENCE!, 'helper-genuine-update.json'),
                    JSON.stringify(
                        {
                            ok: true,
                            appFormat,
                            initialVersion: version,
                            actualPackagedVersion: updateVersion,
                            updateIdentityIsFixture: false,
                            localTransportFixture: true,
                            pendingActivation: true,
                            repeatWithoutPrompt: true,
                            installed: await record(),
                        },
                        null,
                        4,
                    ),
                );
                return;
            }
            const beforeRemoval = await owned();
            const appHash = hash(await readFile(initial.app));
            remove();
            assert.equal(hash(await readFile(initial.app)), appHash);
            await assert.rejects(readFile(path.join(extension, 'managed.json')));
            await assert.rejects(readFile(desktop));
            observations.push({
                appFormat,
                companionFormat: format,
                persistentPathWithSpaces: true,
                firstInstall: true,
                repeatWithoutPrompt: true,
                update: true,
                managedRemovalPreservedDownload: true,
                installedFiles: beforeRemoval,
                status: {
                    first: first.match(/Genie: [^\r\n]+/g),
                    repeat: repeat.match(/Genie: [^\r\n]+/g),
                    updated: updated.match(/Genie: [^\r\n]+/g),
                },
            });
        }
        await writeFile(
            path.join(process.env.HUB_GNOME_EVIDENCE!, 'helper-flows.json'),
            JSON.stringify(
                {
                    ok: true,
                    shell: major,
                    actualExecutableVersion: version,
                    updateIdentityIsFixture: true,
                    localTransportFixture: true,
                    observations,
                },
                null,
                4,
            ),
        );
        console.log(
            'Actual AppImage/archive helper launches, per-user install, repeat/update and managed removal passed using controlled local release metadata.',
        );
    } finally {
        if (!persistent) await rm(root, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
