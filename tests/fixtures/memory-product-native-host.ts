import { reportStartupIdentity } from '../../scripts/lib/startup-identity-report.mjs';
import assert from 'node:assert/strict';
import { settledElectronExecutable } from '../../scripts/lib/pilot-dependencies.mjs';
import { NativePilotStartup } from './native-pilot-startup';
import { nativePilotLaunchRoutes, pilotEarlyAppPaths, pilotPathMap } from './native-pilot-paths';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { productStartup } from './memory-product-startup';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { createHash, randomUUID as cryptoRandomId } from 'node:crypto';
import { build } from 'esbuild';
import { _electron, expect } from '@playwright/test';
import { ProcessSampler } from './memory-resource-processes';
import { sshQualificationProfile } from './memory-resource-ssh-profile';
import type { ProcessSample } from './memory-resource-verdict';
import type {} from './memory-product-app';
import { runNativeCleanup } from './memory-product-native-cleanup';
import { assertProductNativeShutdown } from './memory-product-native-verdict';
import type { AggregateWindowTransition } from './memory-product-aggregate-contract';

const mainProbe = String.raw`
    let __memoryNativeReadWrapped=false;
    let __memoryNativeSave:any=null;
    const __memorySave=()=>{const host=(globalThis as any).__memoryProductCapture;if(!host)throw Error('Native capture host unavailable.');return __memoryNativeSave??=(new __memoryNativeSaveControl(host,(file:string)=>{const directory=process.env.HUB_PRODUCT_NATIVE_DOWNLOADS;if(!directory||path.dirname(file)!==directory)throw Error('Native Save escaped private directory.');}));};
    const __memoryNativeDownloads={ready:false,error:null as string|null,next:0,records:[] as any[],navigations:[] as string[]};
    (globalThis as any).__memoryNativeDownloads=__memoryNativeDownloads;
    app.whenReady().then(()=>{try{
    session.defaultSession.on('will-download',(_event,item)=>{
        const records=__memoryNativeDownloads.records;
        if(records.length>=16)throw Error('Private native download receipt bound exceeded.');
        const directory=process.env.HUB_PRODUCT_NATIVE_DOWNLOADS;
        if(!directory||!path.isAbsolute(directory))throw Error('Private native download destination missing.');
        const name=item.getFilename();
        const ordinal=__memoryNativeDownloads.next++;
        const row={ordinal,file:path.join(directory,ordinal+'-'+name.replace(/[^a-zA-Z0-9._-]/g,'_')),name,state:'started',receivedBytes:0};
        records.push(row);item.setSavePath(row.file);
        item.once('done',(_done,state)=>{row.state=state;row.receivedBytes=item.getReceivedBytes();});
    });
    __memoryNativeDownloads.ready=true;
    }catch(error){__memoryNativeDownloads.error=String(error);}});
    app.on('web-contents-created',(_event,contents)=>contents.on('will-navigate',(_navigation,url)=>{if(__memoryNativeDownloads.navigations.length<16)__memoryNativeDownloads.navigations.push(url.slice(0,512));}));
    const __memoryNativeSnapshot=()=>{
        const host=(globalThis as any).__memoryProductCapture;
        const checked=(object:any,names:string[])=>{for(const name of names)if(!Object.hasOwn(object,name))throw Error('Native owner field absent: '+name);return object;};
        let capture:any=null;
        if(host){
            const h=checked(host,['store','server','exports','closing']);
            const s=checked(h.server,['writer','beginning','readers','pins','mutations','calls','disposed','pinReservations','completed','expiredPins']);
            const d=checked(h.store,['active','modifying','closed','closing','readers','pins','deleting','operation','resultWriting','listing','catalog','metadataQueues','metadataUncertain','jsonOperations']);
            capture={owners:{writer:Number(Boolean(s.writer))+Number(Boolean(s.beginning))+Number(Boolean(d.active))+Number(d.modifying),reader:s.readers.size+[...d.readers.values()].reduce((a:number,b:number)=>a+b,0),pin:s.pins.size+s.pinReservations+d.pins,export:h.exports.size,rpc:s.calls,cleanup:s.mutations.size+d.deleting.size+d.resultWriting.size+Number(Boolean(d.operation))+d.listing+d.metadataQueues.size+d.metadataUncertain.size+d.jsonOperations.size+Number(d.closing)},services:{rpcTimer:!s.disposed,storeOpen:!d.closed,catalogOpen:Boolean(d.catalog)},cache:{completed:s.completed.size,expiredPins:s.expiredPins.size}};
        }
        const activity=(globalThis as any).__memoryProductActivity;
        return {ssh:ssh.ownershipSnapshot,sshHasResources:ssh.hasResources,console:consoleService.snapshot,consoleHasResources:consoleService.hasResources,capture,activity:activity?{lease:Boolean(activity.lease),suspended:activity.suspended}:null,memory:process.memoryUsage(),versions:process.versions};
    };
    (globalThis as any).__memoryNativeQualification={snapshot:__memoryNativeSnapshot,
    prepareReport(file:string,held=false){__memorySave().arm(file,held);},
    reportStatus(){return __memorySave().status();},
    releaseReport(decision:'save'|'cancel'){__memorySave().release(decision);},
    finishReport(){return __memorySave().finish();},
    releaseHolds(){__memoryNativeSave?.cancelForShutdown();const fault=__memoryNativeReadFault.status();if(fault?.action==='hold'&&fault.entered&&!fault.released)__memoryNativeReadFault.release();},
    readFault:{
        arm(action:any){const host=(globalThis as any).__memoryProductCapture;if(!host?.store)throw Error('Actual native capture store missing.');if(!__memoryNativeReadWrapped){__memoryNativeReadFault.wrap(host.store);__memoryNativeReadWrapped=true;}__memoryNativeReadFault.arm(action);},
        status:()=>__memoryNativeReadFault.status(),release:()=>__memoryNativeReadFault.release(),clear:()=>__memoryNativeReadFault.clear()
    }};
    const __memoryNativeQuit={ready:false,release:false,request(){setImmediate(()=>app.quit());},allow(){this.release=true;setImmediate(()=>app.quit());}};
    (globalThis as any).__memoryNativeQuit=__memoryNativeQuit;
    app.on('will-quit',(event)=>{
        if(!__memoryNativeQuit.release){event.preventDefault();__memoryNativeQuit.ready=true;return;}
        const file=process.env.HUB_PRODUCT_NATIVE_EXIT;if(file)__memoryWriteSnapshot(file,JSON.stringify({at:new Date().toISOString(),snapshot:__memoryNativeSnapshot(),downloads:__memoryNativeDownloads.records}));
    });
`;

