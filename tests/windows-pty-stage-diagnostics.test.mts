// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import {
    ptyStageTimeline,
    timelineLimits,
    timelinePhases,
    timelineOrigins,
    stageClockMapping,
    mappedStageInterval,
    stageIntervalOrder,
    validateStageClock,
    validateTimelineRecord,
} from '../scripts/lib/pty-stage-timeline.mjs';
import { terminalRuntimeDiagnostics } from '../scripts/lib/pilot-terminal-diagnostics.mjs';
import { pilotEvidenceReceiver } from '../scripts/lib/pilot-evidence-channel.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { NativeConsoleJournal } from '../electron/console-journal';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const turns = async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve();
};
function deferred() {
    let resolve, reject;
    const promise = new Promise((r, j) => {
        resolve = r;
        reject = j;
    });
    return { promise, resolve, reject };
}
function fixture({ emit, clock, hold } = {}) {
    const frames = [],
        holds = [];
    let n = 0;
    const trace = ptyStageTimeline({
        deadline: 26000,
        pid: 123,
        clock:
            clock ??
            (() => ({ hrBefore: 1000 + 3 * n, perfUs: 5000 + 3000 * n++, hrAfter: 999 + 3 * n })),
        emit: emit ?? (async (stage, data) => frames.push({ stage, data })),
        hold: (e) => {
            holds.push(String(e));
            hold?.(e);
        },
    });
    return { trace, frames, holds };
}
test('complete fixed phase ledger and eight interactions, no command/path/output retention', async () => {
    const f = fixture();
    let calls = 0;
    for (const name of timelinePhases)
        await f.trace.phase(name, async () => {
            calls++;
        });
    await f.trace.finish();
    assert.equal(calls, timelinePhases.length);
    const data = f.frames[0].data;
    validateTimelineRecord('pty-stage-timeline', data);
    assert(data.phaseLedgerComplete);
    assert.equal(data.events.length, timelinePhases.length * 2);
    assert.deepEqual(data.missingPhases, []);
    assert.deepEqual(data.pendingPhases, []);
    assert.equal(data.authority, false);
    assert(!JSON.stringify(data).includes('command'));
    assert.equal(f.holds.length, 0);
});
for (const kind of [
    'missing-end',
    'missing-entry',
    'duplicate',
    'reorder',
    'foreign-phase',
    'counter-overflow',
])
    test('partial or corrupt phase evidence never manufactures completion: ' + kind, async () => {
        const f = fixture();
        const token = f.trace.begin('actor-open');
        if (kind === 'missing-end') {
            await f.trace.finish();
            const d = f.frames[0].data;
            assert(!d.phaseLedgerComplete);
            assert.deepEqual(d.pendingPhases, [timelinePhases.indexOf('actor-open')]);
            validateTimelineRecord('pty-stage-timeline', d);
            return;
        }
        f.trace.end(token);
        const d = f.trace.snapshot();
        if (kind === 'missing-entry') d.events.shift();
        if (kind === 'duplicate') d.events.push(d.events[1]);
        if (kind === 'reorder') d.events.reverse();
        if (kind === 'foreign-phase') d.events[0][1] = 999;
        if (kind === 'counter-overflow') d.counters[0][1] = Number.MAX_SAFE_INTEGER;
        assert.throws(() => validateTimelineRecord('pty-stage-timeline', d));
    });
test('clock mapping uses asymmetric causal bracket, rounding and sampling width; overlap stays unresolved', () => {
    const s = { hrBefore: 100, perfUs: 123456, hrAfter: 103 };
    const m = stageClockMapping(s, { sent: 1000, received: 1020 });
    assert.equal(m.commonOriginAssumed, false);
    assert.equal(m.deliveryWidthMs, 21);
    assert.equal(m.localSampleWidthMs, 4);
    const a = mappedStageInterval(s.perfUs, m),
        b = mappedStageInterval(
            126456,
            stageClockMapping({ ...s, perfUs: 126456 }, { sent: 1000, received: 1020 }),
        );
    assert.throws(() => mappedStageInterval(126456, m), /Unanchored/);
    assert.equal(stageIntervalOrder(a, b), 'unresolved');
    assert.equal(stageIntervalOrder(a, [a[1] + 1, a[1] + 2]), 'before');
    assert.throws(() => stageClockMapping(s, { sent: 1020, received: 1000 }));
    assert.throws(() => validateStageClock({ ...s, hrAfter: 99 }));
    assert.throws(() => validateStageClock({ ...s, foreign: true }));
});
for (const issue of [
    'backwards-hr',
    'backwards-performance',
    'unknown-phase',
    'duplicate-end',
    'event-bound',
    'operation-bound',
])
    test('bounded observation refuses and holds without a false completion: ' + issue, async () => {
        let n = 0;
        const f = fixture(
            issue.startsWith('backwards')
                ? {
                      clock: () => {
                          n++;
                          return {
                              hrBefore: n === 1 ? 100 : issue === 'backwards-hr' ? 99 : 101,
                              hrAfter: n === 1 ? 100 : issue === 'backwards-hr' ? 99 : 101,
                              perfUs:
                                  n === 1 ? 1000 : issue === 'backwards-performance' ? 999 : 1001,
                          };
                      },
                  }
                : {},
        );
        const exercise = () => {
            if (issue.startsWith('backwards')) {
                const t = f.trace.begin('entry');
                f.trace.end(t);
            }
            if (issue === 'unknown-phase') f.trace.begin('private-user-input');
            if (issue === 'duplicate-end') {
                const t = f.trace.begin('entry');
                f.trace.end(t);
                f.trace.end(t);
            }
            if (issue === 'event-bound')
                for (let i = 0; i < 49; i++) {
                    const t = f.trace.begin('entry');
                    f.trace.end(t);
                }
            if (issue === 'operation-bound')
                for (let i = 0; i < 4097; i++) {
                    const t = f.trace.costStart('journal');
                    f.trace.costEnd(t);
                }
        };
        if (issue === 'operation-bound') exercise();
        else assert.throws(exercise);
        assert.equal(f.holds.length, 1);
        assert(f.trace.snapshot().diagnosticFailed);
        await assert.rejects(f.trace.finish());
    });
