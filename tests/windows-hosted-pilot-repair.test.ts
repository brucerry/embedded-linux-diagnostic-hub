// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
    pilotLimits,
    bindingDigest,
    requirePilotRuntimeReady,
} from '../scripts/lib/hosted-pilot-contract.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { PilotDiskObserver } from '../scripts/lib/pilot-disk-observer.mjs';
import { parsePilotSecurity } from '../scripts/lib/hosted-pilot-security.mjs';
import { runHostedPilot, nativePilotMain } from '../scripts/windows-native-pilot.mts';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import {
    pilotPathMap,
    nativePilotLaunchRoutes,
    pilotEarlyAppPaths,
} from './fixtures/native-pilot-paths';
import { finalPtyClosure } from './fixtures/pty-closure';
import { finiteNativeReadiness } from './fixtures/windows-native-readiness-pilot';
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

function temp() {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-pilot-repair-'));
}
const now = () => Number(process.hrtime.bigint() / 1000000n);
function controlledChild() {
    return spawn(
        process.execPath,
        [
            '-e',
            "const timer=setTimeout(()=>process.exit(4),5000);process.on('message',()=>{clearTimeout(timer);process.disconnect();});process.send({kind:'controlled-leaf-identity',pid:process.pid,created:performance.timeOrigin});process.stdout.write('ready');",
        ],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
}
function scope(controller = new AbortController(), hold = () => {}) {
    return new NativePilotStartup({
        signal: controller.signal,
        deadline: now() + 10000,
        emit: async () => {},
        hold,
        timeoutMs: 1000,
        identity: (child) =>
            new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(Error('Controlled child identity missing')),
                    1000,
                );
                child.once('message', (m) => {
                    clearTimeout(timer);
                    try {
                        assert.equal(m.kind, 'controlled-leaf-identity');
                        assert.equal(m.pid, child.pid);
                        assert(Number.isFinite(m.created) && m.created > 0);
                        resolve({
                            pid: m.pid,
                            created: String(m.created),
                            basis: 'controlled test leaf self-report; no Windows OS qualification',
                        });
                    } catch (e) {
                        reject(e);
                    }
                });
            }),
        proveDescendants: async (child) => {
            assert.notEqual(child.exitCode, null);
            assert.equal(child.connected, false);
            assert.equal(child.stdout.readableEnded, true);
            assert.equal(child.stderr.readableEnded, true);
        },
    });
}
async function ready(s, c) {
    await s.children.get(c).identityTask;
    assert(s.children.get(c).identity);
}
function stop(c) {
    if (c.connected) c.send({ kind: 'stop' });
}

