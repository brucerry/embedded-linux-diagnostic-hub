import { SoakDecoder } from './fixtures/soak-reader-control.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SoakTimeline, soakEvidenceLimits } from '../scripts/lib/soak-evidence.mjs';
const sourceSHA256 = 'a'.repeat(64),
    nonce = '11111111-1111-4111-8111-111111111111';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
function fixture(options: any = {}) {
    const lines: Buffer[] = [],
        holds: unknown[] = [];
    let syncs = 0,
        closes = 0;
    const writer = new SoakTimeline(
        {
            async writeFile(value: Buffer) {
                lines.push(Buffer.from(value));
            },
            async sync() {
                if (++syncs === options.failSync) throw Error('sync refusal');
            },
            async close() {
                closes++;
                if (options.failClose) throw Error('close refusal');
            },
        },
        {
            compact: false,
            sourceSHA256,
            nonce,
            hold(error: unknown) {
                holds.push(error);
                if (options.failHold) throw Error('hold refusal');
            },
        },
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
async function valid() {
    const f = fixture();
    await f.writer.start();
    await f.writer.transaction(async () => {
        await f.writer.emit('owners', {
            fixtureOwnership: {
                events: [{ kind: 'full-event', message: 'unchanged exact observed history' }],
            },
        });
        await f.writer.emit('sampling-window', { status: 'usable' });
        await f.writer.emit('processes', []);
    });
    await f.writer.enterCleanup();
    await f.writer.finish();
    return f.lines;
}
function repacket(lines: Buffer[], mutate: (packet: any) => void) {
    const rows = lines.map((line) => JSON.parse(line.toString()));
    const extents = rows.filter((row) => row.kind === 'soak-extent');
    const packet = JSON.parse(
        Buffer.concat(extents.map((row) => Buffer.from(row.base64, 'base64'))).toString(),
    );
    mutate(packet);
    const raw = Buffer.from(JSON.stringify(packet)),
        parts = Math.ceil(raw.length / 49152),
        sha256 = hash(raw);
    const dictionaryBytes = packet.definitions.reduce((sum: number, def: any[]) => sum + def[1], 0);
    const reportBytes = Math.max(...packet.events.map((event: any[]) => event[4]));
    return [
        bytes(rows[0]),
        ...Array.from({ length: parts }, (_, index) =>
            bytes({
                kind: 'soak-extent',
                tx: 1,
                index,
                parts,
                bytes: raw.length,
                sha256,
                dictionaryBytes,
                reportBytes,
                base64: raw.subarray(index * 49152, (index + 1) * 49152).toString('base64'),
            }),
        ),
        bytes({
            kind: 'soak-commit',
            tx: 1,
            parts,
            bytes: raw.length,
            sha256,
            sample: true,
            usable: true,
        }),
        ...rows
            .filter((row) => row.kind === 'soak-cleanup' || row.kind === 'soak-footer')
            .map(bytes),
    ];
}
for (const [label, mutation] of [
    [
        'duplicate dictionary content under a fresh ID',
        (p: any) => p.definitions.push([p.definitions.length + 1, ...p.definitions[0].slice(1)]),
    ],
    ['noncontiguous dictionary ID', (p: any) => (p.definitions[0][0] = 2)],
    ['wrong dictionary hash', (p: any) => (p.definitions[0][2] = 'b'.repeat(64))],
    ['unresolved future reference', (p: any) => (p.events[0][6] = -9999)],
    ['missing stage definition', (p: any) => (p.events[0][2] = 9999)],
    [
        'mixed direct multipart stage',
        (p: any) => {
            const text = JSON.stringify('startup-identity-manifest');
            p.definitions[0] = [1, Buffer.byteLength(text), hash(Buffer.from(text)), text];
        },
    ],
    ['unknown node encoding', (p: any) => (p.events[0][6] = [999, 1])],
    ['negative number escape with extra fields', (p: any) => (p.events[0][6] = [0, -1, 2])],
    [
        'wrong logical hash after a valid earlier report',
        (p: any) => (p.events[1][5] = 'b'.repeat(64)),
    ],
    ['non-null ordinary lifecycle ordinal', (p: any) => (p.events[1][1] = 1)],
    ['out-of-order logical sequence', (p: any) => (p.events[1][0] = 99)],
    ['sample without final process result', (p: any) => p.events.reverse()],
] as const)
    test('strict composed reader rejects ' + label + ' before semantic visibility', async () => {
        const lines = repacket(await valid(), mutation),
            records: unknown[] = [];
        const decoder = new SoakDecoder({
            sourceSHA256,
            nonce,
            record: (record: unknown) => records.push(record),
        });
        assert.throws(() => {
            for (const line of lines) decoder.accept(line);
            decoder.finish();
        });
        assert.equal(records.length, 0);
        assert.throws(() => decoder.accept(lines[0]));
        assert.throws(() => decoder.finish());
    });
test('reader callback failure is terminal and cannot be hidden by a footer', async () => {
    const lines = await valid();
    let callbacks = 0;
    const decoder = new SoakDecoder({
        sourceSHA256,
        nonce,
        record() {
            callbacks++;
            throw Error('semantic refusal');
        },
    });
    assert.throws(() => {
        for (const line of lines) decoder.accept(line);
    }, /semantic refusal/);
    assert.equal(callbacks, 1);
    assert.throws(() => decoder.accept(lines.at(-1)!), /semantic refusal/);
    assert.throws(() => decoder.finish(), /semantic refusal/);
});
test('declared packet allocation exceeding current credit is refused before allocating it', async () => {
    const [header] = await valid();
    const decoder = new SoakDecoder({
        sourceSHA256,
        nonce,
        record() {
            assert.fail('unexpected semantic record');
        },
    });
    decoder.accept(header);
    const count = soakEvidenceLimits.readerBufferBytes,
        original = Buffer.alloc;
    let largeAllocations = 0;
    Buffer.alloc = ((size: number, ...args: any[]) => {
        if (size >= count) largeAllocations++;
        return (original as any)(size, ...args);
    }) as any;
    try {
        assert.throws(
            () =>
                decoder.accept(
                    bytes({
                        kind: 'soak-extent',
                        tx: 1,
                        index: 0,
                        parts: Math.ceil(count / 49152),
                        bytes: count,
                        sha256: 'a'.repeat(64),
                        dictionaryBytes: 0,
                        reportBytes: 1,
                        base64: '',
                    }),
                ),
            /reader buffer credit/,
        );
        assert.equal(largeAllocations, 0);
    } finally {
        Buffer.alloc = original;
    }
});
test('hold callback refusal cannot suppress descriptor closure and finalization is coalesced', async () => {
    const f = fixture({ failSync: 2, failHold: true });
    await f.writer.start();
    await assert.rejects(f.writer.emit('owners', {}), /sync refusal/);
    const first = f.writer.finish(),
        second = f.writer.finish();
    assert.equal(first, second);
    await assert.rejects(first, /sync refusal/);
    assert.equal(f.closes, 1);
    assert(f.writer.holdFailure);
    assert(f.holds.length);
    await assert.rejects(f.writer.finish(), /sync refusal/);
    assert.equal(f.closes, 1);
});
test('header sync and actual close failures never produce successful owner completion', async () => {
    for (const options of [{ failSync: 1 }, { failClose: true }]) {
        const f = fixture(options);
        if (options.failSync) await assert.rejects(f.writer.start(), /sync refusal/);
        else {
            await f.writer.start();
            await f.writer.emit('owners', {});
            await f.writer.enterCleanup();
        }
        await assert.rejects(f.writer.finish());
        assert.equal(f.closes, 1);
        assert(f.holds.length);
        if (options.failClose) assert.equal(f.writer.closed, false);
    }
});
test('partial bytes, unclosed transaction and trailing bytes cannot become usable evidence', async () => {
    const lines = await valid();
    for (const input of [
        lines.slice(0, 2),
        lines.slice(0, -1),
        [...lines, bytes({ kind: 'soak-cleanup', tx: 1 })],
        [lines[0], lines[1].subarray(0, -1)],
    ]) {
        const decoder = new SoakDecoder({ sourceSHA256, nonce, record() {} });
        assert.throws(() => {
            for (const line of input) decoder.accept(line);
            decoder.finish();
        });
    }
});

test('an incomplete declared EOF is sticky even if later bytes would complete the stream', async () => {
    const lines = await valid();
    const decoder = new SoakDecoder({ sourceSHA256, nonce, record() {} });
    decoder.accept(lines[0]);
    assert.throws(() => decoder.finish(), /incomplete EOF/);
    assert.throws(() => decoder.accept(lines[1]), /incomplete EOF/);
    assert.throws(() => decoder.finish(), /incomplete EOF/);
});
