// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ptyStageTimeline } from '../scripts/lib/pty-stage-timeline.mjs';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
const now = () => Number(process.hrtime.bigint() / 1000000n);
const turn = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};
function gate() {
    let resolve, reject;
    const promise = new Promise((r, j) => {
        resolve = r;
        reject = j;
    });
    return { promise, resolve, reject };
}
const stage = fs.readFileSync(
    new URL('../scripts/windows-native-pilot-stage.mts', import.meta.url),
    'utf8',
);
const joinStart = stage.indexOf("    const joinPhase = trace?.begin('startup-join');");
const joinEnd = stage.indexOf(
    "    const drainPhase = trace?.begin('diagnostic-drain');",
    joinStart,
);
assert(joinStart > 0 && joinEnd > joinStart);
// Execute the shipped stage's join/held guard, including its actual await. No copied timeline model.
const stageJoin = new vm.Script(
    '(async () => {\n' + stage.slice(joinStart, joinEnd) + '\nreturn proof; })()',
);

for (const mode of ['write', 'fsync', 'ACK', 'clock', 'budget'])
    for (const proofFails of [false, true])
        test(`shipped stage join drains real controller identity/query/pipe/operation/log and attempts descendant proof after ${mode}, proofFails=${proofFails}`, async () => {
            const dir = fs.mkdtempSync(
                path.join(fs.realpathSync(os.tmpdir()), 'hub-held-timeline-'),
            );
            const identity = gate(),
                query = gate(),
                pipe = gate(),
                operation = gate(),
                log = gate(),
                proof = gate();
            const signal = new AbortController();
            const errors = [],
                firstError = Error('controlled ' + mode + ' diagnostic failure'),
                proofError = Error('controlled descendant closure failure');
            let scope,
                held,
                referenced = false,
                cleanupCalls = 0,
                proofCalls = 0,
                readCalls = 0,
                settled = false,
                clockFailed = false;
            const io = {
                ...fs,
                writeSync: (...args) => {
                    if (mode === 'write') throw firstError;
                    return fs.writeSync(...args);
                },
                fsyncSync: (...args) => {
                    if (mode === 'fsync') throw firstError;
                    return fs.fsyncSync(...args);
                },
            };
            const evidence = new PilotEvidence(dir, { io });
            const descriptor = fs.openSync(path.join(dir, 'owned-operation.bin'), 'wx', 0o600);
            const hold = (e) => {
                errors.push(e);
                scope?.stopQueryAdmission();
                held ??= createOwnershipHold(
                    { first: trace.first(), error: e, fd: evidence.entry.fd },
                    () => {},
                    {
                        interval: () => ({
                            ref() {
                                referenced = true;
                            },
                        }),
                    },
                );
                signal.abort(e);
                scope?.cancel();
            };
            const trace = ptyStageTimeline({
                deadline: now() + 3000,
                hold,
                clock: () => {
                    if (clockFailed) throw firstError;
                    return { hrBefore: 1000, hrAfter: 1000, perfUs: 1000000 };
                },
                emit: async (name, data) => {
                    evidence.append(name, data);
                    if (mode === 'ACK') throw firstError;
                },
            });
            scope = new NativePilotStartup({
                signal: signal.signal,
                deadline: now() + 3000,
                cleanupDeadline: now() + 4000,
                timeoutMs: 1000,
                timeline: trace,
                diagnostics: true,
                identity: async () => identity.promise,
                readTable: async () => {
                    readCalls++;
                    return query.promise;
                },
                proveDescendants: async () => {
                    proofCalls++;
                    await proof.promise;
                    if (proofFails) throw proofError;
                },
                emit: async () => {
                    await log.promise;
                },
                hold,
            });
            const child = Object.assign(new EventEmitter(), {
                pid: 7788,
                stdout: new PassThrough(),
                stderr: new PassThrough(),
            });
            scope.adopt('already-owned', child, () => {});
            const row = scope.children.get(child);
            const admittedQuery = scope.observe(row, () => row.sampler.sample());
            void admittedQuery.catch(() => {});
            const ownedOperation = scope.opaque(
                'already-admitted-operation',
                () => operation.promise,
                () => {},
                async () => {
                    cleanupCalls++;
                    fs.closeSync(descriptor);
                },
            );
            void ownedOperation.catch(() => {});
            await turn();
            assert.equal(readCalls, 1);
            trace.cancel('stage-timer', 'original stage deadline', false);
            const first = trace.first();
            try {
                if (mode === 'clock') {
                    clockFailed = true;
                    assert.throws(
                        () => trace.begin('connect'),
                        (e) => e === firstError,
                    );
                } else if (mode === 'budget') {
                    for (let i = 0; i < 48; i++) {
                        const t = trace.begin('verdict');
                        trace.end(t);
                    }
                    assert.throws(() => trace.begin('connect'), /event bound/);
                } else await assert.rejects(trace.publishCancellation(), (e) => e === firstError);
                const diagnosticError = trace.failure();
                assert(diagnosticError);
                assert(held?.snapshot().attached && referenced);
                assert(fs.fstatSync(evidence.entry.fd).isFile());
                let newWork = 0;
                assert.throws(() =>
                    scope.spawn(
                        'forbidden',
                        () => {
                            newWork++;
                            return child;
                        },
                        () => {},
                    ),
                );
                await assert.rejects(trace.phase('connect', async () => newWork++));
                await assert.rejects(trace.measure('process-query', async () => newWork++));
                const joining = stageJoin.runInNewContext({ trace, startup: scope, held });
                void joining.then(
                    () => {
                        settled = true;
                    },
                    () => {
                        settled = true;
                    },
                );
                await turn();
                assert(
                    scope.joinTask,
                    'The actual stage must call startup.join even with a failed trace.',
                );
                assert(!settled);
                assert.equal(proofCalls, 0);
                identity.resolve([
                    { pid: 7788, created: 'controlled-owned-birth', state: 'running' },
                ]);
                query.resolve([
                    {
                        pid: 7788,
                        parent: process.pid,
                        created: '2026-10-20T00:00:00.0000000Z',
                        creationClock: 'windows-utc-100ns',
                        rssBytes: null,
                    },
                ]);
                operation.resolve({});
                child.emit('exit', 0, null);
                child.emit('close', 0, null);
                pipe.resolve();
                await turn();
                assert.equal(cleanupCalls, 1);
                assert.equal(
                    proofCalls,
                    1,
                    'Original descendant callback must execute despite logging failure.',
                );
                assert(!settled, 'Owned descendant proof must still be awaited.');
                proof.resolve();
                await turn();
                assert(!settled, 'Already-admitted diagnostic/log tasks must still drain.');
                log.resolve();
                await assert.rejects(joining);
                await assert.rejects(ownedOperation);
                await admittedQuery.catch(() => {});
                await assert.rejects(scope.join());
                assert.equal(proofCalls, 1, 'Failure cleanup cannot retry the proof.');
                assert.equal(readCalls, 1, 'Held cleanup must not admit another process read.');
                assert.equal(newWork, 0);
                assert.equal(trace.first(), first);
                assert.equal(trace.failure(), diagnosticError);
                await assert.rejects(trace.finish(), (e) => e === diagnosticError);
                assert(held.snapshot().attached);
                assert.notEqual(row.joined, true);
                assert.equal(row.observations.size, 0);
                assert.equal(scope.diagnosticTasks.size, 0);
                assert.equal(errors[0], diagnosticError);
                if (proofFails)
                    assert(errors.includes(proofError), 'Keep secondary closure failure distinct.');
                if (proofFails)
                    assert.equal(
                        (await scope.heldChildDrains.get(row)).descendantError,
                        proofError,
                    );
                assert.throws(() => fs.fstatSync(descriptor), /EBADF/);
                assert(
                    fs.fstatSync(evidence.entry.fd).isFile(),
                    'No false release of held evidence descriptor.',
                );
            } finally {
                identity.resolve([]);
                query.resolve([]);
                operation.resolve({});
                proof.resolve();
                log.resolve();
                child.emit('exit', 0, null);
                child.emit('close', 0, null);
                await ownedOperation.catch(() => {});
                await admittedQuery.catch(() => {});
                scope.stopQueryAdmission();
                try {
                    fs.closeSync(descriptor);
                } catch {}
                try {
                    fs.closeSync(evidence.entry.fd);
                } catch {}
                fs.rmSync(dir, { recursive: true });
            }
        });

