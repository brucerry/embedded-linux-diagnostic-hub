import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';

type Timer = {
    id: number;
    owner: 'node-http-date-cache' | 'unknown';
    createdAt: number;
    firedAt: number | null;
    unrefAtInit: boolean;
    origin: string;
};
export type RuntimeTimerClosure = Timer & { destroyedAt: number };

/** Track all Timeouts, including unreferenced ones, without retaining their resource objects. */
export class GatewayTimers {
    constructor(private readonly captureOrigins = false) {}
    private live = new Map<number, Timer>();
    private waiters = new Map<number, (closed: RuntimeTimerClosure) => void>();
    private settling = false;
    private lateUnknown?: Timer;
    private hook = createHook({
        init: (id, type, _trigger, resource: { hasRef?: () => boolean }) => {
            if (type !== 'Timeout') return;
            const unrefAtInit = resource.hasRef?.() === false;
            const origin = unrefAtInit || this.captureOrigins ? String(new Error().stack) : '';
            // Fail closed if Node's stack/provenance changes. Callback names alone are insufficient.
            const dateCache =
                unrefAtInit &&
                /at setUnrefTimeout \(node:internal\/timers:\d+:\d+\)\n\s+at cache \(node:internal\/http:\d+:\d+\)\n\s+at utcDate \(node:internal\/http:\d+:\d+\)/.test(
                    origin,
                );
            this.live.set(id, {
                id,
                owner: dateCache ? 'node-http-date-cache' : 'unknown',
                createdAt: Date.now(),
                firedAt: null,
                unrefAtInit,
                origin: origin.slice(0, 2048),
            });
            if (this.settling && !dateCache) this.lateUnknown ??= this.live.get(id);
        },
        before: (id) => {
            const timer = this.live.get(id);
            if (timer) timer.firedAt = Date.now();
        },
        destroy: (id) => {
            const timer = this.live.get(id);
            this.live.delete(id);
            const resolve = this.waiters.get(id);
            this.waiters.delete(id);
            if (resolve && timer) resolve({ ...timer, destroyedAt: Date.now() });
        },
    }).enable();
    get size() {
        return this.live.size;
    }
    snapshot() {
        const preview: Timer[] = [];
        for (const timer of this.live.values()) {
            preview.push(timer);
            if (preview.length === 8) break;
        }
        return preview;
    }
    origins() {
        return this.snapshot()
            .slice(0, 8)
            .map((timer) => [timer.id, timer.origin]);
    }
    disable() {
        this.hook.disable();
    }
    async joinHttpDateCache() {
        assert.ok(
            this.size <= 1,
            'Unexpected live Timeouts after shutdown; only one bounded Node HTTP date cache may remain: ' +
                JSON.stringify(this.snapshot()),
        );
        const remaining = this.snapshot();
        assert.ok(
            remaining.every((timer) => timer.owner === 'node-http-date-cache'),
            'Unexpected live Timeout after gateway shutdown: ' + JSON.stringify(remaining),
        );
        assert.ok(
            remaining.length <= 1,
            'Node HTTP date cache must remain a single bounded runtime timer.',
        );
        // No timer is cleared, ignored or given a new deadline. The existing parent RPC timeout
        // still fails a stalled shutdown. Observe the actual callback and async destroy acknowledgement.
        this.settling = true;
        const closed = await Promise.all(
            remaining.map(
                (timer) =>
                    new Promise<RuntimeTimerClosure>((resolve) =>
                        this.waiters.set(timer.id, resolve),
                    ),
            ),
        );
        this.settling = false;
        assert.equal(
            this.lateUnknown,
            undefined,
            'Unexpected Timeout was created while joining the runtime cache.',
        );
        for (const timer of closed)
            assert.notEqual(
                timer.firedAt,
                null,
                'Runtime cache was destroyed without natural callback completion.',
            );
        assert.equal(this.size, 0, 'Gateway host timers survived shutdown.');
        return closed;
    }
}
