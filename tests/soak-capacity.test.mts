import { SoakDecoder } from './fixtures/soak-reader-control.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    CanonicalStaging,
    measureCanonical,
    canonicalDigest,
    allocateCanonical,
} from '../scripts/lib/soak-canonical.mjs';
import {
    SoakTimeline,
    readerBufferAdmission,
    soakEvidenceLimits as limits,
} from '../scripts/lib/soak-evidence.mjs';

test('multi-event transaction may exceed4MiB total while each report expansion remains below4MiB', async () => {
    const f = fixture(),
        payload = 'x'.repeat(1536 * 1024);
    await f.writer.start();
    await f.writer.transaction(async () => {
        await f.writer.emit('owners', { payload });
        await f.writer.emit('owners', { payload });
        await f.writer.emit('owners', { payload });
        await f.writer.emit('processes', []);
    });
    await f.writer.finish();
    let count = 0,
        total = 0;
    const decoder = new SoakDecoder({
        sourceSHA256,
        nonce,
        record(event: any) {
            if (event.stage === 'owners') {
                count++;
                total += event.data.payload.length;
                assert.equal(event.data.payload, payload);
            }
        },
    });
    for (const line of f.lines) decoder.accept(line);
    const proof = decoder.finish();
    assert.equal(count, 3);
    assert(total > limits.reportBytes);
    assert.equal(proof.counters.records, 4);
    assert.equal(proof.counters.reports, 0);
    assert(f.writer.staging.peak <= limits.writerCanonicalBytes);
});
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const sourceSHA256 = 'a'.repeat(64),
    nonce = '11111111-1111-4111-8111-111111111111';
function fixture() {
    const lines: Buffer[] = [],
        holds: unknown[] = [];
    let closes = 0;
    const writer = new SoakTimeline(
        {
            async writeFile(raw: Buffer) {
                lines.push(Buffer.from(raw));
            },
            async sync() {},
            async close() {
                closes++;
            },
        },
        { sourceSHA256, nonce, hold: (error: unknown) => holds.push(error) },
    );
    return {
        writer,
        lines,
        holds,
        get closes() {
            return closes;
        },
    };
}
const barrier = () => {
    let release!: () => void;
    return {
        promise: new Promise<void>((resolve) => (release = resolve)),
        release: () => release(),
    };
};
for (const value of [
    null,
    true,
    false,
    0,
    -0,
    -1,
    1e100,
    'plain',
    '"\\\b\t\n\f\r\u0000',
    '中文😀\ud800\udfff',
    Array(4).fill({ x: 'é😀'.repeat(4097) }),
    { '10': 'integer order', '2': 'second', nested: [1, null, 'tail'] },
])
    test('preflight canonical byte/hash exactness ' + JSON.stringify(value).slice(0, 35), () => {
        const expected = Buffer.from(JSON.stringify(value)),
            measured = measureCanonical(value, limits);
        assert.equal(measured.bytes, expected.length);
        assert.equal(canonicalDigest(value, measured.bytes), sha(expected));
        assert(allocateCanonical(value, measured.bytes, sha(expected)).equals(expected));
    });
