import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionFailure } from '../shared/connection';
import {
    createQuitController,
    isConnectionAttemptOutcome,
    settleConnectionAttempt,
    quitAllowsIpc,
    runQuitCleanup,
    settleCleanup,
    throwCleanupFailures,
    type QuitCleanupPorts,
} from '../shared/quit-cleanup';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
}
function observe<T>(promise: Promise<T>) {
    const state: { done: boolean; value?: T; error?: unknown; rejected: boolean } = {
        done: false,
        rejected: false,
    };
    void promise.then(
        (value) => { state.value = value; state.done = true; },
        (error: unknown) => { state.error = error; state.rejected = true; state.done = true; },
    );
    return state;
}
async function pump() {
    for (let i = 0; i < 64; i++) await Promise.resolve();
}
async function until(predicate: () => boolean) {
    for (let i = 0; i < 64 && !predicate(); i++) await Promise.resolve();
    assert.ok(predicate(), 'Bounded microtask observation did not settle.');
}
function fixture(overrides: Partial<QuitCleanupPorts> = {}) {
    const trace: string[] = [], counts = new Map<string, number>();
    const record = (name: string) => {
        assert.ok(trace.length < 64, 'Memory trace exceeded its bound.');
        trace.push(name);
        counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    const ports: QuitCleanupPorts = {
        cancelConnection: () => record('cancel'),
        clearHostVerification: () => record('verification'),
        disconnect: () => record('disconnect'),
        prepareConsole: async () => { record('prepare'); },
        joinConnection: async () => { record('connection'); },
        joinSsh: async () => { record('ssh'); },
        finishConsole: async () => { record('journal'); },
        shutdownCapture: async () => { record('capture'); },
        ...overrides,
    };
    return { ports, trace, counts, record };
}
function reasons(error: unknown): unknown[] {
    return error instanceof AggregateError ? error.errors.flatMap(reasons) : [error];
}

test('named barrier waits held siblings and preserves synchronous and asynchronous errors', async () => {
    const held = gate(), first = Error('sync owner failure'), second = Error('async owner failure');
    const called: string[] = [];
    const result = observe(settleCleanup([
        { stage: 'first', run: () => { called.push('first'); throw first; } },
        { stage: 'held', run: () => { called.push('held'); return held.promise; } },
        { stage: 'second', run: async () => { called.push('second'); throw second; } },
    ]));
    try {
        await pump();
        assert.deepEqual(called, ['first', 'held', 'second']);
        assert.equal(result.done, false);
        held.release();
        await until(() => result.done);
        assert.equal(result.rejected, false);
        assert.deepEqual(result.value, [{ stage: 'first', error: first }, { stage: 'second', error: second }]);
        assert.throws(() => throwCleanupFailures(result.value!), (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [first, second]);
            return true;
        });
    } finally { held.release(); await pump(); }
});

for (const failing of ['capture', 'ssh'] as const) {
    test(`early ${failing} rejection cannot overtake the independent pending owner`, async () => {
        const held = gate(), failure = Error(failing + ' failure');
        const f = fixture({
            shutdownCapture: async () => {
                f.record('capture');
                if (failing === 'capture') throw failure;
                await held.promise;
            },
            joinSsh: async () => {
                f.record('ssh');
                if (failing === 'ssh') throw failure;
                await held.promise;
            },
        });
        const controller = createQuitController(() => runQuitCleanup(f.ports));
        const task = controller.begin(undefined), result = observe(task);
        try {
            await until(() => f.counts.has('ssh') && f.counts.has('capture'));
            await pump();
            assert.equal(controller.phase, 'waiting');
            assert.equal(result.done, false);
            assert.equal(f.counts.get('journal') ?? 0, 0);
            assert.equal(controller.begin(undefined), task);
            held.release();
            await until(() => result.done);
            assert.equal(result.value?.status, 'blocked');
            if (result.value?.status !== 'blocked') assert.fail('Expected blocked outcome.');
            assert.deepEqual(reasons(result.value.error), [failure]);
            assert.equal(controller.phase, 'blocked');
            assert.equal(controller.begin(undefined), task);
            assert.equal(f.counts.get('ssh'), 1);
            assert.equal(f.counts.get('capture'), 1);
        } finally { held.release(); await pump(); }
    });
}