for (const phase of ['compiler-join', 'startup-join', 'diagnostic-drain', 'cleanup-session'])
    test(`shipped cleanup phase ${phase} executes and preserves its own error after a new clock failure`, async () => {
        const diagnostic = Error('controlled clock failed'),
            underlying = Error('controlled cleanup failed'),
            errors = [];
        let bad = false,
            calls = 0;
        const trace = ptyStageTimeline({
            deadline: 26000,
            emit: async () => {},
            hold: (e) => errors.push(e),
            clock: () => {
                if (bad) throw diagnostic;
                return { hrBefore: 1000, hrAfter: 1000, perfUs: 1000000 };
            },
        });
        trace.cancel('stage-timer', 'first', false);
        const first = trace.first();
        bad = true;
        await assert.rejects(
            trace.phase(phase, async () => {
                calls++;
                throw underlying;
            }),
            (e) => e === underlying,
        );
        assert.equal(calls, 1);
        assert.equal(trace.first(), first);
        assert.equal(trace.failure(), diagnostic);
        assert.deepEqual(errors, [diagnostic]);
        await assert.rejects(trace.finish(), (e) => e === diagnostic);
    });

test('default descendant callback is attempted while held sampler refuses all new reads; no fabricated join', async () => {
    const signal = new AbortController(),
        errors = [];
    let scope,
        reads = 0,
        proofs = 0;
    const trace = ptyStageTimeline({
        deadline: now() + 3000,
        clock: () => ({ hrBefore: 1000, hrAfter: 1000, perfUs: 1000000 }),
        emit: async () => {
            throw Error('controlled ACK failure');
        },
        hold: (e) => {
            errors.push(e);
            scope.stopQueryAdmission();
            signal.abort(e);
        },
    });
    scope = new NativePilotStartup({
        signal: signal.signal,
        deadline: now() + 3000,
        timeoutMs: 200,
        timeline: trace,
        emit: async () => {},
        hold: (e) => errors.push(e),
        readTable: async () => {
            reads++;
            return [
                {
                    pid: 7788,
                    parent: process.pid,
                    created: '2026-10-20T00:00:00.0000000Z',
                    creationClock: 'windows-utc-100ns',
                    rssBytes: null,
                },
            ];
        },
    });
    const child = Object.assign(new EventEmitter(), {
        pid: 7788,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
    });
    scope.adopt('owned-default', child, () => {});
    const row = scope.children.get(child);
    await row.identityTask;
    const original = row.sampler.assertExited.bind(row.sampler);
    row.sampler.assertExited = () => {
        proofs++;
        return original();
    };
    trace.cancel('stage-timer', 'original deadline', false);
    await assert.rejects(trace.publishCancellation());
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await assert.rejects(scope.join());
    assert.equal(proofs, 1);
    assert.equal(reads, 1);
    assert.notEqual(row.joined, true);
    assert(errors.some((e) => /query admission closed/.test(String(e))));
    await assert.rejects(scope.join());
    assert.equal(proofs, 1);
});