for (const first of ['stage-timer', 'parent-ipc', 'signal', 'disconnect', 'abort-observed'])
    test(
        'first cause is immutable before blocked durability and later reentrant causes: ' + first,
        async () => {
            const gate = deferred(),
                f = fixture({ emit: async () => await gate.promise });
            const phase = f.trace.begin('step-3');
            const cause = f.trace.cancel(
                first,
                Error('bounded secret-free digest'),
                first === 'abort-observed',
            );
            let aborted = false;
            aborted = true;
            const pending = f.trace.publishCancellation();
            assert(aborted);
            assert.equal(f.trace.first(), cause);
            assert(Object.isFrozen(cause.clock) && Object.isFrozen(cause.phase));
            f.trace.cancel('parent-ipc', 'later', true);
            assert.equal(f.trace.first(), cause);
            assert.equal(f.trace.snapshot().laterCancellationCount, 1);
            const final = f.trace.finish();
            let done = false;
            void final.then(() => (done = true));
            await turns();
            assert(!done);
            f.trace.end(phase);
            gate.resolve();
            await pending;
            await final;
            assert.equal(f.holds.length, 0);
        },
    );
for (const mode of ['sync', 'async'])
    test(
        'first cancellation and referenced hold survive ' +
            mode +
            ' persistence failure, once only',
        async () => {
            let writes = 0;
            const f = fixture({
                emit: () => {
                    writes++;
                    if (mode === 'sync') throw Error('disk sync failed');
                    return Promise.reject(Error('ACK failed'));
                },
            });
            const first = f.trace.cancel('stage-timer', 'original deadline', false);
            f.trace.publishCancellation();
            await turns();
            f.trace.cancel('ownership-hold', 'later', true);
            f.trace.publishCancellation();
            await assert.rejects(f.trace.finish());
            assert.equal(writes, 1);
            assert.equal(f.trace.first(), first);
            assert.equal(f.holds.length, 1);
        },
    );
