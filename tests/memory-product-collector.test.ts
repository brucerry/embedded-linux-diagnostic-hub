// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { collectProductPreparation, limits } from '../scripts/lib/product-collector-controller.mjs';
import {
    boundedRead,
    writeAll,
    closeEntries,
    streamCollector,
    digest,
    readDurableArtifacts,
} from '../scripts/lib/product-collector-evidence.mjs';
import {
    ProductLease,
    RootGuard,
    ProductJournal,
} from '../scripts/lib/product-collector-files.mjs';
import { inspectProductRaw } from '../scripts/lib/product-collector-inspection.mjs';
import { observeCollector } from '../scripts/lib/product-collector-observer.mjs';
class Clock {
    time = 0;
    serial = 0;
    timers = new Map();
    now = () => this.time;
    set = (fn, ms) => {
        const id = ++this.serial;
        this.timers.set(id, { fn, at: this.time + ms });
        return id;
    };
    clear = (id) => this.timers.delete(id);
    advance(ms) {
        const target = this.time + ms;
        for (;;) {
            const next = [...this.timers]
                .filter(([, v]) => v.at <= target)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!next) break;
            this.time = next[1].at;
            this.timers.delete(next[0]);
            next[1].fn();
        }
        this.time = target;
    }
}
class Child extends EventEmitter {
    pid = 123;
    connected = true;
    sends = [];
    kills = [];
    send(value, cb) {
        this.sends.push(value);
        if (this.sendThrows) throw Error('send throw');
        cb?.(this.sendError ?? null);
    }
    kill(sig) {
        this.kills.push(sig);
        throw Error('middle owner must never be killed');
    }
    finish(code = 0) {
        this.emit('exit', code, null);
        this.emit('close', code, null);
    }
}
const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};
const manifest = () => ({
    sourceSHA256: 'a'.repeat(64),
    collectorSHA256: 'b'.repeat(64),
    jobs: [0, 1].map((ordinal) => ({
        ordinal,
        observerMode: ordinal === 0 ? 'sampled' : 'no-sampler',
        gcMode: 'normal',
        expectedParentCode: 0,
    })),
});
function harness(options = {}) {
    const clock = new Clock(),
        events = new EventEmitter(),
        children = [],
        records = new Map(),
        order = [];
    let owned = false,
        released = false,
        closed = false,
        durable = true,
        summary = false;
    const ports = {
        owner: { fixtureOnly: true },
        manifestSHA256: 'c'.repeat(64),
        async verify(stage) {
            order.push(stage);
            if (options.verify) await options.verify(stage, { clock, events });
        },
        record(name, v) {
            order.push(name);
            if (options.recordFailure === name) {
                durable = false;
                throw Error('record failed');
            }
            assert(!records.has(name));
            records.set(name, structuredClone(v));
        },
        journal: {
            append(event, v) {
                order.push(event);
                if (options.journalFailure === event) {
                    durable = false;
                    throw Error('journal failure');
                }
            },
            close() {
                closed = true;
                if (options.journalCloseFailure) throw Error('journal close failure');
            },
            proof: () => closed && !options.journalCloseFailure,
        },
        evidenceComplete: () => durable,
        holdUnknown: async (value) => ({ ...value, modelHoldObserved: true }),
        lease: {
            acquire() {
                if (options.foreign) throw Error('foreign marker');
                owned = true;
            },
            check() {
                if (options.leaseDrift) throw Error('lease drift');
            },
            release(proof) {
                assert(Object.values(proof).every(Boolean));
                assert(closed);
                assert(records.has('result-before-release.json'));
                released = true;
                order.push('release');
            },
            state: () => ({
                created: owned,
                retained: owned && !released,
                identityConfirmed: owned,
            }),
        },
        begin(spec, admit, onFailure) {
            const job = admit(),
                child = new Child();
            child.pid += spec.ordinal;
            children.push(child);
            order.push('begin-' + spec.ordinal);
            queueMicrotask(() => {
                child.emit('spawn');
                if (options.start) options.start(child, spec, { clock, events, onFailure, ports });
                else child.finish(spec.expectedParentCode);
            });
            return {
                child,
                job,
                argv: ['fixture-only'],
                cwd: '/fixture-only',
                setup() {
                    if (options.setupFailure) throw Error('post-spawn setup failure');
                },
                cancel(reason) {
                    child.send({ kind: 'cancel-product-job', nonce: job.nonce, reason });
                },
                closeLogs: () => ({ complete: !options.logFailure }),
                async inspect(actualOutcome) {
                    if (options.inspect) return await options.inspect({ spec, job, actualOutcome });
                    return {
                        valid: !options.invalid,
                        ownershipComplete: !options.unknownLeaf,
                        error: options.invalid ? 'invalid fixture' : null,
                    };
                },
            };
        },
        summary() {
            summary = true;
            order.push('summary');
        },
    };
    return {
        clock,
        events,
        children,
        records,
        order,
        ports,
        state: () => ({ owned, released, summary }),
    };
}
async function run(options = {}) {
    const h = harness(options);
    const result = await collectProductPreparation(manifest(), h.ports, {
        clock: h.clock,
        events: h.events,
        supervisorNonce: 'fixture-nonce',
    });
    return { ...h, result };
}