test('pilot path map supplies actual launch/early routes, preserves environment and rejects replaced/aliased directories', () => {
    const parent = temp(),
        root = path.join(parent, 'diagnostic-hub-native-pilot-' + nonce);
    fs.mkdirSync(root);
    const env = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    try {
        const p = pilotPathMap(root, nonce, true);
        assert.deepEqual(nativePilotLaunchRoutes(p), {
            artifactsDir: path.join(root, 'playwright-artifacts'),
            tracesDir: path.join(root, 'playwright-traces'),
        });
        assert.deepEqual(pilotEarlyAppPaths(p), {
            temp: p.temp,
            crashDumps: p.crash,
            logs: p.logs,
        });
        assert.equal(path.dirname(p.ptyHomeParent), root);
        assert.equal(path.dirname(p.ptyJournalParent), root);
        fs.writeFileSync(path.join(root, 'unexpected-app-file'), 'x');
        assert.throws(p.check, /Unexpected application-owned route/);
        fs.unlinkSync(path.join(root, 'unexpected-app-file'));
        const saved = path.join(parent, 'logs-old');
        fs.renameSync(p.logs, saved);
        fs.mkdirSync(p.logs);
        assert.throws(p.check, /replaced/);
        fs.rmSync(p.logs, { recursive: true });
        fs.renameSync(saved, p.logs);
        const alias = path.join(parent, 'alias');
        fs.symlinkSync(root, alias);
        assert.throws(() => pilotPathMap(alias, nonce));
        assert.deepEqual({ TEMP: process.env.TEMP, TMP: process.env.TMP }, env);
    } finally {
        fs.rmSync(parent, { recursive: true });
    }
});
test('real transient file between scans supplies no peak upper bound; actual scan timings/gaps retained', () => {
    const root = temp();
    let tick = 0;
    const o = new PilotDiskObserver([{ path: root, kind: 'private' }], { clock: () => ++tick });
    try {
        o.scan('before');
        fs.writeFileSync(path.join(root, 'transient'), Buffer.alloc(65536));
        fs.unlinkSync(path.join(root, 'transient'));
        const row = o.scan('after');
        assert.equal(row.measuredPeakLowerBound, 0);
        assert.equal(row.hardNativeDiskCap, false);
        assert.equal(row.transientPeakKnown, false);
        assert.equal(row.capacityQualifiedForFullPair, false);
        assert(row.scanMs > 0 && row.gapMs > 0);
        assert(!('overshootUpperBoundBytes' in row));
        assert(!('peakUpperBound' in row));
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
for (const failure of ['excess', 'scan-failure', 'unexpected-route'])
    test('observer ' + failure + ' stops admission and records failure', () => {
        const root = temp();
        let stopped = 0;
        const o = new PilotDiskObserver([{ path: root, kind: 'private' }], {
            stop: () => stopped++,
            check: () => {
                if (failure === 'unexpected-route') throw Error('unexpected app route');
            },
        });
        try {
            if (failure === 'excess') {
                const fd = fs.openSync(path.join(root, 'sparse'), 'wx');
                fs.ftruncateSync(fd, pilotLimits.treeBytes + 1);
                fs.closeSync(fd);
            }
            if (failure === 'scan-failure') fs.symlinkSync(root, path.join(root, 'alias'));
            assert.throws(() => o.scan('failure'));
            assert.equal(stopped, 1);
            assert(o.failed);
            assert.equal(o.snapshot().capacityQualifiedForFullPair, false);
        } finally {
            fs.rmSync(root, { recursive: true });
        }
    });
test('real exposed child remains registered when outer factory throws before returning driver', async () => {
    let holds = 0;
    const s = scope(new AbortController(), () => holds++);
    let child;
    try {
        await assert.rejects(async () => {
            child = s.spawn('build-before-reject', controlledChild, stop);
            await ready(s, child);
            throw Error('factory rejected after spawn');
        });
        assert.equal(s.children.size, 1);
        assert(!s.children.get(child).close);
        stop(child);
        const proof = await s.join();
        assert.equal(proof.complete, true);
        assert.equal(proof.children.length, 1);
        assert(proof.children[0].exit && proof.children[0].close);
        assert.equal(holds, 0);
    } finally {
        if (child?.connected) stop(child);
    }
});
test('opaque launch rejection without process handle remains unknown and cannot join', async () => {
    let holds = 0;
    const s = scope(new AbortController(), () => holds++);
    await assert.rejects(
        s.opaque(
            'launch',
            async () => {
                throw Error('opaque launcher failed');
            },
            () => assert.fail(),
            async () => {},
        ),
    );
    await assert.rejects(s.join(), /Opaque/);
    assert(holds >= 1);
    assert(s.operations.get('launch').unknown);
});
for (const port of ['build', 'launch'])
    for (const reason of ['abort', 'disconnect'])
        test(
            'held ' + port + ' ' + reason + ' forwards stop and refuses late startup',
            async () => {
                let holds = 0;
                const controller = new AbortController(),
                    s = scope(controller, () => holds++);
                let resolve;
                const c = s.spawn('owned-build', controlledChild, stop);
                await ready(s, c);
                const waiting = s.opaque(
                    port + '-await',
                    () => new Promise((r) => (resolve = r)),
                    () => {},
                    async () => {},
                );
                controller.abort(Error(reason));
                resolve({});
                await assert.rejects(waiting);
                await s.join();
                assert.throws(() =>
                    s.spawn(
                        'late',
                        () => assert.fail(),
                        () => {},
                    ),
                );
                assert.equal(holds, 0);
            },
        );
const receipt = {
    complete: true,
    bashExited: true,
    agentExited: true,
    inputPumpJoined: true,
    outputPumpJoined: true,
    outputDrained: true,
    pipesClosed: true,
    handlesClosed: true,
    terminationConfirmed: true,
    childPid: 123,
    agentPid: 124,
    childCreated: '12345',
    agentCreated: '12346',
};
for (const bit of [
    'bashExited',
    'agentExited',
    'inputPumpJoined',
    'outputPumpJoined',
    'outputDrained',
    'pipesClosed',
    'handlesClosed',
    'terminationConfirmed',
])
    test('PTY ' + bit + ' failure cannot authorize HOME cleanup', () => {
        const root = temp();
        fs.writeFileSync(path.join(root, 'owned-HOME'), 'keep');
        let removed = false;
        try {
            assert.throws(() => {
                finalPtyClosure('HUB_OS_PTY_CLOSE ' + JSON.stringify({ ...receipt, [bit]: false }));
                fs.rmSync(root, { recursive: true });
                removed = true;
            });
            assert(!removed && fs.existsSync(path.join(root, 'owned-HOME')));
        } finally {
            fs.rmSync(root, { recursive: true });
        }
    });
test('PTY missing/duplicate/malformed leaf receipts refuse closure', () => {
    for (const text of [
        '',
        'HUB_OS_PTY_CLOSE {}',
        'HUB_OS_PTY_CLOSE ' +
            JSON.stringify(receipt) +
            '\nHUB_OS_PTY_CLOSE ' +
            JSON.stringify(receipt),
    ])
        assert.throws(() => finalPtyClosure(text));
    assert.equal(finalPtyClosure('HUB_OS_PTY_CLOSE ' + JSON.stringify(receipt)).complete, true);
});
function ace(sid, flags) {
    const pieces = sid.split('-').slice(1).map(Number),
        sub = pieces.slice(2),
        b = Buffer.alloc(16 + sub.length * 4);
    b[0] = 0;
    b[1] = flags;
    b.writeUInt16LE(b.length, 2);
    b.writeUInt32LE(0x1f01ff, 4);
    b[8] = 1;
    b[9] = sub.length;
    b.writeUIntBE(pieces[1], 10, 6);
    sub.forEach((v, i) => b.writeUInt32LE(v, 16 + i * 4));
    return { type: 0, flags, binary: b.toString('base64') };
}
function security(kind = 'file', flags = 16) {
    const principal = 'S-1-5-21-1-2-3-500',
        p = 'C:\\Temp\\owned.lock';
    return {
        schema: 1,
        complete: true,
        principal,
        rows: [
            {
                path: p,
                kind,
                owner: 'S-1-5-32-544',
                group: 'S-1-5-21-1-2-3-513',
                daclPresent: true,
                daclNull: false,
                aces: ['S-1-5-18', 'S-1-5-32-544', principal].map((s) => ace(s, flags)),
                binary: Buffer.alloc(32, 1).toString('base64'),
            },
        ],
    };
}
test('fresh marker readback admits file flags 0x10 separately and refuses directory flags/mismatched identity', () => {
    const v = security();
    const plans = [{ path: v.rows[0].path, kind: 'file' }];
    assert(parsePilotSecurity(JSON.stringify(v), plans, v.principal).rows[0].descriptorSHA256);
    assert.throws(() =>
        parsePilotSecurity(JSON.stringify(security('file', 19)), plans, v.principal),
    );
    assert.throws(() =>
        parsePilotSecurity(
            JSON.stringify(v),
            [{ ...plans[0], path: plans[0].path + 'x' }],
            v.principal,
        ),
    );
    assert.throws(() => parsePilotSecurity(JSON.stringify(v), plans, 'S-1-5-21-9-9-9-500'));
});
async function ownedRun(options = {}) {
    const dir = temp(),
        events = new EventEmitter(),
        b = binding(),
        marker = path.join(dir, 'actual.lock'),
        lease = new ProductLease(marker, { nonce, bindingSHA256: bindingDigest(b) });
    let clockNow = 0,
        id = 0,
        holds = 0,
        owner;
    const timers = new Map(),
        order = [],
        children = [],
        descriptors = [];
    const io = {
        ...fs,
        fsyncSync(fd) {
            if (options.syncFail) throw Error('injected sync');
            fs.fsyncSync(fd);
        },
        closeSync(fd) {
            if (options.closeFail) throw Error('injected close');
            fs.closeSync(fd);
        },
    };
    const evidence = new PilotEvidence(dir, { io });
    descriptors.push(evidence.entry.fd);
    const clock = {
        now: () => clockNow,
        set: (fn, ms) => {
            timers.set(++id, { fn, ms });
            return id;
        },
        clear: (h) => timers.delete(h),
    };
    const startup = scope(new AbortController(), () => holds++);
    const ports = {
        lease,
        events,
        clock,
        executionGate: () => {},
        onOwner: (o) => (owner = o),
        record: (s, d) => evidence.append(s, d),
        hold: (state, record) => {
            holds++;
            try {
                record('held', state);
            } catch {}
            return { snapshot: () => ({ attached: true, referencedHandleCreated: true }) };
        },
        verify: async (observed) => {
            assert.deepEqual(observed, b);
            if (options.heldVerification) {
                const pending = new Promise((r) => (options.resolveVerification = r));
                options.owner = owner;
                await pending;
            }
            return observed;
        },
        closeEvidence: async () => evidence.close(),
        beforeStage: async () => {},
        spawnStage: (stage, o) => {
            order.push(stage);
            const c = startup.spawn(stage, controlledChild, stop);
            children.push(c);
            return c;
        },
        waitStage: async (c, o) => {
            await ready(startup, c);
            if (options.cancel) {
                clockNow = 540001;
                events.emit(options.cancel);
                assert.equal(c.connected, true);
                assert.equal(o.cancelled, options.cancel);
            } else if (options.failedCode) c.exitCode = 1;
            stop(c);
            await startup.children.get(c).closed;
        },
        joinStage: async (c) => {
            await startup.children.get(c).descendants();
            if (options.missingDescendant) throw Error('Descendant closure missing');
            return { descendantsClosed: true, leafReceiptsClosed: true, logsClosed: true };
        },
        recheckInputs: async () => true,
        cleanupRoots: async () => {
            await startup.join();
            return true;
        },
    };
    const promise = runHostedPilot(b, ports);
    return {
        dir,
        marker,
        lease,
        order,
        promise,
        options,
        get owner() {
            return owner;
        },
        holds: () => holds,
        clock: () => clockNow,
        async dispose() {
            for (const c of children) if (c.connected) stop(c);
            for (const c of children) await startup.children.get(c).closed;
            for (const fd of descriptors)
                try {
                    fs.closeSync(fd);
                } catch {}
            fs.rmSync(dir, { recursive: true });
        },
    };
}
test('actual proposed entry uses real leases/FDs and exactly PTY then one native stage with no third launch', async () => {
    const f = await ownedRun();
    try {
        const r = await f.promise;
        assert.deepEqual(f.order, ['real-os-pty', 'native-electron-store']);
        assert.equal(r.passed, true);
        assert.equal(r.state, 'released');
        assert.equal(r.capacityQualifiedForFullPair, false);
        assert(!fs.existsSync(f.marker));
        assert.equal(f.holds(), 0);
    } finally {
        await f.dispose();
    }
});
for (const cancel of ['SIGTERM', 'SIGINT', 'disconnect'])
    test(
        'actual entry ' +
            cancel +
            ' at work cutoff joins and releases in cleanup reserve with failed verdict',
        async () => {
            const f = await ownedRun({ cancel });
            try {
                const r = await f.promise;
                assert.equal(r.passed, false);
                assert.equal(r.state, 'released');
                assert.deepEqual(f.order, ['real-os-pty']);
                assert(!fs.existsSync(f.marker));
                assert(f.clock() > 540000 && f.clock() < 600000);
            } finally {
                await f.dispose();
            }
        },
    );
test('held same-job verification cancellation rejects late approval, runs no stage, then releases known closure', async () => {
    const options = { heldVerification: true };
    const f = await ownedRun(options);
    try {
        options.owner.cancel('verification cancelled');
        options.resolveVerification();
        const r = await f.promise;
        assert.equal(r.passed, false);
        assert.deepEqual(f.order, []);
        assert(!fs.existsSync(f.marker));
    } finally {
        await f.dispose();
    }
});
for (const failure of ['syncFail', 'closeFail', 'missingDescendant'])
    test('actual entry ' + failure + ' keeps real marker and attached ownership', async () => {
        const f = await ownedRun({ [failure]: true });
        try {
            await assert.rejects(f.promise);
            assert(fs.existsSync(f.marker));
            assert.equal(f.owner.state, 'held');
            assert(f.holds() > 0);
        } finally {
            await f.dispose();
        }
    });
test('metadata selector cannot bypass native gate or enroll CLI', async () => {
    assert.throws(
        () =>
            requirePilotRuntimeReady({
                HUB_WINDOWS_NATIVE_PILOT: '1',
                HUB_WINDOWS_PREFLIGHT_ONLY: '1',
            }),
        /Metadata-only/,
    );
    await assert.rejects(
        nativePilotMain([], { HUB_WINDOWS_PREFLIGHT_ONLY: '1' }),
        /Separate native/,
    );
});

test('actual finite native adapter forwards the pilot path/startup context and runs one 64 KiB normal-GC cycle', async () => {
    const root = temp();
    const pilot = { root, check: () => {} };
    const startup = { identity: 'test-startup' };
    let options,
        cycles = 0;
    try {
        const result = await finiteNativeReadiness({
            privateRoot: root,
            pilot,
            startup,
            nativeCoverage: {},
            signal: new AbortController().signal,
            workDeadlineMs: now() + 10000,
            emit: async () => {},
            holdUnknown: () => assert.fail(),
            gate: () => {},
            createDriver: async (value) => {
                options = value;
                return {
                    cycle: async (value) => {
                        cycles++;
                        assert.deepEqual(value, {
                            phase: 'measured',
                            ordinal: 1,
                            payloadBytes: 65536,
                            catalogMode: 'growing',
                        });
                        return {
                            coverage: [
                                'native-renderer-generation-reset-reopen',
                                'export-cancel',
                                'export-failure',
                                'clear-reopen',
                            ],
                        };
                    },
                    teardown: async () => {},
                    assertDescendantsExited: async () => {},
                };
            },
        });
        assert.equal(options.pilot, pilot);
        assert.equal(options.startup, startup);
        assert.equal(options.gcMode, 'normal');
        assert.equal(options.profile, path.join(root, 'native-profile'));
        assert.equal(cycles, 1);
        assert.equal(result.fullCollection, false);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
for (const failure of ['sync', 'close'])
    test(
        'real pilot evidence ' +
            failure +
            ' failure never claims descriptor closure or self-releases',
        () => {
            const root = temp();
            const e = new PilotEvidence(root, {
                io: {
                    ...fs,
                    fsyncSync(fd) {
                        if (failure === 'sync') throw Error('sync failed');
                        fs.fsyncSync(fd);
                    },
                    closeSync(fd) {
                        if (failure === 'close') throw Error('close failed');
                        fs.closeSync(fd);
                    },
                },
            });
            try {
                const proof = e.close();
                assert.equal(proof.complete, false);
                if (failure === 'close') assert(fs.fstatSync(e.entry.fd).isFile());
                else assert.equal(e.entry.synced, false);
            } finally {
                try {
                    fs.closeSync(e.entry.fd);
                } catch {}
                fs.rmSync(root, { recursive: true });
            }
        },
    );

test('manual workflow selectors preserve standing build steps and require separate pilot identities', async () => {
    const { load: parse } = await import('js-yaml');
    const flow = parse(
        fs.readFileSync(
            path.join(import.meta.dirname, '../.github/workflows/windows-portable.yml'),
            'utf8',
        ),
    );
    assert.equal(flow.on.workflow_dispatch.inputs.windows_native_pilot.default, false);
    assert.equal(flow.on.workflow_dispatch.inputs.windows_preflight_only.default, false);
    assert.match(
        flow.jobs.build.if,
        /inputs\.windows_preflight_only \|\| inputs\.windows_native_pilot/,
    );
    assert.match(flow.jobs['windows-preflight-only'].if, /!inputs\.windows_native_pilot/);
    const pilot = flow.jobs['windows-native-pilot'];
    assert.equal(pilot.env.HUB_WINDOWS_NATIVE_PILOT, '1');
    assert(!('HUB_WINDOWS_PREFLIGHT_ONLY' in pilot.env));
    assert.match(pilot.steps[0].run, /mutually exclusive/);
    assert.match(pilot.steps[0].run, /GITHUB_RUN_ATTEMPT/);
    for (const key of [
        'pilot_source_sha256',
        'pilot_policy_sha256',
        'pilot_coverage_sha256',
        'pilot_coverage_json',
    ])
        assert(key in flow.on.workflow_dispatch.inputs);
    const run = pilot.steps.find(
        (s) => s.name === 'Run exactly one same-owner PTY then finite native cycle',
    );
    assert.match(run.run, /scripts\/windows-native-pilot\.mts/);
    assert.doesNotMatch(run.run, /memory-product-collect|finite-growth/);
    assert.equal(pilot['timeout-minutes'], 15);
});
