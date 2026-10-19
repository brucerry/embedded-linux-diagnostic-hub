// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import {
    pilotLimits,
    pilotBindingMode,
    pilotStages,
    validatePilotBinding,
    bindingDigest,
    requirePilotMode,
    requirePilotStage,
    ptyObservationMode,
    nativeReadinessMode,
} from '../scripts/lib/hosted-pilot-contract.mjs';
import {
    ptyObservationPolicy,
    parsePtyObservationScope,
    parsePtyObservationPolicy,
} from '../scripts/lib/pty-observation-scope.mjs';
import { SameJobPilotCustody } from '../scripts/lib/hosted-pilot-custody.mjs';
import { runHostedPilot, joinPilotStage } from '../scripts/lib/hosted-pilot-run.mjs';
import { freezePtyObservationDependencies } from '../scripts/lib/pilot-dependencies.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { closeEntries } from '../scripts/lib/product-collector-evidence.mjs';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { nativePilotMain } from '../scripts/windows-native-pilot.mts';
import { sourceFingerprint } from './fixtures/memory-resource-identity';
import {
    pilotPathMap,
    nativePilotLaunchRoutes,
    pilotEarlyAppPaths,
} from './fixtures/native-pilot-paths';
const root = path.resolve(import.meta.dirname, '..'),
    sha = 'a'.repeat(64),
    nonce = '9536ac3c-b0ea-44dc-a4b6-9b1feec7975e';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const now = () => Number(process.hrtime.bigint() / 1000000n);
