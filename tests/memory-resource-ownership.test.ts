import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
    resourceJob,
    observeResourceOwner,
    resourceOwner,
} from '../scripts/lib/resource-owner.mjs';
import { requireObservedClosure } from '../scripts/lib/owned-child.mjs';

class Clock {
    time = 0;
    next = 0;
    timers = new Map<number, { due: number; fn: () => void }>();
    now = () => this.time;
    set = (fn: () => void, ms: number) => {
        const id = ++this.next;
        this.timers.set(id, { due: this.time + ms, fn });
        return id;
    };
    clear = (id: number) => {
        this.timers.delete(id);
    };
    async advance(until: number) {
        for (;;) {
            for (let i = 0; i < 10; i++) await Promise.resolve();
            const row = [...this.timers]
                .filter(([, v]) => v.due <= until)
                .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!row) break;
            this.time = row[1].due;
            this.timers.delete(row[0]);
            row[1].fn();
        }
        this.time = until;
        for (let i = 0; i < 10; i++) await Promise.resolve();
    }
}
async function nested({
    preflight = 20,
    profile = 'fast',
    closeDelay = 300,
    unknown = false,
} = {}) {
    const clock = new Clock(),
        job = resourceJob(profile, null, clock as any),
        signals: any[] = [],
        messages: any[] = [];
    const events: any = Object.assign(new EventEmitter(), { connected: true });
    const parent: any = Object.assign(new EventEmitter(), {
        pid: 101,
        connected: true,
        kill(signal: string) {
            signals.push({ pid: 101, signal, at: clock.now() });
            assert.fail('Middle owner must not be killed.');
        },
        send(message: any, callback: any) {
            messages.push(message);
            events.emit('message', message);
            callback();
        },
    });
    events.disconnect = () => {
        events.connected = false;
        parent.connected = false;
        parent.emit('disconnect');
    };
    const outer = observeResourceOwner(parent, job, clock as any);
    parent.emit('spawn');
    const middle = resourceOwner(
        resourceJob(profile, JSON.stringify(job), clock as any),
        events,
        clock as any,
    );
    await clock.advance(preflight);
    middle.assertAdmissible();
    let closureScheduled = false;
    const leaf: any = Object.assign(new EventEmitter(), {
        pid: 201,
        kill(signal: string) {
            signals.push({ pid: 201, signal, at: clock.now() });
            if (!unknown && !closureScheduled) {
                closureScheduled = true;
                clock.set(() => {
                    leaf.emit('exit', null, signal);
                    leaf.emit('close', null, signal);
                }, closeDelay);
            }
            return !unknown;
        },
    });
    const inner = middle.observe(leaf);
    leaf.emit('spawn');
    const parentClosed = () => {
        if (middle.finish()) {
            parent.emit('exit', 1, null);
            parent.emit('close', 1, null);
        }
    };
    void inner.outcome.then(parentClosed);
    leaf.once('close', parentClosed);
    return { clock, job, outer, middle, inner, events, parent, leaf, signals, messages };
}
test('shared fast/scale deadline counts preflight and cancels leaf without killing its middle watchdog', async () => {
    for (const profile of ['fast', 'scale'])
        for (const preflight of [20, 10000]) {
            const f = await nested({ profile, preflight });
            const work = f.job.deadlineMs - f.job.reserveMs;
            await f.clock.advance(work + 400);
            assert.deepEqual([...new Set(f.signals.map((v) => v.pid))], [201]);
            assert.equal(f.signals[0].at, work);
            assert.equal(f.messages[0].nonce, f.job.nonce);
            assert.equal(f.job.budgetMs, profile === 'fast' ? 120000 : 900000);
            assert(f.inner.snapshot().closeObserved);
            assert((await f.outer.outcome).closeObserved);
            assert.equal(f.middle.snapshot().finished, true);
            assert.throws(() => requireObservedClosure(f.inner.snapshot()));
        }
});
test('near-deadline preflight receives only remaining work time; exhausted preflight cannot admit a leaf', async () => {
    const f = await nested({ preflight: 118999 });
    await f.clock.advance(119400);
    assert.equal(f.signals[0].at, 119000);
    assert.equal(f.inner.snapshot().elapsedMs, 401);
    const clock = new Clock(),
        job = resourceJob('fast', null, clock as any),
        events: any = new EventEmitter();
    const middle = resourceOwner(job, events, clock as any);
    await clock.advance(119000);
    assert.throws(() => middle.assertAdmissible(), /exhausted/);
    assert.equal(middle.snapshot().leaf, null);
    assert(middle.finish());
});
test('slow/unknown close remains INVALID with the middle owner attached and its cancellation handlers retained', async () => {
    for (const unknown of [false, true]) {
        const f = await nested({ closeDelay: 1500, unknown });
        await f.clock.advance(120000);
        const row = await f.outer.outcome;
        assert.equal(row.closeObserved, false);
        assert.equal(row.timedOut, true);
        assert.equal(f.inner.snapshot().closeObserved, false);
        assert.equal(f.middle.finish(), false);
        assert.equal(f.middle.snapshot().finished, false);
        assert.equal(f.events.listenerCount('SIGTERM'), 1);
        assert(f.signals.every((v) => v.pid === 201));
        assert(f.signals.some((v) => v.signal === 'SIGKILL'));
        await f.clock.advance(120600);
        assert.equal(f.middle.snapshot().finished, !unknown);
        assert.equal(row.closeObserved, false, 'Deadline INVALID cannot turn into a late pass.');
    }
});
test('SIGTERM/SIGINT, lost supervisor and wrong nonce forward cancellation and forbid new leaf admission', () => {
    for (const event of ['SIGTERM', 'SIGINT', 'disconnect', 'message']) {
        const clock = new Clock(),
            job = resourceJob('fast', null, clock as any),
            events: any = new EventEmitter();
        const middle = resourceOwner(job, events, clock as any);
        events.emit(event, { kind: 'cancel-resource-job', nonce: 'foreign', reason: 'bad' });
        assert.throws(() => middle.assertAdmissible(), /cancelled/);
        assert.equal(events.exitCode, 1);
        assert(middle.finish());
        assert.equal(events.listenerCount('SIGTERM'), 0);
    }
});
test('normal leaf closure releases supervision; failed IPC never falls back to killing the middle process', async () => {
    const f = await nested();
    f.leaf.emit('exit', 0, null);
    f.leaf.emit('close', 0, null);
    assert.equal(f.middle.snapshot().finished, true);
    assert.equal(f.signals.length, 0);
    const clock = new Clock(),
        job = resourceJob('fast', null, clock as any);
    const parent: any = Object.assign(new EventEmitter(), {
        pid: 101,
        connected: false,
        kill: () => assert.fail('No middle kill fallback'),
    });
    const watched = observeResourceOwner(parent, job, clock as any);
    parent.emit('spawn');
    await clock.advance(120000);
    const invalid = await watched.outcome;
    assert.equal(invalid.closeObserved, false);
    assert.equal(invalid.killErrors.length, 1);
    assert.throws(() => requireObservedClosure(invalid));
});
