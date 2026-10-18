import { nativeGenerationCase } from './memory-product-native-contract';
import { exerciseNativeSaveCases } from './memory-product-native-save-ui';
import type { ReviewedNativeCoverage } from './memory-product-native-contract';
import { productStartup } from './memory-product-startup';
import { shutdownHistory, rememberProcessRoles } from './memory-product-shutdown';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CDPSession } from '@playwright/test';
import { createProductNative } from './memory-product-native-host';
import { createProductGateway } from './memory-product-gateway';
import {
    exerciseProductNativeSsh,
    type NativeProductSshTrust,
} from './memory-product-native-ssh-ui';
import { exerciseProductSerial } from './memory-product-ui';
import {
    exerciseProductSerialLifecycle,
    type ProductSerialLifecycleCase,
} from './memory-product-serial-lifecycle';
import { exerciseProductResults, type ResultsCapture } from './memory-product-results-ui';
import {
    aggregateSupported,
    aggregateCaptureAccounting,
    aggregateNativeResourceCounts,
    assertDistinctAggregateScopes,
    serialExpectation,
    serialLifecycleCoverage,
    scheduledCatalog,
} from './memory-product-aggregate-contract';
import {
    createAggregateViewerWitness,
    exerciseAggregateHeldViewer,
    produceAggregateCrossPage,
} from './memory-product-aggregate-workloads';
import {
    bindAggregateScope,
    inventoryProductArtifacts,
    sampleAggregateHarness,
} from './memory-product-aggregate-scope';
import { sourceFingerprint, nodeRuntimeIdentity } from './memory-resource-identity';
import { ownerKinds, viewerOwnerKinds, type QualificationDriver } from './memory-resource-core';
import type { ProductViewerWorkers } from './memory-product-viewer-lifecycle';

