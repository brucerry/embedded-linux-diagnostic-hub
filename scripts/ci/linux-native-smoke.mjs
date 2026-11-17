// A public-baseline actor only. Importing this file never loads Playwright or an app.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

export const SMOKE_REASONS = Object.freeze([
    'launch',
    'window',
    'renderer',
    'interaction',
    'close',
    'deadline',
    'output',
    'input',
]);
const forbidden = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-seccomp-filter-sandbox',
    '--single-process',
    '--in-process-gpu',
];
export function launchOptions(context, environment) {
    assert.match(context.source, /^[a-f0-9]{40}$/);
    for (const key of ['root', 'project', 'appdir', 'profile'])
        assert.ok(path.isAbsolute(context[key]) && path.normalize(context[key]) === context[key]);
    assert.equal(context.appdir, path.join(context.root, 'out/linux-unpacked'));
    assert.equal(context.profile, path.join(context.root, 'profile'));
    assert.equal(environment.DISPLAY, ':177');
    assert.equal(environment.XAUTHORITY, path.join(context.root, 'Xauthority'));
    for (const key of [
        'NODE_OPTIONS',
        'NODE_PATH',
        'LD_PRELOAD',
        'ELECTRON_RUN_AS_NODE',
        'CHROME_DEVEL_SANDBOX',
        'WAYLAND_DISPLAY',
    ])
        assert.ok(!environment[key]);
    return {
        executablePath: path.join(context.appdir, 'AppRun'),
        chromiumSandbox: true,
        args: ['--user-data-dir=' + context.profile],
        env: environment,
        timeout: 15000,
        acceptDownloads: false,
        artifactsDir: path.join(context.root, 'playwright-data'),
    };
}

export function verifyRenderer(observation, uid) {
    assert.equal(observation.sandbox, true);
    assert.equal(observation.contextIsolation, true);
    assert.equal(observation.nodeIntegration, false);
    assert.equal(observation.version, '0.6.0');
    assert.ok(
        observation.argv.every(
            (arg) => !forbidden.some((flag) => arg === flag || arg.startsWith(flag + '=')),
        ),
    );
    assert.ok(Number.isSafeInteger(observation.rendererPid) && observation.rendererPid > 0);
    assert.equal(observation.uid, uid);
    assert.equal(observation.noNewPrivs, '1');
    assert.equal(observation.seccomp, '2');
    assert.equal(BigInt('0x' + observation.effectiveCaps), 0n);
}

export async function runSmoke(context, ports) {
    let app,
        reason = 'input',
        primary = null,
        closeIssued = false,
        closure = false;
    const start = ports.now();
    const guard = () => {
        if (ports.now() - start > 90000) throw Error('deadline');
    };
    try {
        const options = launchOptions(context, ports.environment);
        await ports.verifyArchive(context);
        guard();
        reason = 'launch';
        app = await ports.launch(options);
        ports.own(app);
        guard();
        reason = 'window';
        const window = await app.firstWindow({ timeout: 10000 });
        await window.waitForLoadState('domcontentloaded', { timeout: 10000 });
        guard();
        reason = 'renderer';
        const observation = await ports.renderer(app);
        verifyRenderer(observation, ports.uid);
        guard();
        reason = 'interaction';
        await window
            .getByRole('heading', { name: 'Device overview', exact: true })
            .waitFor({ timeout: 10000 });
        await window
            .locator('.version-label')
            .filter({ hasText: 'v0.6.0' })
            .waitFor({ timeout: 10000 });
        guard();
        await window.getByRole('button', { name: 'Memory', exact: true }).click({ timeout: 10000 });
        await window
            .getByRole('heading', { name: 'Memory', exact: true })
            .waitFor({ timeout: 10000 });
        guard();
    } catch (error) {
        primary = error instanceof Error && error.message === 'deadline' ? 'deadline' : reason;
    }
    if (app && primary !== 'deadline') {
        try {
            guard();
            closeIssued = true;
            // Request normal Electron quit once. The pinned launcher's separate
            // failure and exit handlers can force-kill; they are not disabled here.
            await app.close();
            await ports.closed(app);
            closure = true;
            guard();
        } catch (error) {
            if (!primary)
                primary =
                    error instanceof Error && error.message === 'deadline' ? 'deadline' : 'close';
        }
    }
    return {
        schema: 1,
        status: !primary && closure ? 'pass' : 'fail',
        reason: primary || (closure ? 'none' : 'close'),
        closeIssued,
        closure,
        qualified: false,
        scope: 'public-native-baseline-only',
    };
}