test('reserved first cause and summary remain after normal evidence admission exhausts, with full wire charge', async () => {
    const sent = [],
        holds = [];
    const diagnostics = terminalRuntimeDiagnostics(
        async (s, d) => sent.push({ stage: s, data: d }),
        (e) => holds.push(e),
    );
    const terminal = diagnostics.reserveTerminal({ rows: 16, bytes: 131072, pendingBytes: 65536 });
    const port = terminal.reserveTimeline();
    const f = fixture({ emit: port.emit });
    diagnostics.setObserver(f.trace);
    // Spend all original nonterminal row credits, not the protected terminal suballocation.
    for (let i = 0; i < 1008; i++) await diagnostics.emit('ordinary', { i });
    assert.throws(() => diagnostics.emit('ordinary', { i: 1008 }), /rows/);
    f.trace.cancel('stage-timer', 'deadline', false);
    f.trace.publishCancellation();
    await f.trace.finish();
    await diagnostics.drain();
    assert.deepEqual(
        sent.slice(-2).map((x) => x.stage),
        ['pty-stage-first-cancel', 'pty-stage-timeline'],
    );
    for (const row of sent.slice(-2)) validateTimelineRecord(row.stage, row.data);
    assert.equal(holds.length, 0);
    assert.equal(f.holds.length, 0);
});
test('timeline subreservation cannot be spent by another terminal caller, and oversized UTF8 is refused before send', async () => {
    const sent = [];
    const d = terminalRuntimeDiagnostics(
        async (s, data) => sent.push({ s, data }),
        () => {},
    );
    const t = d.reserveTerminal({ rows: 16, bytes: 131072, pendingBytes: 65536 });
    const p = t.reserveTimeline();
    const bad = terminalRuntimeDiagnostics(
        async () => assert.fail('Oversized record sent'),
        () => {},
    )
        .reserveTerminal({ rows: 16, bytes: 131072, pendingBytes: 65536 })
        .reserveTimeline();
    assert.throws(
        () => bad.emit('pty-stage-first-cancel', { schema: 1, text: '韓'.repeat(1024) }),
        /frame/,
    );
    for (let i = 0; i < 14; i++) await t.emit('pty-terminal', { i });
    assert.throws(() => t.emit('pty-terminal', { i: 14 }), /row/);
    assert.equal(sent.length, 14);
    const f = fixture({ emit: p.emit });
    f.trace.cancel('signal', 'one', false);
    await f.trace.publishCancellation();
    await f.trace.finish();
    assert.equal(sent.length, 16);
});
for (const ioFailure of ['none', 'short-write', 'fsync'])
    test(
        'exact receiver + disposable evidence IO binds clock bracket and ACK after durability: ' +
            ioFailure,
        async () => {
            const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-timeline-io-'));
            const holds = [],
                order = [];
            const io = {
                ...fs,
                writeSync: (...args) => {
                    order.push('write');
                    if (ioFailure === 'short-write') return 0;
                    return fs.writeSync(...args);
                },
                fsyncSync: (...args) => {
                    order.push('fsync');
                    if (ioFailure === 'fsync') throw Error('fsync failed');
                    return fs.fsyncSync(...args);
                },
            };
            const e = new PilotEvidence(dir, { io });
            const f = fixture();
            f.trace.cancel('stage-timer', 'deadline', false);
            await f.trace.publishCancellation();
            const message = {
                kind: 'pilot-evidence',
                nonce: 'n',
                bindingSHA256: 'b',
                sequence: 0,
                ...f.frames[0],
            };
            const state = {
                sequence: 0,
                final: null,
                diagnosticAdmission: { admittedAt: 900 },
                runtimeDeadline: 26000,
            };
            const receiver = pilotEvidenceReceiver({
                nonce: 'n',
                bindingSHA256: 'b',
                stage: 'real-os-pty',
                state,
                record: (s, d) => e.append(s, d),
                reserve: () => {},
                recordReserved: () => {},
                send: () => order.push('ACK'),
                hold: (x) => holds.push(String(x)),
                clock: () => 2000,
            });
            try {
                const accepted = receiver.receive(message);
                assert.equal(accepted, ioFailure === 'none');
                if (accepted) {
                    assert.deepEqual(order, ['write', 'fsync', 'ACK']);
                    const row = JSON.parse(fs.readFileSync(path.join(dir, 'pilot.jsonl'), 'utf8'));
                    assert.equal(row.data.diagnosticDelivery.commonOriginAssumed, false);
                } else {
                    assert(!order.includes('ACK'));
                    assert.equal(holds.length, 1);
                }
            } finally {
                try {
                    e.close();
                } catch {}
                fs.rmSync(dir, { recursive: true });
            }
        },
    );
test('native journal observes existing durable commits without changing raw records or final closure', async () => {
    const dir = await fsp.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), 'hub-timeline-journal-')),
        f = fixture();
    let store;
    try {
        store = await NativeConsoleJournal.open(dir, { profileOwned: true, diagnostic: f.trace });
        const at = '2026-10-20T00:00:00.000Z';
        await store.begin({
            flowId: 'control',
            startedAt: at,
            receiveTimeSource: 'local-client',
            target: { endpoint: 'controlled' },
            ready: { role: 'shell-prompt', literals: ['#'] },
        });
        await store.start({ kind: 'context', phase: 'startup' }, at);
        await store.observe(Buffer.from('#'), at, 'channel');
        await store.end('ready', { role: 'shell-prompt', literal: '#' }, at);
        await store.close();
        const counter = f.trace.snapshot().counters.find((x) => x[0] === 4);
        assert(counter[1] >= 3);
        assert.equal(counter[1], counter[2]);
        assert.equal(counter[4], 0);
        assert.equal(store.resourceClosed, true);
        assert.equal(f.holds.length, 0);
    } finally {
        await store?.close();
        await fsp.rm(dir, { recursive: true, force: true });
    }
});
test('startup aggregates the existing identity and descendant calls and drains admitted diagnostics', async () => {
    const f = fixture(),
        child = Object.assign(new EventEmitter(), {
            pid: 456,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
        });
    let reads = 0;
    const startup = new NativePilotStartup({
        signal: new AbortController().signal,
        deadline: Number(process.hrtime.bigint() / 1000000n) + 5000,
        cleanupDeadline: Number(process.hrtime.bigint() / 1000000n) + 6000,
        diagnostics: true,
        timeline: f.trace,
        emit: async () => {},
        hold: (e) => f.holds.push(e),
        readTable: async () => {
            reads++;
            return reads === 1
                ? [
                      {
                          pid: 456,
                          parent: process.pid,
                          created: '2026-10-20T00:00:00.0000000Z',
                          creationClock: 'windows-utc-100ns',
                          rssBytes: null,
                      },
                  ]
                : [];
        },
    });
    startup.adopt('controlled', child, () => {});
    await startup.children.get(child).identityTask;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await startup.join();
    await startup.drainDiagnostics();
    assert.equal(reads, 2);
    const counters = f.trace.snapshot().counters;
    assert.equal(counters[0][1], 2);
    assert.equal(counters[1][1], 1);
    assert.equal(counters[3][1], 1);
    assert.equal(f.holds.length, 0);
});

