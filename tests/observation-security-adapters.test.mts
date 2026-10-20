// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
    preparationObservationSecurity,
    collectorObservationSecurity,
    closedObservationSecurityRefusal,
} from '../scripts/lib/observation-security.mjs';
import {
    runSecurityCommand,
    firstCollectorSecurityQuery,
} from '../scripts/lib/pilot-security-command.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { closeEntries, writeAll, digest } from '../scripts/lib/product-collector-evidence.mjs';
import { refuseObservationPreparation } from '../scripts/windows-observation-pair.mts';
import { preserveObservationPty } from '../scripts/lib/observation-pty-receipt.mjs';
import { runCollector } from '../scripts/memory-product-collect.mts';
const sourceRoot = path.resolve(import.meta.dirname, '..'),
    principal = 'S-1-5-21-1-2-3-500';
function ace(sid, flags) {
    const pieces = sid.split('-').slice(1).map(Number),
        sub = pieces.slice(2),
        b = Buffer.alloc(16 + sub.length * 4);
    b[0] = 0;
    b[1] = flags;
    b.writeUInt16LE(b.length, 2);
    b.writeUInt32LE(0x1f01ff, 4);
    b[8] = 1;
    b[9] = sub.length;
    b.writeUIntBE(pieces[1], 10, 6);
    sub.forEach((v, i) => b.writeUInt32LE(v, 16 + i * 4));
    return { type: 0, flags, binary: b.toString('base64') };
}
function report(plans) {
    return {
        schema: 1,
        complete: true,
        principal,
        rows: plans.map((p) => ({
            ...p,
            owner: principal,
            group: 'S-1-5-21-1-2-3-513',
            daclPresent: true,
            daclNull: false,
            aces: ['S-1-5-18', 'S-1-5-32-544', principal].map((s) =>
                ace(s, p.kind === 'file' ? 16 : 19),
            ),
            binary: Buffer.alloc(32, 1).toString('base64'),
        })),
    };
}
function fixture(kind, diagnostic = false) {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-security-adapter-'))),
        root = path.join(tmp, 'private'),
        collection = path.join(root, 'collection'),
        pty = path.join(tmp, 'pty');
    fs.mkdirSync(collection, { recursive: true });
    fs.mkdirSync(pty);
    const files = Array.from({ length: 32 }, (_, i) => {
        const p = path.join(root, 'evidence-' + i);
        fs.writeFileSync(p, 'owned evidence');
        return p;
    });
    const calls = [],
        records = [],
        holds = [];
    let fault = null,
        faultAt = 2,
        cancelled = false,
        recordOrdinal = 0;
    const retainOwnership = (state, record, options = {}) => {
        const handle = {
            referenced: false,
            ref() {
                this.referenced = true;
            },
        };
        const hold = createOwnershipHold(state, record, { ...options, interval: () => handle });
        holds.push({ state, hold, handle });
        return hold;
    };
    const record = (stage, data) => {
        const file = path.join(root, 'query-' + recordOrdinal++ + '.json'),
            entry = { fd: fs.openSync(file, 'wx'), errors: [], attempted: false };
        try {
            writeAll(entry.fd, Buffer.from(JSON.stringify({ stage, data })));
        } finally {
            assert(closeEntries([entry]).complete);
        }
        records.push({ stage, data, file });
    };
    const check = () => {
        assert(!cancelled, 'Cancelled/deadline before next batch');
    };
    const securityQuery = diagnostic
        ? firstCollectorSecurityQuery({
              outputRoot: collection,
              diagnostic: true,
              clock: () => 100,
          })
        : runSecurityCommand;
    const query = (src, pwsh, raw, options) =>
        securityQuery(src, pwsh, raw, {
            ...options,
            identity: (p) => ({ path: p, sha256: 'a'.repeat(64), pe: { architecture: 'x64' } }),
            spawn(_exe, _args, launch) {
                const plans = JSON.parse(launch.env.HUB_NATIVE_PILOT_SECURITY_PATHS);
                assert(
                    Array.isArray(plans) && plans.length >= 1 && plans.length <= 3,
                    'unchanged production max3',
                );
                calls.push(structuredClone(plans));
                let v = report(plans);
                const active = calls.length === faultAt ? fault : null;
                if (active === 'throw') throw Error('spawn uncertain');
                if (active === 'timeout')
                    return {
                        status: null,
                        signal: 'SIGTERM',
                        error: Object.assign(Error('spawnSync fixture-winps.exe ETIMEDOUT'), {
                            code: 'ETIMEDOUT',
                        }),
                        stdout: '',
                        stderr: '',
                    };
                if (active === 'signal')
                    return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
                if (
                    ['refusal', 'touched-refusal', 'refusal-schema', 'refusal-principal'].includes(
                        active,
                    )
                )
                    return {
                        status: 1,
                        signal: null,
                        stdout: JSON.stringify({
                            schema: active === 'refusal-schema' ? 2 : 1,
                            principal:
                                active === 'refusal-principal' ? 'S-1-5-21-9-9-9-500' : principal,
                            complete: false,
                            rows: [],
                            trace: { getItemCalls: active === 'refusal' ? 0 : 1, getAclCalls: 0 },
                            error: { message: 'Input refused' },
                        }),
                        stderr: '',
                    };
                if (active === 'malformed')
                    return { status: 1, signal: null, stdout: '{', stderr: '' };
                if (active === 'principal') v.principal = 'S-1-5-21-9-9-9-500';
                if (active === 'path') v.rows[0].path += '-wrong';
                if (active === 'descriptor')
                    v.rows[0].binary = Buffer.alloc(32, 2).toString('base64');
                if (active === 'cancel') cancelled = true;
                return { status: 0, signal: null, stdout: JSON.stringify(v), stderr: '' };
            },
        });
    let ownerCheck, adapter;
    if (kind === 'preparation') {
        adapter = preparationObservationSecurity(
            sourceRoot,
            'fixture-winps.exe',
            [
                { path: tmp, kind: 'directory' },
                { path: root, kind: 'directory' },
            ],
            {
                record,
                check,
                query,
                onProcessState: (state) => {
                    if (!state.closed)
                        retainOwnership(
                            { phase: 'preparation-security-query-unknown', state },
                            record,
                        );
                },
            },
        );
        ownerCheck = adapter.ownerCheck;
        calls.length = 0;
    } else {
        ownerCheck = collectorObservationSecurity(
            {
                outputRoot: collection,
                canonicalTmp: tmp,
                observationPtyRoot: pty,
                powershell: { path: 'fixture-winps.exe' },
                principalSID: principal,
                outputRootSDDLSHA256: digest(Buffer.alloc(32, 1)),
                canonicalTmpSDDLSHA256: digest(Buffer.alloc(32, 1)),
            },
            sourceRoot,
            { query, retainOwnership, check },
        );
    }
    return {
        tmp,
        root,
        pty,
        files,
        calls,
        records,
        holds,
        ownerCheck,
        adapter,
        record,
        retainOwnership,
        setFault(value, at = 2) {
            fault = value;
            faultAt = at;
            calls.length = 0;
        },
        close() {
            fs.rmSync(tmp, { recursive: true });
        },
    };
}
for (const kind of ['preparation', 'collector'])
    for (const size of [1, 2, 3, 4, 6, 16, 32])
        test(
            kind + ' actual adapter -> runSecurityCommand enforces max3 for ' + size + ' paths',
            () => {
                const f = fixture(kind);
                try {
                    const rows = f.ownerCheck.many(f.files.slice(0, size));
                    assert.deepEqual(
                        rows.map((r) => r.path),
                        f.files.slice(0, size),
                    );
                    assert.deepEqual(
                        f.calls.map((p) => p.length),
                        Array.from({ length: Math.ceil(size / 3) }, (_, i) =>
                            Math.min(3, size - i * 3),
                        ),
                    );
                    assert.equal(f.holds.length, 0);
                } finally {
                    f.close();
                }
            },
        );
