// @ts-nocheck
import { ownerStdioCapture } from '../scripts/lib/security-query-owner-stdio.mjs';
import test from 'node:test';
import {
    fixtureJobEnvironment,
    fixtureRuntime,
    fixtureJobTime,
} from './fixtures/security-query-job-admission.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync, spawn } from 'node:child_process';
import {
    queryPolicy as p,
    QueryLifecycle,
    QueryAccounting,
    oldQueryInputs,
    requireQueryInputs,
    parseQueryRequest,
    queryHostedContext,
    querySourceRoot,
} from '../scripts/lib/security-query-diagnostic.mjs';
import {
    collectorEnvironmentKeys,
    projectCollectorEnvironment,
} from '../scripts/lib/product-collector-environment.mjs';
import {
    observeQueryLeaf,
    writeReceipt,
    cancellationBoundary,
    queryOwner,
} from '../scripts/lib/security-query-diagnostic-runtime.mjs';
import { closeEntries, digest } from '../scripts/lib/product-collector-evidence.mjs';
import { prepareProductLogs, createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { RootGuard } from '../scripts/lib/product-collector-files.mjs';
import {
    firstCollectorSecurityQuery,
    runSecurityCommand,
} from '../scripts/lib/pilot-security-command.mjs';
import { collectorObservationSecurity } from '../scripts/lib/observation-security.mjs';
import { readPreparationEvidence } from '../scripts/lib/observation-preparation-evidence.mjs';
const root = querySourceRoot,
    workflow = fs.readFileSync(path.join(root, '.github/workflows/windows-portable.yml'), 'utf8');
const oldJobs = [
    'build',
    'windows-preflight-only',
    'windows-native-pilot',
    'winps-provider-contract',
    'windows-pty-observation',
    'windows-observation-pair',
    'windows-observation-approval',
];
function selected(job, inputs, event = 'workflow_dispatch') {
    const body = workflow.split('\n    ' + job + ':\n')[1].split(/\n    [a-z][a-z-]*:/)[0];
    const exp = body
        .slice(body.indexOf('        if:') + 11)
        .split(/\n        (?:runs-on|timeout-minutes|permissions):/)[0]
        .trim()
        .replace(/^>-\s*/, '')
        .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .replaceAll('github.event_name', JSON.stringify(event))
        .replace(/inputs\.([a-z_0-9]+)/g, (_, k) => JSON.stringify(inputs[k] ?? ''));
    assert(/^[\s()!&|=\w'".{}:-]+$/.test(exp));
    return Boolean(Function('return (' + exp + ')')());
}
const goodInputs = {
    ...oldQueryInputs,
    windows_security_query_only: true,
    security_query_request_json: '{}',
};
test('query selector or orphan JSON excludes all seven old jobs across 512 selector combinations', () => {
    const keys = [
        'windows_preflight_only',
        'windows_native_pilot',
        'windows_pilot_winps_contract',
        'windows_pty_observation_only',
        'windows_observation_pair',
        'observation_request_json',
        'observation_approve_json',
        'windows_security_query_only',
        'security_query_request_json',
    ];
    for (let mask = 0; mask < 512; mask++) {
        const inputs = {
            ...oldQueryInputs,
            ...Object.fromEntries(
                keys.map((k, i) => [
                    k,
                    mask & (1 << i)
                        ? k.endsWith('_json')
                            ? '{}'
                            : true
                        : k.endsWith('_json')
                          ? ''
                          : false,
                ]),
            ),
        };
        if (inputs.windows_security_query_only || inputs.security_query_request_json) {
            assert.deepEqual(
                oldJobs.filter((j) => selected(j, inputs)),
                [],
            );
            const valid =
                inputs.windows_security_query_only &&
                inputs.security_query_request_json &&
                !keys.slice(0, 7).some((k) => inputs[k]);
            assert.equal(selected('windows-security-query-only', inputs), Boolean(valid));
        }
    }
    for (const event of ['push', 'pull_request', 'workflow_call'])
        assert(!selected('windows-security-query-only', goodInputs, event));
});
test('every contradictory or orphan legacy input refuses new route and strict entry', () => {
    assert(selected('windows-security-query-only', goodInputs));
    assert.doesNotThrow(() => requireQueryInputs(goodInputs, '{}'));
    for (const [k, v] of Object.entries(oldQueryInputs)) {
        const inputs = { ...goodInputs, [k]: typeof v === 'boolean' ? true : 'stale' };
        assert(!selected('windows-security-query-only', inputs), k);
        assert.throws(() => requireQueryInputs(inputs, '{}'), k);
    }
    for (const inputs of [
        { ...goodInputs, windows_security_query_only: false },
        { ...goodInputs, security_query_request_json: '' },
        { ...goodInputs, extra: '' },
    ])
        assert.throws(() => requireQueryInputs(inputs, '{}'));
});
test('new job is 15min read-only, credential-free checkout, no npm/native installs, existing jobs preserved', () => {
    const body = workflow.split('    windows-security-query-only:\n')[1];
    assert.match(body, /timeout-minutes: 15/);
    assert.match(body, /permissions:\s*contents: read/);
    assert.match(body, /persist-credentials: false/);
    assert.match(body, /RUNNER_TOOL_CACHE.*24\.21\.0/);
    assert.doesNotMatch(body, /setup-node@|node-version:/);
    assert.match(body, /shell: cmd/);
    assert.match(
        body,
        /--experimental-transform-types\s+scripts\/windows-security-query-diagnostic.mjs/,
    );
    assert.doesNotMatch(
        body.split('        steps:')[1],
        /npm|npx|actions: write|executionpolicy|electron|PTY|Bash|observation-pair\.mts|memory-product-collect\.mts/i,
    );
    const cancel = workflow.split('    cancel-in-progress:')[1].split('\njobs:')[0];
    assert.match(cancel, /inputs\.windows_security_query_only/);
    assert.match(cancel, /inputs\.security_query_request_json/);
    assert.match(workflow, /'-security-query-only'/);
    assert.equal(oldJobs.length, 7);
});
test('shared collector projection exactly preserves prior whitelist; no credentials/capabilities added', () => {
    const expected = [
        'GITHUB_RUN_ATTEMPT',
        'GITHUB_REPOSITORY',
        'GITHUB_SHA',
        'GITHUB_RUN_ID',
        'SystemRoot',
        'SYSTEMROOT',
        'WINDIR',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'APPDATA',
        'LOCALAPPDATA',
        'COMSPEC',
        'ComSpec',
        'PATHEXT',
        'PSModulePath',
        'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'ProgramData',
        'PUBLIC',
    ];
    assert.deepEqual(collectorEnvironmentKeys, expected);
    const env = Object.fromEntries(
        [
            ...expected,
            'GITHUB_TOKEN',
            'NODE_OPTIONS',
            'HUB_WINDOWS_OBSERVATION_PAIR',
            'USERNAME',
            'UNSAFE',
        ].map((k) => [k, 'private-' + k]),
    );
    assert.deepEqual(projectCollectorEnvironment(env, 'reviewed-path'), {
        ...Object.fromEntries(expected.map((k) => [k, env[k]])),
        PATH: 'reviewed-path',
    });
    const collector = fs.readFileSync(
        path.join(root, 'scripts/memory-product-collect.mts'),
        'utf8',
    );
    assert.match(collector, /if \(authority\) assertObservationAuthority\(authority, m\)/);
    assert.match(collector, /Unreviewed runtime environment/);
    assert.match(collector, /Unreviewed Hub override/);
    assert.match(collector, /projectCollectorEnvironment\(process.env, m.childPATH\)/);
    assert.match(collector, /if \(authority\) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN/);
});
const request = () => ({
    schema: 1,
    kind: p.kind,
    repository: 'brucerry/embedded-linux-diagnostic-hub',
    ref: 'refs/heads/validation/windows-metadata-3577982-20261018',
    commit: 'a'.repeat(40),
    sourceSHA256: 'b'.repeat(64),
    policySHA256: digest(
        fs.readFileSync(path.join(root, 'scripts/lib/security-query-diagnostic-policy.json')),
    ),
    workflowSHA256: digest(
        fs.readFileSync(path.join(root, '.github/workflows/windows-portable.yml')),
    ),
    lockfileSHA256: digest(fs.readFileSync(path.join(root, 'package-lock.json'))),
    diagnostic: true,
});
test('request binds exact fields/ref/commit and refuses pair/native capability and noncanonical bytes', () => {
    const r = request(),
        env = { GITHUB_SHA: r.commit, GITHUB_REF: r.ref };
    assert.deepEqual(parseQueryRequest(JSON.stringify(r), env), r);
    for (const change of [
        { kind: 'windows-hosted-native-readiness-pilot-v1' },
        { commit: 'c'.repeat(40) },
        { diagnostic: false },
        { approval: {} },
        { ref: 'refs/heads/main' },
    ])
        assert.throws(() => parseQueryRequest(JSON.stringify({ ...r, ...change }), env));
    assert.throws(() => parseQueryRequest(JSON.stringify(r, null, 2), env));
});
function state() {
    let now = 100;
    const holds = [];
    const life = new QueryLifecycle(now, { now: () => now, hold: (r) => holds.push(r) });
    return {
        life,
        holds,
        set: (n) => {
            now = n;
        },
    };
}
const contract = {
    passed: true,
    casesPassed: 30,
    casesRequired: 30,
    cleanup: { removed: true },
    evidenceClosure: { complete: true },
};
function prime(life) {
    for (let i = 0; i < 30; i++) life.admit('contract');
    life.contract(contract);
    life.admit('node');
}
test('fixed helper sequence admits exactly 14+30+1 WinPS and 2 Node, never a second target', () => {
    const { life } = state();
    for (let i = 0; i < 14; i++) life.admit('parent');
    prime(life);
    life.admit('target');
    assert.deepEqual(life.counts, { parent: 14, contract: 30, target: 1, node: 2 });
    for (const kind of ['parent', 'contract', 'target', 'node'])
        assert.throws(() => life.admit(kind));
});
test('target requires fresh fully closed contract and all deadlines retain cleanup reserve', () => {
    for (const bad of [
        { ...contract, passed: false },
        { ...contract, cleanup: { removed: false } },
        { ...contract, evidenceClosure: { complete: false } },
        { ...contract, casesPassed: 29 },
    ]) {
        const { life } = state();
        assert.throws(() => life.contract(bad));
        assert.throws(() => life.admit('target'));
    }
    const { life, set } = state();
    prime(life);
    set(life.workDeadline - p.queryMs - p.grantMs);
    assert.throws(() => life.admit('node'));
    set(life.workDeadline - p.queryMs);
    assert.throws(() => life.admit('target'));
    assert.equal(life.deadline - life.workDeadline, 60000);
    life.targetAdmitted = true;
    life.leafExited = life.leafClosed = true;
    set(life.deadline - 10001);
    assert.doesNotThrow(() => life.admit('parent', { cleanup: true }));
    set(life.deadline - 10000);
    assert.throws(() => life.admit('parent', { cleanup: true }));
});
test('clock rollback, cancellation and custody hold forbid all future work/release', () => {
    for (const fault of ['rollback', 'cancel', 'hold']) {
        const f = state();
        prime(f.life);
        if (fault === 'rollback') f.set(99);
        if (fault === 'cancel') f.life.cancel('original');
        if (fault === 'hold') {
            f.life.retain({ phase: 'unknown' });
            f.life.retain({ phase: 'later' });
            assert.equal(f.holds.length, 1);
        }
        assert.throws(() => f.life.admit('target'));
        assert.throws(() =>
            f.life.proof({
                logsClosed: true,
                receiptClosed: true,
                inputsUnchanged: true,
                evidenceClosed: true,
            }),
        );
    }
});
test('release proof needs Node exit and pipe close, receipt, raw logs, source and ledger closure', () => {
    for (const missing of [
        'leafExited',
        'leafClosed',
        'logsClosed',
        'receiptClosed',
        'inputsUnchanged',
        'evidenceClosed',
    ]) {
        const { life } = state();
        prime(life);
        life.admit('target');
        life.leafExited = life.leafClosed = true;
        const proof = {
            logsClosed: true,
            receiptClosed: true,
            inputsUnchanged: true,
            evidenceClosed: true,
        };
        if (missing in life) life[missing] = false;
        else proof[missing] = false;
        assert.throws(() => life.proof(proof));
    }
    const { life } = state();
    prime(life);
    life.admit('target');
    life.leafExited = life.leafClosed = true;
    assert(
        Object.values(
            life.proof({
                logsClosed: true,
                receiptClosed: true,
                inputsUnchanged: true,
                evidenceClosed: true,
            }),
        ).every(Boolean),
    );
});
function budget() {
    let own = 0,
        growth = 0,
        count = 0,
        free = 3 * 1024 ** 3;
    const inventory = (dir) => ({
        bytes: dir === 'own' ? own : growth,
        files: new Map(
            Array.from({ length: dir === 'own' ? count : growth ? 1 : 0 }, (_, i) => [
                'f' + i,
                { identity: 'identity', bytes: dir === 'own' ? own : growth },
            ]),
        ),
        allocatedBytes: null,
    });
    const b = new QueryAccounting('own', 'tmp', { inventory, free: () => free });
    return {
        b,
        set: (v) => {
            own = v.own ?? own;
            growth = v.growth ?? growth;
            count = v.count ?? count;
            free = v.free ?? free;
        },
    };
}
for (const fault of ['evidence', 'job', 'cohort', 'files', 'free', 'reservation'])
    test('aggregate pre-admission refuses ' + fault, () => {
        const f = budget();
        if (fault === 'evidence') f.set({ own: p.evidenceBytes + 1 });
        if (fault === 'job') f.set({ growth: p.jobBytes + 1 });
        if (fault === 'cohort') f.set({ growth: p.cohortBytes + 1 });
        if (fault === 'files') f.set({ count: 8193 });
        if (fault === 'free') f.set({ free: p.stopFreeBytes - 1 });
        if (fault === 'reservation') {
            f.set({ own: p.evidenceBytes - 1 });
            assert.throws(() => f.b.reserve());
        } else assert.throws(() => f.b.scan());
    });
test('aggregate partition fits original 10MiB and does not claim hard disk peak', () => {
    const { b } = budget();
    const r = b.reserve();
    assert(r.pending < p.evidenceBytes);
    assert.equal(b.snapshot().filesystemQuotaClaim, false);
    assert.equal(b.snapshot().betweenPollPeakProved, false);
});
const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-query61-')));
for (const fault of ['write', 'sync', 'close'])
    test(
        'durable receipt ' + fault + ' failure retains before rejection; close attempted only once',
        () => {
            const dir = temp(),
                order = [];
            let closes = 0;
            const io = {
                ...fs,
                writeSync(...a) {
                    order.push('write');
                    if (fault === 'write') throw Error('write');
                    return fs.writeSync(...a);
                },
                fsyncSync(fd) {
                    order.push('sync');
                    if (fault === 'sync') throw Error('sync');
                    return fs.fsyncSync(fd);
                },
                closeSync(value) {
                    if (value === fd) {
                        closes++;
                        order.push('close');
                        if (fault === 'close') throw Error('close');
                    }
                    return fs.closeSync(value);
                },
            };
            let fd;
            const original = io.openSync;
            io.openSync = (...a) => {
                const acquired = original(...a);
                if (a[1] === 'wx') fd = acquired;
                return acquired;
            };
            try {
                assert.throws(() =>
                    writeReceipt(
                        path.join(dir, 'r'),
                        {},
                        {
                            io,
                            check() {},
                            admit() {},
                            hold() {
                                order.push('hold');
                            },
                        },
                    ),
                );
                assert.equal(closes, 1);
                assert.equal(order.at(-1), 'hold');
                if (fault === 'close') fs.closeSync(fd);
            } finally {
                fs.rmSync(dir, { recursive: true });
            }
        },
    );
function observedFixture(io = fs) {
    const dir = temp(),
        logs = prepareProductLogs(new RootGuard(dir), ['stdout', 'stderr']),
        child = Object.assign(new EventEmitter(), {
            pid: 123,
            connected: true,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            send(m, cb) {
                cb?.();
            },
        }),
        { life } = state();
    for (const log of logs) log.path = path.join(dir, log.name);
    prime(life);
    let holds = 0,
        grants = 0;
    const observing = observeQueryLeaf(child, {
        life,
        logs,
        nonce: 'n',
        record() {},
        admit() {},
        hold() {
            holds++;
        },
        grant() {
            grants++;
        },
        io,
    });
    observing.catch(() => {});
    return {
        dir,
        logs,
        child,
        life,
        observing,
        get holds() {
            return holds;
        },
        get grants() {
            return grants;
        },
        clean() {
            for (const e of logs)
                if (!e.closed)
                    try {
                        fs.closeSync(e.fd);
                    } catch {}
            fs.rmSync(dir, { recursive: true });
        },
    };
}
test('receipt alone or exit alone does not resolve; actual close and synced raw logs are required', async () => {
    const f = observedFixture();
    try {
        let done = false;
        f.observing.then(() => (done = true));
        f.child.emit('message', { kind: 'query-ready', nonce: 'n' });
        f.child.stdout.write('raw');
        f.child.emit('message', {
            kind: 'query-receipt',
            nonce: 'n',
            receipt: writeReceipt(
                path.join(f.dir, 'receipt.json'),
                {},
                { check() {}, admit() {}, hold() {} },
            ),
        });
        f.child.emit('exit', 0, null);
        await Promise.resolve();
        assert(!done);
        assert(!f.life.leafClosed);
        f.child.emit('close', 0, null);
        const r = await f.observing;
        assert(r.closure.complete);
        assert.deepEqual(r.rawBytes, [3, 0]);
        assert.equal(f.grants, 1);
    } finally {
        f.clean();
    }
});
for (const fault of [
    'missing-exit',
    'nonzero',
    'signal',
    'IPC',
    'duplicate-ready',
    'log-cap',
    'sync',
    'close',
    'provider-held',
])
    test('owner retains on leaf ' + fault + ' without release', async () => {
        const io = { ...fs };
        if (fault === 'sync')
            io.fsyncSync = () => {
                throw Error('sync');
            };
        if (fault === 'close')
            io.closeSync = () => {
                throw Error('close');
            };
        const f = observedFixture(io);
        try {
            f.child.emit('message', { kind: 'query-ready', nonce: 'n' });
            if (fault === 'IPC') f.child.emit('disconnect');
            if (fault === 'duplicate-ready')
                f.child.emit('message', { kind: 'query-ready', nonce: 'n' });
            if (fault === 'log-cap') f.child.stdout.emit('data', Buffer.alloc(p.streamBytes + 1));
            if (fault === 'provider-held')
                f.child.emit('message', { kind: 'query-held', nonce: 'n' });
            f.child.emit('message', {
                kind: 'query-receipt',
                nonce: 'n',
                receipt: writeReceipt(
                    path.join(f.dir, 'receipt.json'),
                    {},
                    { check() {}, admit() {}, hold() {} },
                ),
            });
            if (fault !== 'missing-exit')
                f.child.emit(
                    'exit',
                    fault === 'nonzero' ? 1 : 0,
                    fault === 'signal' ? 'SIGTERM' : null,
                );
            f.child.emit('close', 0, null);
            await assert.rejects(f.observing);
            assert(f.life.held);
            assert(f.holds > 0);
        } finally {
            f.clean();
        }
    });
test('cancel is latched once and sends IPC only, never kills or retires held watchdog', () => {
    const { life } = state(),
        events = new EventEmitter(),
        sent = [],
        callbacks = [];
    const boundary = cancellationBoundary(life, {
        events,
        child: () => ({
            connected: true,
            send(m) {
                sent.push(m);
            },
        }),
        set: (fn) => {
            callbacks.push(fn);
            return 1;
        },
        clear() {},
    });
    events.emit('SIGTERM');
    events.emit('SIGINT');
    assert.equal(life.cancelled, 'SIGTERM');
    assert.equal(sent.length, 1);
    callbacks[1]();
    assert(life.held);
    assert.throws(() => boundary.dispose());
});
test('entry and runtime import inertly using pinned builtin transform without install or child tool effects', () => {
    const result = spawnSync(
        process.execPath,
        [
            '--experimental-transform-types',
            '--input-type=module',
            '-e',
            "await import('./scripts/windows-security-query-diagnostic.mjs'); await import('./scripts/lib/security-query-diagnostic-runtime.mjs'); console.log('INERT')",
        ],
        { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'INERT');
});

for (const mode of ['success', 'target-timeout'])
    test(
        'actual owner/contract/adapter/leaf ' + mode + ' fixed inventory, model WinPS only',
        async () => {
            const { modelReply, identity, exe } =
                await import('./fixtures/security-query-diagnostic-model.mjs');
            const { runWinpsSecurityContract, winpsContractCases } =
                await import('../scripts/lib/pilot-winps-contract.mjs');
            const { sourceFingerprint } = await import('./fixtures/memory-resource-identity.ts');
            const dir = temp(),
                r = { ...request(), sourceSHA256: await sourceFingerprint(root) },
                raw = JSON.stringify(r),
                environment = {
                    ...fixtureJobEnvironment,
                    GITHUB_SHA: r.commit,
                    GITHUB_REF: r.ref,
                    GITHUB_REPOSITORY: r.repository,
                    GITHUB_RUN_ID: '123456',
                    GITHUB_RUN_ATTEMPT: '1',
                    SystemRoot: 'C:\\Windows',
                    TEMP: dir,
                    TMP: dir,
                };
            environment.SECURITY_QUERY_REQUEST_JSON = raw;
            environment.SECURITY_QUERY_INPUTS_JSON = JSON.stringify({
                ...goodInputs,
                security_query_request_json: raw,
            });
            let inContract = false,
                contractIndex = 0,
                parentCalls = 0,
                leafCalls = 0,
                held = false;
            const cases = winpsContractCases(['a', 'b'], 'f', 'm');
            try {
                const running = queryOwner(
                    {
                        startedAt: Number(process.hrtime.bigint() / 1000000n),
                        environment,
                        sourceRoot: root,
                    },
                    {
                        ownerStdio: ownerStdioCapture(),
                        runtime: fixtureRuntime,
                        jobTime: fixtureJobTime,
                        argv: ['node', 'entry'],
                        execArgv: p.runtimeArgs,
                        version: p.runtimeImages[0].node,
                        platform: 'win32',
                        arch: 'x64',
                        cancellation: { events: new EventEmitter(), set: () => 0, clear() {} },
                        accounting: { free: () => 3 * 1024 ** 3 },
                        identity,
                        resolvePowerShell: () => exe,
                        context: () => ({
                            parent: dir,
                            host: {
                                run: '123456',
                                commit: r.commit,
                                repository: r.repository,
                                attempt: '1',
                                actor: 'brucerry',
                            },
                            check() {},
                        }),
                        command(source, powershell, raw, opts) {
                            let expected = 'green';
                            if (inContract) expected = cases[contractIndex++].expected;
                            else parentCalls++;
                            return runSecurityCommand(source, powershell, raw, {
                                ...opts,
                                identity,
                                spawn() {
                                    return {
                                        pid: 321,
                                        status: expected === 'green' ? 0 : 1,
                                        signal: null,
                                        stdout: JSON.stringify(
                                            modelReply({ plans: JSON.parse(raw), expected }),
                                        ),
                                        stderr: '',
                                    };
                                },
                            });
                        },
                        async contract(opts, ports) {
                            inContract = true;
                            try {
                                return await runWinpsSecurityContract(opts, {
                                    ...ports,
                                    resolvePowerShell: () => exe,
                                });
                            } finally {
                                inContract = false;
                            }
                        },
                        spawn(executable, args, opts) {
                            leafCalls++;
                            assert.deepEqual(args.slice(0, 1), p.runtimeArgs);
                            assert.equal(opts.shell, false);
                            assert.deepEqual(
                                opts.env,
                                projectCollectorEnvironment(environment, opts.env.PATH),
                            );
                            return spawn(
                                executable,
                                [
                                    ...p.runtimeArgs,
                                    path.join(
                                        root,
                                        'tests/fixtures/security-query-diagnostic-leaf.mjs',
                                    ),
                                    ...args.slice(-2),
                                    ...(mode === 'target-timeout' ? ['--timeout-fixture'] : []),
                                ],
                                opts,
                            );
                        },
                        hold(state, record, { onRetained }) {
                            held = true;
                            const h = { outcome: Promise.resolve(), snapshot: () => ({}) };
                            onRetained(h);
                            try {
                                record('ownership-held.json', state);
                            } catch {}
                            return h;
                        },
                    },
                );
                if (mode === 'target-timeout') {
                    await assert.rejects(running);
                    assert(held);
                    assert.equal(parentCalls, 10);
                    assert.equal(contractIndex, 30);
                    assert.equal(leafCalls, 1);
                    const owned = path.join(dir, 'diagnostic-hub-security-query-123456-1');
                    assert(fs.existsSync(path.join(dir, 'diagnostic-hub-v060-check.lock')));
                    assert(!fs.existsSync(path.join(owned, 'leaf-result.json')));
                    const heldRow = JSON.parse(
                        fs.readFileSync(path.join(owned, 'leaf-held.json'), 'utf8'),
                    );
                    assert.equal(heldRow.data.state.phase, 'collector-security-query-unknown');
                    assert(!fs.existsSync(path.join(owned, 'collection', 'collector')));
                    return;
                }
                const result = await running;
                assert.equal(held, false);
                assert.equal(result.state, 'released');
                assert.deepEqual(result.counts, { parent: 14, contract: 30, target: 1, node: 2 });
                assert.equal(parentCalls, 14);
                assert.equal(contractIndex, 30);
                assert.equal(leafCalls, 1);
                assert(!fs.existsSync(path.join(dir, 'diagnostic-hub-v060-check.lock')));
                const owned = path.join(dir, 'diagnostic-hub-security-query-123456-1'),
                    rows = [...readPreparationEvidence(path.join(owned, 'preparation'))];
                assert(rows.length > 0);
                assert.equal(
                    JSON.parse(fs.readFileSync(path.join(owned, 'leaf-result.json'), 'utf8'))
                        .actualWinpsExitOrPipeCloseObserved,
                    false,
                );
                assert(!fs.existsSync(path.join(owned, 'collection', 'collector')));
                assert.deepEqual(fs.readdirSync(path.join(owned, 'work')), []);
            } finally {
                if (!held) fs.rmSync(dir, { recursive: true });
            }
        },
    );

test('owner bootstrap queues bounded raw streams, charges both, and sync/closes each descriptor once', () => {
    const d = temp(),
        capture = ownerStdioCapture();
    let charged = 0;
    try {
        capture.write(1, 'warning');
        capture.attach(d, {
            admit: (n) => (charged += n),
            hold() {
                assert.fail('no hold');
            },
            check() {},
        });
        capture.write(0, 'status');
        assert.equal(charged, 13);
        assert.equal(fs.readFileSync(path.join(d, 'owner.stderr.log'), 'utf8'), 'warning');
        assert.equal(fs.readFileSync(path.join(d, 'owner.stdout.log'), 'utf8'), 'status');
        const closure = capture.close(closeEntries);
        assert(closure.complete);
        assert(capture.entries().every((e) => e.synced && e.closed));
        assert.equal(capture.snapshot().closed, true);
    } finally {
        fs.rmSync(d, { recursive: true });
    }
});
for (const fault of ['open-second', 'write', 'sync', 'close', 'overflow'])
    test('owner raw capture ' + fault + ' retains custody and cannot prove completion', () => {
        const d = temp();
        let opens = 0,
            holds = 0;
        const acquired = [];
        const io = {
            ...fs,
            openSync(...a) {
                if (++opens === 2 && fault === 'open-second') throw Error('open');
                const fd = fs.openSync(...a);
                acquired.push(fd);
                return fd;
            },
            writeSync(...a) {
                if (fault === 'write') throw Error('write');
                return fs.writeSync(...a);
            },
            fsyncSync(fd) {
                if (fault === 'sync') throw Error('sync');
                return fs.fsyncSync(fd);
            },
            closeSync(fd) {
                if (fault === 'close') throw Error('close');
                return fs.closeSync(fd);
            },
        };
        const capture = ownerStdioCapture({ io });
        try {
            if (fault === 'open-second')
                assert.throws(() =>
                    capture.attach(d, {
                        admit() {},
                        hold() {
                            holds++;
                        },
                        check() {},
                    }),
                );
            else {
                capture.attach(d, {
                    admit() {},
                    hold() {
                        holds++;
                    },
                    check() {},
                });
                capture.write(0, fault === 'overflow' ? Buffer.alloc(p.streamBytes + 1) : 'raw');
                assert.throws(() => capture.close(closeEntries));
            }
            assert(holds > 0);
            assert.throws(() => capture.check());
        } finally {
            for (const fd of acquired)
                try {
                    fs.closeSync(fd);
                } catch {}
            fs.rmSync(d, { recursive: true });
        }
    });
const hostEnv = () => ({
    ImageOS: 'win25-vs2026',
    ImageVersion: '20261007.264.1',
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows',
    RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_ACTOR: 'brucerry',
    GITHUB_TRIGGERING_ACTOR: 'brucerry',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123',
    HUB_WINDOWS_SECURITY_QUERY_ONLY: '1',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\runner',
    TEMP: 'C:\\Users\\runner\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\runner\\AppData\\Local\\Temp',
    LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local',
});
test('host contract requires manual owner/first attempt, pinned platform/runtime, clean capability env and pinned temp ancestry', () => {
    const opts = {
            platform: 'win32',
            arch: 'x64',
            version: 'v24.21.0',
            tmp: 'C:\\Users\\runner\\AppData\\Local\\Temp',
            bind: (a) => ({ path: a, check() {} }),
        },
        e = hostEnv(),
        c = queryHostedContext(e, opts);
    assert.doesNotThrow(() => c.check());
    e.TEMP += '-changed';
    assert.throws(() => c.check());
    for (const change of [
        { GITHUB_RUN_ATTEMPT: '2' },
        { GITHUB_EVENT_NAME: 'push' },
        { GITHUB_ACTOR: 'other' },
        { GITHUB_TRIGGERING_ACTOR: 'other' },
        { HUB_WINDOWS_OBSERVATION_PAIR: '1' },
        { NODE_OPTIONS: 'secret' },
        { tsx_cache: 'secret' },
        { ELECTRON_DISABLE_SANDBOX: '1' },
    ])
        assert.throws(() => queryHostedContext({ ...hostEnv(), ...change }, opts));
    for (const change of [
        { platform: 'darwin' },
        { arch: 'arm64' },
        { version: 'v24.23.0' },
        {
            bind: () => {
                throw Error('temp alias');
            },
        },
    ])
        assert.throws(() => queryHostedContext(hostEnv(), { ...opts, ...change }));
});
for (const fault of ['rebound', 'tampered-size'])
    test('owner raw ' + fault + ' fails identity/durability proof', () => {
        const d = temp(),
            c = ownerStdioCapture();
        let held = 0;
        try {
            c.attach(d, {
                admit() {},
                hold() {
                    held++;
                },
                check() {},
            });
            c.write(0, 'raw');
            const file = path.join(d, 'owner.stdout.log');
            if (fault === 'rebound') {
                fs.renameSync(file, file + '.old');
                fs.writeFileSync(file, 'raw');
            } else fs.appendFileSync(file, 'extra');
            assert.throws(() => c.close(closeEntries));
            assert(held > 0);
            assert(c.entries().every((e) => e.attempted && e.closed));
        } finally {
            fs.rmSync(d, { recursive: true });
        }
    });
