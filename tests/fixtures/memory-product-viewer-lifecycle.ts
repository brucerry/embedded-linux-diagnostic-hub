/** Actual viewer actions and external Worker-close observations. Creates no run/capture/ACK. */
import assert from 'node:assert/strict';
import { expect, type Download, type Page, type Worker } from '@playwright/test';
import {
    VIEWER_CODEC_FAILURE,
    validViewerFaultTicket,
    type ViewerFaultAction,
    type ViewerFaultFormat,
    type ViewerFaultStatus,
    type ViewerFaultTicket,
} from './memory-product-viewer-faults';

export const VIEWER_PRIVATE_NEEDLES = {
    viewer: '            task.postMessage({ scene: graph, format, downscale });',
    worker: '    const { scene, format, downscale } = event.data;',
    raster: '        await yieldControl();\n        const blob =',
} as const;
/** Exact count guard only; the packet also binds full integration preimage hashes. No source mutation. */
export function assertViewerPrivateSourceNeedles(
    sources: Record<keyof typeof VIEWER_PRIVATE_NEEDLES, string>,
) {
    return (Object.keys(VIEWER_PRIVATE_NEEDLES) as (keyof typeof VIEWER_PRIVATE_NEEDLES)[]).map(
        (module) => {
            const count = sources[module].split(VIEWER_PRIVATE_NEEDLES[module]).length - 1;
            assert.equal(count, 1, 'Private viewer source needle changed or duplicated: ' + module);
            return { module, count };
        },
    );
}

export interface ViewerLiveCheckpoint {
    transport: 'serial' | 'ssh';
    /** Actual frozen inspection/arm ID; distinct from the runner's capture runId. */
    viewerIdentity: string;
    runIdentity: string;
    armGeneration: string | number;
    captureId: string;
    busy: boolean;
    cleanupPending: boolean;
    captureState: 'active';
    /** Read actual runner/transport/repository probes. Unknown values must not be filled with zero. */
    commandDispatches: number;
    transportWriteBytes: number;
    receivedBytes: number;
    committedBytes: number;
    stall: {
        source: 'serial-prompt-withheld' | 'ssh-target-gate';
        id: string;
        releasePending: boolean;
    };
    acknowledgements:
        | {
              status: 'supported';
              count: number;
              orderedTraceSHA256: string;
              pendingIds: readonly string[];
          }
        | { status: 'unsupported'; reason: string };
}
const integer = (value: number) => assert.ok(Number.isSafeInteger(value) && value >= 0);
function checkpoint(value: ViewerLiveCheckpoint) {
    assert.ok(value.transport === 'serial' || value.transport === 'ssh');
    for (const id of [value.viewerIdentity, value.runIdentity, value.captureId, value.stall.id])
        assert.ok(typeof id === 'string' && id.length > 0);
    assert.ok(
        (typeof value.armGeneration === 'string' && value.armGeneration.length > 0) ||
            (typeof value.armGeneration === 'number' &&
                Number.isSafeInteger(value.armGeneration) &&
                value.armGeneration >= 0),
    );
    assert.equal(value.busy, true, 'Caller must supply a genuinely active held automation run.');
    assert.equal(
        value.cleanupPending,
        false,
        'Run is already settling; it cannot qualify live viewer isolation.',
    );
    assert.equal(value.captureState, 'active');
    assert.equal(
        value.stall.releasePending,
        true,
        'Actual target/prompt hold was released too early.',
    );
    assert.equal(
        value.stall.source,
        value.transport === 'serial' ? 'serial-prompt-withheld' : 'ssh-target-gate',
    );
    for (const name of [
        'commandDispatches',
        'transportWriteBytes',
        'receivedBytes',
        'committedBytes',
    ] as const)
        integer(value[name]);
    if (value.acknowledgements.status === 'supported') {
        integer(value.acknowledgements.count);
        assert.match(value.acknowledgements.orderedTraceSHA256, /^[a-f0-9]{64}$/);
        assert.equal(
            new Set(value.acknowledgements.pendingIds).size,
            value.acknowledgements.pendingIds.length,
        );
        for (const id of value.acknowledgements.pendingIds) assert.ok(id.length > 0);
    } else {
        assert.equal(value.acknowledgements.status, 'unsupported');
        assert.ok(value.acknowledgements.reason.length > 0);
    }
}
/** Pure guard: a removed/changed owner or equal-sized trace cannot stand in for exact identity. */
export function assertViewerRunUnchanged(
    before: ViewerLiveCheckpoint,
    after: ViewerLiveCheckpoint,
) {
    checkpoint(before);
    checkpoint(after);
    for (const key of [
        'transport',
        'viewerIdentity',
        'runIdentity',
        'armGeneration',
        'captureId',
        'busy',
        'cleanupPending',
        'captureState',
        'commandDispatches',
        'transportWriteBytes',
        'receivedBytes',
        'committedBytes',
    ] as const)
        assert.deepEqual(after[key], before[key], 'Viewer changed actual run field: ' + key);
    assert.deepEqual(after.stall, before.stall, 'Actual held target identity changed.');
    if (
        before.acknowledgements.status === 'supported' &&
        after.acknowledgements.status === 'supported'
    ) {
        assert.deepEqual(
            after.acknowledgements,
            before.acknowledgements,
            'Viewer changed actual ordered ACK trace or pending identities.',
        );
        return { status: 'checked-exact-trace' as const };
    }
    return {
        status: 'unsupported' as const,
        reason: 'An actual ACK trace is unavailable at one or both checkpoints; no ACK-preservation claim.',
    };
}