for (const failStep of [0, 3])
    test(
        'exact assertion fixture records actual eight interaction and cleanup hook calls using controlled SSH/PTY and real journal: ' +
            failStep,
        async () => {
            const temp = await fsp.mkdtemp(
                    path.join(fs.realpathSync(os.tmpdir()), 'hub-timeline-spine-'),
                ),
                f = fixture(),
                controller = new AbortController();
            const state = {
                opens: 0,
                closes: 0,
                inputs: [],
                stderr: 'HUB_OS_PTY_CLOSE {"outputDrained":true}',
                helperErrors: [],
            };
            let count = 0,
                finished = false;
            const pty = {
                state,
                attachShell() {},
                async settled() {},
                async close() {
                    state.closes = 1;
                },
            };
            class Session {
                consoleBusy = false;
                automationConnection = {};
                async connect() {}
                disconnect() {}
                async collect() {
                    throw Error('paused for automation');
                }
                async runAutomation() {
                    throw Error('Wait for');
                }
                async openTerminal() {
                    throw Error('owned Automation console');
                }
                createAutomationConsole(store) {
                    const self = this,
                        at = '2026-10-20T00:00:00.000Z';
                    let result;
                    const actor = {
                        async open(input, signal, timeout) {
                            assert.equal(timeout, 7000);
                            signal.throwIfAborted();
                            self.consoleBusy = true;
                            state.opens++;
                            await store.begin(JSON.parse(JSON.stringify(input)));
                            await store.start({ kind: 'context', phase: 'startup' }, at);
                            await store.observe(Buffer.from('hub-pty:~#'), at, 'channel');
                            await store.end(
                                'ready',
                                { role: 'shell-prompt', literal: 'hub-pty:~#' },
                                at,
                            );
                        },
                        async step(segment, timeout) {
                            segment = JSON.parse(JSON.stringify(segment));
                            assert.equal(timeout, 3000);
                            controller.signal.throwIfAborted();
                            count++;
                            if (count === failStep) throw Error('controlled step fault');
                            state.inputs.push(Buffer.from(segment.requestBase64, 'base64'));
                            await store.start(segment, at);
                            const output =
                                count === 3
                                    ? 'REAL_NORMAL_ALIAS'
                                    : count === 4
                                      ? 'REAL_NORMAL_FUNCTION'
                                      : count === 6
                                        ? 'REAL_CONFIRMED'
                                        : '/';
                            await store.observe(
                                Buffer.from(output + '\n' + segment.criterion.literals[0]),
                                at,
                                'channel',
                            );
                            const match = {
                                role: segment.criterion.role,
                                literal: segment.criterion.literals[0],
                            };
                            await store.end('prompt-observed', match, at);
                            await store.outcome('prompt-observed', match, at);
                        },
                        async finish() {
                            await store.start({ kind: 'context', phase: 'shutdown' }, at);
                            await store.observe(Buffer.from('exit'), at, 'channel');
                            await store.end('closed', null, at);
                            result = await store.finish('complete', store.snapshot.bytes, true);
                            await store.close();
                            state.closes = 1;
                            self.consoleBusy = false;
                            finished = true;
                            return result;
                        },
                        async cancel() {
                            await store.close();
                            state.closes = 1;
                            self.consoleBusy = false;
                            return result;
                        },
                    };
                    return { actor, target: { endpoint: 'controlled' }, signal: controller.signal };
                }
            }
            const ts = createRequire(import.meta.url)('typescript'),
                source = fs.readFileSync(
                    new URL('./fixtures/console-real-pty-assertions.ts', import.meta.url),
                    'utf8',
                );
            const code = ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
            }).outputText;
            const context = vm.createContext({
                Buffer,
                process,
                performance,
                crypto,
                Date,
                Uint8Array,
            });
            state.helperErrors = vm.runInContext('[]', context);
            const module = new vm.SourceTextModule(code, { context });
            const imports = {
                '../../scripts/lib/product-entry-custody.mjs': {
                    createOwnershipHold: () =>
                        assert.fail('Known controlled closure must not create hold'),
                },
                'node:assert/strict': { default: assert },
                'node:fs/promises': { default: fsp },
                'node:os': { default: os },
                'node:path': { default: path },
                './os-pty': { osPtyFixture: async () => pty },
                './gateway': {
                    gatewayFixture: async () => ({ options: {}, pinned: 'key', async close() {} }),
                },
                '../../backend/ssh/session': { SshSession: Session },
                '../../electron/console-journal': { NativeConsoleJournal },
                '../../shared/capture-store': {
                    bytesBase64: (b) => Buffer.from(b).toString('base64'),
                },
            };
            await module.link((spec) => {
                assert(spec in imports, spec);
                const value = imports[spec];
                return new vm.SyntheticModule(
                    Object.keys(value),
                    function () {
                        for (const [k, v] of Object.entries(value)) this.setExport(k, v);
                    },
                    { context },
                );
            });
            await module.evaluate();
            try {
                const run = module.namespace.exerciseRealPtyAssertions({
                    timeline: f.trace,
                    journalParent: temp,
                    signal: controller.signal,
                    holdUnknown: (e) => f.holds.push(String(e)),
                    check() {},
                });
                if (failStep) await assert.rejects(run, /controlled step fault/);
                else await run;
                const data = f.trace.snapshot();
                const entered = data.events
                    .filter((r) => r[2] === 0)
                    .map((r) => timelinePhases[r[1]]);
                for (const name of [
                    'fixture',
                    'gateway',
                    'journal-open',
                    'connect',
                    'actor-open',
                    'cleanup',
                    'cleanup-actor',
                    'cleanup-session',
                    'cleanup-pty',
                    'cleanup-server',
                    'cleanup-store',
                    'cleanup-journal',
                ])
                    assert(entered.includes(name), name);
                if (!failStep) {
                    for (let i = 1; i <= 8; i++) assert(entered.includes('step-' + i));
                    assert.equal(count, 8);
                    assert(finished);
                    assert(
                        entered.includes('finish') &&
                            entered.includes('settled') &&
                            entered.includes('readback'),
                    );
                } else {
                    assert.equal(count, 3);
                    assert(
                        data.events.some((r) => timelinePhases[r[1]] === 'step-3' && r[2] === 2),
                    );
                    assert(!entered.includes('step-4'));
                }
                assert.equal(f.holds.length, 0);
                assert.equal(state.closes, 1);
                assert.equal((await fsp.readdir(temp)).length, 0);
            } finally {
                await fsp.rm(temp, { recursive: true, force: true });
            }
        },
    );

