// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import {
    CollectionEntry,
    collectionCohort,
    prepareProductSpawn,
    prepareProductLogs,
    createOwnershipHold,
} from '../scripts/lib/product-entry-custody.mjs';
import { closeEntries } from '../scripts/lib/product-collector-evidence.mjs';
import { collectProductPreparation, limits } from '../scripts/lib/product-collector-controller.mjs';
import { runCollector, runOuter } from '../scripts/memory-product-collect.mts';
import { ptyBridgeArguments, installedPtyIdentity } from './fixtures/winpty-identity';
const nonce = '11111111-1111-4111-8111-111111111111';
const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};
function model() {
    const events = new EventEmitter();
    events.connected = true;
    let disconnects = 0;
    events.disconnect = () => {
        disconnects++;
    };
    const clock = {
        time: 0,
        timers: new Set(),
        now() {
            return this.time;
        },
        set(fn) {
            this.timers.add(fn);
            return fn;
        },
        clear(fn) {
            this.timers.delete(fn);
        },
    };
    return {
        events,
        clock,
        disconnects: () => disconnects,
        cohort: JSON.stringify({ schema: 1, nonce, startedAt: 0, deadlineMs: limits.cohortMs }),
    };
}
for (const event of ['SIGTERM', 'SIGINT', 'disconnect', 'message'])
    test(`actual collector entry retains ${event} through held verification and admits no preparation`, async () => {
        const f = model();
        let release,
            prepared = 0,
            verified = 0;
        const gate = new Promise((resolve) => (release = resolve));
        const result = runCollector({}, 'hash', nonce, f.cohort, {
            events: f.events,
            clock: f.clock,
            verify: () => {
                verified++;
                return gate;
            },
            prepare: () => {
                prepared++;
                throw Error('unexpected prepare');
            },
        });
        const rejection = assert.rejects(result, /Entry|cancel|disconnect|SIG/);
        await flush();
        assert.equal(verified, 1);
        assert(f.events.listenerCount(event) > 0);
        if (event === 'disconnect') f.events.connected = false;
        f.events.emit(event, {
            kind: 'cancel-product-collection',
            nonce,
            reason: 'cancel during actual entry verification',
        });
        release();
        await rejection;
        assert.equal(prepared, 0);
        assert.equal(f.disconnects(), 0);
        assert.equal(f.clock.timers.size, 0);
        assert.equal(f.events.listenerCount('message'), 0);
    });
