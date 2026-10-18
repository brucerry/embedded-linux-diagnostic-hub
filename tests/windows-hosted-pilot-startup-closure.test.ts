// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { SameJobPilotCustody } from '../scripts/lib/hosted-pilot-custody.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { pilotLimits, bindingDigest } from '../scripts/lib/hosted-pilot-contract.mjs';
const h = 'a'.repeat(64),
    nonce = '9536ac3c-b0ea-44dc-a4b6-9b1feec7975e';
function binding() {
    return {
        schema: 1,
        kind: 'windows-hosted-native-readiness-pilot-v1',
        collectionApproval: false,
        host: {
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            attempt: '1',
            run: '39110250748',
            commit: 'a'.repeat(40),
            environment: 'github-hosted',
        },
        nonce,
        principalSID: 'S-1-5-21-1-2-3-500',
        sourceSHA256: h,
        coveragePolicySHA256: h,
        pilotPolicySHA256: h,
        dependenciesSHA256: h,
        runtime: {
            platform: 'win32',
            arch: 'x64',
            ...Object.fromEntries(
                [
                    'node',
                    'tsx',
                    'electron',
                    'powershell',
                    'git',
                    'bash',
                    'cygpath',
                    'winptyDll',
                    'winptyAgent',
                ].map((k) => [
                    k,
                    {
                        path: 'C:\\runtime\\' + k,
                        sha256: h,
                        ...(k === 'node'
                            ? { version: 'v24.22.0' }
                            : k === 'electron'
                              ? { version: '44.5.1' }
                              : {}),
                    },
                ]),
            ),
        },
        roots: Object.fromEntries(
            ['canonicalTemp', 'privateRoot', 'evidenceRoot'].map((k, i) => [
                k,
                {
                    path:
                        k === 'privateRoot'
                            ? 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\diagnostic-hub-native-pilot-' +
                              nonce
                            : k === 'canonicalTemp'
                              ? 'C:\\Users\\runneradmin\\AppData\\Local\\Temp'
                              : 'D:\\a\\report',
                    dev: '1',
                    ino: String(i + 1),
                    ...(k === 'evidenceRoot' ? { identitySHA256: h } : { descriptorSHA256: h }),
                },
            ]),
        ),
        startedAt: 0,
        deadline: 600000,
        limits: pilotLimits,
    };
}