test('reason metadata invokes no getters or user string conversion and retains only a bounded digest', () => {
    let touched = 0;
    const reason = {
        get message() {
            touched++;
            throw Error('secret');
        },
        toString() {
            touched++;
            throw Error('secret');
        },
    };
    const f = fixture();
    const c = f.trace.cancel('signal', reason, false);
    assert.equal(touched, 0);
    assert.equal(c.reasonSHA256.length, 64);
    assert(!JSON.stringify(c).includes('secret'));
});

test('a60KiB existing closure frame retains its pending credit; cause fits and summary waits for actual queue drain', async () => {
    const gate = deferred(),
        sent = [],
        holds = [];
    const d = terminalRuntimeDiagnostics(
        async (s, data) => {
            sent.push(s);
            if (s === 'startup-terminal-observation') await gate.promise;
        },
        (e) => holds.push(e),
    );
    const t = d.reserveTerminal({ rows: 16, bytes: 131072, pendingBytes: 65536 }),
        port = t.reserveTimeline(),
        f = fixture({ emit: port.emit });
    const closure = t.emit('startup-terminal-observation', { data: 'x'.repeat(60000) });
    await turns();
    f.trace.cancel('stage-timer', 'first', false);
    const cause = f.trace.publishCancellation(),
        final = f.trace.finish();
    let done = false;
    void final.then(() => (done = true));
    await turns();
    assert(!done);
    assert.deepEqual(sent, ['startup-terminal-observation']);
    gate.resolve();
    await closure;
    await cause;
    await final;
    assert.deepEqual(sent, [
        'startup-terminal-observation',
        'pty-stage-first-cancel',
        'pty-stage-timeline',
    ]);
    assert.equal(holds.length, 0);
    assert.equal(f.holds.length, 0);
});
test('worst integer widths/96events fit logical+wire+journal charges alongside the full admitted legacy terminal envelope', async () => {
    const rows = [],
        holds = [];
    let n = 0;
    const d = terminalRuntimeDiagnostics(
        async (stage, data) => rows.push({ stage, data }),
        (e) => holds.push(e),
    );
    const terminal = d.reserveTerminal({ rows: 16, bytes: 131072, pendingBytes: 65536 }),
        port = terminal.reserveTimeline();
    const legacyBytes = 131072 - 34816;
    let used = 0;
    for (let i = 0; i < 14; i++) {
        const target =
            i === 0
                ? 60000
                : i === 13
                  ? legacyBytes - used
                  : Math.floor((legacyBytes - 60000) / 13);
        const overhead = Buffer.byteLength(
            JSON.stringify({ stage: 'pty-terminal', data: { body: '' } }),
        );
        await terminal.emit('pty-terminal', { body: 'x'.repeat(target - overhead) });
        used += target;
    }
    assert.equal(used, legacyBytes);
    const trace = ptyStageTimeline({
        deadline: Number.MAX_SAFE_INTEGER,
        pid: Number.MAX_SAFE_INTEGER,
        clock: () => ({
            hrBefore: Number.MAX_SAFE_INTEGER - 100000 + n,
            hrAfter: Number.MAX_SAFE_INTEGER - 99999 + n,
            perfUs: Number.MAX_SAFE_INTEGER - 100000000 + 1000 * n++,
        }),
        emit: port.emit,
        hold: (e) => holds.push(e),
    });
    for (const name of timelinePhases.slice(0, 16)) trace.begin(name);
    for (let i = 0; i < 40; i++) {
        const t = trace.begin('verdict');
        trace.end(t);
    }
    assert.equal(trace.snapshot().events.length, 96);
    trace.cancel('stage-timer', '韓'.repeat(500), false);
    await trace.publishCancellation();
    await trace.finish();
    assert.equal(rows.length, 16);
    assert.equal(holds.length, 0);
    for (const row of rows.slice(-2)) {
        validateTimelineRecord(row.stage, row.data);
        const S = Buffer.byteLength(JSON.stringify(row));
        const data = {
            ...row.data,
            diagnosticDelivery: {
                sent: Number.MAX_SAFE_INTEGER - 1000,
                received: Number.MAX_SAFE_INTEGER - 1,
                ...stageClockMapping(row.data.diagnosticClock ?? row.data.firstCancellation.clock, {
                    sent: Number.MAX_SAFE_INTEGER - 1000,
                    received: Number.MAX_SAFE_INTEGER - 1,
                }),
                authority: false,
            },
        };
        const wire = Buffer.byteLength(
            JSON.stringify({
                kind: 'pilot-evidence',
                nonce: 'a'.repeat(36),
                bindingSHA256: 'b'.repeat(64),
                sequence: Number.MAX_SAFE_INTEGER,
                ...row,
            }),
        );
        const journal = Buffer.byteLength(
            JSON.stringify({
                sequence: Number.MAX_SAFE_INTEGER,
                stage: 'real-os-pty:' + row.stage,
                data,
            }) + '\n',
        );
        assert(wire <= S + 512 && journal <= S + 512);
        assert(S + Math.max(wire, journal) <= 2 * S + 512);
        assert(2 * S + 512 <= (row.stage === 'pty-stage-first-cancel' ? 2048 : 32768));
    }
});
test('first-cause port cannot retry after malformed output and summary cannot bypass a pending queue', async () => {
    const gate = deferred(),
        d = terminalRuntimeDiagnostics(
            async () => await gate.promise,
            () => {},
        ),
        t = d.reserveTerminal({ rows: 16, bytes: 131072, pendingBytes: 65536 }),
        p = t.reserveTimeline();
    const pending = t.emit('pty-terminal', { value: 1 });
    const f = fixture();
    assert.throws(() => p.emit('pty-stage-timeline', f.trace.snapshot()), /drained/);
    assert.throws(() => p.emit('pty-stage-first-cancel', { text: '韓'.repeat(1000) }), /frame/);
    assert.throws(() => p.emit('pty-stage-first-cancel', {}), /One first-cause/);
    gate.resolve();
    await pending;
});
test('unknown/foreign clock or PID evidence is held before receiver persistence/ACK', async () => {
    for (const mode of ['foreign-owner', 'foreign-pid', 'foreign-clock']) {
        const f = fixture();
        f.trace.cancel('signal', 'reason', false);
        await f.trace.publishCancellation();
        const row = JSON.parse(JSON.stringify(f.frames[0]));
        if (mode === 'foreign-clock')
            row.data.firstCancellation.clock = { hrBefore: 2, hrAfter: 1, perfUs: 3 };
        const writes = [],
            holds = [];
        const receiver = pilotEvidenceReceiver({
            nonce: 'owner',
            bindingSHA256: 'binding',
            stage: 'real-os-pty',
            state: {
                sequence: 0,
                final: null,
                diagnosticAdmission: { admittedAt: 100 },
                diagnosticPID: mode === 'foreign-pid' ? 999 : 123,
            },
            record: () => writes.push('write'),
            reserve: () => {},
            recordReserved: () => {},
            send: () => writes.push('ACK'),
            clock: () => 2000,
            hold: (e) => holds.push(e),
        });
        assert.equal(
            receiver.receive({
                kind: 'pilot-evidence',
                nonce: mode === 'foreign-owner' ? 'foreign' : 'owner',
                bindingSHA256: 'binding',
                sequence: 0,
                ...row,
            }),
            false,
        );
        assert.deepEqual(writes, []);
        assert.equal(holds.length, 1);
    }
});

