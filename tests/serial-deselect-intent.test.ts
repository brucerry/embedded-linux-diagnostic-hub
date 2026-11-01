import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialSession } from '../src/features/serial/session';
import { DEFAULT_SERIAL_SETTINGS, type LocalSerialPort } from '../shared/serial';

type Outcome = { ok: true } | { ok: false; error: unknown };
function observe(promise: Promise<void>) {
    const item: { result?: Outcome } = {};
    void promise.then(
        () => { item.result = { ok: true }; },
        (error: unknown) => { item.result = { ok: false, error }; },
    );
    return item;
}
async function until(check: () => boolean, label: string) {
    for (let turn = 0; turn < 256; turn++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.ok(check(), label + ' did not settle in 256 logical turns');
}
async function result(item: ReturnType<typeof observe>) {
    await until(() => item.result !== undefined, 'owned memory operation');
    return item.result!;
}
async function fulfilled(item: ReturnType<typeof observe>) {
    const value = await result(item);
    if (!value.ok) throw value.error;
}
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}
function memoryPort(failFirstClose = false) {
    const closed = gate();
    const originalError = Error('synthetic close failed');
    const counts = { opens: 0, closes: 0, acks: 0, writes: 0, deliveries: 0 };
    const port: LocalSerialPort = {
        readable: null,
        writable: null,
        async open() {
            assert.equal(++counts.opens, 1);
            this.readable = new ReadableStream<Uint8Array>();
            this.writable = new WritableStream<Uint8Array>({
                write() { counts.writes++; throw Error('Unexpected data transmission'); },
            });
        },
        async close() {
            counts.closes++;
            assert.equal(this.readable?.locked, false);
            assert.equal(this.writable?.locked, false);
            await closed.promise;
            if (failFirstClose && counts.closes === 1) throw originalError;
            counts.acks++;
            this.readable = this.writable = null;
        },
        getInfo: () => ({}),
    };
    const session = new SerialSession(async () => {
        counts.deliveries++;
        throw Error('Unexpected received data');
    }, 25);
    return { session, port, closed, originalError, counts };
}
type Fixture = ReturnType<typeof memoryPort>;
interface Scope {
    make(failFirstClose?: boolean): Fixture;
    track(promise: Promise<void>): ReturnType<typeof observe>;
    advance(): void;
    onDispose(callback: () => void): void;
}
async function memory(body: (scope: Scope) => Promise<void>) {
    const originalSet = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')!;
    const originalClear = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout')!;
    const timers = new Map<number, { at: number; run: () => void }>();
    const fixtures: Fixture[] = [];
    const tasks: ReturnType<typeof observe>[] = [];
    const disposers: (() => void)[] = [];
    let now = 0, next = 0;
    const track = (promise: Promise<void>) => {
        const item = observe(promise);
        tasks.push(item);
        return item;
    };
    const set = ((callback: () => void, delay: number, ...args: unknown[]) => {
        assert.equal(typeof callback, 'function');
        assert.equal(delay, 25, 'Only the close watchdog is admitted');
        assert.equal(args.length, 0);
        const id = ++next;
        timers.set(id, { at: now + delay, run: callback });
        return id;
    }) as unknown as typeof setTimeout;
    const clear = ((id?: number) => {
        if (id !== undefined) timers.delete(id);
    }) as unknown as typeof clearTimeout;
    let failed = false, failure: unknown;
    const retain = (error: unknown) => {
        failure = failed ? new AggregateError([failure, error], 'Regression and memory unwind failed') : error;
        failed = true;
    };
    try {
        Object.defineProperty(globalThis, 'setTimeout', { ...originalSet, value: set });
        Object.defineProperty(globalThis, 'clearTimeout', { ...originalClear, value: clear });
        await body({
            make(failFirstClose) {
                const f = memoryPort(failFirstClose);
                fixtures.push(f);
                return f;
            },
            track,
            advance() {
                now += 25;
                for (const [id, timer] of [...timers]) {
                    if (timer.at <= now && timers.delete(id)) timer.run();
                }
            },
            onDispose(callback) { disposers.push(callback); },
        });
    } catch (error) {
        retain(error);
    } finally {
        // Dispose observers before final fixture deselection can publish more states.
        for (const dispose of disposers) dispose();
        for (const f of fixtures) f.closed.release();
        try {
            for (const task of tasks) await result(task);
            for (const f of fixtures) {
                // An explicitly failed fake close can be retried only by this fixture unwind.
                // Production has no retry loop; the failure case exercises explicit recovery.
                await fulfilled(track(f.session.close(true)));
                assert.equal(f.session.isOwned, false);
                assert.equal(f.session.selectedPort, undefined);
                assert.equal(f.counts.writes, 0);
                assert.equal(f.counts.deliveries, 0);
            }
            assert.equal(timers.size, 0);
        } catch (error) {
            retain(error);
        } finally {
            Object.defineProperty(globalThis, 'setTimeout', originalSet);
            Object.defineProperty(globalThis, 'clearTimeout', originalClear);
            assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'setTimeout'), originalSet);
            assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout'), originalClear);
        }
    }
    if (failed) throw failure;
}

