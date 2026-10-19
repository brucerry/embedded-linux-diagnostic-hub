// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ObservationAccounting } from '../scripts/lib/observation-accounting.mjs';
const MiB = 1024 ** 2;
function fixture() {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shared-accounting-'))),
        root = path.join(tmp, 'private'),
        pty = path.join(tmp, 'closed-pty');
    fs.mkdirSync(root);
    fs.mkdirSync(pty);
    const put = (relative, bytes) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.alloc(bytes));
    };
    put('preparation/facts.json', 101);
    put('runtime/preload.cjs', 202);
    put('native-coverage.json', 303);
    put('collection/outer/collector.stdout.log', 404);
    put('collection/collector/journal.jsonl', 505);
    put('collection/collector-security/acl.json', 606);
    for (const ordinal of [0, 1]) {
        put('collection/collector/job-' + ordinal + '/timeline.jsonl', 707 + ordinal);
        put('collection/collector/parent-' + ordinal + '.stdout.log', 11);
        put('collection/collector/parent-' + ordinal + '.stderr.log', 13);
    }
    fs.writeFileSync(path.join(pty, 'pilot.jsonl'), Buffer.alloc(80));
    const accounting = new ObservationAccounting(root, tmp, { prerequisiteRoots: [pty] });
    return { tmp, root, pty, put, accounting, close: () => fs.rmSync(tmp, { recursive: true }) };
}
test('complete shared prep/runtime/PTY/outer/security inventory counts every physical file once inside840/416/8MiB', () => {
    const f = fixture();
    try {
        const s = f.accounting.admit();
        assert.equal(s.sharedBytes, 101 + 202 + 303 + 404 + 606 + 80 + 505);
        assert.equal(s.collectorBytes, s.sharedBytes);
        assert.deepEqual(s.jobs, [731, 732]);
        assert.equal(s.bytes, s.collectorBytes + 1463);
    } finally {
        f.close();
    }
});
test('external file identities remain assigned once across both jobs; peaks do not double charge retained cache bytes', () => {
    const f = fixture();
    try {
        f.accounting.start(0);
        const file = path.join(f.tmp, 'new-cache');
        fs.writeFileSync(file, Buffer.alloc(100));
        f.accounting.scan();
        f.accounting.end(0);
        f.accounting.start(1);
        fs.writeFileSync(file, Buffer.alloc(180));
        fs.writeFileSync(path.join(f.tmp, 'job1-cache'), Buffer.alloc(50));
        const s = f.accounting.scan();
        assert.deepEqual(s.externalAuxiliary, [180, 50]);
        assert.equal(s.bytes, s.sharedBytes + 731 + 732 + 230);
        f.accounting.end(1);
    } finally {
        f.close();
    }
});
test('shared8MiB exact boundary uses disjoint4MiB writer credits and includes outer and PTY records', () => {
    const f = fixture();
    try {
        const s = f.accounting.scan(),
            parent = path.join(f.root, 'collection', 'outer', 'padding'),
            child = path.join(f.root, 'collection', 'collector', 'padding');
        fs.writeFileSync(parent, '');
        fs.writeFileSync(child, '');
        fs.truncateSync(parent, 4 * MiB - s.sharedAllocation.parentBytes);
        fs.truncateSync(child, 4 * MiB - s.sharedAllocation.collectorBytes);
        assert.equal(f.accounting.scan().collectorBytes, 8 * MiB);
        fs.truncateSync(parent, 4 * MiB - s.sharedAllocation.parentBytes + 1);
        assert.throws(() => f.accounting.scan(), /shared credit/);
    } finally {
        f.close();
    }
});
test('missing prerequisite or started job tree cannot silently disappear from the shared inventory', () => {
    for (const target of ['pty', 'job']) {
        const f = fixture();
        try {
            f.accounting.start(0);
            fs.rmSync(
                target === 'pty' ? f.pty : path.join(f.root, 'collection', 'collector', 'job-0'),
                { recursive: true },
            );
            assert.throws(() => f.accounting.scan());
        } finally {
            f.close();
        }
    }
});
test('foreign aliases and auxiliary excess refuse instead of manufacturing external headroom', () => {
    const f = fixture();
    try {
        f.accounting.start(0);
        const file = path.join(f.tmp, 'new-cache');
        fs.writeFileSync(file, '');
        fs.truncateSync(file, 32 * MiB + 1);
        assert.throws(() => f.accounting.scan());
        fs.unlinkSync(file);
        fs.symlinkSync(path.join(f.root, 'runtime'), path.join(f.root, 'alias'));
        assert.throws(() => f.accounting.scan(), /alias/);
    } finally {
        f.close();
    }
});