for (const mode of ['delayed-ACK', 'foreign-ACK', 'missing-ACK'])
    test(
        'exact child stage channel and parent durable receiver keep cause/hold truth through ' +
            mode,
        async () => {
            const { spawn } = await import('node:child_process');
            const dir = fs.mkdtempSync(
                    path.join(fs.realpathSync(os.tmpdir()), 'hub-timeline-channel-'),
                ),
                evidence = new PilotEvidence(dir),
                holds = [],
                messages = [];
            let ackSent = false,
                result,
                stderr = '';
            const channelURL = new URL('./fixtures/pilot-stage-channel.ts', import.meta.url).href,
                timelineURL = new URL('../scripts/lib/pty-stage-timeline.mjs', import.meta.url)
                    .href,
                holdURL = new URL('../scripts/lib/product-entry-custody.mjs', import.meta.url).href;
            const code = `import {stageChannel} from ${JSON.stringify(channelURL)};import {ptyStageTimeline} from ${JSON.stringify(timelineURL)};import {createOwnershipHold} from ${JSON.stringify(holdURL)};const now=()=>Number(process.hrtime.bigint()/1000000n),controller=new AbortController();let channel,trace,held,ref=false;const hold=e=>{held??=createOwnershipHold({first:trace.first(),secondary:String(e)},()=>{},{interval:()=>({ref(){ref=true;}})});};trace=ptyStageTimeline({deadline:now()+600,emit:(s,d)=>channel(s,d),hold});channel=stageChannel('owner','binding',controller.signal,{deadline:now()+600,observer:trace});trace.cancel('stage-timer','original cutoff',false);controller.abort(Error('original cutoff'));let success=false;try{await trace.publishCancellation();process.send({kind:'firstAck'});await trace.finish();success=true;}catch{}process.send({kind:'result',success,ref,held:Boolean(held),first:trace.first()},()=>process.disconnect());`;
            const admittedAt = Number(process.hrtime.bigint() / 1000000n);
            const child = spawn(
                process.execPath,
                ['--import', 'tsx', '--input-type=module', '-e', code],
                {
                    cwd: path.resolve(import.meta.dirname, '..'),
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                },
            );
            child.stdout.resume();
            child.stderr.on('data', (b) => (stderr += b.toString()));
            const receiver = pilotEvidenceReceiver({
                nonce: 'owner',
                bindingSHA256: 'binding',
                stage: 'real-os-pty',
                state: {
                    sequence: 0,
                    final: null,
                    diagnosticAdmission: { admittedAt },
                    diagnosticPID: child.pid,
                },
                record: (s, d) => evidence.append(s, d),
                recordReserved: () => assert.fail(),
                reserve: () => {},
                hold: (x) => holds.push(String(x)),
                clock: () => Number(process.hrtime.bigint() / 1000000n),
                send: (m, cb) => {
                    if (mode === 'missing-ACK') {
                        cb(null);
                        return;
                    }
                    setTimeout(
                        () => {
                            ackSent = true;
                            child.send(
                                mode === 'foreign-ACK' ? { ...m, sequence: m.sequence + 1 } : m,
                                cb,
                            );
                        },
                        mode === 'delayed-ACK' ? 20 : 0,
                    );
                },
            });
            child.on('message', (m) => {
                messages.push(m.kind);
                if (m.kind === 'pilot-evidence') receiver.receive(m);
                if (m.kind === 'firstAck')
                    assert(ackSent, 'send acceptance alone must not satisfy durability');
                if (m.kind === 'result') result = m;
            });
            try {
                const close = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        child.kill();
                        reject(Error('controlled protocol child did not close'));
                    }, 4000);
                    child.on('error', reject);
                    child.on('close', (code, signal) => {
                        clearTimeout(timer);
                        resolve({ code, signal });
                    });
                });
                assert.equal(close.code, 0, stderr);
                assert(result);
                assert.equal(result.first.origin, timelineOrigins.indexOf('stage-timer'));
                if (mode === 'delayed-ACK') {
                    assert(result.success);
                    assert(!result.held);
                    assert.equal(evidence.rows, 2);
                    assert(messages.includes('firstAck'));
                } else {
                    assert(!result.success);
                    assert(result.held && result.ref);
                    assert(!messages.includes('firstAck'));
                    assert.equal(evidence.rows, 1);
                }
                assert.equal(holds.length, 0);
            } finally {
                if (child.exitCode === null && child.signalCode === null) child.kill();
                evidence.close();
                fs.rmSync(dir, { recursive: true });
            }
        },
    );