const env = { HUB_WINDOWS_PTY_OBSERVATION_ONLY: '1' };
const clone = (v) => JSON.parse(JSON.stringify(v));
function binding(at = 0) {
    const parent = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
    return {
        schema: 1,
        kind: 'windows-hosted-pty-observation-v1',
        mode: ptyObservationMode,
        collectionApproval: false,
        host: {
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            attempt: '1',
            run: '39200202754',
            commit: 'a'.repeat(40),
            environment: 'github-hosted',
        },
        nonce,
        principalSID: 'S-1-5-21-1-2-3-500',
        sourceSHA256: sha,
        scopeSHA256: sha,
        pilotPolicySHA256: sha,
        dependenciesSHA256: sha,
        runtime: {
            platform: 'win32',
            arch: 'x64',
            ...Object.fromEntries(
                [
                    'node',
                    'tsx',
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
                        sha256: sha,
                        ...(k === 'node' ? { version: 'v24.22.0' } : {}),
                    },
                ]),
            ),
        },
        roots: Object.fromEntries(
            ['canonicalTemp', 'privateRoot', 'evidenceRoot'].map((k, i) => [
                k,
                {
                    path:
                        k === 'canonicalTemp'
                            ? parent
                            : k === 'privateRoot'
                              ? parent + '\\diagnostic-hub-native-pilot-' + nonce
                              : 'D:\\report',
                    dev: '1',
                    ino: String(i + 1),
                    ...(k === 'evidenceRoot' ? { identitySHA256: sha } : { descriptorSHA256: sha }),
                },
            ]),
        ),
        startedAt: at,
        deadline: at + 600000,
        limits: pilotLimits,
    };
}
function scope(source = sha, policy = sha) {
    return {
        ...clone(ptyObservationPolicy),
        kind: 'windows-hosted-pty-observation-scope-v1',
        reviewed: true,
        sourceSHA256: source,
        policySHA256: policy,
    };
}
function controls(b = binding()) {
    const events = new EventEmitter(),
        records = [],
        timers = new Set();
    let leased = false,
        released = false,
        held = 0;
    const ports = {
        events,
        clock: {
            now: () => 0,
            set: (fn) => (timers.add(fn), fn),
            clear: (fn) => timers.delete(fn),
        },
        lease: {
            acquire() {
                leased = true;
            },
            state: () => ({ created: leased }),
            check() {
                assert(leased);
            },
            release() {
                released = true;
                leased = false;
            },
        },
        verify: async (b) => b,
        record: (s, d) => records.push({ s, d }),
        closeEvidence: async () => ({ complete: true }),
        executionGate: (mode) => requirePilotMode(mode, env),
        hold: () => {
            held++;
            return { referenced: true };
        },
    };
    return {
        ports,
        records,
        get held() {
            return held;
        },
        get released() {
            return released;
        },
        owner: () => new SameJobPilotCustody(b, ports),
    };
}
test('PTY capability requires explicit immutable mode and excludes Electron/native coverage', () => {
    const b = binding();
    assert.equal(validatePilotBinding(b, 0), b);
    assert.deepEqual(pilotStages(b), ['real-os-pty']);
    for (const change of [
        (b) => delete b.mode,
        (b) => (b.mode = nativeReadinessMode),
        (b) => (b.kind = 'windows-hosted-native-readiness-pilot-v1'),
        (b) => (b.coveragePolicySHA256 = sha),
        (b) => (b.runtime.electron = { path: 'C:\\electron.exe', sha256: sha, version: '44.5.1' }),
    ]) {
        const x = clone(b);
        change(x);
        assert.throws(() => validatePilotBinding(x, 0));
    }
});
test('stage and entry gates refuse wrong/missing/full mode and mixed selectors before work', async () => {
    requirePilotStage(binding(), 'real-os-pty', env, 0);
    assert.throws(
        () => requirePilotStage(binding(), 'native-electron-store', env, 0),
        /Stage excluded/,
    );
    for (const values of [
        {},
        { HUB_WINDOWS_NATIVE_PILOT: '1' },
        ...[
            'HUB_WINDOWS_NATIVE_PILOT',
            'HUB_WINDOWS_PREFLIGHT_ONLY',
            'HUB_WINDOWS_PILOT_WINPS_CONTRACT',
        ].map((k) => ({ ...env, [k]: '1' })),
    ]) {
        assert.throws(() => requirePilotMode(ptyObservationMode, values));
        await assert.rejects(() => nativePilotMain([], values, ptyObservationMode));
    }
    await assert.rejects(() => nativePilotMain([], env));
    assert.throws(() => requirePilotMode(undefined, env));
    assert.throws(() => requirePilotStage(binding(), 'other', env, 0));
});
test('scope cannot replay native coverage, stale source/policy, extra stages or nonreviewed facts', () => {
    const bytes = Buffer.from(JSON.stringify(scope()));
    assert.equal(parsePtyObservationScope(bytes, hash(bytes), sha, sha).mode, ptyObservationMode);
    for (const change of [
        (s) => (s.kind = 'native-coverage'),
        (s) => (s.mode = nativeReadinessMode),
        (s) => s.stages.push('native-electron-store'),
        (s) => (s.reviewed = false),
        (s) => (s.sourceSHA256 = 'b'.repeat(64)),
        (s) => (s.policySHA256 = 'b'.repeat(64)),
        (s) => (s.nativeElectronStoreCycles = 1),
        (s) => (s.reruns = 1),
    ]) {
        const s = scope();
        change(s);
        const raw = Buffer.from(JSON.stringify(s));
        assert.throws(() => parsePtyObservationScope(raw, hash(raw), sha, sha));
    }
    assert.throws(() => parsePtyObservationScope(bytes, 'b'.repeat(64), sha, sha));
    const policy = fs.readFileSync(
        path.join(root, 'scripts/lib/hosted-pty-observation-policy.json'),
    );
    parsePtyObservationPolicy(policy, hash(policy));
    assert.throws(() => parsePtyObservationPolicy(Buffer.from('{}'), hash(Buffer.from('{}'))));
});
for (const attempt of ['native-first', 'foreign-binding', 'foreign-token', 'repeat'])
    test('custody refuses ' + attempt + ' before a prohibited stage factory', async () => {
        const b = binding(),
            c = controls(b),
            owner = c.owner(),
            token = await owner.acquireAndVerify();
        let spawns = 0;
        const factory = () => {
            spawns++;
            const child = new EventEmitter();
            child.connected = true;
            child.send = (m, cb) => cb?.();
            return child;
        };
        if (attempt === 'repeat') {
            const child = owner.start('real-os-pty', token, b, factory);
            child.emit('spawn');
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
            await owner.joinStage(async () => ({
                descendantsClosed: true,
                leafReceiptsClosed: true,
                logsClosed: true,
            }));
        }
        const current = attempt === 'foreign-binding' ? { ...b, sourceSHA256: 'b'.repeat(64) } : b;
        assert.throws(() =>
            owner.start(
                attempt === 'native-first' ? 'native-electron-store' : 'real-os-pty',
                attempt === 'foreign-token' ? {} : token,
                current,
                factory,
            ),
        );
        assert.equal(spawns, attempt === 'repeat' ? 1 : 0);
        assert.equal(owner.state, 'held');
        assert(c.held);
        assert(!c.released);
    });
