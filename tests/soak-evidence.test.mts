import { SoakDecoder } from './fixtures/soak-reader-control.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    SoakTimeline,
    SoakLedger,
    soakEvidenceLimits,
    boundedJSON,
    boundedFileLines,
} from '../scripts/lib/soak-evidence.mjs';
const sourceSHA256 = 'a'.repeat(64),
    nonce = '11111111-1111-4111-8111-111111111111';
function fixture(options: any = {}) {
    const lines: Buffer[] = [],
        holds: unknown[] = [];
    let synced = 0,
        closed = 0,
        writes = 0;
    const handle = {
        async writeFile(b: Buffer) {
            if (++writes === options.failWrite) throw Error('write refusal');
            lines.push(Buffer.from(b));
        },
        async sync() {
            if (++synced === options.failSync) throw Error('sync refusal');
        },
        async close() {
            closed++;
            if (options.failClose) throw Error('close refusal');
        },
    };
    const writer = new SoakTimeline(handle, {
        compact: false,
        sourceSHA256,
        nonce,
        hold: (e: unknown) => holds.push(e),
        ...options,
    });
    return {
        writer,
        lines,
        holds,
        handle,
        get closed() {
            return closed;
        },
    };
}
function read(lines: Buffer[], extra: any = {}) {
    const records: any[] = [];
    const decoder = new SoakDecoder({
        sourceSHA256,
        nonce,
        record: (r: unknown) => records.push(r),
        ...extra,
    });
    for (const line of lines) decoder.accept(line);
    return { records, proof: decoder.finish(), decoder };
}
for (const key of [
    'physicalBytes',
    'physicalRows',
    'records',
    'reports',
    'samples',
    'dictionaryEntries',
    'dictionaryBytes',
] as const)
    test('lifetime below/exact/above ' + key, () => {
        const x = new SoakLedger();
        x.enterCleanup();
        const cap = soakEvidenceLimits[key];
        x.reserve({ [key]: cap - 1 });
        x.reserve({ [key]: 1 });
        assert.equal(x.snapshot()[key], cap);
        assert.throws(() => x.reserve({ [key]: 1 }), new RegExp(key));
        assert.throws(() => x.reserve({ [key]: 0 }));
    });
for (const [key, work] of [
    ['physicalBytes', 'workPhysicalBytes'],
    ['physicalRows', 'workPhysicalRows'],
    ['records', 'workRecords'],
    ['reports', 'workReports'],
] as const)
    test('work vs cleanup reservation ' + key, () => {
        const x = new SoakLedger();
        x.reserve({ [key]: soakEvidenceLimits[work] });
        const before = x.snapshot();
        assert.throws(() => x.reserve({ [key]: 1 }));
        assert.deepEqual(x.snapshot(), before);
        const y = new SoakLedger();
        y.reserve(
            Object.fromEntries(
                Object.entries(before).filter(
                    ([key]) =>
                        ![
                            'sampleDecodedBytes',
                            'otherDecodedBytes',
                            'cleanupDecodedBytes',
                        ].includes(key),
                ),
            ),
        );
        y.enterCleanup();
        y.reserve({ [key]: soakEvidenceLimits[key] - before[key] });
        assert.equal(y.snapshot()[key], soakEvidenceLimits[key]);
    });
test('real file writer exceeds finite1024 rows with exact records and a closed footer', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-soak-record-'));
    const file = path.join(root, 'timeline');
    const handle = await fsp.open(file, 'wx');
    const holds: unknown[] = [];
    let time = 1;
    const writer = new SoakTimeline(handle, {
        compact: false,
        sourceSHA256,
        nonce,
        wallClock: () => time++,
        hold: (e: unknown) => holds.push(e),
    });
    try {
        await writer.start();
        for (let i = 0; i < 600; i++)
            await writer.transaction(async () => {
                await writer.emit.publishIdentity('gateway-node-memory', {
                    pid: 42,
                    created: 'same-instance',
                    memory: { rss: i },
                    fixtureOwnership: {
                        events: Array(32).fill({ kind: 'full-event', value: 'x'.repeat(64) }),
                    },
                });
                await writer.emit('processes', [{ pid: 42, created: 'same-instance', rss: i }]);
            });
        await writer.enterCleanup();
        await writer.emit('receipt', { status: 'control-only' });
        const closed = await writer.finish();
        assert(closed.complete);
        const records: any[] = [];
        const decoder = new SoakDecoder({
            sourceSHA256,
            nonce,
            record: (r: unknown) => records.push(r),
        });
        for (const line of boundedFileLines(file)) decoder.accept(line);
        const proof = decoder.finish();
        assert(proof.counters.physicalRows > 1024);
        assert.equal(proof.counters.samples, 600);
        assert.equal(proof.counters.records, 1201);
        assert.equal(records.length, 1201);
        assert.equal(records[1198].data.memory.rss, 599);
        assert.equal(records[1198].time, 1199);
        assert.equal(holds.length, 0);
        assert.deepEqual(proof.counters, closed.counters);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});