test('one shared 32-MiB credit covers seven maximum reports plus one scratch; ninth refuses before acquisition', () => {
    const quota = new CanonicalStaging(limits.writerCanonicalBytes),
        leases = [];
    for (let n = 0; n < 7; n++) leases.push(quota.acquire(limits.reportBytes));
    assert.equal(quota.used, 29360128);
    leases.push(quota.acquire(limits.reportBytes - 1));
    assert.equal(quota.used, limits.writerCanonicalBytes - 1);
    leases.push(quota.acquire(1));
    assert.equal(quota.used, limits.writerCanonicalBytes);
    assert.throws(() => quota.acquire(limits.reportBytes), /Shared canonical/);
    assert.equal(quota.used, limits.writerCanonicalBytes);
    for (const lease of leases) lease.release();
    assert.equal(quota.used, 0);
    assert.equal(quota.peak, 33554432);
});
test('accessors, cycles, proxies and custom serialization refuse before clone allocation or callbacks', () => {
    let calls = 0;
    const getter = {
            get x() {
                calls++;
                return 'forbidden';
            },
        },
        custom = {
            toJSON() {
                calls++;
                return 'forbidden';
            },
        },
        cycle: any = {};
    cycle.self = cycle;
    const proxy = new Proxy(
        { x: 1 },
        {
            ownKeys() {
                calls++;
                throw Error('proxy trap');
            },
        },
    );
    for (const value of [
        getter,
        custom,
        cycle,
        proxy,
        new Date(),
        [undefined],
        Array(2),
        { x: () => 0 },
    ])
        assert.throws(() => measureCanonical(value, limits));
    assert.equal(calls, 0);
});
test('oversized escaped and non-ASCII inputs refuse before materialized clone or publication', async () => {
    for (const value of [
        'x'.repeat(limits.reportBytes + 1),
        '\u0000'.repeat(Math.floor(limits.reportBytes / 6) + 1),
        '中'.repeat(Math.floor(limits.reportBytes / 3) + 1),
    ]) {
        const f = fixture();
        await f.writer.start();
        let allocated = 0;
        const original = Buffer.allocUnsafe;
        Buffer.allocUnsafe = ((size: number) => {
            allocated++;
            return original(size);
        }) as any;
        try {
            await assert.rejects(f.writer.emit('owners', { value }), /before allocation/);
            assert.equal(allocated, 0);
        } finally {
            Buffer.allocUnsafe = original;
        }
        assert.equal(f.lines.length, 1);
        await assert.rejects(f.writer.finish());
        assert.equal(f.closes, 1);
        assert(f.holds.length);
    }
});
for (const dictionary of [0, limits.dictionaryBytes])
    for (const report of [0, limits.reportBytes])
        test(
            'reader residual credit below/exact/above dictionary=' +
                dictionary +
                ' report=' +
                report,
            () => {
                const capacity =
                    limits.readerBufferBytes -
                    dictionary -
                    report -
                    limits.inputBufferBytes -
                    limits.rowBytes;
                assert.equal(
                    readerBufferAdmission(capacity - 1, dictionary, report).total,
                    limits.readerBufferBytes - 1,
                );
                assert.equal(
                    readerBufferAdmission(capacity, dictionary, report).total,
                    limits.readerBufferBytes,
                );
                assert.throws(
                    () => readerBufferAdmission(capacity + 1, dictionary, report),
                    /reader buffer credit/,
                );
                if (dictionary && report) assert.equal(capacity, 3080192);
            },
        );
