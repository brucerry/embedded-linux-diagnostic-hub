import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SameJobPilotCustody } from '../scripts/lib/hosted-pilot-custody.mjs';
import { pilotLimits, bindingDigest } from '../scripts/lib/hosted-pilot-contract.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as queryProofModule from '../scripts/lib/pilot-process-query.mjs';
import { ProcessSampler, type ProcessRow } from './fixtures/memory-resource-processes';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import {
    processQueryDigest,
    validateProcessQueryProof,
} from '../scripts/lib/pilot-process-query.mjs';
import { pilotEvidenceReceiver } from '../scripts/lib/pilot-evidence-channel.mjs';

const root: ProcessRow = {
    pid: 10,
    parent: 1,
    created: '2026-10-20T03:49:21.0000000Z',
    rssBytes: 1,
    creationClock: 'windows-utc-100ns' as const,
};
const query = (n: number): ProcessRow => ({
    pid: 1000 + n,
    parent: 10,
    created: `2026-10-20T03:49:22.${String(n).padStart(7, '0')}Z`,
    rssBytes: 1,
    creationClock: 'windows-utc-100ns' as const,
});
const proof = (row: ProcessRow) => ({
    schema: 1,
    platform: 'win32',
    querySHA256: processQueryDigest('win32'),
    tableSHA256: 'a'.repeat(64),
    querySequence: 1,
    ownerPID: 10,
    ownerCreated: root.created,
    pid: row.pid,
    created: row.created,
    parentPID: 10,
    spawn: true,
    exit: true,
    close: true,
    exitCode: 0,
    exitSignal: null,
    closeCode: 0,
    closeSignal: null,
});