test('publication is capability-bound and reserves before any transaction extent', async () => {
    const f = fixture();
    await f.writer.start();
    await assert.rejects(f.writer.emit('gateway-node-memory', {}), /capability/);
    assert.equal(f.lines.length, 1);
    assert(f.holds.length);
    await assert.rejects(f.writer.finish());
    assert.equal(f.closed, 1);
    const g = fixture({ limits: { ...soakEvidenceLimits, workRecords: 0 } });
    await g.writer.start();
    await assert.rejects(g.writer.emit('owners', {}), /records/);
    assert.equal(g.lines.length, 1);
    await assert.rejects(g.writer.finish());
});
test('one sample transaction retains exact repetitions and timestamps without dictionary reset', async () => {
    const f = fixture({ wallClock: () => 123 });
    await f.writer.start();
    const data = {
        pid: 42,
        fixtureOwnership: { events: Array(20).fill({ kind: 'full', x: 'retained'.repeat(20) }) },
    };
    for (let i = 0; i < 3; i++)
        await f.writer.transaction(async () => {
            await f.writer.emit.publishIdentity('gateway-node-memory', data);
            await f.writer.emit('processes', []);
        });
    await f.writer.enterCleanup();
    await f.writer.finish();
    const r = read(f.lines);
    assert.deepEqual(
        r.records.filter((x) => x.stage === 'gateway-node-memory').map((x) => x.data),
        [data, data, data],
    );
    assert(r.records.every((x) => x.time === 123));
    assert.equal(r.proof.counters.samples, 3);
    assert(r.proof.counters.dictionaryEntries < 20);
});
for (const mode of ['failWrite', 'failSync', 'failClose'])
    test('actual refusal remains sticky and closes descriptor port: ' + mode, async () => {
        const f = fixture({ [mode]: mode === 'failClose' ? true : 2 });
        await f.writer.start();
        if (mode === 'failClose') {
            await f.writer.emit('owners', {});
            await f.writer.enterCleanup();
        } else await assert.rejects(f.writer.emit('owners', {}));
        await assert.rejects(f.writer.finish());
        assert.equal(f.closed, 1);
        assert(f.holds.length);
        if (mode === 'failClose') assert(read(f.lines).proof.complete);
        else assert.throws(() => read(f.lines));
    });
for (const mutation of [
    'missing-footer',
    'duplicate-extent',
    'wrong-hash',
    'foreign-nonce',
    'reordered-extent',
    'unknown-kind',
    'missing-commit',
])
    test('strict reader refuses ' + mutation, async () => {
        const f = fixture({ compact: false });
        await f.writer.start();
        await f.writer.emit.publishIdentity('gateway-host-teardown', {
            role: 'actual',
            events: ['x'.repeat(70000)],
        });
        await f.writer.enterCleanup();
        await f.writer.finish();
        const rows = f.lines.map((b) => JSON.parse(b.toString()));
        if (mutation === 'missing-footer') rows.pop();
        if (mutation === 'duplicate-extent') rows.splice(2, 0, rows[1]);
        if (mutation === 'wrong-hash') rows[1].sha256 = 'b'.repeat(64);
        if (mutation === 'foreign-nonce') rows[0].nonce = 'foreign';
        if (mutation === 'reordered-extent') [rows[1], rows[2]] = [rows[2], rows[1]];
        if (mutation === 'unknown-kind') rows[1].kind = 'stage-final';
        if (mutation === 'missing-commit')
            rows.splice(
                rows.findIndex((r) => r.kind === 'soak-commit'),
                1,
            );
        assert.throws(() => read(rows.map((r) => Buffer.from(JSON.stringify(r) + '\n'))));
    });
test('canonical parser refuses duplicate keys, noncanonical UTF8, depth and excessive object graph before parse', () => {
    for (const b of [
        '{"x":1,"x":2}',
        '{ "x":1}',
        '['.repeat(34) + '0' + ']'.repeat(34),
        '[' + Array(70000).fill('0').join(',') + ']',
    ])
        assert.throws(() => boundedJSON(Buffer.from(b)));
    assert.throws(() => boundedJSON(Buffer.from([34, 255, 34])));
});