test('PTY dependency freeze never resolves or prepares an Electron executable', () => {
    let reads = 0;
    const events = [];
    const result = freezePtyObservationDependencies('/controlled', {
        freeze: (p, check, o) => {
            reads++;
            assert.equal(p, '/controlled/node_modules');
            assert.equal(o.contentPartitions, true);
            return { sha256: sha };
        },
        record: (s, d) => events.push(s),
    });
    assert.equal(reads, 1);
    assert(!('electron' in result));
    assert.deepEqual(events, ['pty-dependency-identity-frozen']);
});
test('PTY path map creates only required directories and refuses native app routes', () => {
    const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-pty-paths-'));
    const dir = path.join(parent, 'diagnostic-hub-native-pilot-' + nonce);
    fs.mkdirSync(dir);
    try {
        const routes = pilotPathMap(dir, nonce, true, ptyObservationMode);
        assert.deepEqual(fs.readdirSync(dir).sort(), ['pty-home', 'pty-journal', 'ssh-runtime']);
        assert(!routes.profile && !routes.artifactsDir && !routes.temp);
        assert.throws(() => nativePilotLaunchRoutes(routes), /PTY-only/);
        assert.throws(() => pilotEarlyAppPaths(routes), /PTY-only/);
        fs.mkdirSync(path.join(dir, 'native-app'));
        assert.throws(() => routes.check(), /Unexpected application-owned route/);
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});
test('a real native-owner approval token cannot authorize the PTY owner', async () => {
    const full = binding();
    full.kind = 'windows-hosted-native-readiness-pilot-v1';
    full.mode = nativeReadinessMode;
    full.coveragePolicySHA256 = full.scopeSHA256;
    delete full.scopeSHA256;
    full.runtime.electron = { path: 'C:\\runtime\\electron.exe', sha256: sha, version: '44.5.1' };
    const native = controls(full).owner(),
        foreign = await native.acquireAndVerify();
    const c = controls(),
        pty = c.owner();
    await pty.acquireAndVerify();
    let spawns = 0;
    assert.throws(
        () =>
            pty.start('real-os-pty', foreign, binding(), () => {
                spawns++;
            }),
        /replayed approval/,
    );
    assert.equal(spawns, 0);
    assert.equal(pty.state, 'held');
    assert(!c.released);
    assert.throws(() => requirePilotStage(full, 'real-os-pty', env, 0));
});
for (const wrong of ['native-stage', 'scope'])
    test('actual stage entry refuses ' + wrong + ' before worker/workload admission', async () => {
        const b = binding(now()),
            value = scope(b.sourceSHA256, b.pilotPolicySHA256);
        const bytes = Buffer.from(JSON.stringify(value));
        b.scopeSHA256 = hash(bytes);
        const messages = [];
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                'scripts/windows-native-pilot-stage.mts',
                JSON.stringify({
                    binding: b,
                    stage: wrong === 'native-stage' ? 'native-electron-store' : 'real-os-pty',
                    scopeJSON: wrong === 'scope' ? '{}' : bytes.toString(),
                    stageDeadline: now() + 25000,
                    runtimeDeadline: now() + 25000,
                }),
            ],
            {
                cwd: root,
                env: {
                    ...process.env,
                    HUB_WINDOWS_NATIVE_PILOT: '0',
                    HUB_WINDOWS_PREFLIGHT_ONLY: '0',
                    HUB_WINDOWS_PILOT_WINPS_CONTRACT: '0',
                    HUB_WINDOWS_PTY_OBSERVATION_ONLY: '1',
                    HUB_NATIVE_PILOT_STAGE: '1',
                },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            },
        );
        let stderr = '';
        child.stderr.on('data', (b) => (stderr += b));
        child.stdout.resume();
        child.on('message', (m) => messages.push(m));
        const timer = setTimeout(() => child.kill(), 5000);
        try {
            const [code, signal] = await once(child, 'close');
            assert.equal(code, 1);
            assert.equal(signal, null);
            assert.match(
                stderr,
                wrong === 'native-stage' ? /Stage excluded/ : /Exact PTY scope bytes changed/,
            );
            assert.deepEqual(messages, []);
        } finally {
            clearTimeout(timer);
            if (child.exitCode === null) child.kill();
        }
    });
