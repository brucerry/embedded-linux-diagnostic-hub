import assert from 'node:assert/strict';
import { validateProcessSample, type ProcessSample } from './memory-resource-verdict';
import { productClock, type ProductClock } from './memory-product-owner';

/** OS-history only: no new CDP, forced GC, or RPC after inspection starts retiring. */
export function shutdownHistory(rows: ProcessSample[], known: Map<string, string>) {
    rows.forEach(validateProcessSample);
    return rows.map((row) => ({
        ...row,
        role: known.get(`${row.pid}/${row.created}`) ?? row.role,
        heapUsedBytes: null,
        externalBytes: null,
        arrayBuffersBytes: null,
        unsupported: [
            ...new Set([
                ...row.unsupported,
                'Shutdown OS history has no allocation breakdown; diagnostic RSS only.',
            ]),
        ],
    }));
}
export function rememberProcessRoles(rows: readonly ProcessSample[], known: Map<string, string>) {
    for (const row of rows) {
        validateProcessSample(row);
        if (row.state === 'running') known.set(`${row.pid}/${row.created}`, row.role);
    }
    assert.ok(known.size <= 256, 'Product process-role history bound exceeded.');
}

/** One serialized observer spans real cleanup, then takes a final actual joined-history sample. */
export class ProductShutdownObserver {
    private task?: Promise<void>;
    private stopped = false;
    private failure?: unknown;
    private wake?: () => void;
    private identities = new Set<string>();
    constructor(
        private read: () => Promise<ProcessSample[]>,
        private observe: <T>(read: () => Promise<T>) => Promise<T>,
        private emit: (stage: string, data: unknown) => Promise<void>,
        private accepted: (rows: ProcessSample[]) => void,
        private clock: ProductClock = productClock,
    ) {}
    private async take(final: boolean) {
        const sampleStartedMs = this.clock.now();
        const rows = await this.observe(this.read);
        const sampleFinishedMs = this.clock.now();
        assert.ok(rows.length, 'Missing shutdown process history; never an empty/zero sample.');
        assert.equal(
            new Set(rows.map((row) => `${row.pid}/${row.created}`)).size,
            rows.length,
            'Duplicated shutdown identity.',
        );
        rows.forEach(validateProcessSample);
        const identities = new Set(rows.map((row) => `${row.pid}/${row.created}`));
        if (final)
            for (const key of this.identities)
                assert.ok(
                    identities.has(key),
                    'Shutdown history omitted an owned process instance.',
                );
        if (final)
            for (const row of rows)
                assert.ok(
                    row.role === 'qualification-harness' || row.state === 'terminated',
                    'Actual product descendant remains live after join.',
                );
        const history = new Set([...this.identities, ...identities]);
        assert.ok(history.size <= 256, 'Shutdown identity history bound exceeded.');
        this.accepted(rows);
        this.identities = history;
        await this.emit('shutdown-processes', {
            sampleStartedMs,
            sampleFinishedMs,
            phase: final ? 'final-joined' : 'during-shutdown',
            processes: rows,
            allocationScope: 'OS RSS diagnostic; no allocation or forced-GC inference.',
        });
    }
    start() {
        this.task ??= this.loop().catch((error) => {
            this.failure = error;
        });
    }
    private async loop() {
        while (!this.stopped) {
            const begin = this.clock.now();
            await this.take(false);
            if (!this.stopped)
                await new Promise<void>((resolve) => {
                    const timer = this.clock.set(
                        () => {
                            this.wake = undefined;
                            resolve();
                        },
                        Math.max(0, 250 - (this.clock.now() - begin)),
                    );
                    this.wake = () => {
                        this.clock.clear(timer);
                        this.wake = undefined;
                        resolve();
                    };
                });
        }
    }
    async finish() {
        assert.ok(this.task, 'Shutdown observer never started.');
        this.stopped = true;
        this.wake?.();
        await this.task;
        if (this.failure !== undefined) throw this.failure;
        await this.take(true);
    }
}
