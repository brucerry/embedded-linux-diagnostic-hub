import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    PreparationEvidence,
    preparationEvidenceLimits,
    provedPreparationRefusal,
    readPreparationEvidence,
} from '../scripts/lib/observation-preparation-evidence.mjs';
import { runSecurityCommand } from '../scripts/lib/pilot-security-command.mjs';
import { firstPlainParentLaunchEvidence } from '../scripts/lib/plain-parent-launch-evidence.mjs';

// All actual writer operations use these in-memory ports. No filesystem fixture,
// native child, environment mutation, timer, cleanup or release operation exists.
const directory = '/injected-preparation-evidence';
const source = '/injected-source';
const powershell = '/injected-powershell';
const plans = [source, source + '/root', source + '/root/collection'].map((path) => ({
    path,
    kind: 'directory',
}));
const raw = JSON.stringify(plans);
const digest = (data) => createHash('sha256').update(data).digest('hex');
function caught(fn) {
    let result;
    try {
        fn();
    } catch (error) {
        result = error;
    }
    assert(result, 'Expected refusal');
    return result;
}
function memoryWriter({ limits = {}, fault, check = () => {}, admit = () => {} } = {}) {
    const files = new Map(),
        descriptors = new Map(),
        events = [],
        holds = [];
    let next = 10,
        inode = 100,
        held = false,
        reportHold = false;
    const info = (file) => {
        assert(file, 'Injected file must exist');
        return {
            isFile: () => true,
            isSymbolicLink: () => false,
            dev: 1,
            ino: file.ino,
            uid: process.getuid?.() ?? 0,
            nlink: 1,
            size: file.bytes.length,
        };
    };
    const io = {
        openSync(file, flags, mode) {
            events.push({ op: flags === 'wx' ? 'open-write' : 'open-read', file });
            if (flags === 'wx') {
                assert.equal(mode, 0o600);
                assert(!files.has(file));
                if (fault === 'open') throw Error('injected open');
                files.set(file, { ino: inode++, bytes: Buffer.alloc(0) });
            } else {
                assert.equal(typeof flags, 'number');
                assert(files.has(file));
            }
            const fd = next++;
            descriptors.set(fd, { file, writable: flags === 'wx', position: 0 });
            return fd;
        },
        writeSync(fd, bytes, offset, length) {
            const handle = descriptors.get(fd);
            assert(handle?.writable);
            events.push({ op: 'write', file: handle.file });
            if (fault === 'write') throw Error('injected write');
            if (fault === 'zero') return 0;
            const n = fault === 'short' ? Math.min(length, 7) : length;
            const file = files.get(handle.file);
            file.bytes = Buffer.concat([file.bytes, bytes.subarray(offset, offset + n)]);
            return n;
        },
        readSync(fd, bytes, offset, length, position) {
            const handle = descriptors.get(fd);
            assert(handle && !handle.writable);
            assert.equal(position, null);
            events.push({ op: 'read', file: handle.file });
            const content = files.get(handle.file).bytes;
            const n = Math.min(length, content.length - handle.position);
            content.copy(bytes, offset, handle.position, handle.position + n);
            handle.position += n;
            return n;
        },
        fstatSync(fd) {
            const handle = descriptors.get(fd);
            assert(handle);
            return info(files.get(handle.file));
        },
        lstatSync: (file) => info(files.get(file)),
        fsyncSync(fd) {
            assert(descriptors.get(fd)?.writable);
            events.push({ op: 'sync', file: descriptors.get(fd).file });
            if (fault === 'sync') throw Error('injected sync');
        },
        closeSync(fd) {
            assert(descriptors.has(fd));
            events.push({ op: 'close', file: descriptors.get(fd).file });
            if (fault === 'close') throw Error('injected close');
            descriptors.delete(fd);
        },
        readdirSync: (dir) => {
            assert.equal(dir, directory);
            return [...files.keys()].map((p) => path.basename(p));
        },
    };
    const h = { files, descriptors, events, holds, io };
    h.retain = (state) => {
        events.push({ op: 'hold' });
        if (held) return;
        held = true; // Custody always latches before optional hold evidence.
        holds.push(state);
        if (reportHold) h.ledger.record('ownership-held.json', state);
    };
    h.ledger = new PreparationEvidence(directory, {
        io,
        check: () => {
            events.push({ op: 'check' });
            check();
        },
        admit: (n) => {
            events.push({ op: 'admit', bytes: n });
            admit(n);
        },
        hold: h.retain,
        limits,
    });
    h.reportHold = () => {
        reportHold = true;
    };
    h.isHeld = () => held;
    h.audit = () => [...readPreparationEvidence(directory, { io })];
    h.physical = () => [...files.values()].map((f) => JSON.parse(f.bytes.toString()));
    h.effects = () => ({
        opens: events.filter((e) => e.op === 'open-write').length,
        writes: events.filter((e) => e.op === 'write').length,
        syncs: events.filter((e) => e.op === 'sync').length,
        files: files.size,
        rows: h.ledger.rows,
        bytes: h.ledger.bytes,
    });
    return h;
}
function command(h, { telemetry = false, unknown = false, maximum = false } = {}) {
    const environment = Object.freeze({ PATH: 'EXACT_FAKE_PATH' });
    const stdout = maximum ? 'x'.repeat(65536) : 'plain report',
        stderr = maximum ? 'y'.repeat(65536) : '';
    const reply = unknown
        ? {
              status: null,
              signal: 'SIGTERM',
              error: Error('injected unknown'),
              stdout,
              stderr,
              pid: 42,
          }
        : { status: 0, signal: null, stdout, stderr, pid: 42 };
    const binding = firstPlainParentLaunchEvidence({
        sourceRoot: source,
        powershell,
        plans,
        environment,
        clock: () => 1,
    });
    let nativeCalls = 0,
        beforeResult;
    const query = h.ledger.securityQuery((src, exe, input, opts) => {
        const invoke = (token, native) =>
            runSecurityCommand(src, exe, input, {
                ...opts,
                environment,
                record(stage, value) {
                    if (stage === 'security-command-closed') beforeResult = h.effects();
                    return h.ledger.record(stage, value);
                },
                identity: (p) => ({ path: p, pe: { architecture: 'x64' } }),
                spawn: native,
                ...(token ? { parentLaunchEvidence: token } : {}),
                onProcessState(state) {
                    if (!state.closed) h.retain({ phase: 'parent-query-unknown', state });
                    opts.onProcessState(state);
                },
            });
        const fakeNative = () => {
            nativeCalls++;
            return reply;
        };
        return telemetry ? binding.run(invoke, fakeNative) : invoke(undefined, fakeNative);
    });
    return {
        run: () => query(source, powershell, raw),
        calls: () => nativeCalls,
        beforeResult: () => beforeResult,
        stdout,
        stderr,
    };
}
function assertNoNextRecord(h, before) {
    assert.deepEqual(h.effects(), before);
    const next = path.join(directory, String(before.rows).padStart(6, '0') + '.json');
    assert(!h.files.has(next));
    assert(!h.events.some((e) => e.file === next));
}