test('diagnostic fault during an already-running proof drains that same attempt and preserves secondary failure', async () => {
    const proof = gate(),
        errors = [],
        underlying = Error('controlled original proof failed');
    let scope,
        calls = 0;
    const signal = new AbortController();
    const trace = ptyStageTimeline({
        deadline: now() + 3000,
        emit: async () => {
            throw Error('controlled fsync failure');
        },
        hold: (e) => {
            errors.push(e);
            scope.stopQueryAdmission();
            signal.abort(e);
        },
    });
    scope = new NativePilotStartup({
        signal: signal.signal,
        deadline: now() + 3000,
        timeoutMs: 300,
        timeline: trace,
        emit: async () => {},
        hold: (e) => errors.push(e),
        identity: async () => [{ pid: 7788, created: 'owned', state: 'running' }],
        proveDescendants: async () => {
            calls++;
            await proof.promise;
            throw underlying;
        },
    });
    const child = Object.assign(new EventEmitter(), {
        pid: 7788,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
    });
    scope.adopt('owned-race', child, () => {});
    const row = scope.children.get(child);
    await row.identityTask;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const joining = scope.join();
    void joining.catch(() => {});
    await turn();
    assert.equal(calls, 1);
    trace.cancel('stage-timer', 'original', false);
    await assert.rejects(trace.publishCancellation());
    proof.resolve();
    await assert.rejects(joining, (e) => e === underlying);
    assert.equal(calls, 1);
    assert(errors.includes(underlying));
    assert.notEqual(row.joined, true);
});