test('inconsistent local clock origin is a bounded held diagnostic failure, without common-origin assumptions', async () => {
    let n = 0;
    const f = fixture({
        clock: () =>
            ++n === 1
                ? { hrBefore: 100, hrAfter: 100, perfUs: 1000 }
                : { hrBefore: 500, hrAfter: 500, perfUs: 2000 },
    });
    const token = f.trace.begin('entry');
    assert.throws(() => f.trace.end(token), /Inconsistent/);
    assert.equal(f.holds.length, 1);
    assert.match(f.holds[0], /Inconsistent/);
    await assert.rejects(f.trace.finish());
});

test('root journal protects diagnostic bytes/rows before ordinary admission and never grants duplicate credit', async () => {
    const { timelineJournalBudget, timelineJournalTags } =
        await import('../scripts/lib/pty-stage-timeline.mjs');
    const b = timelineJournalBudget(100, 50000);
    b.reserve(50000 - 100 - 36864);
    assert.throws(() => b.reserve(1), /protected/);
    b.reserve(2048, timelineJournalTags[0]);
    b.row(timelineJournalTags[0]);
    assert.throws(() => b.reserve(1, timelineJournalTags[0]), /One root/);
    b.reserve(32768, timelineJournalTags[1]);
    b.row(timelineJournalTags[1]);
    b.reserve(2048, timelineJournalTags[2]);
    b.row(timelineJournalTags[2]);
    assert.equal(b.snapshot().bytes, 50000);
    assert.equal(b.snapshot().reservedRows, 0);
    assert.throws(() => b.row(timelineJournalTags[1]), /duplicate/);
    const r = timelineJournalBudget(0, 10485760);
    for (let i = 0; i < 4093; i++) r.row();
    assert.throws(() => r.row(), /row reserve/);
    for (const tag of timelineJournalTags) {
        r.reserve(1, tag);
        r.row(tag);
    }
    assert.equal(r.snapshot().rows, 4096);
    assert.throws(() => r.row());
    assert.throws(() => timelineJournalBudget(49000, 50000));
});