for (const telemetry of [false, true]) {
    test(`maximum streams with interleaved hold refuse ninth BEFORE record acquisition telemetry=${telemetry}`, () => {
        const h = memoryWriter();
        h.reportHold();
        const c = command(h, { telemetry, unknown: true, maximum: true });
        const error = caught(c.run);
        assertNoNextRecord(h, c.beforeResult());
        assert(provedPreparationRefusal(error));
        assert.equal(provedPreparationRefusal(error).descriptorAcquired, false);
        assert.equal(c.calls(), 1);
        assert.equal(h.ledger.rows, preparationEvidenceLimits.queryRows);
        assert.equal(h.ledger.committed.length, 8);
        assert.equal(h.files.size, 8);
        assert(h.isHeld() && h.ledger.uncertain);
        assert.equal(h.ledger.activeQuery, null);
        assert.equal(h.descriptors.size, 0);
        assert(h.ledger.bytes <= preparationEvidenceLimits.queryBytes);
        const records = h.audit();
        assert.deepEqual(
            records.map((r) => r.stage),
            ['security-input', 'ownership-held.json', ...Array(6).fill('security-output')],
        );
        assert.equal(records[0].data.json, raw);
        assert.equal(records[1].data.state.closed, false);
        assert.equal(h.holds[0].state.closed, false);
        assert(
            h.events.findIndex((e) => e.op === 'hold') <
                h.events.findIndex((e) => e.file?.endsWith('000001.json')),
        );
        for (const stream of ['stdout', 'stderr']) {
            const chunks = records.filter(
                (r) => r.stage === 'security-output' && r.data.stream === stream,
            );
            const bytes = Buffer.concat(chunks.map((r) => Buffer.from(r.data.base64, 'base64')));
            assert.equal(bytes.length, 65536);
            assert.equal(digest(bytes), digest(c[stream]));
        }
        const before = h.effects();
        assert.throws(c.run, /Uncertain query admission/);
        assertNoNextRecord(h, before);
        assert.equal(c.calls(), 1);
    });
    test(`eight command rows succeed at exact unchanged row boundary telemetry=${telemetry}`, () => {
        const h = memoryWriter();
        const c = command(h, { telemetry, maximum: true });
        const value = c.run();
        assert.equal(c.calls(), 1);
        assert.equal(value.result.status, 0);
        assert.equal(h.ledger.rows, 8);
        assert.equal(h.files.size, 8);
        assert(!h.isHeld() && !h.ledger.uncertain && !h.ledger.refused);
        assert.equal(h.descriptors.size, 0);
        assert(h.ledger.complete());
        const rows = h.audit();
        assert.equal(rows.at(-1).stage, 'security-command-closed');
        assert.equal(Object.hasOwn(rows.at(-1).data, 'parentLaunch'), telemetry);
        assert.equal(rows.at(-1).data.streams.stdout.sha256, digest(c.stdout));
        assert.equal(rows.at(-1).data.streams.stderr.sha256, digest(c.stderr));
    });
    test(`uncertain maximum result without interleaved record stays held within eight rows telemetry=${telemetry}`, () => {
        const h = memoryWriter();
        const c = command(h, { telemetry, unknown: true, maximum: true });
        assert.throws(c.run, /closure\/evidence unproved/);
        assert.equal(h.ledger.rows, 8);
        assert.equal(h.audit().at(-1).stage, 'security-command-closed');
        assert(h.isHeld() && h.ledger.uncertain);
        assert.equal(c.calls(), 1);
    });
}