test('already-disconnected entry rejects before verification; missing shared cohort never resets its budget', async () => {
    const f = model();
    f.events.connected = false;
    let verified = 0;
    await assert.rejects(
        runCollector({}, 'hash', nonce, f.cohort, {
            ...f,
            verify: () => {
                verified++;
            },
        }),
        /IPC/,
    );
    assert.equal(verified, 0);
    assert.equal(f.clock.timers.size, 0);
    await assert.rejects(
        runCollector({}, 'hash', nonce, undefined, {
            ...f,
            verify: () => {
                verified++;
            },
        }),
        /existing outer cohort/,
    );
    assert.equal(verified, 0);
    assert.equal(f.events.listenerCount('SIGINT'), 0);
});
test('actual outer entry cancellation during verification cannot reach output preparation', async () => {
    const f = model();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const outcome = runOuter({ outputRoot: '/must-not-be-read' }, 'hash', '/must-not-be-read', {
        events: f.events,
        clock: f.clock,
        verify: () => gate,
    });
    const rejected = assert.rejects(outcome, /SIGINT/);
    await flush();
    assert.equal(f.events.listenerCount('SIGINT'), 1);
    f.events.emit('SIGINT');
    release();
    await rejected;
    assert.equal(f.clock.timers.size, 0);
});
test('one captured monotonic start survives verification/inner handoff and cannot be extended', () => {
    const f = model();
    const raw = collectionCohort(undefined, nonce, f.clock);
    f.clock.time = 12345;
    const inner = new CollectionEntry({
        nonce,
        cohort: JSON.stringify(raw),
        events: f.events,
        clock: f.clock,
        requireIPC: true,
        requireCohort: true,
    });
    assert.equal(inner.cohort.deadlineMs, limits.cohortMs);
    assert.equal(inner.cohort.startedAt, 0);
    f.clock.time = limits.cohortMs;
    assert.throws(() => inner.assertAdmissible(), /deadline/);
    inner.dispose({ closed: true });
    let now = 0;
    const advancing = { now: () => now++ };
    assert.equal(collectionCohort(undefined, nonce, advancing).deadlineMs, limits.cohortMs);
});
for (const stage of ['directory', 'logs', 'command', 'options', 'deadline', 'final-exception'])
    test(`real spawn preparation refuses ${stage} cancellation/expiry and independently closes every prepared log`, () => {
        const f = model(),
            entry = new CollectionEntry({
                nonce,
                cohort: f.cohort,
                events: f.events,
                clock: f.clock,
                requireIPC: true,
            }),
            root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-spawn-control-'));
        let spawns = 0,
            allocations = 0,
            opened = [];
        const job = Object.freeze({ deadlineMs: 2400000, reserveMs: 60000 });
        const affect = (where) => {
            if (stage === where) entry.cancel('cancel during ' + where);
            if (stage === 'deadline' && where === 'options') f.clock.time = 2340000;
        };
        try {
            assert.throws(
                () =>
                    prepareProductSpawn(
                        {},
                        () => {
                            allocations++;
                            return job;
                        },
                        (j) => {
                            if (stage === 'final-exception') throw Error('final-check exception');
                            entry.assertAdmissible(j);
                        },
                        {
                            directory() {
                                affect('directory');
                                return root;
                            },
                            logs() {
                                opened = ['a', 'b'].map((name) => ({
                                    fd: fs.openSync(path.join(root, name), 'wx'),
                                    errors: [],
                                    attempted: false,
                                }));
                                affect('logs');
                                return opened;
                            },
                            command() {
                                affect('command');
                                return ['never-start'];
                            },
                            options() {
                                affect('options');
                                return {};
                            },
                            spawn() {
                                spawns++;
                                return new EventEmitter();
                            },
                        },
                    ),
                (error) => {
                    assert.equal(error.noChildStarted, true);
                    assert.equal(error.fdClosure.complete, true);
                    return true;
                },
            );
            assert.equal(spawns, 0);
            assert.equal(allocations, 1);
            assert(opened.every((e) => e.synced && e.closed));
        } finally {
            entry.dispose({ closed: true });
            fs.rmSync(root, { recursive: true });
        }
    });
test('successful model spawn uses the same job and puts final admission adjacent to spawn', () => {
    const f = model(),
        entry = new CollectionEntry({ nonce, cohort: f.cohort, events: f.events, clock: f.clock }),
        order = [],
        job = Object.freeze({ deadlineMs: 2400000, reserveMs: 60000 });
    const result = prepareProductSpawn(
        {},
        () => {
            order.push('allocate');
            return job;
        },
        (j) => {
            entry.assertAdmissible(j);
            order.push('final-admission');
        },
        {
            directory: () => {
                order.push('directory');
                return '/model';
            },
            logs: () => [],
            command: () => {
                order.push('command');
                return [];
            },
            options: () => {
                order.push('options');
                return {};
            },
            spawn: () => {
                order.push('spawn');
                return new EventEmitter();
            },
        },
    );
    assert.equal(result.job, job);
    assert.deepEqual(order.slice(-2), ['final-admission', 'spawn']);
    entry.dispose({ closed: true });
});
for (const error of ['disk-full', 'path-drift', 'sync-failure', 'close-failure'])
    test(`hold ${error} persistence failure cannot escape referenced custody or retire entry handlers`, async () => {
        const f = model(),
            entry = new CollectionEntry({
                nonce,
                cohort: f.cohort,
                events: f.events,
                clock: f.clock,
            }),
            order = [];
        const hold = createOwnershipHold(
            { unknown: true },
            () => {
                order.push('record');
                throw Error(error);
            },
            {
                interval: () => {
                    order.push('handle');
                    return { ref: () => order.push('ref') };
                },
            },
        );
        let resolved = false,
            rejected = false;
        void hold.outcome.then(
            () => (resolved = true),
            () => (rejected = true),
        );
        await flush();
        assert.deepEqual(order, ['handle', 'ref', 'record']);
        assert.equal(hold.snapshot().referencedHandleCreated, true);
        assert.match(hold.snapshot().recordErrors[0], new RegExp(error));
        assert.equal(resolved, false);
        assert.equal(rejected, false);
        assert.equal(f.disconnects(), 0);
        assert.equal(f.events.listenerCount('message'), 1);
        assert.equal(entry.disposed, false);
        entry.dispose({ closed: true });
    });