test('held cleanup timeout retains admitted waits without restarting cutoff or starting a late proof', async () => {
    const identity = gate(),
        errors = [];
    let scope,
        proofs = 0;
    const signal = new AbortController();
    const trace = ptyStageTimeline({
        deadline: now() + 3000,
        emit: async () => {
            throw Error('controlled fsync failed');
        },
        hold: (e) => {
            errors.push(e);
            scope.stopQueryAdmission();
            signal.abort(e);
        },
    });
    scope = new NativePilotStartup({
        signal: signal.signal,
        deadline: now() + 3000,
        timeoutMs: 40,
        timeline: trace,
        emit: async () => {},
        hold: (e) => errors.push(e),
        identity: async () => identity.promise,
        proveDescendants: async () => {
            proofs++;
        },
    });
    const child = Object.assign(new EventEmitter(), {
        pid: 7788,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
    });
    scope.adopt('owned-timeout', child, () => {});
    await turn();
    trace.cancel('stage-timer', 'original', false);
    const first = trace.first();
    await assert.rejects(trace.publishCancellation());
    const joining = scope.join();
    await assert.rejects(joining);
    const cutoff = scope.heldDrainDeadline;
    assert(scope.heldDrainTimeout);
    assert.equal(scope.join(), joining);
    await assert.rejects(scope.join());
    assert.equal(scope.heldDrainDeadline, cutoff);
    assert(errors.some((e) => /cleanup deadline exhausted/.test(String(e))));
    assert.equal(proofs, 0);
    identity.resolve([{ pid: 7788, created: 'owned', state: 'running' }]);
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await scope.heldDrainWork;
    assert.equal(proofs, 0, 'Finishing an admitted wait after cutoff must not start a late proof.');
    assert.equal(trace.first(), first);
    assert.notEqual(scope.children.get(child).joined, true);
});

test('held per-child cleanup inside an admitted opaque operation cannot wait on its own caller', async () => {
    const errors = [];
    let scope,
        proofs = 0;
    const signal = new AbortController();
    const trace = ptyStageTimeline({
        deadline: now() + 3000,
        emit: async () => {
            throw Error('controlled fsync failed');
        },
        hold: (e) => {
            errors.push(e);
            scope.stopQueryAdmission();
            signal.abort(e);
        },
    });
    scope = new NativePilotStartup({
        signal: signal.signal,
        deadline: now() + 3000,
        timeoutMs: 500,
        timeline: trace,
        emit: async () => {},
        hold: (e) => errors.push(e),
        identity: async () => [{ pid: 7788, created: 'owned', state: 'running' }],
        proveDescendants: async () => {
            proofs++;
        },
    });
    const child = Object.assign(new EventEmitter(), {
        pid: 7788,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
    });
    scope.adopt('owned-nested', child, () => {});
    await scope.children.get(child).identityTask;
    const operation = scope.opaque(
        'caller-of-join',
        () => scope.joinChild(child),
        () => {},
        async () => {},
    );
    void operation.catch(() => {});
    trace.cancel('stage-timer', 'original', false);
    await assert.rejects(trace.publishCancellation());
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await assert.rejects(operation);
    assert.equal(proofs, 1);
    assert.equal(scope.operations.get('caller-of-join').pending, false);
    assert(
        !errors.some((e) => /cleanup deadline exhausted/.test(String(e))),
        'No caller/drain dependency cycle.',
    );
    await assert.rejects(scope.join());
    assert.equal(proofs, 1);
});

test('secondary failure of one held child cannot bypass another original descendant attempt', async () => {
    const proof = gate(),
        errors = [],
        calls = [];
    let scope;
    const signal = new AbortController();
    const trace = ptyStageTimeline({
        deadline: now() + 3000,
        emit: async () => {
            throw Error('controlled ACK failed');
        },
        hold: (e) => {
            errors.push(e);
            scope.stopQueryAdmission();
            signal.abort(e);
        },
    });
    scope = new NativePilotStartup({
        signal: signal.signal,
        deadline: now() + 3000,
        timeoutMs: 500,
        timeline: trace,
        emit: async () => {},
        hold: (e) => errors.push(e),
        identity: async (c) => [{ pid: c.pid, created: 'owned', state: 'running' }],
        proveDescendants: async (c) => {
            calls.push(c.pid);
            if (c.pid === 7788) throw Error('controlled first child closure failed');
            await proof.promise;
        },
    });
    const children = [7788, 7789].map((pid) =>
        Object.assign(new EventEmitter(), {
            pid,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
        }),
    );
    for (const c of children) {
        scope.adopt('owned-' + c.pid, c, () => {});
        await scope.children.get(c).identityTask;
    }
    trace.cancel('stage-timer', 'original', false);
    await assert.rejects(trace.publishCancellation());
    for (const c of children) {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
    }
    const joining = scope.join();
    void joining.catch(() => {});
    await turn();
    assert.deepEqual(calls, [7788, 7789]);
    proof.resolve();
    await assert.rejects(joining);
    assert(errors.some((e) => /first child closure failed/.test(String(e))));
    for (const c of children) assert.notEqual(scope.children.get(c).joined, true);
});