test('preparation and connection failures still join SSH once and prevent journal closure', async () => {
    const held = gate(), preparation = Error('reader release failed'), connection = Error('unverified attempt');
    const f = fixture({
        prepareConsole: async () => { f.record('prepare'); throw preparation; },
        joinConnection: async () => { f.record('connection'); throw connection; },
        joinSsh: async () => { f.record('ssh'); await held.promise; },
    });
    const result = observe(runQuitCleanup(f.ports));
    try {
        await until(() => f.counts.has('ssh'));
        assert.equal(result.done, false);
        assert.equal(f.counts.get('journal') ?? 0, 0);
        held.release();
        await until(() => result.done);
        assert.equal(result.rejected, true);
        assert.deepEqual(reasons(result.error), [preparation, connection]);
        assert.equal(f.counts.get('ssh'), 1);
        assert.equal(f.counts.get('journal') ?? 0, 0);
    } finally { held.release(); await pump(); }
});

test('successful quit waits connection settlement before the SSH snapshot and final storage close', async () => {
    const connection = gate(), capture = gate(), owners: string[] = [];
    let snapshot: string[] = [];
    const f = fixture({
        joinConnection: async () => { f.record('connection'); await connection.promise; },
        joinSsh: async () => { f.record('ssh'); snapshot = [...owners]; },
        shutdownCapture: async () => { f.record('capture'); await capture.promise; },
    });
    const controller = createQuitController(() => runQuitCleanup(f.ports));
    const task = controller.begin(undefined), result = observe(task);
    try {
        await until(() => f.counts.has('connection') && f.counts.has('capture'));
        assert.equal(f.counts.has('ssh'), false);
        owners.push('already-admitted-late-owner');
        connection.release();
        await until(() => f.counts.has('journal'));
        assert.deepEqual(snapshot, owners);
        assert.ok(f.trace.indexOf('prepare') < f.trace.indexOf('ssh'));
        assert.ok(f.trace.indexOf('ssh') < f.trace.indexOf('journal'));
        assert.equal(controller.phase, 'waiting');
        capture.release();
        await until(() => result.done);
        assert.deepEqual(result.value, { status: 'ready' });
        assert.equal(controller.phase, 'ready');
        assert.equal(controller.begin(undefined), task);
        for (const name of ['cancel', 'verification', 'disconnect', 'prepare', 'connection', 'ssh', 'journal', 'capture'])
            assert.equal(f.counts.get(name), 1, name);
    } finally { connection.release(); capture.release(); await pump(); }
});

test('failed cancellation request does not skip other owners or permit final storage closure', async () => {
    const failure = Error('disconnect request failed');
    const f = fixture({ disconnect: () => { f.record('disconnect'); throw failure; } });
    const result = observe(runQuitCleanup(f.ports));
    await until(() => result.done);
    assert.equal(result.rejected, true);
    assert.deepEqual(reasons(result.error), [failure]);
    for (const name of ['cancel', 'verification', 'disconnect', 'prepare', 'connection', 'ssh', 'capture'])
        assert.equal(f.counts.get(name), 1, name);
    assert.equal(f.counts.has('journal'), false);
});

test('controller caches reentrant failure and stays blocked if the outcome reporter throws', async () => {
    const failure = Error('cleanup failed synchronously');
    let calls = 0, reentered: Promise<unknown> | undefined;
    const controller = createQuitController(() => {
        calls++;
        reentered = controller.begin(undefined);
        throw failure;
    });
    const task = controller.begin(undefined), result = observe(task);
    assert.equal(controller.phase, 'waiting');
    await until(() => result.done);
    assert.equal(reentered, task);
    assert.deepEqual(result.value, { status: 'blocked', error: failure });
    assert.throws(() => { throw Error('synthetic reporter unavailable'); });
    assert.equal(controller.phase, 'blocked');
    assert.equal(controller.begin(undefined), task);
    await pump();
    assert.equal(calls, 1);
});

test('quit admission preserves drain acknowledgements and rejects new work', () => {
    for (const name of ['hub:serial-cleanup-ack', 'hub:terminal-ack', 'hub:automation-activity-release'])
        assert.equal(quitAllowsIpc(name), true, name);
    for (const action of ['read', 'ack', 'cancel', 'finalize'])
        assert.equal(quitAllowsIpc('hub:automation-stream', action), true, action);
    for (const action of ['read', 'ack', 'status', 'heartbeat'])
        assert.equal(quitAllowsIpc('hub:automation-console', action), true, action);
    for (const name of ['hub:connect', 'hub:terminal-open', 'hub:automation-run', 'hub:serial-select', 'hub:start-update', 'hub:capture', 'hub:console-storage', 'unknown'])
        assert.equal(quitAllowsIpc(name), false, name);
    for (const action of ['capabilities', 'start', 'open', 'step', 'finish', 'release', '', 'unknown']) {
        assert.equal(quitAllowsIpc('hub:automation-stream', action), false, action);
        assert.equal(quitAllowsIpc('hub:automation-console', action), false, action);
    }
});