export async function prepareProductNativeBuild(options: {
    profile: string;
    gcMode: string;
    coldStart?: boolean;
    signal?: AbortSignal;
    workDeadlineMs?: number;
    pilot?: Record<string, any>;
    emit(stage: string, data: unknown): Promise<void>;
}) {
    const admit = productStartup(options);
    const sourceRoot = path.resolve(import.meta.dirname, '../..'),
        require = createRequire(import.meta.url);
    const root = path.resolve(options.profile, '..', 'native-app'),
        renderer = path.join(root, 'dist'),
        desktop = path.join(root, 'dist-electron');
    await fs.mkdir(desktop, { recursive: true });
    admit();
    await fs.mkdir(options.profile, { recursive: true });
    admit();
    const downloads = path.resolve(options.profile, '..', 'native-downloads');
    await fs.mkdir(downloads, { recursive: true });
    admit();
    const run = async (args: string[], env: NodeJS.ProcessEnv = process.env) =>
        new Promise<{ stdout: string; stderr: string }>(
            (resolve, reject) => (
                admit(),
                execFile(
                    process.execPath,
                    args,
                    {
                        cwd: sourceRoot,
                        env,
                        windowsHide: true,
                        timeout: 60000,
                        maxBuffer: 1024 ** 2,
                    },
                    (error, stdout, stderr) =>
                        error
                            ? reject(Object.assign(error, { stdout, stderr }))
                            : resolve({ stdout, stderr }),
                )
            ),
        );
    const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
    if (options.pilot) {
        process.env.HUB_PRODUCT_BUILD_OUT = renderer;
        process.env.HUB_PRODUCT_AGGREGATE_COLD_START = options.coldStart ? '1' : '0';
        const { build: viteBuild } = await import('vite');
        await viteBuild({
            configFile: path.join(sourceRoot, 'tests/fixtures/memory-product.vite.mts'),
            configLoader: 'runner',
            mode: 'desktop',
        });
        await options.emit('native-renderer-build', {
            configLoader: 'runner',
            configFile: 'tests/fixtures/memory-product.vite.mts',
            outDir: renderer,
        });
    } else {
        await options.emit(
            'native-renderer-build',
            await run(
                [
                    vite,
                    'build',
                    '--mode',
                    'desktop',
                    '--config',
                    'tests/fixtures/memory-product.vite.mts',
                ],
                {
                    ...process.env,
                    HUB_PRODUCT_BUILD_OUT: renderer,
                    HUB_PRODUCT_AGGREGATE_COLD_START: options.coldStart ? '1' : '0',
                },
            ),
        );
    }
    admit();
    const profile = await sshQualificationProfile();
    admit();
    const guarded = async (file: string, expected: string) => {
        const source = await fs.readFile(file, 'utf8');
        if (createHash('sha256').update(source).digest('hex') !== expected)
            throw Error('Native probe preimage changed: ' + file);
        return source;
    };
    admit();
    await build({
        absWorkingDir: sourceRoot,
        entryPoints: ['electron/main.ts', 'electron/preload.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outdir: desktop,
        outExtension: { '.js': '.cjs' },
        external: ['electron'],
        plugins: [
            {
                name: 'private-native-product-observers',
                setup(b) {
                    b.onResolve({ filter: /^ssh2$/ }, () => ({
                        path: profile.sshEntry,
                        external: true,
                    }));
                    b.onLoad({ filter: /[\\/]electron[\\/]main\.ts$/ }, async (args) => {
                        let source = await guarded(
                            args.path,
                            '005de35d840bcc87567c4530677359986886137c293eb79327305bd6b25c1a9d',
                        );
                        const needle = "    app.on('window-all-closed', () => app.quit());";
                        if (source.split(needle).length !== 2)
                            throw Error('Native lifecycle observer boundary changed.');
                        source = source.replace(needle, mainProbe + '\n' + needle);
                        const early = options.pilot
                            ? `import {app as __pilotApp} from 'electron';
const __pilot=JSON.parse(process.env.HUB_NATIVE_PILOT_PATHS!);
if(__pilotApp.isReady())throw Error('Pilot paths configured late');
__pilotApp.setPath('temp',__pilot.temp);__pilotApp.setPath('crashDumps',__pilot.crashDumps);__pilotApp.setAppLogsPath(__pilot.logs);
(globalThis as any).__memoryPilotPaths={temp:__pilotApp.getPath('temp'),crashDumps:__pilotApp.getPath('crashDumps'),logs:__pilotApp.getPath('logs')};
`
                            : '';
                        return {
                            contents:
                                early +
                                "import {writeNativeReceipt as __memoryWriteSnapshot} from '../tests/fixtures/memory-product-native-evidence';\nimport {workerReadFault as __memoryNativeReadFault} from '../tests/fixtures/memory-product-worker-faults';\nimport {NativeSaveControl as __memoryNativeSaveControl} from '../tests/fixtures/memory-product-native-save-control';\n" +
                                source,
                            loader: 'ts',
                        };
                    });
                    for (const [file, name, expected, field] of [
                        [
                            'capture-host',
                            'NativeCaptureHost',
                            'a939da5ab4819be7306427db68c34bfe6b07593f73bdc056b2a3661ac227b2e3',
                            '__memoryProductCapture',
                        ],
                        [
                            'automation-activity',
                            'AutomationActivity',
                            '1a3e969e9545476ca0157c6504e9df072ff1240e68e512ef4fc6370aa573d95c',
                            '__memoryProductActivity',
                        ],
                    ])
                        b.onLoad(
                            { filter: new RegExp('[\\\\/]electron[\\\\/]' + file + '\\.ts$') },
                            async (args) => {
                                let source = await guarded(args.path, expected);
                                if (file === 'capture-host') {
                                    const report =
                                        'streamCaptureReport(this.store, format, scope, pin.through)';
                                    if (source.split(report).length !== 2)
                                        throw Error('Native report writer boundary changed.');
                                    source =
                                        "import {boundedNativeReport} from '../tests/fixtures/memory-product-native-evidence';\n" +
                                        source.replace(
                                            report,
                                            'boundedNativeReport(' + report + ')',
                                        );
                                }
                                const needle = 'export class ' + name + ' {';
                                if (source.split(needle).length !== 2)
                                    throw Error('Native constructor probe boundary changed.');
                                return {
                                    contents: source.replace(
                                        needle,
                                        needle +
                                            '\n private readonly __qualification = ((globalThis as any).' +
                                            field +
                                            '=this);',
                                    ),
                                    loader: 'ts',
                                };
                            },
                        );
                },
            },
        ],
    });
    for (const file of ['main.cjs', 'preload.cjs']) {
        if (options.pilot) {
            const { Script } = await import('node:vm');
            new Script(await fs.readFile(path.join(desktop, file), 'utf8'), { filename: file });
        } else await run(['--check', path.join(desktop, file)]);
    }
    admit();
    const metadata = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
    await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
            name: metadata.name,
            version: metadata.version,
            productName: metadata.productName,
            main: 'dist-electron/main.cjs',
        }),
    );

    return { root, metadata, downloads, profile };
}
export function nativePilotBuildLaunch(options: {
    profile: string;
    gcMode: string;
    coldStart?: boolean;
    workDeadlineMs?: number;
    pilot?: Record<string, any>;
}) {
    const require = createRequire(import.meta.url);
    const loader = pathToFileURL(require.resolve('tsx')).href;
    return {
        executable: process.execPath,
        args: [
            '--require',
            path.join(path.dirname(process.env.HUB_MEMORY_SSH_PROFILE!), 'preload.cjs'),
            '--import',
            loader,
            path.join(import.meta.dirname, 'native-pilot-build-worker.mts'),
            JSON.stringify({
                profile: options.profile,
                gcMode: options.gcMode,
                coldStart: options.coldStart,
                workDeadlineMs: options.workDeadlineMs,
                root: options.pilot!.root,
                nonce: options.pilot!.nonce,
            }),
        ],
        options: {
            cwd: path.resolve(import.meta.dirname, '../..'),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'] as const,
            env: { ...process.env, HUB_NATIVE_PILOT_STAGE: '1' },
        },
    };
}
export async function createProductNative(options: {
    signal?: AbortSignal;
    workDeadlineMs?: number;
    pilot?: Record<string, any>;
    startup?: NativePilotStartup;
    profile: string;
    gcMode: string;
    coldStart?: boolean;
    emit(stage: string, data: unknown): Promise<void>;
}) {
    const admit = productStartup(options);
    admit();
    if (!options.profile || !path.isAbsolute(options.profile))
        throw Error('Private product native profile must be an explicit absolute path.');
    if (!['normal', 'forced'].includes(options.gcMode))
        throw Error('Unsupported product native GC mode.');
    const require = createRequire(import.meta.url);
    let prepared;
    if (options.pilot) {
        options.pilot.check();
        assert(options.startup, 'Pilot startup owner required before build');
        const startup = options.startup;
        const launch = nativePilotBuildLaunch(options);
        const child = startup.spawn(
            'native-build-owner',
            () =>
                spawn(launch.executable, launch.args, {
                    ...launch.options,
                    stdio: [...launch.options.stdio],
                }),
            (c) => {
                if (c.connected) c.send({ kind: 'cancel-native-pilot-build' });
                else startup.options.hold('Build cancellation IPC unavailable');
            },
        );
        let result: any;
        let evidenceTask = Promise.resolve();
        child.on('message', (message: any) => {
            if (message?.kind === 'native-build-event')
                evidenceTask = evidenceTask
                    .then(() => options.emit(message.stage, message.data))
                    .then(() => {
                        if (child.connected) child.send({ kind: 'native-build-event-ack' });
                    })
                    .catch((e) => {
                        startup.options.hold(e);
                        throw e;
                    });
            if (message?.kind === 'native-build-result') result = message.result;
        });
        const row = startup.children.get(child)!;
        await row.closed;
        await evidenceTask;
        assert.equal(row.code, 0, 'Owned native build failed');
        assert(result, 'Native build receipt missing');
        prepared = result;
    } else prepared = await prepareProductNativeBuild(options);
    const { root, metadata, downloads, profile } = prepared;
    const exitFile = path.resolve(options.profile, '..', 'native-will-quit.json');
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
        ),
    ) as Record<string, string>;
    admit();
    const launchOptions = {
        chromiumSandbox: true,
        executablePath: options.pilot
            ? settledElectronExecutable(path.resolve(import.meta.dirname, '../..'), process.env)
            : require('electron'),
        args: [
            root,
            '--user-data-dir=' + path.resolve(options.profile),
            ...(options.gcMode === 'forced' ? ['--js-flags=--expose-gc'] : []),
        ],
        env: {
            ...environment,
            HUB_PRODUCT_NATIVE_EXIT: exitFile,
            HUB_PRODUCT_NATIVE_DOWNLOADS: downloads,
            ...(options.pilot
                ? { HUB_NATIVE_PILOT_PATHS: JSON.stringify(pilotEarlyAppPaths(options.pilot)) }
                : {}),
        },
        ...(options.pilot ? nativePilotLaunchRoutes(options.pilot) : {}),
    };
    const application = options.pilot
        ? await options.startup!.opaque(
              'playwright-electron-launch',
              () => _electron.launch(launchOptions),
              (app) => {
                  options.startup!.adopt('electron-main', app.process(), () => {
                      void app.close().catch((e) => options.startup!.options.hold(e));
                  });
              },
              (app) => app.close(),
          )
        : await _electron.launch(launchOptions);
    if (options.pilot) {
        const actual = await application.evaluate(() => (globalThis as any).__memoryPilotPaths);
        assert.deepEqual(actual, pilotEarlyAppPaths(options.pilot));
        await options.emit('native-early-paths', actual);
    }
    const child = application.process();
    const actualClose = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
    );
    const termination = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const joinExit = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                termination,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                Error(
                                    'Native process exit unverified after existing 10-second join bound.',
                                ),
                            ),
                        10000,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    };
    const sampler = new ProcessSampler([application.process().pid!]);
    let closed = false,
        captureExpected = false;
    let protocol: import('@playwright/test').CDPSession | undefined;
    const closeNative = async () => {
        let releaseSucceeded = false;
        await runNativeCleanup(
            [
                { name: 'pre-shutdown-history', run: () => sampler.sample() },
                {
                    name: 'detach-renderer-observer',
                    run: async () => {
                        await protocol?.detach();
                    },
                },
                {
                    name: 'request-actual-product-shutdown',
                    run: () =>
                        application.evaluate(() => {
                            (globalThis as any).__memoryNativeQuit.request();
                        }),
                },
                {
                    name: 'join-actual-product-shutdown-barrier',
                    run: async () => {
                        const deadline = Date.now() + 10000;
                        while (Date.now() < deadline) {
                            if (
                                await application.evaluate(() =>
                                    Boolean((globalThis as any).__memoryNativeQuit.ready),
                                )
                            )
                                return;
                            await new Promise((resolve) => setTimeout(resolve, 20));
                        }
                        throw Error(
                            'Actual product did not reach the private pre-release quit barrier.',
                        );
                    },
                },
                { name: 'pre-root-release-history', run: () => sampler.sample() },
                {
                    name: 'release-actual-root-quit',
                    run: async () => {
                        try {
                            await application.evaluate(() => {
                                (globalThis as any).__memoryNativeQuit.allow();
                            });
                            releaseSucceeded = true;
                        } finally {
                            if (!releaseSucceeded) await application.close();
                        }
                    },
                },
                {
                    name: 'observe-real-normal-exit',
                    run: async () => {
                        const ended = await joinExit();
                        if (ended.code !== 0 || ended.signal !== null)
                            throw Error('Native exit abnormal: ' + JSON.stringify(ended));
                        await options.emit('native-actual-exit', ended);
                        const close = await actualClose;
                        if (close.code !== ended.code || close.signal !== ended.signal)
                            throw Error('Native actual close disagrees with exit.');
                        await options.emit('native-actual-close', close);
                    },
                },
                { name: 'observe-all-descendant-exits', run: () => sampler.assertExited() },
                {
                    name: 'validate-final-product-shutdown',
                    run: async () => {
                        const receipt = JSON.parse(await fs.readFile(exitFile, 'utf8'));
                        const verdict = assertProductNativeShutdown(receipt.snapshot, {
                            captureExpected,
                            downloads: receipt.downloads,
                        });
                        await options.emit('native-will-quit', { ...receipt, verdict });
                    },
                },
            ],
            options.emit,
        );
        closed = true;
    };
    try {
        await sampler.sample();
        admit();
        if (
            child.spawnargs.some((arg) =>
                /(?:^|[\s"'])--(?:no-sandbox|disable-setuid-sandbox)(?:=|[\s"']|$)/.test(arg),
            )
        )
            throw Error('Private product native launch disabled the OS sandbox.');
        admit();
        const page = await application.firstWindow();
        admit();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await application.evaluate(() => {
            const downloads = (globalThis as any).__memoryNativeDownloads;
            if (!downloads?.ready)
                throw Error('Private native download observer failed: ' + String(downloads?.error));
        });

        const errors: string[] = [];
        page.on('pageerror', (error) => {
            if (errors.length < 32) errors.push(error.message);
        });
        await page.waitForFunction(() =>
            Boolean(window.memoryProduct && window.memoryProductLedger),
        );
        admit();
        protocol = await page.context().newCDPSession(page);
        admit();
        const rendererProtocol = protocol;
        const workers = new Set<import('@playwright/test').Worker>();
        page.on('worker', (worker) => {
            workers.add(worker);
            worker.once('close', () => workers.delete(worker));
        });
        const snapshot = async () => {
            const result = await application.evaluate(() => {
                const probe = (globalThis as any).__memoryNativeQualification;
                if (!probe) throw Error('Native product probe unavailable.');
                return probe.snapshot();
            });
            captureExpected ||= Boolean(result.capture);
            return result;
        };
        await reportStartupIdentity(options.emit, 'actual-native-product', {
            version: metadata.version,
            process: application.process().pid,
            preferences: await application.evaluate(({ BrowserWindow }) => {
                const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
                    getLastWebPreferences?: () => Record<string, unknown>;
                };
                if (typeof contents.getLastWebPreferences !== 'function')
                    throw Error('Actual Electron web preferences inspection unavailable.');
                return contents.getLastWebPreferences();
            }),
            sshProfile: profile,
            initial: await snapshot(),
        });
        return {
            page,
            root,
            version: metadata.version,
            application,
            async reportDownload(
                extension: string,
                action: () => Promise<void>,
                validate?: (bytes: Buffer) => unknown,
            ) {
                if (!['json', 'csv', 'md', 'txt'].includes(extension))
                    throw Error('Unknown native report format.');
                const file = path.join(downloads, 'report-' + cryptoRandomId() + '.' + extension);
                try {
                    await fs.lstat(file);
                    throw Error('Private native report output already exists.');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
                await application.evaluate(
                    (_electron, file) =>
                        (globalThis as any).__memoryNativeQualification.prepareReport(file),
                    file,
                );
                await action();
                const bound = Date.now() + 10000;
                while (true) {
                    const status = await application.evaluate(() =>
                        (globalThis as any).__memoryNativeQualification.reportStatus(),
                    );
                    if (status?.invoked && (await snapshot()).capture?.owners.export === 0) break;
                    if (Date.now() >= bound)
                        throw Error('Actual native report export did not join.');
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                const receipt = await application.evaluate(() =>
                    (globalThis as any).__memoryNativeQualification.finishReport(),
                );
                if (!receipt.invoked || receipt.file !== file)
                    throw Error('Native trusted destination was not invoked.');
                const stat = await fs.lstat(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 ** 2)
                    throw Error('Native report file is invalid/oversized.');
                const bytes = await fs.readFile(file);
                await options.emit('actual-native-results-file', {
                    ...receipt,
                    bytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex'),
                    scope: 'Actual UI/IPC/native store/export writer; private deterministic trusted-main destination replaces only Save selection, not the report pipeline.',
                });
                if (validate) {
                    await validate(bytes);
                    await fs.unlink(file);
                    await options.emit('native-artifact-retired', {
                        file,
                        reason: 'semantic validation acknowledged',
                        bytes: bytes.length,
                    });
                }
                return bytes;
            },
            async prepareHeldReport() {
                const file = path.join(downloads, 'held-' + cryptoRandomId() + '.json');
                await application.evaluate(
                    (_electron, file) =>
                        (globalThis as any).__memoryNativeQualification.prepareReport(file, true),
                    file,
                );
                return file;
            },
            async reportStatus() {
                return application.evaluate(() =>
                    (globalThis as any).__memoryNativeQualification.reportStatus(),
                );
            },
            async releaseReport(decision: 'save' | 'cancel') {
                await application.evaluate(
                    (_electron, decision) =>
                        (globalThis as any).__memoryNativeQualification.releaseReport(decision),
                    decision,
                );
            },
            async finishReport() {
                return application.evaluate(() =>
                    (globalThis as any).__memoryNativeQualification.finishReport(),
                );
            },
            async releaseQualificationHolds() {
                await application.evaluate(() =>
                    (globalThis as any).__memoryNativeQualification.releaseHolds(),
                );
            },
            readFault: {
                realm: 'native-main' as const,
                quotaMessage: 'Private synthetic export read quota control.',
                async arm(action: 'hold' | 'quota') {
                    await application.evaluate(
                        (_electron, action) =>
                            (globalThis as any).__memoryNativeQualification.readFault.arm(action),
                        action,
                    );
                },
                async status() {
                    const value = await application.evaluate(() =>
                        (globalThis as any).__memoryNativeQualification.readFault.status(),
                    );
                    if (!value) throw Error('Native actual read fault absent.');
                    return { method: 'read' as const, ...value };
                },
                async release() {
                    await application.evaluate(() =>
                        (globalThis as any).__memoryNativeQualification.readFault.release(),
                    );
                },
                async clear() {
                    await application.evaluate(() =>
                        (globalThis as any).__memoryNativeQualification.readFault.clear(),
                    );
                },
                snapshot,
            },
            async consumeFailedDownloads() {
                return application.evaluate(() => {
                    const records = (globalThis as any).__memoryNativeDownloads.records as {
                        state: string;
                    }[];
                    if (records.some((row) => !['cancelled', 'interrupted'].includes(row.state)))
                        throw Error(
                            'Native failure export has a live or successful unexpected download.',
                        );
                    return records.splice(0);
                });
            },
            async visibility(hidden: boolean): Promise<AggregateWindowTransition> {
                const observe = () =>
                    application.evaluate(({ BrowserWindow }) => {
                        const windows = BrowserWindow.getAllWindows();
                        if (windows.length !== 1)
                            throw Error('Native actual window identity is ambiguous.');
                        const win = windows[0],
                            activity = (globalThis as any).__memoryProductActivity;
                        const contents = win.webContents as any;
                        if (
                            !activity ||
                            typeof activity.lease !== 'string' ||
                            typeof contents.getBackgroundThrottling !== 'function'
                        )
                            throw Error(
                                'Actual native activity/throttling observation unavailable.',
                            );
                        return {
                            windowId: win.id,
                            minimized: win.isMinimized(),
                            lease: activity.lease as string,
                            backgroundThrottling: contents.getBackgroundThrottling() as boolean,
                        };
                    });
                const before = await observe();
                await application.evaluate(({ BrowserWindow }, hidden) => {
                    const windows = BrowserWindow.getAllWindows();
                    if (windows.length !== 1)
                        throw Error('Native actual window identity is ambiguous.');
                    if (hidden) windows[0].minimize();
                    else windows[0].restore();
                }, hidden);
                await expect
                    .poll(async () => (await observe()).minimized, { timeout: 10000 })
                    .toBe(hidden);
                const after = await observe();
                if (after.windowId !== before.windowId)
                    throw Error('Native window identity changed during transition.');
                return {
                    kind: 'native',
                    requestedHidden: hidden,
                    windowId: after.windowId,
                    nativeWindowState: after.minimized ? 'minimized' : 'normal',
                    documentVisibility: await page.evaluate(() => document.visibilityState),
                    activityLeaseHeld: Boolean(after.lease),
                    leaseRetained: Boolean(before.lease) && before.lease === after.lease,
                    backgroundThrottling: after.backgroundThrottling,
                };
            },
            async download(
                format: string,
                action: () => Promise<void>,
                validate?: (bytes: Buffer) => unknown,
            ) {
                const ordinal = await application.evaluate(
                    () => (globalThis as any).__memoryNativeDownloads.next as number,
                );
                await action();
                const deadline = Date.now() + 30000;
                let record:
                    | { name: string; file: string; state: string; receivedBytes: number }
                    | undefined;
                while (Date.now() < deadline) {
                    record = await application.evaluate(
                        (_electron, index) =>
                            (globalThis as any).__memoryNativeDownloads.records.find(
                                (row: { ordinal: number }) => row.ordinal === index,
                            ),
                        ordinal,
                    );
                    if (record && record.state !== 'started') break;
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                if (!record || record.state !== 'completed') {
                    await options.emit('native-download-failure-context', {
                        observed: await application.evaluate(() => ({
                            records: (globalThis as any).__memoryNativeDownloads.records,
                            navigations: (globalThis as any).__memoryNativeDownloads.navigations,
                        })),
                        rendererErrors: [...errors],
                        exportStatus: await page
                            .getByRole('status', { name: 'Flow export status' })
                            .allTextContents(),
                    });
                    throw Error(
                        'Native download did not complete: ' + JSON.stringify(record ?? null),
                    );
                }
                if (!record.name.toLowerCase().endsWith('.' + format.toLowerCase()))
                    throw Error('Unexpected native download name.');
                const bytes = await fs.readFile(record.file);
                if (bytes.length !== record.receivedBytes)
                    throw Error('Native download byte receipt mismatch.');
                await options.emit('actual-native-download', record);
                await application.evaluate((_electron, index) => {
                    const records = (globalThis as any).__memoryNativeDownloads.records as {
                        ordinal: number;
                        state: string;
                    }[];
                    const position = records.findIndex((row) => row.ordinal === index);
                    if (position < 0 || records[position].state !== 'completed')
                        throw Error(
                            'Native completed download receipt changed before consumption.',
                        );
                    records.splice(position, 1);
                }, ordinal);
                if (validate) {
                    await validate(bytes);
                    await fs.unlink(record.file);
                    await options.emit('native-artifact-retired', {
                        file: record.file,
                        bytes: bytes.length,
                        reason: 'viewer semantic validation acknowledged',
                    });
                }
                return bytes;
            },
            snapshot,
            errors: () => [...errors],
            async joinDedicatedWorkers() {
                await Promise.all(
                    [...workers].map((worker) => worker.waitForEvent('close', { timeout: 10000 })),
                );
                if (workers.size) throw Error('Native dedicated worker close event missing.');
            },
            sampleProcessHistory: () => sampler.sample(),
            async sample(input?: { quiescent: boolean; forceGc: boolean }) {
                if (closed) return sampler.sample();
                if (input?.forceGc) {
                    await application.evaluate(() => {
                        if (typeof (globalThis as any).gc !== 'function')
                            throw Error('Native main forced GC unavailable.');
                        (globalThis as any).gc();
                    });
                    await rendererProtocol.send('HeapProfiler.collectGarbage');
                }
                const rows: ProcessSample[] = await sampler.sample();
                const memory = await application.evaluate(() => ({
                    pid: process.pid,
                    memory: process.memoryUsage(),
                }));
                const main = rows.find((row) => row.pid === memory.pid && row.state === 'running');
                if (!main) throw Error('Native main identity unavailable.');
                Object.assign(main, {
                    role: 'electron-main',
                    heapUsedBytes: memory.memory.heapUsed,
                    externalBytes: memory.memory.external,
                    arrayBuffersBytes: memory.memory.arrayBuffers,
                    unsupported: [],
                });
                const metrics = await application.evaluate(({ app }) => app.getAppMetrics());
                for (const metric of metrics) {
                    const row = rows.find(
                        (row) => row.pid === metric.pid && row.state === 'running',
                    );
                    if (row && row !== main) row.role = 'electron-' + metric.type;
                }
                const binding = await application.evaluate(({ BrowserWindow }) => {
                    const windows = BrowserWindow.getAllWindows();
                    if (windows.length !== 1)
                        throw Error(
                            'Native renderer allocation attribution requires exactly the actual host window.',
                        );
                    return {
                        pid: windows[0].webContents.getOSProcessId(),
                        webContentsId: windows[0].webContents.id,
                        url: windows[0].webContents.getURL(),
                    };
                });
                if (binding.url !== page.url())
                    throw Error('Native renderer attribution URL differs from the actual page.');
                const renderer = rows.find(
                    (row) => row.pid === binding.pid && row.state === 'running',
                );
                if (!renderer) throw Error('Actual native renderer PID/creation sample absent.');
                const allocation = await rendererProtocol.send('Runtime.getHeapUsage');
                Object.assign(renderer, {
                    role: 'electron-renderer',
                    heapUsedBytes: allocation.usedSize,
                    externalBytes: null,
                    arrayBuffersBytes: null,
                    unsupported: [
                        'Renderer external and Node ArrayBuffers split unavailable. CDP backingStorageSize is separately reported, never aliased.',
                    ],
                });
                await options.emit('native-renderer-allocation', {
                    binding,
                    ...allocation,
                    units: 'bytes',
                    scope: 'CDP backingStorageSize is distinct from Node ArrayBuffers; no fabricated split',
                });
                return rows;
            },
            async close() {
                if (closed) return;
                await closeNative();
            },
            async assertExited() {
                if (!closed) throw Error('Native cleanup not verified.');
                await sampler.assertExited();
            },
        };
    } catch (error) {
        try {
            await closeNative();
            await options.emit('native-startup-failure-cleanup', { verified: true });
        } catch (cleanupError) {
            await options.emit('native-startup-cleanup-failure', {
                original: String(error),
                cleanup: String(cleanupError),
                verified: false,
            });
            throw new AggregateError(
                [error, cleanupError],
                'Native startup failed; cleanup could not be verified.',
            );
        }
        throw error;
    }
}