async function physical(context) {
    const require = createRequire(path.join(context.project, 'package.json'));
    let record;
    const ports = {
        environment: {
            PATH: '/usr/bin:/bin',
            HOME: path.join(context.root, 'home'),
            TMPDIR: path.join(context.root, 'tmp'),
            XDG_CONFIG_HOME: path.join(context.root, 'config'),
            XDG_CACHE_HOME: path.join(context.root, 'cache'),
            XDG_DATA_HOME: path.join(context.root, 'data'),
            XDG_RUNTIME_DIR: path.join(context.root, 'runtime'),
            DISPLAY: ':177',
            XAUTHORITY: path.join(context.root, 'Xauthority'),
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            TZ: 'UTC',
        },
        uid: process.getuid(),
        now: () => performance.now(),
        async verifyArchive(value) {
            const archive = path.join(value.appdir, 'resources/app.asar');
            const bytes = await fs.readFile(archive);
            assert.ok(bytes.length <= 128 * 1024 ** 2);
            assert.equal(createHash('sha256').update(bytes).digest('hex'), value.asarSHA256);
            const asar = require('@electron/asar');
            for (const name of ['dist-electron/main.cjs', 'dist-electron/preload.cjs']) {
                const expected = await fs.readFile(path.join(value.project, name));
                assert.ok(asar.extractFile(archive, name).equals(expected));
            }
            const manifest = JSON.parse(asar.extractFile(archive, 'package.json'));
            assert.equal(manifest.version, '0.6.0');
            assert.equal(manifest.main, 'dist-electron/main.cjs');
            asar.uncacheAll();
        },
        async launch(options) {
            const { _electron } = require('playwright');
            return _electron.launch(options);
        },
        own(app) {
            const child = app.process();
            assert.ok(child && Number.isSafeInteger(child.pid));
            assert.equal(child.exitCode, null);
            assert.equal(child.signalCode, null);
            record = {
                child,
                exit: child.exitCode,
                signal: child.signalCode,
                close: false,
                stdout: child.stdout?.readableEnded === true,
                stderr: child.stderr?.readableEnded === true,
                bytes: 0,
                overflow: false,
            };
            for (const name of ['stdout', 'stderr']) {
                assert.ok(child[name]);
                child[name].on('data', (bytes) => {
                    record.bytes += bytes.length;
                    record.overflow ||= record.bytes > 1024 ** 2;
                });
                child[name].once('end', () => {
                    record[name] = true;
                });
            }
            child.once('exit', (code, signal) => {
                record.exit = code;
                record.signal = signal;
            });
            record.closedPromise = new Promise((resolve) =>
                child.once('close', () => {
                    record.close = true;
                    resolve();
                }),
            );
        },
        async renderer(app) {
            const observed = await app.evaluate(({ app, BrowserWindow }) => {
                const windows = BrowserWindow.getAllWindows();
                if (windows.length !== 1) throw Error('window');
                const prefs = windows[0].webContents.getLastWebPreferences();
                return {
                    sandbox: prefs.sandbox,
                    contextIsolation: prefs.contextIsolation,
                    nodeIntegration: prefs.nodeIntegration,
                    rendererPid: windows[0].webContents.getOSProcessId(),
                    version: app.getVersion(),
                    argv: process.argv,
                };
            });
            assert.ok(Number.isSafeInteger(observed.rendererPid) && observed.rendererPid > 0);
            const base = '/proc/' + observed.rendererPid;
            const before = await fs.readFile(base + '/stat', 'utf8');
            const status = Object.fromEntries(
                (await fs.readFile(base + '/status', 'utf8'))
                    .split('\n')
                    .filter((line) => line.includes(':'))
                    .map((line) => {
                        const i = line.indexOf(':');
                        return [line.slice(0, i), line.slice(i + 1).trim()];
                    }),
            );
            const after = await fs.readFile(base + '/stat', 'utf8');
            const identity = (value) => value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
            assert.equal(identity(before), identity(after));
            record.renderer = { pid: observed.rendererPid, start: identity(before) };
            return {
                ...observed,
                uid: Number(status.Uid.split(/\s+/)[0]),
                noNewPrivs: status.NoNewPrivs,
                seccomp: status.Seccomp,
                effectiveCaps: status.CapEff,
            };
        },
        async closed() {
            await record.closedPromise;
            assert.equal(record.exit, 0);
            assert.equal(record.signal, null);
            assert.ok(record.close && record.stdout && record.stderr && !record.overflow);
            if (record.renderer) {
                try {
                    const value = await fs.readFile(
                        '/proc/' + record.renderer.pid + '/stat',
                        'utf8',
                    );
                    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
                    assert.notEqual(fields[19], record.renderer.start);
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            }
        },
    };
    return runSmoke(context, ports);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void (async () => {
        assert.equal(process.argv.length, 3);
        assert.equal(process.platform, 'linux');
        assert.ok(process.getuid() > 0 && process.getuid() === process.geteuid());
        assert.equal(process.execArgv.length, 0);
        for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD']) assert.ok(!process.env[key]);
        const raw = await fs.readFile(process.argv[2]);
        assert.ok(raw.length <= 8192);
        const result = await physical(JSON.parse(raw));
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exitCode = result.status === 'pass' ? 0 : 1;
    })().catch(() => {
        process.stdout.write(
            JSON.stringify({
                schema: 1,
                status: 'fail',
                reason: 'input',
                closure: false,
                qualified: false,
                scope: 'public-native-baseline-only',
            }) + '\n',
        );
        process.exitCode = 1;
    });
}