for (const mode of ['initiating', 'joining'] as const)
    test('Deselect intent survives both watchdogs until genuine close acknowledgement: ' + mode, async () => {
        await memory(async ({ make, track, advance }) => {
            const f = make();
            f.session.select(f.port, 'synthetic port');
            await fulfilled(track(f.session.connect(DEFAULT_SERIAL_SETTINGS)));
            const first = track(f.session.close(mode === 'initiating'));
            await until(() => f.counts.closes === 1, 'close entry');
            advance();
            const firstError = await result(first);
            assert.equal(firstError.ok, false);
            if (firstError.ok) throw Error('Expected first watchdog rejection');
            assert.match((firstError.error as Error).message, /Timed out waiting for Serial cleanup/);
            const joined = track(f.session.close(mode === 'joining'));
            const generation = f.session.current.generation;
            assert.equal(f.counts.closes, 1);
            advance();
            const joinedError = await result(joined);
            assert.equal(joinedError.ok, false);
            if (joinedError.ok) throw Error('Expected joined watchdog rejection');
            assert.match((joinedError.error as Error).message, /Timed out waiting for Serial cleanup/);
            assert.notStrictEqual(firstError.error, joinedError.error);
            assert.equal(f.session.current.state, 'error');
            assert.equal(f.session.isOwned, true);
            assert.strictEqual(f.session.selectedPort, f.port);
            assert.equal(f.counts.acks, 0);
            assert.throws(() => f.session.select(f.port, 'replacement'), /Disconnect/);
            const refused = await result(track(f.session.connect(DEFAULT_SERIAL_SETTINGS)));
            assert.equal(refused.ok, false);
            f.closed.release();
            await until(() => !f.session.isOwned, 'late close acknowledgement');
            assert.equal(f.session.current.state, 'idle');
            assert.equal(f.session.current.label, '');
            assert.equal(f.session.selectedPort, undefined);
            assert.equal(f.session.current.generation, generation);
            assert.equal(f.counts.opens, 1);
            assert.equal(f.counts.closes, 1);
            assert.equal(f.counts.acks, 1);
            assert.strictEqual((await result(first)), firstError);
            assert.strictEqual((await result(joined)), joinedError);
            // Message handling is deliberately outside this ownership correction.
            assert.match(f.session.current.message, /Timed out waiting for Serial cleanup/);
        });
    });

