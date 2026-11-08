import assert from 'node:assert/strict';
import test from 'node:test';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';
import { serialCaptureBackend } from '../src/features/automation/capture/serial-backend';
import { SerialSession } from '../src/features/serial/session';
import { type AutomationPlan, type AutomationRecord, serialPayload } from '../shared/automation';
import {
    appendFrames,
    newCapture,
    sealedCapture,
    type CaptureRepository,
    type StoredCapture,
} from '../shared/capture-store';
import {
    DEFAULT_SERIAL_SETTINGS,
    SERIAL_CHUNK_BYTES,
    type LocalSerialPort,
} from '../shared/serial';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}
interface Task {
    done: boolean;
    error?: unknown;
    failed: boolean;
}
function observe(promise: Promise<unknown>): Task {
    const task: Task = { done: false, failed: false };
    void promise.then(
        () => {
            task.done = true;
        },
        (error: unknown) => {
            task.error = error;
            task.failed = true;
            task.done = true;
        },
    );
    return task;
}
async function jobs() {
    for (let turn = 0; turn < 64; turn++) await Promise.resolve();
}
async function until(check: () => boolean, label: string) {
    for (let turn = 0; turn < 64; turn++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.ok(check(), label + ' did not settle within 64 logical microtask turns.');
}
async function joined(task: Task, label: string) {
    await until(() => task.done, label);
    if (task.failed) throw task.error;
}

test('Serial write acknowledgement precedes multiline prompt completion and later Enter steps', async (t) => {
    const script = 'cd /\npwd\nll';
    const commands = [script, '', '', 'pwd'];
    const payloads = commands.map((command) => serialPayload(command, 'CR'));
    assert.ok(new TextEncoder().encode(script).length <= 8192);
    assert.ok(payloads.every((bytes) => bytes.length < SERIAL_CHUNK_BYTES));
    const firstWrite = gate();
    const writes: Uint8Array[] = [],
        delivered: Uint8Array[] = [],
        rows: AutomationRecord[] = [],
        states: FlowState[] = [],
        unexpected: string[] = [];
    const captures = new Map<string, StoredCapture>();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let opens = 0,
        closes = 0,
        aborts = 0,
        acknowledgements = 0,
        begins = 0,
        seals = 0,
        receivedBytes = 0,
        logicalMs = 1000;
    const port: LocalSerialPort = {
        readable: null,
        writable: null,
        async open() {
            assert.equal(++opens, 1);
            this.readable = new ReadableStream<Uint8Array>({
                start(value) {
                    controller = value;
                },
            });
            this.writable = new WritableStream<Uint8Array>({
                async write(bytes) {
                    const index = writes.length;
                    assert.ok(index < payloads.length, 'No extra input may be delivered.');
                    assert.deepEqual(bytes, payloads[index]);
                    writes.push(Uint8Array.from(bytes));
                    if (index === 0) await firstWrite.promise;
                    acknowledgements++;
                },
                abort() {
                    aborts++;
                },
            });
        },
        async close() {
            closes++;
            assert.equal(this.readable?.locked, false);
            assert.equal(this.writable?.locked, false);
            this.readable = null;
            this.writable = null;
        },
        getInfo: () => ({}),
    };
    const session = new SerialSession(async (bytes) => {
        delivered.push(Uint8Array.from(bytes));
        assert.ok(delivered.length <= 4);
    });
    const forbidden = (operation: string): never => {
        unexpected.push(operation);
        throw Error('Unexpected memory-only repository operation: ' + operation);
    };
    const repository: CaptureRepository = {
        async begin(header) {
            assert.ok(begins < 4);
            assert.equal(begins, seals, 'A later capture requires the earlier seal.');
            const sequence = ++begins;
            const capture = newCapture(
                '00000000-0000-4000-8000-' + sequence.toString(16).padStart(12, '0'),
                sequence,
                header,
            );
            captures.set(capture.id, capture);
            return structuredClone(capture);
        },
        async append(id, frames) {
            const previous = captures.get(id);
            assert.ok(previous);
            receivedBytes += frames.reduce((total, frame) => total + frame.bytes.length, 0);
            assert.ok(receivedBytes < 1024, 'Bound every retained receive frame.');
            const next = appendFrames(previous, frames);
            captures.set(id, next);
            return structuredClone(next);
        },
        async seal(id, observed, reason) {
            const previous = captures.get(id);
            assert.ok(previous);
            const next = sealedCapture(previous, observed, reason);
            captures.set(id, next);
            seals++;
            return structuredClone(next);
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
    const runner = new FlowRunner(
        (state) => {
            states.push(state);
        },
        (row) => {
            rows.push(row);
            assert.ok(rows.length <= 4);
        },
        {
            local: () => Date.UTC(2028, 1, 29, 12) + logicalMs,
            mono: () => logicalMs,
            async sleep() {
                throw Error('This immediate flow must not sleep.');
            },
        },
    );
    const plan: AutomationPlan = {
        transport: 'serial',
        steps: commands.map((command, index) => ({
            id: 'step-' + index,
            name: command || 'Enter ' + index,
            command,
            enabled: true,
            enterOnly: command === '',
            delaySeconds: 0,
        })),
        start: null,
        timeoutSeconds: 5,
        repeatSeconds: null,
        captureDeviceTime: false,
        serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
    };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalNow = performance.now;
    const originalNowOwn = Object.getOwnPropertyDescriptor(performance, 'now');
    const timers = t.mock.timers;
    const tasks: Task[] = [];
    const track = (promise: Promise<unknown>) => {
        const task = observe(promise);
        tasks.push(task);
        return task;
    };
    let timerScopeActive = false,
        nowInstalled = false;
    const failures: unknown[] = [];
    const advance = async (ms: number) => {
        logicalMs += ms;
        timers.tick(ms);
        await jobs();
    };
    const receive = async (ordinal: number) => {
        controller.enqueue(new TextEncoder().encode('response-' + ordinal + '\r\nboard# '));
        await until(() => delivered.length === ordinal, 'memory receive delivery');
        await jobs();
    };
    try {
        timers.enable({ apis: ['setTimeout'] });
        assert.notStrictEqual(globalThis.setTimeout, originalSetTimeout);
        assert.notStrictEqual(globalThis.clearTimeout, originalClearTimeout);
        timerScopeActive = true;
        // This test-owned shadow also controls SerialSession's pre-send quiet check.
        Object.defineProperty(performance, 'now', {
            value: () => logicalMs,
            configurable: true,
            writable: true,
        });
        nowInstalled = true;
        assert.equal(performance.now(), logicalMs);
        session.select(port, 'memory-only write acknowledgement');
        await joined(track(session.connect(DEFAULT_SERIAL_SETTINGS)), 'memory connect');
        const generation = session.current.generation;
        const running = track(runner.start(plan, serialCaptureBackend(session, repository)));
        await until(() => writes.length === 1, 'first payload delivery');
        assert.equal(acknowledgements, 0);
        await receive(1);
        await advance(250);
        assert.equal(acknowledgements, 0);
        assert.equal(rows.length, 0, 'A received prompt cannot acknowledge a pending input write.');
        assert.equal(seals, 0);
        assert.equal(begins, 1);
        assert.equal(writes.length, 1, 'No later Enter may start before input acknowledgement.');
        assert.equal(runner.busy, true);
        assert.equal(session.automationActive, true);
        assert.equal(session.current.generation, generation);
        assert.equal(session.current.state, 'connected');

        firstWrite.release();
        await until(() => acknowledgements === 1, 'first write acknowledgement');
        await jobs();
        await advance(199);
        assert.equal(rows.length, 0, 'Acknowledgement still requires the prompt quiet interval.');
        await advance(1);
        await until(() => writes.length === 2, 'first Enter delivery');
        assert.equal(rows.length, 1);
        for (let ordinal = 2; ordinal <= 4; ordinal++) {
            // A previous prompt must never complete a fresh Enter or final script.
            await advance(250);
            assert.equal(rows.length, ordinal - 1);
            assert.equal(writes.length, ordinal);
            await receive(ordinal);
            await advance(200);
            await until(() => rows.length === ordinal, 'command outcome acknowledgement');
            if (ordinal < 4)
                await until(() => writes.length === ordinal + 1, 'next ordered payload');
        }
        await joined(running, 'whole memory flow');
        assert.equal(states.at(-1)?.state, 'finished');
        assert.equal(runner.busy, false);
        assert.equal(session.automationActive, false);
        assert.equal(session.current.generation, generation);
        assert.equal(session.current.state, 'connected');
        assert.equal(opens, 1);
        assert.equal(closes, 0);
        assert.equal(acknowledgements, 4);
        assert.deepEqual(writes, payloads);
        assert.deepEqual(
            rows.map((row) => row.command),
            commands,
        );
        assert.deepEqual(
            rows.map((row) => row.ordinal),
            [1, 2, 3, 4],
        );
        assert.equal(new Set(rows.map((row) => row.runId)).size, 1);
        assert.equal(new Set(rows.map((row) => row.stored?.id)).size, 4);
        rows.forEach((row, index) => {
            assert.equal(row.completion, 'prompt-observed');
            assert.equal(row.exitCode, null);
            assert.equal(row.stdout, 'response-' + (index + 1) + '\r\nboard# ');
            assert.equal(row.requestBytes, Buffer.from(payloads[index]).toString('base64'));
            assert.ok(row.stored);
            assert.deepEqual(row.stored, captures.get(row.stored.id));
            assert.equal(row.stored.header.command, commands[index]);
            assert.equal(row.stored.header.requestBase64, row.requestBytes);
            assert.equal(
                row.stored.header.execution?.intent,
                index === 1 || index === 2 ? 'send-enter' : 'script',
            );
            assert.equal(row.stored.state, 'complete');
            assert.equal(row.stored.reason, 'prompt-observed');
            assert.equal(row.stored.committedBytes, new TextEncoder().encode(row.stdout).length);
        });
        assert.equal(begins, 4);
        assert.equal(seals, 4);
        assert.equal(captures.size, 4);
        assert.deepEqual(unexpected, []);
    } catch (error) {
        failures.push(error);
    } finally {
        firstWrite.release();
        runner.cancel();
        try {
            if (timerScopeActive) {
                for (const task of tasks) {
                    try {
                        await joined(task, 'owned memory task during unwind');
                    } catch (error) {
                        failures.push(error);
                    }
                }
                try {
                    await joined(observe(session.close(true)), 'final memory-port close');
                } catch (error) {
                    failures.push(error);
                }
            }
        } finally {
            try {
                if (nowInstalled) {
                    if (originalNowOwn) Object.defineProperty(performance, 'now', originalNowOwn);
                    else assert.equal(Reflect.deleteProperty(performance, 'now'), true);
                }
                assert.strictEqual(performance.now, originalNow);
                assert.deepEqual(
                    Object.getOwnPropertyDescriptor(performance, 'now'),
                    originalNowOwn,
                );
            } catch (error) {
                failures.push(error);
            } finally {
                try {
                    timers.reset();
                    assert.strictEqual(globalThis.setTimeout, originalSetTimeout);
                    assert.strictEqual(globalThis.clearTimeout, originalClearTimeout);
                } catch (error) {
                    failures.push(error);
                }
            }
        }
    }
    if (failures.length)
        throw new AggregateError(failures, 'Write acknowledgement test or unwind failed.');
    assert.equal(closes, 1);
    assert.equal(aborts, 1);
    assert.equal(session.current.state, 'idle');
    assert.equal(session.isOwned, false);
    assert.equal(session.selectedPort, undefined);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((task) => task.done && !task.failed));
    assert.strictEqual(performance.now, originalNow);
    assert.strictEqual(globalThis.setTimeout, originalSetTimeout);
    assert.strictEqual(globalThis.clearTimeout, originalClearTimeout);
});