for (const kind of ['preparation', 'collector'])
    for (const fault of [
        'refusal',
        'touched-refusal',
        'refusal-schema',
        'refusal-principal',
        'malformed',
        'principal',
        'path',
        'descriptor',
        'cancel',
        'signal',
        'timeout',
        'throw',
    ])
        test(kind + ' batch2 ' + fault + ' stops before batch3; no partial success', () => {
            const f = fixture(kind);
            try {
                if (fault === 'descriptor') f.ownerCheck.many(f.files.slice(0, 7));
                const before = f.adapter && new Map(f.adapter.descriptors);
                f.setFault(fault);
                let error;
                try {
                    f.ownerCheck.many(f.files.slice(0, 7));
                    assert.fail('Batch fault must refuse');
                } catch (e) {
                    error = e;
                }
                assert.equal(f.calls.length, 2);
                if (before) assert.deepEqual(f.adapter.descriptors, before);
                if (fault === 'refusal') {
                    assert.deepEqual(closedObservationSecurityRefusal(error), {
                        kind: 'closed-security-input-refusal',
                        batch: 1,
                        plans: 3,
                        processClosed: true,
                        rawEvidenceClosed: true,
                        getItemCalls: 0,
                        getAclCalls: 0,
                    });
                    assert.equal(f.holds.length, 0);
                } else assert.equal(closedObservationSecurityRefusal(error), null);
                if (['signal', 'timeout', 'throw'].includes(fault)) {
                    assert.equal(f.holds.length, 1);
                    assert(f.holds[0].handle.referenced);
                }
            } finally {
                f.close();
            }
        });