const now = () => Number(process.hrtime.bigint() / 1000000n);
const turn = () => new Promise((r) => setImmediate(r));
function deferred() {
    let resolve, reject;
    const promise = new Promise((r, j) => {
        resolve = r;
        reject = j;
    });
    return { promise, resolve, reject };
}
function leaf() {
    const child = spawn(
        process.execPath,
        [
            '-e',
            "const timer=setTimeout(()=>process.exit(4),5000);process.on('message',()=>{clearTimeout(timer);process.disconnect();});process.send({pid:process.pid,created:performance.timeOrigin});",
        ],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const identity = new Promise((resolve, reject) => {
        child.once('message', (m) => {
            try {
                assert.equal(m.pid, child.pid);
                assert(Number.isFinite(m.created) && m.created > 0);
                resolve(m);
            } catch (e) {
                reject(e);
            }
        });
        child.once('error', reject);
    });
    const closed = new Promise((resolve) =>
        child.once('close', (code, signal) => resolve({ code, signal })),
    );
    return {
        child,
        identity,
        closed,
        stop() {
            if (child.connected) child.send('stop');
        },
    };
}
async function ownerFixture() {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-startup-closure-')),
        marker = path.join(dir, 'controlled-owner.lock'),
        evidence = new PilotEvidence(dir),
        b = binding(),
        events = new EventEmitter(),
        timers = new Map();
    let id = 0;
    const lease = new ProductLease(marker, { nonce, bindingSHA256: bindingDigest(b) }),
        holds = [];
    const owner = new SameJobPilotCustody(b, {
        lease,
        events,
        clock: {
            now: () => 0,
            set: (fn, ms) => {
                timers.set(++id, { fn, ms });
                return id;
            },
            clear: (h) => timers.delete(h),
        },
        executionGate: () => {},
        verify: async (b) => b,
        record: (stage, data) => evidence.append(stage, data),
        closeEvidence: async () => evidence.close(),
        hold: (state, record) => {
            const probe = { ref: false };
            const actual = createOwnershipHold(state, record, {
                interval: () => ({
                    ref() {
                        probe.ref = true;
                    },
                }),
            });
            holds.push({ actual, probe });
            return actual;
        },
    });
    await owner.acquireAndVerify();
    return {
        dir,
        marker,
        evidence,
        owner,
        holds,
        held() {
            assert.equal(owner.state, 'held');
            assert(fs.existsSync(marker));
            assert(holds.length > 0 && holds.every((h) => h.probe.ref));
            assert.equal(evidence.entry.attempted, false);
            assert(fs.fstatSync(evidence.entry.fd).isFile());
        },
        async releaseFailed() {
            owner.cancel('Controlled startup cancelled before native payload');
            await owner.release({
                inputsUnchanged: true,
                rootsCleanupClosed: true,
                resultClosed: true,
            });
            assert.equal(owner.verdict, 'failed');
            assert.equal(owner.state, 'released');
            assert(!fs.existsSync(marker));
        },
        dispose() {
            try {
                fs.closeSync(evidence.entry.fd);
            } catch {}
            fs.rmSync(dir, { recursive: true });
        },
    };
}
for (const result of ['success', 'reject'])
    test(
        'opaque abort cleanup ' +
            result +
            ' stays pending through real child close and owned FD cleanup',
        async () => {
            const f = await ownerFixture(),
                controller = new AbortController(),
                factory = deferred(),
                cleanup = deferred(),
                cleanupEntered = deferred();
            const fd = fs.openSync(path.join(f.dir, 'launcher-owned.bin'), 'wx', 0o600);
            let child,
                fdClosed = false;
            const scope = new NativePilotStartup({
                signal: controller.signal,
                deadline: now() + 5000,
                cleanupDeadline: now() + 6000,
                emit: async () => {},
                hold: (e) => f.owner.hold(e),
                identity: async () => await child.identity,
                proveDescendants: async () => {
                    assert.equal((await child.closed).code, 0);
                    assert.equal(child.child.stdout.readableEnded, true);
                    assert.equal(child.child.stderr.readableEnded, true);
                },
                timeoutMs: 2000,
            });
            let joined = false,
                join,
                launch;
            try {
                launch = scope.opaque(
                    'launcher',
                    () => {
                        child = leaf();
                        return factory.promise;
                    },
                    (value) =>
                        scope.adopt('adopted-launcher-child', value.child.child, () =>
                            value.child.stop(),
                        ),
                    async (value) => {
                        await value.child.closed;
                        cleanupEntered.resolve();
                        await cleanup.promise;
                        fs.closeSync(value.fd);
                        fdClosed = true;
                    },
                );
                const launchOutcome = launch.then(
                    () => assert.fail('Cancellation must remain failure'),
                    (e) => e,
                );
                await child.identity;
                controller.abort(Error('cancel while launcher is pending'));
                f.owner.cancel('cancelled launcher');
                if (result === 'success') {
                    join = scope.join();
                    void join.then(
                        () => (joined = true),
                        () => {},
                    );
                    await turn();
                    assert.equal(joined, false);
                }
                factory.resolve({ fd, child });
                await cleanupEntered.promise;
                assert.equal(scope.children.get(child.child).close, true);
                assert(fs.fstatSync(fd).isFile());
                assert.equal(scope.operations.get('launcher').pending, true);
                assert.equal(scope.operations.get('launcher').closed, false);
                if (!join) {
                    join = scope.join();
                    void join.then(
                        () => (joined = true),
                        () => {},
                    );
                }
                await turn();
                assert.equal(joined, false);
                assert.equal(f.holds.length, 0);
                assert.equal(f.evidence.entry.attempted, false);
                if (result === 'reject') {
                    cleanup.reject(
                        Error('owned launcher cleanup rejected after actual child closure'),
                    );
                    assert.match(String(await launchOutcome), /owned launcher cleanup rejected/);
                    await assert.rejects(join, /Opaque startup/);
                    assert.equal(scope.operations.get('launcher').unknown, true);
                    assert.equal(scope.operations.get('launcher').closed, false);
                    assert.match(
                        scope.operations.get('launcher').failure,
                        /owned launcher cleanup rejected/,
                    );
                    assert(fs.fstatSync(fd).isFile());
                    f.held();
                    await assert.rejects(
                        f.owner.release({
                            inputsUnchanged: true,
                            rootsCleanupClosed: true,
                            resultClosed: true,
                        }),
                    );
                    f.held();
                } else {
                    cleanup.resolve();
                    assert.match(String(await launchOutcome), /cancel while launcher/);
                    assert.equal((await join).complete, true);
                    assert.equal(joined, true);
                    assert.equal(fdClosed, true);
                    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
                    assert.equal(scope.operations.get('launcher').unknown, false);
                    assert.equal(scope.operations.get('launcher').closed, true);
                    assert.equal(scope.operations.get('launcher').pending, false);
                    assert.equal(f.holds.length, 0);
                    await f.releaseFailed();
                }
            } finally {
                factory.resolve({ fd, child });
                cleanup.resolve();
                child?.stop();
                if (child) await child.closed;
                if (!fdClosed)
                    try {
                        fs.closeSync(fd);
                    } catch {}
                f.dispose();
            }
        },
    );
async function observedFixture({
    timeoutMs = 2000,
    lifeMs = 5000,
    holdInitial = false,
    holdFinal = false,
} = {}) {
    const f = await ownerFixture(),
        query = deferred(),
        started = deferred(),
        final = deferred(),
        finalStarted = deferred();
    let child,
        reads = 0,
        periodicSettled = false,
        finalReads = 0;
    const deadline = now() + lifeMs;
    const scope = new NativePilotStartup({
        signal: new AbortController().signal,
        deadline,
        cleanupDeadline: deadline,
        timeoutMs,
        emit: async () => {},
        hold: (e) => f.owner.hold(e),
        readTable: async () => {
            reads++;
            const current = reads,
                id = await child.identity;
            const live = [
                {
                    pid: child.child.pid,
                    parent: process.pid,
                    created: String(id.created),
                    rssBytes: null,
                },
            ];
            if (current === (holdInitial ? 1 : 2)) {
                started.resolve();
                const result = await query.promise;
                periodicSettled = true;
                return result === 'live' ? live : result;
            }
            if (current === 1) return live;
            finalReads++;
            assert.equal(
                periodicSettled,
                true,
                'Final descendant query raced an active observation',
            );
            assert.equal(scope.children.get(child.child).close, true);
            finalStarted.resolve();
            if (holdFinal) return await final.promise;
            return [];
        },
    });
    scope.spawn(
        'observed-child',
        () => {
            child = leaf();
            return child.child;
        },
        () => child.stop(),
    );
    await started.promise;
    child.stop();
    await child.closed;
    await scope.children.get(child.child).closed;
    return {
        ...f,
        scope,
        child,
        query,
        started,
        final,
        finalStarted,
        deadline,
        get reads() {
            return reads;
        },
        get finalReads() {
            return finalReads;
        },
        get periodicSettled() {
            return periodicSettled;
        },
        async disposeAll() {
            query.resolve([]);
            final.resolve([]);
            child.stop();
            await child.closed;
            await turn();
            f.dispose();
        },
    };
}
for (const entry of ['scope', 'child'])
    for (const result of ['success', 'reject', 'missing'])
        test(
            entry + ' closure drains the default periodic path before final proof: ' + result,
            async () => {
                const f = await observedFixture({
                    lifeMs: result === 'missing' ? 800 : 5000,
                    timeoutMs: 2000,
                });
                let settled = false;
                try {
                    assert.equal(
                        f.scope.options.identity,
                        undefined,
                        'Test must exercise default periodic ProcessSampler path',
                    );
                    assert.equal(f.periodicSettled, false);
                    assert.equal(f.child.child.stdout.readableEnded, true);
                    assert.equal(f.child.child.stderr.readableEnded, true);
                    const joining =
                        entry === 'scope' ? f.scope.join() : f.scope.joinChild(f.child.child);
                    void joining.then(
                        () => (settled = true),
                        () => (settled = true),
                    );
                    await turn();
                    assert.equal(settled, false);
                    assert.equal(f.finalReads, 0);
                    assert.equal(f.holds.length, 0);
                    assert.equal(f.evidence.entry.attempted, false);
                    assert(fs.existsSync(f.marker));
                    if (result === 'success') {
                        f.query.resolve([]);
                        assert.equal((await joining).complete, true);
                        assert.equal(f.periodicSettled, true);
                        assert.equal(f.finalReads, 1);
                        assert.equal(f.scope.children.get(f.child.child).observations.size, 0);
                        assert.equal((await f.scope.join()).complete, true);
                        const reads = f.reads;
                        await new Promise((r) => setTimeout(r, 270));
                        assert.equal(
                            f.reads,
                            reads,
                            'Periodic observer admitted work after receipt',
                        );
                        assert.equal(f.holds.length, 0);
                        await f.releaseFailed();
                    } else {
                        if (result === 'reject')
                            f.query.reject(
                                Error('periodic observation failed after actual child pipe-close'),
                            );
                        await assert.rejects(
                            joining,
                            result === 'reject'
                                ? /periodic observation failed/
                                : /cleanup deadline/,
                        );
                        assert.equal(f.finalReads, 0);
                        f.held();
                        const again =
                            entry === 'scope' ? f.scope.join() : f.scope.joinChild(f.child.child);
                        assert.equal(again, joining, 'Join retry must not reset the budget');
                        await assert.rejects(again);
                        if (result === 'missing') {
                            assert(now() >= f.deadline - 2);
                            assert.equal(f.scope.cleanupDeadline, f.deadline);
                            assert.throws(
                                () => (f.scope.cleanupDeadline = f.deadline + 10000),
                                TypeError,
                            );
                            f.query.resolve([]);
                            await turn();
                            assert.equal(
                                f.finalReads,
                                0,
                                'Late observation must not start a new descendant query',
                            );
                            assert.notEqual(f.scope.children.get(f.child.child).joined, true);
                        }
                        await assert.rejects(
                            f.owner.release({
                                inputsUnchanged: true,
                                rootsCleanupClosed: true,
                                resultClosed: true,
                            }),
                        );
                        f.held();
                    }
                } finally {
                    await f.disposeAll();
                }
            },
        );
test('held initial process identity is owned and drained before final descendant proof', async () => {
    const f = await observedFixture({ holdInitial: true });
    let complete = false;
    try {
        const joining = f.scope.join();
        void joining.then(
            () => (complete = true),
            () => {},
        );
        await turn();
        assert.equal(complete, false);
        assert.equal(f.finalReads, 0);
        assert.equal(f.scope.children.get(f.child.child).identity, null);
        f.query.resolve('live');
        assert.equal((await joining).complete, true);
        assert.equal(f.finalReads, 1);
        assert.equal(f.scope.children.get(f.child.child).observations.size, 0);
        assert.equal(f.holds.length, 0);
        await f.releaseFailed();
    } finally {
        await f.disposeAll();
    }
});
test('one immutable join timeout covers periodic drain and the final descendant query together', async () => {
    const f = await observedFixture({ timeoutMs: 150, holdFinal: true });
    let complete = false;
    try {
        const joining = f.scope.join();
        void joining.then(
            () => (complete = true),
            () => {},
        );
        await new Promise((r) => setTimeout(r, 60));
        f.query.resolve([]);
        await f.finalStarted.promise;
        assert.equal(complete, false);
        assert.equal(f.finalReads, 1);
        await assert.rejects(joining, /cleanup deadline/);
        f.held();
        f.final.resolve([]);
        await turn();
        assert.notEqual(f.scope.children.get(f.child.child).joined, true);
        await assert.rejects(f.scope.join());
        f.held();
    } finally {
        await f.disposeAll();
    }
});

test('successful opaque adoption remains available without invoking cancellation cleanup', async () => {
    const f = await ownerFixture();
    let child;
    const fd = fs.openSync(path.join(f.dir, 'adopted-owned.bin'), 'wx', 0o600);
    let closed = false;
    const scope = new NativePilotStartup({
        signal: new AbortController().signal,
        deadline: now() + 5000,
        cleanupDeadline: now() + 6000,
        timeoutMs: 2000,
        emit: async () => {},
        hold: (e) => f.owner.hold(e),
        identity: async () => await child.identity,
        proveDescendants: async () => {
            assert.equal((await child.closed).code, 0);
        },
    });
    try {
        const value = await scope.opaque(
            'normal-launch',
            async () => {
                child = leaf();
                return { child, fd };
            },
            (v) => scope.adopt('normal-child', v.child.child, () => v.child.stop()),
            async () => assert.fail('Normal adoption must not call cancellation cleanup'),
        );
        assert.equal(value.fd, fd);
        assert.equal(scope.operations.get('normal-launch').pending, false);
        assert.equal(scope.operations.get('normal-launch').closed, true);
        assert.equal(scope.operations.get('normal-launch').unknown, false);
        assert(fs.fstatSync(fd).isFile());
        await child.identity;
        child.stop();
        await child.closed;
        fs.closeSync(fd);
        closed = true;
        assert.equal((await scope.join()).complete, true);
        assert.equal(f.holds.length, 0);
        await f.releaseFailed();
    } finally {
        child?.stop();
        if (child) await child.closed;
        if (!closed)
            try {
                fs.closeSync(fd);
            } catch {}
        f.dispose();
    }
});
