import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../../src/app/App';
import '../../src/styles/workspace.css';
import { productInstances, productOwnership, productFaults } from './memory-product-registry';
import { installProductSerial } from './memory-product-serial';
import { SerialGeometryRead } from './memory-product-geometry';
import { openCaptureRepository } from '../../src/features/automation/capture/repository';
import type { SerialSession } from '../../src/features/serial/session';
import type { FlowRunner } from '../../src/features/automation/runner';
import { captureVerifier } from '../../shared/capture-store';
import type { BrowserLedgerToken } from './memory-product-browser-ledger';
import type {} from './memory-product-ledger-entry';
import { readProductPageRefs } from './memory-product-page-refs';
import { joinAggregatePageOperations } from './memory-product-aggregate-cleanup';
import type { AggregateRunnerCleanupTarget } from './memory-product-aggregate-cleanup';
import { openConsoleArchive } from '../../src/features/automation/capture/console-archive';
import {
    catalogConsoleArchive,
    summarizeConsoleRead,
    type ConsoleReadLimits,
} from './memory-product-console-read';

const serial = installProductSerial({ chunkBytes: 16384, prompt: 'qualification# ' });
const container = document.getElementById('root');
if (!container) throw Error('Qualification root missing.');
let root: Root | undefined;
let mountCount = 0;
declare const __MEMORY_PRODUCT_COLD_START__: boolean;
let ledgerBaseline: BrowserLedgerToken | undefined;
function latest<T>(kind: Parameters<typeof productInstances>[0]): T {
    const all = productInstances(kind);
    if (!all.length) throw Error(`Product instance not mounted: ${kind}`);
    return all.at(-1)!.value as T;
}
const api = {
    serial,
    faults: productFaults,
    joinAggregatePageOperations,
    mount() {
        if (root) throw Error('Actual App already mounted.');
        root = createRoot(container!);
        mountCount++;
        root.render(
            <React.StrictMode>
                <App />
            </React.StrictMode>,
        );
    },
    unmount() {
        if (!root) throw Error('Actual App not mounted.');
        root.unmount();
        root = undefined;
    },
    async closeSerial() {
        await latest<SerialSession>('serial').close(true);
    },
    serialStatus() {
        const serial = latest<SerialSession>('serial');
        return { ...serial.current, isOwned: serial.isOwned };
    },
    ownership: productOwnership,
    async createInspectionFixtureCapture(ordinal: number) {
        if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 3)
            throw Error('Inspection fixture ordinal outside the three-record bound.');
        const repository = await openCaptureRepository();
        const capture = await repository.begin({
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: crypto.randomUUID(),
            stepId: crypto.randomUUID(),
            command: 'synthetic-storage-inspection-' + ordinal,
            name: 'Synthetic storage fixture; no transport execution',
            startedAt: new Date().toISOString(),
        });
        return repository.seal(capture.id, 0, 'inspection-storage-fixture');
    },
    async consoleCatalog() {
        const view = await openConsoleArchive();
        try {
            return await catalogConsoleArchive(view.archive, 500);
        } finally {
            await view.dispose();
        }
    },
    async readConsoleSummary(id: string, limits: ConsoleReadLimits) {
        const view = await openConsoleArchive();
        try {
            return await summarizeConsoleRead(id, view.archive.read(id), limits);
        } finally {
            await view.dispose();
        }
    },
    pageRefs() {
        if (!root) throw Error('Actual App is unmounted.');
        return readProductPageRefs();
    },
    browserExports() {
        if (typeof (globalThis as any).__memoryBrowserExports !== 'function')
            throw Error('Actual browser export module probe not loaded.');
        return (globalThis as any).__memoryBrowserExports() as {
            active: number;
            rpc: number;
            helpers: number;
            busyHelpers: number;
            connectedHelpers: number;
        };
    },
    baselineAfterUnmount() {
        if (root) throw Error('Product ledger baseline requires an actually unmounted App.');
        const actual = productOwnership();
        for (const count of Object.values(actual.owners))
            if (count !== 0)
                throw Error(
                    'Cannot baseline active product operation owners: ' + JSON.stringify(actual),
                );
        if (ledgerBaseline) throw Error('Original product ledger baseline is immutable.');
        ledgerBaseline = window.memoryProductLedger.baseline();
        return {
            rootId: window.memoryProductLedger.identify(container!),
            snapshot: window.memoryProductLedger.snapshot(),
        };
    },
    coldBaselineBeforeFirstMount() {
        if (root || mountCount !== 0 || ledgerBaseline)
            throw Error('Cold baseline requires a never-mounted actual App realm.');
        const kinds = [
            'serial',
            'runner',
            'repository',
            'native-repository',
            'gateway',
            'console-journal',
        ] as const;
        const instances = Object.fromEntries(
            kinds.map((kind) => [kind, productInstances(kind).length]),
        );
        if (Object.values(instances).some((value) => value !== 0))
            throw Error('Product instances existed before the declared cold App baseline.');
        const operation = productOwnership();
        if (Object.values(operation.owners).some((value) => value !== 0))
            throw Error('Cannot baseline active cold operation owners.');
        const snapshot = window.memoryProductLedger.snapshot();
        if (
            snapshot.product.some(
                (row) => !['event-listener', 'mutation-observer'].includes(row.kind),
            )
        )
            throw Error('Unexpected resource kind before first App mount.');
        if (snapshot.product.some((row) => row.target?.disposition === 'detached'))
            throw Error('Detached-node registration cannot enter a cold App baseline.');
        ledgerBaseline = window.memoryProductLedger.baseline();
        return {
            mountCount,
            instances,
            operation,
            snapshot,
            rootId: window.memoryProductLedger.identify(container!),
            scope: 'Actual never-mounted module/harness realm baseline; raw registrations retained and source-bound. No earlier App operation can be absorbed.',
        };
    },
    async abortActualVersionChange() {
        const store = latest<any>('repository');
        const db: IDBDatabase | undefined = store.db;
        if (!(db instanceof IDBDatabase) || store.closed)
            throw Error('Actual open product IndexedDB connection unavailable for versionchange.');
        const before = { name: db.name, version: db.version };
        let versionchange: { oldVersion: number; newVersion: number | null } | undefined;
        db.addEventListener(
            'versionchange',
            (event) => {
                versionchange = { oldVersion: event.oldVersion, newVersion: event.newVersion };
            },
            { once: true },
        );
        const upgrade = await new Promise<{ oldVersion: number; newVersion: number | null }>(
            (resolve, reject) => {
                const request = indexedDB.open(db.name, db.version + 1);
                let entered: { oldVersion: number; newVersion: number | null } | undefined;
                request.onupgradeneeded = (event) => {
                    entered = { oldVersion: event.oldVersion, newVersion: event.newVersion };
                    request.transaction!.abort();
                };
                request.onerror = () => {
                    if (request.error?.name === 'AbortError' && entered) resolve(entered);
                    else reject(request.error ?? Error('Versionchange abort did not occur.'));
                };
                request.onsuccess = () => {
                    request.result.close();
                    reject(Error('Private upgrade committed unexpectedly.'));
                };
            },
        );
        await store.releasing;
        if (!versionchange || !store.closed || store.leases.size || store.reserving)
            throw Error('Actual versionchange owner release was not acknowledged.');
        return {
            before,
            versionchange,
            abortedUpgrade: upgrade,
            storeClosed: store.closed,
            scope: 'Real upgrade transaction deliberately aborted; original schema/data must be verified after actual realm reload.',
        };
    },
    ledgerDelta() {
        if (!ledgerBaseline) throw Error('No actual unmounted product baseline.');
        return window.memoryProductLedger.delta(ledgerBaseline);
    },
    async catalog() {
        const repository = await openCaptureRepository();
        let after: number | undefined;
        const records = [];
        do {
            const page = await repository.page(after);
            records.push(
                ...page.records.map((c) => ({
                    id: c.id,
                    sequence: c.sequence,
                    state: c.state,
                    committedBytes: c.committedBytes,
                    observedBytes: c.observedBytes,
                    command: c.header.command,
                    transport: c.header.transport,
                    name: c.header.name,
                    runId: c.header.runId,
                    failure: c.failure,
                })),
            );
            after = page.next ?? undefined;
            if (records.length > 500) throw Error('Qualification catalog bound exceeded.');
        } while (after !== undefined);
        return records;
    },
    async clear() {
        const repository = await openCaptureRepository();
        for (const record of await api.catalog()) await repository.delete(record.id);
    },
    async deleteCaptures(ids: string[]) {
        if (ids.length > 500 || new Set(ids).size !== ids.length)
            throw Error('Invalid private product deletion membership.');
        const actual = new Set((await api.catalog()).map((row) => row.id));
        if (ids.some((id) => !actual.has(id)))
            throw Error('Private product deletion contains an unknown capture.');
        const repository = await openCaptureRepository();
        for (const id of ids) await repository.delete(id);
    },
    async storageUsage() {
        const estimate = await navigator.storage.estimate();
        return {
            usageBytes: typeof estimate.usage === 'number' ? estimate.usage : null,
            quotaBytes: typeof estimate.quota === 'number' ? estimate.quota : null,
            precision:
                'browser origin estimate, includes intentional caches; not exact physical allocation',
        };
    },
    async readSummary(id: string, expectedGeometry?: { bodyBytes: number; tail: string }) {
        const geometry = expectedGeometry
            ? new SerialGeometryRead(expectedGeometry.bodyBytes, expectedGeometry.tail)
            : null;
        const repository = await openCaptureRepository();
        let bytes = 0,
            frames = 0;
        const streamBytes = { stdout: 0, stderr: 0, serial: 0 };
        const streamSamples: Record<string, number[]> = { stdout: [], stderr: [], serial: [] };
        let verifier: ReturnType<typeof captureVerifier> | undefined;
        for await (const item of repository.read(id))
            if (item.type === 'metadata') verifier = captureVerifier(item.capture);
            else {
                if (!verifier) throw Error('Raw product read returned a frame before metadata.');
                verifier.append(item.frame);
                geometry?.append(item.frame);
                bytes += item.frame.bytes.length;
                streamBytes[item.frame.stream] += item.frame.bytes.length;
                for (const value of item.frame.bytes)
                    if (streamSamples[item.frame.stream].length < 32)
                        streamSamples[item.frame.stream].push(value);
                    else break;
                frames++;
            }
        if (!verifier) throw Error('Raw product read omitted metadata.');
        verifier.finish();
        return {
            bytes,
            frames,
            streamBytes,
            streamSamples,
            crcAndBoundariesVerified: true,
            geometry: geometry?.finish() ?? null,
            outcome: await repository.result?.(id),
        };
    },
    async closeRepository() {
        await (await openCaptureRepository()).close();
    },
    runnerCleanupTargets(): AggregateRunnerCleanupTarget[] {
        return productInstances('runner').map(({ id, value }) => ({
            id,
            value: value as unknown as AggregateRunnerCleanupTarget['value'],
        }));
    },
    runnerState() {
        const runner = latest<FlowRunner>('runner');
        return { busy: runner.busy, cleanupPending: runner.cleanupPending };
    },
    interrupt(reason: string) {
        latest<FlowRunner>('runner').interrupt(reason);
    },
};
declare global {
    interface Window {
        memoryProduct: typeof api;
    }
}
window.memoryProduct = api;
if (!__MEMORY_PRODUCT_COLD_START__) api.mount();