for (const diagnostic of [false, true])
    test(
        'exact first collector query timeout holds before result reporting/controller preparation; diagnostic=' +
            diagnostic,
        async () => {
            const f = fixture('collector', diagnostic),
                events = Object.assign(new EventEmitter(), { connected: true }),
                timers = new Set(),
                clock = {
                    now: () => 100,
                    set: (fn) => (timers.add(fn), fn),
                    clear: (fn) => timers.delete(fn),
                },
                nonce = '00000000-0000-4000-8000-000000000058',
                lease = new ProductLease(path.join(f.root, 'fixture-only-marker'), { nonce });
            let prepared = 0;
            lease.acquire();
            f.setFault('timeout', 1);
            try {
                await assert.rejects(
                    runCollector(
                        {},
                        'a'.repeat(64),
                        nonce,
                        { schema: 1, nonce, startedAt: 100, deadlineMs: 4800100 },
                        {
                            events,
                            clock,
                            verify: () => f.ownerCheck(path.join(f.root, 'collection')),
                            prepare: () => {
                                prepared++;
                                throw Error('Must not reach controller preparation');
                            },
                        },
                    ),
                    /Collector security custody remains held/,
                );
                assert.equal(f.calls.length, 1);
                assert.equal(prepared, 0);
                assert.equal(f.holds.length, 1);
                assert(f.holds[0].handle.referenced);
                const directory = path.join(f.root, 'collection', 'collector-security'),
                    records = fs
                        .readdirSync(directory)
                        .map((name) =>
                            JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
                        );
                assert.deepEqual(
                    records.map((r) => r.stage),
                    ['security-input', 'ownership-held.json', 'security-command-closed'],
                );
                assert.deepEqual(records[1].data.state, {
                    attempted: true,
                    closed: false,
                    status: null,
                    signal: 'SIGTERM',
                    errorPresent: true,
                });
                assert.match(records[2].data.error, /ETIMEDOUT/);
                assert.equal(records[2].data.streams.stdout.bytes, 0);
                assert.equal(records[2].data.streams.stderr.bytes, 0);
                assert.equal(Boolean(records[0].data.diagnostic), diagnostic);
                assert.equal(Boolean(records[2].data.diagnostic), diagnostic);
                if (diagnostic) assert.equal(records[2].data.diagnostic.returnedPID, null);
                assert(lease.state().retained);
                assert(!lease.state().released);
                assert(!fs.existsSync(path.join(f.root, 'collection', 'collector')));
                assert.equal(
                    timers.size,
                    0,
                    'Entry timer retirement does not retire the independent referenced hold',
                );
            } finally {
                // Only this fresh fixture tree is removed; no production or historical lease is touched.
                f.close();
            }
        },
    );
