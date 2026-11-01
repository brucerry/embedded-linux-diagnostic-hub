import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SerialSession, type SerialAutomationRelease } from '../src/features/serial/session';
import { serialCanDisconnect, serialUiAdmission } from '../src/features/serial/admission';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';
import { serialCaptureBackend } from '../src/features/automation/capture/serial-backend';
import type { AutomationPlan, AutomationRecord } from '../shared/automation';
import {
    appendFrames,
    newCapture,
    sealedCapture,
    type CaptureRepository,
    type StoredCapture,
} from '../shared/capture-store';
import { DEFAULT_SERIAL_SETTINGS, type LocalSerialPort } from '../shared/serial';

const encode = (value: string) => new TextEncoder().encode(value);
function gate() {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function observe(promise: Promise<unknown>) {
    const task: { done: boolean; error?: unknown } = { done: false };
    void promise.then(
        () => {
            task.done = true;
        },
        (error: unknown) => {
            task.error = error;
            task.done = true;
        },
    );
    return task;
}
async function jobs() {
    for (let i = 0; i < 128; i++) await Promise.resolve();
}
async function until(check: () => boolean, name: string) {
    for (let i = 0; i < 1024 && !check(); i++) await Promise.resolve();
    assert.ok(check(), name + ' did not settle within 1024 microtask turns');
}
function memoryPort(held = false, holdReadCancel = false) {
    const write = gate(),
        abort = gate(),
        close = gate(),
        readerCancel = gate();
    if (!held) {
        write.resolve();
        abort.resolve();
        close.resolve();
    }
    if (!holdReadCancel) readerCancel.resolve();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const counts = { opens: 0, closes: 0, closed: 0, aborts: 0, cancels: 0, writeAcks: 0 };
    const writes: Uint8Array[] = [];
    const readable = () =>
        new ReadableStream<Uint8Array>({
            start(value) {
                controller = value;
            },
            async cancel() {
                counts.cancels++;
                await readerCancel.promise;
            },
        });
    const port: LocalSerialPort = {
        readable: null,
        writable: null,
        async open() {
            assert.equal(++counts.opens, 1, 'No implicit reopen');
            this.readable = readable();
            this.writable = new WritableStream<Uint8Array>({
                async write(bytes) {
                    assert.ok(writes.length < 2, 'Bound fake input');
                    writes.push(Uint8Array.from(bytes));
                    await write.promise;
                    counts.writeAcks++;
                },
                async abort() {
                    counts.aborts++;
                    await abort.promise;
                },
            });
        },
        async close() {
            assert.equal(++counts.closes, 1);
            assert.equal(this.readable?.locked, false);
            assert.equal(this.writable?.locked, false);
            await close.promise;
            counts.closed++;
            this.readable = null;
            this.writable = null;
        },
        getInfo: () => ({}),
    };
    return {
        port,
        counts,
        writes,
        write,
        abort,
        close,
        readerCancel,
        receive: (text: string) => controller.enqueue(encode(text)),
        recover(name = 'BreakError') {
            const old = port.readable!,
                before = controller;
            port.readable = readable();
            before.error(Object.assign(Error('synthetic line error'), { name }));
            return old;
        },
        releaseFixture() {
            write.resolve();
            abort.resolve();
            close.resolve();
            readerCancel.resolve();
        },
    };
}
const plan: AutomationPlan = {
    transport: 'serial',
    start: null,
    timeoutSeconds: 300,
    repeatSeconds: null,
    captureDeviceTime: false,
    serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
    steps: ['first', 'never-send'].map((command, i) => ({
        id: 'step-' + i,
        name: command,
        command,
        enabled: true,
        delaySeconds: 0,
    })),
};
async function scope(
    t: TestContext,
    held: boolean,
    work: (c: ReturnType<typeof context>) => Promise<void>,
    holdReadCancel = false,
    holdSeal = false,
) {
    const c = context(t, held, holdReadCancel, holdSeal);
    const now = performance.now,
        descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    const set = globalThis.setTimeout,
        clear = globalThis.clearTimeout;
    const errors: unknown[] = [];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    Object.defineProperty(performance, 'now', {
        value: () => c.mono,
        configurable: true,
        writable: true,
    });
    try {
        await c.connect(c.fixture);
        await work(c);
        assert.deepEqual(c.unexpected, []);
    } catch (error) {
        errors.push(error);
    } finally {
        c.seal.resolve();
        c.fixtures.forEach((f) => f.releaseFixture());
        c.runner.cancel();
        try {
            const closing = c.track(c.session.close(true));
            await jobs();
            // Let the real reader's existing 25 ms recovery pacing retire before its join.
            if (!closing.done) await c.advance(25);
            await until(() => closing.done, 'fixture close');
            if (closing.error) throw closing.error;
            if (c.tasks.some((task) => !task.done)) await c.advance(101);
            if (c.runner.cleanupPending) await c.runner.retryCleanup();
            for (const task of c.tasks) await until(() => task.done, 'owned task retirement');
            assert.equal(c.runner.busy, false);
            assert.equal(c.session.isOwned, false);
        } catch (error) {
            errors.push(error);
        } finally {
            if (descriptor) Object.defineProperty(performance, 'now', descriptor);
            else assert.equal(Reflect.deleteProperty(performance, 'now'), true);
            assert.strictEqual(performance.now, now);
            assert.deepEqual(Object.getOwnPropertyDescriptor(performance, 'now'), descriptor);
            t.mock.timers.reset();
            assert.strictEqual(globalThis.setTimeout, set);
            assert.strictEqual(globalThis.clearTimeout, clear);
        }
    }
    if (errors.length) {
        for (const error of errors)
            t.diagnostic(error instanceof Error ? (error.stack ?? error.message) : String(error));
        throw new AggregateError(errors, 'Retained-write test or fixture retirement failed');
    }
}
function context(t: TestContext, held: boolean, holdReadCancel: boolean, holdSeal: boolean) {
    const fixture = memoryPort(held, holdReadCancel),
        fixtures = [fixture],
        seal = gate();
    if (!holdSeal) seal.resolve();
    const captures = new Map<string, StoredCapture>(),
        raw: Uint8Array[] = [];
    const rows: AutomationRecord[] = [],
        states: FlowState[] = [],
        unexpected: string[] = [],
        received: Uint8Array[] = [];
    let mono = 1000,
        begins = 0,
        seals = 0,
        owner: SerialAutomationRelease | undefined;
    const tasks: ReturnType<typeof observe>[] = [];
    const forbidden = (name: string): never => {
        unexpected.push(name);
        throw Error('Forbidden IO: ' + name);
    };
    const repository: CaptureRepository = {
        async begin(header) {
            assert.equal(++begins, 1);
            const value = newCapture('00000000-0000-4000-8000-000000000001', 1, header);
            captures.set(value.id, value);
            return structuredClone(value);
        },
        async append(id, frames) {
            for (const frame of frames) {
                assert.ok(frame.bytes.length < 128);
                raw.push(Uint8Array.from(frame.bytes));
            }
            const value = appendFrames(captures.get(id)!, frames);
            captures.set(id, value);
            return structuredClone(value);
        },
        async seal(id, observed, reason) {
            assert.equal(++seals, 1);
            await seal.promise;
            const value = sealedCapture(captures.get(id)!, observed, reason);
            captures.set(id, value);
            return structuredClone(value);
        },
        fail: async () => forbidden('fail'),
        page: async () => forbidden('page'),
        read: () => forbidden('read'),
        delete: async () => forbidden('delete'),
        close: async () => forbidden('close'),
        pin: async () => forbidden('pin'),
        record: async () => forbidden('record'),
        result: async () => forbidden('result'),
    };
    const session = new SerialSession(async (bytes) => {
        assert.ok(received.length < 4);
        received.push(Uint8Array.from(bytes));
    }, 50);
    const runner = new FlowRunner(
        (state) => {
            assert.ok(states.length < 20);
            states.push(state);
        },
        (row) => {
            assert.equal(rows.length, 0);
            rows.push(row);
        },
        {
            local: () => Date.UTC(2028, 1, 29) + mono,
            mono: () => mono,
            async sleep() {
                throw Error('No flow sleeps');
            },
        },
    );
    const track = (p: Promise<unknown>) => {
        const task = observe(p);
        tasks.push(task);
        return task;
    };
    return {
        fixture,
        fixtures,
        session,
        runner,
        rows,
        states,
        received,
        raw,
        unexpected,
        seal,
        tasks,
        get mono() {
            return mono;
        },
        get owner() {
            assert.ok(owner);
            return owner;
        },
        get seals() {
            return seals;
        },
        track,
        async advance(ms: number) {
            mono += ms;
            t.mock.timers.tick(ms);
            await jobs();
        },
        async connect(f: ReturnType<typeof memoryPort>) {
            session.select(f.port, 'memory UART');
            await session.connect(DEFAULT_SERIAL_SETTINGS);
        },
        start() {
            const backend = serialCaptureBackend(session, repository),
                acquire = backend.acquire;
            // Observe the actual lease; never replace its methods or ownership logic.
            backend.acquire = () => {
                owner = acquire() as SerialAutomationRelease;
                return owner;
            };
            return track(runner.start(plan, backend));
        },
        async breakCapture() {
            await until(() => fixture.writes.length === 1, 'first payload');
            fixture.receive('prefix\r\n');
            await until(() => received.length === 1, 'first receive');
            await jobs();
            const previous = fixture.recover();
            await jobs();
            assert.equal(previous.locked, false);
            assert.equal(fixture.port.readable?.locked, true);
        },
        assertEvidence() {
            assert.equal(rows.length, 1);
            assert.equal(rows[0].completion, 'transport-error');
            assert.equal(rows[0].exitCode, null);
            assert.equal(rows[0].stdout, 'prefix\r\n');
            assert.equal(rows[0].stored?.reason, 'transport-error');
            assert.deepEqual(raw, [encode('prefix\r\n')]);
            assert.deepEqual(fixture.writes, [encode('first\r')]);
        },
    };
}

test('streaming acknowledged-write break retains the same port and exact failed evidence', async (t) =>
    scope(t, false, async (c) => {
        const generation = c.session.current.generation,
            running = c.start();
        await until(() => c.fixture.counts.writeAcks === 1, 'input acknowledged');
        await c.breakCapture();
        await until(() => running.done, 'failed flow');
        assert.equal(running.error, undefined);
        c.assertEvidence();
        assert.equal(c.session.current.generation, generation);
        assert.equal(c.session.current.state, 'connected');
        assert.equal(c.runner.busy, false);
        assert.equal(c.fixture.counts.closes, 0);
        assert.equal(c.fixture.counts.aborts, 0);
        c.fixture.receive('boot\r\n');
        await c.advance(25);
        await until(() => c.received.length === 2, 'replacement receive');
    }));

test('held streaming write keeps receive, input/flow ownership and explicit recovery until real retirement', async (t) =>
    scope(t, true, async (c) => {
        const generation = c.session.current.generation,
            running = c.start();
        await c.breakCapture();
        await until(() => c.rows.length === 1, 'failed record');
        await jobs();
        c.assertEvidence();
        assert.equal(running.done, false);
        assert.equal(c.session.current.generation, generation);
        assert.equal(c.session.current.state, 'error');
        assert.equal(c.session.automationActive, true);
        assert.equal(c.session.automationQuarantined, true);
        assert.equal(c.session.isOwned, true);
        assert.throws(() => c.session.send(encode('blocked')), /owned/);
        assert.throws(() => c.session.acquireAutomation(), /connect/);
        assert.throws(
            () => c.runner.start(plan, serialCaptureBackend(c.session, {} as CaptureRepository)),
            /flow/,
        );
        c.fixture.receive('boot\r\n');
        await c.advance(25);
        await until(() => c.received.length === 2, 'retained reception');
        c.runner.cancel();
        c.runner.cancel();
        c.owner();
        assert.equal(
            c.session.automationActive,
            true,
            'Release request cannot release pending write',
        );
        await c.advance(51);
        await until(() => running.done, 'bounded diagnostic');
        assert.equal(c.runner.cleanupPending, true);
        assert.equal(c.runner.busy, true);
        assert.match(c.states.at(-1)!.message, /Serial cleanup remains pending.*UART BreakError/);
        const guards = serialUiAdmission({
            automationBusy: true,
            resetting: false,
            showConnect: false,
            showUpdates: false,
            selectedProbe: false,
        });
        assert.equal(
            serialCanDisconnect(
                c.session.current.state,
                guards.blocked,
                guards.disconnectBlocked,
                c.session.automationQuarantined,
            ),
            true,
        );
        assert.equal(c.fixture.counts.closes, 0);
        assert.equal(c.fixture.counts.aborts, 0);
        c.fixture.write.resolve();
        await jobs();
        await c.runner.retryCleanup();
        assert.equal(c.runner.busy, false);
        assert.equal(c.session.automationActive, false);
        assert.equal(c.session.current.state, 'connected');
        assert.equal(c.session.current.generation, generation);
        assert.equal(c.fixture.counts.closes, 0);
        assert.deepEqual(c.fixture.writes, [encode('first\r')]);
        const replacement = c.session.acquireAutomation(),
            epoch = c.session.inputEpoch;
        await c.owner.finish();
        c.owner();
        assert.equal(c.session.automationActive, true);
        assert.equal(c.session.inputEpoch, epoch);
        await replacement.finish();
        replacement();
    }));

test('write rejection after a recoverable break remains read-only until explicit acknowledged close', async (t) =>
    scope(t, true, async (c) => {
        const running = c.start();
        await c.breakCapture();
        await until(() => c.rows.length === 1, 'saved capture');
        c.fixture.write.reject(Error('synthetic driver write rejection'));
        await jobs();
        assert.match(
            c.session.current.message,
            /UART BreakError.*write failed: synthetic driver write rejection/,
        );
        assert.equal(c.session.current.state, 'error');
        assert.equal(c.session.automationActive, true);
        await c.advance(51);
        await until(() => running.done, 'failure diagnostic');
        assert.equal(c.runner.cleanupPending, true);
        const retry = c.track(c.runner.retryCleanup());
        await until(() => retry.done, 'rejected retirement wait');
        assert.match(String(retry.error), /synthetic driver write rejection/);
        assert.equal(c.fixture.counts.closes, 0);
        assert.equal(c.fixture.counts.aborts, 0);
        const closing = c.track(c.session.close());
        await until(() => c.fixture.counts.closes === 1, 'explicit close invocation');
        assert.equal(closing.done, false);
        assert.equal(c.session.isOwned, true);
        c.fixture.close.resolve();
        await until(() => closing.done, 'port close acknowledgement');
        assert.equal(closing.error, undefined);
        await c.runner.retryCleanup();
        assert.equal(c.session.isOwned, false);
        assert.equal(c.runner.busy, false);
        c.assertEvidence();
    }));

test('explicit Disconnect joins held write, reader, abort and close acknowledgements; stale owner cannot clear reconnect', async (t) =>
    scope(
        t,
        true,
        async (c) => {
            const running = c.start();
            await c.breakCapture();
            await until(() => c.rows.length === 1, 'failed record');
            const old = c.owner,
                closing = c.track(c.session.close());
            await jobs();
            assert.equal(c.fixture.counts.cancels, 1);
            c.runner.cancel();
            c.runner.cancel();
            c.fixture.write.resolve();
            await until(() => c.fixture.counts.aborts === 1, 'write then abort');
            assert.equal(c.fixture.counts.closes, 0);
            assert.equal(c.session.automationActive, true);
            c.fixture.abort.resolve();
            await jobs();
            assert.equal(c.fixture.counts.closes, 0, 'Reader acknowledgement held');
            c.fixture.readerCancel.resolve();
            await c.advance(25);
            await until(() => c.fixture.counts.closes === 1, 'close after stream retirement');
            assert.equal(closing.done, false);
            assert.equal(running.done, false);
            assert.equal(c.session.isOwned, true);
            c.fixture.close.resolve();
            await until(() => closing.done && running.done, 'actual close and flow retirement');
            assert.equal(closing.error, undefined);
            assert.equal(c.runner.busy, false);
            assert.equal(c.fixture.counts.closed, 1);
            c.assertEvidence();
            const next = memoryPort();
            c.fixtures.push(next);
            await c.connect(next);
            const current = c.session.acquireAutomation(),
                before = c.session.current,
                epoch = c.session.inputEpoch;
            await old.finish();
            old();
            assert.deepEqual(c.session.current, before);
            assert.equal(c.session.inputEpoch, epoch);
            assert.equal(c.session.automationActive, true);
            assert.equal(next.writes.length, 0);
            await current.finish();
            current();
        },
        true,
    ));

test('saved-capture fence survives Cancel and write acknowledgement without pretending evidence finished early', async (t) =>
    scope(
        t,
        true,
        async (c) => {
            const running = c.start();
            await c.breakCapture();
            await until(() => c.seals === 1, 'held seal');
            assert.equal(c.rows.length, 0);
            assert.equal(c.session.automationQuarantined, true);
            const guards = serialUiAdmission({
                automationBusy: true,
                resetting: false,
                showConnect: false,
                showUpdates: false,
                selectedProbe: false,
            });
            assert.equal(
                serialCanDisconnect(
                    c.session.current.state,
                    guards.blocked,
                    guards.disconnectBlocked,
                    c.session.automationQuarantined,
                ),
                true,
            );
            c.runner.cancel();
            c.fixture.write.resolve();
            await jobs();
            assert.equal(running.done, false);
            assert.equal(c.session.automationActive, true);
            assert.equal(c.session.current.state, 'error');
            assert.equal(c.fixture.counts.closes, 0);
            c.seal.resolve();
            await until(() => running.done, 'seal then flow retirement');
            assert.equal(c.runner.busy, false);
            assert.equal(c.session.current.state, 'connected');
            c.assertEvidence();
        },
        false,
        true,
    ));

test('a quiet-wait continuation cannot adopt a newer same-generation input owner', async (t) =>
    scope(t, false, async (c) => {
        c.fixture.receive('quiet');
        await until(() => c.received.length === 1, 'preexisting receive');
        await jobs();
        const old = c.session.acquireAutomation();
        const previous = c.track(
            c.session.runAutomation(
                encode('old\r'),
                'board# ',
                1000,
                new AbortController().signal,
                {
                    async append() {
                        throw Error('No old capture output allowed');
                    },
                    rejectObservation() {
                        throw Error('No observation allowed');
                    },
                },
            ),
        );
        old();
        const replacement = c.session.acquireAutomation(),
            before = c.session.current;
        await c.advance(101);
        await until(() => previous.done, 'stale quiet wait');
        assert.match(String(previous.error), /Serial connection changed/);
        await old.finish();
        old();
        assert.deepEqual(c.session.current, before);
        assert.equal(c.session.automationActive, true);
        assert.equal(c.fixture.writes.length, 0);
        await replacement.finish();
        replacement();
    }));

test('actual Serial UI recovery predicates preserve every non-Automation block and closing-state fence', () => {
    const base = {
        automationBusy: true,
        resetting: false,
        showConnect: false,
        showUpdates: false,
        selectedProbe: false,
    };
    const ordinary = serialUiAdmission(base);
    assert.equal(
        serialCanDisconnect('error', ordinary.blocked, ordinary.disconnectBlocked, false),
        false,
    );
    assert.equal(
        serialCanDisconnect('error', ordinary.blocked, ordinary.disconnectBlocked, true),
        true,
    );
    for (const key of ['resetting', 'showConnect', 'showUpdates', 'selectedProbe'] as const) {
        const guards = serialUiAdmission({ ...base, [key]: true });
        assert.equal(
            serialCanDisconnect('error', guards.blocked, guards.disconnectBlocked, true),
            false,
            key,
        );
    }
    for (const state of ['idle', 'selected', 'selecting', 'closing'] as const)
        assert.equal(serialCanDisconnect(state, true, false, true), false);
});

test('failed explicit close preserves the Serial retirement owner and permits only an explicit retry', async (t) =>
    scope(t, true, async (c) => {
        const running = c.start();
        await c.breakCapture();
        await until(() => c.rows.length === 1, 'failed capture recorded');
        const old = c.owner;
        const closeError = Error('synthetic port.close rejected');
        const acknowledgeClose = c.fixture.port.close.bind(c.fixture.port);
        let closeAttempts = 0;
        // Only the external fake-port boundary rejects. Actual session/runner code is unchanged.
        c.fixture.port.close = async () => {
            assert.ok(++closeAttempts <= 2, 'No automatic close retry');
            if (closeAttempts === 1) throw closeError;
            return acknowledgeClose();
        };
        const states: string[] = [];
        const unsubscribe = c.session.subscribe((value) => states.push(value.state));
        try {
            const first = c.track(c.session.close());
            c.fixture.write.resolve();
            c.fixture.abort.resolve();
            await c.advance(25); // Existing read-recovery pacing, not a cleanup acknowledgement.
            await until(() => first.done, 'rejected port close');
            assert.strictEqual(first.error, closeError);
            assert.equal(closeAttempts, 1);
            assert.equal(c.fixture.counts.closed, 0);
            assert.equal(c.session.isOwned, true);
            assert.equal(c.session.automationActive, true);
            assert.equal(c.session.current.state, 'error');
            assert.match(c.session.current.message, /synthetic port.close rejected/);
            assert.match(old.failure()!, /UART BreakError/);
            assert.equal(running.done, false, 'Failed port.close cannot acknowledge finishFlow');
            assert.throws(() => c.session.send(encode('blocked')), /owned/);
            assert.throws(() => c.session.acquireAutomation(), /connect/);

            const base = {
                automationBusy: true,
                resetting: false,
                showConnect: false,
                showUpdates: false,
                selectedProbe: false,
            };
            const recovery = serialUiAdmission(base);
            assert.equal(
                serialCanDisconnect(
                    c.session.current.state,
                    recovery.blocked,
                    recovery.disconnectBlocked,
                    c.session.automationQuarantined,
                ),
                true,
            );
            for (const key of [
                'resetting',
                'showConnect',
                'showUpdates',
                'selectedProbe',
            ] as const) {
                const guarded = serialUiAdmission({ ...base, [key]: true });
                assert.equal(
                    serialCanDisconnect(
                        c.session.current.state,
                        guarded.blocked,
                        guarded.disconnectBlocked,
                        c.session.automationQuarantined,
                    ),
                    false,
                    key,
                );
            }
            await c.advance(26);
            await until(() => running.done, 'pending retirement diagnostic');
            assert.equal(c.runner.cleanupPending, true);
            assert.equal(c.runner.busy, true);
            const retryWait = c.track(c.runner.retryCleanup());
            await until(() => retryWait.done, 'failed owner join');
            assert.strictEqual(retryWait.error, closeError, 'Original error is preserved');
            assert.equal(closeAttempts, 1, 'Cleanup retry must not retry transport close');
            assert.equal(c.session.automationActive, true);

            const second = c.track(c.session.close());
            await until(() => closeAttempts === 2, 'second explicit close');
            assert.equal(second.done, false);
            assert.equal(c.session.isOwned, true);
            assert.equal(c.session.automationActive, true);
            assert.equal(c.runner.cleanupPending, true);
            assert.equal(c.fixture.counts.closed, 0);
            assert.equal(
                states.includes('connected'),
                false,
                'No false Ready during failure/close',
            );
            c.fixture.close.resolve();
            await until(() => second.done, 'positive close acknowledgement');
            assert.equal(second.error, undefined);
            assert.equal(c.fixture.counts.closed, 1);
            assert.equal(c.session.isOwned, false);
            await c.runner.retryCleanup();
            assert.equal(c.runner.busy, false);
            assert.equal(c.session.automationActive, false);
            c.assertEvidence();
            unsubscribe();

            const replacement = memoryPort();
            c.fixtures.push(replacement);
            await c.connect(replacement);
            const current = c.session.acquireAutomation();
            const before = c.session.current,
                epoch = c.session.inputEpoch;
            await old.finish();
            old();
            assert.deepEqual(c.session.current, before);
            assert.equal(c.session.inputEpoch, epoch);
            assert.equal(c.session.automationActive, true);
            assert.equal(replacement.writes.length, 0);
            assert.equal(closeAttempts, 2);
            await current.finish();
            current();
        } finally {
            unsubscribe();
        }
    }));