// Measure the ACTUAL compressed/canonical writer representation, not an estimate.
function rowBytes(stage, value) {
    const h = memoryWriter();
    h.ledger.record(stage, value);
    return [...h.files.values()][0].bytes.length;
}
function noise(length) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const out = [];
    let state = 0x12345678;
    for (let n = 0; n < length; n++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        out.push(alphabet[state >>> 26]);
    }
    return out.join('');
}
for (const delta of [-1, 0, 1])
    test(`unchanged245760-byte query partition exact full-size boundary delta=${delta}`, () => {
        const h = memoryWriter();
        const stage = 'security-output';
        const data = (n, size) => {
            const empty = { n, v: '' };
            const overhead = Buffer.byteLength(
                JSON.stringify({ schema: 1, sequence: n, stage, data: empty }) + '\n',
            );
            return { n, v: noise(size - overhead) };
        };
        const q = h.ledger.securityQuery(() => {
            for (let n = 0; n < 3; n++) h.ledger.record(stage, data(n, 61440));
            assert.equal(h.ledger.bytes, 184320);
            if (delta <= 0) {
                h.ledger.record(stage, data(3, 61440 + delta));
                assert.equal(h.ledger.bytes, preparationEvidenceLimits.queryBytes + delta);
                assert(h.physical().every((r) => Object.hasOwn(r, 'data')));
            }
            const before = h.effects();
            const error = caught(() =>
                h.ledger.record(
                    delta > 0 ? stage : 'ownership-held.json',
                    delta > 0 ? data(3, 61441) : {},
                ),
            );
            assert(provedPreparationRefusal(error));
            assertNoNextRecord(h, before);
            throw error;
        });
        caught(() => q('', '', ''));
        assert.equal(h.files.size, delta > 0 ? 3 : 4);
        assert.equal(h.descriptors.size, 0);
        assert(h.ledger.bytes <= preparationEvidenceLimits.queryBytes);
        assert(h.ledger.complete());
    });
