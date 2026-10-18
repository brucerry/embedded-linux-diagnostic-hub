import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observeOwnedChild } from './owned-child.mjs';

// Node's monotonic OS clock is shared by this same-host process hierarchy. No wall-clock deadline.
export const resourceClock = {
    now: () => Number(process.hrtime.bigint() / 1000000n),
    set: setTimeout,
    clear: clearTimeout,
};
/** @param {string | null} [raw] */
export function resourceJob(profile, raw = null, clock = resourceClock) {
    const budgetMs = profile === 'fast' ? 120000 : 900000;
    assert.ok(['fast', 'scale'].includes(profile));
    const job = raw
        ? JSON.parse(raw)
        : {
              schema: 1,
              nonce: randomUUID(),
              budgetMs,
              reserveMs: 1000,
              deadlineMs: clock.now() + budgetMs,
          };
    assert.deepEqual(Object.keys(job).sort(), [
        'budgetMs',
        'deadlineMs',
        'nonce',
        'reserveMs',
        'schema',
    ]);
    assert.equal(job.schema, 1);
    assert.equal(job.budgetMs, budgetMs);
    assert.equal(job.reserveMs, 1000);
    assert.match(job.nonce, /^[a-f0-9-]{36}$/);
    assert.ok(
        Number.isSafeInteger(job.deadlineMs) &&
            job.deadlineMs >= 0 &&
            job.deadlineMs <= clock.now() + budgetMs,
    );
    return Object.freeze(job);
}
/** Outer deadline forwards IPC only. A resource owner is never terminated while it may own a leaf. */
export function observeResourceOwner(child, job, clock = resourceClock) {
    const observed = observeOwnedChild(child, {
        totalMs: Math.max(0, job.deadlineMs - clock.now()),
        reserveMs: job.reserveMs,
        clock,
        requestStop: (reason) => {
            assert.equal(
                child.connected,
                true,
                'Resource owner cancellation channel unavailable; ownership remains unknown.',
            );
            child.send({ kind: 'cancel-resource-job', nonce: job.nonce, reason }, (error) => {
                if (error) observed.abort('Cancellation send failed: ' + String(error));
            });
        },
    });
    return observed;
}

/** Installed before preflight; SIGTERM/SIGINT or lost supervisor stops the directly owned leaf. */
export function resourceOwner(job, events = process, clock = resourceClock) {
    let leaf = null,
        cancellation = null,
        finished = false,
        releaseRequested = false;
    const cancel = (reason) => {
        cancellation ??= String(reason).slice(0, 1024);
        events.exitCode = 1;
        leaf?.abort(cancellation);
    };
    const message = (value) => {
        if (value?.kind !== 'cancel-resource-job' || value.nonce !== job.nonce)
            cancel('Invalid resource cancellation identity.');
        else cancel(value.reason);
    };
    const term = () => cancel('Resource owner received SIGTERM.');
    const interrupt = () => cancel('Resource owner received SIGINT.');
    const lost = () => cancel('Resource supervisor disconnected.');
    for (const [name, handler] of [
        ['message', message],
        ['SIGTERM', term],
        ['SIGINT', interrupt],
        ['disconnect', lost],
    ])
        events.on(name, handler);
    const finish = () => {
        releaseRequested = true;
        if (leaf && !leaf.snapshot().closeObserved) return false;
        if (finished) return true;
        finished = true;
        for (const [name, handler] of [
            ['message', message],
            ['SIGTERM', term],
            ['SIGINT', interrupt],
            ['disconnect', lost],
        ])
            events.off(name, handler);
        if (events.connected) events.disconnect();
        return true;
    };
    return {
        cancel,
        finish,
        snapshot: () => ({ cancellation, finished, leaf: leaf?.snapshot() ?? null }),
        assertAdmissible() {
            assert.equal(cancellation, null, 'Resource job cancelled before leaf admission.');
            assert.ok(
                clock.now() < job.deadlineMs - job.reserveMs,
                'Resource job work deadline exhausted before leaf admission.',
            );
        },
        assertCollected() {
            assert.equal(cancellation, null, 'Resource job was cancelled.');
            assert.ok(
                clock.now() < job.deadlineMs,
                'Resource collection exceeded the shared deadline.',
            );
            assert.ok(leaf?.snapshot().closeObserved, 'Resource leaf has not actually closed.');
        },
        observe(child) {
            assert.equal(leaf, null, 'Only one resource leaf is permitted.');
            leaf = observeOwnedChild(child, {
                totalMs: Math.max(0, job.deadlineMs - clock.now()),
                reserveMs: job.reserveMs,
                clock,
            });
            child.once('close', () => {
                if (releaseRequested) finish();
            });
            if (cancellation) leaf.abort(cancellation);
            return leaf;
        },
    };
}