for (const fault of ['open', 'write', 'sync', 'close'])
    test(
        'collector actual record ' +
            fault +
            ' failure latches hold before durable reason; no recursive same-path write',
        (t) => {
            const f = fixture('collector'),
                fdPaths = new Map(),
                open = fs.openSync,
                close = fs.closeSync,
                sync = fs.fsyncSync;
            let faulted = false,
                unclosed = null;
            try {
                t.mock.method(fs, 'openSync', function (file, ...args) {
                    if (fault === 'open' && !faulted && String(file).endsWith('000003.json')) {
                        faulted = true;
                        throw Error('open failed');
                    }
                    const fd = open(file, ...args);
                    fdPaths.set(fd, String(file));
                    return fd;
                });
                if (fault === 'write') {
                    const write = fs.writeSync;
                    t.mock.method(fs, 'writeSync', function (fd, ...args) {
                        if (!faulted && fdPaths.get(fd)?.endsWith('000003.json')) {
                            faulted = true;
                            throw Error('write failed');
                        }
                        return write(fd, ...args);
                    });
                } else if (fault === 'sync')
                    t.mock.method(fs, 'fsyncSync', function (fd) {
                        if (!faulted && fdPaths.get(fd)?.endsWith('000003.json')) {
                            faulted = true;
                            throw Error('sync unknown');
                        }
                        return sync(fd);
                    });
                else
                    t.mock.method(fs, 'closeSync', function (fd) {
                        if (!faulted && fdPaths.get(fd)?.endsWith('000003.json')) {
                            faulted = true;
                            unclosed = fd;
                            throw Error('close unknown');
                        }
                        return close(fd);
                    });
                assert.throws(() => f.ownerCheck.many(f.files.slice(0, 7)));
                assert.equal(f.calls.length, 1);
                assert(faulted);
                assert.equal(f.holds.length, 1);
                assert(f.holds[0].handle.referenced);
                const dir = path.join(f.root, 'collection', 'collector-security'),
                    rows = fs.readdirSync(dir).map((n) => {
                        const text = fs.readFileSync(path.join(dir, n), 'utf8');
                        return text.length ? JSON.parse(text) : { incomplete: true };
                    });
                if (fault === 'write') assert(rows.some((r) => r.incomplete));
                assert(
                    rows.some(
                        (r) =>
                            r.stage === 'ownership-held.json' &&
                            r.data.phase === 'collector-security-evidence-unknown',
                    ),
                );
                if (unclosed !== null) {
                    assert(fs.fstatSync(unclosed).isFile());
                    close(unclosed);
                    unclosed = null;
                }
            } finally {
                if (unclosed !== null) close(unclosed);
                t.mock.restoreAll();
                f.close();
            }
        },
    );
test('six PTY files pass actual preparation adapter before durable source/scope/closure revalidation', () => {
    const f = fixture('preparation');
    try {
        // Deliberately incomplete journal: batching succeeds, then the unchanged receipt validator refuses.
        fs.writeFileSync(path.join(f.pty, 'pilot.jsonl'), '');
        for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(f.pty, 'evidence-' + i), 'x');
        const holds = [];
        assert.throws(() =>
            preserveObservationPty(
                f.pty,
                {},
                {
                    sourceRoot,
                    host: {},
                    canonicalTemp: f.tmp,
                    ownerCheck: f.ownerCheck,
                    hold: (s) => holds.push(s),
                },
            ),
        );
        assert.deepEqual(
            f.calls.map((p) => p.length),
            [1, 3, 3],
        );
        assert.equal(holds.length, 1);
        assert.match(holds[0].phase, /pty-source/);
    } finally {
        f.close();
    }
});
test('proved input-only refusal avoids false unknown hold; same six-file route stops before any reader', () => {
    const f = fixture('preparation');
    try {
        fs.writeFileSync(path.join(f.pty, 'pilot.jsonl'), '');
        for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(f.pty, 'evidence-' + i), 'x');
        f.setFault('refusal', 2);
        const holds = [];
        let error;
        try {
            preserveObservationPty(
                f.pty,
                {},
                {
                    sourceRoot,
                    host: {},
                    canonicalTemp: f.tmp,
                    ownerCheck: f.ownerCheck,
                    hold: (s) => holds.push(s),
                },
            );
        } catch (e) {
            error = e;
        }
        assert(closedObservationSecurityRefusal(error));
        assert.equal(holds.length, 0);
        assert.deepEqual(
            f.calls.map((p) => p.length),
            [1, 3],
        );
        assert.equal(
            closedObservationSecurityRefusal({
                ...error,
                processClosed: true,
                rawEvidenceClosed: true,
            }),
            null,
        );
    } finally {
        f.close();
    }
});
for (const scenario of [
    'positive-prefix',
    'positive-joined',
    'unjoined-worker',
    'evidence',
    'source',
    'guard',
    'marker',
    'record',
])
    test('preparation refusal requires positive release proofs: ' + scenario, async () => {
        const f = fixture('preparation'),
            lease = new ProductLease(path.join(f.tmp, 'owned-marker'), { nonce: 'fixture' });
        lease.acquire();
        let recorded = false;
        try {
            const opts = {
                lease,
                verifySource: async () => scenario !== 'source',
                check() {
                    if (scenario === 'guard') throw Error('ancestry changed');
                },
                record(name, value) {
                    if (scenario === 'record') throw Error('result not durable');
                    f.record(name, value);
                    recorded = true;
                },
                resourceStates: () => ({
                    electron:
                        scenario === 'unjoined-worker'
                            ? 'running'
                            : scenario === 'positive-joined'
                              ? 'closed'
                              : 'not-started',
                    runtime: 'not-started',
                }),
                evidenceComplete: () => scenario !== 'evidence',
            };
            if (scenario === 'marker') fs.writeFileSync(lease.file, 'changed');
            if (scenario.startsWith('positive')) {
                const r = await refuseObservationPreparation(
                    Error('Known preparation refusal'),
                    opts,
                );
                assert(r.released);
                assert(!fs.existsSync(lease.file));
                assert(recorded);
            } else {
                await assert.rejects(refuseObservationPreparation(Error('Refusal'), opts));
                assert(fs.existsSync(lease.file));
                const held = f.retainOwnership({ phase: 'preparation-release-unknown' }, f.record);
                assert(held.snapshot().referencedHandleCreated);
            }
        } finally {
            f.close();
        }
    });