test('positive creation-matched query closure retires over256 sequential probes, keeping unresolved ownership bounded', async () => {
    let rows: ProcessRow[] = [root];
    const s = new ProcessSampler([10], async () => rows);
    for (let n = 0; n < 700; n++) {
        const q = query(n);
        rows = [root, q];
        assert.equal((await s.sample()).length, 2);
        s.acceptClosedQuery(proof(q), 10);
        rows = [root];
        assert.equal((await s.sample()).length, 1);
        assert.equal(s.historyProof().retiredCount, n + 1);
        assert.equal(s.historyProof().unresolved, 1);
    }
    rows = [];
    await s.assertExited();
    assert.equal(s.historyProof().retiredCount, 700);
    assert.match(s.historyProof().retiredSHA256, /^[a-f0-9]{64}$/);
});
test('257 live identities still trip unchanged guard with bounded complete overflow facts and sticky failure', async () => {
    let rows = [root, ...Array.from({ length: 256 }, (_, n) => query(n))];
    const s = new ProcessSampler([10], async () => rows);
    await assert.rejects(s.sample(), /Owned process identity bound exceeded/);
    const h = s.historyProof() as any;
    assert.equal(h.overflow.live, 257);
    assert.equal(h.overflow.unresolved, 257);
    assert.equal(h.overflow.tuples.length, 257);
    assert.equal(h.overflow.tuplesComplete, true);
    assert.match(h.tableSHA256, /^[a-f0-9]{64}$/);
    rows = [];
    await assert.rejects(s.assertExited(), /Owned process identity bound exceeded/);
});
test('unproven historical churn remains unknown ownership, even after an empty table', async () => {
    let rows: ProcessRow[] = [root];
    const s = new ProcessSampler([10], async () => rows);
    for (let n = 0; n < 255; n++) {
        rows = [root, query(n)];
        await s.sample();
    }
    rows = [root, query(255)];
    await assert.rejects(s.sample(), /identity bound exceeded/);
    const h = s.historyProof() as any;
    assert.equal(h.retiredCount, 0);
    assert.equal(h.overflow.live, 2);
    assert.equal(h.overflow.terminated, 255);
    rows = [];
    await assert.rejects(s.assertExited(), /identity bound exceeded/);
});
test('stable repeated samples do not grow history', async () => {
    const s = new ProcessSampler([10], async () => [root, query(0)]);
    for (let n = 0; n < 512; n++) assert.equal((await s.sample()).length, 2);
    assert.equal(s.historyProof().unresolved, 2);
    assert.equal(s.historyProof().retiredCount, 0);
});
test('closed query witness never retires a creation-matched live or reparented descendant', async () => {
    const q = query(0);
    let rows = [root, q];
    const s = new ProcessSampler([10], async () => rows);
    await s.sample();
    s.acceptClosedQuery(proof(q), 10);
    rows = [{ ...q, parent: 1 }];
    const result = await s.sample();
    assert.equal(result.find((r) => r.pid === q.pid)?.state, 'running');
    assert.equal(s.historyProof().retiredCount, 0);
    await assert.rejects(s.assertExited(), /still running/);
});
test('old PID proof does not retire reused creation identity or transfer ownership to an ambient replacement', async () => {
    const old = query(0),
        fresh = { ...old, created: '2026-10-20T03:49:23.0000000Z' };
    let rows = [root, old];
    const s = new ProcessSampler([10], async () => rows);
    await s.sample();
    s.acceptClosedQuery(proof(old), 10);
    rows = [root, fresh];
    const records = await s.sample();
    assert.equal(s.historyProof().retiredCount, 1);
    assert.equal(records.find((r) => r.created === fresh.created)?.state, 'running');
    rows = [{ ...fresh, parent: 1 }];
    await assert.rejects(s.assertExited(), /still running/);
});
test('an in-flight table from before witness acceptance cannot retire history', async () => {
    const q = query(0);
    let rows = [root, q],
        release: (r: ProcessRow[]) => void = () => {};
    let gate = false;
    const s = new ProcessSampler([10], () =>
        gate
            ? new Promise<ProcessRow[]>((r) => {
                  release = r;
              })
            : Promise.resolve(rows),
    );
    await s.sample();
    gate = true;
    const pending = s.sample();
    s.acceptClosedQuery(proof(q), 10);
    release([root]);
    await pending;
    assert.equal(s.historyProof().retiredCount, 0);
    gate = false;
    rows = [root];
    await s.sample();
    assert.equal(s.historyProof().retiredCount, 1);
});
for (const fault of [
    'owner',
    'creation',
    'hash',
    'spawn',
    'exit',
    'pipe',
    'code',
    'signal',
    'extra',
] as const)
    test('invalid query closure remains failed: ' + fault, async () => {
        const q = query(0),
            s = new ProcessSampler([10], async () => [root, q]);
        await s.sample();
        const p: any = proof(q);
        if (fault === 'owner') p.ownerPID = p.parentPID = 20;
        if (fault === 'creation') p.created = '';
        if (fault === 'hash') p.querySHA256 = 'a'.repeat(64);
        if (fault === 'spawn') p.spawn = false;
        if (fault === 'exit') p.exit = false;
        if (fault === 'pipe') p.close = false;
        if (fault === 'code') p.closeCode = 1;
        if (fault === 'signal') p.exitSignal = 'SIGKILL';
        if (fault === 'extra') p.forged = true;
        assert.throws(() => s.acceptClosedQuery(p, 10));
        await assert.rejects(s.assertExited());
        assert.equal(s.historyProof().retiredCount, 0);
    });
