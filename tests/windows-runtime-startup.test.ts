// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { SameJobPilotCustody } from '../scripts/lib/hosted-pilot-custody.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { pilotLimits, bindingDigest } from '../scripts/lib/hosted-pilot-contract.mjs';
import { EventEmitter } from 'node:events';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import {
    preparePilotStageRuntime,
    pilotStageDeadlines,
    runtimeDiagnostics,
    waitPilotStage,
    stopHeldPilotActivity,
} from '../scripts/lib/pilot-runtime-startup.mjs';
const source = path.resolve(import.meta.dirname, '..'),
    deps = path.join(source, 'node_modules'),
    worker = path.join(source, 'tests/fixtures/native-pilot-runtime-worker.ts');
const now = () => Number(process.hrtime.bigint() / 1000000n),
    turn = () => new Promise((r) => setImmediate(r));
const temp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-runtime-boundary-'));
function controlFiles(dir, mode = 'pending', trace = false) {
    const fake = path.join(dir, 'fake-esbuild.cjs'),
        preload = path.join(dir, 'control-hooks.cjs');
    const healthy = `({outputFiles:[{contents:Buffer.from('module.exports={};')}],metafile:{outputs:{out:{imports:[]}},inputs:{'memory-ssh-profile-entry.cjs':{}}}})`;
    fs.writeFileSync(
        fake,
        `exports.version='0.28.2';exports.build=()=>{${trace ? "process.send({kind:'review-build-entered'});" : ''}${mode === 'blocked-sync' ? `for(;;){}` : mode === 'noisy' ? `console.error('x'.repeat(70000));return new Promise(()=>{});` : mode === 'healthy' ? `return Promise.resolve(${healthy});` : mode === 'late' ? `return new Promise(r=>setTimeout(()=>r(${healthy}),300));` : mode === 'pipe' ? `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>console.log("late inherited pipe"),250)'],{stdio:['ignore',1,2]}).unref();return Promise.resolve(${healthy});` : `return new Promise(()=>{});`}};exports.stop=()=>{${trace ? "process.send?.({kind:'review-stop-called'});" : ''}};`,
    );
    fs.writeFileSync(
        preload,
        `require('node:module').registerHooks({resolve(s,c,n){if(s==='esbuild')return{url:${JSON.stringify(pathToFileURL(fake).href)},shortCircuit:true};if(['ssh2','asn1','safer-buffer','bcrypt-pbkdf','tweetnacl','tsx','esbuild'].some(x=>s===x+'/package.json'))return{url:require('node:url').pathToFileURL(require('node:path').join(${JSON.stringify(deps)},s)).href,shortCircuit:true};return n(s,c);}});`,
    );
    return { preload, fake };
}
function bounded(task, ms = 3000) {
    let t;
    return Promise.race([
        task,
        new Promise((_, j) => (t = setTimeout(() => j(Error('Test control deadline')), ms))),
    ]).finally(() => clearTimeout(t));
}
test('original review boundary: exact production worker stops pending fake build and closes without release-build message', async (t) => {
    const dir = temp(),
        out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const { preload } = controlFiles(dir, 'pending', true),
        messages = [],
        raw = {
            root: source,
            outputParent: out,
            gated: true,
            nonce: 'control-nonce',
            bindingSHA256: 'a'.repeat(64),
            deadline: now() + 2500,
            cleanupDeadline: now() + 3000,
        };
    const child = spawn(process.execPath, ['--require', preload, worker, JSON.stringify(raw)], {
        cwd: source,
        env: { ...process.env, HUB_NATIVE_PILOT_STAGE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '',
        stderr = '',
        closed = false;
    child.stdout.on('data', (b) => {
        stdout += b;
        assert(stdout.length <= 65536);
    });
    child.stderr.on('data', (b) => {
        stderr += b;
        assert(stderr.length <= 65536);
    });
    const closure = new Promise((r) =>
        child.once('close', (code, signal) => {
            closed = true;
            r({ code, signal });
        }),
    );
    let buildEntered;
    const entered = new Promise((r) => (buildEntered = r));
    child.on('message', (m) => {
        messages.push(m);
        if (m.kind === 'native-runtime-ready')
            child.send({
                kind: 'admit-native-runtime',
                nonce: raw.nonce,
                bindingSHA256: raw.bindingSHA256,
                deadline: raw.deadline,
            });
        if (m.kind === 'native-runtime-event')
            child.send({
                kind: 'native-runtime-event-ack',
                nonce: raw.nonce,
                bindingSHA256: raw.bindingSHA256,
                sequence: m.sequence,
            });
        if (m.kind === 'review-build-entered') buildEntered();
    });
    try {
        await bounded(entered);
        child.send({ kind: 'cancel-native-pilot-build', reason: 'review cancellation' });
        const result = await bounded(closure);
        assert.equal(result.code, 1);
        assert(messages.some((m) => m.kind === 'native-runtime-cancel-ack'));
        assert.equal(messages.filter((m) => m.kind === 'review-stop-called').length, 1);
        assert(!messages.some((m) => m.kind === 'native-runtime-result'));
        assert.deepEqual(fs.readdirSync(out), []);
        const observed = {
            productionWorker: true,
            productionPrepareModule: true,
            onlyBuildAPIFaked: true,
            cancelAcknowledged: true,
            stopCalledBeforeExternalRelease: true,
            externalReleaseMessages: 0,
            knownClosure: result,
            publicationFiles: [],
            phaseNames: messages
                .filter((m) => m.kind === 'native-runtime-event')
                .map((m) => m.stage),
        };
        t.diagnostic(JSON.stringify(observed));
    } finally {
        if (!closed) {
            child.kill();
            await bounded(closure);
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
async function runtimeFixture({
    mode = 'pending',
    fault = null,
    workMs = 450,
    realProcessTable = false,
} = {}) {
    const dir = temp(),
        out = path.join(dir, 'runtime'),
        report = path.join(dir, 'evidence');
    fs.mkdirSync(out);
    fs.mkdirSync(report);
    const journal = new PilotEvidence(report),
        rows = [],
        controller = new AbortController(),
        holds = [];
    let child,
        scope,
        queries = 0,
        lateResolve;
    const files = controlFiles(dir, mode);
    const heldIdentity = new Promise((r) => (lateResolve = r));
    const hold = (e) => {
        scope?.stopQueryAdmission();
        if (!holds.length) {
            const probe = { ref: false };
            const actual = createOwnershipHold(
                { reason: String(e) },
                (s, d) => {
                    assert(probe.ref);
                    journal.append(s, d);
                },
                {
                    interval: () => ({
                        ref() {
                            probe.ref = true;
                        },
                    }),
                },
            );
            holds.push({ probe, actual });
        }
        controller.abort(e);
        scope?.cancel();
    };
    const diagnostics = runtimeDiagnostics(async (s, d) => {
        rows.push({ stage: s, data: d });
        journal.append(s, d);
    }, hold);
    scope = new NativePilotStartup({
        signal: controller.signal,
        deadline: now() + workMs,
        cleanupDeadline: now() + 4000,
        diagnostics: true,
        emit: diagnostics.emit,
        hold,
        timeoutMs: 200,
        ...(realProcessTable
            ? {}
            : {
                  identity: async (c) => {
                      queries++;
                      if (fault === 'identity-held') return await heldIdentity;
                      return { pid: c.pid, created: 'controlled actual Node child identity port' };
                  },
                  proveDescendants: async () => {
                      queries++;
                      assert(child.stdout.readableEnded && child.stderr.readableEnded);
                      if (fault === 'descendant-unknown')
                          throw Error('controlled surviving descendant');
                  },
              }),
    });
    const binding = { nonce: 'control-runtime-nonce', deadline: now() + 600000 },
        deadline = now() + workMs;
    const spawnPort = (exe, args, opts) => {
        let next = ['--require', files.preload, worker, args.at(-1)];
        if (fault === 'loader')
            next = ['-e', `console.error('controlled loader failure');process.exitCode=3;`];
        if (fault === 'close-no-result')
            next = [
                '-e',
                `process.send({kind:'native-runtime-ready',nonce:'control-runtime-nonce',bindingSHA256:'${'b'.repeat(64)}',pid:process.pid});process.once('message',()=>{process.disconnect();});`,
            ];
        child = spawn(exe, next, opts);
        return child;
    };
    const promise = preparePilotStageRuntime(
        {
            binding,
            bindingSHA256: 'b'.repeat(64),
            paths: { runtimeParent: out },
            startup: scope,
            signal: controller.signal,
            deadline,
            emit: diagnostics.emit,
            cancel: (e) => controller.abort(e),
            hold,
            root: source,
        },
        {
            spawnPort,
            worker,
            loader: pathToFileURL(path.join(deps, 'tsx/dist/loader.mjs')).href,
            cooperativeMs: 30,
        },
    );
    return {
        dir,
        out,
        journal,
        rows,
        controller,
        holds,
        scope,
        promise,
        diagnostics,
        lateResolve,
        get child() {
            return child;
        },
        get queries() {
            return queries;
        },
        async dispose() {
            lateResolve({ pid: child?.pid, created: 'late controlled identity' });
            if (child && !scope.children.get(child)?.close) {
                child.kill('SIGKILL');
                await bounded(new Promise((r) => child.once('close', r)));
            }
            await turn();
            journal.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
test('production runtime orchestration cancels a pending build before PTY and preserves immediate phase/cancel/pipe receipts', async () => {
    const f = await runtimeFixture();
    try {
        await assert.rejects(f.promise, /deadline/);
        assert.equal(f.holds.length, 0);
        assert.deepEqual(fs.readdirSync(f.out), []);
        const stages = f.rows.map((r) => r.stage);
        for (const s of [
            'runtime-loader-before',
            'startup-child-adopted',
            'startup-child-identity',
            'runtime-admission',
            'runtime-esbuild-before',
            'runtime-cancel-request',
            'runtime-cancel-transport',
            'runtime-cancel-ack',
            'esbuild-stop-before',
            'esbuild-stop-after',
            'startup-child-exit',
            'startup-child-pipe-close',
            'startup-child-joined',
        ])
            assert(stages.includes(s), s);
        assert.equal(f.rows.filter((r) => r.stage === 'runtime-cancel-request').length, 1);
        assert(!stages.includes('runtime-ready'));
        assert(!stages.includes('runtime-publication-before'));
        assert(fs.fstatSync(f.journal.entry.fd).isFile());
    } finally {
        await f.dispose();
    }
});
for (const fault of ['loader', 'close-no-result', 'identity-held', 'descendant-unknown'])
    test(
        'production runtime boundary refuses ' +
            fault +
            ' and emits diagnostics before cleanup/hold',
        async () => {
            const f = await runtimeFixture({
                mode: 'healthy',
                fault,
                workMs: fault === 'identity-held' ? 120 : 1000,
            });
            try {
                await assert.rejects(f.promise);
                assert(!f.rows.some((r) => r.stage === 'runtime-ready'));
                if (fault === 'loader') {
                    const raw = f.rows
                        .filter((r) => r.stage === 'startup-child-output')
                        .map((r) => Buffer.from(r.data.base64, 'base64').toString())
                        .join('');
                    assert.match(raw, /controlled loader failure/);
                }
                if (fault === 'identity-held' || fault === 'descendant-unknown') {
                    assert.equal(f.holds.length, 1);
                    assert(f.holds[0].probe.ref);
                    const reads = f.queries;
                    f.lateResolve({ pid: f.child.pid, created: 'too-late' });
                    await turn();
                    assert.equal(f.queries, reads);
                    assert.throws(() => f.scope.admit());
                    assert(!f.journal.entry.attempted);
                }
            } finally {
                await f.dispose();
            }
        },
    );
test('positive production boundary publishes only after owned runtime closure and admits the caller before the same deadline', async () => {
    const f = await runtimeFixture({ mode: 'healthy', workMs: 2000 });
    try {
        const r = await f.promise;
        assert(fs.existsSync(r.manifestPath));
        assert.equal(f.holds.length, 0);
        const row = f.scope.children.get(f.child);
        assert(row.exit && row.close && row.joined && row.observationsDrained);
        assert(
            f.rows.findIndex((r) => r.stage === 'startup-child-pipe-close') <
                f.rows.findIndex((r) => r.stage === 'runtime-ready'),
        );
    } finally {
        await f.dispose();
    }
});
test('cancellation racing late build success never publishes or revives runtime admission', async () => {
    const f = await runtimeFixture({ mode: 'late', workMs: 1200 });
    try {
        const wait = async () => {
            while (!f.rows.some((r) => r.stage === 'runtime-esbuild-before'))
                await new Promise((r) => setTimeout(r, 5));
        };
        await bounded(wait());
        f.controller.abort(Error('race cancellation'));
        await assert.rejects(f.promise, /race cancellation/);
        assert(!f.rows.some((r) => r.stage === 'runtime-ready'));
        assert.deepEqual(fs.readdirSync(f.out), []);
    } finally {
        await f.dispose();
    }
});
test('actual root exit with a delayed inherited pipe does not satisfy the production runtime wait', async () => {
    const f = await runtimeFixture({ mode: 'pipe', workMs: 150 });
    try {
        await assert.rejects(f.promise, /deadline/);
        const row = f.scope.children.get(f.child);
        assert(row.exit && row.close);
        assert(!f.rows.some((r) => r.stage === 'runtime-ready'));
        const raw = f.rows
            .filter((r) => r.stage === 'startup-child-output')
            .map((r) => Buffer.from(r.data.base64, 'base64').toString())
            .join('');
        assert.match(raw, /late inherited pipe/);
    } finally {
        await f.dispose();
    }
});
test('outer production watchdog includes blocked loader/setup and preserves its immutable cleanup cutoff', async () => {
    const dir = temp(),
        journal = new PilotEvidence(dir),
        controller = new AbortController(),
        rows = [],
        holds = [];
    let stopCount = 0,
        child;
    const scope = new NativePilotStartup({
        signal: new AbortController().signal,
        deadline: now() + 1000,
        cleanupDeadline: now() + 1500,
        diagnostics: true,
        emit: async (s, d) => {
            rows.push({ stage: s, data: d });
            journal.append(s, d);
        },
        hold: (e) => holds.push(e),
        identity: async (c) => ({ pid: c.pid, created: 'controlled loader identity' }),
        proveDescendants: async () => {},
    });
    child = scope.spawn(
        'blocked-stage-loader',
        () =>
            spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], {
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            }),
        () => {},
    );
    const deadlines = {
        runtimeDeadline: now() + 70,
        stageDeadline: now() + 100,
        cleanupDeadline: now() + 1500,
    };
    const state = { stage: 'real-os-pty', runtimeReady: false, ...deadlines };
    const wait = waitPilotStage({
        child,
        startup: scope,
        state,
        signal: controller.signal,
        cancel: () => {
            if (!stopCount++) {
                child.kill();
            }
        },
        hold: (e) => holds.push(e),
        emit: async (s, d) => {
            rows.push({ stage: s, data: d });
            journal.append(s, d);
        },
    });
    try {
        await assert.rejects(wait, /deadline/);
        assert.equal(stopCount, 1);
        assert.equal(holds.length, 0);
        assert(rows.some((r) => r.stage === 'stage-watchdog'));
        assert.equal(state.runtimeDeadline, deadlines.runtimeDeadline);
        assert(!state.runtimeReady);
        assert(scope.children.get(child).close);
    } finally {
        if (!scope.children.get(child).close) {
            child.kill();
            await new Promise((r) => child.once('close', r));
        }
        journal.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('parent-derived whole first-stage deadline is25s at spawn, clips core cutoff and does not reset on readiness', () => {
    const b = { deadline: 600000 };
    assert.deepEqual(pilotStageDeadlines(b, 'real-os-pty', 1000), {
        runtimeDeadline: 26000,
        stageDeadline: 26000,
        cleanupDeadline: 600000,
    });
    assert.deepEqual(pilotStageDeadlines(b, 'real-os-pty', 539990), {
        runtimeDeadline: 540000,
        stageDeadline: 540000,
        cleanupDeadline: 600000,
    });
    const native = pilotStageDeadlines(b, 'native-electron-store', 1000);
    assert.equal(native.runtimeDeadline, 26000);
    assert.equal(native.stageDeadline, 540000);
    assert.throws(() => native.stageDeadline++);
});

test('terminal production hold stops query/disk admission and retains the real marker/evidence through late identity completion', async () => {
    const dir = temp(),
        evidence = new PilotEvidence(dir),
        events = new EventEmitter(),
        timers = new Map();
    const h = 'a'.repeat(64),
        nonce = '9536ac3c-b0ea-44dc-a4b6-9b1feec7975e';
    const binding = {
        schema: 1,
        kind: 'windows-hosted-native-readiness-pilot-v1',
        collectionApproval: false,
        host: {
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            attempt: '1',
            run: '39124523368',
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
    const marker = path.join(dir, 'controlled-marker.lock'),
        lease = new ProductLease(marker, { nonce, bindingSHA256: bindingDigest(binding) }),
        controller = new AbortController();
    let scope,
        child,
        diskReads = 0,
        queryReads = 0,
        stops = 0,
        held,
        resolveIdentity;
    const identity = new Promise((r) => (resolveIdentity = r)),
        disk = setInterval(() => diskReads++, 10);
    let timerId = 0;
    const owner = new SameJobPilotCustody(binding, {
        lease,
        events,
        clock: {
            now: () => 0,
            set: (fn, ms) => {
                const id = ++timerId;
                timers.set(id, { fn, ms });
                return id;
            },
            clear: (id) => timers.delete(id),
        },
        executionGate: () => {},
        verify: async (b) => b,
        record: (s, d) => evidence.append(s, d),
        closeEvidence: async () => evidence.close(),
        hold: (state, record) => {
            stopHeldPilotActivity(scope, () => clearInterval(disk));
            if (!held) {
                let referenced = false;
                const actual = createOwnershipHold(
                    state,
                    (s, d) => {
                        assert(referenced);
                        record(s, d);
                    },
                    {
                        interval: () => ({
                            ref() {
                                referenced = true;
                            },
                        }),
                    },
                );
                held = { actual, referenced };
            }
            controller.abort(Error('controlled terminal hold'));
            scope?.cancel();
            return held.actual;
        },
    });
    await owner.acquireAndVerify();
    scope = new NativePilotStartup({
        signal: controller.signal,
        deadline: now() + 1000,
        cleanupDeadline: now() + 1500,
        emit: async () => {},
        hold: (e) => owner.hold(e),
        identity: async () => {
            queryReads++;
            return await identity;
        },
        proveDescendants: async () => {
            queryReads++;
        },
    });
    child = scope.spawn(
        'held-stage-child',
        () =>
            spawn(process.execPath, ['-e', "process.on('message',()=>process.disconnect());"], {
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            }),
        (p) => {
            stops++;
            if (p.connected) p.send('stop');
        },
    );
    const closed = new Promise((r) => child.once('close', r));
    try {
        await turn();
        owner.hold('controlled terminal startup uncertainty');
        await bounded(closed);
        assert.equal(timers.size, 0);
        const q = queryReads,
            d = diskReads;
        resolveIdentity({ pid: child.pid, created: 'late identity' });
        await new Promise((r) => setTimeout(r, 280));
        assert.equal(queryReads, q);
        assert.equal(diskReads, d);
        assert.equal(stops, 1);
        assert.throws(() => scope.admit());
        assert.equal(owner.state, 'held');
        assert(held.referenced && fs.existsSync(marker));
        assert(!evidence.entry.attempted && fs.fstatSync(evidence.entry.fd).isFile());
        await assert.rejects(
            owner.release({ inputsUnchanged: true, rootsCleanupClosed: true, resultClosed: true }),
        );
        assert(fs.existsSync(marker));
    } finally {
        clearInterval(disk);
        resolveIdentity({ pid: child.pid, created: 'cleanup' });
        if (!scope.children.get(child).close) {
            child.kill();
            await closed;
        }
        evidence.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('parent watchdog terminates an unresponsive exact production runtime worker and joins actual process/pipe identity', async () => {
    const f = await runtimeFixture({ mode: 'blocked-sync', workMs: 250, realProcessTable: true });
    try {
        await assert.rejects(f.promise, /deadline/);
        const row = f.scope.children.get(f.child);
        assert(row.exit && row.close && row.joined);
        assert.equal(row.signal, 'SIGKILL');
        assert.equal(f.holds.length, 0);
        assert(row.identity.some((r) => r.pid === f.child.pid && r.created));
        assert(f.rows.some((r) => r.stage === 'startup-termination-request'));
        assert(
            f.rows.some(
                (r) => r.stage === 'startup-termination-result' && r.data.returned === true,
            ),
        );
        assert(!f.rows.some((r) => r.stage === 'runtime-ready'));
        assert.deepEqual(fs.readdirSync(f.out), []);
    } finally {
        await f.dispose();
    }
});
test('exact runtime-worker stderr is retained immediately as a bounded prefix while the build is pending', async () => {
    const f = await runtimeFixture({ mode: 'noisy', workMs: 450 });
    try {
        await assert.rejects(f.promise, /deadline/);
        const raw = f.rows.filter(
            (r) => r.stage === 'startup-child-output' && r.data.stream === 'stderr',
        );
        const bytes = raw.reduce((n, r) => n + Buffer.from(r.data.base64, 'base64').length, 0);
        assert(bytes > 0 && bytes <= 65536);
        assert(
            f.rows.findIndex((r) => r.stage === 'startup-child-output') <
                f.rows.findIndex((r) => r.stage === 'runtime-failed'),
        );
        assert(!f.rows.some((r) => r.stage === 'runtime-ready'));
    } finally {
        await f.dispose();
    }
});