export interface ViewerWorkerCloseReceipt {
    id: string;
    url: string;
    createdAt: string;
    closedAt: string;
    event: 'playwright-worker-close';
}
export interface ViewerWorkerWitness {
    readonly id: string;
    readonly url: string;
    readonly createdAt: string;
    readonly worker: Worker;
    readonly closed: Promise<ViewerWorkerCloseReceipt>;
}
interface WorkerRecord {
    witness: ViewerWorkerWitness;
    closed?: ViewerWorkerCloseReceipt;
    listener(): void;
}
interface WorkerToken {
    readonly ids: readonly string[];
}
/** Caller installs before exports, joins these actual promises, and disposes after real page/world teardown. */
export class ProductViewerWorkers {
    private records = new Map<string, WorkerRecord>();
    private workers = new WeakMap<Worker, string>();
    private tokens = new Set<WorkerToken>();
    private sequence = 0;
    private retiredClosed = 0;
    private disposed = false;
    private inspectionReleased = false;
    private inspectionGeneration = 1;
    private readonly added = (worker: Worker) => this.observe(worker);
    constructor(
        private page: Page,
        private readonly matchesExport: (url: string) => boolean,
    ) {
        page.on('worker', this.added);
        for (const worker of page.workers()) this.observe(worker);
    }
    private observe(worker: Worker) {
        if (this.workers.has(worker)) return;
        const id = 'observed-viewer-worker-' + ++this.sequence,
            createdAt = new Date().toISOString(),
            url = worker.url();
        let resolve!: (value: ViewerWorkerCloseReceipt) => void;
        const closed = new Promise<ViewerWorkerCloseReceipt>((done) => {
            resolve = done;
        });
        const witness = Object.freeze({ id, url, createdAt, worker, closed });
        const record: WorkerRecord = {
            witness,
            listener: () => {
                assert.equal(record.closed, undefined, 'Duplicate native Worker close event.');
                record.closed = {
                    id,
                    url,
                    createdAt,
                    closedAt: new Date().toISOString(),
                    event: 'playwright-worker-close',
                };
                resolve({ ...record.closed });
            },
        };
        this.records.set(id, record);
        this.workers.set(worker, id);
        worker.once('close', record.listener);
    }
    baseline(): WorkerToken {
        assert.equal(this.disposed, false);
        assert.equal(this.inspectionReleased, false, 'Viewer observer binding is released.');
        const token = Object.freeze({ ids: Object.freeze([...this.records.keys()]) });
        this.tokens.add(token);
        return token;
    }
    since(token: WorkerToken): readonly ViewerWorkerWitness[] {
        assert.ok(
            this.tokens.has(token),
            'Worker token was released, belongs to another observer or was invented.',
        );
        const old = new Set(token.ids);
        return [...this.records.values()]
            .filter((r) => !old.has(r.witness.id) && this.matchesExport(r.witness.url))
            .map((r) => r.witness);
    }
    releaseBaseline(token: WorkerToken) {
        assert.ok(this.tokens.delete(token), 'Unknown or already released observer baseline.');
    }
    isClosed(witness: ViewerWorkerWitness) {
        return this.record(witness).closed !== undefined;
    }
    private record(witness: ViewerWorkerWitness) {
        const record = this.records.get(witness.id);
        assert.ok(
            record && record.witness === witness && record.witness.worker === witness.worker,
            'Foreign or substituted Worker identity.',
        );
        return record;
    }
    assertClosed(witnesses: readonly ViewerWorkerWitness[]) {
        assert.equal(new Set(witnesses.map((w) => w.id)).size, witnesses.length);
        return witnesses.map((witness) => {
            const receipt = this.record(witness).closed;
            assert.ok(receipt, 'Actual Worker close event has not been observed: ' + witness.id);
            return { ...receipt };
        });
    }
    /** Forget only actual acknowledged closed wrappers, after every comparison token is released. */
    retireClosed(witnesses: readonly ViewerWorkerWitness[]) {
        assert.equal(
            this.tokens.size,
            0,
            'Retirement could hide a new owner from an active comparison token.',
        );
        const receipts = this.assertClosed(witnesses);
        for (const witness of witnesses) {
            const record = this.record(witness);
            witness.worker.off('close', record.listener);
            this.records.delete(witness.id);
            this.retiredClosed++;
        }
        return receipts;
    }
    snapshotObserver() {
        return {
            scope: 'test-observer-only' as const,
            disposed: this.disposed,
            observed: this.sequence,
            retiredActualClosed: this.retiredClosed,
            activeBaselines: this.tokens.size,
            pageWorkerListener: this.disposed || this.inspectionReleased ? 'removed' : 'registered',
            records: [...this.records.values()].map((r) => ({
                id: r.witness.id,
                url: r.witness.url,
                createdAt: r.witness.createdAt,
                closed: r.closed ? { ...r.closed } : null,
                closeListener: r.closed ? 'naturally-settled' : 'registered',
            })),
        };
    }
    releaseForInspection() {
        assert.equal(this.disposed, false);
        assert.equal(this.inspectionReleased, false);
        assert.equal(this.tokens.size, 0, 'Viewer comparison tokens prevent inspection release.');
        assert.equal(
            this.records.size,
            0,
            'Retire actually closed viewer workers before inspection release.',
        );
        this.page.off('worker', this.added);
        this.inspectionReleased = true;
    }
    assertInspectionReleased() {
        assert.equal(this.inspectionReleased, true);
        assert.equal(this.tokens.size, 0);
        assert.equal(this.records.size, 0);
    }
    bindInspection(page: Page, generation: number) {
        this.assertInspectionReleased();
        assert.equal(this.disposed, false);
        assert.ok(Number.isSafeInteger(generation) && generation === this.inspectionGeneration + 1);
        this.page = page;
        this.inspectionReleased = false;
        page.on('worker', this.added);
        for (const worker of page.workers()) this.observe(worker);
        assert.equal(
            this.records.size,
            0,
            'Unexpected live viewer workers in the reconnect binding.',
        );
        this.inspectionGeneration = generation;
    }
    assertInspectionBound(page: Page, generation: number) {
        assert.equal(this.disposed, false);
        assert.equal(this.inspectionReleased, false);
        assert.equal(this.page, page);
        assert.equal(this.inspectionGeneration, generation);
    }
    inspectionPageForCleanup() {
        return this.page;
    }
    async settleInspectionWorkers() {
        assert.equal(this.tokens.size, 0, 'Release viewer comparison tokens before inspection.');
        const witnesses = [...this.records.values()].map((record) => record.witness);
        await Promise.all(witnesses.map((witness) => witness.closed));
        return this.retireClosed(witnesses);
    }
    dispose() {
        assert.equal(this.disposed, false);
        assert.equal(
            this.tokens.size,
            0,
            'Release every observer comparison token before disposal.',
        );
        assert.equal(
            this.page.isClosed(),
            true,
            'Dispose the observer only after actual page/world teardown.',
        );
        for (const record of this.records.values())
            assert.ok(
                record.closed,
                'Caller must join every observed worker/page teardown before observer disposal.',
            );
        this.page.off('worker', this.added);
        for (const record of this.records.values())
            record.witness.worker.off('close', record.listener);
        this.records.clear();
        this.disposed = true;
    }
}