test('wrong owner creation, missing liveness, query failure and ambiguous table never prove retirement', async () => {
    for (const fault of ['owner-created', 'missing-created', 'read-failed', 'ambiguous']) {
        const q = query(0);
        let rows = [root, q],
            fail = false;
        const s = new ProcessSampler([10], async () => {
            if (fail) throw Error('Denied OS table');
            return rows;
        });
        await s.sample();
        const p = proof(q);
        if (fault === 'owner-created') p.ownerCreated = 'other';
        s.acceptClosedQuery(p, 10);
        rows =
            fault === 'missing-created'
                ? [root, { ...q, created: '' }]
                : fault === 'ambiguous'
                  ? [root, root]
                  : [root];
        fail = fault === 'read-failed';
        await assert.rejects(s.sample());
        rows = [];
        fail = false;
        await assert.rejects(s.assertExited());
        assert.equal(s.historyProof().retiredCount, 0);
    }
});
test('pending receipt storage remains256 and cannot be unbounded by unseen closed probes', () => {
    const s = new ProcessSampler([10], async () => [root]);
    for (let n = 0; n < 256; n++) s.acceptClosedQuery(proof(query(n)), 10);
    assert.throws(() => s.acceptClosedQuery(proof(query(256)), 10), /witness bound/);
    assert.equal(s.historyProof().pendingClosedQueries, 256);
});
function receiver(
    record: (s: string, d: unknown) => void,
    forward: (batch: unknown) => void,
    hold: (e: unknown) => void,
) {
    const state: any = { sequence: 0, final: null, runtimeDeadline: 10000 };
    const ack: unknown[] = [];
    const port = pilotEvidenceReceiver({
        nonce: 'n',
        bindingSHA256: 'h',
        stage: 'native-electron-store',
        state,
        record,
        reserve: () => {},
        recordReserved: () => {},
        send: (m: any, cb: any) => {
            ack.push(m);
            cb();
        },
        hold,
        clock: () => 0,
        acceptQueryClosures: forward,
    });
    const message = (sequence: number, stage: string, data: unknown) => ({
        kind: 'pilot-evidence',
        nonce: 'n',
        bindingSHA256: 'h',
        sequence,
        stage,
        data,
    });
    return { port, state, ack, message };
}
test('bound receiver durably records closure witness before forwarding it or acknowledging', () => {
    const order: string[] = [];
    const r = receiver(
        () => {
            order.push('durable');
        },
        () => {
            order.push('forward');
        },
        () => assert.fail('Unexpected hold'),
    );
    assert(
        r.port.receive(
            r.message(0, 'startup-process-query-closed', { schema: 1, queries: [proof(query(0))] }),
        ),
    );
    assert.deepEqual(order, ['durable', 'forward']);
    assert.equal(r.ack.length, 1);
});
test('persistence failure holds before receipt admission; late inner final never clears the held owner', () => {
    let held = false,
        forwarded = false;
    const r = receiver(
        () => {
            held = true;
            throw Error('fsync failed');
        },
        () => {
            forwarded = true;
        },
        () => {
            held = true;
        },
    );
    assert.equal(
        r.port.receive(
            r.message(0, 'startup-process-query-closed', { schema: 1, queries: [proof(query(0))] }),
        ),
        false,
    );
    assert(held);
    assert.equal(forwarded, false);
    assert.equal(r.ack.length, 0);
    assert.equal(
        r.port.receive(r.message(0, 'stage-final', { passed: false, startup: { complete: true } })),
        false,
    );
    assert(held);
    assert.equal(r.state.final, null);
});
test('real startup controller preserves overflow facts in referenced hold even if persistence throws', async (t) => {
    const rows = [root, ...Array.from({ length: 256 }, (_, n) => query(n))];
    let captured: any;
    const child: any = Object.assign(new EventEmitter(), {
        pid: 10,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
    });
    const controller = new NativePilotStartup({
        signal: new AbortController().signal,
        deadline: Number(process.hrtime.bigint() / 1000000n) + 100000,
        readTable: async () => rows,
        emit: async () => {},
        hold: () => {
            controller.stopQueryAdmission();
            captured = controller.snapshot();
            throw Error('Hold persistence failed');
        },
    });
    t.after(() => controller.stopQueryAdmission());
    controller.adopt('native-stage', child, () => {});
    await assert.rejects(controller.children.get(child).identityTask, /Hold persistence failed/);
    assert.equal(captured.queryAdmissionClosed, true);
    assert.equal(captured.children[0].processHistory.overflow.unresolved, 257);
    assert.match(captured.children[0].error, /identity bound exceeded/);
    assert(Buffer.byteLength(JSON.stringify(captured)) < 65536);
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await assert.rejects(controller.join());
});
test('query proof requires exact constructor, complete exit and inherited pipe closure', () => {
    const p = proof(query(0));
    assert.deepEqual(validateProcessQueryProof(p), p);
    assert.throws(() => validateProcessQueryProof({ ...p, close: false }));
    assert.throws(() => validateProcessQueryProof({ ...p, querySHA256: '0'.repeat(64) }));
});

