import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { Client as TransportClient } from 'ssh2';
import { DeviceMonitor } from '../backend/ssh/monitor';
import { DesktopConnectionAttempts } from '../electron/connection-attempts';
import { ConnectionFailure } from '../shared/connection';
import { runQuitCleanup, settleConnectionAttempt } from '../shared/quit-cleanup';
import { ConnectionOperation } from '../src/services/connection-operation';
import { Client, observe, until, turns, memoryClientScope } from './fixtures/ssh-memory-client';

// Ordinary test runners must never turn these memory cases into real SSH attempts.
const memoryOptions = {
    skip: Object.is(TransportClient, Client) ? false : 'Requires the reviewed ssh2 memory compiler alias',
};
const id = (n: number) => n.toString(16).padStart(32, '0');
const options = () => ({ host: 'synthetic.invalid', port: 22, username: 'synthetic', auth: 'password' as const, password: 'SYNTHETIC_PLACEHOLDER' });
function setup() {
    const monitor = new DeviceMonitor();
    const owner = new DesktopConnectionAttempts(monitor);
    const start = (attemptId: string) => owner.connect(attemptId, signal => monitor.configure(options(), async () => { throw Error('Unexpected host verification'); }, undefined, signal));
    return { monitor, owner, start };
}
async function release(monitor: DeviceMonitor, owner: DesktopConnectionAttempts) {
    for (const client of Client.instances) client.closeOwned();
    const snapshot = owner.snapshot;
    if (snapshot) {
        const cancelled = observe(owner.cancel(snapshot.id));
        await until(() => cancelled.done, 'fixture cancellation settled');
        if (cancelled.error) throw cancelled.error;
    }
    monitor.clear();
    const joined = observe(monitor.joinCleanup());
    await until(() => joined.done, 'fixture owners settled');
    if (joined.error) throw joined.error;
    assert.equal(monitor.hasResources, false);
}
class RetryClock {
    now = 0;
    next = 0;
    timers = new Map<number, { due: number; callback: () => void }>();
    set = (callback: () => void, delay: number) => {
        assert.equal(delay, 3000);
        assert.equal(this.timers.size, 0);
        assert.ok(++this.next <= 1);
        this.timers.set(this.next, { due: this.now + delay, callback });
        return this.next;
    };
    clear = (timer: unknown) => { assert.equal(this.timers.delete(timer as number), true); };
    advance(ms: number) {
        this.now += ms;
        for (const [timer, value] of [...this.timers]) if (value.due <= this.now) {
            this.timers.delete(timer);
            value.callback();
        }
    }
}

test('desktop retry waits for owned close before its3000ms delay, and stale IDs cannot cancel replacement', memoryOptions, () => memoryClientScope(async () => {
    const { monitor, owner, start } = setup(), clock = new RetryClock();
    const operation = new ConnectionOperation(clock, (() => { let n = 0; return () => id(++n); })());
    const work = observe(operation.connect({ connect: (_options, attemptId) => start(attemptId!), cancelConnect: attemptId => owner.cancel(attemptId) }, options(), () => {}));
    try {
        await until(() => Client.instances.length === 1, 'first fake');
        const oldSignal = owner.snapshot!.controller.signal;
        Client.instances[0].fail(new ConnectionFailure('network', 'Synthetic failure'));
        await turns(); clock.advance(6000); await turns();
        assert.equal(clock.timers.size, 0);
        assert.equal(Client.instances.length, 1);
        assert.equal(owner.busy, true);
        assert.equal(owner.snapshot!.id, id(1));
        assert.equal(work.done, false);
        assert.equal(monitor.isConnected, false);
        assert.equal(getEventListeners(oldSignal, 'abort').length, 0);
        Client.instances[0].closeOwned();
        await until(() => clock.timers.size === 1, 'post-close retry wait');
        assert.equal(monitor.hasResources, false);
        clock.advance(2999); await turns(); assert.equal(Client.instances.length, 1);
        clock.advance(1); await until(() => Client.instances.length === 2, 'replacement');
        const replacement = owner.snapshot!, destroys = Client.instances[1].destroyCalls;
        await owner.cancel(id(1)); await owner.cancel('f'.repeat(32));
        assert.equal(owner.snapshot!.controller, replacement.controller);
        assert.equal(replacement.controller.signal.aborted, false);
        assert.equal(Client.instances[1].destroyCalls, destroys);
        assert.equal(monitor.ownershipSnapshot.connections.length, 1);
        Client.instances[1].ready();
        await until(() => work.done, 'live success does not wait for close');
        assert.equal(work.error, undefined); assert.equal(work.value, true);
        assert.equal(monitor.isConnected, true); assert.equal(Client.instances[1].closed, false);
        assert.equal(owner.busy, false); assert.equal(owner.snapshot!.id, id(2));
        assert.equal(clock.timers.size, 0);
    } finally {
        for (const client of Client.instances) client.closeOwned();
        if (operation.running) {
            const cancelled = observe(operation.cancel());
            await until(() => cancelled.done && work.done, 'retry unwind');
        }
        await release(monitor, owner);
    }
}));

