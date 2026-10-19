// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    securityLaunch,
    runSecurityCommand,
    requireSecurityProcess,
} from '../scripts/lib/pilot-security-command.mjs';
import {
    winpsContractCases,
    requireWinpsContractReply,
    runWinpsSecurityContract,
    winpsContractLimits,
} from '../scripts/lib/pilot-winps-contract.mjs';
import {
    prepareAndFreezePilotDependencies,
    settledElectronExecutable,
} from '../scripts/lib/pilot-dependencies.mjs';
import { dependencyFacts, digest, fileIdentity } from '../scripts/lib/windows-preflight.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { winpsContractMain } from '../scripts/windows-pilot-winps-contract.mts';
const windowsPath = (...parts) => parts.join(String.fromCharCode(92)),
    exe = windowsPath('C:', 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    root = path.resolve(import.meta.dirname, '..'),
    h = 'a'.repeat(64),
    principal = 'S-1-5-21-1-2-3-500';
const temp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-winps-boundary-'));
const shape = (type, count = 1, array = false) => ({ type, count, array });
function ace(sid, flags) {
    const pieces = sid.split('-').slice(1).map(Number),
        sub = pieces.slice(2),
        b = Buffer.alloc(16 + sub.length * 4);
    b[1] = flags;
    b.writeUInt16LE(b.length, 2);
    b.writeUInt32LE(0x1f01ff, 4);
    b[8] = 1;
    b[9] = sub.length;
    b.writeUIntBE(pieces[1], 10, 6);
    sub.forEach((v, i) => b.writeUInt32LE(v, 16 + i * 4));
    return { type: 0, flags, binary: b.toString('base64') };
}
function modelReply(c, script = path.join(root, 'scripts/lib/hosted-pilot-security.ps1')) {
    const interpreter = {
        path: exe,
        script,
        version: '5.1.26100.1234',
        edition: 'Desktop',
        x64: true,
    };
    const trace = {
        root: shape('System.Object[]', Array.isArray(c.plans) ? c.plans.length : 1, true),
        rootElements: [],
        rows: [],
        getItemCalls: 0,
        getAclCalls: 0,
        red: null,
    };
    const reply = {
        schema: 1,
        complete: c.expected === 'green',
        principal,
        interpreter,
        trace,
        rows: [],
        error: null,
    };
    if (c.expected === 'legacy-red') {
        trace.root = shape('System.Object[]', 1, true);
        trace.rootElements = [shape('System.Object[]', 2, true)];
        trace.red = {
            plan: shape('System.Object[]', 2, true),
            path: shape('System.Object[]', 2, true),
            item: shape('System.Object[]', 2, true),
            attributes: shape('System.Object[]', 2, true),
            itemTypes: ['System.IO.DirectoryInfo', 'System.IO.DirectoryInfo'],
        };
        trace.getItemCalls = 1;
        reply.error = {
            id: 'MethodNotFound',
            message: 'System.Object[] does not contain op_BitwiseAnd',
        };
    } else if (c.expected === 'green')
        for (const plan of c.plans) {
            trace.rootElements.push(shape('System.Management.Automation.PSCustomObject'));
            trace.getItemCalls++;
            trace.getAclCalls++;
            trace.rows.push({
                plan: shape('System.Management.Automation.PSCustomObject'),
                path: shape('System.String'),
                kind: shape('System.String'),
                item: shape(
                    plan.kind === 'file' ? 'System.IO.FileInfo' : 'System.IO.DirectoryInfo',
                ),
                attributes: shape('System.IO.FileAttributes'),
                container: shape('System.Boolean'),
                acl: shape(
                    plan.kind === 'file'
                        ? 'System.Security.AccessControl.FileSecurity'
                        : 'System.Security.AccessControl.DirectorySecurity',
                ),
            });
            reply.rows.push({
                path: plan.path,
                kind: plan.kind,
                owner: 'S-1-5-32-544',
                group: 'S-1-5-21-1-2-3-513',
                daclPresent: true,
                daclNull: false,
                aces: ['S-1-5-18', 'S-1-5-32-544', principal].map((s) =>
                    ace(s, plan.kind === 'file' ? 16 : 19),
                ),
                binary: Buffer.alloc(32, 1).toString('base64'),
            });
        }
    else {
        trace.getItemCalls = c.expected === 'reject-before-provider' ? 0 : 1;
        trace.getAclCalls = c.expected === 'reject-kind' ? 1 : 0;
        reply.error = {
            id: 'controlled-unit-rejection',
            message: 'Controlled reply for Node boundary tests only',
        };
    }
    return reply;
}
const cases = winpsContractCases(
    [windowsPath('C:', 'one'), windowsPath('C:', 'two')],
    windowsPath('C:', 'file'),
    windowsPath('C:', 'missing'),
);
test('finite case matrix contains exact legacy two-directory case, real-provider green shapes and all invalid boundaries', () => {
    assert.equal(cases.length, 30);
    assert.deepEqual(
        cases.filter((c) => c.expected === 'green').map((c) => c.plans.length),
        [1, 2, 3],
    );
    for (const name of [
        'nested',
        'count-value-wrapper',
        'wrapped-row',
        'path-array',
        'kind-array',
        'missing-path',
        'extra-field',
        'null-root',
        'relative-path',
        'nul-path',
        'overlong-path',
        'four-rows',
        'file-as-directory',
        'directory-as-file',
        'missing-literal',
    ])
        assert(cases.some((c) => c.name === name));
});
for (const c of cases)
    test(
        'production Node contract validator checks ' +
            c.name +
            ' without claiming a real interpreter run',
        () => {
            const reply = modelReply(c);
            assert.doesNotThrow(() =>
                requireWinpsContractReply(
                    reply,
                    c,
                    exe,
                    path.join(root, 'scripts/lib/hosted-pilot-security.ps1'),
                    principal,
                ),
            );
        },
    );
for (const [name, change] of [
    ['root array wrapper', (r) => (r.trace.rootElements[0] = shape('System.Object[]', 2, true))],
    ['PS7', (r) => (r.interpreter.version = '7.5.0')],
    ['Core', (r) => (r.interpreter.edition = 'Core')],
    ['x86', (r) => (r.interpreter.x64 = false)],
    ['wrong executable', (r) => (r.interpreter.path = exe + 'other')],
    ['array attributes', (r) => (r.trace.rows[0].attributes = shape('System.Object[]', 2, true))],
    ['array path', (r) => (r.trace.rows[0].path = shape('System.Object[]', 2, true))],
    [
        'wrong ACL type',
        (r) => (r.trace.rows[0].acl = shape('System.Security.AccessControl.FileSecurity')),
    ],
    ['missing provider call', (r) => (r.trace.getItemCalls = 0)],
    [
        'wrong file ACE flags',
        (r) => (r.rows[2].aces = r.rows[2].aces.map((a) => ({ ...a, flags: 19 }))),
    ],
])
    test('production validator refuses ' + name, () => {
        const c = cases.find((c) => c.name === 'directories-and-file'),
            reply = modelReply(c);
        change(reply);
        assert.throws(() =>
            requireWinpsContractReply(
                reply,
                c,
                exe,
                path.join(root, 'scripts/lib/hosted-pilot-security.ps1'),
                principal,
            ),
        );
    });
test('production launch is exact System32 WinPS File invocation; only child PSModulePath is isolated', () => {
    const env = {
            PSModulePath: 'inherited',
            psmodulepath: 'also inherited',
            TEMP: 'original',
            TMP: 'original-tmp',
            HUB_NATIVE_PILOT_SECURITY_RED_CONTROL: '1',
        },
        before = { ...env },
        json = JSON.stringify(cases[1].plans);
    const launch = securityLaunch(root, exe, json, env);
    assert.deepEqual(launch.args, [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(root, 'scripts/lib/hosted-pilot-security.ps1'),
    ]);
    assert.equal(launch.options.env.HUB_NATIVE_PILOT_SECURITY_PATHS, json);
    assert(!Object.keys(launch.options.env).some((k) => k.toLowerCase() === 'psmodulepath'));
    assert(!launch.options.env.HUB_NATIVE_PILOT_SECURITY_RED_CONTROL);
    assert.equal(launch.options.env.TEMP, env.TEMP);
    assert.equal(launch.options.env.TMP, env.TMP);
    assert.deepEqual(env, before);
    assert.equal(launch.options.timeout, 10000);
    assert.equal(launch.options.maxBuffer, 65536);
    assert.equal(launch.options.shell, false);
});
const fakeIdentity = (file) => ({
    path: file,
    sha256: h,
    ...(file === exe ? { pe: { architecture: 'x64' } } : {}),
});
for (const fault of ['process-error', 'nonzero', 'parse', 'schema', 'bounds'])
    test(
        'actual command wrapper preserves bounded raw evidence before ' + fault + ' assertion',
        () => {
            const rows = [],
                json = JSON.stringify(cases[1].plans);
            const result = { status: 0, signal: null, stdout: '{}', stderr: 'retained stderr' };
            if (fault === 'process-error')
                Object.assign(result, {
                    status: null,
                    error: Error('controlled transport failure'),
                });
            if (fault === 'nonzero') result.status = 1;
            if (fault === 'parse') result.stdout = '{';
            if (fault === 'bounds') result.stdout = 'X'.repeat(65537);
            const observed = runSecurityCommand(root, exe, json, {
                identity: fakeIdentity,
                spawn: () => result,
                record: (stage, data) => rows.push({ stage, data }),
            });
            assert.equal(rows[0].stage, 'security-input');
            assert.equal(rows[0].data.json, json);
            assert(rows.some((r) => r.stage === 'security-output' && r.data.stream === 'stderr'));
            assert.equal(rows.at(-1).stage, 'security-command-closed');
            assert.throws(() => {
                requireSecurityProcess(observed.result);
                const value = JSON.parse(observed.stdout);
                requireWinpsContractReply(
                    value,
                    cases[1],
                    exe,
                    path.join(root, 'scripts/lib/hosted-pilot-security.ps1'),
                );
            });
            for (const row of rows) assert(Buffer.byteLength(JSON.stringify(row)) <= 65536);
            if (fault === 'bounds') {
                assert.equal(observed.result.streams.stdout.truncated, true);
                assert.equal(observed.result.streams.stdout.retainedBytes, 65536);
            }
        },
    );
test('raw input persistence failure refuses the command before spawning', () => {
    let calls = 0;
    assert.throws(() =>
        runSecurityCommand(root, exe, '[]', {
            identity: fakeIdentity,
            spawn: () => {
                calls++;
            },
            record: () => {
                throw Error('fsync failed');
            },
        }),
    );
    assert.equal(calls, 0);
});
test('Electron materialization port settles before the complete dependency digest is frozen', () => {
    const dir = temp(),
        order = [];
    fs.mkdirSync(path.join(dir, 'node_modules'));
    const fake = path.join(dir, 'node_modules', 'settled-electron.exe');
    try {
        const r = prepareAndFreezePilotDependencies(dir, {
            resolve: () => {
                order.push('resolve');
                fs.writeFileSync(fake, 'known settled dependency');
                return fake;
            },
            freeze: (p, check) => {
                order.push('freeze');
                assert.equal(fs.readFileSync(fake, 'utf8'), 'known settled dependency');
                return dependencyFacts(p, check);
            },
            record: (stage) => order.push(stage),
        });
        assert.deepEqual(order, [
            'resolve',
            'electron-dependency-settled',
            'freeze',
            'dependency-identity-frozen',
        ]);
        assert.equal(
            r.dependencies.sha256,
            dependencyFacts(path.join(dir, 'node_modules'), () => {}).sha256,
        );
        fs.writeFileSync(fake, 'late mutation');
        assert.notEqual(
            r.dependencies.sha256,
            dependencyFacts(path.join(dir, 'node_modules'), () => {}).sha256,
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
test('missing settled Electron refuses before dependency freeze and performs no lazy resolution', () => {
    let freezes = 0;
    assert.throws(
        () =>
            prepareAndFreezePilotDependencies(root, {
                resolve: () => {
                    throw Error('Missing settled Electron');
                },
                freeze: () => {
                    freezes++;
                },
            }),
        /Missing settled/,
    );
    assert.equal(freezes, 0);
    const code = fs.readFileSync(path.join(root, 'scripts/lib/pilot-dependencies.mjs'), 'utf8');
    assert.doesNotMatch(code, /require\(['"]electron['"]\)|spawn|install\.js/);
});
test('native entry wires real contract before Electron preparation and freezes no lazy Electron index', () => {
    const code = fs.readFileSync(path.join(root, 'scripts/windows-native-pilot.mts'), 'utf8');
    assert(
        code.indexOf('await runWinpsSecurityContract(') <
            code.indexOf('prepareAndFreezePilotDependencies(root'),
    );
    assert.doesNotMatch(code, /electron: require\(['"]electron['"]\)/);
    assert.match(code, /electron: prepared.electron/);
    assert.match(code, /closeEvidence:[\s\S]*entryEvidence.close/);
});
test('WinPS production green boundary has direct assignment and refuses scalar/provider arrays without first-item coercion', () => {
    const code = fs.readFileSync(path.join(root, 'scripts/lib/hosted-pilot-security.ps1'), 'utf8');
    const green = code.slice(code.indexOf('# Direct assignment'));
    assert.match(green, /\$plans = ConvertFrom-Json -InputObject/);
    assert.doesNotMatch(green, /\$plans = @\(ConvertFrom-Json/);
    assert.match(green, /\$item -isnot \[IO.FileSystemInfo\]/);
    assert.match(green, /\$attributes -isnot \[IO.FileAttributes\]/);
    assert.doesNotMatch(green, /Select-Object -First|\$item\[0\]|\[int\]\$item.Attributes/);
    const pattern = green.match(/-notmatch '([^']+)'/)[1];
    assert(new RegExp(pattern).test(windowsPath('C:', 'safe')));
});
test('separately selected contract job runs no native entry or Electron resolver', async () => {
    const { load } = await import('js-yaml');
    const flow = load(
        fs.readFileSync(path.join(root, '.github/workflows/windows-portable.yml'), 'utf8'),
    );
    assert.equal(flow.on.workflow_dispatch.inputs.windows_pilot_winps_contract.default, false);
    const job = flow.jobs['winps-provider-contract'];
    assert.equal(job['timeout-minutes'], 8);
    assert.equal(
        job.if,
        "github.event_name == 'workflow_dispatch' && !inputs.windows_observation_pair && !inputs.observation_request_json && !inputs.observation_approve_json && inputs.windows_pilot_winps_contract && !inputs.windows_pty_observation_only",
    );
    assert.match(job.steps[0].run, /mutually exclusive/);
    assert.match(flow.jobs['windows-native-pilot'].if, /!inputs.windows_pilot_winps_contract/);
    assert.match(flow.jobs['windows-preflight-only'].if, /!inputs.windows_pilot_winps_contract/);
    assert.equal(job.env.HUB_WINDOWS_PILOT_WINPS_CONTRACT, '1');
    assert(!('HUB_WINDOWS_NATIVE_PILOT' in job.env));
    assert(!('needs' in job));
    const commands = job.steps.map((s) => s.run ?? '').join('\n');
    assert.match(commands, /scripts\/windows-pilot-winps-contract.mts/);
    assert.doesNotMatch(
        commands,
        /windows-native-pilot\.mts|require\(['"]electron['"]\)|install\.js|winpty/,
    );
});
test('standalone entry refuses native/metadata selector combinations before any contract process', async () => {
    await assert.rejects(
        winpsContractMain([], {
            HUB_WINDOWS_PILOT_WINPS_CONTRACT: '1',
            HUB_WINDOWS_NATIVE_PILOT: '1',
        }),
    );
    await assert.rejects(
        winpsContractMain([], {
            HUB_WINDOWS_PILOT_WINPS_CONTRACT: '1',
            HUB_WINDOWS_PREFLIGHT_ONLY: '1',
        }),
    );
});

async function controlledContract({ fault = null, io = fs } = {}) {
    const controller = new AbortController();
    let clockReads = 0,
        contractTime = 139999;
    const processStates = [],
        holdProbes = [];
    const dir = temp(),
        out = path.join(dir, 'evidence');
    fs.mkdirSync(out);
    let journal,
        calls = 0,
        held = 0;
    const script = path.join(root, 'scripts/lib/hosted-pilot-security.ps1');
    const context = {
        parent: dir,
        host: {
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            run: '1',
            attempt: '1',
            commit: 'b'.repeat(40),
            environment: 'github-hosted',
        },
        check() {},
    };
    const command = (sourceRoot, powershell, raw, options) => {
        calls++;
        return runSecurityCommand(sourceRoot, powershell, raw, {
            ...options,
            identity: fakeIdentity,
            onProcessState: (state) => {
                processStates.push(state);
                options.onProcessState?.(state);
            },
            record: (stage, data) => {
                if (fault?.includes('report') && stage === 'security-output')
                    throw Error('controlled post-call reporting failure');
                return options.record(stage, data);
            },
            spawn: () => {
                if (fault === 'process-cancel' || fault === 'joined-cancel')
                    controller.abort(Error('cancelled during uncertain command'));
                if (fault === 'process-deadline' || fault === 'joined-deadline')
                    contractTime = 150001;
                if (fault?.startsWith('process'))
                    return {
                        status: null,
                        signal: null,
                        error: Error('controlled query failed'),
                        stdout: '',
                        stderr: 'retained process error',
                    };
                if (fault === 'parse' || fault?.startsWith('joined-'))
                    return { status: 1, signal: null, stdout: '{', stderr: 'retained parse error' };
                if (fault === 'schema')
                    return {
                        status: 1,
                        signal: null,
                        stdout: JSON.stringify({ schema: 0 }),
                        stderr: 'retained schema error',
                    };
                const first = JSON.parse(raw);
                const fixtures =
                    Array.isArray(first) && first.length === 2 ? first.map((p) => p.path) : null;
                if (fixtures) command.fixturePaths = fixtures;
                const dirs = command.fixturePaths;
                const generated = winpsContractCases(
                    dirs,
                    path.join(path.dirname(dirs[0]), 'regular sentinel.bin'),
                    path.join(path.dirname(dirs[0]), 'absent literal'),
                );
                const c = generated.find(
                    (c) =>
                        JSON.stringify(c.plans) === raw &&
                        (c.expected === 'legacy-red') === options.red,
                );
                assert(c);
                const value = modelReply(c, script);
                return {
                    status: c.expected === 'green' ? 0 : 1,
                    signal: null,
                    stdout: JSON.stringify(value),
                    stderr: '',
                };
            },
        });
    };
    const promise = runWinpsSecurityContract(
        {
            sourceRoot: root,
            outputRoot: out,
            expectedSourceSHA256: h,
            environment: { SystemRoot: windowsPath('C:', 'Windows') },
            signal: controller.signal,
        },
        {
            ...(fault === 'process-deadline' || fault === 'joined-deadline'
                ? { now: () => (clockReads++ === 0 ? 0 : contractTime) }
                : {}),
            context,
            command,
            fingerprint: async () => h,
            identity: fakeIdentity,
            resolvePowerShell: () => exe,
            hold: (state, record) => {
                held++;
                const probe = { referenced: false, persistedAfterReference: false, hold: null };
                const owner = createOwnershipHold(
                    state,
                    (...args) => {
                        assert(probe.referenced, 'Hold must be referenced before persistence');
                        probe.persistedAfterReference = true;
                        if (fault === 'process-hold-write-report')
                            throw Error('controlled hold receipt write failure');
                        return record(...args);
                    },
                    {
                        interval: () => ({
                            ref() {
                                probe.referenced = true;
                            },
                        }),
                    },
                );
                probe.hold = owner;
                holdProbes.push(probe);
                // Controlled tests retire the referenced interval port after proving custody;
                // production keeps the real unresolved outcome and refed interval.
                return { ...owner, outcome: Promise.resolve() };
            },
            evidenceFactory: (p) => (journal = new PilotEvidence(p, { io })),
        },
    );
    return {
        dir,
        out,
        promise,
        processStates,
        holdProbes,
        get journal() {
            return journal;
        },
        get calls() {
            return calls;
        },
        get held() {
            return held;
        },
        dispose() {
            try {
                fs.closeSync(journal.entry.fd);
            } catch {}
            fs.rmSync(dir, { recursive: true });
        },
    };
}
test('actual contract orchestrator closes real sentinel/journal FDs, removes only its fixture and never resolves Electron', async () => {
    const f = await controlledContract();
    try {
        const result = await f.promise;
        assert.equal(result.passed, true, String(result.failure) + ' cases=' + result.casesPassed);
        assert.equal(result.casesPassed, 30);
        assert.equal(result.casesRequired, 30);
        assert.equal(f.calls, 30);
        assert.equal(result.nativeLaunches, 0);
        assert.equal(result.ElectronResolution, false);
        assert.equal(result.canonicalMarkerAcquisition, false);
        assert(result.cleanup.removed && result.evidenceClosure.complete);
        assert.deepEqual(fs.readdirSync(f.dir), ['evidence']);
        assert.equal(f.held, 0);
        const rows = fs
            .readFileSync(path.join(f.out, 'pilot.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((s) => JSON.parse(s));
        assert(rows.some((r) => r.stage === 'security-input' && r.data.case === 'two-directories'));
        assert(rows.some((r) => r.stage === 'security-output'));
        assert.equal(rows.at(-1).stage, 'contract-result');
        assert(
            fs.statSync(path.join(f.out, 'pilot.jsonl')).size <= winpsContractLimits.evidenceBytes,
        );
    } finally {
        f.dispose();
    }
});
for (const fault of ['parse', 'schema'])
    test(
        'actual contract ' +
            fault +
            ' failure retains raw evidence and known fixture cleanup without launching later cases',
        async () => {
            const f = await controlledContract({ fault });
            try {
                const result = await f.promise;
                assert.equal(result.passed, false);
                assert.equal(result.casesPassed, 0);
                assert.equal(f.calls, 1);
                assert(result.cleanup.removed && result.evidenceClosure.complete);
                assert.equal(result.nativeLaunches, 0);
                const rows = fs
                    .readFileSync(path.join(f.out, 'pilot.jsonl'), 'utf8')
                    .trim()
                    .split('\n')
                    .map((s) => JSON.parse(s));
                assert(rows.some((r) => r.stage === 'security-input'));
                assert(rows.some((r) => r.stage === 'security-output'));
                assert(rows.some((r) => r.stage === 'security-command-closed'));
                assert(rows.some((r) => r.stage === 'contract-failed'));
            } finally {
                f.dispose();
            }
        },
    );
test('actual contract process uncertainty holds its real fixture and open evidence descriptor', async () => {
    const f = await controlledContract({ fault: 'process' });
    try {
        await assert.rejects(f.promise, /Unknown contract custody/);
        assert.equal(f.calls, 1);
        assert.equal(f.held, 1);
        assert(fs.readdirSync(f.dir).some((n) => n.startsWith('diagnostic-hub-winps-contract-')));
        assert(fs.fstatSync(f.journal.entry.fd).isFile());
        assert.equal(f.journal.entry.attempted, false);
    } finally {
        f.dispose();
    }
});
for (const fault of ['sync', 'close'])
    test(
        'actual contract evidence ' + fault + ' failure holds before it can report complete',
        async () => {
            const custom = {
                ...fs,
                fsyncSync(fd) {
                    if (fault === 'sync') throw Error('controlled fsync failure');
                    fs.fsyncSync(fd);
                },
                closeSync(fd) {
                    if (fault === 'close') throw Error('controlled close failure');
                    fs.closeSync(fd);
                },
            };
            const f = await controlledContract({ io: custom });
            try {
                await assert.rejects(f.promise);
                assert(f.held > 0);
                if (fault === 'close') assert(fs.fstatSync(f.journal.entry.fd).isFile());
            } finally {
                f.dispose();
            }
        },
    );

test('all 32 workflow selector cases choose exactly one intended job and preserve ordinary build behavior', async () => {
    const { load } = await import('js-yaml'),
        flow = load(
            fs.readFileSync(path.join(root, '.github/workflows/windows-portable.yml'), 'utf8'),
        );
    const evaluate = (expression, event, inputs) =>
        Function(
            'github',
            'inputs',
            'return (' + expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '') + ');',
        )({ event_name: event }, inputs);
    let count = 0;
    for (const event of ['workflow_dispatch', 'push', 'pull_request', 'workflow_call'])
        for (const metadata of [false, true])
            for (const native of [false, true])
                for (const contract of [false, true]) {
                    const inputs = {
                        windows_preflight_only: metadata,
                        windows_native_pilot: native,
                        windows_pilot_winps_contract: contract,
                    };
                    const selected = Object.entries(flow.jobs)
                        .filter(([, job]) => evaluate(job.if, event, inputs))
                        .map(([key]) => key);
                    const expected =
                        event !== 'workflow_dispatch'
                            ? 'build'
                            : contract
                              ? 'winps-provider-contract'
                              : native
                                ? 'windows-native-pilot'
                                : metadata
                                  ? 'windows-preflight-only'
                                  : 'build';
                    assert.deepEqual(selected, [expected]);
                    assert.equal(
                        evaluate(flow.concurrency['cancel-in-progress'], event, inputs),
                        !(event === 'workflow_dispatch' && (metadata || native || contract)),
                    );
                    count++;
                }
    assert.equal(count, 32);
});

// Reuse hosted-pilot-review-4's exact cancellation/deadline injections. No PowerShell is run.
for (const fault of ['process-cancel', 'process-deadline'])
    test(
        'reviewer replay: uncertain ' + fault + ' preserves fixture, referenced owner and evidence',
        async (t) => {
            const f = await controlledContract({ fault });
            try {
                await assert.rejects(f.promise, /Unknown contract custody/);
                const observed = {
                    replay: fault,
                    calls: f.calls,
                    holds: f.held,
                    fixturePresent: fs
                        .readdirSync(f.dir)
                        .some((n) => n.startsWith('diagnostic-hub-winps-contract-')),
                    evidenceOpen: !f.journal.entry.closed,
                    closeAttempted: f.journal.entry.attempted,
                    processState: f.processStates[0],
                    referenced: f.holdProbes.every(
                        (p) => p.referenced && p.persistedAfterReference,
                    ),
                };
                t.diagnostic(JSON.stringify(observed));
                assert.equal(f.calls, 1);
                assert.equal(f.held, 1);
                assert.equal(observed.fixturePresent, true);
                assert.equal(observed.evidenceOpen, true);
                assert.equal(observed.closeAttempted, false);
                assert.equal(observed.processState.closed, false);
                assert.equal(observed.referenced, true);
                assert(fs.fstatSync(f.journal.entry.fd).isFile());
            } finally {
                f.dispose();
            }
        },
    );
for (const fault of ['process-report', 'process-hold-write-report'])
    test(
        'uncertain ' + fault + ' latches custody before evidence persistence can throw',
        async () => {
            const f = await controlledContract({ fault });
            try {
                await assert.rejects(f.promise, /Unknown contract custody/);
                assert.equal(f.calls, 1);
                assert.equal(f.held, 1);
                assert(
                    fs
                        .readdirSync(f.dir)
                        .some((n) => n.startsWith('diagnostic-hub-winps-contract-')),
                );
                assert.equal(f.journal.entry.attempted, false);
                assert(fs.fstatSync(f.journal.entry.fd).isFile());
                assert.equal(f.processStates[0].closed, false);
                assert(f.holdProbes[0].referenced);
                if (fault === 'process-hold-write-report')
                    assert(f.holdProbes[0].hold.snapshot().recordErrors.length > 0);
            } finally {
                f.dispose();
            }
        },
    );
for (const fault of ['joined-cancel', 'joined-deadline'])
    test('known ' + fault + ' still cleans its bound fixture and returns failed', async () => {
        const f = await controlledContract({ fault });
        try {
            const r = await f.promise;
            assert.equal(r.passed, false);
            assert.equal(f.calls, 1);
            assert.equal(f.held, 0);
            assert.equal(f.processStates[0].closed, true);
            assert.equal(r.cleanup.removed, true);
            assert.equal(r.evidenceClosure.complete, true);
            assert.deepEqual(fs.readdirSync(f.dir), ['evidence']);
            assert.throws(() => fs.fstatSync(f.journal.entry.fd), { code: 'EBADF' });
        } finally {
            f.dispose();
        }
    });
for (const fault of ['throw', 'signal', 'missing-status', 'post-identity'])
    test('shared process latch handles ' + fault + ' before later effects', () => {
        const order = [];
        let spawned = false,
            state;
        const run = () =>
            runSecurityCommand(root, exe, '[]', {
                identity: (file) => {
                    if (fault === 'post-identity' && spawned)
                        throw Error('post-call identity failure');
                    return fakeIdentity(file);
                },
                spawn: () => {
                    spawned = true;
                    order.push('process');
                    if (fault === 'throw') throw Error('spawn threw');
                    if (fault === 'signal')
                        return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
                    return {
                        status: null,
                        error: Error('uncertain query'),
                        stdout: '',
                        stderr: '',
                    };
                },
                onProcessState: (observed) => {
                    state = observed;
                    order.push('latch');
                },
                record: (stage) => {
                    order.push(stage);
                },
            });
        if (fault === 'post-identity') assert.throws(run, /post-call identity/);
        else run();
        assert.equal(state.attempted, true);
        assert.equal(state.closed, false);
        assert.equal(Object.isFrozen(state), true);
        assert.equal(order.indexOf('latch'), order.indexOf('process') + 1);
        assert(order.indexOf('security-command-closed') > order.indexOf('latch'));
    });
test('native-entry shared command wiring holds before closing early evidence on uncertainty', () => {
    const code = fs.readFileSync(path.join(root, 'scripts/windows-native-pilot.mts'), 'utf8');
    assert.match(code, /runSecurityCommand[\s\S]*onProcessState:/);
    assert.match(code, /if \(!state.closed\)/);
    assert.match(code, /if \(!held && \(!owner \|\| !owner.ports.lease.state\(\).created\)\)/);
    const doc = fs.readFileSync(path.join(root, 'docs/windows-pilot-winps-contract.md'), 'utf8');
    assert.match(doc, /windows-portable.yml/);
    assert.match(doc, /windows_pilot_winps_contract=true/);
    assert.doesNotMatch(doc, /windows-pilot-winps-contract.yml/);
});