test('actual default startup reader publishes joined query proofs in a bounded batch before its final join', async (t) => {
    const events: any[] = [],
        holds: unknown[] = [];
    const manager = new NativePilotStartup({
        signal: new AbortController().signal,
        deadline: Number(process.hrtime.bigint() / 1000000n) + 10000,
        diagnostics: true,
        emit: async (stage, data) => {
            events.push({ stage, data });
        },
        hold: (e) => holds.push(e),
    });
    const child = manager.spawn(
        'controlled-node',
        () =>
            spawn(
                process.execPath,
                [
                    '-e',
                    "const guard=setTimeout(()=>process.exit(9),5000);process.on('message',()=>{clearTimeout(guard);process.disconnect()})",
                ],
                { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
            ),
        (c) => {
            if (c.connected) c.send('stop');
        },
    );
    const childClosed = new Promise<void>((r) => child.once('close', () => r()));
    t.after(async () => {
        manager.stopQueryAdmission();
        if (child.connected) child.send('stop');
        await childClosed;
    });
    await manager.children.get(child).identityTask;
    child.send('stop');
    const result = await manager.join();
    assert(result.complete);
    assert.deepEqual(holds, []);
    assert(result.children[0].joined && result.children[0].observationsDrained);
    const batches = events.filter((e) => e.stage === 'startup-process-query-closed');
    if (process.platform === 'linux') {
        assert.equal(batches.length, 0);
        return;
    }
    assert(batches.length > 0);
    const queries = batches.flatMap((e) => e.data.queries);
    assert(queries.length >= 2);
    for (const q of queries) {
        validateProcessQueryProof(q);
        assert.equal(q.ownerPID, process.pid);
        assert.equal(q.platform, process.platform);
        assert.equal(q.exitCode, 0);
        assert.equal(q.closeCode, 0);
    }
    assert(batches.every((e) => e.data.queries.length <= 16));
});
test('cancellation owns an admitted query until it settles and a later fresh final query completes', async (t) => {
    let release: (rows: ProcessRow[]) => void = () => {},
        reads = 0,
        finished = false;
    const abort = new AbortController(),
        child: any = Object.assign(new EventEmitter(), {
            pid: 10,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        });
    const manager = new NativePilotStartup({
        signal: abort.signal,
        deadline: Number(process.hrtime.bigint() / 1000000n) + 10000,
        emit: async () => {},
        hold: () => assert.fail('Unexpected hold'),
        readTable: () =>
            ++reads === 1
                ? new Promise<ProcessRow[]>((r) => {
                      release = r;
                  })
                : Promise.resolve([]),
    });
    t.after(() => manager.stopQueryAdmission());
    manager.adopt('controlled', child, () => {});
    await Promise.resolve();
    await Promise.resolve();
    abort.abort(Error('cancel during query'));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const joining = manager.join().then((r) => {
        finished = true;
        return r;
    });
    for (let n = 0; n < 10; n++) await Promise.resolve();
    assert.equal(finished, false);
    release([root]);
    assert((await joining).complete);
    assert.equal(reads, 2);
});
test('closed proof input is snapshotted and immutable roots can never be retired', async () => {
    let rows = [root, query(0)];
    const s = new ProcessSampler([10], async () => rows);
    await s.sample();
    const p = proof(query(0));
    s.acceptClosedQuery(p, 10);
    p.ownerCreated = 'mutated';
    rows = [root];
    await s.sample();
    assert.equal(s.historyProof().retiredCount, 1);
    const q = query(1);
    let rootRows = [root, q];
    const roots = new ProcessSampler([10, q.pid], async () => rootRows);
    await roots.sample();
    roots.acceptClosedQuery(proof(q), 10);
    rootRows = [root];
    await assert.rejects(roots.assertExited(), /immutable root/);
});
test('oversized ancestry stops at the first rejected identity and keeps diagnostics bounded', async () => {
    const s = new ProcessSampler([10], async () => [
        root,
        ...Array.from({ length: 1000 }, (_, n) => query(n)),
    ]);
    await assert.rejects(s.sample(), /identity bound/);
    const h = s.historyProof() as any;
    assert.equal(h.unresolved, 257);
    assert.equal(h.overflow.tuples.length, 257);
    assert(h.overflow.discoveryStoppedAtFirstRejection);
    assert(Buffer.byteLength(JSON.stringify(h)) < 65536);
});
test('malformed query frames hold before persistence and before forwarding', () => {
    let writes = 0,
        forwarded = 0,
        holds = 0;
    const r = receiver(
        () => {
            writes++;
        },
        () => {
            forwarded++;
        },
        () => {
            holds++;
        },
    );
    assert.equal(
        r.port.receive(
            r.message(0, 'startup-process-query-closed', {
                schema: 1,
                queries: [{ ...proof(query(0)), close: false }],
            }),
        ),
        false,
    );
    assert.equal(writes, 0);
    assert.equal(forwarded, 0);
    assert.equal(holds, 1);
    assert.equal(r.ack.length, 0);
});
for (const failure of [
    'overflow',
    'unknown-ancestry',
    'live-descendant',
    'late-parent-absent',
    'late-parent-reused',
    'late-grandchild',
    'late-unknown',
])
    test(`real custody lease stays held after ${failure}, child close and late inner final`, async (t) => {
        const hash = 'a'.repeat(64),
            nonce = '9536ac3c-b0ea-44dc-a4b6-9b1feec7975e';
        const binding: any = {
            schema: 1,
            kind: 'windows-hosted-native-readiness-pilot-v1',
            collectionApproval: false,
            host: {
                repository: 'brucerry/embedded-linux-diagnostic-hub',
                attempt: '1',
                run: '39184109993',
                commit: 'a'.repeat(40),
                environment: 'github-hosted',
            },
            nonce,
            principalSID: 'S-1-5-21-1-2-3-500',
            sourceSHA256: hash,
            coveragePolicySHA256: hash,
            pilotPolicySHA256: hash,
            dependenciesSHA256: hash,
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
                            sha256: hash,
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
                                  : 'D:\\report',
                        dev: '1',
                        ino: String(i + 1),
                        ...(k === 'evidenceRoot'
                            ? { identitySHA256: hash }
                            : { descriptorSHA256: hash }),
                    },
                ]),
            ),
            startedAt: 0,
            deadline: 600000,
            limits: pilotLimits,
        };
        const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-query-custody-')),
            marker = path.join(dir, 'controlled.lock');
        const journal = new PilotEvidence(dir);
        const lease = new ProductLease(marker, { nonce, bindingSHA256: bindingDigest(binding) });
        let referenced = false,
            released = false;
        t.after(() => {
            journal.close();
            fs.rmSync(dir, { recursive: true });
        });
        const owner = new SameJobPilotCustody(binding, {
            lease,
            verify: async (b: any) => b,
            record: (stage: any, data: any) => journal.append(stage, data),
            closeEvidence: async () => journal.close(),
            events: new EventEmitter(),
            clock: { now: () => 0, set: () => 0, clear: () => {} },
            executionGate: () => {},
            hold: (state: any, record: any) =>
                createOwnershipHold(state, record, {
                    interval: (() => ({
                        ref() {
                            referenced = true;
                        },
                    })) as any,
                }),
        });
        const token = await owner.acquireAndVerify();
        const child: any = Object.assign(new EventEmitter(), {
            pid: 10,
            connected: true,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            send(_m: any, cb: any) {
                cb?.();
                return true;
            },
        });
        owner.start('real-os-pty', token, binding, () => child);
        child.emit('spawn');
        let custodyChildClosed = false;
        const manager = new NativePilotStartup({
            signal: new AbortController().signal,
            deadline: Number(process.hrtime.bigint() / 1000000n) + 10000,
            readTable: async () =>
                failure === 'overflow'
                    ? [root, ...Array.from({ length: 256 }, (_, n) => query(n))]
                    : failure.startsWith('late-')
                      ? custodyChildClosed
                          ? failure === 'late-grandchild'
                              ? [{ ...query(1), parent: query(0).pid }]
                              : failure === 'late-parent-reused'
                                ? [{ ...root, created: '2026-10-20T03:49:24.0000000Z' }, query(0)]
                                : failure === 'late-unknown'
                                  ? [{ ...query(0), created: '' }]
                                  : [query(0)]
                          : failure === 'late-grandchild'
                            ? [root, query(0)]
                            : [root]
                      : failure === 'unknown-ancestry'
                        ? custodyChildClosed
                            ? []
                            : [root, { ...query(0), created: '' }]
                        : custodyChildClosed
                          ? [{ ...query(0), parent: 1 }]
                          : [root, query(0)],
            emit: async () => {},
            hold: (e) => {
                manager.stopQueryAdmission();
                owner.hold(e);
            },
        });
        t.after(() => manager.stopQueryAdmission());
        manager.adopt('stage', child, () => {});
        if (failure === 'live-descendant' || failure.startsWith('late-'))
            await manager.children.get(child).identityTask;
        else
            await assert.rejects(
                manager.children.get(child).identityTask,
                failure === 'overflow' ? /identity bound/ : /creation|chronology/,
            );
        const state: any = { sequence: 0, final: null, runtimeDeadline: 1000 };
        const receiver = pilotEvidenceReceiver({
            nonce,
            bindingSHA256: owner.hash,
            stage: 'real-os-pty',
            state,
            record: (s: any, d: any) => journal.append(s, d),
            reserve: () => {},
            recordReserved: (s: any, d: any) => journal.append(s, d),
            send: (_m: any, cb: any) => cb(),
            hold: (e: any) => owner.hold(e),
            clock: () => 0,
            acceptQueryClosures: (b: any) => manager.acceptQueryClosures(child, b),
        });
        assert(
            receiver.receive({
                kind: 'pilot-evidence',
                nonce,
                bindingSHA256: owner.hash,
                sequence: 0,
                stage: 'stage-final',
                data: {
                    stage: 'real-os-pty',
                    passed: false,
                    startup: { complete: true },
                    leafReceiptsClosed: true,
                    descendantsClosed: true,
                },
            }),
        );
        custodyChildClosed = true;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        if (failure === 'live-descendant' || failure.startsWith('late-'))
            await assert.rejects(manager.join());
        assert(state.final);
        await assert.rejects(
            owner.release({ inputsUnchanged: true, rootsCleanupClosed: true, resultClosed: true }),
        );
        released = owner.state === 'released';
        assert.equal(released, false);
        assert.equal(owner.state, 'held');
        assert(referenced);
        assert(fs.existsSync(marker));
        assert.equal(lease.state().released, false);
        assert.equal(journal.entry.attempted, false);
    });