test('four lightweight queued emissions share active transaction staging and materialize only when admitted', async () => {
    const f = fixture();
    await f.writer.start();
    const entered = barrier(),
        release = barrier();
    let allocated = 0;
    const original = Buffer.allocUnsafe;
    Buffer.allocUnsafe = ((size: number) => {
        allocated++;
        return original(size);
    }) as any;
    try {
        const active = f.writer.transaction(async () => {
            await f.writer.emit('sampling-window', { status: 'usable' });
            entered.release();
            await release.promise;
            await f.writer.emit('processes', []);
        });
        await entered.promise;
        const before = allocated;
        const queued = Array.from({ length: 4 }, (_, n) => f.writer.emit('owners', { n }));
        assert.equal(allocated, before, 'Queued requests must not clone canonical payloads');
        assert(f.writer.staging.used < limits.writerCanonicalBytes);
        release.release();
        await active;
        await Promise.all(queued);
    } finally {
        Buffer.allocUnsafe = original;
    }
    await f.writer.enterCleanup();
    const result = await f.writer.finish();
    assert.equal(result.counters.records, 6);
    assert.equal(result.counters.reports, 0);
    assert.equal(f.writer.staging.used, 0);
});
test('queued input mutation fails sticky instead of publishing changed observed data', async () => {
    const f = fixture();
    await f.writer.start();
    const entered = barrier(),
        release = barrier();
    const active = f.writer.transaction(async () => {
        entered.release();
        await release.promise;
        await f.writer.emit('processes', []);
    });
    await entered.promise;
    const value = { text: 'before' },
        pending = f.writer.emit('owners', value);
    void pending.catch(() => {});
    value.text = 'mutate';
    release.release();
    await active;
    await assert.rejects(pending, /source mutated/);
    await assert.rejects(f.writer.finish());
    assert(f.holds.length);
    assert.equal(f.writer.staging.used, 0);
});
test('cleanup admission refuses new sample/cycle work while accepting explicit final records', async () => {
    const valid = fixture();
    await valid.writer.start();
    await valid.writer.enterCleanup();
    await valid.writer.emit('owners', { stage: 'full-teardown', counts: { producer: 0 } });
    await valid.writer.emit('receipt', { status: 'control-only' });
    await valid.writer.finish();
    const decoder = new SoakDecoder({ sourceSHA256, nonce, record() {} });
    for (const line of valid.lines) decoder.accept(line);
    assert(decoder.finish().complete);
    for (const kind of ['sample', 'cycle']) {
        const f = fixture();
        await f.writer.start();
        await f.writer.enterCleanup();
        if (kind === 'sample')
            await assert.rejects(
                f.writer.transaction(async () => {}),
                /after cleanup/,
            );
        else await assert.rejects(f.writer.emit('measured-cycle', {}), /cleanup-only/);
        await assert.rejects(f.writer.finish());
        assert(f.holds.length);
    }
});
test('provisional semantic state publishes no earlier effects when a late event fails', async () => {
    const f = fixture();
    await f.writer.start();
    await f.writer.transaction(async () => {
        await f.writer.emit('owners', { step: 1 });
        await f.writer.emit('processes', []);
    });
    await f.writer.finish();
    const accepted: unknown[] = [];
    let began = 0;
    const decoder = new SoakDecoder({
        sourceSHA256,
        nonce,
        beginTransaction() {
            began++;
            const next: unknown[] = [];
            return {
                record(event: any) {
                    if (event.stage === 'processes') throw Error('late semantic refusal');
                    next.push(event);
                },
                commit() {
                    accepted.push(...next);
                },
            };
        },
    });
    assert.throws(() => {
        for (const line of f.lines) decoder.accept(line);
    }, /late semantic refusal/);
    assert.equal(began, 1);
    assert.equal(accepted.length, 0);
    assert.throws(() => decoder.finish(), /late semantic/);
});
test('record/report/ordinal counters remain separate and one transactional decode pass is charged', async () => {
    const f = fixture();
    await f.writer.start();
    await f.writer.transaction(async () => {
        await f.writer.emit.publishIdentity('gateway-node-memory', { pid: 42, created: 'actual' });
        await f.writer.emit('sampling-window', { status: 'usable' });
        await f.writer.emit('processes', []);
    });
    await f.writer.finish();
    const records: any[] = [],
        timing: any[] = [];
    const decoder = new SoakDecoder({
        sourceSHA256,
        nonce,
        record: (event: any) => records.push(event),
        timing: (value: any) => timing.push(value),
    });
    for (const line of f.lines) decoder.accept(line);
    const proof = decoder.finish();
    assert.equal(proof.counters.records, 3);
    assert.equal(proof.counters.reports, 1);
    assert.equal(decoder.ordinal, 1);
    assert.equal(
        proof.counters.decodedBytes,
        records.reduce(
            (sum, event) =>
                sum + Buffer.byteLength(JSON.stringify({ stage: event.stage, data: event.data })),
            0,
        ),
    );
    assert.equal(timing.length, 1);
    assert(timing[0].syncEndedMono >= timing[0].syncStartedMono);
    assert(timing[0].canonicalizationMs >= 0);
    assert(timing[0].referenceEncodingMs >= 0);
});