test('2 ordered parents persist closure before next admission and release only after result', async () => {
    const h = await run();
    assert.equal(h.result.status, 'COLLECTED_UNREVIEWED_WINDOWS_PAIR');
    assert.equal(h.result.policyReviewed, false);
    assert.equal(h.result.thresholdsSelected, false);
    assert.equal(h.children.length, 2);
    assert(h.state().released && h.state().summary);
    for (let i = 0; i < 1; i++)
        assert(h.order.indexOf(`parent-${i}-closure.json`) < h.order.indexOf('begin-' + (i + 1)));
    assert(h.order.indexOf('result-before-release.json') < h.order.indexOf('release'));
    assert(h.order.indexOf('release') < h.order.indexOf('marker-release.json'));

    assert(h.children.every((c) => c.kills.length === 0));
    assert.equal(h.events.listenerCount('SIGTERM'), 0);
});
test('known closed invalid measurement stops at first parent and may release safely', async () => {
    const h = await run({ invalid: true });
    assert.equal(h.children.length, 1);
    assert(h.state().released);
    assert(!h.state().summary);
    assert.match(h.result.status, /INVALID/);
});
test('missing leaf closure stops admission and retains own lease', async () => {
    const h = await run({ unknownLeaf: true });
    assert.equal(h.children.length, 1);
    assert(!h.state().released);
    assert(h.result.leaseRetained);
    assert(h.result.modelHoldObserved);
});
for (const name of ['foreign', 'leaseDrift'])
    test(name + ' admits no child', async () => {
        const h = await run({ [name]: true });
        assert.equal(h.children.length, 0);
        assert(!h.state().released || name === 'leaseDrift');
        assert.match(h.result.status, /INVALID/);
    });
for (const [label, options] of Object.entries({
    journal: { journalFailure: 'parent-admitted' },
    record: { recordFailure: 'parent-0-admission.json' },
    spawnRecord: { recordFailure: 'parent-0-spawn.json' },
    journalClose: { journalCloseFailure: true },
    log: { logFailure: true },
    postSpawnSetup: { setupFailure: true },
}))
    test(label + ' failure joins actual child, stops next admission and invalidates', async () => {
        const h = await run(options);
        assert(h.children.length <= 1 || label === 'journalClose');
        assert.match(h.result.status, /INVALID/);
        assert(h.children.every((c) => c.kills.length === 0));
        assert(
            h.children.every(
                (c) =>
                    h.records.get(`parent-${c.pid - 123}-closure.json`)?.actualOutcome
                        .closeObserved,
            ),
        );
        if (['journal', 'record', 'spawnRecord', 'journalClose'].includes(label))
            assert(!h.state().released);
    });
