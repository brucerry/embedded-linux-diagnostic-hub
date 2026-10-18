/** Actual Web Streams in Node; no real serial API or port is enumerated/opened. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installProductSerial } from './memory-product-serial';

const settings = {
    baudRate: 115200,
    dataBits: 8 as const,
    parity: 'none' as const,
    stopBits: 1 as const,
    flowControl: 'none' as const,
    bufferSize: 16384,
};
function fixture(t: { after(callback: () => void): void }) {
    const original = Object.getOwnPropertyDescriptor(navigator, 'serial');
    t.after(() => {
        if (original) Object.defineProperty(navigator, 'serial', original);
        else delete (navigator as unknown as { serial?: unknown }).serial;
    });
    return installProductSerial();
}
test('synthetic close rejects actual held open and live reader/writer without resetting them', async (t) => {
    const api = fixture(t);
    api.configure({ holdOpen: true });
    const opening = api.port.open(settings);
    assert.equal(api.snapshot().heldOpen, true);
    await assert.rejects(api.port.close(), /before actual stream ownership ended/);
    assert.equal(api.snapshot().heldOpen, true);
    assert.equal(api.snapshot().closes, 0);
    api.releaseOpen();
    await opening;
    const reader = api.port.readable!.getReader(),
        writer = api.port.writable!.getWriter();
    await assert.rejects(api.port.close(), /before actual stream ownership ended/);
    assert.equal(api.snapshot().readerActive, true);
    assert.equal(api.snapshot().writerActive, true);
    assert.equal(api.snapshot().closes, 0);
    reader.releaseLock();
    writer.releaseLock();
    await api.port.close();
    assert.equal(api.snapshot().closes, 1);
});
test('a released writer lock cannot hide its actual held underlying write', async (t) => {
    const api = fixture(t);
    api.configure({ holdWrite: true });
    await api.port.open(settings);
    const writer = api.port.writable!.getWriter(),
        writing = writer.write(new Uint8Array([88]));
    while (!api.snapshot().heldWrite) await new Promise<void>((resolve) => setImmediate(resolve));
    writer.releaseLock();
    assert.equal(api.snapshot().writerActive, false);
    await assert.rejects(api.port.close(), /before actual stream ownership ended/);
    assert.equal(api.snapshot().heldWrite, true);
    assert.equal(api.snapshot().closes, 0);
    api.releaseWrite();
    await writing;
    await api.port.close();
    const final = api.snapshot();
    assert.equal(final.closes, 1);
    assert.equal(final.heldWrite, false);
    assert.equal(final.remaining, 0);
    assert.equal(final.promptPending, false);
    const ack = final.events.find((event) => event.event === 'write-ack')!,
        closed = final.events.find((event) => event.event === 'close-ack')!;
    assert.ok(ack.ordinal < closed.ordinal);
});
test('unplugged close joins the actual delayed producer before discarding unproduced output', async (t) => {
    const api = fixture(t);
    api.configure({ bytes: 32, delayMs: 1000 });
    await api.port.open(settings);
    const reader = api.port.readable!.getReader(),
        writer = api.port.writable!.getWriter();
    const reading = reader.read(),
        rejected = assert.rejects(reading, /Synthetic local adapter removed/);
    await writer.write(new Uint8Array([88]));
    assert.equal(api.snapshot().pumping, true);
    api.unplug();
    await rejected;
    reader.releaseLock();
    writer.releaseLock();
    let settled = false;
    const closing = api.port.close().then(() => {
        settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(api.snapshot().pumping, true);
    assert.equal(api.snapshot().closes, 0);
    assert.equal(api.snapshot().remaining, 32);
    assert.equal(api.snapshot().produced, 0);
    assert.throws(() => api.configure({ bytes: 1 }), /Finish current fixture response/);
    await closing;
    const final = api.snapshot();
    assert.equal(final.pumping, false);
    assert.equal(final.closes, 1);
    assert.equal(final.remaining, 0);
    assert.equal(final.promptPending, false);
    assert.equal(final.produced, 0);
    const joined = final.events.find((event) => event.event === 'producer-close')!,
        closed = final.events.find((event) => event.event === 'close-ack')!;
    assert.equal(joined.bytes, 32);
    assert.ok(joined.ordinal < closed.ordinal);
});