for (const stage of [
    'security-input',
    'ownership-held.json',
    'security-output',
    'security-command-closed',
]) {
    const data = { v: 'original' },
        size = rowBytes(stage, data);
    for (const delta of [-1, 0, 1])
        test(`active-query exact serialized byte boundary ${stage} allowance delta=${delta}`, () => {
            const h = memoryWriter({ limits: { queryBytes: size + delta } });
            const q = h.ledger.securityQuery((_s, _p, _r, opts) => {
                if (delta < 0) {
                    const before = h.effects();
                    const error = caught(() => h.ledger.record(stage, data));
                    assert(provedPreparationRefusal(error));
                    assertNoNextRecord(h, before);
                    throw error;
                }
                h.ledger.record(stage, data);
                assert.equal(h.ledger.bytes, size);
                assert.equal(h.ledger.rows, 1);
                // Test a single record partition, without inventing provider closure.
                opts.onProcessState({ attempted: false, closed: false });
            });
            caught(() => q('', '', ''));
            assert.equal(h.files.size, delta < 0 ? 0 : 1);
            assert.equal(h.ledger.bytes, delta < 0 ? 0 : size);
            assert.equal(h.descriptors.size, 0);
        });
}
for (const rows of [0, 1, 7, 8])
    test(`active-query row reservation ${rows} refuses next record without changing ordinal or bytes`, () => {
        const h = memoryWriter({ limits: { queryRows: rows } });
        const q = h.ledger.securityQuery(() => {
            for (let n = 0; n < rows; n++) h.ledger.record('ordinary', { n });
            const before = h.effects();
            const error = caught(() => h.ledger.record('ownership-held.json', {}));
            assert(provedPreparationRefusal(error));
            assertNoNextRecord(h, before);
            assert.equal(h.ledger.rows, rows);
            throw error;
        });
        caught(() => q('', '', ''));
        assert.equal(h.files.size, rows);
        assert.equal(h.descriptors.size, 0);
    });
test('active-query byte usage is relative to admitted prefix, including interleaved hold bytes', () => {
    const h = memoryWriter();
    h.ledger.record('existing-prefix', { prefix: true });
    const prefixBytes = h.ledger.bytes;
    const q = h.ledger.securityQuery(() => {
        assert.equal(h.ledger.activeQuery.bytes, prefixBytes);
        h.ledger.record('security-input', {});
        h.ledger.record('ownership-held.json', { classified: true });
        h.ledger.limits.queryBytes = h.ledger.bytes - prefixBytes;
        const before = h.effects();
        const error = caught(() => h.ledger.record('security-output', {}));
        assert(provedPreparationRefusal(error));
        assertNoNextRecord(h, before);
        throw error;
    });
    caught(() => q('', '', ''));
    assert.equal(h.files.size, 3);
    assert.equal(h.ledger.rows, 3);
});
test('actual reference representation is charged to query bytes before origin acknowledgment', () => {
    const h = memoryWriter();
    const data = { v: 'repeat'.repeat(200) };
    h.ledger.record('security-input', data);
    const q = h.ledger.securityQuery(() => {
        const beforeBytes = h.ledger.bytes;
        h.ledger.record('security-input', data);
        const firstReferenceBytes = h.ledger.bytes - beforeBytes;
        assert(h.physical().at(-1).reference);
        h.ledger.limits.queryBytes = firstReferenceBytes;
        const before = h.effects();
        const error = caught(() => h.ledger.record('security-input', data));
        assert(provedPreparationRefusal(error));
        assertNoNextRecord(h, before);
        throw error;
    });
    caught(() => q('', '', ''));
    assert.equal(h.files.size, 2);
    assert.equal(h.audit()[1].data.v, data.v);
});
for (const stage of ['ordinary', 'security-input', 'ownership-held.json', 'preparation-error'])
    test(`no-active-query default ${stage} ignores query partition while preserving global budget`, () => {
        const h = memoryWriter({ limits: { queryRows: 0, queryBytes: 0 } });
        h.ledger.record(stage, { unchanged: true });
        assert.equal(h.ledger.rows, 1);
        assert.equal(h.audit()[0].data.unchanged, true);
        assert(!h.isHeld() && !h.ledger.refused && !h.ledger.uncertain);
        assert(h.ledger.complete());
    });
