import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SoakTimeline,
    SoakDecoder,
    SoakLedger,
    soakEvidenceLimits as limits,
} from '../scripts/lib/soak-evidence.mjs';
import {
    SoakPhysicalReservations,
    soakPhysicalLimits as physical,
    inspectSoakPhysical,
    inspectSoakCohort,
    classifySoakFile,
} from '../scripts/lib/soak-physical-budget.mjs';
const sourceSHA256 = 'a'.repeat(64),
    nonce = '11111111-1111-4111-8111-111111111111';
for (const partition of ['sample', 'other', 'cleanup'] as const)
    test('canonical partition below/exact/above ' + partition, () => {
        const ledger = new SoakLedger();
        if (partition === 'cleanup') ledger.enterCleanup();
        const cap = limits[(partition + 'DecodedBytes') as keyof typeof limits];
        ledger.reserve({ decodedBytes: cap - 1 }, partition);
        ledger.reserve({ decodedBytes: 1 }, partition);
        assert.equal(ledger.used[(partition + 'DecodedBytes') as keyof typeof ledger.used], cap);
        assert.equal(ledger.used.decodedBytes, cap);
        assert.throws(
            () => ledger.reserve({ decodedBytes: 1 }, partition),
            new RegExp(partition + 'DecodedBytes'),
        );
        assert.throws(() => ledger.reserve({ decodedBytes: 0 }, partition));
        if (partition !== 'cleanup') {
            ledger.enterCleanup();
            ledger.reserve({ decodedBytes: limits.cleanupDecodedBytes });
            assert.equal(ledger.used.cleanupDecodedBytes, limits.cleanupDecodedBytes);
        }
    });
