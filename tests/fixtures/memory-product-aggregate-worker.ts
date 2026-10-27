import assert from 'node:assert/strict';
import { expect, type CDPSession, type Page, type Worker } from '@playwright/test';
import { workerQuotaMessage } from './memory-product-worker-faults';
import type { ResultsExportReadFault } from './memory-product-results-ui';
import {
    requireProductParentClosure,
    type ProductParentClosure,
} from './memory-product-parent-closure';
import {
    AggregateCallTracker,
    type AggregateDiagnosticClock,
} from './memory-product-aggregate-diagnostics';
import type { InspectionNativeStop } from './memory-product-inspection';

export interface ExportWorkerInspection {
    bind(url: string, version: () => string | undefined): Promise<object>;
    transition(
        binding: object,
        input: {
            closed(): boolean;
            joinWorkerClose(): Promise<void>;
            acknowledge(stop: InspectionNativeStop): Promise<void>;
        },
    ): Promise<void>;
}

export interface AggregateWorkerSnapshot {
    product: {
        owners: Record<string, number>;
        jobs: unknown[];
        services: Record<string, boolean>;
        cache: Record<string, number>;
    };
    independent: {
        installedBeforeStore: boolean;
        owners: Record<string, number>;
        connections: {
            id: number;
            name: string;
            version: number;
            transactions: number;
            closeRequested: boolean;
        }[];
        logicalCloseAcknowledgements: number;
        physicalClose: string;
    };
}
export function assertAggregateWorkerQuiescent(value: AggregateWorkerSnapshot) {
    assert.equal(value.independent.installedBeforeStore, true);
    for (const owners of [value.product.owners, value.independent.owners]) {
        assert.ok(Object.keys(owners).length > 0, 'Missing independent worker owner vector.');
        for (const [kind, count] of Object.entries(owners))
            assert.equal(count, 0, 'Worker owner remains: ' + kind);
    }
    assert.deepEqual(value.product.jobs, []);
    assert.equal(
        value.independent.connections.length,
        Number(value.product.services.captureConnection) +
            Number(value.product.services.consoleConnection),
        'Worker service/independent connection counts disagree.',
    );
    for (const db of value.independent.connections) {
        assert.equal(db.transactions, 0);
        assert.equal(db.closeRequested, false);
        assert.ok(db.id > 0 && db.name && db.version > 0);
    }
}
/** Owns observations only; actual product jobs/stores must settle before runtime retirement. */
export class AggregateExportWorker {
    private worker?: Worker;
    private workerDone?: Promise<void>;
    private closed = false;
    private versionId?: string;
    private protocol?: CDPSession;
    private protocolClosed = false;
    private protocolDone?: Promise<void>;
    private protocolCloseListener?: () => void;
    private workerCloseListener?: () => void;
    private disposed?: {
        disposition:
            | 'detached-live-session'
            | 'session-close-observed'
            | 'no-session-created'
            | 'disposed-by-verified-parent-closure';
        workerCloseObserved: boolean;
        protocolCloseObserved: boolean;
        retired: number;
        hostId?: string;
    };
    private disposing?: Promise<NonNullable<AggregateExportWorker['disposed']>>;
    private disposalEvidenceFailure?: unknown;
    private disposalEvidenceFailed = false;
    private disposalStarted = false;
    private retired = 0;
    private inspection?: ExportWorkerInspection;
    private inspectionReleased = false;
    private inspectionDetachAcknowledged = false;
    private inspectionGeneration = 1;
    private inspectionBinding = false;
    private inspectionFailure?: unknown;
    private retiring = false;
    private readonly calls: AggregateCallTracker;
    private observe<T>(phase: string, work: () => Promise<T>) {
        return this.calls.run(phase, work);
    }
    private readonly version = ({
        versions,
    }: {
        versions: { scriptURL: string; versionId: string; runningStatus: string }[];
    }) => {
        for (const value of versions)
            if (value.scriptURL === this.url && value.runningStatus === 'running')
                this.versionId = value.versionId;
    };
    readonly url: string;
    constructor(
        private page: Page,
        private emit: (stage: string, data: unknown) => Promise<void>,
        clock?: AggregateDiagnosticClock,
    ) {
        this.url = new URL('/capture-download-sw.js', page.url()).href;
        this.calls = new AggregateCallTracker(emit, 'aggregate-service-worker-call', clock);
    }
    async initialize() {
        assert.ok(!this.disposalStarted && !this.protocol, 'Worker observer initialized twice.');
        await this.observe('protocol-create', async () => {
            this.protocol = await this.page.context().newCDPSession(this.page);
            this.inspectionDetachAcknowledged = false;
            this.protocolClosed = false;
            this.protocolDone = new Promise((resolve) => {
                this.protocolCloseListener = () => {
                    this.protocolClosed = true;
                    resolve();
                };
                this.protocol!.once('close', this.protocolCloseListener);
            });
            this.protocol.on('ServiceWorker.workerVersionUpdated', this.version);
        });
        assert.equal(this.disposalStarted, false);
        await this.observe('protocol-enable', () => this.protocol!.send('ServiceWorker.enable'));
        assert.equal(this.disposalStarted, false);
    }
    configureInspection(value: ExportWorkerInspection) {
        assert.equal(this.inspection, undefined);
        assert.ok(!this.disposalStarted && !this.worker);
        this.inspection = value;
    }
    async releaseForInspection() {
        this.calls.assertJoined();
        assert.ok(
            this.retiring && this.worker && !this.closed,
            'Exact retiring worker must remain observed.',
        );
        assert.ok(!this.inspectionReleased && this.protocol && !this.disposalStarted);
        await this.observe('inspection-detach-protocol', () => this.protocol!.detach());
        assert.equal(this.disposalStarted, false);
        this.inspectionDetachAcknowledged = true;
        this.protocol!.off('ServiceWorker.workerVersionUpdated', this.version);
        if (this.protocolCloseListener) this.protocol!.off('close', this.protocolCloseListener);
        this.protocol = undefined;
        this.protocolDone = undefined;
        this.protocolCloseListener = undefined;
        this.inspectionReleased = true;
    }
    assertInspectionReleased() {
        this.calls.assertJoined();
        assert.equal(this.inspectionReleased, true);
        assert.equal(this.protocol, undefined);
    }
    async bindInspection(page: Page, generation: number) {
        this.assertInspectionReleased();
        assert.equal(
            this.worker,
            undefined,
            'Native retirement evidence must settle before rebind.',
        );
        assert.equal(generation, this.inspectionGeneration + 1);
        this.inspectionBinding = true;
        this.page = page;
        try {
            assert.equal(new URL('/capture-download-sw.js', page.url()).href, this.url);
            await this.initialize();
            assert.equal(this.disposalStarted, false);
            this.inspectionGeneration = generation;
            this.inspectionReleased = false;
        } finally {
            this.inspectionBinding = false;
        }
    }
    assertInspectionBound(page: Page, generation: number) {
        this.calls.assertJoined();
        assert.equal(this.inspectionReleased, false);
        assert.equal(this.inspectionBinding, false);
        assert.equal(this.inspectionFailure, undefined);
        assert.equal(this.page, page);
        assert.equal(this.inspectionGeneration, generation);
        assert.ok(this.protocol && !this.protocolClosed && !this.disposalStarted);
    }
    inspectionPageForCleanup() {
        return this.page;
    }
    assertInspectionCallsJoined() {
        this.calls.assertJoined();
    }
    private current() {
        assert.ok(!this.disposalStarted, 'Worker observer admission is closed.');
        assert.equal(this.inspectionFailure, undefined);
        assert.equal(this.inspectionReleased, false);
        const workers = this.page
            .context()
            .serviceWorkers()
            .filter((worker) => worker.url() === this.url);
        assert.equal(workers.length, 1, 'Exactly one actual export worker must be observed.');
        if (this.worker && !this.closed)
            assert.equal(
                workers[0],
                this.worker,
                'Worker identity changed during admitted operations.',
            );
        if (!this.worker || this.closed) {
            this.worker = workers[0];
            this.closed = false;
            this.workerDone = new Promise((resolve) => {
                this.workerCloseListener = () => {
                    this.closed = true;
                    resolve();
                };
                this.worker!.once('close', this.workerCloseListener);
            });
        }
        return this.worker;
    }
    readonly faults: ResultsExportReadFault = {
        realm: 'service-worker',
        quotaMessage: workerQuotaMessage,
        arm: async (action) => {
            await this.observe('fault-arm', () =>
                this.current().evaluate(
                    (action) => (globalThis as any).__memoryProductWorker.faults.arm(action),
                    action,
                ),
            );
        },
        status: async () => {
            const value = await this.observe('fault-status', () =>
                this.current().evaluate(() =>
                    (globalThis as any).__memoryProductWorker.faults.status(),
                ),
            );
            assert.ok(value);
            return { method: 'read', ...value };
        },
        release: async () => {
            await this.observe('fault-release', () =>
                this.current().evaluate(() =>
                    (globalThis as any).__memoryProductWorker.faults.release(),
                ),
            );
        },
        clear: async () => {
            await this.observe('fault-clear', () =>
                this.current().evaluate(() =>
                    (globalThis as any).__memoryProductWorker.faults.clear(),
                ),
            );
        },
        snapshot: () => this.snapshot(),
    };
    async snapshot(): Promise<AggregateWorkerSnapshot> {
        return this.observe('owner-snapshot', () =>
            this.current().evaluate(async () => {
                const probe = (globalThis as any).__memoryProductWorker;
                if (!probe?.snapshot || !probe.ledger)
                    throw Error('Independent worker probe absent.');
                return { product: await probe.snapshot(), independent: probe.ledger() };
            }),
        );
    }
    async retire(destroyClientRealms: () => Promise<void>) {
        assert.equal(this.retiring, false, 'Worker retirement already owns work.');
        assert.equal(this.inspectionFailure, undefined);
        this.retiring = true;
        try {
            await expect
                .poll(async () => {
                    const value = await this.snapshot();
                    return (
                        Object.values(value.product.owners).every((value) => value === 0) &&
                        Object.values(value.independent.owners).every((value) => value === 0)
                    );
                })
                .toBe(true);
            const before = await this.snapshot();
            assertAggregateWorkerQuiescent(before);
            const worker = this.current();
            const inspectionBinding = this.inspection
                ? await this.observe('bind-native-before-unregister', () =>
                      this.inspection!.bind(this.url, () => this.versionId),
                  )
                : undefined;
            const clients = await this.observe('snapshot-owning-clients', () =>
                worker.evaluate(async () => {
                    const clients = await (globalThis as any).clients.matchAll({ type: 'window' });
                    if (clients.length > 16)
                        throw Error('Worker client observation bound exceeded.');
                    return clients.map((row: { id: string; url: string }) => ({
                        id: row.id,
                        url: row.url,
                    }));
                }),
            );
            const stores = await this.observe('close-idle-stores', () =>
                worker.evaluate(() => (globalThis as any).__memoryProductWorker.closeIdleStores()),
            );
            assert.equal(stores.after.connections.length, 0);
            const unregistered = await this.observe('unregister-exact-worker', () =>
                this.page.evaluate(async (url) => {
                    const registrations = await navigator.serviceWorker.getRegistrations();
                    const found = registrations.filter((row) => row.active?.scriptURL === url);
                    if (found.length !== 1)
                        throw Error('Actual worker registration identity ambiguous.');
                    return found[0].unregister();
                }, this.url),
            );
            assert.equal(unregistered, true);
            assert.ok(
                this.protocol && this.versionId,
                'Actual worker version identity was not observed.',
            );
            await this.emit('aggregate-service-worker-awaiting-client-unload', {
                url: this.url,
                versionId: this.versionId,
                clients,
                stores,
                unregistered,
                runtimeWorkerClosed: this.closed,
                scope: 'Unregister does not unload existing controlled clients. No idle-zero receipt before actual worker close.',
            });
            await this.observe('destroy-owning-client-realms', destroyClientRealms);
            const acknowledge = async (nativeStop?: InspectionNativeStop) => {
                assert.equal(this.closed, true);
                assert.deepEqual(
                    this.page
                        .context()
                        .serviceWorkers()
                        .filter((row) => row.url() === this.url),
                    [],
                );
                const nextRetired = this.retired + 1;
                await this.emit('aggregate-service-worker-retired', {
                    url: this.url,
                    versionId: this.versionId,
                    before,
                    stores,
                    unregistered,
                    clientsBeforeUnload: clients,
                    playwrightWorkerCloseObserved: true,
                    nativeStop: nativeStop ?? null,
                    retired: nextRetired,
                    scope: nativeStop
                        ? 'Logical/store joins and SDK close precede fresh native stopped-event evidence; no physical IDB-free inference.'
                        : 'SDK close joined; native stop is not independently qualified on this path.',
                });
                this.retired = nextRetired;
                if (this.workerCloseListener) this.worker?.off('close', this.workerCloseListener);
                this.worker = undefined;
                this.workerDone = undefined;
                this.workerCloseListener = undefined;
                this.versionId = undefined;
            };
            if (this.inspection && inspectionBinding) {
                await this.inspection.transition(inspectionBinding, {
                    closed: () => this.closed,
                    joinWorkerClose: () => this.workerDone!,
                    acknowledge,
                });
            } else {
                await this.observe('join-worker-close', () => this.workerDone!);
                await acknowledge();
            }
        } catch (error) {
            if (this.inspection) this.inspectionFailure = error;
            throw error;
        } finally {
            this.retiring = false;
        }
    }
    private async disposeOnce(parentClosure?: ProductParentClosure) {
        this.calls.assertJoined();
        assert.equal(this.inspectionBinding, false, 'Inspection bind still owns the observer.');
        if (this.worker && !this.closed)
            throw Error('Service worker observation cannot dispose before its close notification.');
        let disposition: NonNullable<AggregateExportWorker['disposed']>['disposition'];
        if (parentClosure) {
            requireProductParentClosure(parentClosure, this.page);
            // Parent connection/process closure is an alternative observer disposition.
            // It does not invent a session close event or a per-cycle worker retirement.
            disposition = 'disposed-by-verified-parent-closure';
        } else if (this.protocol && !this.protocolClosed) {
            await this.observe('detach-observer-protocol', () => this.protocol!.detach());
            await this.observe('join-observer-protocol-close', () => this.protocolDone!);
            disposition = 'detached-live-session';
        } else if (this.protocolClosed) {
            disposition = 'session-close-observed';
        } else {
            disposition = this.inspectionDetachAcknowledged
                ? 'detached-live-session'
                : 'no-session-created';
        }
        this.calls.assertJoined();
        this.protocol?.off('ServiceWorker.workerVersionUpdated', this.version);
        if (this.protocolCloseListener) this.protocol?.off('close', this.protocolCloseListener);
        if (this.workerCloseListener) this.worker?.off('close', this.workerCloseListener);
        const receipt = {
            disposition,
            workerCloseObserved: this.closed,
            protocolCloseObserved: this.protocolClosed,
            retired: this.retired,
            ...(parentClosure ? { hostId: parentClosure.hostId } : {}),
        };
        this.protocol = undefined;
        this.protocolDone = undefined;
        this.protocolCloseListener = undefined;
        this.worker = undefined;
        this.workerDone = undefined;
        this.workerCloseListener = undefined;
        this.versionId = undefined;
        try {
            await this.emit('aggregate-service-worker-observer-disposed', receipt);
        } catch (error) {
            this.disposalEvidenceFailed = true;
            this.disposalEvidenceFailure = error;
            throw error;
        }
        this.disposed = receipt;
        return receipt;
    }
    async dispose(parentClosure?: ProductParentClosure) {
        if (parentClosure) requireProductParentClosure(parentClosure, this.page);
        if (this.disposing) return this.disposing;
        if (this.disposalEvidenceFailed) throw this.disposalEvidenceFailure;
        if (this.disposed) return this.disposed;
        this.disposalStarted = true;
        // Publish the shared join before any disposer/evidence callback can reenter.
        const task = Promise.resolve().then(() => this.disposeOnce(parentClosure));
        this.disposing = task;
        try {
            return await task;
        } finally {
            if (this.disposing === task) this.disposing = undefined;
        }
    }
    idleSnapshot() {
        this.calls.assertJoined();
        if (this.worker && !this.closed)
            throw Error('Worker is still live; read its actual owners.');
        return {
            retired: this.retired,
            runtimeWorkerActive: 0,
            basis: 'Actual Worker close was joined before each observer retirement.',
        };
    }
    pending() {
        return this.calls.pending();
    }
}
