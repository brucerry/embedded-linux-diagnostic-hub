import { reportStartupIdentity } from '../../scripts/lib/startup-identity-report.mjs';
import type { ReviewedNativeCoverage } from './memory-product-native-contract';
import { productStartup } from './memory-product-startup';
import { shutdownHistory, rememberProcessRoles } from './memory-product-shutdown';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, firefox, webkit, type Page } from '@playwright/test';
import { createProductBrowser } from './memory-product-browser-host';
import { createProductGateway } from './memory-product-gateway';
import { exerciseProductSerial } from './memory-product-ui';
import {
    exerciseProductSerialLifecycle,
    type ProductSerialLifecycleCase,
} from './memory-product-serial-lifecycle';
import { exerciseProductSsh } from './memory-product-ssh-ui';
import { exerciseProductResults, type ResultsCapture } from './memory-product-results-ui';
import { sourceFingerprint, nodeRuntimeIdentity } from './memory-resource-identity';
import {
    soakCoverage,
    viewerCoverage,
    ownerKinds,
    viewerOwnerKinds,
    type QualificationDriver,
} from './memory-resource-core';
import {
    aggregatePending,
    aggregateSupported,
    serialLifecycleCoverage,
    serialExpectation,
    scheduledCatalog,
    assertCoverageReceipt,
} from './memory-product-aggregate-contract';
import type { ProcessSample } from './memory-resource-verdict';
import type {} from './memory-product-app';
import { ProductInspectionController } from './memory-product-inspection-controller';
import { requireInspectionRealmDestruction } from './memory-product-inspection-realm';
import {
    exerciseAggregateHeldViewer,
    produceAggregateCrossPage,
} from './memory-product-aggregate-workloads';
import type { ProductViewerWorkers } from './memory-product-viewer-lifecycle';
import { bindAggregateScope, sampleAggregateHarness } from './memory-product-aggregate-scope';
import {
    aggregateCaptureAccounting,
    assertDistinctAggregateScopes,
} from './memory-product-aggregate-contract';
import { createNativeAggregateDriver } from './memory-product-aggregate-native';
import {
    AggregateCallTracker,
    recordAggregateFailure,
} from './memory-product-aggregate-diagnostics';