test('canonical partitions total2GiB without borrowing or forged accounting', () => {
    const x = new SoakLedger();
    x.reserve({ decodedBytes: limits.sampleDecodedBytes }, 'sample');
    x.reserve({ decodedBytes: limits.otherDecodedBytes }, 'other');
    x.enterCleanup();
    x.reserve({ decodedBytes: limits.cleanupDecodedBytes });
    assert.equal(x.used.decodedBytes, 2147483648);
    const y = new SoakLedger();
    assert.throws(() => y.reserve({ sampleDecodedBytes: 1 }), /Forged/);
});
function fixture(options: any = {}) {
    const lines: Buffer[] = [];
    let syncs = 0,
        closes = 0;
    const writer = new SoakTimeline(
        {
            async writeFile(b: Buffer) {
                lines.push(Buffer.from(b));
            },
            async sync() {
                if (++syncs === options.failSync) throw Error('sync failed');
            },
            async close() {
                closes++;
            },
        },
        { sourceSHA256, nonce, hold() {}, ...options },
    );
    return {
        writer,
        lines,
        get closes() {
            return closes;
        },
    };
}
function reader(lines: Buffer[], record: (e: any) => void = () => {}) {
    const decoder = new SoakDecoder({
        sourceSHA256,
        nonce,
        beginTransaction() {
            const events: any[] = [];
            return {
                record(e: any) {
                    events.push(e);
                },
                commit() {
                    events.forEach(record);
                },
            };
        },
    });
    for (const line of lines) decoder.accept(line);
    return { decoder, proof: decoder.finish() };
}
test('compact row acknowledges only after sync; exact reference histories are immutable and expanded bytes charged once', async () => {
    const f = fixture();
    await f.writer.start();
    const history = { events: [{ kind: 'exact', value: 'x'.repeat(8192) }] };
    for (let i = 0; i < 2; i++)
        await f.writer.transaction(async () => {
            await f.writer.emit('owners', { fixtureOwnership: history });
            await f.writer.emit('processes', []);
        });
    await f.writer.finish();
    assert(f.lines.some((line) => JSON.parse(line.toString()).kind === 'soak-local'));
    const observed: any[] = [];
    const { proof } = reader(f.lines, (e) => observed.push(e));
    assert(proof.complete);
    const a = observed[0].data.fixtureOwnership,
        b = observed[2].data.fixtureOwnership;
    assert.strictEqual(a, b);
    assert(Object.isFrozen(a) && Object.isFrozen(a.events[0]));
    assert.throws(() => {
        a.events[0].value = 'changed';
    });
    assert.equal(
        proof.counters.decodedBytes,
        observed.reduce(
            (n, e) => n + Buffer.byteLength(JSON.stringify({ stage: e.stage, data: e.data })),
            0,
        ),
    );
    assert.equal(proof.decodedPassesReserved, 1);
});
test('work budget refusal remains sticky while healthy cleanup durably closes; no qualifying footer or successful finish', async () => {
    const f = fixture({ limits: { ...limits, otherDecodedBytes: 1 } });
    await f.writer.start();
    await assert.rejects(f.writer.emit('owners', {}), /otherDecodedBytes/);
    const before = f.writer.ledger.snapshot();
    await assert.rejects(f.writer.emit('owners', {}));
    await f.writer.enterCleanup();
    await f.writer.emit('owners', { stage: 'full-teardown', closed: true });
    await assert.rejects(f.writer.finish(), /otherDecodedBytes/);
    assert.equal(f.closes, 1);
    const { proof } = reader(f.lines);
    assert.equal(proof.complete, false);
    assert.match(proof.workFailure, /otherDecodedBytes/);
    assert.equal(proof.counters.otherDecodedBytes, before.otherDecodedBytes);
    assert(proof.counters.cleanupDecodedBytes > 0);
});
test('I/O corruption is fatal and cannot use healthy cleanup path; compact incomplete rows cannot commit', async () => {
    const f = fixture({ failSync: 2 });
    await f.writer.start();
    await assert.rejects(f.writer.emit('owners', {}), /sync failed/);
    await assert.rejects(f.writer.enterCleanup(), /sync failed/);
    await assert.rejects(f.writer.finish(), /sync failed/);
    assert.equal(f.closes, 1);
    assert.throws(() => reader(f.lines));
    const good = fixture();
    await good.writer.start();
    await good.writer.emit('owners', {});
    await good.writer.finish();
    const lines = good.lines.map((b) => Buffer.from(b));
    lines[1] = lines[1].subarray(0, -1);
    let commits = 0;
    assert.throws(() => reader(lines, () => commits++));
    assert.equal(commits, 0);
    assert.throws(() => new SoakDecoder({ sourceSHA256, nonce, record() {} }), /transactional/);
});
for (const partition of [
    'capture',
    'profile',
    'artifact',
    'timeline',
    'streams',
    'auxiliary',
    'cleanup',
] as const)
    test('physical reservation below/exact/above ' + partition, () => {
        const x = new SoakPhysicalReservations();
        if (partition === 'cleanup') x.enterCleanup();
        const cap = physical[partition];
        x.reserve('owned', partition, cap - 1);
        if (partition === 'artifact') {
            assert.throws(() => x.reserve('overlap', partition, 1), /One live/);
            const y = new SoakPhysicalReservations();
            y.reserve('exact', partition, cap);
            assert.throws(() => y.reserve('over', partition, 1));
        } else {
            x.reserve('last', partition, 1);
            assert.throws(() => x.reserve('over', partition, 1), new RegExp(partition));
        }
    });
