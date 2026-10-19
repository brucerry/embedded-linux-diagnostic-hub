import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import * as reports from '../scripts/lib/startup-identity-report.mjs';
import { runtimeDiagnostics } from '../scripts/lib/pilot-runtime-startup.mjs';
import { terminalRuntimeDiagnostics } from '../scripts/lib/pilot-terminal-diagnostics.mjs';
import { pilotEvidenceReceiver } from '../scripts/lib/pilot-evidence-channel.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { OwnedHost } from './fixtures/memory-resource-gateway-process';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const stage = 'gateway-host-teardown',
    nonce = 'lifecycle-controlled-nonce',
    binding = 'c'.repeat(64);
const now = () => Number(process.hrtime.bigint() / 1000000n);
const tick = () => new Promise<void>((r) => setImmediate(r));
function payload(bytes: number) {
    const data: any = {
        role: 'ssh-fixture-node',
        pid: 42,
        created: '2026-10-19T00:00:00.0000000Z',
        shutdown: { resources: { timers: 0 }, events: [{ owner: 42, event: 'closed' }] },
        release: { resources: { ipcMessageListeners: 0, ipcDisconnectListeners: 0, timers: 0 } },
        termination: { kind: 'exited', code: 0, signal: null },
        childExit: 'normal-zero',
        padding: '',
    };
    const base = Buffer.byteLength(JSON.stringify({ stage, data }));
    assert(bytes >= base);
    data.padding = 'x'.repeat(bytes - base);
    assert.equal(Buffer.byteLength(JSON.stringify({ stage, data })), bytes);
    return data;
}
function wire(
    options: {
        mutate?: (m: any) => void;
        blockAck?: (m: any) => boolean;
        persistFailure?: boolean;
        ackFailure?: boolean;
        deadlineMs?: number;
        seed?: number;
    } = {},
) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-lifecycle-wire-'));
    const journal = new PilotEvidence(dir);
    const marker = path.join(dir, 'fixture-marker.lock');
    const lease = new ProductLease(marker, { nonce, bindingSHA256: binding });
    lease.acquire();
    const frames: any[] = [],
        acks: any[] = [],
        records: any[] = [],
        holds: any[] = [],
        blocked: any[] = [];
    let charged = options.seed ?? 0,
        held: any,
        ref = false,
        maxOutstanding = 0,
        outstanding = 0;
    const hold = (e: unknown) => {
        holds.push(e);
        if (!held)
            held = createOwnershipHold(
                { reason: String(e) },
                () => {
                    assert(ref);
                    journal.append('ownership-held.json', { reason: String(e) });
                },
                {
                    interval: (() => ({
                        ref() {
                            ref = true;
                        },
                    })) as unknown as typeof setInterval,
                },
            );
    };
    const fake: any = Object.assign(new EventEmitter(), {
        connected: true,
        hrtime: process.hrtime,
    });
    const state: any = { sequence: 0, final: null, runtimeReady: false, runtimeDeadline: Infinity };
    const reserve = (bytes: number) => {
        assert(charged + bytes <= 10485760, 'Global evidence limit');
        charged += bytes;
    };
    const append = (s: string, d: any) => {
        if (options.persistFailure) throw Error('controlled fsync/write failure');
        journal.append(s, d);
        records.push({ stage: s, data: d });
    };
    const receiver = pilotEvidenceReceiver({
        nonce,
        bindingSHA256: binding,
        stage: 'native-electron-store',
        state,
        acceptQueryClosures: undefined,
        reserve,
        record: (s: string, d: any) => {
            reserve(Buffer.byteLength(JSON.stringify({ stage: s, data: d })) + 1024);
            append(s, d);
        },
        recordReserved: append,
        hold,
        clock: () => 0,
        send(m: any, cb: any) {
            const lines = fs.readFileSync(path.join(dir, 'pilot.jsonl'), 'utf8').trim().split('\n');
            assert(lines.length >= records.length, 'ACK follows actual durable append');
            acks.push(m);
            const deliver = () => {
                outstanding--;
                if (options.ackFailure) {
                    cb(Error('controlled ACK failure'));
                    fake.emit('disconnect');
                } else {
                    fake.emit('message', m);
                    cb(null);
                }
            };
            if (options.blockAck?.(m)) blocked.push(deliver);
            else deliver();
        },
    });
    fake.send = (input: any, callback: any) => {
        const m = JSON.parse(JSON.stringify(input));
        options.mutate?.(m);
        frames.push(m);
        assert(Buffer.byteLength(JSON.stringify(m)) <= 65536);
        outstanding++;
        maxOutstanding = Math.max(maxOutstanding, outstanding);
        const valid = receiver.receive(m);
        if (!valid) outstanding--;
        callback(valid ? null : Error('Parent refused frame'));
        return true;
    };
    const module: any = { exports: {} };
    vm.runInNewContext(
        transformSync(fs.readFileSync('tests/fixtures/pilot-stage-channel.ts', 'utf8'), {
            loader: 'ts',
            format: 'cjs',
            target: 'es2022',
        }).code,
        {
            module,
            exports: module.exports,
            process: fake,
            Buffer,
            setTimeout,
            clearTimeout,
            require(spec: string) {
                if (spec === 'node:assert/strict') return assert;
                assert.equal(spec, '../../scripts/lib/startup-identity-report.mjs');
                return reports;
            },
        },
    );
    const channel = module.exports.stageChannel(nonce, binding, new AbortController().signal, {
        deadline: options.deadlineMs ? now() + options.deadlineMs : Infinity,
    });
    const diagnostics = runtimeDiagnostics(channel, hold);
    const replay = () => {
        const decoder = reports.startupIdentityDecoder(),
            logical: any[] = [];
        for (const r of records) {
            const s = r.stage.slice('native-electron-store:'.length);
            if (s === reports.identityManifestStage || s === reports.identityPartStage) {
                const value = decoder.accept(s, r.data);
                if (value) logical.push(value);
            } else decoder.assertComplete();
        }
        decoder.assertComplete();
        return logical;
    };
    return {
        dir,
        journal,
        marker,
        lease,
        frames,
        acks,
        records,
        holds,
        state,
        receiver,
        diagnostics,
        channel,
        hold,
        replay,
        blocked,
        get charged() {
            return charged;
        },
        get maxOutstanding() {
            return maxOutstanding;
        },
        get held() {
            return held;
        },
        get referenced() {
            return ref;
        },
        dispose() {
            journal.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
function retainEvidence(name: string, w: ReturnType<typeof wire>, details: unknown = {}) {
    const root = process.env.HUB_LIFECYCLE_TRANSPORT_EVIDENCE;
    if (!root) return;
    fs.mkdirSync(root, { recursive: true });
    const journal = fs.readFileSync(path.join(w.dir, 'pilot.jsonl'));
    fs.writeFileSync(path.join(root, name + '.jsonl'), journal, { flag: 'wx' });
    fs.writeFileSync(
        path.join(root, name + '.json'),
        JSON.stringify(
            {
                schema: 1,
                controlledPortsOnly: true,
                WindowsClosureQualification: false,
                details,
                journalSHA256: sha(journal),
                frames: w.frames.map((m) => ({
                    stage: m.stage,
                    sequence: m.sequence,
                    bytes: Buffer.byteLength(JSON.stringify(m)),
                })),
                durableACKs: w.acks.length,
                maximumOutstandingCredit: w.maxOutstanding,
                ownerHeld: Boolean(w.held),
                markerPresent: fs.existsSync(w.marker),
                final: w.state.final,
                logical: w.replay(),
            },
            null,
            2,
        ) + '\n',
        { flag: 'wx' },
    );
}
for (const size of [32767, 32768, 32769, 65535, 65536, 65537, 71047, 131072])
    test('lossless truthful lifecycle report at exact logical bytes ' + size, async () => {
        const w = wire();
        try {
            const data = payload(size);
            await reports.reportLifecycleEvidence(w.diagnostics.emit, stage, data);
            await w.diagnostics.drain();
            w.receiver.assertComplete();
            const [value] = w.replay();
            assert.deepEqual(value.data, data);
            assert.equal(value.stage, stage);
            assert.equal(value.bytes, size);
            assert.equal(value.sha256, sha(Buffer.from(JSON.stringify({ stage, data }))));
            assert.equal(value.ordinal, 1);
            assert.equal(value.parts, Math.ceil(size / 32768));
            assert.equal(w.frames.length, value.parts + 1);
            assert.equal(w.acks.length, w.frames.length);
            assert.equal(w.maxOutstanding, 1);
            assert.equal(w.holds.length, 0);
            if (size === 71047)
                retainEvidence('logical-71047', w, { exactOriginalByteCount: size });
            for (const line of fs
                .readFileSync(path.join(w.dir, 'pilot.jsonl'), 'utf8')
                .trim()
                .split('\n'))
                assert(Buffer.byteLength(line + '\n') <= 65536);
        } finally {
            w.dispose();
        }
    });
test('legacy ordinary 71047-byte teardown refuses while shared lossless path preserves every byte', async () => {
    const w = wire();
    try {
        const data = payload(71047);
        assert.throws(() => w.diagnostics.emit(stage, data), /frameBytes.*71047/);
        assert.equal(w.frames.length, 0);
        await reports.reportLifecycleEvidence(w.diagnostics.emit, stage, data);
        assert.deepEqual(w.replay()[0].data, data);
    } finally {
        w.dispose();
    }
});
test('lifecycle ordinals accept identical observations without relaxing startup replay protection', async () => {
    const w = wire();
    try {
        const data = payload(1000);
        await reports.reportLifecycleEvidence(w.diagnostics.emit, stage, data);
        await reports.reportLifecycleEvidence(w.diagnostics.emit, stage, data);
        const logical = w.replay();
        assert.deepEqual(
            logical.map((r) => r.ordinal),
            [1, 2],
        );
        assert.deepEqual(logical[0].data, logical[1].data);
        const dec = reports.startupIdentityDecoder(),
            plan = reports.planStartupIdentity('actual-native-product', { same: true });
        for (const f of plan.frames()) dec.accept(f.stage, f.data);
        assert.throws(() => dec.accept(reports.identityManifestStage, plan.manifest), /Duplicate/);
    } finally {
        w.dispose();
    }
});
for (const s of reports.lifecycleEvidenceStages)
    test('audited lifecycle stage is lossless and ordinary bypass is refused: ' + s, async () => {
        const w = wire();
        try {
            const data = {
                identity: { pid: 42, created: 'control' },
                events: ['full'],
                padding: 'x'.repeat(70000),
            };
            await reports.reportLifecycleEvidence(w.diagnostics.emit, s, data);
            assert.deepEqual(w.replay()[0].data, data);
            assert.equal(w.replay()[0].stage, s);
            const state: any = {
                sequence: 0,
                final: null,
                runtimeReady: false,
                runtimeDeadline: Infinity,
            };
            let held = false;
            const recv = pilotEvidenceReceiver({
                nonce,
                bindingSHA256: binding,
                stage: 'control',
                state,
                acceptQueryClosures: undefined,
                record() {
                    assert.fail('bypass persisted');
                },
                reserve() {},
                recordReserved() {},
                send() {},
                hold() {
                    held = true;
                },
                clock: () => 0,
            });
            assert.equal(
                recv.receive({
                    kind: 'pilot-evidence',
                    nonce,
                    bindingSHA256: binding,
                    sequence: 0,
                    stage: s,
                    data: { tiny: true },
                }),
                false,
            );
            assert(held);
            assert.equal(state.final, null);
        } finally {
            w.dispose();
        }
    });
test('durable last ACK gates publication completion and queued ordinary data cannot interleave', async () => {
    const w = wire({ blockAck: (m) => m.sequence === 3 });
    try {
        const data = payload(71047);
        let done = false;
        const publication = reports
            .reportLifecycleEvidence(w.diagnostics.emit, stage, data)
            .then(() => {
                done = true;
            });
        const later = w.diagnostics.emit('after-lifecycle', { done: true });
        for (let i = 0; i < 20 && !w.blocked.length; i++) await tick();
        assert.equal(done, false);
        assert.equal(w.frames.length, 4);
        assert(w.frames.every((r) => r.stage !== 'after-lifecycle'));
        assert.equal(w.blocked.length, 1);
        w.blocked.shift()();
        await publication;
        await later;
        assert.equal(done, true);
        assert.equal(w.frames.at(-1).stage, 'after-lifecycle');
        assert.equal(w.maxOutstanding, 1);
    } finally {
        w.dispose();
    }
});
const mutations: any = {
    'missing manifest': (m: any) => {
        if (m.sequence === 0) m.stage = reports.identityPartStage;
    },
    'duplicate manifest': (m: any) => {
        if (m.sequence === 1) {
            m.stage = reports.identityManifestStage;
            m.data = { ...reports.planStartupIdentity(stage, payload(71047), 1).manifest };
        }
    },
    'out of order part': (m: any) => {
        if (m.sequence === 1) m.data.index = 1;
    },
    'duplicate part': (m: any) => {
        if (m.sequence === 2) m.data.index = 0;
    },
    'truncated part': (m: any) => {
        if (m.sequence === 1) m.data.base64 = m.data.base64.slice(0, -4);
    },
    'corrupt part': (m: any) => {
        if (m.sequence === 1)
            m.data.base64 = (m.data.base64[0] === 'A' ? 'B' : 'A') + m.data.base64.slice(1);
    },
    'wrong ordinal': (m: any) => {
        if (m.sequence === 1) m.data.ordinal = 2;
    },
    'out of order manifest ordinal': (m: any) => {
        if (m.sequence === 0) m.data.ordinal = 2;
    },
    'foreign binding': (m: any) => {
        if (m.sequence === 1) m.bindingSHA256 = 'b'.repeat(64);
    },
    'foreign nonce': (m: any) => {
        if (m.sequence === 1) m.nonce = 'foreign';
    },
    'foreign sequence': (m: any) => {
        if (m.sequence === 1) m.sequence = 19;
    },
    'role corruption': (m: any) => {
        if (m.sequence === 1) {
            const b = Buffer.from(m.data.base64, 'base64');
            const text = b.toString();
            const other = text.replace('ssh-fixture-node', 'bad-fixture-node');
            m.data.base64 = Buffer.from(other).toString('base64');
        }
    },
    'control stage smuggling': (m: any) => {
        if (m.sequence === 0) m.data.stage = 'stage-final';
    },
};
for (const [label, mutate] of Object.entries(mutations))
    test('real parent/queue retains ownership on ' + label, async () => {
        const w = wire({ mutate: mutate as any });
        try {
            await assert.rejects(
                reports.reportLifecycleEvidence(w.diagnostics.emit, stage, payload(71047)),
            );
            assert(w.holds.length > 0);
            assert(w.held && w.referenced);
            assert(fs.existsSync(w.marker));
            assert.equal(w.state.final, null);
            assert.throws(() => w.receiver.assertComplete());
            await assert.rejects(w.diagnostics.drain());
        } finally {
            w.dispose();
        }
    });
for (const mode of ['persistence', 'ACK', 'missing ACK'] as const)
    test('publication ' + mode + ' failure never supplies release or completion', async () => {
        const w = wire({
            persistFailure: mode === 'persistence',
            ackFailure: mode === 'ACK',
            blockAck: mode === 'missing ACK' ? () => true : undefined,
            deadlineMs: mode === 'missing ACK' ? 150 : undefined,
        });
        try {
            await assert.rejects(
                reports.reportLifecycleEvidence(w.diagnostics.emit, stage, payload(71047)),
            );
            assert(w.holds.length > 0 && w.held && w.referenced);
            assert(fs.existsSync(w.marker));
            assert.equal(w.state.final, null);
            await assert.rejects(w.diagnostics.drain());
            if (mode === 'missing ACK')
                assert.throws(() => w.receiver.assertComplete(), /incomplete/);
        } finally {
            w.dispose();
        }
    });
test('logical/row/total/pending preflight reserves atomically before any lifecycle frame', async () => {
    const d = runtimeDiagnostics(
        async () => assert.fail('frame before reservation'),
        () => {},
    );
    assert.throws(
        () => d.emit.publishIdentity(stage, { padding: 'x'.repeat(4194304) }),
        /logicalBytes/,
    );
    for (const counter of ['rows', 'totalBytes', 'pendingBytes']) {
        let sent = 0;
        const blocked = new Promise(() => {});
        const x = runtimeDiagnostics(
            async (name: string) => {
                assert.notEqual(name, reports.identityManifestStage);
                sent++;
                if (counter !== 'totalBytes') return blocked;
            },
            () => {},
        );
        if (counter === 'rows') for (let i = 0; i < 1023; i++) void x.emit('small', {});
        if (counter === 'totalBytes')
            for (let i = 0; i < 160; i++) await x.emit('large', { padding: 'x'.repeat(65000) });
        if (counter === 'pendingBytes')
            for (let i = 0; i < 4; i++) void x.emit('large', { padding: 'x'.repeat(65000) });
        assert.throws(() => x.emit.publishIdentity(stage, payload(71047)), new RegExp(counter));
        assert.equal(sent, counter === 'totalBytes' ? 160 : 0);
    }
});
test('maximum logical bytes, split UTF8 and ordinal boundaries retain exact schemas', () => {
    for (const bytes of [4194304]) {
        const data = payload(bytes);
        const plan = reports.planStartupIdentity(stage, data, 1);
        const dec = reports.startupIdentityDecoder();
        let value: any;
        for (const f of plan.frames()) value = dec.accept(f.stage, f.data);
        dec.assertComplete();
        assert.equal(value.bytes, bytes);
        assert.equal(value.sha256, sha(Buffer.from(JSON.stringify({ stage, data }))));
        assert.deepEqual(value.data, data);
    }
    assert.throws(() => reports.planStartupIdentity(stage, payload(4194305), 1), /logicalBytes/);
    const data = { padding: '界🙂'.repeat(12000) };
    const dec = reports.startupIdentityDecoder();
    let value: any;
    for (const f of reports.planStartupIdentity(stage, data, 1).frames())
        value = dec.accept(f.stage, f.data);
    assert.deepEqual(value.data, data);
    for (const ordinal of [undefined, 0, -1, 1.5, 1025, NaN])
        assert.throws(() => reports.planStartupIdentity(stage, {}, ordinal), /ordinal/);
    assert.equal(reports.planStartupIdentity(stage, {}, 1024).manifest.ordinal, 1024);
    assert.throws(
        () => reports.planStartupIdentity('actual-native-product', {}, 1),
        /cannot carry/,
    );
    const plan = reports.planStartupIdentity(stage, {}, 1);
    for (const mutate of [
        (m: any) => {
            delete m.ordinal;
        },
        (m: any) => {
            m.extra = true;
        },
        (m: any) => {
            m.ordinal = 0;
        },
    ]) {
        const manifest = { ...plan.manifest };
        mutate(manifest);
        assert.throws(() =>
            reports.startupIdentityDecoder().accept(reports.identityManifestStage, manifest),
        );
    }
});
test('ordinary reporter preserves repeated lifecycle order with interleaved startup and sticky failure', async () => {
    const frames: any[] = [];
    const emit = async (stage: string, data: any) => {
        frames.push({ stage, data });
    };
    const data = payload(71047);
    await Promise.all([
        reports.reportLifecycleEvidence(emit, stage, data),
        reports.reportStartupIdentity(emit, 'actual-native-product', { identity: 'full' }),
        reports.reportLifecycleEvidence(emit, stage, data),
    ]);
    const dec = reports.startupIdentityDecoder();
    const values = frames.map((f) => dec.accept(f.stage, f.data)).filter(Boolean);
    dec.assertComplete();
    assert.deepEqual(
        values.map((v) => v.ordinal),
        [1, undefined, 2],
    );
    assert.deepEqual(values[0].data, data);
    assert.deepEqual(values[2].data, data);
    assert.throws(() => dec.accept(reports.identityManifestStage, frames[0].data), /ordering/);
    const failure = Error('ordinary persistence refusal');
    let sent = 0;
    const reject = async () => {
        sent++;
        throw failure;
    };
    await assert.rejects(
        reports.reportLifecycleEvidence(reject, stage, data),
        (e) => e === failure,
    );
    await assert.rejects(
        reports.reportLifecycleEvidence(reject, stage, data),
        (e) => e === failure,
    );
    assert.equal(sent, 1);
});
test('PTY diagnostic queue shares lifecycle ordering while preserving terminal hold reservation', async () => {
    const frames: any[] = [],
        holds: unknown[] = [];
    const q = terminalRuntimeDiagnostics(
        async (stage: string, data: any) => {
            frames.push({ stage, data });
        },
        (e: unknown) => holds.push(e),
    );
    const terminal = q.reserveTerminal({ rows: 4, bytes: 32768, pendingBytes: 16384 });
    const data = payload(71047);
    await reports.reportLifecycleEvidence(q.emit, stage, data);
    await reports.reportLifecycleEvidence(q.emit, stage, data);
    const dec = reports.startupIdentityDecoder();
    const logical = frames.map((f) => dec.accept(f.stage, f.data)).filter(Boolean);
    assert.deepEqual(
        logical.map((v) => v.ordinal),
        [1, 2],
    );
    assert.deepEqual(
        logical.map((v) => v.data),
        [data, data],
    );
    terminal.enterHold();
    await assert.rejects(reports.reportLifecycleEvidence(q.emit, stage, data), /admission closed/);
    await terminal.emit('stage-held', { held: true });
    await q.drain();
    assert.equal(frames.at(-1).stage, 'stage-held');
    assert.equal(holds.length, 0);
});
test('parent total reservation refusal persists no manifest and retains owner', async () => {
    const w = wire({ seed: 10485750 });
    try {
        await assert.rejects(
            reports.reportLifecycleEvidence(w.diagnostics.emit, stage, payload(71047)),
        );
        assert(w.held && w.referenced);
        assert.equal(w.records.length, 0);
        assert.equal(w.state.final, null);
    } finally {
        w.dispose();
    }
});
test('unknown/control stages and foreign module plans cannot masquerade as lifecycle evidence', async () => {
    const d = runtimeDiagnostics(
        async () => {},
        () => {},
    );
    for (const name of ['stage-final', 'stage-held', 'runtime-ready', 'made-up'])
        await assert.rejects(reports.reportLifecycleEvidence(d.emit, name, {}), /allowlist/);
    const foreign = await import(
        pathToFileURL(path.resolve('scripts/lib/startup-identity-report.mjs')).href +
            '?foreignLifecycle=true'
    );
    assert.throws(
        () => reports.requireIdentityPlan(foreign.planStartupIdentity(stage, payload(1000), 1)),
        /validated plan/,
    );
    const own = reports.planStartupIdentity(stage, payload(1000), 1);
    assert.throws(() => reports.requireIdentityPlan({ ...own }), /validated plan/);
});
function child(role: string, pid: number, metrics: any) {
    const c: any = Object.assign(new EventEmitter(), { pid, connected: true });
    let ended = false;
    const finish = () => {
        if (ended) return;
        ended = true;
        c.emit('exit', 0, null);
        c.connected = false;
        c.emit('close', 0, null);
    };
    c.kill = () => {
        finish();
        return true;
    };
    c.send = (m: any, cb: any) => {
        cb?.();
        queueMicrotask(() => {
            c.emit('message', {
                version: 1,
                nonce: m.nonce,
                pid,
                role,
                id: m.id,
                ok: true,
                value: structuredClone(metrics[m.action]),
            });
            if (m.action === 'release') setImmediate(finish);
        });
        return true;
    };
    return c;
}
function nativeClose(metrics: any, emit: any) {
    const source = fs.readFileSync('tests/fixtures/memory-resource-gateway-process.ts', 'utf8');
    const ast = ts.createSourceFile(
        'gateway.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    let method: any;
    function visit(n: ts.Node) {
        if (
            ts.isMethodDeclaration(n) &&
            n.name?.getText(ast) === 'close' &&
            ts.isObjectLiteralExpression(n.parent)
        )
            method = n;
        ts.forEachChild(n, visit);
    }
    visit(ast);
    assert(method);
    const text = 'let closed=false;return ({' + method.getText(ast) + ', isClosed:()=>closed});';
    const code = ts.transpileModule(text, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const calls: string[] = [],
        hosts = ['ssh-fixture-node', 'gateway-node'].map(
            (role, i) =>
                new OwnedHost(role as any, 'normal', {
                    forkChild: (() => child(role, 42 + i, metrics)) as any,
                    terminationMs: 1000,
                }),
        );
    const histories = hosts.map((host) => ({
        host,
        pid: host.child.pid,
        created: 'controlled-' + host.child.pid,
        mayExit: false,
    }));
    const factory = new Function(
        'exclusive',
        'beforeStop',
        'hosts',
        'histories',
        'emit',
        'assertHistoryExited',
        'abortAll',
        'reportLifecycleEvidence',
        code,
    );
    const manager = factory(
        async (f: any) => f(),
        async (s: string) => {
            calls.push(s);
            return [];
        },
        hosts,
        histories,
        emit,
        async () => {
            calls.push('history-asserted');
            for (const h of hosts) assert.equal(h.terminalState?.kind, 'exited');
        },
        async (e: any) => {
            calls.push('abortAll');
            await Promise.all(hosts.map((h) => h.abort()));
            throw e;
        },
        reports.reportLifecycleEvidence,
    );
    return { manager, calls, hosts };
}
function snapshot(count: number) {
    if (process.env.HUB_GATEWAY_TEARDOWN_SNAPSHOT) {
        const file = process.env.HUB_GATEWAY_TEARDOWN_SNAPSHOT;
        assert(fs.statSync(file).size <= 65536);
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(value.events.length, 197);
        while (value.events.length < count)
            value.events.push({ ...value.events.at(-1), sequence: value.events.length + 1 });
        value.cache.events = value.events.length;
        return value;
    }
    return {
        owners: { clients: 0, channels: 0, pumps: 0 },
        services: { listening: false },
        cache: { events: count, eventLimit: 256 },
        totals: { stdoutBytes: 65536 },
        events: Array.from({ length: count }, (_, i) => ({
            sequence: i,
            event: 'program-complete',
            command: 'x'.repeat(220),
        })),
    };
}
for (const count of [0, 197, 256])
    test(
        'actual gateway close and OwnedHost preserve full ' +
            count +
            '-event shutdown/release before closed',
        async () => {
            const w = wire({ blockAck: (m) => m.sequence === 0 });
            const resources = { ipcMessageListeners: 0, ipcDisconnectListeners: 0, timers: 0 };
            const raw = snapshot(count);
            if (count === 0) {
                raw.events = [];
                raw.cache.events = 0;
            }
            const metrics = {
                shutdown: { resources, fixtureOwnership: raw },
                release: { resources, fixtureOwnership: raw },
            };
            const x = nativeClose(metrics, w.diagnostics.emit);
            try {
                let done = false;
                const close = x.manager.close().then(() => {
                    done = true;
                });
                for (let i = 0; i < 30 && !w.blocked.length; i++) await tick();
                assert(!done && !x.manager.isClosed());
                assert(!x.calls.includes('history-asserted'));
                w.blocked.shift()();
                await close;
                await w.diagnostics.drain();
                assert(x.manager.isClosed());
                assert(x.calls.includes('history-asserted'));
                const logical = w.replay();
                assert.equal(logical.length, 2);
                for (const r of logical) {
                    assert.equal(r.stage, stage);
                    assert.deepEqual(r.data.shutdown, metrics.shutdown);
                    assert.deepEqual(r.data.release, metrics.release);
                    assert.deepEqual(r.data.termination, { kind: 'exited', code: 0, signal: null });
                    assert.equal(r.data.childExit, 'normal-zero');
                }
                assert.equal(w.maxOutstanding, 1);
                assert.equal(w.holds.length, 0);
                retainEvidence('actual-gateway-' + count, w, {
                    eventCount: count,
                    actualOwnedHost: true,
                    actualManagerMethodASTExtracted: true,
                    beforeFirstACKClosed: false,
                    afterAllACKsClosed: x.manager.isClosed(),
                    historyAsserted: x.calls.includes('history-asserted'),
                    snapshotFile: process.env.HUB_GATEWAY_TEARDOWN_SNAPSHOT ?? null,
                });
            } finally {
                await Promise.all(x.hosts.map((h) => h.abort()));
                w.dispose();
            }
        },
    );
test('actual gateway publication failure preserves original refusal and cannot set closed', async () => {
    const w = wire({ persistFailure: true });
    const resources = { ipcMessageListeners: 0, ipcDisconnectListeners: 0, timers: 0 };
    const x = nativeClose(
        {
            shutdown: { resources, fixtureOwnership: snapshot(256) },
            release: { resources, fixtureOwnership: snapshot(256) },
        },
        w.diagnostics.emit,
    );
    try {
        await assert.rejects(x.manager.close());
        assert(!x.manager.isClosed());
        assert(!x.calls.includes('history-asserted'));
        assert(x.calls.includes('abortAll'));
        assert(w.held && w.referenced && fs.existsSync(w.marker));
    } finally {
        await Promise.all(x.hosts.map((h) => h.abort()));
        w.dispose();
    }
});
