// @ts-nocheck
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import * as capture from '../shared/capture-store';
import * as journal from '../shared/console-journal';
import * as ssh from '../shared/ssh-console';
import * as completion from '../src/features/automation/serial-completion';
import { dependencyFacts } from '../scripts/lib/windows-preflight.mjs';
import { runtimeDiagnostics } from '../scripts/lib/pilot-runtime-startup.mjs';
const root = path.resolve(import.meta.dirname, '..'),
    ts = createRequire(import.meta.url)('typescript');
// Retained transcript bytes from the reviewed actual run; timing below is virtual, not Windows execution.
const lateBytes = Buffer.from(
    '1b5b306d1b5b304b5245414c5f4f535f494e5445524143544956455f494e49541b5b304b1b5b3f32356c0d0a6875622d7074793a7e231b5b304b0d0a657869741b5b304b0d0a1b5b304b1b5b3f323568',
    'hex',
);
const passingBytes = Buffer.from(
    '1b5b306d1b5b304b1b5b3f32356c5245414c5f4f535f494e5445524143544956455f494e49541b5b304b1b5b31471b5b3f3235681b5b3f32356c0d0a6875622d7074793a7e231b5b304b1b5b3f323568',
    'hex',
);

const source = fs.readFileSync(path.join(root, 'backend/ssh/persistent-console.ts'), 'utf8');
const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
async function replay({
    arrival,
    bytes = lateBytes,
    prefixAt = arrival,
    observe = true,
    throwObserver = false,
    slowStore = false,
}) {
    let now = 0,
        id = 0,
        released = 0,
        writeCalls = 0,
        finished,
        diagnosticError;
    const timers = new Map(),
        events = [],
        retained = [],
        diagnostics = [];
    const setTimer = (fn, ms) => {
        const k = ++id;
        timers.set(k, { at: now + ms, fn });
        return k;
    };
    const clearTimer = (k) => timers.delete(k);
    class Channel extends EventEmitter {
        stderr = new EventEmitter();
        readableLength = 0;
        readableEnded = false;
        closedScheduled = false;
        constructor() {
            super();
            Object.assign(this.stderr, {
                readableLength: 0,
                readableEnded: false,
                pause() {},
                resume() {},
                read() {
                    return null;
                },
            });
        }
        pause() {}
        resume() {}
        read() {
            return null;
        }
        write() {
            writeCalls++;
            throw Error('No scripted input permitted');
        }
        close() {
            if (this.closedScheduled) return;
            this.closedScheduled = true;
            setTimer(
                () => {
                    this.readableEnded = true;
                    this.stderr.readableEnded = true;
                    this.emit('end');
                    this.stderr.emit('end');
                    this.emit('close');
                },
                Math.max(now, arrival) + 10 - now,
            );
        }
    }
    const channel = new Channel();
    const repository = {
        resourceClosed: false,
        snapshot: null,
        async begin(header) {
            this.snapshot = {
                header: { ...header, schema: 2, id: 'controlled-console' },
                state: 'writing',
            };
        },
        async start(s, at) {
            events.push({ kind: 'start', s, at, mono: now });
        },
        async observe(b, at, origin) {
            if (slowStore) await new Promise((resolve) => setTimer(resolve, 150));
            retained.push(Buffer.from(b));
            events.push({ kind: 'observe', bytes: b.length, mono: now, origin });
        },
        async end(reason, match, at) {
            events.push({ kind: 'end', reason, match, at, mono: now });
        },
        async finish(reason, observedBytes) {
            this.snapshot.state = reason;
            events.push({ kind: 'finish', reason, observedBytes, mono: now });
        },
        async close() {
            this.resourceClosed = true;
        },
    };
    const context = vm.createContext({
        performance: { now: () => now },
        Date,
        TextDecoder,
        Uint8Array,
        Buffer,
        setTimeout: setTimer,
        clearTimeout: clearTimer,
    });
    const module = new vm.SourceTextModule(code, { context });
    const imports = {
        '../../shared/capture-store': capture,
        '../../shared/console-journal': journal,
        '../../shared/ssh-console': ssh,
        '../../src/features/automation/serial-completion': completion,
    };
    await module.link((s) => {
        assert(s in imports, s);
        const e = imports[s];
        return new vm.SyntheticModule(
            Object.keys(e),
            function () {
                for (const [k, v] of Object.entries(e)) this.setExport(k, v);
            },
            { context },
        );
    });
    await module.evaluate();
    const clockDate = new Date().toISOString();
    const actor = new module.namespace.PersistentSshConsole(
        {
            acquire: () => () => released++,
            assertCurrent() {},
            assertFresh() {},
            readinessDiagnostic: observe
                ? (row) => {
                      diagnostics.push(JSON.parse(JSON.stringify(row)));
                      if (throwObserver) throw Error('Diagnostic sink failed');
                  }
                : undefined,
            open(cb) {
                cb(undefined, channel);
                setTimer(() => channel.emit('data', bytes.subarray(0, 8)), prefixAt);
                setTimer(() => channel.emit('data', bytes.subarray(8)), arrival);
            },
        },
        repository,
    );
    const open = actor
        .open(
            {
                flowId: 'real-os-pty',
                startedAt: clockDate,
                receiveTimeSource: 'local-client',
                target: {},
                ready: { role: 'shell-prompt', literals: ['hub-pty:~#'] },
            },
            new AbortController().signal,
            7000,
        )
        .then(
            (s) => {
                finished = { state: 'ready', at: now };
                return s;
            },
            (e) => {
                finished = { state: 'rejected', at: now, error: String(e) };
                return null;
            },
        );
    const flush = async () => {
        for (let i = 0; i < 40; i++) await Promise.resolve();
    };
    await flush();
    const advance = async (until) => {
        while (true) {
            const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!next || next[1].at > until) break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].fn();
            await flush();
        }
        now = until;
        await flush();
    };
    await advance(12000);
    await open;
    assert(finished);
    diagnosticError = actor.readinessDiagnosticFailure;
    if (finished.state === 'ready') {
        const close = actor.finish();
        await flush();
        await advance(12020);
        await close;
    } else await assert.rejects(actor.step({}, 3000), /Console is unavailable/);
    assert.equal(released, 1);
    assert.equal(writeCalls, 0);
    assert(repository.resourceClosed);
    assert.equal(actor.ownershipSnapshot.timers, 0);
    assert.equal(Buffer.concat(retained).toString('hex'), bytes.toString('hex'));
    assert.equal(
        diagnostics.filter((d) => d.phase === 'first-input-channel-bytes').length,
        observe ? 1 : 0,
    );
    assert(diagnostics.length <= 5);
    assert(diagnostics.every((d) => Buffer.byteLength(JSON.stringify(d)) < 2048));
    return {
        finished,
        state: repository.snapshot.state,
        retainedHex: Buffer.concat(retained).toString('hex'),
        writeCalls,
        released,
        events: events.map(({ at, ...e }) => e),
        diagnostics,
        diagnosticError,
    };
}
test('production actor and parser preserve passing readiness with diagnostic on and off', async (t) => {
    const input = { arrival: 2974.7612, bytes: passingBytes };
    const a = await replay({ ...input, observe: true }),
        b = await replay({ ...input, observe: false });
    assert.deepEqual(
        JSON.parse(JSON.stringify({ ...a, diagnostics: [], diagnosticError: undefined })),
        JSON.parse(JSON.stringify(b)),
    );
    assert.equal(a.finished.state, 'ready');
    const arm = a.diagnostics.find((x) => x.phase === 'readiness-wait-armed'),
        match = a.diagnostics.find((x) => x.phase === 'ready-match');
    assert.equal(arm.armedAtMono, 0);
    assert.equal(arm.deadlineMono, 7000);
    assert.equal(match.suffixMatch, true);
    assert.equal(match.utf8Complete, true);
    assert.equal(match.ansiComplete, true);
    assert.equal(match.pendingBytes, 0);
    assert(match.monoMs - match.lastReceivedMono >= 100);
    t.diagnostic(JSON.stringify({ kind: 'passing-virtual-readiness', diagnostics: a.diagnostics }));
});
test('production 7000ms expiry precedes late80byte startup and still disarms later input', async (t) => {
    const input = { arrival: 11342.3479 };
    const a = await replay(input),
        b = await replay({ ...input, observe: false });
    assert.deepEqual(
        JSON.parse(JSON.stringify({ ...a, diagnostics: [], diagnosticError: undefined })),
        JSON.parse(JSON.stringify(b)),
    );
    assert.equal(a.state, 'timeout');
    assert.match(a.finished.error, /Console ended with timeout; later input is disarmed/);
    const expiry = a.diagnostics.find((x) => x.phase === 'ready-expiry'),
        first = a.diagnostics.find((x) => x.phase === 'first-input-channel-bytes');
    assert.equal(expiry.monoMs, 7000);
    assert.equal(expiry.lastReceivedMono, null);
    assert.equal(first.monoMs, 11342.3479);
    assert.equal(first.stopReason, 'timeout');
    assert.equal(a.retainedHex, lateBytes.toString('hex'));
    t.diagnostic(
        JSON.stringify({
            kind: 'late-virtual-readiness',
            diagnostics: a.diagnostics,
            scriptedWrites: a.writeCalls,
            releasedAfterDrains: a.released === 1,
        }),
    );
});
test('readiness diagnostics do not turn an ANSI prefix into prompt completion', async () => {
    const a = await replay({ arrival: 11342.3479, prefixAt: 0 });
    assert.equal(a.state, 'timeout');
    const expiry = a.diagnostics.find((d) => d.phase === 'ready-expiry');
    assert.equal(expiry.lastReceivedMono, 0);
    assert.equal(expiry.suffixMatch, false);
    assert.equal(expiry.monoMs, 7000);
});
test('quiet interval remains inside the original readiness deadline', async () => {
    const a = await replay({ arrival: 6990, bytes: passingBytes });
    assert.equal(a.state, 'timeout');
    assert.equal(a.diagnostics.find((d) => d.phase === 'ready-expiry').monoMs, 7000);
    const b = await replay({ arrival: 6800, bytes: passingBytes });
    assert.equal(b.finished.state, 'ready');
    assert.equal(b.diagnostics.find((d) => d.phase === 'ready-match').monoMs, 6900);
});
test('pending persistence is reported without granting readiness or moving expiry', async () => {
    const a = await replay({ arrival: 6950, bytes: passingBytes, slowStore: true });
    assert.equal(a.state, 'timeout');
    const expiry = a.diagnostics.find((d) => d.phase === 'ready-expiry');
    assert.equal(expiry.monoMs, 7000);
    assert(expiry.pendingBytes > 0);
    assert.equal(expiry.retainedBytes, 0);
    assert(expiry.pendingOperations > 0);
});
test('throwing diagnostic observer is retained and never overrides first timeout or disarming', async () => {
    const a = await replay({ arrival: 11342.3479, throwObserver: true });
    assert.equal(a.state, 'timeout');
    assert.match(a.finished.error, /Console ended with timeout/);
    assert.match(String(a.diagnosticError), /Diagnostic sink failed/);
    assert.equal(a.writeCalls, 0);
    assert.equal(a.released, 1);
});
test('readiness observations fit unchanged bounded diagnostic queue', async () => {
    const a = await replay({ arrival: 11342.3479 });
    const sent = [],
        held = [];
    const d = runtimeDiagnostics(
        async (stage, data) => sent.push({ stage, data }),
        (e) => held.push(e),
    );
    for (const row of a.diagnostics) await d.emit('pty-diagnostic', { text: JSON.stringify(row) });
    await d.drain();
    assert.equal(sent.length, a.diagnostics.length);
    assert.equal(held.length, 0);
    assert(sent.every((row) => Buffer.byteLength(JSON.stringify(row)) < 8192));
});
test('dependency content partitions reuse exact canonical identity, cover every file and localize change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-timing-deps-'));
    try {
        const files = {
            'tsx/loader.mjs': 'tsx',
            'ssh2/index.js': 'ssh2',
            '.bin/tsx': 'shim',
            'other/index.js': 'one',
            '@esbuild/win32-x64/esbuild.exe': 'binary',
        };
        for (const [rel, data] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), data);
        }
        const base = dependencyFacts(dir, () => {}),
            a = dependencyFacts(dir, () => {}, { contentPartitions: true });
        assert.deepEqual(
            { ...a, contentPartitions: undefined },
            { ...base, contentPartitions: undefined },
        );
        assert.equal(a.contentPartitions.partitions.length, 7);
        assert.equal(
            a.contentPartitions.partitions.reduce((n, p) => n + p.files, 0),
            base.files,
        );
        assert.equal(
            a.contentPartitions.partitions.reduce((n, p) => n + p.bytes, 0),
            base.bytes,
        );
        fs.writeFileSync(path.join(dir, 'other/index.js'), 'two');
        const b = dependencyFacts(dir, () => {}, { contentPartitions: true });
        assert.notEqual(a.sha256, b.sha256);
        assert.equal(a.files, b.files);
        assert.equal(a.bytes, b.bytes);
        assert.deepEqual(
            a.contentPartitions.partitions.filter((p) => p.name !== 'all-other-files'),
            b.contentPartitions.partitions.filter((p) => p.name !== 'all-other-files'),
        );
        assert.notEqual(
            a.contentPartitions.partitions.at(-1).sha256,
            b.contentPartitions.partitions.at(-1).sha256,
        );
        assert(Buffer.byteLength(JSON.stringify(a.contentPartitions)) < 4096);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