test('settled Deselect waiters cannot clear a reentrant new selection or upgrade a later Disconnect', async () => {
    await memory(async ({ make, track, onDispose }) => {
        const f = make();
        f.session.select(f.port, 'old selection');
        await fulfilled(track(f.session.connect(DEFAULT_SERIAL_SETTINGS)));
        let later: ReturnType<typeof observe> | undefined;
        let reselections = 0;
        onDispose(f.session.subscribe((status) => {
            if (status.state !== 'idle' || reselections) return;
            assert.equal(f.session.isOwned, false);
            assert.equal(f.session.selectedPort, undefined);
            reselections++;
            // Same physical object, new explicit generation: identity alone is insufficient.
            f.session.select(f.port, 'new explicit selection');
            later = track(f.session.close(false));
        }));
        const first = track(f.session.close(false));
        await until(() => f.counts.closes === 1, 'first close entry');
        const joined = track(f.session.close(true));
        f.closed.release();
        await fulfilled(first);
        await fulfilled(joined);
        assert.equal(reselections, 1);
        assert.ok(later);
        await fulfilled(later);
        assert.equal(f.session.current.state, 'selected');
        assert.equal(f.session.current.label, 'new explicit selection');
        assert.strictEqual(f.session.selectedPort, f.port);
        assert.equal(f.session.isOwned, false);
        assert.equal(f.counts.opens, 1, 'Selection does not reopen');
        assert.equal(f.counts.closes, 1, 'Later selected-only Disconnect has no owned port');
    });
});

test('failed close preserves original error and ownership without leaking Deselect intent into explicit recovery', async () => {
    await memory(async ({ make, track }) => {
        const f = make(true);
        f.session.select(f.port, 'retained selection');
        await fulfilled(track(f.session.connect(DEFAULT_SERIAL_SETTINGS)));
        const first = track(f.session.close(false));
        await until(() => f.counts.closes === 1, 'failed close entry');
        const joined = track(f.session.close(true));
        f.closed.release();
        for (const item of [first, joined]) {
            const value = await result(item);
            assert.equal(value.ok, false);
            if (value.ok) throw Error('Expected close rejection');
            assert.strictEqual(value.error, f.originalError);
        }
        assert.equal(f.session.isOwned, true);
        assert.strictEqual(f.session.selectedPort, f.port);
        assert.equal(f.counts.acks, 0);
        const refused = await result(track(f.session.connect(DEFAULT_SERIAL_SETTINGS)));
        assert.equal(refused.ok, false);
        assert.equal(f.counts.closes, 1, 'No automatic transport retry');
        // A distinct, explicitly requested Disconnect must retain selection.
        await fulfilled(track(f.session.close(false)));
        assert.equal(f.session.isOwned, false);
        assert.strictEqual(f.session.selectedPort, f.port);
        assert.equal(f.session.current.state, 'selected');
        assert.equal(f.session.current.label, 'retained selection');
        assert.equal(f.counts.closes, 2);
        assert.equal(f.counts.acks, 1);
        assert.equal(f.counts.opens, 1);
    });
});

test('Deselect joining after transport task resolution is consumed before transaction settlement', async () => {
    await memory(async ({ make, track }) => {
        const f = make();
        f.session.select(f.port, 'late joined selection');
        await fulfilled(track(f.session.connect(DEFAULT_SERIAL_SETTINGS)));
        const disconnect = track(f.session.close(false));
        await until(() => f.counts.closes === 1, 'close entry');
        f.closed.release();
        // Fake port.close resumes first; its caller resumes after this continuation.
        await Promise.resolve();
        // Queue behind the transport task but ahead of its settlement callback.
        const late = await Promise.resolve().then(() => {
            assert.equal(f.counts.acks, 1);
            assert.equal(f.port.readable, null);
            assert.equal(f.session.current.state, 'closing');
            assert.equal(f.session.isOwned, true);
            assert.strictEqual(f.session.selectedPort, f.port);
            return track(f.session.close(true));
        });
        await fulfilled(disconnect);
        await fulfilled(late);
        assert.equal(f.session.isOwned, false);
        assert.equal(f.session.selectedPort, undefined);
        assert.equal(f.session.current.state, 'idle');
        assert.equal(f.session.current.label, '');
        assert.equal(f.counts.opens, 1);
        assert.equal(f.counts.closes, 1);
        assert.equal(f.counts.acks, 1);
    });
});
