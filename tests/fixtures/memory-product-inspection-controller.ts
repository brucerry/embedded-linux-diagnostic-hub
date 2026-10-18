import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { createProductBrowser } from './memory-product-browser-host';
import { ProductInspection } from './memory-product-inspection';
import { ProductInspectionRealm } from './memory-product-inspection-realm';
import { AggregateExportWorker } from './memory-product-aggregate-worker';
import { createAggregateViewerWitness } from './memory-product-aggregate-workloads';
import type { ProductViewerWorkers } from './memory-product-viewer-lifecycle';
import { AggregateCallTracker } from './memory-product-aggregate-diagnostics';
import { runNativeCleanup } from './memory-product-native-cleanup';
type Host = Awaited<ReturnType<typeof createProductBrowser>>;
type Connection = Awaited<ReturnType<Host['createInspection']>>;
/** Construct this owner before starting any asynchronous connection binding. */
export class ProductInspectionController {
    private state: 'new' | 'initializing' | 'ready' | 'retiring' | 'failed' | 'closing' | 'closed' =
        'new';
    private connection?: Connection;
    private inspection?: ProductInspection<Page>;
    private readonly realm: ProductInspectionRealm;
    private viewer?: ProductViewerWorkers;
    private viewerArtifactSHA256?: string;
    private exportWorker?: AggregateExportWorker;
    private readonly calls: AggregateCallTracker;
    private epochs = new Map<object, { binding: unknown; controlOffset: number }>();
    private initialization?: Promise<void>;
    private retirement?: Promise<void>;
    private closing?: Promise<void>;
    constructor(
        private host: Host,
        private emit: (stage: string, value: unknown) => Promise<void>,
        private record: (stage: string, value: unknown) => void,
    ) {
        this.realm = new ProductInspectionRealm(emit);
        this.calls = new AggregateCallTracker(emit, 'inspection-controller-call');
    }
    initialize() {
        assert.equal(this.state, 'new');
        this.state = 'initializing';
        const task = Promise.resolve()
            .then(async () => {
                assert.equal(this.state, 'initializing');
                this.connection = await this.host.createInspection(this.record);
                assert.equal(this.state, 'initializing');
                const connection = this.connection;
                this.inspection = new ProductInspection({
                    currentPage: connection.currentPage,
                    identity: connection.identity,
                    disconnect: connection.disconnect,
                    reconnect: connection.reconnect,
                    verifyCurrentIdentity: connection.verify,
                    commitBinding: connection.commit,
                    emit: this.emit,
                });
                const page = connection.currentPage();
                const viewerBinding = await createAggregateViewerWitness(
                    page,
                    path.join(this.host.root, 'assets'),
                );
                this.viewer = viewerBinding.workers;
                this.viewerArtifactSHA256 = viewerBinding.sha256;
                assert.equal(this.state, 'initializing');
                this.exportWorker = new AggregateExportWorker(page, this.emit);
                this.exportWorker.configureInspection({
                    bind: async (url, version) => {
                        assert.equal(this.state, 'retiring');
                        assert.equal(this.epochs.size, 0);
                        const metadata = connection.metadata;
                        const matching = () =>
                            [...metadata.versions.values()].filter(
                                (row: any) =>
                                    row.scriptURL === url &&
                                    row.versionId === version() &&
                                    row.runningStatus === 'running',
                            );
                        await metadata.wait(
                            () => Boolean(version()) && matching().length === 1,
                            'bind-exact-retiring-worker',
                        );
                        const value = matching()[0] as any;
                        const targets = (
                            await metadata.send('Target.getTargets')
                        ).targetInfos.filter(
                            (row: any) => row.type === 'service_worker' && row.url === url,
                        );
                        assert.equal(targets.length, 1);
                        if (value.targetId) assert.equal(value.targetId, targets[0].targetId);
                        const binding = Object.freeze({
                            versionId: value.versionId,
                            registrationId: value.registrationId,
                            scriptURL: value.scriptURL,
                            targetId: targets[0].targetId,
                        });
                        const token = Object.freeze({
                            generation: this.inspection!.snapshot().generation,
                        });
                        this.epochs.set(token, { binding, controlOffset: metadata.events.length });
                        await this.emit(
                            'inspection-native-worker-bound-before-unregister',
                            binding,
                        );
                        return token;
                    },
                    transition: async (token, input) => {
                        assert.equal(this.state, 'retiring');
                        const epoch = this.epochs.get(token);
                        assert.ok(epoch);
                        await this.calls.run(
                            'join-actual-viewer-workers-before-disconnect',
                            async () => {
                                const receipts = await this.viewer!.settleInspectionWorkers();
                                await this.emit(
                                    'inspection-viewer-workers-closed-before-disconnect',
                                    receipts,
                                );
                            },
                        );
                        const metadata = connection.metadata,
                            binding = epoch.binding as any;
                        await metadata.wait(() => {
                            const row = metadata.versions.get(binding.versionId);
                            return (
                                row?.status === 'redundant' &&
                                row.runningStatus === 'running' &&
                                row.controlledClients.length === 0
                            );
                        }, 'redundant-worker-without-clients');
                        await this.inspection!.retire({
                            observeRelease: (disconnect, join) =>
                                connection.observeRelease(
                                    epoch.binding,
                                    epoch.controlOffset,
                                    input.closed,
                                    disconnect,
                                    join,
                                ),
                            joinWorkerClose: input.joinWorkerClose,
                            acknowledgeNativeStop: input.acknowledge,
                        });
                        this.inspection!.assertReady();
                        connection.finishReady(connection.currentPage());
                        this.epochs.delete(token);
                    },
                });
                await this.realm.bind(page, 1);
                assert.equal(this.state, 'initializing');
                await this.exportWorker.initialize();
                assert.equal(this.state, 'initializing');
                this.inspection.register('host-events', connection.hostObserver);
                this.inspection.register('host-downloads', connection.downloadObserver);
                this.inspection.register('aggregate-realm', this.realm);
                this.inspection.register('aggregate-viewer', {
                    release: async () => this.viewer!.releaseForInspection(),
                    assertReleased: () => this.viewer!.assertInspectionReleased(),
                    bind: async (next, generation) => this.viewer!.bindInspection(next, generation),
                    assertBound: (next, generation) =>
                        this.viewer!.assertInspectionBound(next, generation),
                });
                this.inspection.register('aggregate-export', {
                    release: () => this.exportWorker!.releaseForInspection(),
                    assertReleased: () => this.exportWorker!.assertInspectionReleased(),
                    bind: (next, generation) => this.exportWorker!.bindInspection(next, generation),
                    assertBound: (next, generation) =>
                        this.exportWorker!.assertInspectionBound(next, generation),
                });
                this.host.bindInspectionAdmission(() => {
                    assert.equal(this.state, 'ready', 'Controller admission is closed.');
                    this.inspection!.assertReady();
                });
                assert.equal(this.state, 'initializing');
                this.state = 'ready';
            })
            .catch((error) => {
                if (this.state !== 'closing') this.state = 'failed';
                throw error;
            });
        this.initialization = task;
        return task;
    }
    async use<T>(name: string, work: () => Promise<T>) {
        assert.equal(this.state, 'ready');
        return this.inspection!.use(name, work);
    }
    retire(destroyClientRealms: (page: Page) => Promise<void>) {
        assert.equal(this.state, 'ready');
        this.inspection!.assertReady();
        this.inspection!.assertJoined();
        this.state = 'retiring';
        const task = Promise.resolve()
            .then(async () => {
                assert.equal(this.state, 'retiring');
                this.inspection!.assertReady();
                this.inspection!.assertJoined();
                await this.exportWorker!.retire(() =>
                    destroyClientRealms(this.connection!.currentPage()),
                );
                assert.equal(this.state, 'retiring');
                this.state = 'ready';
            })
            .catch((error) => {
                if (this.state !== 'closing') this.state = 'failed';
                throw error;
            });
        this.retirement = task;
        return task;
    }
    viewerWorkers() {
        assert.ok(this.viewer);
        return this.viewer;
    }
    viewerArtifact() {
        assert.ok(this.viewerArtifactSHA256);
        return this.viewerArtifactSHA256;
    }
    exportReadFaults() {
        assert.equal(this.state, 'ready');
        this.inspection!.assertReady();
        assert.ok(this.exportWorker);
        const faults = this.exportWorker.faults;
        const snapshot = faults.snapshot;
        assert.ok(snapshot);
        const admitted = <T>(name: string, work: () => Promise<T>) =>
            this.use(name, async () => {
                assert.equal(this.state, 'ready');
                return work();
            });
        return {
            ...faults,
            arm: (action: Parameters<typeof faults.arm>[0]) =>
                admitted('export-fault-arm', () => faults.arm(action)),
            status: () => admitted('export-fault-status', () => faults.status()),
            release: () => admitted('export-fault-release', () => faults.release()),
            clear: () => admitted('export-fault-clear', () => faults.clear()),
            snapshot: () => admitted('export-fault-snapshot', () => snapshot()),
        };
    }
    exportIdleSnapshot() {
        assert.equal(this.state, 'ready');
        this.inspection!.assertReady();
        assert.ok(this.exportWorker);
        return this.exportWorker.idleSnapshot();
    }
    realmSnapshot() {
        return this.realm.snapshot();
    }
    snapshot() {
        return {
            state: this.state,
            inspection: this.inspection?.snapshot(),
            connection: this.connection?.snapshotOwners(),
            nativeIdentity: this.connection?.identity,
            realm: this.realm.snapshot(),
            viewer: this.viewer?.snapshotObserver(),
            exportPending: this.exportWorker?.pending(),
            activeRetirementEpochs: this.epochs.size,
        };
    }
    close() {
        if (this.closing) return this.closing;
        this.state = 'closing';
        this.inspection?.closeAdmission();
        const task = Promise.resolve().then(async () => {
            await runNativeCleanup(
                [
                    { name: 'close-actual-host', run: () => this.host.close() },
                    { name: 'join-actual-host', run: () => this.host.assertExited() },
                    {
                        name: 'join-initialization',
                        run: async () => {
                            await this.initialization?.catch(() => {});
                        },
                    },
                    {
                        name: 'join-retirement',
                        run: async () => {
                            await this.retirement?.catch(() => {});
                        },
                    },
                    {
                        name: 'assert-actual-calls-joined',
                        run: async () => {
                            this.inspection?.assertJoined();
                            this.realm.assertJoined();
                            this.exportWorker?.assertInspectionCallsJoined();
                            this.calls.assertJoined();
                        },
                    },
                    {
                        name: 'dispose-realm-after-exact-parent',
                        run: async () => {
                            const page = this.realm.cleanupPage();
                            if (page)
                                this.realm.disposeAfterParentClosure(
                                    await this.host.joinParentClosure(page),
                                );
                        },
                    },
                    {
                        name: 'dispose-export-after-exact-parent',
                        run: async () => {
                            if (this.exportWorker)
                                await this.exportWorker.dispose(
                                    await this.host.joinParentClosure(
                                        this.exportWorker.inspectionPageForCleanup(),
                                    ),
                                );
                        },
                    },
                    {
                        name: 'dispose-viewer-after-exact-parent',
                        run: async () => {
                            if (this.viewer) {
                                await this.host.joinParentClosure(
                                    this.viewer.inspectionPageForCleanup(),
                                );
                                await this.viewer.settleInspectionWorkers();
                                this.viewer.dispose();
                            }
                        },
                    },
                ],
                this.emit,
                { stage: 'inspection-parent-cleanup-step' },
            );
            this.inspection?.acknowledgeClosed();
            await this.emit('inspection-controller-actual-parent-cleanup', this.snapshot());
            assert.equal(this.state, 'closing');
            this.state = 'closed';
        });
        this.closing = task;
        return task;
    }
}
