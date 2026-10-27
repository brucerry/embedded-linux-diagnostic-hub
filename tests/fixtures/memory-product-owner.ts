import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { observeOwnedChild } from '../../scripts/lib/owned-child.mjs';

export interface ProductClock {
    now(): number;
    set(callback: () => void, milliseconds: number): unknown;
    clear(handle: unknown): void;
}
export const productClock: ProductClock = {
    now: () => Number(process.hrtime.bigint() / 1000000n),
    set: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export interface ProductJob {
    schema: 1;
    nonce: string;
    budgetMs: 2400000;
    reserveMs: 60000;
    deadlineMs: number;
}
/** One shared deadline includes startup; the last minute admits cleanup only. */
export function productJob(raw?: string, clock = productClock): Readonly<ProductJob> {
    const value = raw
        ? JSON.parse(raw)
        : {
              schema: 1,
              nonce: randomUUID(),
              budgetMs: 2400000,
              reserveMs: 60000,
              deadlineMs: clock.now() + 2400000,
          };
    assert.deepEqual(Object.keys(value).sort(), [
        'budgetMs',
        'deadlineMs',
        'nonce',
        'reserveMs',
        'schema',
    ]);
    assert.equal(value.schema, 1);
    assert.match(value.nonce, /^[a-f0-9-]{36}$/);
    assert.equal(value.budgetMs, 2400000);
    assert.equal(value.reserveMs, 60000);
    assert.ok(
        Number.isSafeInteger(value.deadlineMs) &&
            value.deadlineMs >= 0 &&
            value.deadlineMs <= clock.now() + value.budgetMs,
    );
    return Object.freeze(value);
}
/** Never signal the owning harness. Missing IPC/close remains an attached invalid observation. */
export function observeProductOwner(child: any, job: ProductJob, clock = productClock) {
    const observed = observeOwnedChild(child, {
        totalMs: Math.max(0, job.deadlineMs - clock.now()),
        reserveMs: job.reserveMs,
        clock,
        requestStop: (reason: string) => {
            assert.equal(
                child.connected,
                true,
                'Product cancellation IPC unavailable; owner remains attached.',
            );
            child.send(
                { kind: 'cancel-product-job', nonce: job.nonce, reason },
                (error: unknown) => {
                    if (error) observed.abort('Product cancellation send failed: ' + String(error));
                },
            );
        },
    });
    return observed;
}

type OwnerEvents = EventEmitter & {
    exitCode?: string | number | null;
    connected?: boolean;
    disconnect?(): void;
};
type Driver = { teardown(): Promise<void>; assertDescendantsExited(): Promise<void> };
/** The live timer and IPC handlers are retained until actual joins and durable evidence succeed. */
export class ProductRunOwner {
    readonly controller = new AbortController();
    readonly signal = this.controller.signal;
    private pending = new Set<Promise<unknown>>();
    private observations = new Set<Promise<unknown>>();
    private observationsUsed = false;
    private observationsClosed = false;
    private beforeTeardown?: () => Promise<void>;
    private driver?: Driver;
    private cleanup?: Promise<void>;
    private cleanupFailure?: unknown;
    private invalid: string | null = null;
    private completed = false;
    private joined = false;
    private timer: unknown;
    private workTimer: unknown;
    private handlers: [string, (...args: any[]) => void][];
    constructor(
        readonly job: ProductJob,
        private events: OwnerEvents = process,
        private clock = productClock,
    ) {
        this.handlers = [
            [
                'message',
                (message) => {
                    if (message?.kind !== 'cancel-product-job' || message.nonce !== job.nonce)
                        this.cancel('Invalid product cancellation identity.');
                    else this.cancel(message.reason);
                },
            ],
            ['SIGTERM', () => this.cancel('Product owner received SIGTERM.')],
            ['SIGINT', () => this.cancel('Product owner received SIGINT.')],
            ['disconnect', () => this.cancel('Product supervisor disconnected.')],
        ];
        for (const [name, handler] of this.handlers) events.on(name, handler);
        this.workTimer = clock.set(
            () => this.cancel('Product work deadline exhausted.'),
            Math.max(0, job.deadlineMs - job.reserveMs - clock.now()),
        );
        this.timer = clock.set(
            () => {
                this.hold(
                    'Product actual closure or evidence durability unknown at total deadline.',
                );
            },
            Math.max(0, job.deadlineMs - clock.now()),
        );
    }
    snapshot() {
        return {
            cancelled: this.signal.aborted,
            pending: this.pending.size,
            observations: this.observations.size,
            cleanupStarted: Boolean(this.cleanup),
            cleanupFailed: this.cleanupFailure !== undefined,
            invalid: this.invalid,
            completed: this.completed,
        };
    }
    cancel(reason: unknown) {
        if (this.completed) return;
        this.events.exitCode = 1;
        if (!this.signal.aborted) this.controller.abort(Error(String(reason).slice(0, 1024)));
        if (this.driver) void this.teardown().catch(() => {});
    }
    assertAdmissible() {
        this.signal.throwIfAborted();
        assert.equal(
            this.cleanup,
            undefined,
            'Product cleanup already started; work admission is closed.',
        );
        assert.ok(
            !this.completed && this.clock.now() < this.job.deadlineMs - this.job.reserveMs,
            'Product work admission deadline exhausted.',
        );
    }
    /** Register before invoking work, so cancellation cannot lose an asynchronous factory/cycle. */
    async run<T>(work: () => Promise<T>): Promise<T> {
        this.assertAdmissible();
        this.joined = false;
        const task = Promise.resolve().then(() => {
            this.assertAdmissible();
            return work();
        });
        this.pending.add(task);
        try {
            return await task;
        } finally {
            this.pending.delete(task);
        }
    }
    bind(driver: Driver, beforeTeardown?: () => Promise<void>) {
        assert.equal(this.driver, undefined, 'Only one product adapter may be owned.');
        assert.equal(this.cleanup, undefined, 'Adapter cannot be admitted after cleanup.');
        this.driver = driver;
        this.beforeTeardown = beforeTeardown;
        if (this.signal.aborted) void this.teardown().catch(() => {});
    }
    teardown() {
        return (this.cleanup ??= Promise.resolve()
            .then(async () => {
                const errors: unknown[] = [];
                try {
                    await this.beforeTeardown?.();
                } catch (error) {
                    errors.push(error);
                }
                try {
                    if (this.driver) await this.driver.teardown();
                } catch (error) {
                    errors.push(error);
                }
                if (errors.length)
                    throw new AggregateError(
                        errors,
                        'Product observation handoff or actual teardown failed: ' +
                            errors.map(String).join(' | '),
                    );
            })
            .catch((error) => {
                this.cleanupFailure = error;
                throw error;
            }));
    }
    async join() {
        this.joined = false;
        // Invoke cancellation/teardown before waiting for operations which closing real hosts can settle.
        const cleanup = this.teardown();
        const results = await Promise.allSettled([cleanup, ...this.pending]);
        const failed = results.filter((result) => result.status === 'rejected');
        if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
        // Operation failures are qualification failures, but are settled ownership, not live handles.
        assert.equal(this.pending.size, 0, 'Product operations remain unjoined.');
        if (this.driver) await this.driver.assertDescendantsExited();
        this.joined = true;
        return { settledFailures: failed.length };
    }
    /** Diagnostic observation is separate from work admission, but cannot accept a late read. */
    async observe<T>(read: () => Promise<T>): Promise<T> {
        assert.equal(this.observationsClosed, false, 'Product observation admission is closed.');
        this.observationsUsed = true;
        assert.ok(
            !this.completed && this.clock.now() < this.job.deadlineMs,
            'Product observation deadline exhausted.',
        );
        const task = Promise.resolve().then(read);
        this.observations.add(task);
        try {
            const value = await task;
            assert.ok(
                this.clock.now() < this.job.deadlineMs,
                'Product observation returned after total deadline.',
            );
            return value;
        } finally {
            this.observations.delete(task);
        }
    }
    closeObservations() {
        assert.equal(this.observations.size, 0, 'Product observations remain unjoined.');
        this.observationsClosed = true;
    }
    hold(reason: unknown) {
        if (this.completed) return;
        this.invalid ??= String(reason).slice(0, 1024);
        this.cancel(this.invalid);
        // Ref'ed timer deliberately keeps unknown custody attached. Never unref, exit or kill an owner.
        if (this.timer !== undefined) this.clock.clear(this.timer);
        this.timer = this.clock.set(() => this.hold(this.invalid), 1000);
    }
    finish(evidenceDurable: boolean) {
        assert.ok(evidenceDurable, 'Product evidence is not durably closed.');
        assert.equal(this.pending.size, 0, 'Product operations remain unjoined.');
        assert.equal(this.observations.size, 0, 'Product observations remain unjoined.');
        assert.ok(
            !this.observationsUsed || this.observationsClosed,
            'Product observation admission remains open.',
        );
        assert.equal(this.joined, true, 'Product descendants have not actually joined.');
        assert.ok(
            this.cleanup && this.cleanupFailure === undefined,
            'Product cleanup is unverified.',
        );
        assert.equal(this.invalid, null, 'Deadline INVALID remains held, even after late joins.');
        this.completed = true;
        this.clock.clear(this.workTimer);
        this.clock.clear(this.timer);
        for (const [name, handler] of this.handlers) this.events.off(name, handler);
        if (this.events.connected) this.events.disconnect?.();
    }
}
