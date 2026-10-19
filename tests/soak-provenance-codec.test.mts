import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeProvenance, decodeProvenance } from '../scripts/lib/soak-provenance-codec.mjs';
import { SoakTimeline, soakEvidenceLimits as limits } from '../scripts/lib/soak-evidence.mjs';
import { SoakPhysicalCharges } from '../scripts/lib/soak-physical-charges.mjs';
import { SoakDecoder } from './fixtures/soak-reader-control.mts';
import { measureCanonical } from '../scripts/lib/soak-canonical.mjs';
import { SerialGeometryRead } from './fixtures/memory-product-geometry';
import { frameCrc } from '../shared/capture-store';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rows = (times: string[], first = 0) =>
    times.map((time, index) => [
        first + index,
        time,
        index === times.length - 1 ? 'abcdef12' : '1234abcd',
    ]);
const quota = () => ({ bytes: 0, nodes: 0, members: 0 });
for (const times of [
    ['2026-10-19T00:00:00.000Z'],
    [
        '2026-10-19T00:00:00.001Z',
        '2026-10-19T00:00:00.001Z',
        '2026-10-19T00:00:00.000Z',
        '2026-10-20T00:00:00.999Z',
    ],
    ['0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', '0000-01-01T00:00:00.000Z'],
    ['2024-02-28T23:59:59.999Z', '2024-02-29T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
])
    test('exact observed ordinals/timestamps/CRC and canonical charges ' + times.join('/'), () => {
        const source = rows(times, 42),
            node = encodeProvenance(source),
            q = quota(),
            decoded = decodeProvenance(node, q);
        assert.deepEqual(decoded, source);
        assert.equal(hash(decoded), hash(source));
        const measured = measureCanonical(source, limits);
        assert.equal(q.bytes, measured.bytes);
        assert.equal(q.nodes, measured.nodes);
        assert.equal(q.members, measured.members);
    });
function geometry(body: number, tail = 'tail', extreme = false) {
    const read = new SerialGeometryRead(body, tail);
    let ordinal = 0;
    for (let remaining = body; remaining > 0;) {
        const size = Math.min(remaining, 16384),
            bytes = Buffer.alloc(size, 120);
        if (remaining === size)
            Buffer.from(tail).copy(bytes, bytes.length - Buffer.byteLength(tail));
        const receivedAt = extreme
            ? ordinal % 2
                ? '9999-12-31T23:59:59.999Z'
                : '0000-01-01T00:00:00.000Z'
            : new Date(1792411200000 + ordinal).toISOString();
        read.append({
            observation: ordinal++,
            receivedAt,
            stream: 'serial',
            offset: 0,
            totalBytes: size,
            bytes,
            crc32: frameCrc(bytes),
        });
        remaining -= size;
    }
    const bytes = Buffer.from('\r\nqualification# ');
    read.append({
        observation: ordinal,
        receivedAt: extreme
            ? ordinal % 2
                ? '9999-12-31T23:59:59.999Z'
                : '0000-01-01T00:00:00.000Z'
            : new Date(1792411200000 + ordinal).toISOString(),
        stream: 'serial',
        offset: 0,
        totalBytes: 17,
        bytes,
        crc32: frameCrc(bytes),
    });
    return read.finish();
}
const sourceSHA256 = 'a'.repeat(64),
    nonce = '11111111-1111-4111-8111-111111111111';
function fixture(options: any = {}) {
    const lines: Buffer[] = [];
    let syncs = 0,
        closes = 0;
    const writer = new SoakTimeline(
        {
            async writeFile(raw: Buffer) {
                if (options.partial) {
                    lines.push(Buffer.from(raw.subarray(0, Math.floor(raw.length / 2))));
                    throw Error('partial write');
                }
                lines.push(Buffer.from(raw));
            },
            async sync() {
                if (++syncs === options.failSync) throw Error('sync refusal');
            },
            async close() {
                closes++;
                if (options.failClose) throw Error('close refusal');
            },
        },
        { sourceSHA256, nonce, wallClock: () => 1, monotonic: () => 1, hold() {}, ...options },
    );
    return {
        writer,
        lines,
        get closes() {
            return closes;
        },
    };
}
function read(lines: Buffer[]) {
    const records: any[] = [];
    const decoder = new SoakDecoder({ sourceSHA256, nonce, record: (r: any) => records.push(r) });
    for (const line of lines) decoder.accept(line);
    return { records, proof: decoder.finish(), decoder };
}
for (const extreme of [false, true])
    test(
        'actual primary2113 and rearm geometry roundtrip/hash/expanded charges; signed timestamp extremes=' +
            extreme,
        async () => {
            const f = fixture();
            await f.writer.start();
            const primary = geometry(33 * 1024 ** 2, 'native-aggregate-9007199254740991', extreme),
                rearm = geometry(64, 'tail', extreme);
            const proofs = [primary, rearm].map((proof, index) => ({
                captureId: 'capture-' + index,
                actualMode: {
                    bodyBytes: proof.bodyBytes,
                    chunkBytes: 16384,
                    prompt: 'qualification# ',
                    tail: index ? 'tail' : 'native-aggregate-9007199254740991',
                },
                read: proof,
            }));
            for (const proof of proofs)
                await f.writer.emit('actual-product-serial-geometry', proof);
            const result = await f.writer.finish();
            const decoded = read(f.lines);
            assert.deepEqual(
                decoded.records.map((r) => r.data),
                proofs,
            );
            for (let index = 0; index < proofs.length; index++)
                assert.equal(hash(decoded.records[index].data), hash(proofs[index]));
            const independent = new SoakPhysicalCharges();
            for (const line of f.lines)
                independent.observe(JSON.parse(line.toString()), line.length);
            assert.deepEqual(result.physicalCharges, independent.snapshot());
            assert.deepEqual(decoded.proof.physicalCharges, result.physicalCharges);
            assert.equal(result.counters.physicalBytes, result.physicalCharges.physicalBytes);
            assert.equal(
                result.counters.decodedBytes,
                proofs.reduce(
                    (n, data) =>
                        n +
                        Buffer.byteLength(
                            JSON.stringify({ stage: 'actual-product-serial-geometry', data }),
                        ),
                    0,
                ),
            );
            const codec = encodeProvenance(primary.provenance);
            assert.equal(codec[5].length, 3);
            assert(Buffer.byteLength(JSON.stringify(codec)) <= (extreme ? 35993 : 4313));
            const first = JSON.parse(f.lines[1].toString());
            assert.equal(first.kind, 'soak-local');
            if (!extreme) assert(f.lines[1].length <= 37000);
            assert(first.bytes <= 49152);
        },
    );
for (const [label, mutate] of [
    ['zero count', (v: any) => (v[1] = 0)],
    ['huge count', (v: any) => (v[1] = 1e9)],
    ['negative first', (v: any) => (v[2] = -1)],
    ['overflow ordinal', (v: any) => (v[2] = Number.MAX_SAFE_INTEGER)],
    ['bad UTC offset', (v: any) => (v[3] = '2026-10-19T00:00:00.000+00:00')],
    ['bad calendar', (v: any) => (v[3] = '2026-02-30T00:00:00.000Z')],
    ['short deltas', (v: any) => (v[4] = [])],
    ['fractional delta', (v: any) => (v[4][0] = 0.5)],
    ['negative zero delta', (v: any) => (v[4][0] = -0)],
    ['timestamp overflow', (v: any) => (v[4][0] = Number.MAX_SAFE_INTEGER)],
    ['zero CRC run', (v: any) => (v[5][0][0] = 0)],
    ['short CRC expansion', (v: any) => (v[5] = [[1, '1234abcd']])],
    ['long CRC expansion', (v: any) => (v[5][0][0] = 3)],
    ['bad CRC', (v: any) => (v[5][0][1] = 'UPPERBAD')],
    [
        'duplicate CRC run',
        (v: any) =>
            (v[5] = [
                [1, '1234abcd'],
                [1, '1234abcd'],
            ]),
    ],
    ['extra node field', (v: any) => v.push('extra')],
] as const)
    test('malformed codec refuses before output exposure: ' + label, () => {
        const node = encodeProvenance(
            rows(['2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.001Z']),
        );
        mutate(node);
        const q = quota();
        assert.throws(() => decodeProvenance(node, q));
        assert.deepEqual(q, quota());
    });
test('nonconsecutive source ordinals refuse and every expansion quota is checked before allocation', () => {
    assert.throws(
        () =>
            encodeProvenance([
                [0, '2026-10-19T00:00:00.000Z', '1234abcd'],
                [2, '2026-10-19T00:00:00.001Z', '1234abcd'],
            ]),
        /consecutive/,
    );
    const source = rows(['2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.001Z']),
        node = encodeProvenance(source),
        stats = measureCanonical(source, limits);
    for (const [key, cap] of [
        ['bytes', stats.bytes],
        ['nodes', stats.nodes],
        ['members', stats.members],
    ] as const) {
        const q = quota();
        q[key] = limits[key === 'bytes' ? 'reportBytes' : key] - cap;
        decodeProvenance(node, q);
        const bad = quota();
        bad[key] = limits[key === 'bytes' ? 'reportBytes' : key] - cap + 1;
        assert.throws(() => decodeProvenance(node, bad));
        assert.equal(bad[key], limits[key === 'bytes' ? 'reportBytes' : key] - cap + 1);
    }
    assert.throws(() => decodeProvenance(node, quota(), limits.depth - 1), /depth/);
});
for (const failure of ['partial', 'failSync', 'failClose'])
    test('codec publication ' + failure + ' cannot qualify failed durable ownership', async () => {
        const f = fixture(
            failure === 'failSync'
                ? { failSync: 2 }
                : failure === 'failClose'
                  ? { failClose: true }
                  : {},
        );
        await f.writer.start();
        if (failure === 'partial')
            f.writer.handle.writeFile = async (raw: Buffer) => {
                f.lines.push(Buffer.from(raw.subarray(0, Math.floor(raw.length / 2))));
                throw Error('partial write');
            };
        const task = f.writer.emit('actual-product-serial-geometry', { read: geometry(64) });
        if (failure !== 'failClose') await assert.rejects(task);
        else await task;
        await assert.rejects(f.writer.finish());
        assert.equal(f.closes, 1);
        if (failure !== 'failClose') assert.throws(() => read(f.lines));
        else assert.equal(f.writer.closed, false);
    });
test('compact/extent threshold is exact and unchanged at49152 packet bytes', async () => {
    for (const target of [49151, 49152, 49153]) {
        let padding = target - 600;
        let final: any;
        for (let attempt = 0; attempt < 5; attempt++) {
            const f = fixture();
            await f.writer.start();
            await f.writer.emit('owners', { padding: 'x'.repeat(padding) });
            await f.writer.finish();
            const row = JSON.parse(f.lines[1].toString());
            if (row.bytes === target) {
                final = { f, row };
                break;
            }
            padding += target - row.bytes;
        }
        assert(final, 'Exact packet boundary fixture');
        assert.equal(final.row.kind, target <= 49152 ? 'soak-local' : 'soak-extent');
        assert(read(final.f.lines).proof.complete);
    }
});

test('malformed target codec cannot commit an earlier valid record in the same transaction', async () => {
    const f = fixture();
    await f.writer.start();
    await f.writer.transaction(async () => {
        await f.writer.emit('owners', { first: 'valid but provisional' });
        await f.writer.emit('actual-product-serial-geometry', { read: geometry(64) });
        await f.writer.emit('processes', []);
    });
    await f.writer.finish();
    const lines = f.lines.map((b) => Buffer.from(b)),
        row = JSON.parse(lines[1].toString());
    assert.equal(row.kind, 'soak-local');
    let found: any;
    const visit = (v: any) => {
        if (Array.isArray(v) && v.length === 6 && v[0] === 3 && typeof v[3] === 'string') found = v;
        else if (v && typeof v === 'object') for (const item of Object.values(v)) visit(item);
    };
    visit(row.packet);
    assert(found);
    found[5][0][0] = found[1] + 1;
    const packet = JSON.stringify(row.packet);
    row.bytes = Buffer.byteLength(packet);
    row.sha256 = createHash('sha256').update(packet).digest('hex');
    lines[1] = Buffer.from(JSON.stringify(row) + '\n');
    let committed = 0,
        tentative = 0;
    const decoder = new SoakDecoder({
        sourceSHA256,
        nonce,
        beginTransaction() {
            return {
                record() {
                    tentative++;
                },
                commit() {
                    committed++;
                },
            };
        },
    });
    decoder.accept(lines[0]);
    assert.throws(() => decoder.accept(lines[1]), /Provenance/);
    assert(tentative > 0);
    assert.equal(committed, 0);
    assert.throws(() => decoder.finish());
});
test('expansion refusal occurs before the output tuple array allocation', () => {
    const source = rows(
            Array.from({ length: 2113 }, (_, i) => new Date(1792411200000 + i).toISOString()),
        ),
        node = encodeProvenance(source),
        original = globalThis.Array;
    let allocations = 0;
    globalThis.Array = new Proxy(original, {
        construct(target, args, newTarget) {
            if (args[0] === 2113) allocations++;
            return Reflect.construct(target, args, newTarget);
        },
    }) as typeof Array;
    try {
        assert.throws(
            () => decodeProvenance(node, { bytes: limits.reportBytes, nodes: 0, members: 0 }),
            /bytes/,
        );
        assert.equal(allocations, 0);
        decodeProvenance(node, quota());
        assert.equal(allocations, 1);
    } finally {
        globalThis.Array = original;
    }
});
test('physical charge footer cannot substitute unobserved packet/envelope accounting', async () => {
    const f = fixture();
    await f.writer.start();
    await f.writer.emit('actual-product-serial-geometry', { read: geometry(64) });
    await f.writer.finish();
    const lines = f.lines.map((b) => Buffer.from(b)),
        footer = JSON.parse(lines.at(-1)!.toString());
    footer.physicalChargesBeforeFooter.localEnvelopeBytes++;
    lines[lines.length - 1] = Buffer.from(JSON.stringify(footer) + '\n');
    assert.throws(() => read(lines), /Physical charge footer binding/);
});