const flow = (page: Page) => page.getByRole('region', { name: 'Automation', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Automation flow', exact: true });
async function open(page: Page, identity?: string) {
    await flow(page).getByRole('button', { name: 'Show flow', exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    if (identity) {
        await expect(dialog(page).locator('.flow-kind')).toHaveText('Active snapshot');
        await expect(dialog(page).locator('.flow-identity')).toHaveText(identity);
    }
}
export async function exerciseViewerWhileLive(
    page: Page,
    input: {
        transport: 'serial' | 'ssh';
        expectedViewerIdentity: string;
        repeatCount: number;
        readCheckpoint(): Promise<ViewerLiveCheckpoint>;
        workers: ProductViewerWorkers;
    },
) {
    assert.ok(Number.isSafeInteger(input.repeatCount) && input.repeatCount > 0);
    const before = await input.readCheckpoint();
    checkpoint(before);
    assert.equal(before.transport, input.transport);
    assert.equal(before.viewerIdentity, input.expectedViewerIdentity);
    const token = input.workers.baseline(),
        observations = [before];
    let acknowledgement: ReturnType<typeof assertViewerRunUnchanged> | undefined;
    try {
        for (let index = 0; index < input.repeatCount; index++) {
            await open(page, input.expectedViewerIdentity);
            const during = await input.readCheckpoint();
            acknowledgement = assertViewerRunUnchanged(before, during);
            observations.push(during);
            if (index % 2) await page.keyboard.press('Escape');
            else
                await dialog(page)
                    .getByRole('button', { name: 'Close dialog', exact: true })
                    .click();
            await expect(dialog(page)).toBeHidden();
            const after = await input.readCheckpoint();
            acknowledgement = assertViewerRunUnchanged(before, after);
            observations.push(after);
        }
        assert.deepEqual(
            input.workers.since(token),
            [],
            'Opening/closing a view unexpectedly started an export Worker.',
        );
        return {
            coverage: ['viewer-open-close-live'],
            transport: input.transport,
            observations,
            acknowledgement,
            release:
                'caller-owned; helper never releases actual target/prompt, sends commands or changes ACKs',
        };
    } finally {
        input.workers.releaseBaseline(token);
    }
}

export interface ViewerFaultControl {
    arm(action: ViewerFaultAction, format: ViewerFaultFormat): Promise<ViewerFaultTicket>;
    pageStatus(): Promise<ViewerFaultStatus | null>;
    workerStatus(worker: ViewerWorkerWitness): Promise<ViewerFaultStatus | null>;
    release(
        ticket: ViewerFaultTicket,
        where: { realm: 'page' } | { realm: 'worker'; worker: ViewerWorkerWitness },
    ): Promise<void>;
    clearPage(): Promise<void>;
}
/** Uses real realm evaluation only. Missing hooks are returned as unsupported, never synthesized. */
export async function productViewerFaultControl(page: Page): Promise<ViewerFaultControl | null> {
    const installed = await page.evaluate(
        () => globalThis.__memoryProductViewerFaults?.version === 1,
    );
    if (!installed) return null;
    return {
        arm: (action, format) =>
            page.evaluate(
                ({ action, format }) => {
                    if (!globalThis.__memoryProductViewerFaults)
                        throw Error('Private page viewer hook missing.');
                    return globalThis.__memoryProductViewerFaults.arm(action, format);
                },
                { action, format },
            ),
        pageStatus: () =>
            page.evaluate(() => globalThis.__memoryProductViewerFaults?.status() ?? null),
        workerStatus: (witness) =>
            witness.worker.evaluate(() => globalThis.__memoryProductViewerFaults?.status() ?? null),
        async release(ticket, where) {
            if (where.realm === 'page')
                await page.evaluate((id) => {
                    if (!globalThis.__memoryProductViewerFaults)
                        throw Error('Private page viewer hook missing.');
                    globalThis.__memoryProductViewerFaults.release(id);
                }, ticket.id);
            else
                await where.worker.worker.evaluate((id) => {
                    if (!globalThis.__memoryProductViewerFaults)
                        throw Error('Private Worker viewer hook missing.');
                    globalThis.__memoryProductViewerFaults.release(id);
                }, ticket.id);
        },
        clearPage: () =>
            page.evaluate(() => {
                if (!globalThis.__memoryProductViewerFaults)
                    throw Error('Private page viewer hook missing.');
                globalThis.__memoryProductViewerFaults.clear();
            }),
    };
}

export async function exerciseViewerExportLifecycle(
    page: Page,
    input: {
        action: 'close-held-request' | 'unmount-held-request' | 'codec-failure';
        format: ViewerFaultFormat;
        workers: ProductViewerWorkers;
        /** Must await the supplied actual close promises under the caller's existing workload watchdog. */
        joinWorkers(witnesses: readonly ViewerWorkerWitness[]): Promise<void>;
        expectedViewerIdentity?: string;
        readCheckpoint?(): Promise<ViewerLiveCheckpoint>;
        /** Actual UI navigation or real parent unmount only; no direct worker/timer/owner manipulation. */
        unmountViewer?(): Promise<void>;
        faults?: ViewerFaultControl;
        browserDownloads?: { count(): number };
    },
) {
    const before = input.readCheckpoint ? await input.readCheckpoint() : undefined;
    if (before) checkpoint(before);
    if (input.action === 'unmount-held-request')
        assert.ok(input.unmountViewer, 'Supply actual parent/UI unmount.');
    await open(page, input.expectedViewerIdentity);
    const faults = input.faults ?? (await productViewerFaultControl(page));
    if (!faults) {
        await dialog(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
        await expect(dialog(page)).toBeHidden();
        return {
            status: 'unsupported' as const,
            coverage: [],
            reason: 'Actual private worker-request/codec hooks are absent; no export fault was exercised.',
        };
    }
    const ticket = validViewerFaultTicket(
        await faults.arm(
            input.action === 'codec-failure' ? 'hold-codec-throw' : 'hold-request',
            input.format,
        ),
    );
    const token = input.workers.baseline();
    let retire: readonly ViewerWorkerWitness[] | undefined;
    assert.equal(ticket.format, input.format);
    const downloads: Download[] = [],
        listener = (value: Download) => downloads.push(value);
    page.on('download', listener);
    const browserDownloadBaseline = input.browserDownloads?.count();
    try {
        await dialog(page)
            .getByRole('button', { name: 'Export ' + input.format.toUpperCase(), exact: true })
            .click();
        await expect.poll(() => input.workers.since(token).length).toBe(1);
        const witness = input.workers.since(token)[0];
        const readEntered = async (): Promise<
            { realm: 'page' | 'worker'; status: ViewerFaultStatus } | undefined
        > => {
            const snapshots = [await faults.pageStatus()];
            if (!input.workers.isClosed(witness)) {
                try {
                    snapshots.push(await faults.workerStatus(witness));
                } catch (error) {
                    if (!input.workers.isClosed(witness)) throw error;
                }
            }
            const matches = snapshots.filter((status): status is ViewerFaultStatus =>
                Boolean(
                    status &&
                    status.ticket?.id === ticket.id &&
                    status.gates.some(
                        (gate) =>
                            gate.id === ticket.id &&
                            gate.stage ===
                                (input.action === 'codec-failure' ? 'codec' : 'request') &&
                            !gate.released,
                    ),
                ),
            );
            assert.ok(
                matches.length <= 1,
                'The same private export fault entered multiple realms.',
            );
            return matches[0] ? { realm: matches[0].realm, status: matches[0] } : undefined;
        };
        await expect.poll(async () => Boolean(await readEntered())).toBe(true);
        const entered = await readEntered();
        assert.ok(entered);
        for (const name of ['SVG', 'PNG', 'PDF'])
            await expect(
                dialog(page).getByRole('button', { name: 'Export ' + name, exact: true }),
            ).toBeDisabled();
        if (before) assertViewerRunUnchanged(before, await input.readCheckpoint!());
        if (input.action === 'codec-failure') {
            await faults.release(
                ticket,
                entered.realm === 'page' ? { realm: 'page' } : { realm: 'worker', worker: witness },
            );
            await expect(
                dialog(page).getByRole('status', { name: 'Flow export status', exact: true }),
            ).toHaveText(VIEWER_CODEC_FAILURE);
            for (const name of ['SVG', 'PNG', 'PDF'])
                await expect(
                    dialog(page).getByRole('button', { name: 'Export ' + name, exact: true }),
                ).toBeEnabled();
            await dialog(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
        } else if (input.action === 'unmount-held-request') await input.unmountViewer!();
        else await page.keyboard.press('Escape');
        await expect(dialog(page)).toBeHidden();
        await input.joinWorkers([witness]);
        const closed = input.workers.assertClosed([witness]);
        assert.equal(downloads.length, 0, 'Cancelled/failed export emitted a file download.');
        if (input.browserDownloads)
            assert.equal(
                input.browserDownloads.count(),
                browserDownloadBaseline,
                'Cancelled/failed viewer export started an actual browser download.',
            );
        const after = input.readCheckpoint ? await input.readCheckpoint() : undefined;
        const acknowledgement =
            before && after
                ? assertViewerRunUnchanged(before, after)
                : {
                      status: 'unassessed',
                      reason: 'No live run checkpoint supplied; no runner/ACK-isolation claim.',
                  };
        await faults.clearPage();
        retire = [witness];
        return {
            status: 'exercised-actual-ui' as const,
            coverage: ['viewer-export-' + input.action],
            faultTicket: ticket,
            entered,
            closed,
            before,
            after,
            acknowledgement,
            codec:
                input.action === 'codec-failure'
                    ? 'Synthetic throw at actual encode boundary; underlying native encoder was not invoked.'
                    : 'Real request held before existing worker canvas fallback; normal product unmount terminates it.',
            owners: 'unassessed; use actual browser ledger, raster canvas-finally and parent module/process probes',
        };
    } finally {
        page.off('download', listener);
        input.workers.releaseBaseline(token);
        if (retire) input.workers.retireClosed(retire);
        // On failure, caller performs actual product/page teardown and joins every observed worker.
        // Never release a held request, terminate a worker, cancel a product timer or reset an owner here.
    }
}