async function queryReaderControl(mode: string) {
    const context = vm.createContext({ Buffer, process: { pid: 10, platform: 'win32' } }),
        proofs: any[] = [];
    let invocation: any;
    const text = fs.readFileSync(
        path.join(import.meta.dirname, 'fixtures/memory-resource-processes.ts'),
        'utf8',
    );
    const code = transformSync(text, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
    const fakeExec = (file: any, args: any, options: any, callback: any) => {
        invocation = { file, args, options };
        const child: any = Object.assign(new EventEmitter(), { pid: 20 });
        queueMicrotask(() => {
            child.emit('spawn');
            if (mode !== 'missing-exit') child.emit('exit', mode === 'bad-exit' ? 1 : 0, null);
            const owner = {
                ProcessId: 10,
                ParentProcessId: 1,
                Created: root.created,
                WorkingSetSize: 1,
            };
            const query = {
                ProcessId: 20,
                ParentProcessId: 10,
                Created: mode === 'missing-creation' ? '' : '2026-10-20T03:49:22.0000000Z',
                WorkingSetSize: 1,
            };
            const rows =
                mode === 'missing-owner'
                    ? [query]
                    : mode === 'missing-query'
                      ? [owner]
                      : [owner, query];
            const bytes = Buffer.from(mode === 'invalid-json' ? '[' : JSON.stringify(rows));
            callback(mode === 'buffer-failure' ? Error('stdout maxBuffer exceeded') : null, bytes);
            if (mode !== 'missing-pipe-close')
                child.emit('close', mode === 'bad-exit' ? 1 : 0, null);
        });
        return child;
    };
    const imports: Record<string, any> = {
        'node:fs/promises': { default: fs.promises },
        'node:child_process': { execFile: fakeExec },
        'node:assert/strict': { default: assert },
        'node:crypto': { createHash: (await import('node:crypto')).createHash },
        '../../scripts/lib/pilot-process-query.mjs': queryProofModule,
    };
    const module = new vm.SourceTextModule(code, { context });
    await module.link(async (specifier) => {
        const values = imports[specifier];
        assert(values, 'Unexpected reader import ' + specifier);
        const linked = new vm.SyntheticModule(
            Object.keys(values),
            () => {
                for (const k of Object.keys(values)) linked.setExport(k, values[k]);
            },
            { context },
        );
        return linked;
    });
    await module.evaluate();
    const read = (module.namespace as any).readProcessTable;
    return {
        query: () =>
            read((proof: any) => {
                proofs.push(proof);
            }),
        proofs,
        invocation: () => invocation,
    };
}
for (const mode of [
    'success',
    'missing-exit',
    'missing-pipe-close',
    'bad-exit',
    'missing-creation',
    'missing-owner',
    'missing-query',
    'buffer-failure',
    'invalid-json',
])
    test('actual process-table reader closure gate: ' + mode, async () => {
        const c = await queryReaderControl(mode);
        if (mode === 'success') {
            const rows = await c.query();
            assert.equal(rows.length, 2);
            assert.equal(c.proofs.length, 1);
            validateProcessQueryProof(c.proofs[0]);
        } else {
            await assert.rejects(c.query());
            assert.equal(c.proofs.length, 0);
        }
        const call = c.invocation();
        assert.equal(call.file, 'powershell.exe');
        assert.equal(call.options.timeout, 10000);
        assert.equal(call.options.maxBuffer, 4 * 1024 ** 2);
        assert.equal(call.options.encoding, 'buffer');
    });