/** Actual native main/preload/renderer/IPC/capture workload; browser fixtures are never substituted. */
export async function createNativeAggregateDriver(context: {
    lane: string;
    gcMode: string;
    nativeCoverage?: ReviewedNativeCoverage;
    profile: string;
    viewer?: boolean;
    component?: boolean;
    pilot?: Record<string, any>;
    startup?: import('./native-pilot-startup').NativePilotStartup;
    signal?: AbortSignal;
    workDeadlineMs?: number;
    emit(stage: string, data: unknown): Promise<void>;
}): Promise<QualificationDriver & { inspect(): Promise<unknown> }> {
    const admit = productStartup(context);
    admit();
    assert.equal(context.lane, 'desktop');
    assert.equal(Boolean(context.component), false);
    assert.ok(['normal', 'forced'].includes(context.gcMode) && path.isAbsolute(context.profile));
    const sourceSHA256 = await sourceFingerprint(path.resolve(import.meta.dirname, '../..'));
    assert.ok(
        context.nativeCoverage,
        'Native full product work requires its independently reviewed backend coverage contract before startup.',
    );
    assert.equal(context.nativeCoverage.contract.sourceSHA256, sourceSHA256);
    assert.equal(process.platform, 'win32');
    assert.equal(process.arch, 'x64');
    const unsupported = {
        versionchange: context.nativeCoverage.contract.cases.versionchange.reason,
    };
    const supported = [
        ...aggregateSupported(Boolean(context.viewer)).filter((id) => id !== 'versionchange'),
        nativeGenerationCase,
    ];
    let host: Awaited<ReturnType<typeof createProductNative>> | undefined,
        gateway: Awaited<ReturnType<typeof createProductGateway>> | undefined,
        workers: ProductViewerWorkers | undefined,
        protocol: CDPSession | undefined;
    let closed = false,
        busy = false,
        failed = false,
        ordinal = 200000,
        anchor: string | undefined,
        trust: NativeProductSshTrust | undefined,
        baseline: unknown,
        latestCycle: unknown;
    let memoryScope: NonNullable<QualificationDriver['memoryScope']> = {
        roles: [],
        runtimeIdentity: {},
        unsupported: {},
    };
    let destroyed = 0;
    async function cold() {
        assert.ok(host);
        await host.page.locator('#root').count();
        baseline = await host.page.evaluate(() =>
            window.memoryProduct.coldBaselineBeforeFirstMount(),
        );
        await context.emit('aggregate-native-cold-baseline', baseline);
    }
    const processRoles = new Map<string, string>();
    async function sample(input?: { quiescent: boolean; forceGc: boolean }) {
        assert.ok(host && gateway);
        assert.ok(!input?.forceGc || context.gcMode === 'forced');
        const rows = [
            await sampleAggregateHarness(Boolean(input?.forceGc)),
            ...(await host.sample(input)),
            ...(await gateway.sample(input)),
        ];
        assert.equal(new Set(rows.map((row) => `${row.pid}/${row.created}`)).size, rows.length);
        rememberProcessRoles(rows, processRoles);
        return rows;
    }
    let teardownTask: Promise<void> | undefined;
    async function teardown() {
        return (teardownTask ??= teardownOnce());
    }
    async function teardownOnce() {
        if (closed) return;
        const errors: unknown[] = [];
        if (host && !host.page.isClosed())
            try {
                await host.releaseQualificationHolds();
            } catch (error) {
                errors.push(error);
            }
        if (host && !host.page.isClosed())
            try {
                await context.emit(
                    'aggregate-native-page-cleanup',
                    await host.page.evaluate(() =>
                        window.memoryProduct.joinAggregatePageOperations(),
                    ),
                );
            } catch (error) {
                errors.push(error);
            }
        if (protocol)
            try {
                await protocol.detach();
            } catch (error) {
                errors.push(error);
            }
        if (gateway)
            try {
                await gateway.close();
                await gateway.assertExited();
            } catch (error) {
                errors.push(error);
            }
        if (host)
            try {
                await host.close();
                await host.assertExited();
            } catch (error) {
                errors.push(error);
            }
        if (workers)
            try {
                workers.dispose();
            } catch (error) {
                errors.push(error);
            }
        if (errors.length)
            throw new AggregateError(errors, 'Native aggregate cleanup is unverified.');
        closed = true;
    }
    try {
        admit();
        host = await createProductNative({
            pilot: context.pilot,
            startup: context.startup,
            signal: context.signal,
            workDeadlineMs: context.workDeadlineMs,
            profile: context.profile,
            gcMode: context.gcMode,
            coldStart: true,
            emit: context.emit,
        });
        admit();
        gateway = await createProductGateway({
            startup: context.startup,
            signal: context.signal,
            workDeadlineMs: context.workDeadlineMs,
            profile: path.join(path.dirname(context.profile), 'target-profile'),
            origin: 'http://127.0.0.1:9',
            gcMode: context.gcMode,
            emit: context.emit,
        });
        admit();
        workers = (
            await createAggregateViewerWitness(host.page, path.join(host.root, 'dist/assets'))
        ).workers;
        admit();
        protocol = await host.page.context().newCDPSession(host.page);
        admit();
        protocol.on('Runtime.executionContextsCleared', () => {
            destroyed++;
        });
        await protocol.send('Runtime.enable');
        const artifacts = await inventoryProductArtifacts(host.root),
            rows = await sample({ quiescent: false, forceGc: false });
        const scope = await bindAggregateScope(rows, {
            harness: await nodeRuntimeIdentity(),
            gatewayRuntime: gateway.runtimeIdentity,
            sourceSHA256,
            artifacts,
            lane: 'desktop',
            gcMode: context.gcMode,
            sandbox: true,
        });
        memoryScope = {
            roles: scope.roles,
            runtimeIdentity: scope.runtimeIdentity,
            unsupported: memoryScope.unsupported,
        };
        await context.emit('aggregate-native-input-identity', {
            sourceSHA256,
            artifacts,
            scope,
            target: gateway.runtimeIdentity,
        });
        await cold();
        admit();
    } catch (error) {
        try {
            await teardown();
        } catch (cleanup) {
            throw new AggregateError(
                [error, cleanup],
                'Native aggregate startup and cleanup failed.',
            );
        }
        throw error;
    }
    return {
        versions: {
            sourceSHA256,
            lane: 'desktop',
            version: host.version,
            scope: 'actual native aggregate; reviewed native backend applicability',
            nativeCoverageSHA256: context.nativeCoverage.sha256,
        },
        capabilities: { supported, unsupported },
        memoryScope,
        async cycle(input) {
            assert.ok(!closed && !busy && !failed);
            busy = true;
            try {
                const page = host!.page,
                    coverage = new Set<string>(),
                    count = scheduledCatalog(input.ordinal, input.catalogMode);
                await page.evaluate(() => window.memoryProduct.mount());
                const before = await page.evaluate(() => window.memoryProduct.catalog());
                const commandOrdinal = ordinal++,
                    tail = 'native-aggregate-' + commandOrdinal;
                await page.evaluate(
                    (tail) => window.memoryProduct.serial.configure({ tail }),
                    tail,
                );
                const token = workers!.baseline();
                const serial = await exerciseProductSerial(page, {
                    ordinal: commandOrdinal,
                    payloadBytes: input.payloadBytes,
                    viewer: Boolean(context.viewer),
                    faults: true,
                    nativeDownload: host!.download,
                });
                await host!.joinDedicatedWorkers();
                const seen = workers!.since(token);
                await Promise.all(seen.map((row) => row.closed));
                workers!.releaseBaseline(token);
                workers!.retireClosed(seen);
                for (const id of serial.coverage) coverage.add(id);
                const primary = serial.catalog
                    .filter((row) => row.command === 'product-qualification-' + commandOrdinal)
                    .sort((a, b) => a.sequence - b.sequence)
                    .map((row, index): ResultsCapture => ({
                        ...row,
                        state: 'complete',
                        completion: 'prompt-observed',
                        exitCode: null,
                        streams: {
                            serial: serialExpectation(index === 0 ? input.payloadBytes : 64, tail),
                        },
                        readableOutput: serialExpectation(
                            index === 0 ? input.payloadBytes : 64,
                            tail,
                        ),
                    }));
                assert.equal(primary.length, 2);
                const cross = input.ordinal % 8 === 0,
                    extra = await produceAggregateCrossPage(page, ordinal++, cross ? 21 : 1);
                const catalog = await page.evaluate(() => window.memoryProduct.catalog());
                const selected = cross ? [primary[0], extra.produced.at(-1)!] : [primary[0]],
                    scopes = {
                        selected: selected.map((row) => row.id),
                        filtered: primary.map((row) => row.id),
                        all: catalog
                            .filter((row) => row.transport === 'serial')
                            .map((row) => row.id),
                    };
                assertDistinctAggregateScopes(scopes);
                const results = await exerciseProductResults(page, {
                    transport: 'serial',
                    catalog: catalog.map(
                        (row) =>
                            primary.find((value) => value.id === row.id) ??
                            extra.produced.find((value) => value.id === row.id) ??
                            row,
                    ) as ResultsCapture[],
                    selection: selected,
                    search: { query: tail, expectedIds: primary.map((row) => row.id) },
                    evidenceDirectory: path.join(path.dirname(context.profile), 'native-results'),
                    maxDownloadBytes: 128 * 1024 ** 2,
                    requireCrossPage: cross,
                    clear: 'none',
                    reopen: 'none',
                    nativeDownload: host!.reportDownload,
                    nativeSaveCases: (view) =>
                        exerciseNativeSaveCases(page, view, host!, context.emit),
                });
                assertDistinctAggregateScopes(scopes, {
                    selected: results.exports[0].captureIds!,
                    filtered: results.exports[4].captureIds!,
                    all: results.exports[5].captureIds!,
                });
                coverage.add('export-cancel');
                coverage.add('export-failure');
                for (const format of ['json', 'csv', 'markdown', 'text'])
                    coverage.add('export-' + format);
                if (cross) coverage.add('search-page-offscreen-selection');
                if (input.ordinal % 8 === 0) {
                    const held = await exerciseAggregateHeldViewer(page, {
                        ordinal: ordinal++,
                        viewer: Boolean(context.viewer),
                        workers: workers!,
                        visibility: (hidden) => host!.visibility(hidden),
                        emit: context.emit,
                    });
                    for (const id of held.coverage) coverage.add(id);
                }
                const names = Object.keys(serialLifecycleCoverage) as ProductSerialLifecycleCase[],
                    name = names[input.ordinal % names.length];
                const lifecycle = await exerciseProductSerialLifecycle(page, {
                    ordinal: ordinal++,
                    cases: [name],
                    emit: context.emit,
                });
                assert.equal(lifecycle.receipts.length, 1);
                for (const id of serialLifecycleCoverage[name]) coverage.add(id);
                const ssh = await exerciseProductNativeSsh(page, gateway!, {
                    ordinal: ordinal++,
                    payloadBytes: 65536,
                    snapshot: host!.snapshot,
                    previousTrust: trust,
                    afterReload: async () => {
                        await cold();
                        await page.evaluate(() => window.memoryProduct.mount());
                    },
                    scenarios: [
                        'stream',
                        'manual-pty',
                        ...(input.ordinal % 4 === 2 ? ['server-loss-rearm' as const] : []),
                        ...(input.ordinal % 4 === 3 ? ['client-reload-rearm' as const] : []),
                    ],
                    emit: context.emit,
                });
                trust = ssh.trust;
                coverage.add('stdout-stderr');
                coverage.add('manual-pty-separate');
                coverage.add('transport-switch');
                if (input.ordinal % 4 === 2) coverage.add('server-loss');
                if (input.ordinal % 4 === 3) coverage.add('client-loss');
                const all = await page.evaluate(() => window.memoryProduct.catalog()),
                    accounting = aggregateCaptureAccounting(before, all);
                anchor ??= all.find(
                    (row) =>
                        row.state === 'complete' &&
                        row.transport === 'serial' &&
                        row.committedBytes < 4096,
                )?.id;
                assert.ok(anchor && all.some((row) => row.id === anchor));
                const keep = [
                    anchor,
                    ...all
                        .filter(
                            (row) =>
                                row.id !== anchor &&
                                row.state === 'complete' &&
                                row.committedBytes < 4096,
                        )
                        .map((row) => row.id),
                ].slice(0, count);
                assert.equal(keep.length, count);
                await page.evaluate(
                    (ids) => window.memoryProduct.deleteCaptures(ids),
                    all.filter((row) => !keep.includes(row.id)).map((row) => row.id),
                );
                await page.evaluate(() => window.memoryProduct.joinAggregatePageOperations());
                const stale = await page.evaluate(async (id) => {
                    const bridge = window.diagnosticHub!.captureStorage!;
                    const reader = await bridge({ op: 'read', id }),
                        pin = await bridge({ op: 'pin' });
                    if (!reader.ok || !pin.ok)
                        throw Error('Actual native reset leases unavailable.');
                    return {
                        reader: (reader.value as { handle: string }).handle,
                        pin: (pin.value as { handle: string }).handle,
                    };
                }, keep[0]);
                const held = await host!.snapshot();
                assert.ok(held.capture.owners.reader > 0 && held.capture.owners.pin > 0);
                const epoch = destroyed;
                await page.reload();
                await page.waitForFunction(() => Boolean(window.memoryProduct));
                assert.ok(
                    destroyed > epoch,
                    'Native old renderer realm was not actually destroyed.',
                );
                const staleReplies = await page.evaluate(async (handles) => {
                    const bridge = window.diagnosticHub!.captureStorage!;
                    return [
                        await bridge({ op: 'pull', handle: handles.reader }),
                        await bridge({ op: 'unpin', handle: handles.pin }),
                    ];
                }, stale);
                assert.equal(staleReplies[0].ok, false, 'Old native reader remained usable.');
                assert.equal(staleReplies[1].ok, true, 'Idempotent stale unpin cleanup failed.');
                const reset = await host!.snapshot();
                assert.equal(reset.capture.owners.reader, 0);
                assert.equal(reset.capture.owners.pin, 0);
                coverage.add(nativeGenerationCase);
                await context.emit('actual-native-generation-reset', {
                    stale,
                    held,
                    reset,
                    staleReplies,
                });
                const reopened = await page.evaluate(() => window.memoryProduct.catalog());
                assert.deepEqual(reopened.map((row) => row.id).sort(), [...keep].sort());
                await page.evaluate(() => window.memoryProduct.closeRepository());
                await page.reload();
                await page.waitForFunction(() => Boolean(window.memoryProduct));
                await cold();
                coverage.add('clear-reopen');
                coverage.add('reload');
                coverage.add(
                    input.catalogMode === 'constant'
                        ? 'constant-catalog'
                        : 'bounded-growing-catalog',
                );
                for (const id of coverage)
                    assert.ok(supported.includes(id as never), 'Unadvertised native case: ' + id);
                assert.deepEqual(host!.errors(), []);
                let diskBytes = 0;
                async function disk(directory: string) {
                    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                        assert.ok(!entry.isSymbolicLink());
                        const file = path.join(directory, entry.name);
                        if (entry.isDirectory()) await disk(file);
                        else diskBytes += (await fs.stat(file)).size;
                    }
                }
                await disk(context.profile);
                latestCycle = {
                    input,
                    coverage: [...coverage],
                    accounting,
                    keep,
                    ssh,
                    results,
                    lifecycle,
                    diskBytes,
                };
                await context.emit('aggregate-native-cycle', latestCycle);
                return {
                    coverage: [...coverage],
                    capturedBytes: accounting.committedBytes,
                    exportedBytes:
                        serial.exportedBytes +
                        results.exports.reduce((sum, row) => sum + row.bytes, 0),
                    diskBytes,
                    diskRecords: keep.length,
                    cache: {
                        referenceId: anchor,
                        observedCaptureBytes:
                            accounting.observedBytes ?? 'unavailable; per-capture nulls retained',
                        knownObservedCaptureSubtotal: accounting.knownObservedSubtotal,
                        createdCaptureRecords: accounting.createdRecords,
                        diskPrecision:
                            'Actual private-profile logical file sizes, includes intentional cache and metadata.',
                    },
                };
            } catch (error) {
                failed = true;
                await context.emit('aggregate-native-cycle-failed', {
                    primary: String(error),
                    stack: error instanceof Error ? error.stack : null,
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
            if (closed)
                return Object.fromEntries(
                    [...new Set([...ownerKinds, ...(context.viewer ? viewerOwnerKinds : [])])].map(
                        (key) => [key, 0],
                    ),
                );
            assert.ok(host && gateway);
            const page = await host.page.evaluate(() => ({
                    operation: window.memoryProduct.ownership(),
                    ledger: window.memoryProduct.ledgerDelta(),
                })),
                main = await host.snapshot(),
                remote = await gateway.snapshotOwners();
            const counts: Record<string, number> = {
                ...page.operation.owners,
                ...aggregateNativeResourceCounts(main),
            };
            for (const kind of ['writer', 'reader', 'pin', 'export', 'rpc', 'cleanup']) {
                const value = main.capture?.owners[kind];
                if (typeof value !== 'number')
                    throw Error('Actual native capture owner missing: ' + kind);
                counts[kind] += value;
            }
            const add = (...kinds: string[]) =>
                page.ledger.added.filter((row) => kinds.includes(row.kind)).length;
            counts.listenerDelta = add('event-listener');
            counts.timerDelta = add('timeout', 'interval');
            counts.databaseConnectionDelta = add('idb-connection');
            if (context.viewer)
                Object.assign(counts, {
                    raf: add('animation-frame'),
                    observer: add('resize-observer', 'mutation-observer'),
                    pointerCapture: add('pointer-capture'),
                    worker: add('worker'),
                    canvas: add('canvas'),
                    blobUrl: add('object-url'),
                    pdfWindow: host.page
                        .context()
                        .pages()
                        .filter((page) => page !== host!.page && !page.isClosed()).length,
                });
            counts.nativeSshOperations =
                main.ssh.pendingOperations +
                main.ssh.streams.currentStates +
                main.ssh.streams.retiringStates +
                main.ssh.streams.readers +
                main.ssh.streams.pendingAcks;
            counts.gatewayOperations =
                remote.product.httpBodyReaders +
                remote.product.inFlight +
                remote.product.pendingConnections +
                remote.product.ownedSessions +
                remote.product.retiringSessions;
            counts.targetResources = Object.values(remote.target.owners).reduce(
                (sum, value) => sum + value,
                0,
            );
            await context.emit('aggregate-native-raw-owners', {
                stage,
                page,
                main,
                remote,
                counts,
            });
            return counts;
        },
        teardown,
        async assertDescendantsExited() {
            assert.ok(closed);
            await host!.assertExited();
            await gateway!.assertExited();
        },
        async inspect() {
            return {
                sourceSHA256,
                supported,
                unsupported,
                memoryScope,
                baselineAudit: baseline,
                latestCycle,
                busy,
                failed,
                closed,
            };
        },
    };
}