test('exit without close remains attached; deadline stays invalid after late close', async () => {
    const h = harness({
        start(child) {
            child.emit('exit', 0, null);
        },
    });
    let settled = false;
    const p = collectProductPreparation(manifest(), h.ports, {
        clock: h.clock,
        events: h.events,
    }).then((v) => {
        settled = true;
        return v;
    });
    await flush();
    assert(!settled);
    h.clock.advance(2400000);
    await flush();
    assert(!settled);
    assert(h.records.has('parent-0-deadline.json'));
    assert(h.children[0].sends.length === 1);
    assert(h.children[0].kills.length === 0);
    assert(h.state().owned && !h.state().released);
    h.children[0].emit('close', 0, null);
    const result = await p;
    assert.match(result.status, /INVALID/);
    assert.equal(h.records.get('parent-0-closure.json').deadlineOutcome.closeObserved, false);
    assert.equal(h.records.get('parent-0-closure.json').actualOutcome.closeObserved, true);
});
for (const event of ['SIGTERM', 'SIGINT', 'disconnect', 'message'])
    test(event + ' cancels current owner without killing or admitting next', async () => {
        const h = harness({
            start(child, _spec, { events }) {
                events.emit(
                    event,
                    event === 'message'
                        ? {
                              kind: 'cancel-product-collection',
                              nonce: 'fixture-nonce',
                              reason: 'cancel fixture',
                          }
                        : undefined,
                );
                child.finish(1);
            },
        });
        const result = await collectProductPreparation(manifest(), h.ports, {
            clock: h.clock,
            events: h.events,
            supervisorNonce: 'fixture-nonce',
        });
        assert.match(result.status, /INVALID/);
        assert.equal(h.children.length, 1);
        assert(h.children[0].sends.length === 1);
        assert.equal(h.children[0].kills.length, 0);
    });
for (const fault of ['sendThrows', 'sendError', 'disconnected'])
    test(fault + ' forwarding failure never kills middle owner', async () => {
        const h = harness({
            start(child, _spec, { events }) {
                if (fault === 'disconnected') child.connected = false;
                else child[fault] = fault === 'sendError' ? Error('async send callback') : true;
                events.emit('SIGINT');
                child.finish(1);
            },
        });
        const r = await collectProductPreparation(manifest(), h.ports, {
            clock: h.clock,
            events: h.events,
        });
        assert.match(r.status, /INVALID/);
        assert.equal(h.children.length, 1);
        assert.equal(h.children[0].kills.length, 0);
    });
