import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installProductSerial } from './fixtures/memory-product-serial';
test('actual synthetic WebStreams preserve a known tail across output chunks and close normally', async (t) => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'serial');
    t.after(() => {
        if (original) Object.defineProperty(navigator, 'serial', original);
        else delete (navigator as unknown as { serial?: unknown }).serial;
    });
    const fixture = installProductSerial();
    fixture.configure({ bytes: 21, chunkBytes: 4, tail: 'END' });
    await fixture.port.open({
        baudRate: 115200,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        flowControl: 'none',
        bufferSize: 16384,
    });
    const reader = fixture.port.readable!.getReader(),
        writer = fixture.port.writable!.getWriter();
    const expected = Buffer.from('x'.repeat(18) + 'END\r\nqualification# '),
        chunks: Uint8Array[] = [];
    let received = 0;
    await writer.write(new Uint8Array([65]));
    while (received < expected.length) {
        const value = await reader.read();
        assert.equal(value.done, false);
        assert.ok(value.value);
        chunks.push(value.value);
        received += value.value.length;
        assert.ok(received <= expected.length);
    }
    assert.deepEqual(Buffer.concat(chunks), expected);
    await reader.cancel();
    reader.releaseLock();
    writer.releaseLock();
    await fixture.port.close();
    assert.equal(fixture.snapshot().writes, 1);
    assert.equal(fixture.snapshot().pumping, false);
    assert.equal(fixture.snapshot().closes, 1);
});