for (const failureMode of [false, true])
    test(`global terminal reserves still refuse before record creation failureMode=${failureMode}`, () => {
        const h = memoryWriter();
        h.ledger.failureMode = failureMode;
        h.ledger.rows = h.ledger.limits.rows - (failureMode ? 1 : h.ledger.limits.terminalRows);
        const before = h.effects();
        assert(provedPreparationRefusal(caught(() => h.ledger.record('security-output', {}))));
        assertNoNextRecord(h, before);
    });
for (const delta of [-1, 0, 1])
    test(`no-active-query original global byte boundary allowance delta=${delta}`, () => {
        const stage = 'ordinary',
            value = { v: 'original' };
        const size = rowBytes(stage, value);
        const h = memoryWriter({
            limits: { bytes: preparationEvidenceLimits.terminalBytes + size + delta },
        });
        const before = h.effects();
        if (delta < 0) {
            assert(provedPreparationRefusal(caught(() => h.ledger.record(stage, value))));
            assertNoNextRecord(h, before);
        } else {
            h.ledger.record(stage, value);
            assert.equal(h.files.size, 1);
            assert.equal(h.ledger.bytes, size);
        }
    });
for (const fault of ['open', 'write', 'zero', 'sync', 'close', 'short'])
    test(`admitted writer still preserves original durability/fault semantics: ${fault}`, () => {
        const h = memoryWriter({ fault });
        const q = h.ledger.securityQuery(() => {
            h.ledger.record('security-output', { data: 'original evidence' });
        });
        const error = caught(() => q('', '', ''));
        assert.equal(h.ledger.rows, 1);
        if (fault === 'short') {
            assert.equal(h.audit()[0].data.data, 'original evidence');
            assert(!h.ledger.uncertain && !h.isHeld());
            assert.equal(h.descriptors.size, 0);
        } else {
            assert.equal(provedPreparationRefusal(error), null);
            assert(h.ledger.uncertain && h.isHeld());
            assert.equal(h.ledger.committed.length, 0);
            if (fault === 'close') assert(h.descriptors.size > 0);
        }
    });
for (const gate of ['identity', 'deadline', 'accounting'])
    test(`original ${gate} refusal is not bypassed by query budget admission`, () => {
        let calls = 0;
        const h = memoryWriter({
            check: () => {
                if (gate !== 'accounting' && ++calls === 2) throw Error('injected ' + gate);
            },
            admit: () => {
                if (gate === 'accounting' && ++calls === 2) throw Error('injected accounting');
            },
        });
        const q = h.ledger.securityQuery(() => h.ledger.record('security-input', {}));
        const error = caught(() => q('', '', ''));
        assert.equal(provedPreparationRefusal(error), null);
        assert.equal(h.files.size, 0);
        assert(h.ledger.uncertain && h.isHeld());
    });
test('failed prefix verification on budget refusal remains uncertain, never a proved clean refusal', () => {
    const h = memoryWriter({ limits: { queryRows: 1 } });
    const q = h.ledger.securityQuery(() => {
        h.ledger.record('security-input', {});
        [...h.files.values()][0].ino++;
        const before = h.effects();
        const error = caught(() => h.ledger.record('security-output', {}));
        assert.equal(provedPreparationRefusal(error), null);
        assertNoNextRecord(h, before);
        assert(h.ledger.uncertain && h.isHeld());
        throw error;
    });
    caught(() => q('', '', ''));
});
test('uncertain failure-only stages stay restricted even with unused query capacity', () => {
    const h = memoryWriter();
    h.ledger.uncertain = h.ledger.failureMode = true;
    const before = h.effects();
    const error = caught(() => h.ledger.record('security-output', {}));
    assert.equal(provedPreparationRefusal(error), null);
    assertNoNextRecord(h, before);
    assert(h.isHeld());
});