test('journal-close failure remains blocked even after every other owner has joined', async () => {
    const failure = Error('journal close unacknowledged');
    const f = fixture({ finishConsole: async () => { f.record('journal'); throw failure; } });
    const controller = createQuitController(() => runQuitCleanup(f.ports));
    const task = controller.begin(undefined), result = observe(task);
    await until(() => result.done);
    assert.equal(result.value?.status, 'blocked');
    if (result.value?.status !== 'blocked') assert.fail('Expected blocked outcome.');
    assert.deepEqual(reasons(result.value.error), [failure]);
    assert.equal(controller.phase, 'blocked');
    assert.equal(controller.begin(undefined), task);
    assert.equal(f.counts.get('journal'), 1);
});

test('typed public attempt outcomes remain original diagnostics while owner joins stay mandatory', async () => {
    for (const code of ['cancelled', 'network', 'authentication', 'host-key', 'policy'] as const) {
        const original = new ConnectionFailure(code, 'Synthetic ' + code + ' operation outcome');
        let diagnostic: ConnectionFailure | null = null;
        const f = fixture({
            joinConnection: async () => {
                f.record('connection');
                diagnostic = await settleConnectionAttempt(Promise.reject(original));
            },
        });
        assert.equal(isConnectionAttemptOutcome(original), true);
        const controller = createQuitController(() => runQuitCleanup(f.ports));
        const result = observe(controller.begin(undefined));
        await until(() => result.done);
        assert.deepEqual(result.value, { status: 'ready' });
        assert.equal(diagnostic, original);
        assert.equal(f.counts.get('ssh'), 1);
        assert.equal(f.counts.get('journal'), 1);
    }
    assert.equal(await settleConnectionAttempt(undefined), null);
    assert.equal(await settleConnectionAttempt(Promise.resolve()), null);
});

test('cleanup-coded and unclassified errors reject unchanged and cannot impersonate typed outcomes', async () => {
    const cleanup = new ConnectionFailure('cleanup', 'Synthetic retained owner'),
        unclassified = Error('Synthetic unknown failure'),
        disguised = Object.assign(Error('Synthetic lookalike'), { code: 'policy', name: 'ConnectionFailure' }),
        plain = { code: 'cancelled', message: 'Synthetic object' };
    for (const original of [cleanup, unclassified, disguised, plain]) {
        assert.equal(isConnectionAttemptOutcome(original), false);
        const f = fixture({
            joinConnection: async () => {
                f.record('connection');
                await settleConnectionAttempt(Promise.reject(original));
            },
        });
        const controller = createQuitController(() => runQuitCleanup(f.ports));
        const result = observe(controller.begin(undefined));
        await until(() => result.done);
        assert.equal(result.value?.status, 'blocked');
        if (result.value?.status !== 'blocked') assert.fail('Expected blocking exception.');
        assert.deepEqual(reasons(result.value.error), [original]);
        assert.equal(f.counts.get('ssh'), 1);
        assert.equal(f.counts.has('journal'), false);
    }
});

test('nonblocking attempt diagnostic cannot bypass a pending or failed actual ownership port', async () => {
    const held = gate(), attempt = new ConnectionFailure('authentication', 'Synthetic attempt failure'),
        ownership = Error('Synthetic transport closure unverified');
    let diagnostic: ConnectionFailure | null = null;
    const f = fixture({
        joinConnection: async () => {
            f.record('connection');
            diagnostic = await settleConnectionAttempt(Promise.reject(attempt));
        },
        joinSsh: async () => { f.record('ssh'); await held.promise; throw ownership; },
    });
    const controller = createQuitController(() => runQuitCleanup(f.ports));
    const result = observe(controller.begin(undefined));
    try {
        await until(() => f.counts.has('ssh'));
        assert.equal(diagnostic, attempt);
        assert.equal(controller.phase, 'waiting');
        assert.equal(result.done, false);
        assert.equal(f.counts.has('journal'), false);
        held.release();
        await until(() => result.done);
        assert.equal(result.value?.status, 'blocked');
        if (result.value?.status !== 'blocked') assert.fail('Expected retained ownership failure.');
        assert.deepEqual(reasons(result.value.error), [ownership]);
        assert.equal(diagnostic, attempt);
        assert.equal(f.counts.get('ssh'), 1);
        assert.equal(f.counts.has('journal'), false);
    } finally { held.release(); await pump(); }
});