for (const mode of ['durable', 'fsync-failure', 'unexpected-async'])
    test(
        'parent first cause cancels before reserved durable observation; persistence fault remains held: ' +
            mode,
        async () => {
            const { waitPilotStage, pilotStageDeadlines } =
                await import('../scripts/lib/pilot-runtime-startup.mjs');
            const { createOwnershipHold } =
                await import('../scripts/lib/product-entry-custody.mjs');
            const dir = fs.mkdtempSync(
                    path.join(fs.realpathSync(os.tmpdir()), 'hub-parent-cause-'),
                ),
                events = [],
                closed = deferred(),
                persistence = deferred();
            let now = 1000,
                ref = false,
                held;
            const io = {
                ...fs,
                fsyncSync: (...args) => {
                    if (mode === 'fsync-failure') throw Error('controlled fsync fault');
                    fs.fsyncSync(...args);
                },
            };
            const evidence = new PilotEvidence(dir, { io }),
                child = {},
                state = {
                    stage: 'real-os-pty',
                    runtimeReady: true,
                    ...pilotStageDeadlines({ deadline: 600000 }, 'real-os-pty', now),
                    diagnosticAdmission: { admittedAt: 1000 },
                };
            const hold = (e) => {
                held ??= createOwnershipHold(
                    {
                        cause: state.parentCancellationDiagnostics,
                        descriptor: evidence.entry.fd,
                        secondary: String(e),
                    },
                    () => {},
                    {
                        interval: () => ({
                            ref() {
                                ref = true;
                            },
                        }),
                    },
                );
            };
            const waiting = waitPilotStage({
                child,
                startup: {
                    children: new Map([[child, { closed: closed.promise }]]),
                    async joinChild() {
                        events.push('joined');
                    },
                },
                state,
                clock: () => now,
                signal: new AbortController().signal,
                cancel: () => events.push('cancel'),
                hold,
                emit: async () => {},
                recordFirstCancellation: (data) => {
                    events.push('record');
                    if (mode === 'unexpected-async') return persistence.promise;
                    evidence.append('pty-parent-first-cancel', data);
                },
            });
            try {
                now = 26000;
                closed.resolve();
                await assert.rejects(waiting, /Stage absolute work deadline/);
                assert.deepEqual(events.slice(0, 2), ['cancel', 'record']);
                assert.equal(state.parentFirstCauseDurable, mode === 'durable');
                assert.equal(Boolean(held), mode !== 'durable');
                if (held) {
                    assert(ref);
                    assert(fs.fstatSync(evidence.entry.fd).isFile());
                }
                if (mode === 'unexpected-async') {
                    assert(state.parentFirstCauseTask);
                    persistence.resolve();
                    await state.parentFirstCauseTask;
                    assert.equal(state.parentFirstCauseDurable, false);
                    assert(held);
                }
                assert.equal(state.stageDeadline, 26000);
            } finally {
                try {
                    evidence.close();
                } catch {}
                try {
                    fs.closeSync(evidence.entry.fd);
                } catch {}
                fs.rmSync(dir, { recursive: true });
            }
        },
    );

test('diagnostic failure blocks new work effects while retaining cleanup and already-admitted journal writes', async () => {
    const f = fixture();
    assert.throws(() => f.trace.begin('unknown-phase'));
    let newEffects = 0,
        closures = 0,
        writes = 0;
    await assert.rejects(f.trace.phase('connect', async () => newEffects++));
    await f.trace.phase('cleanup-session', async () => closures++);
    await f.trace.measure('journal', async () => writes++);
    await assert.rejects(f.trace.measure('process-query', async () => newEffects++));
    assert.equal(newEffects, 0);
    assert.equal(closures, 1);
    assert.equal(writes, 1);
    assert.equal(f.holds.length, 1);
});
