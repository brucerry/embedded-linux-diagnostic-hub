import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialSession } from '../src/features/serial/session';
import {
    DEFAULT_SERIAL_SETTINGS,
    SERIAL_QUEUE_BYTES,
    type LocalSerialPort,
} from '../shared/serial';
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
function fake(openGate?: Promise<void>, writeGate?: Promise<void>) {
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const writes: Uint8Array[] = [];
    let opens = 0,
        closes = 0,
        aborts = 0;
    const port: LocalSerialPort = {
        readable: null,
        writable: null,
        async open() {
            opens++;
            await openGate;
            this.readable = new ReadableStream({
                start(controller) {
                    input = controller;
                },
            });
            this.writable = new WritableStream({
                async write(bytes, controller) {
                    writes.push(bytes);
                    if (writeGate)
                        await Promise.race([
                            writeGate,
                            new Promise<void>((resolve) => {
                                controller.signal.addEventListener('abort', () => resolve(), {
                                    once: true,
                                });
                            }),
                        ]);
                },
                abort() {
                    aborts++;
                },
            });
        },
        async close() {
            closes++;
            this.readable = this.writable = null;
        },
        getInfo: () => ({}),
    };
    return {
        port,
        writes,
        push(bytes: Uint8Array) {
            input.enqueue(bytes);
        },
        error() {
            input.error(new Error('unplugged'));
        },
        get opens() {
            return opens;
        },
        get closes() {
            return closes;
        },
        get aborts() {
            return aborts;
        },
    };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test('selection is not open; receive/write are bytes; deselect releases idle reader and writer', async () => {
    const f = fake();
    const received: Uint8Array[] = [];
    const session = new SerialSession(async (bytes) => {
        received.push(bytes);
    });
    session.select(f.port, 'COM7');
    assert.equal(f.opens, 0);
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    f.push(new Uint8Array([0xe2, 0x82]));
    f.push(new Uint8Array([0xac, 27, 91, 65]));
    session.send(new Uint8Array([3, 13]));
    await tick();
    assert.deepEqual(
        received.flatMap((b) => [...b]),
        [0xe2, 0x82, 0xac, 27, 91, 65],
    );
    assert.deepEqual([...f.writes[0]], [3, 13]);
    await session.close(true);
    assert.equal(f.closes, 1);
    assert.equal(session.current.state, 'idle');
    assert.equal(session.selectedPort, undefined);
    await session.close();
    assert.equal(f.closes, 1);
});
test('cancelled late open releases ownership; duplicate/open replacement is blocked', async () => {
    const gate = deferred();
    const f = fake(gate.promise);
    const session = new SerialSession(async () => {});
    session.select(f.port, 'ttyUSB0');
    const connecting = session.connect(DEFAULT_SERIAL_SETTINGS);
    await assert.rejects(session.connect(DEFAULT_SERIAL_SETTINGS), /still open/);
    const closing = session.close(true);
    assert.throws(() => session.select(fake().port, 'replacement'), /Disconnect/);
    gate.resolve();
    await connecting;
    await closing;
    assert.equal(f.closes, 1);
    assert.equal(session.current.state, 'idle');
});
test('close aborts a hardware-flow blocked write and discards queued input', async () => {
    const gate = deferred();
    const f = fake(undefined, gate.promise);
    const session = new SerialSession(async () => {});
    session.select(f.port, 'port');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    session.send(new Uint8Array(17000).fill(65));
    assert.throws(() => session.send(new Uint8Array(SERIAL_QUEUE_BYTES)), /queue is full/);
    await tick();
    await session.close();
    assert.equal(f.writes.length, 1);
    assert.equal(f.aborts, 1);
    assert.equal(f.closes, 1);
});
test('unplug closes without retry, and stale chooser results do not select', async () => {
    const f = fake();
    const session = new SerialSession(async () => {});
    session.select(f.port, 'port');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    f.error();
    await tick();
    await tick();
    assert.equal(f.opens, 1);
    assert.equal(f.closes, 1);
    const gate = deferred();
    const choosing = session.choose(
        async () => {
            await gate.promise;
            return fake().port;
        },
        () => 'late',
    );
    session.cancelSelection();
    gate.resolve();
    await choosing;
    assert.equal(session.current.label, 'port');
});
test('timeout does not claim closed ownership and close recovery cannot open another port', async () => {
    const gate = deferred();
    const f = fake(gate.promise);
    const session = new SerialSession(async () => {}, 15);
    session.select(f.port, 'port');
    const opening = session.connect(DEFAULT_SERIAL_SETTINGS);
    await assert.rejects(session.close(), /cleanup is still pending/);
    await assert.rejects(session.connect(DEFAULT_SERIAL_SETTINGS), /still open/);
    gate.resolve();
    await opening;
    await session.close();
    assert.equal(f.closes, 1);
});
test('invalid framing cannot open and cancelling selection is ordinary', async () => {
    const f = fake();
    const session = new SerialSession(async () => {});
    session.select(f.port, 'port');
    await assert.rejects(session.connect({ ...DEFAULT_SERIAL_SETTINGS, baudRate: 0 }), /baud rate/);
    assert.equal(f.opens, 0);
    await session.choose(
        async () => {
            throw new DOMException('cancel', 'NotFoundError');
        },
        () => 'port',
    );
    assert.equal(session.current.state, 'selected');
    assert.equal(session.current.message, '');
});
test('a fulfilled open with missing streams is still closed; stream presence is not proof of ownership', async () => {
    let closes = 0;
    const port: LocalSerialPort = {
        readable: null,
        writable: null,
        async open() {},
        async close() {
            closes++;
        },
        getInfo: () => ({}),
    };
    const session = new SerialSession(async () => {});
    session.select(port, 'broken driver');
    await assert.rejects(session.connect(DEFAULT_SERIAL_SETTINGS), /streams are unavailable/);
    assert.equal(closes, 1);
    assert.equal(session.isOwned, false);
});

test('high-volume Serial input/output stay ordered and callback-paced in 16 KiB chunks', async () => {
    const f = fake(),
        gate = deferred(),
        received: Uint8Array[] = [],
        states: string[] = [];
    const session = new SerialSession(async (bytes) => {
        received.push(bytes);
        await gate.promise;
    });
    session.subscribe((s) => states.push(s.message));
    session.select(f.port, 'synthetic');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    const output = new Uint8Array(100000).map((_, i) => i % 251);
    f.push(output);
    await tick();
    assert.equal(received.length, 1);
    assert.equal(received[0].length, 16384);
    gate.resolve();
    await tick();
    assert.deepEqual(Buffer.concat(received), Buffer.from(output));
    assert.ok(received.every((b) => b.length <= 16384));
    session.send(output);
    await tick();
    assert.deepEqual(Buffer.concat(f.writes), Buffer.from(output));
    assert.ok(f.writes.every((b) => b.length <= 16384));
    f.push(new Uint8Array(SERIAL_QUEUE_BYTES + 1));
    await tick();
    await tick();
    assert.ok(states.some((s) => s.includes('buffer limit')));
    assert.equal(f.closes, 1);
    assert.equal(session.isOwned, false);
    await session.close();
});