for (const exitCode of [0, 1])
    test(
        'real owned Node PTY-stage port closes and releases ' +
            (exitCode ? 'failed' : 'passed') +
            ' without native factory',
        async () => {
            // Windows inner PTY receipts remain a controlled port. Actual Node root/pipe,
            // startup joins, raw descriptor closure, root deletion and ProductLease are real.
            const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-pty-mode-'));
            const privateRoot = path.join(dir, 'private');
            fs.mkdirSync(privateRoot);
            const b = binding(now()),
                events = new EventEmitter(),
                records = [],
                factories = [];
            const lease = new ProductLease(path.join(dir, 'marker.lock'), {
                nonce,
                bindingSHA256: bindingDigest(b),
            });
            let owner,
                child,
                state,
                cleanup = false;
            const clock = { now, set: (fn, ms) => setTimeout(fn, ms), clear: clearTimeout };
            const startup = new NativePilotStartup({
                signal: new AbortController().signal,
                deadline: b.deadline - pilotLimits.reserveMs,
                cleanupDeadline: b.deadline,
                emit: async () => {},
                hold: (e) => {
                    throw e;
                },
                identity: (c) => ({ pid: c.pid, created: 'controlled-node-creation' }),
                proveDescendants: async (c) => {
                    assert.notEqual(c.exitCode, null);
                    assert(c.stdout.readableEnded && c.stderr.readableEnded);
                },
            });
            try {
                const result = await runHostedPilot(b, {
                    lease,
                    clock,
                    events,
                    executionGate: (mode) => requirePilotMode(mode, env),
                    record: (s, d) => records.push({ s, d }),
                    hold: (e) => {
                        throw Error('Unexpected hold ' + JSON.stringify(e));
                    },
                    onOwner: (o) => (owner = o),
                    verify: async (value) => value,
                    beforeStage: async (stage) => assert.equal(stage, 'real-os-pty'),
                    spawnStage(stage) {
                        factories.push(stage);
                        assert.equal(stage, 'real-os-pty');
                        state = { stage, logs: [], final: null };
                        child = startup.spawn(
                            'controlled-PTY-stage',
                            () =>
                                spawn(
                                    process.execPath,
                                    [
                                        '-e',
                                        `process.stdout.write('controlled PTY stage port\\n');process.exitCode=${exitCode}`,
                                    ],
                                    { stdio: ['ignore', 'pipe', 'pipe'] },
                                ),
                            () => {},
                        );
                        for (const [name, stream] of [
                            ['stdout', child.stdout],
                            ['stderr', child.stderr],
                        ]) {
                            const entry = {
                                fd: fs.openSync(path.join(dir, name + '.log'), 'wx', 0o600),
                                errors: [],
                                attempted: false,
                            };
                            state.logs.push(entry);
                            stream.on('data', (bytes) => fs.writeSync(entry.fd, bytes));
                        }
                        return child;
                    },
                    async waitStage(c) {
                        await startup.children.get(c).closed;
                        const proof = await startup.joinChild(c);
                        state.final = {
                            stage: 'real-os-pty',
                            passed: exitCode === 0,
                            startup: proof,
                            descendantsClosed: true,
                            leafReceiptsClosed: true,
                            controlledInnerPort: true,
                        };
                    },
                    joinStage: (c) =>
                        joinPilotStage(c, {
                            state,
                            startup,
                            cancel: (reason) => owner.cancel(reason),
                            observe: () => {},
                        }),
                    recheckInputs: async () => true,
                    async cleanupRoots() {
                        await startup.join();
                        assert(state.logs.every((r) => r.closed));
                        fs.rmSync(privateRoot, { recursive: true });
                        cleanup = true;
                        return !fs.existsSync(privateRoot);
                    },
                    closeEvidence: async () => ({ complete: true }),
                });
                assert.deepEqual(factories, ['real-os-pty']);
                assert.deepEqual(result.stages, ['real-os-pty']);
                assert.equal(result.passed, exitCode === 0);
                assert.equal(result.state, 'released');
                assert(cleanup);
                assert(!fs.existsSync(lease.file));
                assert(state.logs.every((r) => r.closed && r.synced));
                assert(records.some((r) => r.s === 'pilot-real-os-pty-closed.json'));
            } finally {
                if (owner && owner.state !== 'released') {
                    clock.clear(owner.timer);
                    clock.clear(owner.cleanupTimer);
                }
                if (child && child.exitCode === null) {
                    child.kill();
                    await once(child, 'close');
                }
                for (const entry of state?.logs ?? [])
                    if (!entry.closed)
                        try {
                            fs.closeSync(entry.fd);
                        } catch {}
                if (fs.existsSync(lease.file)) fs.unlinkSync(lease.file);
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
    );
for (const missing of [
    'exit',
    'close',
    'descendantsClosed',
    'leafReceiptsClosed',
    'logsClosed',
    'evidence',
])
    test('unknown ' + missing + ' cannot release PTY-only custody', async () => {
        const b = binding(),
            c = controls(b);
        if (missing === 'evidence') c.ports.closeEvidence = async () => ({ complete: false });
        const owner = c.owner(),
            token = await owner.acquireAndVerify();
        const child = new EventEmitter();
        child.connected = true;
        child.send = (m, cb) => cb?.();
        owner.start('real-os-pty', token, b, () => child);
        child.emit('spawn');
        if (missing !== 'exit') child.emit('exit', 0, null);
        if (missing !== 'close') child.emit('close', 0, null);
        const proof = { descendantsClosed: true, leafReceiptsClosed: true, logsClosed: true };
        if (missing in proof) proof[missing] = false;
        if (missing === 'evidence') {
            await owner.joinStage(async () => proof);
            await assert.rejects(() =>
                owner.release({
                    inputsUnchanged: true,
                    rootsCleanupClosed: true,
                    resultClosed: true,
                }),
            );
        } else await assert.rejects(() => owner.joinStage(async () => proof));
        assert.equal(owner.state, 'held');
        assert(c.held);
        assert(!c.released);
    });
test('workflow PTY selector skips all other jobs and refuses mixed selectors before checkout', () => {
    const flow = load(
        fs.readFileSync(path.join(root, '.github/workflows/windows-portable.yml'), 'utf8'),
    );
    const job = flow.jobs['windows-pty-observation'];
    assert.equal(job.needs, undefined);
    assert.deepEqual(job.permissions, { contents: 'read' });
    assert.equal(job['timeout-minutes'], 15);
    const enabled = (expression, event, inputs) =>
        Function(
            'github',
            'inputs',
            'return (' + expression.replace(/\$\{\{|\}\}/g, '') + ')',
        )({ event_name: event }, inputs);
    const keys = [
        'windows_pty_observation_only',
        'windows_native_pilot',
        'windows_preflight_only',
        'windows_pilot_winps_contract',
    ];
    for (let mask = 0; mask < 16; mask++) {
        const inputs = Object.fromEntries(keys.map((k, i) => [k, Boolean(mask & (1 << i))]));
        for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
            if (inputs.windows_pty_observation_only && event === 'workflow_dispatch') {
                assert(enabled(job.if, event, inputs));
                for (const [name, other] of Object.entries(flow.jobs))
                    if (name !== 'windows-pty-observation')
                        assert(!enabled(other.if, event, inputs), name);
            } else assert(!enabled(job.if, event, inputs));
        }
    }
    const guard = job.steps[0].run;
    for (const k of [
        'PTY_NATIVE_SELECTED',
        'PTY_METADATA_SELECTED',
        'PTY_CONTRACT_SELECTED',
        'GITHUB_RUN_ATTEMPT',
        'PTY_EXPECTED_SOURCE',
        'PTY_EXPECTED_POLICY',
        'PTY_SCOPE_SHA256',
        'HUB_PTY_OBSERVATION_SCOPE_JSON',
    ])
        assert(guard.includes(k));
    assert(job.steps[1].uses.startsWith('actions/checkout@'));
    const run = job.steps.map((s) => s.run ?? '').join('\n');
    assert(run.includes('scripts/windows-pty-observation.mts'));
    assert(
        !/windows-native-pilot\.mts|preparePilotElectron|build|playwright|electron-builder/.test(
            run,
        ),
    );
    const verify = job.steps.findIndex(
        (s) => s.name === 'Verify exact PTY source, policy and scope before dependency restore',
    );
    const dependencies = job.steps.findIndex((s) => s.run === 'npm ci');
    assert(verify > 1 && verify < dependencies);
    assert.equal(job.steps[verify]['timeout-minutes'], 1);
});
for (const wrong of ['none', 'source', 'scope', 'mode'])
    test(
        'actual workflow request verification ' + wrong + ' precedes dependency work',
        async () => {
            const flow = load(
                fs.readFileSync(path.join(root, '.github/workflows/windows-portable.yml'), 'utf8'),
            );
            const step = flow.jobs['windows-pty-observation'].steps.find(
                (s) =>
                    s.name ===
                    'Verify exact PTY source, policy and scope before dependency restore',
            );
            const code = step.run.match(/node --input-type=module -e "([^\n]+)"/)[1];
            const source = await sourceFingerprint(root),
                policy = hash(
                    fs.readFileSync(
                        path.join(root, 'scripts/lib/hosted-pty-observation-policy.json'),
                    ),
                );
            const s = JSON.stringify(scope(wrong === 'source' ? sha : source, policy));
            const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
                cwd: root,
                env: {
                    ...process.env,
                    ...env,
                    HUB_WINDOWS_NATIVE_PILOT: wrong === 'mode' ? '1' : '0',
                    HUB_WINDOWS_PREFLIGHT_ONLY: '0',
                    HUB_WINDOWS_PILOT_WINPS_CONTRACT: '0',
                    PTY_EXPECTED_SOURCE: wrong === 'source' ? sha : source,
                    PTY_EXPECTED_POLICY: policy,
                    PTY_SCOPE_SHA256: wrong === 'scope' ? sha : hash(Buffer.from(s)),
                    HUB_PTY_OBSERVATION_SCOPE_JSON: s,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (b) => (stderr += b));
            child.stdout.resume();
            const timer = setTimeout(() => child.kill(), 5000);
            try {
                const [code, signal] = await once(child, 'close');
                assert.equal(signal, null);
                assert.equal(code, wrong === 'none' ? 0 : 1, stderr);
                if (wrong === 'scope') assert.match(stderr, /scope bytes changed/);
                if (wrong === 'mode') assert.match(stderr, /selectors must be exclusive/);
                if (wrong === 'source') assert.match(stderr, /AssertionError/);
            } finally {
                clearTimeout(timer);
                if (child.exitCode === null) child.kill();
            }
        },
    );
test('loaded assembly diagnostics contain metadata only with no new file reads before managed Run', () => {
    const ps = fs.readFileSync(path.join(root, 'tests/fixtures/winpty-bridge.ps1'), 'utf8');
    const a = ps.indexOf('function Read-PtyLoadedRuntime'),
        b = ps.indexOf('$beforeLoggingStart=', a),
        end = ps.indexOf('$cpuAfter=Read-PtySelfCpu'),
        run = ps.indexOf('[HubWinptyFixture]::Run');
    assert(a > 0 && b > a && run > end);
    for (const span of [ps.slice(a, b), ps.slice(end, run)])
        assert(
            !/Get-Item|Get-FileHash|ReadAll|FileStream|OpenRead|\.Location|Start-Process/.test(
                span,
            ),
        );
    assert(ps.includes('No physical assembly read authorized on readiness path.'));
    assert.equal((ps.match(/Add-Type -Path/g) || []).length, 1);
});
test('actual PTY opening guard rejects a second helper before accepting its channel or spawning', () => {
    const source = fs.readFileSync(path.join(root, 'tests/fixtures/os-pty.ts'), 'utf8');
    const start =
        source.indexOf("        session.on('shell', (accept) => {") +
        "        session.on('shell', (accept) => {".length;
    const end = source.indexOf('            const child = spawn(', start);
    assert(start > 0 && end > start);
    let holds = 0,
        accepts = 0,
        checks = 0;
    const callback = Function(
        'options',
        'state',
        'holdUnknown',
        'return (accept)=>{' + source.slice(start, end) + '}',
    )({ maxOpenings: 1, check: () => checks++ }, { opens: 1 }, () => holds++);
    assert.throws(
        () =>
            callback(() => {
                accepts++;
                return {};
            }),
        /one helper invocation/,
    );
    assert.equal(holds, 1);
    assert.equal(accepts, 0);
    assert.equal(checks, 0);
});