test('helper instrumentation remains finite and brackets existing operations without changed waits', () => {
    const ps = fs.readFileSync(path.join(root, 'tests/fixtures/winpty-bridge.ps1'), 'utf8'),
        cs = fs.readFileSync(path.join(root, 'tests/fixtures/winpty-bridge.cs'), 'utf8');
    assert.equal((ps.match(/^Write-PtyTiming '/gm) || []).length, 9);
    assert.equal((cs.match(/Timing\("[^"\n]+"\)/g) || []).length, 10);
    for (const phase of [
        'helper-entry',
        'identity-checks-before',
        'identity-checks-after',
        'Add-Type-before',
        'Add-Type-after',
        'closure-contract-before',
        'closure-contract-after',
        'managed-Run-before',
        'managed-Run-after',
    ])
        assert(ps.includes("Write-PtyTiming '" + phase + "'"));
    for (const [before, op, after] of [
        ['winpty_open-before', 'agent=winpty_open', 'winpty_open-after'],
        ['pipe-connect-before', 'input=Pipe', 'pipe-connect-after'],
        ['Bash-spawn-before', 'if(!winpty_spawn', 'Bash-spawn-after'],
        [
            'Bash-wait-start',
            'uint wait=WaitForSingleObject(process,(uint)timeoutMs)',
            'Bash-wait-end',
        ],
    ])
        assert(
            cs.indexOf('Timing("' + before + '")') < cs.indexOf(op) &&
                cs.indexOf(op) < cs.indexOf('Timing("' + after + '")'),
        );
    assert(ps.includes('[int]$DeadlineMs=15000'));
    assert(cs.includes('winpty_config_set_agent_timeout(config,5000)'));
    assert(cs.includes('Thread.Join(3000)'));
    assert(
        cs.includes(
            'if(Interlocked.CompareExchange(ref firstOutput,1,0)==0)Timing("first-output")',
        ),
    );
    assert(cs.includes('HUB_OS_PTY_CLOSE'));
    assert(ps.includes("clockDomain='helper-stopwatch'"));
});
