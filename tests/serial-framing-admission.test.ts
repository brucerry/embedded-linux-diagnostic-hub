import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialSession } from '../src/features/serial/session';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';
import { serialCaptureBackend } from '../src/features/automation/capture/serial-backend';
import type { AutomationPlan, AutomationRecord } from '../shared/automation';
import {
    newCapture,
    sealedCapture,
    type CaptureRepository,
    type StoredCapture,
} from '../shared/capture-store';
import {
    SERIAL_CHUNK_BYTES,
    type LocalSerialPort,
    type SerialSettings,
} from '../shared/serial';

type Outcome = { ok: true } | { ok: false; error: unknown };
interface Pending {
    result?: Outcome;
}
function observe(promise: Promise<void>): Pending {
    const pending: Pending = {};
    // Attach both handlers immediately, including for deliberately refused connects.
    void promise.then(
        () => {
            pending.result = { ok: true };
        },
        (error: unknown) => {
            pending.result = { ok: false, error };
        },
    );
    return pending;
}
async function settled(pending: Pending, label: string): Promise<Outcome> {
    for (let turn = 0; turn < 64; turn++) {
        if (pending.result) return pending.result;
        await Promise.resolve();
    }
    if (pending.result) return pending.result;
    throw Error(label + ' did not settle within 64 logical microtask turns.');
}
async function fulfilled(pending: Pending, label: string) {
    const outcome = await settled(pending, label);
    if (!outcome.ok) throw outcome.error;
}
async function refused(pending: Pending, pattern: RegExp) {
    const outcome = await settled(pending, 'refused connect');
    if (outcome.ok) throw Error('Connect unexpectedly succeeded.');
    assert.match(
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        pattern,
    );
}
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test('refused Serial connects preserve admitted framing through opening, connected and closing states', async (t) => {
    const settingsA: SerialSettings = {
        baudRate: 115200,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        flowControl: 'none',
    };
    const settingsB: SerialSettings = {
        baudRate: 57600,
        dataBits: 7,
        parity: 'even',
        stopBits: 2,
        flowControl: 'hardware',
    };
    const framingA = '115200 baud · 8/none/1 · none';
    const framingB = '57600 baud · 7/even/2 · hardware';
    const openGate = gate(),
        closeGate = gate();
    const opens: Parameters<LocalSerialPort['open']>[0][] = [];
    const locksAtClose: { readable: boolean | undefined; writable: boolean | undefined }[] = [];
    let closes = 0,
        aborts = 0,
        writes = 0,
        deliveries = 0;
    const port: LocalSerialPort = {
        readable: null,
        writable: null,
        async open(options) {
            opens.push({ ...options });
            if (opens.length === 1) await openGate.promise;
            else if (opens.length !== 2) throw Error('Unexpected additional fake-port open.');
            // No producer ever enqueues data. The pending read settles on reader cancellation.
            this.readable = new ReadableStream<Uint8Array>();
            this.writable = new WritableStream<Uint8Array>({
                write() {
                    writes++;
                    throw Error('This admission fixture must not transmit data.');
                },
                abort() {
                    aborts++;
                },
            });
        },
        async close() {
            closes++;
            locksAtClose.push({
                readable: this.readable?.locked,
                writable: this.writable?.locked,
            });
            if (closes === 1) await closeGate.promise;
            this.readable = null;
            this.writable = null;
        },
        getInfo: () => ({}),
    };
    const session = new SerialSession(async () => {
        deliveries++;
    });
    const pending: Pending[] = [];
    const track = (promise: Promise<void>) => {
        const next = observe(promise);
        pending.push(next);
        return next;
    };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = t.mock.timers;
    let timerScopeActive = false,
        failed = false;
    let failure: unknown;
    const rememberFailure = (error: unknown) => {
        failure = failed
            ? new AggregateError([failure, error], 'Admission test and fixture unwind failed.')
            : error;
        failed = true;
    };
    const metadataProbe = async (expectedFraming: string, sequence: 1 | 2) => {
        const rows: AutomationRecord[] = [],
            states: FlowState[] = [],
            unexpected: string[] = [];
        const memory: { capture?: StoredCapture } = {};
        let begins = 0,
            seals = 0;
        const forbidden = (operation: string): never => {
            unexpected.push(operation);
            throw Error('Unexpected metadata-only repository operation: ' + operation);
        };
        const runner = new FlowRunner(
            (state) => {
                states.push(state);
            },
            (record) => {
                rows.push(record);
            },
            {
                local: () => Date.UTC(2028, 1, 29, 12),
                mono: () => 0,
                async sleep() {
                    throw Error('The immediate metadata probe must not sleep.');
                },
            },
        );
        const repository: CaptureRepository = {
            async begin(header) {
                begins++;
                try {
                    if (memory.capture) return forbidden('duplicate begin');
                    memory.capture = newCapture(
                        '00000000-0000-4000-8000-00000000000' + sequence,
                        sequence,
                        header,
                    );
                    return structuredClone(memory.capture);
                } finally {
                    // Cancel even if header validation fails; a producer must never start.
                    runner.cancel();
                }
            },
            async seal(id, observed, reason) {
                seals++;
                assert.ok(memory.capture);
                assert.equal(id, memory.capture.id);
                assert.equal(observed, 0);
                assert.equal(reason, 'cancelled');
                memory.capture = sealedCapture(memory.capture, observed, reason);
                return structuredClone(memory.capture);
            },
            append: async () => forbidden('append'),
            fail: async () => forbidden('fail'),
            page: async () => forbidden('page'),
            read: () => forbidden('read'),
            delete: async () => forbidden('delete'),
            close: async () => forbidden('close'),
            pin: async () => forbidden('pin'),
            record: async () => forbidden('record'),
            result: async () => forbidden('result'),
        };
        const plan: AutomationPlan = {
            transport: 'serial',
            steps: [
                {
                    id: 'metadata',
                    name: 'Metadata only',
                    enabled: true,
                    command: 'fixture',
                    delaySeconds: 0,
                },
            ],
            start: null,
            timeoutSeconds: 1,
            repeatSeconds: null,
            captureDeviceTime: false,
            serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
        };
        // Construct after the refused connect (or accepted reconnect), so stale framing is exposed.
        const backend = serialCaptureBackend(session, repository);
        const before = session.current;
        assert.equal(session.automationActive, false);
        assert.equal(backend.target.serialSettings, expectedFraming);
        await fulfilled(track(runner.start(plan, backend)), 'cancelled metadata flow');
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.equal(row.target.serialSettings, expectedFraming);
        assert.ok(row.stored);
        assert.equal(row.stored.header.target?.serialSettings, expectedFraming);
        assert.deepEqual(row.stored.header.target, backend.target);
        assert.deepEqual(memory.capture, row.stored);
        assert.equal(row.completion, 'cancelled');
        assert.equal(row.exitCode, null);
        assert.equal(row.stdout, '');
        assert.equal(row.stderr, '');
        assert.equal(row.stored.state, 'complete');
        assert.equal(row.stored.reason, 'cancelled');
        assert.equal(row.stored.committedBytes, 0);
        assert.equal(row.stored.committedFrames, 0);
        assert.equal(row.stored.observedBytes, 0);
        assert.equal(row.stored.observations, 0);
        assert.equal(begins, 1);
        assert.equal(seals, 1);
        assert.deepEqual(unexpected, []);
        assert.equal(states.at(-1)?.state, 'paused');
        assert.equal(runner.busy, false);
        assert.equal(session.automationActive, false);
        assert.deepEqual(session.current, before);
        assert.equal(session.isOwned, true);
        assert.equal(writes, 0);
        assert.equal(deliveries, 0);
        return row;
    };
    try {
        timers.enable({ apis: ['setTimeout'] });
        assert.notStrictEqual(globalThis.setTimeout, originalSetTimeout);
        assert.notStrictEqual(globalThis.clearTimeout, originalClearTimeout);
        timerScopeActive = true;
        session.select(port, 'memory-only port');
        const selectedGeneration = session.current.generation;
        const opening = track(session.connect(settingsA));
        const openingStatus = session.current;
        assert.equal(openingStatus.state, 'opening');
        assert.equal(openingStatus.generation, selectedGeneration + 1);
        assert.equal(session.framing, framingA);
        assert.equal(session.isOwned, true);
        assert.strictEqual(session.selectedPort, port);
        assert.deepEqual(opens, [{ ...settingsA, bufferSize: SERIAL_CHUNK_BYTES }]);
        assert.equal(closes, 0);

        await refused(track(session.connect(settingsB)), /still open or closing/);
        assert.equal(session.framing, framingA);
        assert.deepEqual(session.current, openingStatus);
        assert.strictEqual(session.selectedPort, port);
        assert.equal(opens.length, 1);
        assert.equal(closes, 0);
        // Settings validation retains its original precedence over the ownership guard.
        await refused(track(session.connect({ ...settingsB, baudRate: 0 })), /baud rate/);
        assert.equal(session.framing, framingA);
        assert.deepEqual(session.current, openingStatus);

        openGate.resolve();
        await fulfilled(opening, 'first open');
        const connectedStatus = session.current;
        assert.equal(connectedStatus.state, 'connected');
        assert.equal(connectedStatus.generation, openingStatus.generation);
        await refused(track(session.connect(settingsB)), /still open or closing/);
        assert.equal(session.framing, framingA);
        assert.deepEqual(session.current, connectedStatus);
        assert.strictEqual(session.selectedPort, port);
        assert.equal(session.isOwned, true);
        assert.equal(opens.length, 1);
        assert.equal(closes, 0);

        const retainedA = await metadataProbe(framingA, 1);
        const closing = track(session.close());
        const closingStatus = session.current;
        assert.equal(closingStatus.state, 'closing');
        assert.equal(closingStatus.generation, connectedStatus.generation + 1);
        await refused(track(session.connect(settingsB)), /still open or closing/);
        assert.equal(session.framing, framingA);
        assert.deepEqual(session.current, closingStatus);
        assert.strictEqual(session.selectedPort, port);
        assert.equal(session.isOwned, true);
        assert.equal(opens.length, 1);
        // Let only in-memory stream cancellation/abort jobs progress to fake port.close().
        for (let turn = 0; turn < 64 && closes === 0; turn++) await Promise.resolve();
        assert.equal(closes, 1);
        assert.deepEqual(locksAtClose, [{ readable: false, writable: false }]);
        assert.equal(aborts, 1);
        assert.equal(closing.result, undefined, 'fake close remains gated');
        closeGate.resolve();
        await fulfilled(closing, 'first close');
        assert.equal(session.current.state, 'selected');
        assert.equal(session.current.generation, closingStatus.generation);
        assert.equal(session.isOwned, false);
        assert.strictEqual(session.selectedPort, port);
        assert.equal(session.framing, framingA);

        await fulfilled(track(session.connect(settingsB)), 'admitted reconnect');
        assert.equal(session.current.state, 'connected');
        assert.equal(session.current.generation, closingStatus.generation + 1);
        assert.equal(session.isOwned, true);
        assert.strictEqual(session.selectedPort, port);
        assert.equal(session.framing, framingB);
        assert.deepEqual(opens, [
            { ...settingsA, bufferSize: SERIAL_CHUNK_BYTES },
            { ...settingsB, bufferSize: SERIAL_CHUNK_BYTES },
        ]);
        assert.equal(closes, 1);
        assert.equal(writes, 0);
        assert.equal(deliveries, 0);
        await metadataProbe(framingB, 2);
        assert.equal(retainedA.target.serialSettings, framingA);
        assert.equal(retainedA.stored?.header.target?.serialSettings, framingA);
    } catch (error) {
        rememberFailure(error);
    } finally {
        // Release only this fixture's private promises, including after an early assertion.
        openGate.resolve();
        closeGate.resolve();
        try {
            if (timerScopeActive) {
                for (const task of pending) {
                    try {
                        await settled(task, 'fixture-owned lifecycle');
                    } catch (error) {
                        rememberFailure(error);
                    }
                }
                try {
                    // Close/deselect only our in-memory port while its watchdog is still mocked.
                    await fulfilled(observe(session.close(true)), 'final memory-port close');
                } catch (error) {
                    rememberFailure(error);
                }
            }
        } finally {
            // Reset also discards any pending virtual watchdog, even when a fixture assertion fails.
            try {
                timers.reset();
                assert.strictEqual(globalThis.setTimeout, originalSetTimeout);
                assert.strictEqual(globalThis.clearTimeout, originalClearTimeout);
            } catch (error) {
                rememberFailure(error);
            }
        }
    }
    if (failed) throw failure;
    assert.equal(session.current.state, 'idle');
    assert.equal(session.selectedPort, undefined);
    assert.equal(session.isOwned, false);
    assert.equal(session.framing, framingB);
    assert.equal(opens.length, 2);
    assert.equal(closes, 2);
    assert.equal(aborts, 2);
    assert.deepEqual(locksAtClose, [
        { readable: false, writable: false },
        { readable: false, writable: false },
    ]);
    assert.equal(writes, 0);
    assert.equal(deliveries, 0);
    assert.strictEqual(globalThis.setTimeout, originalSetTimeout);
    assert.strictEqual(globalThis.clearTimeout, originalClearTimeout);
    assert.equal(pending.length, 9);
    assert.ok(pending.every((task) => task.result !== undefined));
});
