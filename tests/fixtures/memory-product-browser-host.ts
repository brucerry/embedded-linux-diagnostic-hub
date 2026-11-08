import { productStartup } from './memory-product-startup';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { execFile, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, firefox, webkit, type Page } from '@playwright/test';
import { ProcessSampler } from './memory-resource-processes';
import type { ProcessSample } from './memory-resource-verdict';
import type {} from './memory-product-app';
import { runNativeCleanup } from './memory-product-native-cleanup';
import type { AggregateWindowTransition } from './memory-product-aggregate-contract';
import { BrowserDownloadEvents, createBrowserDownloads } from './memory-product-browser-downloads';
import { createProductParentClosureWitness } from './memory-product-parent-closure';
import {
    createBrowserInspectionHost,
    type BrowserInspectionCleanup,
} from './memory-product-inspection-host';

/** Runs the real App, compiled by the product Vite config with constructor probes only. */
export async function createProductBrowser(options: {
    signal?: AbortSignal;
    workDeadlineMs?: number;
    profile: string;
    gcMode: string;
    engine?: string;
    coldStart?: boolean;
    headless?: boolean;
    windowSemantics?: 'native';
    observeRoot?(child: ChildProcess): Promise<void>;
    emit(stage: string, data: unknown): Promise<void>;
}) {
    const admit = productStartup(options);
    admit();
    if (!options.profile || !path.isAbsolute(options.profile))
        throw Error('Private product browser profile must be an explicit absolute path.');
    // Validate unsupported lanes before allocating build children, directories or listeners.
    const engine = options.engine ?? 'chromium';
    const type = { chromium, firefox, webkit }[engine];
    if (!type || !Object.hasOwn({ chromium, firefox, webkit }, engine))
        throw Error('Unsupported product browser engine.');
    if (!['normal', 'forced'].includes(options.gcMode))
        throw Error('Unsupported product browser GC mode.');
    if (options.gcMode === 'forced' && type !== chromium)
        throw Error('This product host cannot force GC in Firefox/WebKit.');
    if (options.windowSemantics && (type !== chromium || options.headless !== false))
        throw Error('Unemulated native-window observations require owned headful Chromium.');
    const sourceRoot = path.resolve(import.meta.dirname, '../..');
    const root = path.resolve(options.profile, '..', 'product-build');
    await fs.mkdir(root, { recursive: true });
    admit();
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
    const build = await new Promise<{ stdout: string; stderr: string }>(
        (resolve, reject) => (
            admit(),
            execFile(
                process.execPath,
                [
                    cli,
                    'build',
                    '--mode',
                    'web',
                    '--config',
                    'tests/fixtures/memory-product.vite.mts',
                ],
                {
                    cwd: sourceRoot,
                    windowsHide: true,
                    timeout: 60000,
                    maxBuffer: 1024 ** 2,
                    env: {
                        ...process.env,
                        HUB_PRODUCT_BUILD_OUT: root,
                        HUB_PRODUCT_AGGREGATE_COLD_START: options.coldStart ? '1' : '0',
                    },
                },
                (error, stdout, stderr) =>
                    error
                        ? reject(Object.assign(error, { stdout, stderr }))
                        : resolve({ stdout, stderr }),
            )
        ),
    );
    await options.emit('private-production-build', {
        ...build,
        entry: 'actual App with exact-preimage constructor probes',
        cli,
    });
    admit();
    const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
    };
    const sockets = new Set<import('node:net').Socket>();
    const socketClosures = new Set<Promise<void>>();
    const proxyRequests = new Set<http.ClientRequest>();
    let gatewayTarget: URL | undefined;
    admit();
    const server = http.createServer(async (request, response) => {
        const relative = decodeURIComponent(
            new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
        );
        if (relative.startsWith('/api/')) {
            if (!gatewayTarget) {
                response.writeHead(503).end();
                return;
            }
            const target = new URL(request.url ?? '/', gatewayTarget);
            const upstream = http.request(
                target,
                {
                    method: request.method,
                    headers: {
                        ...request.headers,
                        host: target.host,
                        origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
                    },
                },
                (incoming) => {
                    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
                    incoming.pipe(response);
                    incoming.once('error', () => response.destroy());
                },
            );
            proxyRequests.add(upstream);
            upstream.once('close', () => proxyRequests.delete(upstream));
            upstream.once('error', (error) => response.destroy(error));
            request.once('aborted', () => upstream.destroy());
            response.once('close', () => {
                if (!response.writableFinished) upstream.destroy();
            });
            request.pipe(upstream);
            return;
        }
        const file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
        if (!file.startsWith(root + path.sep)) {
            response.writeHead(403).end();
            return;
        }
        try {
            const data = await fs.readFile(file);
            response.setHeader(
                'Content-Type',
                types[path.extname(file)] ?? 'application/octet-stream',
            );
            response.setHeader('Cache-Control', 'no-store');
            response.end(data);
        } catch {
            response.writeHead(404).end();
        }
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        const closed = new Promise<void>((resolve) =>
            socket.once('close', () => {
                sockets.delete(socket);
                resolve();
            }),
        );
        socketClosures.add(closed);
        void closed.finally(() => socketClosures.delete(closed));
    });
    let launched: Awaited<ReturnType<typeof type.launchServer>> | undefined;
    let browser: Awaited<ReturnType<typeof type.connect>> | undefined;
    let sampler: ProcessSampler | undefined;
    let actualDownloads: Awaited<ReturnType<typeof createBrowserDownloads>> | undefined;
    const downloadJournal = new BrowserDownloadEvents();
    let nativeEndpoint: string | undefined;
    let inspection: Awaited<ReturnType<typeof createBrowserInspectionHost>> | undefined;
    let inspectionCleanup: BrowserInspectionCleanup | undefined;
    let requireInspectionReady: (() => void) | undefined;
    let closed = false;
    let launchAttempted = false;
    const closeServer = async () => {
        const failures: unknown[] = [];
        const closing = new Promise<void>((resolve, reject) =>
            server.close((error) =>
                error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
                    ? reject(error)
                    : resolve(),
            ),
        );
        for (const action of [
            () => server.closeAllConnections(),
            ...[...proxyRequests].map((request) => () => request.destroy()),
        ])
            try {
                action();
            } catch (error) {
                failures.push(error);
            }
        try {
            await closing;
        } catch (error) {
            failures.push(error);
        }
        await Promise.all([...socketClosures]);
        if (sockets.size) failures.push(Error('Private HTTP socket close is not acknowledged.'));
        if (proxyRequests.size)
            failures.push(Error('Private proxy upstream close is not acknowledged.'));
        if (failures.length)
            throw new AggregateError(failures, 'Private server cleanup unverified.');
    };
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            admit();
            server.listen(0, '127.0.0.1', resolve);
        });
        admit();
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        admit();
        launchAttempted = true;
        launched = await type.launchServer({
            headless: options.headless ?? true,
            ...(type === chromium ? { chromiumSandbox: true } : {}),
            ...(options.windowSemantics
                ? { args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] }
                : {}),
        });
        sampler = new ProcessSampler([launched.process().pid!]);
        await options.observeRoot?.(launched.process());
        // Observe the owned root/children before connecting or executing any page script.
        await sampler.sample();
        admit();
        if (
            launched
                .process()
                .spawnargs.some((arg) =>
                    /(?:^|[\s"'])--(?:no-sandbox|disable-setuid-sandbox)(?:=|[\s"']|$)/.test(arg),
                )
        )
            throw Error('Private product browser launch disabled the OS sandbox.');
        const downloads = path.join(root, 'downloads');
        if (options.windowSemantics) {
            // Playwright normally enables focus emulation in every new context. A second
            // session cannot revoke that first session's override. Use the documented
            // noDefaults connection on this newly launched, private default context.
            const profiles = launched
                .process()
                .spawnargs.filter((arg) => arg.startsWith('--user-data-dir='));
            if (profiles.length !== 1) throw Error('Owned Chrome profile identity is ambiguous.');
            const profile = profiles[0].slice('--user-data-dir='.length);
            if (!path.isAbsolute(profile))
                throw Error('Owned Chrome profile path is not absolute.');
            const descriptor = path.join(profile, 'DevToolsActivePort');
            const deadline = performance.now() + 10000;
            let endpoint: string | undefined;
            do {
                try {
                    const stat = await fs.lstat(descriptor);
                    if (
                        !stat.isFile() ||
                        stat.isSymbolicLink() ||
                        stat.nlink !== 1 ||
                        stat.size > 4096
                    )
                        throw Error('Invalid owned Chrome endpoint descriptor.');
                    const [port, pathname] = (await fs.readFile(descriptor, 'utf8'))
                        .trim()
                        .split(/\r?\n/);
                    if (
                        !/^\d+$/.test(port) ||
                        Number(port) < 1 ||
                        Number(port) > 65535 ||
                        !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(pathname)
                    )
                        throw Error('Malformed owned Chrome endpoint descriptor.');
                    endpoint = `ws://127.0.0.1:${port}${pathname}`;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
                if (!endpoint) await new Promise((resolve) => setTimeout(resolve, 100));
            } while (!endpoint && performance.now() < deadline);
            if (!endpoint) throw Error('Owned Chrome endpoint did not acknowledge within10000ms.');
            nativeEndpoint = endpoint;
            admit();
            await fs.mkdir(downloads, { recursive: true });
            admit();
            browser = await chromium.connectOverCDP(endpoint, {
                noDefaults: true,
                artifactsDir: downloads,
                timeout: 10000,
            });
        } else {
            admit();
            browser = await type.connect(launched.wsEndpoint());
        }
        admit();
        const contexts = browser.contexts();
        if (options.windowSemantics && contexts.length !== 1)
            throw Error('Owned default context identity is ambiguous.');
        admit();
        let context = options.windowSemantics
            ? contexts[0]
            : await browser.newContext({
                  acceptDownloads: true,
                  viewport: { width: 1280, height: 900 },
                  reducedMotion: 'reduce',
              });
        admit();
        let page: Page = await context.newPage();
        admit();
        const parents = new Map<Page, ReturnType<typeof createProductParentClosureWitness>>();
        const retainParent = (boundPage: Page, boundBrowser: NonNullable<typeof browser>) => {
            if (parents.has(boundPage)) return;
            assert.ok(parents.size < 17, 'Bounded reconnect page inventory exceeded.');
            parents.set(
                boundPage,
                createProductParentClosureWitness({
                    page: boundPage,
                    hostId: `owned-browser-root/${launched!.process().pid}`,
                    hostCleanupVerified: () => closed,
                    pageClosed: () => boundPage.isClosed(),
                    connectionClosed: () => !boundBrowser.isConnected(),
                    joinProcessHistory: () => sampler!.assertExited(),
                }),
            );
        };
        retainParent(page, browser);
        if (options.windowSemantics) {
            await page.setViewportSize({ width: 1280, height: 900 });
            await page.emulateMedia({ reducedMotion: 'reduce' });
        }
        const liveWorkers = new Set<import('@playwright/test').Worker>();
        const addedWorker = (worker: import('@playwright/test').Worker) => {
            liveWorkers.add(worker);
            worker.once('close', () => liveWorkers.delete(worker));
        };
        const failures: string[] = [];
        const webError = (error: import('@playwright/test').WebError) => {
            if (failures.length < 32)
                failures.push('Context/worker error: ' + error.error().message);
        };
        const pageError = (error: Error) => {
            if (failures.length < 32) failures.push(error.message);
        };
        const bindEvents = (boundPage: Page, boundContext: typeof context) => {
            boundPage.on('worker', addedWorker);
            for (const worker of boundPage.workers()) addedWorker(worker);
            boundContext.on('weberror', webError);
            boundPage.on('pageerror', pageError);
        };
        const detachEvents = (boundPage: Page, boundContext: typeof context) => {
            boundPage.off('worker', addedWorker);
            boundContext.off('weberror', webError);
            boundPage.off('pageerror', pageError);
        };
        bindEvents(page, context);
        admit();
        await page.goto(origin);
        admit();
        await page.waitForFunction(() => Boolean(window.memoryProduct));
        admit();
        admit();
        let protocol = type === chromium ? await context.newCDPSession(page) : undefined;
        admit();
        let rootProtocol = type === chromium ? await browser.newBrowserCDPSession() : undefined;
        admit();
        if (options.windowSemantics) {
            if (!rootProtocol || !protocol)
                throw Error('Owned browser download transport unavailable.');
            actualDownloads = await createBrowserDownloads({
                root: rootProtocol,
                page: protocol,
                directory: downloads,
                emit: options.emit,
                journal: downloadJournal,
            });
        }
        await options.emit('actual-product-browser', {
            engine: options.engine ?? 'chromium',
            version: browser.version(),
            origin,
            pid: launched.process().pid,
            windowSemantics: options.windowSemantics
                ? 'native private default context; Playwright focus override not installed'
                : 'Playwright default focus/media emulation',
            scope: 'actual production App and product modules; private entry/constructor probes; synthetic local Serial only',
        });
        return {
            get page() {
                requireInspectionReady?.();
                return page;
            },
            pageForCleanup: () => page,
            bindInspectionAdmission(check: () => void) {
                assert.equal(requireInspectionReady, undefined);
                requireInspectionReady = check;
            },
            async createInspection(record: (stage: string, value: unknown) => void) {
                assert.equal(
                    inspectionCleanup,
                    undefined,
                    'Inspection host already owns an initialization.',
                );
                assert.ok(
                    nativeEndpoint &&
                        options.windowSemantics &&
                        protocol &&
                        rootProtocol &&
                        actualDownloads,
                );
                admit();
                inspection = await createBrowserInspectionHost({
                    assertAdmissible: admit,
                    initial: {
                        page,
                        context,
                        browser: browser!,
                        pageProtocol: protocol,
                        rootProtocol,
                    },
                    endpoint: nativeEndpoint,
                    origin,
                    directory: downloads,
                    journal: downloadJournal,
                    monitor: actualDownloads,
                    rootChild: launched!.process(),
                    emit: options.emit,
                    record,
                    retainParent,
                    detachEvents,
                    bindEvents,
                    workers: () => liveWorkers.size,
                    errors: () => [...failures],
                    install(value) {
                        page = value.page;
                        context = value.context;
                        browser = value.browser;
                        protocol = value.pageProtocol;
                        rootProtocol = value.rootProtocol;
                    },
                    clearProtocols() {
                        protocol = undefined;
                        rootProtocol = undefined;
                    },
                    installMonitor(value) {
                        actualDownloads = value;
                    },
                    pruneParents(activePage) {
                        for (const old of parents.keys())
                            if (old !== activePage) parents.delete(old);
                    },
                    retainCleanup(owner) {
                        inspectionCleanup = owner;
                    },
                });
                return inspection;
            },
            origin,
            proxyGateway(url: string) {
                const target = new URL(url);
                if (
                    target.protocol !== 'http:' ||
                    target.hostname !== '127.0.0.1' ||
                    target.pathname !== '/' ||
                    target.username ||
                    target.password ||
                    target.search ||
                    target.hash
                )
                    throw Error('Private proxy accepts only the owned loopback gateway origin.');
                if (gatewayTarget || proxyRequests.size)
                    throw Error('Private gateway proxy identity is already fixed.');
                gatewayTarget = target;
            },
            version: browser.version(),
            root,
            get download() {
                requireInspectionReady?.();
                return actualDownloads?.download;
            },
            get downloadCount() {
                return actualDownloads?.count;
            },
            get downloadSnapshot() {
                return actualDownloads?.snapshot;
            },
            async visibility(hidden: boolean): Promise<AggregateWindowTransition> {
                requireInspectionReady?.();
                if (!protocol)
                    throw Error(
                        'Actual browser window visibility control is unavailable for this engine.',
                    );
                if (!options.windowSemantics)
                    throw Error(
                        'Actual window visibility requires a connection without Playwright focus emulation.',
                    );
                const window = await protocol.send('Browser.getWindowForTarget');
                await protocol.send('Browser.setWindowBounds', {
                    windowId: window.windowId,
                    bounds: { windowState: hidden ? 'minimized' : 'normal' },
                });
                await page.waitForFunction(
                    (hidden) => document.visibilityState === (hidden ? 'hidden' : 'visible'),
                    hidden,
                    { timeout: 10000, polling: 100 },
                );
                const actual = await protocol.send('Browser.getWindowBounds', {
                    windowId: window.windowId,
                });
                return {
                    kind: 'browser',
                    requestedHidden: hidden,
                    windowId: window.windowId,
                    nativeWindowState: actual.bounds.windowState ?? 'unavailable',
                    documentVisibility: await page.evaluate(() => document.visibilityState),
                    activityLeaseHeld: null,
                    leaseRetained: null,
                    backgroundThrottling: null,
                };
            },
            sampleProcessHistory: () => sampler!.sample(),
            async sample(input?: { quiescent: boolean; forceGc: boolean }) {
                if (closed) return sampler!.sample();
                requireInspectionReady?.();
                if (input?.forceGc) {
                    if (!protocol) throw Error('Forced renderer GC unavailable.');
                    await protocol.send('HeapProfiler.collectGarbage');
                }
                const rows: ProcessSample[] = await sampler!.sample();
                if (rootProtocol && protocol) {
                    const info = await rootProtocol.send('SystemInfo.getProcessInfo');
                    const renderers = info.processInfo.filter((row) => row.type === 'renderer');
                    const heap = await protocol.send('Runtime.getHeapUsage');
                    for (const row of rows) {
                        const detail = info.processInfo.find((p) => p.id === row.pid);
                        if (detail) row.role = 'browser-' + detail.type;
                        if (
                            renderers.length === 1 &&
                            row.pid === renderers[0].id &&
                            row.state === 'running'
                        ) {
                            row.heapUsedBytes = heap.usedSize;
                            row.unsupported = [
                                'CDP has no Node external/ArrayBuffer allocation split; backingStorageSize is recorded separately',
                            ];
                        }
                    }
                    await options.emit('actual-renderer-heap', {
                        ...heap,
                        units: 'bytes',
                        rendererPid: renderers.length === 1 ? renderers[0].id : null,
                        attribution:
                            renderers.length === 1
                                ? 'single renderer identity in owned browser'
                                : 'ambiguous renderer PID; no heap assigned to process rows',
                    });
                }
                return rows;
            },
            async close() {
                if (closed) return;
                await runNativeCleanup(
                    [
                        { name: 'pre-shutdown-history', run: () => sampler!.sample() },
                        {
                            name: 'detach-page-protocol',
                            run: async () =>
                                inspectionCleanup
                                    ? inspectionCleanup.closeProtocols()
                                    : protocol?.detach(),
                        },
                        {
                            name: 'detach-root-protocol',
                            run: async () => {
                                if (!inspectionCleanup) await rootProtocol?.detach();
                            },
                        },
                        {
                            name: 'close-passive-metadata-before-native-parent',
                            run: async () => inspectionCleanup?.closeMetadata(),
                        },
                        {
                            name: 'close-context',
                            run: async () => {
                                if (browser?.isConnected()) await context.close();
                            },
                        },
                        {
                            name: 'close-browser',
                            run: async () =>
                                inspectionCleanup
                                    ? inspectionCleanup.closeConnections()
                                    : browser!.close(),
                        },
                        { name: 'close-launched-root', run: () => launched!.close() },
                        { name: 'close-server-and-sockets', run: closeServer },
                        { name: 'join-descendant-exits', run: () => sampler!.assertExited() },
                        {
                            name: 'release-download-observers-after-exit',
                            run: async () =>
                                inspectionCleanup
                                    ? inspectionCleanup.releaseAfterRootExit()
                                    : actualDownloads?.releaseAfterBrowserExit(),
                        },
                    ],
                    options.emit,
                    { stage: 'browser-cleanup-step' },
                );
                if (sockets.size)
                    throw Error(
                        `Static product host retained ${sockets.size} sockets after close.`,
                    );
                closed = true;
            },
            async assertExited() {
                if (!closed) throw Error('Product browser cleanup not verified.');
                await sampler!.assertExited();
            },
            joinParentClosure: (boundPage: Page = page) => {
                const witness = parents.get(boundPage);
                assert.ok(witness, 'Unknown actual parent wrapper.');
                return witness.join();
            },
            errors() {
                return [...failures];
            },
            dedicatedWorkers() {
                return liveWorkers.size;
            },
            async joinDedicatedWorkers() {
                await Promise.all(
                    [...liveWorkers].map((worker) =>
                        worker.waitForEvent('close', { timeout: 10000 }),
                    ),
                );
                if (liveWorkers.size) throw Error('Dedicated worker close event is missing.');
            },
        };
    } catch (error) {
        try {
            await runNativeCleanup(
                [
                    {
                        name: 'startup-history',
                        run: async () => {
                            if (sampler) await sampler.sample();
                        },
                    },
                    { name: 'close-connected-browser', run: async () => browser?.close() },
                    { name: 'close-launched-root', run: async () => launched?.close() },
                    { name: 'close-server-and-sockets', run: closeServer },
                    {
                        name: 'join-startup-descendants',
                        run: async () => {
                            if (sampler) await sampler.assertExited();
                            else if (launchAttempted)
                                throw Error(
                                    'Browser launch did not provide an observed root/history; cleanup is unverified.',
                                );
                        },
                    },
                ],
                options.emit,
                { stage: 'browser-startup-cleanup-step' },
            );
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                `Browser startup failed; cleanup unverified for root ${launched?.process().pid ?? 'unknown'}. Preserve the owned coordination marker and observed history.`,
            );
        }
        throw error;
    }
}