test('controller handoff retains a previously observed cancellation and admits zero parents', async () => {
    const f = model(),
        entry = new CollectionEntry({ nonce, cohort: f.cohort, events: f.events, clock: f.clock });
    entry.cancel('cancel before controller handoff');
    let admits = 0;
    const result = await collectProductPreparation(
        {
            jobs: [0, 1].map((ordinal) => ({
                ordinal,
                observerMode: ordinal ? 'no-sampler' : 'sampled',
                gcMode: 'normal',
                expectedParentCode: 0,
            })),
        },
        {
            owner: {},
            manifestSHA256: 'x',
            verify: async () => {},
            record: () => {},
            evidenceComplete: () => true,
            journal: { append() {}, close() {}, proof: () => true },
            lease: {
                acquire() {
                    throw Error('cannot acquire after cancellation');
                },
                state: () => ({ created: false, retained: false, identityConfirmed: false }),
            },
            begin() {
                admits++;
            },
            holdUnknown: async (state) => state,
        },
        { entry, clock: f.clock, events: f.events, supervisorNonce: nonce },
    );
    assert.equal(admits, 0);
    assert.match(result.status, /INVALID/);
    entry.dispose({ closed: true });
});
test('collection CLI is unreachable while later-host approval remains unresolved', () => {
    const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/memory-product-collect.mts', '--collect=1'],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Collection disabled/);
    assert.equal(result.stdout, '');
});
test('nondefault Bash path is preserved in the exact application, command and PS/C# handoff', () => {
    const bash = 'D:\\Portable Tools\\Git\\usr\\bin\\bash.exe',
        args = ptyBridgeArguments(bash, 'D:\\probe\\bridge.ps1', 'D:\\owned home');
    assert.equal(args[args.indexOf('-BashExecutable') + 1], bash);
    assert.equal(args[args.indexOf('-CommandLine') + 1], '"' + bash + '" --noprofile -i');
    const cs = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/winpty-bridge.cs'), 'utf8'),
        ps = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/winpty-bridge.ps1'), 'utf8');
    assert(cs.includes('winpty_spawn_config_new(3,bashExecutable,commandLine'));
    assert(!cs.includes('C:\\Program Files\\Git'));
    assert(ps.includes('::Run($BashExecutable,$CommandLine'));
    for (const bad of ['relative/bash.exe', 'D:\\bad"name.exe'])
        assert.throws(() => ptyBridgeArguments(bad, 'script', 'home'));
});
test('installed PTY identity hashes/records x64 PE bytes and rejects other architecture without executing', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-pty-identity-'));
    try {
        const file = path.join(root, 'fake.exe'),
            bytes = Buffer.alloc(128);
        bytes.write('MZ');
        bytes.writeUInt32LE(64, 60);
        bytes.writeUInt32LE(0x4550, 64);
        bytes.writeUInt16LE(0x8664, 68);
        fs.writeFileSync(file, bytes);
        const identity = await installedPtyIdentity(file);
        assert.equal(identity.architecture, 'x64');
        assert.match(identity.sha256, /^[a-f0-9]{64}$/);
        bytes.writeUInt16LE(0x14c, 68);
        fs.writeFileSync(file, bytes);
        await assert.rejects(installedPtyIdentity(file), /x64/);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('queued cancellation is delivered after blocking preparation and before deferred real spawn commit', async () => {
    const f = model(),
        entry = new CollectionEntry({ nonce, cohort: f.cohort, events: f.events, clock: f.clock });
    let spawns = 0;
    const prepared = prepareProductSpawn(
        {},
        () => Object.freeze({ deadlineMs: 2400000, reserveMs: 60000 }),
        (job) => entry.assertAdmissible(job),
        {
            deferSpawn: true,
            directory: () => '/model',
            logs: () => [],
            command: () => [],
            options: () => {
                setImmediate(() =>
                    f.events.emit('message', {
                        kind: 'cancel-product-collection',
                        nonce,
                        reason: 'queued during preparation',
                    }),
                );
                return {};
            },
            spawn: () => {
                spawns++;
            },
        },
    );
    assert.equal(spawns, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => prepared.commit(), /queued/);
    assert.equal(spawns, 0);
    entry.dispose({ closed: true });
});

// Real entry/controller/helper, real disposable FDs, modeled lease and hold interval; no child.
for (const stage of [
    'cancellation',
    'expiry',
    'final-exception',
    'partial-logs',
    'command',
    'options',
])
    for (const fault of [null, 'sync', 'close', 'sync-and-close'])
        test(`pre-spawn ${stage} with ${fault ?? 'durable closure'} preserves descriptor custody through actual entry`, async () => {
            const f = model(),
                root = fs.mkdtempSync(
                    path.join(fs.realpathSync(os.tmpdir()), 'hub-admission-custody-'),
                ),
                opened = [],
                records = new Map(),
                order = [];
            let released = false,
                owned = false,
                spawns = 0,
                held = false,
                resolved = false,
                rejected = false,
                custody,
                heldState,
                hold,
                syncAttempts = 0,
                closeAttempts = 0,
                opens = 0,
                observeHold;
            const holdObserved = new Promise((resolve) => {
                observeHold = resolve;
            });
            const io = {
                ...fs,
                openSync(...args) {
                    if (stage === 'partial-logs' && ++opens === 2)
                        throw Error('second log open refused');
                    const fd = fs.openSync(...args);
                    opened.push(fd);
                    return fd;
                },
                fsyncSync(fd) {
                    syncAttempts++;
                    if (fault?.includes('sync')) throw Error('injected real-log sync failure');
                    fs.fsyncSync(fd);
                },
                closeSync(fd) {
                    closeAttempts++;
                    if (fault?.includes('close')) throw Error('injected real-log close failure');
                    fs.closeSync(fd);
                },
            };
            const manifest = {
                sourceSHA256: 'a'.repeat(64),
                jobs: [0, 1].map((ordinal) => ({
                    ordinal,
                    observerMode: ordinal ? 'no-sampler' : 'sampled',
                    gcMode: 'normal',
                    expectedParentCode: 0,
                })),
            };
            const ports = {
                owner: {},
                manifestSHA256: 'c'.repeat(64),
                verify: async () => {},
                record(name, value) {
                    records.set(name, structuredClone(value));
                },
                evidenceComplete: () => true,
                journal: { append() {}, close() {}, proof: () => true },
                lease: {
                    acquire() {
                        owned = true;
                    },
                    check() {},
                    release(proof) {
                        assert(Object.values(proof).every(Boolean));
                        released = true;
                    },
                    state: () => ({
                        retained: owned && !released,
                        created: owned,
                        identityConfirmed: owned,
                    }),
                },
                async prepare(spec, allocate, _failure, finalAdmission) {
                    return prepareProductSpawn(
                        spec,
                        allocate,
                        (job) => {
                            if (stage === 'final-exception')
                                throw Error('final-admission exception');
                            finalAdmission(job);
                        },
                        {
                            deferSpawn: true,
                            io,
                            directory: () => root,
                            logs: () =>
                                prepareProductLogs({ root, check() {} }, ['stdout', 'stderr'], io),
                            command() {
                                if (stage === 'command') throw Error('command refusal');
                                return [];
                            },
                            options() {
                                if (stage === 'options') throw Error('options refusal');
                                if (stage === 'cancellation') f.events.emit('SIGINT');
                                if (stage === 'expiry') f.clock.time = 2340000;
                                return {};
                            },
                            spawn() {
                                spawns++;
                                throw Error('must not spawn');
                            },
                        },
                    );
                },
                begin(_spec, _allocate, _failure, _final, prepared) {
                    return prepared.commit();
                },
                holdUnknown(state) {
                    held = true;
                    heldState = state;
                    hold = createOwnershipHold(state, ports.record, {
                        interval: () => {
                            order.push('handle');
                            return { ref: () => order.push('ref') };
                        },
                    });
                    observeHold();
                    return hold.outcome;
                },
            };
            const outcome = runCollector(manifest, ports.manifestSHA256, nonce, f.cohort, {
                events: f.events,
                clock: f.clock,
                verify: async () => {},
                prepare(_m, _hash, _nonce, entry) {
                    custody = entry;
                    return ports;
                },
            });
            void outcome.then(
                () => {
                    resolved = true;
                },
                () => {
                    rejected = true;
                },
            );
            try {
                if (fault) await holdObserved;
                else await outcome;
                await flush();
                assert.equal(spawns, 0);
                assert.equal(opened.length, stage === 'partial-logs' ? 1 : 2);
                assert.equal(syncAttempts, opened.length);
                assert.equal(closeAttempts, opened.length);
                const closure = records.get('prepared-descriptors.json');
                assert.equal(closure.handles.length, opened.length);
                assert(closure.handles.every((row) => row.closeAttempted));
                assert.equal(closure.complete, !fault);
                assert.equal(released, !fault);
                assert.equal(held, Boolean(fault));
                assert.equal(rejected, false);
                if (fault) {
                    assert.equal(resolved, false);
                    assert.equal(heldState.markerReleased, false);
                    assert.equal(heldState.leaseRetained, true);
                    assert.equal(heldState.status, 'INVALID_PRODUCT_COLLECTION');
                    assert.deepEqual(order, ['handle', 'ref']);
                    assert.equal(hold.snapshot().referencedHandleCreated, true);
                    assert.equal(custody.disposed, false);
                    assert.equal(f.disconnects(), 0);
                    for (const event of ['SIGINT', 'SIGTERM', 'disconnect', 'message'])
                        assert.equal(f.events.listenerCount(event), 2);
                    assert.equal(f.clock.timers.size, 1);
                } else {
                    assert.equal(resolved, true);
                    assert.equal(custody.disposed, true);
                    assert.equal(f.disconnects(), 1);
                    assert.equal(f.clock.timers.size, 0);
                }
                for (const fd of opened) {
                    if (fault?.includes('close')) assert(fs.fstatSync(fd).isFile());
                    else assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
                }
            } finally {
                // Only this fixture closes its retained disposable FDs after hold assertions.
                for (const fd of opened)
                    try {
                        fs.closeSync(fd);
                    } catch (error) {
                        assert.equal(error.code, 'EBADF');
                    }
                if (!custody.disposed) custody.dispose({ closed: true });
                fs.rmSync(root, { recursive: true });
            }
        });
for (const proof of [undefined, { complete: false, errors: ['unregistered partial descriptor'] }])
    test(`no-child assertion with ${proof ? 'incomplete' : 'missing'} descriptor proof cannot release ownership`, async () => {
        const events = new EventEmitter(),
            clock = { now: () => 0, set: () => 1, clear() {} };
        let released = false,
            held = false;
        const result = await collectProductPreparation(
            {
                jobs: [0, 1].map((ordinal) => ({
                    ordinal,
                    observerMode: ordinal ? 'no-sampler' : 'sampled',
                    gcMode: 'normal',
                    expectedParentCode: 0,
                })),
            },
            {
                owner: {},
                verify: async () => {},
                record() {},
                evidenceComplete: () => true,
                journal: { append() {}, close() {}, proof: () => true },
                lease: {
                    acquire() {},
                    check() {},
                    release() {
                        released = true;
                    },
                    state: () => ({ retained: !released }),
                },
                prepare() {
                    throw Object.assign(Error('unknown prepared closure'), {
                        noChildStarted: true,
                        fdClosure: proof,
                    });
                },
                holdUnknown: async (state) => {
                    held = true;
                    return state;
                },
            },
            { clock, events },
        );
        assert.equal(released, false);
        assert.equal(held, true);
        assert.equal(result.preparedClosure.complete, false);
        assert.equal(result.preparedClosure.closureUnknown, true);
        assert.equal(events.listenerCount('SIGINT'), 1);
    });
test('prepared descriptor inventory spans both admitted model parents and permits release only after actual log closure', async () => {
    const f = model(),
        root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-prepared-positive-')),
        records = new Map(),
        descriptors = [];
    let released = false,
        held = false;
    f.clock.now = () => 0;
    const ports = {
        owner: {},
        manifestSHA256: 'c'.repeat(64),
        verify: async () => {},
        record(name, value) {
            records.set(name, structuredClone(value));
        },
        evidenceComplete: () => true,
        journal: { append() {}, close() {}, proof: () => true },
        lease: {
            acquire() {},
            check() {},
            release(proof) {
                assert(Object.values(proof).every(Boolean));
                assert.equal(descriptors.length, 4);
                for (const entry of descriptors)
                    assert.throws(() => fs.fstatSync(entry.fd), { code: 'EBADF' });
                released = true;
            },
            state: () => ({ retained: !released, created: true, identityConfirmed: true }),
        },
        prepare(spec, allocate, _failure, finalAdmission) {
            return prepareProductSpawn(spec, allocate, finalAdmission, {
                deferSpawn: true,
                directory: () => root,
                logs() {
                    const logs = prepareProductLogs({ root, check() {} }, [
                        `${spec.ordinal}-out`,
                        `${spec.ordinal}-err`,
                    ]);
                    descriptors.push(...logs);
                    return logs;
                },
                command: () => [],
                options: () => ({}),
                spawn() {
                    const child = new EventEmitter();
                    child.pid = 100 + spec.ordinal;
                    return child;
                },
            });
        },
        begin(_spec, _allocate, _failure, _final, prepared) {
            const session = prepared.commit();
            queueMicrotask(() => {
                session.child.emit('spawn');
                session.child.emit('exit', 0, null);
                session.child.emit('close', 0, null);
            });
            return {
                ...session,
                closeLogs: () => closeEntries(session.logs),
                inspect: async () => ({ ownershipComplete: true, valid: true }),
            };
        },
        summary() {},
        holdUnknown: async (state) => {
            held = true;
            return state;
        },
    };
    try {
        const result = await collectProductPreparation(
            {
                jobs: [0, 1].map((ordinal) => ({
                    ordinal,
                    observerMode: ordinal ? 'no-sampler' : 'sampled',
                    gcMode: 'normal',
                    expectedParentCode: 0,
                })),
            },
            ports,
            { clock: f.clock, events: f.events },
        );
        assert.equal(result.status, 'COLLECTED_UNREVIEWED_WINDOWS_PAIR', result.failure);
        assert.equal(released, true);
        assert.equal(held, false);
        assert.equal(records.get('prepared-descriptors.json').handles.length, 4);
        assert.equal(result.preparedClosure.complete, true);
        assert.equal(f.events.listenerCount('SIGINT'), 0);
    } finally {
        for (const entry of descriptors) if (!entry.closed) fs.closeSync(entry.fd);
        fs.rmSync(root, { recursive: true });
    }
});

for (const fault of [null, 'sync', 'close', 'sync-and-close'])
    for (const recordFailure of fault ? [false, true] : [false])
        test(`actual outer partial second-log open with ${fault ?? 'nominal closure'} and ${recordFailure ? 'failed' : 'durable'} hold receipt retains real descriptor custody`, async () => {
            const f = model(),
                root = fs.mkdtempSync(
                    path.join(fs.realpathSync(os.tmpdir()), 'hub-outer-partial-'),
                ),
                opened = [],
                order = [],
                observed = [];
            let opens = 0,
                syncs = 0,
                closes = 0,
                spawns = 0,
                resolved = false,
                rejection = null,
                hold = null,
                heldState = null,
                holdTimer = null;
            const io = {
                ...fs,
                openSync(...args) {
                    if (++opens === 2) throw Error('outer second log open refused');
                    const fd = fs.openSync(...args);
                    opened.push(fd);
                    return fd;
                },
                fsyncSync(fd) {
                    syncs++;
                    if (fault?.includes('sync')) throw Error('outer log sync failed');
                    fs.fsyncSync(fd);
                },
                closeSync(fd) {
                    closes++;
                    if (fault?.includes('close')) throw Error('outer log close failed');
                    fs.closeSync(fd);
                },
            };
            const outcome = runOuter({ outputRoot: root }, 'hash', '/never-read-manifest', {
                events: f.events,
                clock: f.clock,
                verify: async () => {},
                logIO: io,
                principalObserver: () => (file) => {
                    observed.push(file);
                },
                spawnChild() {
                    spawns++;
                    throw Error('native launch forbidden');
                },
                ownershipHold(state, record) {
                    heldState = state;
                    hold = createOwnershipHold(
                        state,
                        (name, value) => {
                            order.push('record');
                            if (recordFailure) throw Error('outer hold receipt persistence failed');
                            record(name, value);
                        },
                        {
                            interval: () => {
                                order.push('handle');
                                holdTimer = setInterval(() => {}, 1000);
                                const ref = holdTimer.ref.bind(holdTimer);
                                holdTimer.ref = () => {
                                    order.push('ref');
                                    return ref();
                                };
                                return holdTimer;
                            },
                        },
                    );
                    return hold;
                },
            });
            void outcome.then(
                () => {
                    resolved = true;
                },
                (error) => {
                    rejection = error;
                },
            );
            try {
                await new Promise((resolve) => setImmediate(resolve));
                await flush();
                assert.equal(opens, 2);
                assert.equal(opened.length, 1);
                assert.equal(syncs, 1);
                assert.equal(closes, 1, 'outer catch must never reset or retry the helper closure');
                assert.equal(spawns, 0);
                assert(observed.includes(root));
                assert(observed.includes(path.join(root, 'outer')));
                assert.equal(resolved, false);
                if (fault) {
                    assert.equal(
                        rejection,
                        null,
                        'pending hold cannot reject out of entry custody',
                    );
                    assert(hold);
                    assert.deepEqual(order, ['handle', 'ref', 'record']);
                    assert.equal(heldState.phase, 'outer-custody-unknown');
                    assert.equal(heldState.preparedLogClosure.complete, false);
                    assert.equal(heldState.closure.complete, false);
                    assert.equal(heldState.handles.length, 1);
                    assert.equal(heldState.handles[0].closeAttempted, true);
                    assert.equal(heldState.handles[0].closeObserved, !fault.includes('close'));
                    assert.equal(heldState.handles[0].syncObserved, !fault.includes('sync'));
                    assert.equal(hold.snapshot().referencedHandleCreated, true);
                    assert.equal(holdTimer.hasRef(), true);
                    assert.equal(hold.snapshot().recordErrors.length, recordFailure ? 1 : 0);
                    for (const event of ['SIGTERM', 'SIGINT', 'disconnect', 'message'])
                        assert.equal(f.events.listenerCount(event), 1);
                    assert.equal(f.clock.timers.size, 1);
                    // Sticky cancellation while held cannot retire handlers or escape ownership.
                    f.events.emit('SIGTERM');
                    f.events.connected = false;
                    f.events.emit('disconnect');
                    await flush();
                    assert.equal(resolved, false);
                    assert.equal(rejection, null);
                    assert.equal(f.events.listenerCount('SIGINT'), 1);
                    if (!recordFailure) {
                        const saved = JSON.parse(
                            fs.readFileSync(path.join(root, 'outer/ownership-held.json'), 'utf8'),
                        );
                        assert.equal(saved.handles[0].closeObserved, !fault.includes('close'));
                        assert.equal(saved.preparedLogClosure.complete, false);
                    }
                } else {
                    assert.match(String(rejection), /outer second log open refused/);
                    assert.equal(hold, null);
                    assert.equal(f.clock.timers.size, 0);
                    for (const event of ['SIGTERM', 'SIGINT', 'disconnect', 'message'])
                        assert.equal(f.events.listenerCount(event), 0);
                }
                if (fault?.includes('close')) assert(fs.fstatSync(opened[0]).isFile());
                else assert.throws(() => fs.fstatSync(opened[0]), { code: 'EBADF' });
                assert.equal(f.disconnects(), 0);
            } finally {
                // Fixture alone closes its disposable retained FD after all custody assertions.
                for (const fd of opened)
                    try {
                        fs.closeSync(fd);
                    } catch (error) {
                        assert.equal(error.code, 'EBADF');
                    }
                if (holdTimer) clearInterval(holdTimer);
                fs.rmSync(root, { recursive: true });
            }
        });