async function fileHash(file: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
async function artifactInventory(directory: string) {
    const result: { path: string; bytes: number; sha256: string }[] = [];
    async function visit(relative: string) {
        for (const item of await fs.readdir(path.join(directory, relative), {
            withFileTypes: true,
        })) {
            assert.ok(!item.isSymbolicLink(), 'Aggregate artifact aliases refused.');
            const name = path.join(relative, item.name);
            if (item.isDirectory()) await visit(name);
            else
                result.push({
                    path: name.replaceAll('\\', '/'),
                    bytes: (await fs.stat(path.join(directory, name))).size,
                    sha256: await fileHash(path.join(directory, name)),
                });
        }
    }
    await visit('');
    return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

/** Actual App adapter. Missing coverage/scope blocks the unchanged full-product soak. */
export async function createQualificationDriver(context: {
    lane: string;
    gcMode: string;
    nativeCoverage?: ReviewedNativeCoverage;
    profile: string;
    viewer?: boolean;
    component?: boolean;
    signal?: AbortSignal;
    workDeadlineMs?: number;
    emit(stage: string, data: unknown): Promise<void>;
}): Promise<QualificationDriver & { inspect(): Promise<unknown> }> {
    const admit = productStartup(context);
    admit();
    if (context.lane === 'desktop') return createNativeAggregateDriver(context);
    assert.ok(['browser', 'gateway'].includes(context.lane), 'Unknown aggregate lane.');
    assert.ok(['normal', 'forced'].includes(context.gcMode));
    assert.equal(
        Boolean(context.component),
        false,
        'Actual App adapter cannot be relabelled a component pass.',
    );
    assert.ok(path.isAbsolute(context.profile));
    const engine = process.env.HUB_MEMORY_BROWSER ?? 'chromium';
    assert.ok(['chromium', 'firefox', 'webkit'].includes(engine));
    assert.equal(
        engine,
        'chromium',
        'Complete aggregate worker/visibility observation is currently implemented for Chromium; other engines remain blocked.',
    );
    assert.ok(
        context.gcMode === 'normal' || engine === 'chromium',
        'Forced GC is unsupported for this engine.',
    );
    const sourceRoot = path.resolve(import.meta.dirname, '../..'),
        sourceSHA256 = await sourceFingerprint(sourceRoot);
    const harness = await nodeRuntimeIdentity(),
        browserExecutable = await fs.realpath(
            { chromium, firefox, webkit }[engine]!.executablePath(),
        );
    const browserSHA256 = await fileHash(browserExecutable);
    let host: Awaited<ReturnType<typeof createProductBrowser>> | undefined,
        gateway: Awaited<ReturnType<typeof createProductGateway>> | undefined;
    let closed = false,
        busy = false,
        failed = false,
        fixtureOrdinal = 100000,
        anchor: string | undefined;
    let teardownStarted = false,
        teardownTask: Promise<void> | undefined,
        teardownEvidenceFailed = false,
        teardownEvidenceFailure: unknown;
    let inspection: ProductInspectionController | undefined,
        baselineAudit: unknown,
        latestCycle: unknown;
    let viewerWorkers: ProductViewerWorkers | undefined;
    let rootClosed: Promise<void> | undefined;
    let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let rootClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let lastProcesses: ProcessSample[] = [],
        finalOwners: Record<string, number> | undefined;
    const diagnosticCalls = new AggregateCallTracker(context.emit);
    const nativeJournal = path.join(path.dirname(context.profile), 'inspection-native.jsonl');
    const recordNative = (stage: string, data: unknown) =>
        appendFileSync(
            nativeJournal,
            JSON.stringify({ stage, at: performance.now(), data }) + '\n',
        );
    const supported = aggregateSupported(Boolean(context.viewer));
    const unsupported = Object.fromEntries(
        [...soakCoverage, ...(context.viewer ? viewerCoverage : [])]
            .filter((id) => !supported.includes(id as never))
            .map((id) => [id, aggregatePending[id as keyof typeof aggregatePending]]),
    );
    const memoryScope = {
        roles: [] as string[],
        runtimeIdentity: {
            harness,
            browser: {
                executablePath: browserExecutable,
                executableSHA256: browserSHA256,
                launch: {
                    hostSourceSHA256: await fileHash(
                        path.join(sourceRoot, 'tests/fixtures/memory-product-browser-host.ts'),
                    ),
                    engine,
                    gcMode: context.gcMode,
                    sandbox: true,
                },
            },
        } as Record<string, unknown>,
        unsupported: {} as Record<string, string>,
    };
    const processRoles = new Map<string, string>();
    async function sample(input?: { quiescent: boolean; forceGc: boolean }) {
        assert.ok(inspection);
        return inspection.use('aggregate-process-sample', () => sampleOnce(input));
    }
    async function sampleOnce(input?: { quiescent: boolean; forceGc: boolean }) {
        assert.ok(host);
        assert.ok(
            !input?.forceGc || context.gcMode === 'forced',
            'Normal lane cannot introduce GC.',
        );
        const rows = [
            await sampleAggregateHarness(Boolean(input?.forceGc)),
            ...(await host.sample(input)),
            ...(gateway ? await gateway.sample(input) : []),
        ];
        const keys = rows.map((row) => `${row.pid}/${row.created}`);
        assert.equal(new Set(keys).size, keys.length, 'Aggregate process identity duplicated.');
        lastProcesses = rows;
        rememberProcessRoles(rows, processRoles);
        return rows;
    }
    async function coldBaseline(page: Page = host!.page) {
        assert.ok(host);
        await page.locator('#root').count();
        const value = await page.evaluate(() =>
            window.memoryProduct.coldBaselineBeforeFirstMount(),
        );
        baselineAudit = {
            ...value,
            status: 'structurally-verified-never-mounted-cold-baseline',
        };
        await context.emit('aggregate-cold-baseline', baselineAudit);
    }
    async function reloadAndReopen(page: Page, expectedIds: string[]) {
        assert.ok(host && inspection);
        const start = inspection.realmSnapshot(),
            before = start.defaults,
            offset = start.history.length;
        await page.reload();
        await page.waitForFunction(() => Boolean(window.memoryProduct));
        const rows = await page.evaluate(() => window.memoryProduct.catalog());
        assert.deepEqual(rows.map((row) => row.id).sort(), [...expectedIds].sort());
        const reloaded = inspection.realmSnapshot();
        requireInspectionRealmDestruction(start, reloaded);
        await page.evaluate(() => window.memoryProduct.closeRepository());
        // Reading the real reopened catalog opened its real singleton. Destroy that
        // verification realm after closing it; leave the next cold realm unmounted
        // with no database connection absorbed into its baseline.
        await page.reload();
        await page.waitForFunction(() => Boolean(window.memoryProduct));
        const reopened = inspection.realmSnapshot();
        assert.equal(reopened.generation, start.generation);
        assert.ok(reopened.history.length <= 4096, 'Aggregate realm witness bound exceeded.');
        await context.emit('aggregate-realm-reopen', {
            beforeContexts: before,
            afterContexts: reopened.defaults,
            events: reopened.history.slice(offset),
            ids: expectedIds,
            actualContextWitness: reopened.hasProtocol,
            inspectionGeneration: reopened.generation,
            verificationRealmClosed: true,
        });
        // The real repository cache is closed only at the end of a realm. A reload, rather
        // than calling its cached closed repository again, creates the fresh binding.
        await coldBaseline(page);
    }
    async function rawOwners(stage: string) {
        assert.ok(inspection);
        return inspection.use('aggregate-owner-snapshot', () => rawOwnersOnce(stage));
    }
    async function rawOwnersOnce(stage: string) {
        assert.ok(host);
        const page = await host.page.evaluate(() => ({
            operation: window.memoryProduct.ownership(),
            ledger: window.memoryProduct.ledgerDelta(),
        }));
        const remote = gateway ? await gateway.snapshotOwners() : null;
        const independentWorker = inspection?.exportIdleSnapshot();
        const counts: Record<string, number> = { ...page.operation.owners };
        counts.diagnosticCalls = diagnosticCalls.pending().length;
        if (remote) {
            counts.gatewayOperations =
                remote.product.httpBodyReaders +
                remote.product.pendingConnections +
                remote.product.inFlight +
                remote.product.ownedSessions +
                remote.product.retiringSessions;
            counts.targetResources = Object.values(remote.target.owners).reduce(
                (sum, count) => sum + count,
                0,
            );
        }
        const added = page.ledger.added;
        const count = (...kinds: string[]) =>
            added.filter((row) => kinds.includes(row.kind)).length;
        counts.listenerDelta = count('event-listener');
        counts.timerDelta = count('timeout', 'interval');
        counts.databaseConnectionDelta = count('idb-connection');
        if (context.viewer) {
            counts.raf = count('animation-frame');
            counts.observer = count('resize-observer', 'mutation-observer');
            counts.pointerCapture = count('pointer-capture');
            counts.worker = Math.max(count('worker'), host.dedicatedWorkers());
            counts.canvas = count('canvas');
            counts.blobUrl = count('object-url');
            counts.pdfWindow = host.page
                .context()
                .pages()
                .filter((page) => page !== host!.page && !page.isClosed()).length;
        }
        for (const key of [...ownerKinds, ...(context.viewer ? viewerOwnerKinds : [])])
            assert.ok(Number.isSafeInteger(counts[key]), 'Missing actual named probe: ' + key);
        await context.emit('aggregate-raw-owners', {
            stage,
            page,
            gateway: remote,
            independentWorker,
            counts,
            scope: 'Page observations and exact operation owners only; independent worker/realm scope remains explicitly unsupported.',
        });
        return { counts, page, gateway: remote };
    }
    async function teardown() {
        if (teardownTask) return teardownTask;
        if (teardownEvidenceFailed) throw teardownEvidenceFailure;
        if (closed) return;
        teardownStarted = true;
        const task = Promise.resolve().then(teardownOnce);
        teardownTask = task;
        try {
            await task;
        } finally {
            if (teardownTask === task) teardownTask = undefined;
        }
    }
    async function teardownOnce() {
        const errors: unknown[] = [];
        const cleanupPage = host?.pageForCleanup();
        if (cleanupPage && !cleanupPage.isClosed()) {
            try {
                await context.emit(
                    'aggregate-page-cleanup-joined',
                    await cleanupPage.evaluate(() =>
                        window.memoryProduct.joinAggregatePageOperations(),
                    ),
                );
            } catch (error) {
                errors.push(error);
                try {
                    await context.emit('aggregate-page-cleanup-failed', {
                        error: String(error),
                        stack: error instanceof Error ? error.stack : null,
                        acknowledged: false,
                    });
                } catch (recording) {
                    errors.push(recording);
                }
            }
        }
        if (gateway) {
            try {
                await gateway.close();
                await gateway.assertExited();
            } catch (error) {
                errors.push(error);
            }
        }
        if (host) {
            try {
                if (inspection) await inspection.close();
                else await host.close();
                assert.ok(rootClosed, 'Native root ownership not retained.');
                await rootClosed;
                assert.deepEqual(rootExit, { code: 0, signal: null });
                assert.deepEqual(rootClose, { code: 0, signal: null });
                await context.emit('aggregate-native-root-exit-close', {
                    exit: rootExit,
                    close: rootClose,
                });
            } catch (error) {
                errors.push(error);
            }
        }
        // An actual context close settles its in-flight evaluations and closes worker targets.
        // The observers may retire only after those real events, never because a deadline expired.
        try {
            diagnosticCalls.assertJoined();
        } catch (error) {
            errors.push(error);
        }
        if (errors.length)
            throw new AggregateError(
                errors,
                'Actual aggregate cleanup is unverified. ' + errors.map(String).join(' | '),
            );
        const counts = Object.fromEntries(
            [...new Set([...ownerKinds, ...(context.viewer ? viewerOwnerKinds : [])])].map(
                (kind) => [kind, 0],
            ),
        );
        try {
            await context.emit('aggregate-full-process-teardown', {
                actualHostExited: true,
                actualGatewayExited: Boolean(gateway),
                counts,
                basis: 'All owned browser realms/processes and gateway roots joined; not fabricated live snapshots.',
            });
        } catch (error) {
            teardownEvidenceFailed = true;
            teardownEvidenceFailure = error;
            throw error;
        }
        finalOwners = counts;
        closed = true;
    }
    try {
        admit();
        host = await createProductBrowser({
            signal: context.signal,
            workDeadlineMs: context.workDeadlineMs,
            profile: context.profile,
            gcMode: context.gcMode,
            engine,
            coldStart: true,
            headless: false,
            windowSemantics: engine === 'chromium' ? 'native' : undefined,
            emit: context.emit,
            async observeRoot(child) {
                assert.ok(child.pid && child.exitCode === null && child.signalCode === null);
                child.once('exit', (code, signal) => {
                    rootExit = { code, signal };
                });
                rootClosed = new Promise((resolve) =>
                    child.once('close', (code, signal) => {
                        rootClose = { code, signal };
                        resolve();
                    }),
                );
            },
        });
        admit();
        gateway = await createProductGateway({
            signal: context.signal,
            workDeadlineMs: context.workDeadlineMs,
            origin: host.origin,
            gcMode: context.gcMode,
            profile: path.join(path.dirname(context.profile), 'gateway-profile'),
            emit: context.emit,
        });
        admit();
        host.proxyGateway(gateway.descriptor.url);
        inspection = new ProductInspectionController(host, context.emit, (stage, data) => {
            // Persist each native receipt synchronously before allowing publication.
            recordNative(stage, data);
        });
        admit();
        await inspection.initialize();
        admit();
        viewerWorkers = inspection.viewerWorkers();
        await context.emit('aggregate-viewer-worker-binding', {
            sha256: inspection.viewerArtifact(),
        });
        const artifacts = await artifactInventory(host.root);
        await sample({ quiescent: false, forceGc: false });
        const scope = await bindAggregateScope(lastProcesses, {
            harness,
            gatewayRuntime: gateway.runtimeIdentity,
            sourceSHA256,
            artifacts,
            engine,
            headless: false,
            gcMode: context.gcMode,
            lane: context.lane,
            hostSourceSHA256: await fileHash(
                path.join(sourceRoot, 'tests/fixtures/memory-product-browser-host.ts'),
            ),
        });
        memoryScope.roles = scope.roles;
        memoryScope.runtimeIdentity = scope.runtimeIdentity;
        await reportStartupIdentity(context.emit, 'aggregate-actual-process-launches', scope.raw);
        await reportStartupIdentity(context.emit, 'aggregate-input-identity', {
            sourceSHA256,
            harness,
            configuredBrowserExecutable: browserExecutable,
            configuredBrowserSHA256: browserSHA256,
            actualRoleExecutableIdentity: scope.runtimeIdentity,
            browserVersion: host.version,
            artifacts,
            gatewayRuntime: gateway.runtimeIdentity,
            processes: lastProcesses,
            partialScope: memoryScope,
        });
        await coldBaseline();
        admit();
    } catch (error) {
        try {
            await teardown();
        } catch (cleanup) {
            throw new AggregateError(
                [error, cleanup],
                'Aggregate startup failed; preserve unknown cleanup.',
            );
        }
        throw error;
    }
    return {
        versions: {
            sourceSHA256,
            node: process.version,
            browser: host.version,
            engine,
            lane: context.lane,
            scope: 'actual App aggregate adapter; incomplete qualification gates explicit',
        },
        capabilities: { supported, unsupported },
        memoryScope,
        async cycle(input) {
            assert.ok(
                !closed && !busy && !failed && !teardownStarted,
                'Aggregate cannot overlap, reuse failure, or run after close.',
            );
            const targetCount = scheduledCatalog(input.ordinal, input.catalogMode);
            assert.ok(
                Number.isSafeInteger(input.payloadBytes) &&
                    input.payloadBytes >= 32 &&
                    input.payloadBytes <= 64 * 1024 ** 2,
            );
            busy = true;
            try {
                const page = host!.page,
                    acknowledged = new Set<string>();
                await page.evaluate(() => window.memoryProduct.mount());
                const beforeCatalog = await page.evaluate(() => window.memoryProduct.catalog());
                const viewerToken = viewerWorkers!.baseline();
                const tail = 'raw-aggregate-' + fixtureOrdinal;
                await page.evaluate(
                    (tail) => window.memoryProduct.serial.configure({ tail }),
                    tail,
                );
                const ordinal = fixtureOrdinal++;
                const serial = await exerciseProductSerial(page, {
                    ordinal,
                    payloadBytes: input.payloadBytes,
                    viewer: Boolean(context.viewer),
                    faults: false,
                    nativeDownload: host!.viewerDownload,
                    expectedTail: tail,
                    emit: context.emit,
                });
                await host!.joinDedicatedWorkers();
                const actualViewerWorkers = viewerWorkers!.since(viewerToken);
                await Promise.all(actualViewerWorkers.map((worker) => worker.closed));
                viewerWorkers!.releaseBaseline(viewerToken);
                viewerWorkers!.retireClosed(actualViewerWorkers);
                for (const id of serial.coverage) acknowledged.add(id);
                const selected = serial.catalog
                    .filter((row) => row.command === 'product-qualification-' + ordinal)
                    .sort((a, b) => a.sequence - b.sequence);
                assert.equal(selected.length, 2);
                const primary: ResultsCapture[] = selected.map((row, index) => ({
                    ...row,
                    state: row.state as 'complete',
                    completion: 'prompt-observed',
                    exitCode: null,
                    streams: {
                        serial: serialExpectation(index === 0 ? input.payloadBytes : 64, tail),
                    },
                    readableOutput: serialExpectation(index === 0 ? input.payloadBytes : 64, tail),
                }));
                const crossPage = input.ordinal % 8 === 0;
                const extra = await produceAggregateCrossPage(
                    page,
                    fixtureOrdinal++,
                    crossPage ? 21 : 1,
                );
                const selection = crossPage ? [primary[0], extra.produced.at(-1)!] : [primary[0]];
                const allCatalog = await page.evaluate(() => window.memoryProduct.catalog());
                const expectedScopes = {
                    selected: selection.map((row) => row.id),
                    filtered: selected.map((row) => row.id),
                    all: allCatalog
                        .filter((row) => row.transport === 'serial')
                        .map((row) => row.id),
                };
                assertDistinctAggregateScopes(expectedScopes);
                const result = await exerciseProductResults(page, {
                    transport: 'serial',
                    catalog: allCatalog.map(
                        (row) =>
                            primary.find((value) => value.id === row.id) ??
                            extra.produced.find((value) => value.id === row.id) ??
                            row,
                    ) as ResultsCapture[],
                    selection,
                    search: { query: tail, expectedIds: selected.map((row) => row.id) },
                    evidenceDirectory: path.join(path.dirname(context.profile), 'actual-results'),
                    maxDownloadBytes: 128 * 1024 ** 2,
                    requireCrossPage: crossPage,
                    clear: 'none',
                    reopen: 'none',
                    exportReadFault: inspection!.exportReadFaults(),
                    streamDownload: host!.streamDownload,
                    browserDownloads: host!.downloadCount
                        ? { count: host!.downloadCount }
                        : undefined,
                });
                assertDistinctAggregateScopes(expectedScopes, {
                    selected: result.exports[0].captureIds!,
                    filtered: result.exports[4].captureIds!,
                    all: result.exports[5].captureIds!,
                });
                if (crossPage) {
                    assert.ok(result.covered.includes('stored-results-cross-page-selection'));
                    acknowledged.add('search-page-offscreen-selection');
                }
                assert.ok(
                    result.covered.includes('stored-results-cancel-held-read') &&
                        result.covered.includes('stored-results-read-failure-preserves-catalog'),
                );
                acknowledged.add('export-cancel');
                acknowledged.add('export-failure');
                for (const format of ['json', 'csv', 'markdown', 'text']) {
                    assert.ok(
                        result.covered.includes('stored-results-' + format + '-download-semantics'),
                    );
                    acknowledged.add('export-' + format);
                }
                await context.emit('aggregate-actual-results', result);
                if (input.ordinal % 8 === 0) {
                    const held = await exerciseAggregateHeldViewer(page, {
                        ordinal: fixtureOrdinal++,
                        viewer: Boolean(context.viewer),
                        workers: viewerWorkers!,
                        visibility: (hidden) => host!.visibility(hidden),
                        browserDownloads: host!.downloadCount
                            ? { count: host!.downloadCount }
                            : undefined,
                        emit: context.emit,
                    });
                    for (const id of held.coverage) acknowledged.add(id);
                }
                await page.evaluate(() => window.memoryProduct.serial.configure({ tail: '' }));
                const faults = await exerciseProductSerial(page, {
                    ordinal: fixtureOrdinal++,
                    payloadBytes: 32,
                    viewer: false,
                    faults: true,
                });
                for (const id of faults.coverage) acknowledged.add(id);
                const names = Object.keys(serialLifecycleCoverage) as ProductSerialLifecycleCase[];
                const caseName = names[input.ordinal % names.length];
                const lifecycle = await exerciseProductSerialLifecycle(page, {
                    ordinal: fixtureOrdinal++,
                    cases: [caseName],
                    emit: context.emit,
                });
                assert.equal(lifecycle.receipts.length, 1);
                for (const id of serialLifecycleCoverage[caseName]) acknowledged.add(id);
                const ssh = await exerciseProductSsh(page, gateway!, {
                    ordinal: fixtureOrdinal++,
                    payloadBytes: 65536,
                    gatewayUrl: host!.origin,
                    afterReload: async () => {
                        await coldBaseline();
                        await page.evaluate(() => window.memoryProduct.mount());
                    },
                    scenarios: [
                        'stream',
                        'serial-to-ssh',
                        'manual-pty',
                        ...(input.ordinal % 4 === 2 ? ['server-loss-rearm' as const] : []),
                        ...(input.ordinal % 4 === 3 ? ['client-reload-rearm' as const] : []),
                    ],
                    emit: context.emit,
                });
                const receipts = new Set(ssh.receipts.map((row) => row.scenario));
                assert.ok(receipts.has('independent-stream-stored'));
                acknowledged.add('stdout-stderr');
                acknowledged.add('transport-switch');
                acknowledged.add('manual-pty-separate');
                if (receipts.has('server-connection-loss')) acknowledged.add('server-loss');
                if (receipts.has('client-reload-loss')) {
                    acknowledged.add('client-loss');
                    acknowledged.add('reload');
                }
                await context.emit('aggregate-actual-ssh', ssh);
                let catalog = await page.evaluate(() => window.memoryProduct.catalog());
                const accounting = aggregateCaptureAccounting(beforeCatalog, catalog);
                await context.emit('aggregate-complete-capture-accounting', accounting);
                if (!anchor)
                    anchor = catalog.find(
                        (row) =>
                            row.state === 'complete' &&
                            row.transport === 'serial' &&
                            row.committedBytes < 4096,
                    )?.id;
                assert.ok(
                    anchor && catalog.some((row) => row.id === anchor),
                    'Real stable reference capture missing.',
                );
                const keep = [
                    anchor,
                    ...catalog
                        .filter(
                            (row) =>
                                row.id !== anchor &&
                                row.state === 'complete' &&
                                row.committedBytes < 4096,
                        )
                        .map((row) => row.id),
                ].slice(0, targetCount);
                assert.equal(
                    keep.length,
                    targetCount,
                    'Produce real small records before reconciliation.',
                );
                await page.evaluate(
                    (ids) => window.memoryProduct.deleteCaptures(ids),
                    catalog.filter((row) => !keep.includes(row.id)).map((row) => row.id),
                );
                catalog = await page.evaluate(() => window.memoryProduct.catalog());
                assert.deepEqual(catalog.map((row) => row.id).sort(), [...keep].sort());
                const usage = await page.evaluate(() => window.memoryProduct.storageUsage());
                assert.ok(usage.usageBytes !== null, 'Actual origin disk estimate unavailable.');
                await host!.joinDedicatedWorkers();
                await inspection!.retire(async (retiringPage) => {
                    assert.equal(retiringPage, page);
                    await context.emit(
                        'aggregate-actual-versionchange',
                        await page.evaluate(() => window.memoryProduct.abortActualVersionChange()),
                    );
                    acknowledged.add('versionchange');
                    await page.evaluate(async () => {
                        window.memoryProduct.unmount();
                        await window.memoryProduct.closeSerial();
                        await window.memoryProduct.closeRepository();
                    });
                    await context.emit('aggregate-old-realm-observation', {
                        operation: await page.evaluate(() => window.memoryProduct.ownership()),
                        note: 'Raw retained registrations are preserved; old context destruction is separately witnessed.',
                    });
                    await reloadAndReopen(retiringPage, keep);
                });
                acknowledged.add('clear-reopen');
                acknowledged.add(
                    input.catalogMode === 'constant'
                        ? 'constant-catalog'
                        : 'bounded-growing-catalog',
                );
                acknowledged.add('reload');
                const coverage = [...acknowledged];
                assertCoverageReceipt(coverage, Boolean(context.viewer));
                assert.deepEqual(host!.errors(), []);
                latestCycle = {
                    input,
                    serial: {
                        capturedBytes: serial.capturedBytes,
                        ids: selected.map((row) => row.id),
                    },
                    lifecycle,
                    sshReceipts: ssh.receipts,
                    catalog,
                    usage,
                    coverage,
                    accounting,
                };
                await context.emit('aggregate-cycle', latestCycle);
                return {
                    coverage,
                    capturedBytes: accounting.committedBytes,
                    exportedBytes:
                        serial.exportedBytes +
                        result.exports.reduce((total, row) => total + row.bytes, 0),
                    diskBytes: usage.usageBytes,
                    diskRecords: catalog.length,
                    cache: {
                        diskPrecision: usage.precision,
                        referenceId: anchor,
                        checkpointKind: 'actual bounded product membership',
                        originQuotaBytes: usage.quotaBytes ?? 'unavailable',
                        observedCaptureBytes:
                            accounting.observedBytes ??
                            'unavailable; see per-capture nulls and known subtotal',
                        knownObservedCaptureSubtotal: accounting.knownObservedSubtotal,
                        createdCaptureRecords: accounting.createdRecords,
                        captureAccounting: accounting.scope,
                    },
                };
            } catch (error) {
                failed = true;
                await recordAggregateFailure({
                    error,
                    emit: context.emit,
                    calls: diagnosticCalls,
                    collect: () => [
                        {
                            name: 'alerts',
                            read: () => host!.pageForCleanup().getByRole('alert').allTextContents(),
                        },
                        {
                            name: 'status',
                            read: () =>
                                host!.pageForCleanup().getByRole('status').allTextContents(),
                        },
                        {
                            name: 'page-owners',
                            read: () =>
                                host!
                                    .pageForCleanup()
                                    .evaluate(() => window.memoryProduct.ownership()),
                        },
                        { name: 'host-errors', read: async () => host!.errors() },
                        ...host!
                            .pageForCleanup()
                            .context()
                            .serviceWorkers()
                            .map((worker) => ({
                                name: 'service-worker/' + worker.url(),
                                read: () =>
                                    worker.evaluate(async () => {
                                        const probe = (globalThis as any).__memoryProductWorker;
                                        return probe
                                            ? {
                                                  product: await probe.snapshot(),
                                                  independent: probe.ledger(),
                                              }
                                            : { probeAbsent: true };
                                    }),
                            })),
                    ],
                });
                throw error;
            } finally {
                busy = false;
            }
        },
        sampleProcesses: sample,
        async sampleShutdownProcesses() {
            return shutdownHistory(
                [
                    await sampleAggregateHarness(false),
                    ...(host ? await host.sampleProcessHistory() : []),
                    ...(gateway ? await gateway.sampleProcessHistory() : []),
                ],
                processRoles,
            );
        },
        async snapshotOwners(stage) {
            assert.ok(
                !teardownStarted || closed,
                'Aggregate teardown is pending or failed; no zero-owner receipt.',
            );
            if (closed) {
                assert.ok(finalOwners);
                return { ...finalOwners };
            }
            return (await rawOwners(stage)).counts;
        },
        teardown,
        async assertDescendantsExited() {
            assert.ok(closed, 'Aggregate teardown was not acknowledged.');
            await host!.assertExited();
            await gateway!.assertExited();
        },
        async inspect() {
            return {
                sourceSHA256,
                supported,
                unsupported,
                memoryScope,
                baselineAudit,
                latestCycle,
                busy,
                failed,
                closed,
                processes: lastProcesses,
                pendingDiagnosticCalls: diagnosticCalls.pending(),
                pendingWorkerCalls: inspection?.snapshot().exportPending ?? [],
                inspection: inspection?.snapshot(),
            };
        },
    };
}
