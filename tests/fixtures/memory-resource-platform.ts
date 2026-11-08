import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { chromium, firefox, webkit, _electron, type Page, type CDPSession } from '@playwright/test';
import { build } from 'esbuild';
import { isolatedGateway } from './memory-resource-gateway-process';
import { sshQualificationProfile } from './memory-resource-ssh-profile';
import { soakCoverage, type QualificationDriver } from './memory-resource-core';
import { ProcessSampler } from './memory-resource-processes';
import type {} from './memory-resource-browser';

/** Runnable component driver. Full product adapter must add all missing coverage/owner probes. */
export async function createQualificationDriver(context: {
    lane: string;
    gcMode: string;
    profile: string;
    emit(stage: string, data: unknown): Promise<void>;
}): Promise<QualificationDriver> {
    const root = path.resolve(context.profile, '..', 'fixture');
    await fs.mkdir(root, { recursive: true });
    const require = createRequire(import.meta.url),
        sourceRoot = path.resolve(import.meta.dirname, '../..');
    if (context.lane === 'gateway')
        await context.emit('ssh-runtime', await sshQualificationProfile());
    const bundle = async (
        entry: string,
        outfile: string,
        platform: 'node' | 'browser',
        external: string[] = [],
    ) =>
        build({
            entryPoints: [path.join(sourceRoot, entry)],
            bundle: true,
            platform,
            format: platform === 'node' ? 'cjs' : 'iife',
            outfile: path.join(root, outfile),
            external,
            nodePaths: (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean),
        });
    await bundle('tests/fixtures/memory-resource-browser.ts', 'renderer.js', 'browser');
    await fs.writeFile(
        path.join(root, 'index.html'),
        '<!doctype html><meta charset="utf-8"><title>Private memory component fixture</title><script src="./renderer.js"></script>',
    );
    let page: Page, close: () => Promise<void>, sampler: ProcessSampler;
    let electronApplication: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let server: http.Server | undefined,
        loopback: Awaited<ReturnType<typeof isolatedGateway>> | undefined;
    let browserVersion = '',
        protocol: CDPSession | undefined;
    const cleanup: (() => Promise<void>)[] = [];
    let chromiumProtocol = context.lane === 'desktop';
    try {
        if (context.lane === 'desktop') {
            await bundle('tests/fixtures/capture-electron-main.ts', 'main.cjs', 'node', [
                'electron',
            ]);
            await bundle('electron/preload.ts', 'preload.cjs', 'node', ['electron']);
            for (const name of ['profile', 'crash', 'logs']) await fs.mkdir(path.join(root, name));
            const env = Object.fromEntries(
                Object.entries(process.env).filter(
                    (entry): entry is [string, string] =>
                        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
                ),
            );
            electronApplication = await _electron.launch({
                executablePath: process.env.HUB_MEMORY_ELECTRON ?? require('electron'),
                args: [path.join(root, 'main.cjs')],
                env: { ...env, HUB_CAPTURE_ELECTRON_ROOT: root },
            });
            cleanup.push(() => electronApplication!.close());
            page = await electronApplication.firstWindow();
            sampler = new ProcessSampler([electronApplication.process().pid!]);
            browserVersion = await electronApplication.evaluate(({ app }) => app.getVersion());
            close = () => electronApplication!.close();
        } else {
            server = http.createServer(async (request, response) => {
                const name =
                    request.url === '/renderer.js'
                        ? 'renderer.js'
                        : request.url === '/'
                          ? 'index.html'
                          : '';
                if (!name) {
                    response.writeHead(404).end();
                    return;
                }
                try {
                    response.setHeader(
                        'Content-Type',
                        name.endsWith('.js') ? 'text/javascript' : 'text/html',
                    );
                    response.end(await fs.readFile(path.join(root, name)));
                } catch {
                    response.writeHead(500).end();
                }
            });
            await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
            cleanup.push(
                () =>
                    new Promise<void>((resolve, reject) =>
                        server!.close((error) => (error ? reject(error) : resolve())),
                    ),
            );
            const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const engine = process.env.HUB_MEMORY_BROWSER ?? 'chromium';
            const type = { chromium, firefox, webkit }[engine];
            chromiumProtocol = engine === 'chromium';
            if (!type) throw Error('HUB_MEMORY_BROWSER must be chromium, firefox or webkit.');
            if (context.gcMode === 'forced' && engine !== 'chromium')
                throw Error(
                    'Forced heap diagnostic unsupported in this Firefox/WebKit driver. Run normal GC independently.',
                );
            const launched = await type.launchServer({ headless: true });
            cleanup.push(() => launched.close());
            const browser = await type.connect(launched.wsEndpoint());
            const browserContext = await browser.newContext({ acceptDownloads: true });
            page = await browserContext.newPage();
            sampler = new ProcessSampler([launched.process().pid!]);
            browserVersion = browser.version();
            await page.goto(origin);
            if (context.lane === 'gateway')
                loopback = await isolatedGateway(origin, context.gcMode, context.emit);
            close = async () => {
                await browserContext.close();
                await browser.close();
                await launched.close();
            };
        }
        await page.waitForFunction(() => Boolean(window.memoryResourceQA));
        await sampler.sample();
        if (chromiumProtocol) protocol = await page.context().newCDPSession(page);
        const supported = [
            'run-success',
            'same-generation-rearm',
            'connect-disconnect',
            'clear-reopen',
            'constant-catalog',
            'large-slow-capture',
            'export-json',
            'export-csv',
            'export-markdown',
            'export-text',
            ...(loopback ? ['stdout-stderr'] : []),
        ];
        const unsupported = Object.fromEntries(
            soakCoverage
                .filter((id) => !supported.includes(id))
                .map((id) => [
                    id,
                    'Requires composed product/UI/transport integration adapter; this runnable driver covers component boundaries only.',
                ]),
        );
        let closed = false;
        return {
            versions: {
                node: process.version,
                browser: browserVersion,
                lane: context.lane,
                sourceRoot,
                scope: 'component fixture; not whole-product qualification',
            },
            capabilities: { supported, unsupported },
            memoryScope: {
                roles: loopback?.roles ?? [],
                runtimeIdentity: loopback?.runtimeIdentity ?? null,
                unsupported: {
                    nativeAllocationMetrics:
                        'Component process/renderer diagnostics do not supply a complete per-role retained-memory assessment.',
                },
            },
            async cycle(input) {
                const result = await page.evaluate(
                    (value) => window.memoryResourceQA.cycle(value),
                    {
                        ...input,
                        lane: context.lane,
                        gateway: loopback
                            ? {
                                  url: loopback.url,
                                  token: loopback.token,
                                  options: loopback.options,
                              }
                            : undefined,
                    },
                );
                if (protocol && context.gcMode === 'forced') {
                    await protocol.send('HeapProfiler.collectGarbage');
                    await protocol.send('HeapProfiler.collectGarbage');
                }
                if (context.lane === 'desktop') {
                    let bytes = 0;
                    const visit = async (directory: string) => {
                        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                            const file = path.join(directory, entry.name);
                            if (entry.isDirectory()) await visit(file);
                            else if (entry.isFile()) bytes += (await fs.stat(file)).size;
                        }
                    };
                    await visit(path.join(root, 'profile'));
                    result.diskBytes = bytes;
                }
                return result;
            },
            sampleShutdownProcesses: () => sampler.sample(),
            async sampleProcesses(sampleContext) {
                const processes: Awaited<ReturnType<QualificationDriver['sampleProcesses']>> =
                    await sampler.sample();
                if (loopback) processes.push(...(await loopback.sample(sampleContext)));
                if (electronApplication && !closed) {
                    const metrics = await electronApplication.evaluate(({ app }) =>
                        app.getAppMetrics(),
                    );
                    await context.emit('electron-metrics', {
                        units: 'memory workingSetSize/peakWorkingSetSize/privateBytes are KiB; OS timeline normalized to bytes',
                        metrics,
                    });
                    for (const metric of metrics) {
                        const process = processes.find(
                            (row) => row.pid === metric.pid && row.state === 'running',
                        );
                        if (process) process.role = `electron-${metric.type}`;
                    }
                }
                if (protocol && !closed)
                    await context.emit(
                        'renderer-heap',
                        await protocol.send('Runtime.getHeapUsage'),
                    );
                return processes;
            },
            async snapshotOwners() {
                const gatewayOwners = (await loopback?.snapshotOwners()) ?? {};
                if (closed)
                    return {
                        ...gatewayOwners,
                        fixtureApp: 0,
                        fixtureServer: server?.listening ? 1 : 0,
                    };
                return {
                    ...(await page.evaluate(() => window.memoryResourceQA.snapshot())),
                    ...gatewayOwners,
                };
            },
            async teardown() {
                let failure: unknown;
                for (const dispose of [
                    async () => {
                        await protocol?.detach();
                        protocol = undefined;
                    },
                    async () => {
                        await close();
                        closed = true;
                    },
                    async () => {
                        await loopback?.close();
                    },
                    async () => {
                        if (server)
                            await new Promise<void>((resolve, reject) =>
                                server!.close((error) => (error ? reject(error) : resolve())),
                            );
                    },
                ]) {
                    try {
                        await dispose();
                    } catch (error) {
                        failure ??= error;
                    }
                }
                if (failure) throw failure;
            },
            async assertDescendantsExited() {
                await sampler.assertExited();
                await loopback?.assertExited();
            },
        };
    } catch (error) {
        await loopback?.close().catch(() => {});
        for (const dispose of cleanup.reverse()) await dispose().catch(() => {});
        throw error;
    }
}