test('desktop Cancel and duplicate Cancel await one retirement while closing blocks new admission', memoryOptions, () => memoryClientScope(async () => {
    const { monitor, owner, start } = setup(), work = observe(start(id(1)));
    try {
        await until(() => Client.instances.length === 1, 'pending client');
        const signal = owner.snapshot!.controller.signal;
        const cancelled = observe(owner.cancel(id(1))), again = observe(owner.cancel(id(1)));
        await turns();
        assert.equal(signal.aborted, true); assert.equal(getEventListeners(signal, 'abort').length, 0);
        assert.equal(cancelled.done, false); assert.equal(again.done, false); assert.equal(work.done, false);
        assert.equal(Client.instances[0].destroyCalls, 1, 'abort requests destroy; retirement joins that same owner');
        assert.throws(() => start(id(2)), /already in progress/);
        Client.instances[0].closeOwned();
        await until(() => work.done && cancelled.done && again.done, 'close acknowledged');
        assert.ok(work.error instanceof ConnectionFailure && work.error.code === 'cancelled');
        assert.equal(cancelled.error, undefined); assert.equal(again.error, undefined);
        assert.equal(owner.snapshot, undefined); assert.equal(owner.busy, false);
    } finally { await release(monitor, owner); }
}));

test('replacing a live connection waits its close and cancellation during preparation admits no new client', memoryOptions, () => memoryClientScope(async () => {
    const { monitor, owner, start } = setup(), first = observe(start(id(1)));
    try {
        await until(() => Client.instances.length === 1, 'first client');
        Client.instances[0].ready(); await until(() => first.done, 'authenticated');
        assert.equal(first.error, undefined);
        const replacement = observe(start(id(2)));
        await turns();
        assert.equal(owner.snapshot!.id, id(2)); assert.equal(owner.busy, true);
        assert.equal(Client.instances.length, 1); assert.equal(monitor.isConnected, false);
        const beforeCancel = Client.instances[0].destroyCalls;
        await owner.cancel(id(1));
        assert.equal(Client.instances[0].destroyCalls, beforeCancel);
        const cancelled = observe(owner.cancel(id(2)));
        await turns(); assert.equal(cancelled.done, false); assert.equal(replacement.done, false);
        Client.instances[0].closeOwned();
        await until(() => replacement.done && cancelled.done, 'preparation cancellation acknowledged');
        assert.ok(replacement.error instanceof ConnectionFailure && replacement.error.code === 'cancelled');
        assert.equal(cancelled.error, undefined); assert.equal(Client.instances.length, 1);
    } finally { await release(monitor, owner); }
}));

function contains(root: unknown, expected: unknown, seen = new Set<unknown>()): boolean {
    if (root === expected) return true;
    if (!(root instanceof Error) || seen.has(root)) return false;
    seen.add(root);
    return contains(root.cause, expected, seen) || (root instanceof AggregateError && root.errors.some(error => contains(error, expected, seen)));
}
test('closure failures remain blocking, preserve original errors and never retry a failed preparation', memoryOptions, () => memoryClientScope(async () => {
    for (const preparationFailure of [false, true]) {
        const original = new ConnectionFailure('network', 'Original synthetic operation error');
        const cleanup = Error('Original synthetic closure error');
        let clears = 0, joins = 0, starts = 0;
        const owner = new DesktopConnectionAttempts({ clear() { clears++; }, async joinCleanup() {
            joins++;
            if (preparationFailure || joins === 2) throw cleanup;
        } });
        const work = observe(owner.connect(id(1), async () => { starts++; throw original; }));
        await until(() => work.done, 'known failed closure');
        assert.ok(work.error instanceof ConnectionFailure && work.error.code === 'cleanup');
        assert.equal(contains(work.error, cleanup), true);
        if (!preparationFailure) assert.equal(contains(work.error, original), true);
        assert.equal(joins, preparationFailure ? 1 : 2); assert.equal(starts, preparationFailure ? 0 : 1);
        const previous = { clears, joins, starts };
        assert.equal(owner.busy, true); assert.equal(owner.snapshot!.id, id(1));
        assert.throws(() => owner.connect(id(2), async () => {}), error => error instanceof ConnectionFailure && error.code === 'cleanup');
        const cancelled = observe(owner.cancel(id(1)));
        await until(() => cancelled.done, 'failed cancellation reports');
        assert.notEqual(cancelled.error, undefined);
        await owner.cancel(id(2));
        assert.deepEqual({ clears, joins, starts }, previous);
        const quitSettlement = observe(settleConnectionAttempt(owner.snapshot!.done));
        await until(() => quitSettlement.done, 'quit sees closure failure');
        assert.equal(quitSettlement.error, work.error);
    }
}));

test('normal quit can close pending and successful attempts without waiting on a live success or bypassing closure', memoryOptions, () => memoryClientScope(async () => {
    for (const authenticated of [false, true]) {
        const before = Client.instances.length, { monitor, owner, start } = setup(), work = observe(start(id(1)));
        try {
            await until(() => Client.instances.length === before + 1, 'quit client');
            if (authenticated) {
                Client.instances[before].ready(); await until(() => work.done, 'live success');
                assert.equal(work.error, undefined); assert.equal(owner.busy, false);
            }
            const snapshot = owner.snapshot!; let journalCloses = 0;
            const quitting = observe(runQuitCleanup({ cancelConnection: () => snapshot.controller.abort(), clearHostVerification() {}, disconnect: () => monitor.clear(), prepareConsole: async () => {}, joinConnection: () => settleConnectionAttempt(snapshot.done), joinSsh: () => monitor.joinCleanup(), finishConsole: async () => { journalCloses++; }, shutdownCapture: async () => {} }));
            await turns();
            assert.equal(quitting.done, false); assert.equal(journalCloses, 0);
            Client.instances[before].closeOwned();
            await until(() => quitting.done, 'quit close acknowledged');
            assert.equal(quitting.error, undefined); assert.equal(journalCloses, 1);
        } finally { await release(monitor, owner); }
    }
}));
