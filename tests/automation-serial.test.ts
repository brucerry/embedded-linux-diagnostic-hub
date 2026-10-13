import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialSession } from '../src/features/serial/session';
import { DEFAULT_SERIAL_SETTINGS, type LocalSerialPort } from '../shared/serial';
function fixture() {
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const writes: Uint8Array[] = [],
        port: LocalSerialPort = {
            readable: null,
            writable: null,
            async open() {
                this.readable = new ReadableStream({
                    start(c) {
                        input = c;
                    },
                });
                this.writable = new WritableStream({
                    write(bytes) {
                        writes.push(bytes);
                    },
                });
            },
            async close() {
                this.readable = null;
                this.writable = null;
            },
            getInfo: () => ({}),
        };
    return {
        port,
        writes,
        push(text: string) {
            input.enqueue(new TextEncoder().encode(text));
        },
    };
}
const tick = () => new Promise((r) => setImmediate(r));
test('Serial automation owns input, ignores prior app buffer and captures split ANSI prompt/raw payload', async () => {
    const f = fixture(),
        session = new SerialSession(async () => {});
    session.select(f.port, 'COM synthetic');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    f.push('old-console# ');
    await tick();
    const release = session.acquireAutomation();
    assert.throws(() => session.send(new Uint8Array([1])), /owned/);
    const pending = session.runAutomation(
        new TextEncoder().encode('two\nlines\r'),
        'console# ',
        1000,
        new AbortController().signal,
    );
    await new Promise((r) => setTimeout(r, 130));
    assert.equal(Buffer.concat(f.writes).toString(), 'two\nlines\r');
    f.push('reply €\n\x1b[');
    f.push('32mcon');
    f.push('sole# ');
    const result = await pending;
    assert.equal(result.completion, 'prompt-observed');
    assert.equal(result.exitCode, null);
    assert.doesNotMatch(result.stdout, /old-console/);
    assert.ok(result.stdout.includes('reply €'));
    assert.equal(
        Buffer.concat(result.chunks.map((c) => Buffer.from(c.base64, 'base64'))).toString(),
        result.stdout,
    );
    release();
    session.send(new TextEncoder().encode('interactive'));
    await tick();
    assert.ok(Buffer.concat(f.writes).toString().endsWith('interactive'));
    await session.close();
});
test('Serial timeout/cancel and disconnect never claim exit or send helper payloads', async () => {
    const f = fixture(),
        session = new SerialSession(async () => {});
    session.select(f.port, 'synthetic');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    const release = session.acquireAutomation();
    const result = await session.runAutomation(
        new TextEncoder().encode('one'),
        '# ',
        40,
        new AbortController().signal,
    );
    assert.equal(result.completion, 'timeout');
    assert.equal(result.exitCode, null);
    const abort = new AbortController(),
        pending = session.runAutomation(new TextEncoder().encode('two'), '# ', 1000, abort.signal);
    await tick();
    abort.abort();
    assert.equal((await pending).completion, 'cancelled');
    assert.equal(Buffer.concat(f.writes).toString(), 'onetwo');
    release();
    await session.close();
});