test('all physical partitions remain independent, total work406/job416, cohort840 with8collector; retirement needs joined producer and actual absence', () => {
    const x = new SoakPhysicalReservations();
    for (const key of [
        'capture',
        'profile',
        'artifact',
        'timeline',
        'streams',
        'auxiliary',
    ] as const)
        x.reserve(key, key, physical[key]);
    assert.equal(x.totals().total, 402 * 1024 ** 2);
    x.enterCleanup();
    x.reserve('cleanup', 'cleanup', physical.cleanup);
    assert.equal(x.totals().total, 412 * 1024 ** 2);
    assert.equal(
        inspectSoakCohort([physical.job, physical.job], physical.collector),
        physical.cohort,
    );
    assert.throws(() => inspectSoakCohort([physical.job, physical.job], physical.collector + 1));
    assert.throws(() => inspectSoakCohort([physical.job + 1], 0));
    const y = new SoakPhysicalReservations(),
        t = y.reserve('a', 'artifact', physical.artifact);
    assert.throws(() =>
        y.retire(t, { descriptorClosed: false, producersJoined: true, paths: ['missing'] }),
    );
    assert.equal(y.totals().artifact, physical.artifact);
    y.retire(t, {
        descriptorClosed: true,
        producersJoined: true,
        paths: ['/tmp/soak-budget-control-absent'],
        io: {
            lstatSync() {
                throw Object.assign(Error('absent'), { code: 'ENOENT' });
            },
        } as any,
    });
    assert.equal(y.totals().artifact, 0);
});
test('physical inventory excludes authoritative captures from profile; counts real atomic temporary and catalog once; symlinks and output-copy overlap refuse', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-soak-partitions-'));
    try {
        const rows = {
            'run/profile/captures-v1/capture-id/raw.jsonl': 100,
            'run/profile/captures-v1/capture-id/meta.tmp': 3,
            'run/profile/captures-v1/.catalog-x.sqlite': 11,
            'run/profile/Cache/file': 7,
            'run/native-downloads/.diagnostic-hub-export-x.tmp': 13,
            'run/timeline.jsonl': 17,
        };
        for (const [rel, size] of Object.entries(rows)) {
            const p = path.join(root, rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, Buffer.alloc(size));
        }
        const result = inspectSoakPhysical(root);
        assert.equal(result.totals.capture, 103);
        assert.equal(result.totals.profile, 18);
        assert.equal(result.totals.artifact, 13);
        assert.equal(result.bytes, 151);
        assert.equal(classifySoakFile('run/profile/captures-v1/.catalog-x.sqlite'), 'profile');
        fs.symlinkSync(path.join(root, 'run/timeline.jsonl'), path.join(root, 'alias'));
        assert.throws(() => inspectSoakPhysical(root), /alias/);
        fs.unlinkSync(path.join(root, 'alias'));
        const p = path.join(root, 'run/native-downloads/report.json');
        fs.writeFileSync(p, '');
        fs.truncateSync(p, physical.artifact);
        assert.throws(() => inspectSoakPhysical(root), /artifact/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('history event prefixes reuse immutable exact element references without hiding expanded byte charges', async () => {
    const f = fixture();
    await f.writer.start();
    const events = [
        { kind: 'one', at: 'a' },
        { kind: 'two', at: 'b' },
    ];
    await f.writer.emit('product-target-control', { receipt: { events } });
    await f.writer.emit('product-target-control', {
        receipt: { events: [...events, { kind: 'three', at: 'c' }] },
    });
    await f.writer.finish();
    const observed: any[] = [];
    const { proof } = reader(f.lines, (e) => observed.push(e));
    assert.strictEqual(observed[0].data.receipt.events[0], observed[1].data.receipt.events[0]);
    assert.deepEqual(observed[1].data.receipt.events, [...events, { kind: 'three', at: 'c' }]);
    assert.equal(
        proof.counters.decodedBytes,
        observed.reduce(
            (n, e) => n + Buffer.byteLength(JSON.stringify({ stage: e.stage, data: e.data })),
            0,
        ),
    );
});
for (const partition of [
    'capture',
    'profile',
    'artifact',
    'timeline',
    'streams',
    'auxiliary',
    'cleanup',
] as const)
    test('actual sparse inventory below/exact/above ' + partition, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-soak-inventory-'));
        const names = {
            capture: 'profile/captures-v1/id/raw.jsonl',
            profile: 'profile/Cache/file',
            artifact: 'native-downloads/report.json',
            timeline: 'timeline.jsonl',
            streams: 'parent.stdout.log',
            auxiliary: 'native-app/file',
            cleanup: 'cleanup-evidence/hold.json',
        };
        const file = path.join(root, names[partition]);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
        try {
            fs.truncateSync(file, physical[partition] - 1);
            assert.equal(
                inspectSoakPhysical(root, { cleanup: true }).totals[partition],
                physical[partition] - 1,
            );
            fs.truncateSync(file, physical[partition]);
            assert.equal(
                inspectSoakPhysical(root, { cleanup: true }).totals[partition],
                physical[partition],
            );
            if (partition === 'artifact' || partition === 'profile') {
                const extra = path.join(path.dirname(file), 'extra');
                fs.writeFileSync(extra, 'x');
            } else fs.truncateSync(file, physical[partition] + 1);
            assert.throws(
                () => inspectSoakPhysical(root, { cleanup: true }),
                new RegExp(partition),
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
test('real descriptor closes after work refusal while preserving synced cleanup and incomplete status', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-soak-cleanup-')),
        file = path.join(root, 'timeline.jsonl');
    const handle = await import('node:fs/promises').then((fs) => fs.open(file, 'wx'));
    try {
        const writer = new SoakTimeline(handle, {
            sourceSHA256,
            nonce,
            limits: { ...limits, otherDecodedBytes: 1 },
            hold() {},
        });
        await writer.start();
        await assert.rejects(writer.emit('owners', {}));
        assert.equal(writer.ledger.used.dictionaryBytes, 0);
        await writer.enterCleanup();
        await writer.emit('owners', { stage: 'full-teardown', counts: { reader: 0 } });
        await assert.rejects(writer.finish());
        assert.equal(handle.fd, -1);
        const lines = fs
            .readFileSync(file)
            .toString()
            .trimEnd()
            .split('\n')
            .map((line) => Buffer.from(line + '\n'));
        assert.equal(reader(lines).proof.complete, false);
        assert(lines.some((line) => JSON.parse(line.toString()).kind === 'soak-local'));
    } finally {
        await handle.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('native atomic link temporary and destination charge one inode; a copied output charges both files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-soak-link-'));
    try {
        const dir = path.join(root, 'native-downloads');
        fs.mkdirSync(dir);
        const tmp = path.join(
                dir,
                '.diagnostic-hub-export-11111111-1111-4111-8111-111111111111.tmp',
            ),
            dest = path.join(dir, 'report-11111111-1111-4111-8111-111111111111.json');
        fs.writeFileSync(tmp, Buffer.alloc(19));
        fs.linkSync(tmp, dest);
        assert.equal(inspectSoakPhysical(root).totals.artifact, 19);
        fs.unlinkSync(dest);
        fs.copyFileSync(tmp, dest);
        assert.equal(inspectSoakPhysical(root).totals.artifact, 38);
        fs.linkSync(tmp, path.join(dir, 'foreign'));
        assert.throws(() => inspectSoakPhysical(root), /alias|ownership/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('late teardown refusal can add a sticky footer failure but can never clear a workload failure', async () => {
    const f = fixture();
    await f.writer.start();
    await f.writer.emit('owners', {});
    await f.writer.enterCleanup();
    f.writer.fail(Error('late teardown refusal'));
    await f.writer.emit('owners', { stage: 'full-teardown' });
    await assert.rejects(f.writer.finish(), /late teardown/);
    const { proof } = reader(f.lines);
    assert.equal(proof.complete, false);
    assert.match(proof.workFailure, /late teardown/);
});

test('reader retains one immutable parsed definition rather than raw bytes plus a duplicate graph', async () => {
    const f = fixture();
    await f.writer.start();
    await f.writer.emit('owners', { fixtureOwnership: { events: [{ kind: 'one' }] } });
    await f.writer.finish();
    const { decoder } = reader(f.lines);
    for (const entry of decoder.dictionary.values()) {
        assert.equal(entry.raw, undefined);
        assert.equal(typeof entry.bytes, 'number');
        assert(entry.value !== undefined);
        if (typeof entry.value === 'object') assert(Object.isFrozen(entry.value));
    }
});
