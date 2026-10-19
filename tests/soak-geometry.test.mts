import { SoakDecoder } from './fixtures/soak-reader-control.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { installProductSerial } from './fixtures/memory-product-serial';
import { SerialGeometryRead } from './fixtures/memory-product-geometry';
import { frameCrc } from '../shared/capture-store';
import { SoakTimeline } from '../scripts/lib/soak-evidence.mjs';
const settings = {
    baudRate: 115200,
    dataBits: 8 as const,
    parity: 'none' as const,
    stopBits: 1 as const,
    flowControl: 'none' as const,
    bufferSize: 16384,
};
function fixture(t: any, bound = true) {
    const before = Object.getOwnPropertyDescriptor(navigator, 'serial');
    t.after(() => {
        if (before) Object.defineProperty(navigator, 'serial', before);
        else delete (navigator as any).serial;
    });
    return installProductSerial(
        bound ? { chunkBytes: 16384, prompt: 'qualification# ' } : undefined,
    );
}
test('selected existing 33-MiB fixture emits2112 unchanged body observations and exact17-byte prompt without whole payload allocation', async (t) => {
    const api = fixture(t),
        bodyBytes = 33 * 1024 ** 2,
        tail = 'native-aggregate-9007199254740991';
    api.configure({ bytes: bodyBytes, tail, delayMs: 0 });
    assert.deepEqual(api.snapshot().geometry.expected, {
        chunkBytes: 16384,
        prompt: 'qualification# ',
    });
    await api.port.open(settings);
    const reader = api.port.readable!.getReader(),
        writer = api.port.writable!.getWriter(),
        verifier = new SerialGeometryRead(bodyBytes, tail);
    await writer.write(new Uint8Array([65]));
    let bytes = 0,
        ordinal = 0,
        max = 0;
    while (bytes < bodyBytes + 17) {
        const result = await reader.read();
        assert(!result.done && result.value);
        const value = result.value;
        max = Math.max(max, value.length);
        verifier.append({
            observation: ordinal++,
            receivedAt: '2026-10-19T00:00:00.000Z',
            stream: 'serial',
            offset: 0,
            totalBytes: value.length,
            bytes: value,
            crc32: frameCrc(value),
        });
        bytes += value.length;
    }
    const proof = verifier.finish();
    assert.equal(bytes, bodyBytes + 17);
    assert.equal(proof.observations, 2113);
    assert.equal(proof.bodyObservations, 2112);
    assert.equal(proof.provenance.length, 2113);
    assert.equal(max, 16384);
    assert.equal(proof.everyRawByteVerified, true);
    const lines: Buffer[] = [],
        sourceSHA256 = 'a'.repeat(64),
        nonce = '11111111-1111-4111-8111-111111111111';
    const evidence = new SoakTimeline(
        {
            async writeFile(raw: Buffer) {
                lines.push(Buffer.from(raw));
            },
            async sync() {},
            async close() {},
        },
        {
            sourceSHA256,
            nonce,
            hold: (error: unknown) => {
                throw error;
            },
        },
    );
    await evidence.start();
    await evidence.emit('actual-product-serial-geometry', {
        captureId: '00000000-0000-4000-8000-000000000001',
        read: proof,
    });
    await evidence.finish();
    const reconstructed: any[] = [];
    const decoder = new SoakDecoder({
        sourceSHA256,
        nonce,
        record: (value: any) => reconstructed.push(value),
    });
    for (const line of lines) decoder.accept(line);
    assert(decoder.finish().complete);
    assert.deepEqual(reconstructed[0].data.read, proof);
    assert(
        evidence.ledger.used.dictionaryEntries < 64,
        'Unique receive timestamps must not consume lifetime dictionary entries',
    );
    await reader.cancel();
    reader.releaseLock();
    writer.releaseLock();
    await api.port.close();
    api.configure({ bytes: 32, chunkBytes: 16384, prompt: 'qualification# ', tail: '' });
    assert.equal(api.snapshot().geometry.actual.chunkBytes, 16384);
});
for (const chunkBytes of [1, 64, 8192])
    test(
        'selected qualification geometry refuses ' +
            chunkBytes +
            ' without retry or silent normalization',
        (t) => {
            const api = fixture(t);
            assert.throws(() => api.configure({ chunkBytes }), /geometry mismatch/);
            assert.equal(api.snapshot().geometry.actual.chunkBytes, 16384);
            assert(api.snapshot().geometry.failure);
            assert.throws(() => api.configure({ chunkBytes: 16384 }), /geometry mismatch/);
        },
    );
test('generic fixture keeps its existing admissible64-byte setting but it is outside selected geometry', (t) => {
    const api = fixture(t, false);
    api.configure({ chunkBytes: 64 });
    assert.equal(api.snapshot().geometry.expected, null);
    assert.equal(api.snapshot().geometry.actual.chunkBytes, 64);
});
test('full provenance verifier rejects changed byte, coalesced/rechunked observation and reordered timestamp metadata', () => {
    const bytes = new Uint8Array(32).fill(120),
        frame = {
            observation: 0,
            receivedAt: '2026-10-19T00:00:00.000Z',
            stream: 'serial' as const,
            offset: 0,
            totalBytes: 32,
            bytes,
            crc32: frameCrc(bytes),
        };
    for (const mutate of [
        (f: any) => (f.bytes[31] = 121),
        (f: any) => (f.offset = 1),
        (f: any) => (f.totalBytes = 64),
        (f: any) => (f.observation = 1),
        (f: any) => (f.receivedAt = 'not-a-time'),
    ]) {
        const verifier = new SerialGeometryRead(32, ''),
            value = { ...frame, bytes: bytes.slice() };
        mutate(value);
        assert.throws(() => verifier.append(value));
        assert.throws(() => verifier.finish());
    }
    const short = new SerialGeometryRead(32, '');
    short.append(frame);
    assert.throws(() => short.finish(), /Incomplete/);
});