for (const persistenceFailure of [false, true])
    test(
        'latched referenced hold survives reentry and ' +
            (persistenceFailure ? 'failed' : 'durable') +
            ' reporting',
        () => {
            const f = fixture('preparation');
            let current,
                attempts = 0;
            try {
                const held = (state) =>
                    current ??
                    createOwnershipHold(
                        state,
                        (name, data) => {
                            attempts++;
                            assert(current);
                            assert(current.snapshot().referencedHandleCreated);
                            assert.equal(held({ phase: 'reentry' }), current);
                            if (persistenceFailure) throw Error('report unavailable');
                            f.record(name, data);
                        },
                        {
                            interval: () => ({ ref() {} }),
                            onRetained: (h) => {
                                current = h;
                            },
                        },
                    );
                const h = held({ phase: 'known exact hold reason' });
                assert.equal(h, current);
                assert.equal(attempts, 1);
                assert.equal(h.snapshot().recordErrors.length, persistenceFailure ? 1 : 0);
                if (!persistenceFailure) {
                    const r = f.records.at(-1);
                    assert.equal(r.stage, 'ownership-held.json');
                    assert.equal(
                        JSON.parse(fs.readFileSync(r.file)).data.phase,
                        'known exact hold reason',
                    );
                }
            } finally {
                f.close();
            }
        },
    );

test('input-only refusal propagates through PTY validation into actual guarded preparation lease cleanup', async () => {
    const f = fixture('preparation');
    try {
        const lease = new ProductLease(
            path.join(f.tmp, 'owned-marker'),
            { nonce: 'fixture' },
            { ownerCheck: f.ownerCheck },
        );
        lease.acquire();
        fs.writeFileSync(path.join(f.pty, 'pilot.jsonl'), '');
        for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(f.pty, 'evidence-' + i), 'x');
        f.setFault('refusal', 2);
        let error;
        const holds = [];
        try {
            preserveObservationPty(
                f.pty,
                {},
                {
                    sourceRoot,
                    host: {},
                    canonicalTemp: f.tmp,
                    ownerCheck: f.ownerCheck,
                    hold: (s) => holds.push(s),
                },
            );
        } catch (e) {
            error = e;
        }
        assert(closedObservationSecurityRefusal(error));
        assert.equal(holds.length, 0);
        assert(fs.existsSync(lease.file));
        const result = await refuseObservationPreparation(error, {
            lease,
            verifySource: async () => true,
            check() {},
            record: f.record,
            resourceStates: () => ({ electron: 'not-started', runtime: 'not-started' }),
            evidenceComplete: () => true,
        });
        assert(result.released);
        assert(!fs.existsSync(lease.file));
        const refused = f.records.find((r) => r.stage === 'preparation-refused');
        assert(refused);
        assert(refused.data.securityRefusal.processClosed);
        assert(refused.data.releasePending);
    } finally {
        f.close();
    }
});
for (const fault of [
    'touched-refusal',
    'refusal-schema',
    'refusal-principal',
    'malformed',
    'principal',
])
    test('PTY ' + fault + ' cannot use input-only cleanup classification', () => {
        const f = fixture('preparation');
        try {
            const lease = new ProductLease(path.join(f.tmp, 'owned-marker'), { nonce: 'fixture' });
            lease.acquire();
            fs.writeFileSync(path.join(f.pty, 'pilot.jsonl'), '');
            f.setFault(fault, 1);
            let retained;
            assert.throws(() =>
                preserveObservationPty(
                    f.pty,
                    {},
                    {
                        sourceRoot,
                        host: {},
                        canonicalTemp: f.tmp,
                        ownerCheck: f.ownerCheck,
                        hold: (s) => {
                            retained = f.retainOwnership(s, f.record);
                        },
                    },
                ),
            );
            assert(retained.snapshot().referencedHandleCreated);
            assert(fs.existsSync(lease.file));
        } finally {
            f.close();
        }
    });