test('cancel between preflight and admission refuses all parents', async () => {
    const h = await run({
        verify(stage, { events }) {
            if (stage === 'before-parent-0') events.emit('SIGINT');
        },
    });
    assert.equal(h.children.length, 0);
});
test('short writes preserve every byte and independent sync/close failures attempt every handle', () => {
    const got = [];
    writeAll(1, Buffer.from('abcdef'), {
        writeSync(_fd, b, o, n) {
            const k = Math.min(n, 2);
            got.push(b.subarray(o, o + k));
            return k;
        },
    });
    assert.equal(Buffer.concat(got).toString(), 'abcdef');
    assert.throws(() => writeAll(1, Buffer.from('a'), { writeSync: () => 0 }));
    for (const syncFailure of [1, 2])
        for (const closeFailure of [1, 2]) {
            const calls = [],
                entries = [1, 2].map((fd) => ({ fd, errors: [] }));
            const proof = closeEntries(entries, {
                fsyncSync(fd) {
                    calls.push('s' + fd);
                    if (fd === syncFailure) throw Error('sync');
                },
                closeSync(fd) {
                    calls.push('c' + fd);
                    if (fd === closeFailure) throw Error('close');
                },
            });
            assert(!proof.complete);
            assert.deepEqual(calls, ['s1', 'c1', 's2', 'c2']);
            closeEntries(entries, {
                fsyncSync() {
                    throw Error('repeat');
                },
            });
        }
});
test('stream overflow keeps draining/counting/full hash with bounded retained prefix', () => {
    const written = [],
        errors = [];
    const s = streamCollector(1, {
        max: 4,
        io: {
            writeSync(_fd, b, o, n) {
                written.push(b.subarray(o, o + n));
                return n;
            },
        },
        onFailure: (e) => errors.push(e),
    });
    for (const b of ['abc', 'de', 'tail']) s.write(Buffer.from(b));
    const p = s.snapshot();
    assert.equal(p.attempted, 9);
    assert.equal(p.written, 3);
    assert.equal(p.fullStreamSHA256, digest('abcdetail'));
    assert.equal(p.retainedAcknowledgedSHA256, digest('abc'));
    assert(p.truncated);
    assert.equal(errors.length, 1);
});
test('partial stream write retains acknowledged prefix and continues drain after error', () => {
    let first = true;
    const s = streamCollector(1, {
        io: {
            writeSync() {
                if (first) {
                    first = false;
                    return 2;
                }
                throw Error('write failed');
            },
        },
    });
    s.write(Buffer.from('abcd'));
    s.write(Buffer.from('ef'));
    const p = s.snapshot();
    assert.equal(p.written, 2);
    assert.equal(p.attempted, 6);
    assert.equal(p.retainedAcknowledgedSHA256, digest('ab'));
    assert(p.failed);
});
const scratch = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'collector-unit-'));
test('bounded reader refuses oversized/link/rebound/growing evidence without unbounded allocation', () => {
    const root = scratch(),
        p = path.join(root, 'raw');
    try {
        fs.writeFileSync(p, 'abc');
        assert.equal(boundedRead(p, 3).toString(), 'abc');
        assert.throws(() => boundedRead(p, 2));
        fs.symlinkSync(p, path.join(root, 'alias'));
        assert.throws(() => boundedRead(path.join(root, 'alias'), 3));
        const io = {
            ...fs,
            fstatSync(fd) {
                return { ...fs.fstatSync(fd), isFile: () => true, ino: 0 };
            },
        };
        assert.throws(() => boundedRead(p, 3, io));
        let reads = 0;
        assert.throws(() =>
            boundedRead(p, 3, {
                ...fs,
                readSync(fd, b, o, n, pos) {
                    reads++;
                    if (reads === 1) fs.appendFileSync(p, 'extra');
                    return fs.readSync(fd, b, o, n, pos);
                },
            }),
        );
        assert(reads <= 2);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
const releaseProof = () =>
    Object.fromEntries(
        [
            'admissionCertain',
            'directParentsClosed',
            'evidenceClosed',
            'inputsUnchanged',
            'leafReceiptsClosed',
            'resultClosed',
        ].map((k) => [k, true]),
    );
test('lease create-only foreign marker and partial marker write cannot admit or unlink', () => {
    const root = scratch(),
        file = path.join(root, 'lease'),
        owner = { pid: process.pid, nonce: 'fixture', root };
    try {
        fs.writeFileSync(file, 'foreign');
        const foreign = new ProductLease(file, owner);
        assert.throws(() => foreign.acquire());
        assert.equal(foreign.created, false);
        assert.throws(() => foreign.release(releaseProof()));
        assert.equal(fs.readFileSync(file, 'utf8'), 'foreign');
        fs.unlinkSync(file);
        let closed = false;
        const partial = new ProductLease(file, owner, {
            io: {
                ...fs,
                writeSync: () => 0,
                closeSync(fd) {
                    closed = true;
                    fs.closeSync(fd);
                },
            },
        });
        assert.throws(() => partial.acquire());
        assert(closed && partial.created && !partial.identity);
        assert.throws(() => partial.release(releaseProof()));
        assert(fs.existsSync(file));
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('lease exact body/inode/UID drift refuses unlink; complete own lease may release', () => {
    for (const mutation of ['body', 'whitespace', 'hardlink', 'inode', 'uid', 'none']) {
        const root = scratch(),
            file = path.join(root, 'lease'),
            owner = { pid: process.pid, nonce: 'fixture', root };
        try {
            const lease = new ProductLease(file, owner);
            lease.acquire();
            if (mutation === 'body') fs.writeFileSync(file, '{}');
            if (mutation === 'whitespace') fs.appendFileSync(file, ' ');
            if (mutation === 'hardlink') fs.linkSync(file, path.join(root, 'alias'));
            if (mutation === 'inode') {
                fs.renameSync(file, path.join(root, 'retained'));
                fs.writeFileSync(file, JSON.stringify(owner));
            }
            if (mutation === 'uid') lease.identity += '/drift';
            if (mutation === 'none') {
                lease.release(releaseProof());
                assert(!fs.existsSync(file));
            } else {
                assert.throws(() => lease.release(releaseProof()));
                assert(fs.existsSync(file));
            }
        } finally {
            fs.rmSync(root, { recursive: true });
        }
    }
});

test('second job shares the cohort deadline; no time extension or third admission', async () => {
    const h = await run({
        verify(stage, { clock }) {
            if (stage === 'before-parent-1') clock.time = limits.jobMs + 1000;
        },
    });
    const job = h.records.get('parent-1-admission.json').job;
    assert.equal(job.deadlineMs, limits.cohortMs);
    assert.equal(job.budgetMs, limits.jobMs);
    assert.equal(h.children.length, 2);
    for (const mutate of [
        (m) => m.jobs.push(m.jobs[0]),
        (m) => (m.jobs[0].gcMode = 'forced'),
        (m) => m.jobs.reverse(),
    ]) {
        const m = manifest(),
            f = harness();
        mutate(m);
        await assert.rejects(
            collectProductPreparation(m, f.ports, { clock: f.clock, events: f.events }),
        );
        assert.equal(f.children.length, 0);
    }
});
test('insufficient remaining workload/reserve and expired cohort admit no child', async () => {
    for (const remaining of [1859999, 0]) {
        const h = await run({
            verify(stage, { clock }) {
                if (stage === 'before-parent-0') clock.time = limits.cohortMs - remaining;
            },
        });
        assert.equal(h.children.length, 0);
        assert.match(h.result.status, /INVALID/);
    }
});
test('raw fsync/close failures are independent and prevent durable acceptance', () => {
    const root = scratch();
    try {
        const file = path.join(root, 'raw');
        fs.writeFileSync(file, 'abc');
        let closes = 0;
        const result = readDurableArtifacts([{ name: 'raw', path: file, max: 3 }], {
            io: {
                ...fs,
                fsyncSync() {
                    throw Error('sync injected');
                },
                closeSync(fd) {
                    closes++;
                    fs.closeSync(fd);
                },
            },
        });
        assert.equal(result.raw.raw.toString(), 'abc');
        assert.equal(result.durability.complete, false);
        assert.equal(closes, 1);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('journal bound refuses before write; root rebinding refuses subsequent records', () => {
    const root = scratch();
    try {
        const guard = new RootGuard(root),
            journal = new ProductJournal(guard, path.join(root, 'journal'));
        journal.append('small', {});
        const before = fs.statSync(path.join(root, 'journal')).size;
        assert.throws(() => journal.append('oversize', 'x'.repeat(65536)));
        assert.equal(fs.statSync(path.join(root, 'journal')).size, before);
        assert.throws(() => journal.close());
        assert.equal(journal.proof(), false);
        const child = guard.mkdir('bound');
        fs.renameSync(child, path.join(root, 'old'));
        fs.mkdirSync(child);
        assert.throws(() => guard.write('record', 'x'));
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('outer exit alone stays attached and cancels by IPC at the immutable cohort deadline', async () => {
    const clock = new Clock(),
        events = new EventEmitter(),
        child = new Child();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const records = [];
    let settled = false;
    const outcome = observeCollector(child, {
        clock,
        events,
        nonce: 'fixture',
        record: (name, row) => records.push({ name, row }),
    }).then((r) => {
        settled = true;
        return r;
    });
    child.emit('spawn');
    child.emit('exit', 0, null);
    await flush();
    assert.equal(settled, false);
    clock.advance(limits.cohortMs);
    await flush();
    assert.equal(settled, false);
    assert.equal(child.sends[0].kind, 'cancel-product-collection');
    assert.equal(child.kills.length, 0);
    child.emit('close', 0, null);
    const r = await outcome;
    assert.equal(r.timedOut, true);
    assert.equal(r.exitObserved, true);
    assert.equal(r.closeObserved, true);
    assert.equal(r.middleOwnerKillAttempted, false);
});
test('incomplete raw native receipt never creates a product or ownership pass', () => {
    for (const raw of [
        {},
        {
            timeline: Buffer.from(
                '{"stage":"receipt","data":{"status":"collected-product-calibration-evidence"}}\n',
            ),
        },
        { timeline: Buffer.from('partial') },
    ]) {
        const result = inspectProductRaw(raw, {
            parentLifecycle: {
                spawnObserved: true,
                exitObserved: true,
                closeObserved: true,
                code: 0,
                closeCode: 0,
                signal: null,
                closeSignal: null,
            },
        });
        assert.equal(result.valid, false);
        assert.equal(result.ownershipComplete, false);
    }
});

function productRawModel() {
    const sourceSHA256 = 'a'.repeat(64),
        adapterSHA256 = 'b'.repeat(64),
        contractSHA256 = 'c'.repeat(64),
        job = { model: 'shared-job' },
        parentLifecycle = {
            spawnObserved: true,
            exitObserved: true,
            closeObserved: true,
            code: 0,
            closeCode: 0,
            signal: null,
            closeSignal: null,
        };
    const identities = [
        {
            pid: 10,
            created: 'harness-instance',
            role: 'qualification-harness',
            state: 'running',
            heapUsedBytes: 1,
            arrayBuffersBytes: 1,
            externalBytes: 1,
            rssBytes: 1,
        },
        {
            pid: 20,
            created: 'native-instance',
            role: 'native-main',
            state: 'terminated',
            heapUsedBytes: null,
            arrayBuffersBytes: null,
            externalBytes: null,
            rssBytes: null,
        },
    ];
    const native = {
        snapshot: {
            sshHasResources: false,
            consoleHasResources: false,
            activity: { lease: false },
            capture: {
                owners: { writer: 0, reader: 0, pin: 0, export: 0, rpc: 0, cleanup: 0 },
                services: { rpcTimer: false, storeOpen: false, catalogOpen: false },
                cache: { completed: 0, expiredPins: 0 },
            },
            versions: { electron: '44.5.1' },
        },
        downloads: [],
    };
    const context = {
        config: { requirements: { coverage: ['native-reset', 'export-cancel', 'export-failure'] } },
        scope: {
            runtimeIdentity: {
                main: {
                    executableSHA256: 'd'.repeat(64),
                    launch: { harness: { platform: 'win32' } },
                },
            },
        },
    };
    const receipt = {
        status: 'collected-product-calibration-evidence',
        failure: null,
        sourceSHA256,
        adapterHash: adapterSHA256,
        gcMode: 'normal',
        lane: 'desktop',
        achievedWarmupMs: 300000,
        achievedMeasuredMs: 1500000,
        cycles: 100,
        missing: [],
        coverage: ['native-reset', 'export-cancel', 'export-failure'],
        policySHA256: null,
        memory: { status: 'unreviewed-product-calibration', thresholdsSelected: false },
        assessmentIdentity: digest(JSON.stringify(context)),
    };
    const rows = [
        {
            stage: 'identity',
            data: {
                sourceSHA256,
                adapterHash: adapterSHA256,
                productJob: job,
                nativeCoverage: { sha256: contractSHA256 },
                observer: 'serialized-250ms-target',
            },
        },
        { stage: 'shutdown-processes', data: { phase: 'final-joined', processes: identities } },
        {
            stage: 'owners',
            data: { stage: 'full-teardown', counts: { writer: 0, reader: 0, pin: 0, export: 0 } },
        },
        { stage: 'native-actual-exit', data: { code: 0, signal: null } },
        { stage: 'native-actual-close', data: { code: 0, signal: null } },
        { stage: 'native-will-quit', data: native },
        { stage: 'assessment-context', data: { context } },
        { stage: 'receipt', data: receipt },
    ];
    return {
        rows,
        native,
        binding: {
            sourceSHA256,
            adapterSHA256,
            contractSHA256,
            job,
            parentLifecycle,
            noSampler: false,
        },
        raw() {
            return {
                timeline: Buffer.from(rows.map((r) => JSON.stringify(r) + '\n').join('')),
                nativeExit: Buffer.from(JSON.stringify(native)),
            };
        },
    };
}
test('complete modeled native collection is explicitly unreviewed; missing ownership and false numerical claims reject', () => {
    const f = productRawModel(),
        ok = inspectProductRaw(f.raw(), f.binding);
    assert.equal(ok.valid, true);
    assert.equal(ok.ownershipComplete, true);
    assert.equal(ok.policyQualified, false);
    for (const mutate of [
        (f) =>
            f.rows.splice(
                f.rows.findIndex((r) => r.stage === 'native-actual-close'),
                1,
            ),
        (f) => (f.rows.find((r) => r.stage === 'owners').data.counts.pin = 1),
        (f) => (f.native.snapshot.capture.services.storeOpen = true),
        (f) =>
            (f.rows.find((r) => r.stage === 'shutdown-processes').data.processes[1].state =
                'running'),
        (f) => (f.rows.find((r) => r.stage === 'identity').data.sourceSHA256 = 'f'.repeat(64)),
        (f) => (f.rows.find((r) => r.stage === 'receipt').data.cycles = 99),
        (f) => f.rows.find((r) => r.stage === 'receipt').data.coverage.pop(),
        (f) => (f.rows.find((r) => r.stage === 'receipt').data.policySHA256 = 'f'.repeat(64)),
    ]) {
        const bad = productRawModel();
        mutate(bad);
        assert.equal(inspectProductRaw(bad.raw(), bad.binding).valid, false);
    }
});
