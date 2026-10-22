import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
    firstPlainParentLaunchEvidence,
    plainParentEvidenceLimits,
} from '../scripts/lib/plain-parent-launch-evidence.mjs';
import {
    runSecurityCommand,
    firstCollectorSecurityQuery,
} from '../scripts/lib/pilot-security-command.mjs';
import { QueryLifecycle } from '../scripts/lib/security-query-diagnostic.mjs';
import { preparationEvidenceLimits } from '../scripts/lib/observation-preparation-evidence.mjs';

const root = path.resolve(import.meta.dirname, '..');
const powershell = '/injected-Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const plans = [
    root,
    path.join(root, 'injected-root'),
    path.join(root, 'injected-root/collection'),
].map((p) => ({ path: p, kind: 'directory' }));
const raw = JSON.stringify(plans);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ok = () => ({
    pid: 42,
    status: 0,
    signal: null,
    stdout: 'original plain report',
    stderr: '',
});
const bad = () => ({
    pid: 43,
    status: null,
    signal: 'SIGTERM',
    error: Object.assign(Error('injected'), {
        code: 'ETIMEDOUT',
        errno: -4039,
        syscall: 'spawnSync PRIVATE_PATH',
    }),
    stdout: 'partial stdout',
    stderr: 'partial stderr',
});
function setup({
    clock,
    format,
    reply = ok(),
    guard = () => {},
    recordHook = () => {},
    holdHook = () => {},
    inputPlans = plans,
} = {}) {
    const events = [],
        records = [],
        launches = [],
        states = [];
    const environment = Object.freeze({
        SystemRoot: 'injected-Windows',
        PATH: 'EXACT_PARENT_PATH',
        TEMP: 'temp',
        TMP: 'temp',
        PSModulePath: 'strip-me',
        HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC: 'inherited-must-be-stripped',
        PRIVATE_VALUE: 'NEVER_LOG_THIS_VALUE',
    });
    let t = 100,
        ticks = 0;
    const diagnosticClock =
        clock ??
        (() => {
            events.push('clock');
            ticks++;
            return t;
        });
    const binding = firstPlainParentLaunchEvidence({
        sourceRoot: root,
        powershell,
        plans: inputPlans,
        environment,
        clock: diagnosticClock,
        ...(format ? { format } : {}),
    });
    const life = new QueryLifecycle(0, { now: () => 1 });
    const options = {
        environment,
        identity: (p) => ({
            path: p,
            realpath: p,
            dev: '1',
            ino: '2',
            nlink: '1',
            size: '10',
            sha256: 'a'.repeat(64),
            pe: { architecture: 'x64' },
        }),
        check: () => {
            events.push('check');
        },
        record(stage, data) {
            recordHook(stage, data);
            events.push(stage);
            records.push({ stage, data });
        },
        onProcessState(s) {
            events.push('classified');
            states.push(s);
            if (!s.closed) {
                life.held = true;
                life.cancel('injected unknown');
                events.push('hold');
                holdHook();
            }
        },
    };
    const native = (...args) => {
        events.push('native');
        launches.push(args);
        t = 110;
        if (reply instanceof Error) throw reply;
        return reply;
    };
    const execute = (changes = {}, producer = runSecurityCommand) =>
        binding.run(
            (token, nativeAtBoundary) =>
                producer(root, powershell, JSON.stringify(inputPlans), {
                    ...options,
                    ...changes,
                    parentLaunchEvidence: token,
                    spawn: (...args) => {
                        events.push('original-final-guard');
                        guard();
                        return nativeAtBoundary(...args);
                    },
                }),
            native,
        );
    return {
        binding,
        execute,
        options,
        native,
        environment,
        events,
        records,
        launches,
        states,
        life,
        clockCount: () => ticks,
        time: (n) => {
            t = n;
        },
    };
}
const inputRow = (h) => h.records.find((r) => r.stage === 'security-input').data;
const finalRow = (h) => h.records.find((r) => r.stage === 'security-command-closed').data;

test('first plain parent preserves all three input bytes and exact original launch options', () => {
    const h = setup();
    const r = h.execute();
    const [exe, args, options] = h.launches[0];
    assert.equal(exe, powershell);
    assert.deepEqual(args, [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(root, 'scripts/lib/hosted-pilot-security.ps1'),
    ]);
    assert.equal(options.env.HUB_NATIVE_PILOT_SECURITY_PATHS, raw);
    assert.equal(options.env.PATH, 'EXACT_PARENT_PATH');
    assert.equal(options.env.PRIVATE_VALUE, h.environment.PRIVATE_VALUE);
    assert(!Object.hasOwn(options.env, 'PSModulePath'));
    assert(!Object.hasOwn(options.env, 'HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC'));
    assert(!Object.hasOwn(options, 'cwd'));
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxBuffer, 65536);
    assert.equal(r.stdout, 'original plain report');
    assert.equal(inputRow(h).json, raw);
    assert.equal(inputRow(h).bytes, Buffer.byteLength(raw));
    assert(!Object.hasOwn(inputRow(h), 'diagnostic'));
    assert(!Object.hasOwn(r.result, 'diagnostic'));
    const evidence = finalRow(h).parentLaunch;
    assert.equal(evidence.spawnCallBoundaryReached, true);
    assert.equal(evidence.launchBoundaryAtMs, 100);
    assert.equal(evidence.postCustodyObservedAtMs, 110);
    assert.equal(evidence.observedElapsedMs, 10);
    assert.equal(evidence.returnedPID, 42);
    assert.equal(evidence.actualExitOrPipeCloseObserved, false);
    assert(h.events.indexOf('original-final-guard') < h.events.indexOf('clock'));
    assert(h.events.indexOf('security-input') < h.events.indexOf('native'));
});
test('custody callback precedes post-return observation and both raw stream records', () => {
    const h = setup({ reply: bad(), holdHook: () => h.time(125) });
    assert.equal(h.execute().result.signal, 'SIGTERM');
    const hold = h.events.indexOf('hold');
    assert(hold < h.events.lastIndexOf('clock'));
    assert(hold < h.events.indexOf('security-output'));
    assert.deepEqual(h.states[0], {
        attempted: true,
        closed: false,
        status: null,
        signal: 'SIGTERM',
        errorPresent: true,
    });
    assert(h.life.held && h.life.cancelled);
    assert.throws(() => h.life.admit('parent'));
    assert.throws(() => h.life.admit('node'));
    assert.throws(() =>
        h.life.proof({
            logsClosed: true,
            receiptClosed: true,
            inputsUnchanged: true,
            evidenceClosed: true,
        }),
    );
    assert.equal(finalRow(h).parentLaunch.observedElapsedMs, 25); // Includes custody callback overhead.
    assert.equal(finalRow(h).parentLaunch.errorCode, 'ETIMEDOUT');
    assert.equal(finalRow(h).parentLaunch.errno, -4039);
    assert.equal(finalRow(h).parentLaunch.syscall, 'spawnSync');
    assert.equal(finalRow(h).streams.stdout.sha256, sha('partial stdout'));
    assert.equal(finalRow(h).streams.stderr.sha256, sha('partial stderr'));
});
test('a refusal in the original final guard records no native boundary or PID', () => {
    const h = setup({
        guard: () => {
            throw Error('original guard');
        },
    });
    h.execute();
    assert.equal(h.launches.length, 0);
    assert(h.life.held);
    const e = finalRow(h).parentLaunch;
    assert.equal(e.spawnCallBoundaryReached, false);
    assert.equal(e.launchBoundaryAtMs, null);
    assert.equal(e.returnedPID, null);
    assert.equal(e.observedElapsedMs, null);
    assert.equal(e.errorCode, 'OTHER');
});
test('a native callback throw retains original classification and bounded structured error', () => {
    const h = setup({
        reply: Object.assign(Error('launch'), {
            code: 'ENOENT',
            errno: -2,
            syscall: 'spawnSync /private/exe',
        }),
    });
    h.execute();
    assert.equal(h.launches.length, 1);
    assert.equal(h.states[0].closed, false);
    assert.equal(h.states[0].signal, null);
    const e = finalRow(h).parentLaunch;
    assert.equal(e.spawnCallBoundaryReached, true);
    assert.equal(e.returnedPID, null);
    assert.equal(e.errorCode, 'ENOENT');
    assert.equal(e.errno, -2);
    assert.equal(e.syscall, 'spawnSync');
});
for (const pid of [
    undefined,
    null,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    'SECRET_PID',
    {},
    1n,
])
    test(`unavailable PID ${typeof pid}/${String(pid)} is null without blocking capture`, () => {
        const reply = { ...bad(), pid };
        const h = setup({ reply });
        h.execute();
        assert.equal(finalRow(h).parentLaunch.returnedPID, null);
        assert.equal(finalRow(h).streams.stdout.sha256, sha(reply.stdout));
    });
for (const code of [
    'ETIMEDOUT',
    'ENOENT',
    'EACCES',
    'EPERM',
    'ENOBUFS',
    'ECANCELED',
    'PRIVATE_UNKNOWN_CODE',
])
    test(`structured error code ${code === 'PRIVATE_UNKNOWN_CODE' ? 'unknown' : code}`, () => {
        const reply = bad();
        reply.error.code = code;
        const h = setup({ reply });
        h.execute();
        assert.equal(
            finalRow(h).parentLaunch.errorCode,
            code === 'PRIVATE_UNKNOWN_CODE' ? 'OTHER' : code,
        );
        assert(!JSON.stringify(finalRow(h).parentLaunch).includes('PRIVATE_'));
    });
test('hostile error property getters and arbitrary names/values never leak into telemetry', () => {
    const reply = bad();
    Object.defineProperties(reply.error, {
        code: {
            get() {
                throw Error('PRIVATE_CODE');
            },
        },
        errno: {
            get() {
                throw Error('PRIVATE_ERRNO');
            },
        },
        syscall: {
            get() {
                throw Error('PRIVATE_SYSCALL');
            },
        },
    });
    Object.defineProperty(reply, 'pid', {
        get() {
            throw Error('PRIVATE_PID');
        },
    });
    const h = setup({ reply });
    h.execute();
    const e = finalRow(h).parentLaunch;
    assert.equal(e.errorCode, 'OTHER');
    assert.equal(e.errno, null);
    assert.equal(e.syscall, null);
    assert.equal(e.returnedPID, null);
    assert(!JSON.stringify(e).includes('PRIVATE'));
    assert.equal(finalRow(h).streams.stdout.sha256, sha(reply.stdout));
});
for (const errno of [undefined, null, 1.5, Infinity, 2147483648, -2147483649, 'PRIVATE_ERRNO', {}])
    test(`unsupported errno ${typeof errno}/${String(errno)} remains null`, () => {
        const reply = bad();
        reply.error.errno = errno;
        const h = setup({ reply });
        h.execute();
        assert.equal(finalRow(h).parentLaunch.errno, null);
    });
for (const syscall of [undefined, null, {}, 'PRIVATE_SYSCALL'])
    test(`bounded syscall ${typeof syscall}/${String(syscall)}`, () => {
        const reply = bad();
        reply.error.syscall = syscall;
        const h = setup({ reply });
        h.execute();
        assert.equal(
            finalRow(h).parentLaunch.syscall,
            typeof syscall === 'string' ? 'OTHER' : null,
        );
        assert(!JSON.stringify(finalRow(h).parentLaunch).includes('PRIVATE_SYSCALL'));
    });
for (const [name, clock] of [
    [
        'throw',
        () => {
            throw Error('PRIVATE_CLOCK');
        },
    ],
    ['negative', () => -1],
    ['NaN', () => NaN],
    ['unsafe', () => Number.MAX_SAFE_INTEGER + 1],
    ['wrong type', () => ({ value: 'PRIVATE' })],
    [
        'regression',
        (() => {
            let n = 0;
            return () => (++n === 1 ? 10 : 9);
        })(),
    ],
])
    test(`optional clock ${name} preserves original classification and raw capture`, () => {
        const h = setup({ clock, reply: bad() });
        h.execute();
        assert.equal(h.states[0].closed, false);
        assert(h.life.held);
        assert.equal(finalRow(h).parentLaunch.clockComplete, false);
        assert.equal(finalRow(h).parentLaunch.observedElapsedMs, null);
        assert.equal(finalRow(h).streams.stdout.sha256, sha('partial stdout'));
        assert.equal(finalRow(h).streams.stderr.sha256, sha('partial stderr'));
    });
test('post-custody clock throw is nonfatal and cannot move ahead of the hold', () => {
    let calls = 0;
    const events = [];
    const h = setup({
        reply: bad(),
        clock: () => {
            events.push('clock');
            if (++calls === 2) throw Error('PRIVATE');
            return 10;
        },
        holdHook: () => events.push('hold'),
    });
    h.execute();
    assert.deepEqual(events, ['clock', 'hold', 'clock']);
    assert.equal(finalRow(h).parentLaunch.clockComplete, false);
    assert.equal(finalRow(h).streams.stdout.sha256, sha('partial stdout'));
});
for (const [name, format] of [
    [
        'throw',
        () => {
            throw Error('PRIVATE_FORMAT');
        },
    ],
    ['oversized', () => 'x'.repeat(1025)],
    ['wrong type', () => null],
    [
        'attempt mutation',
        (v) => {
            v.arbitrary = 'PRIVATE_MUTATION';
            return JSON.stringify(v);
        },
    ],
])
    test(`optional formatting ${name} uses fixed fallback without suppressing capture`, () => {
        const h = setup({ reply: bad(), format });
        h.execute();
        assert.equal(inputRow(h).parentLaunch.available, false);
        assert.equal(finalRow(h).parentLaunch.available, false);
        assert.equal(finalRow(h).streams.stdout.sha256, sha('partial stdout'));
        assert.equal(h.states[0].closed, false);
        assert.equal(h.launches.length, 1);
        assert(!JSON.stringify(finalRow(h).parentLaunch).includes('PRIVATE'));
        assert.equal(finalRow(h).parentLaunch.actualExitOrPipeCloseObserved, false);
    });
for (const [name, change] of [
    ['foreign source', { sourceRoot: root + '-other' }],
    ['foreign executable', { powershell: powershell + '-other' }],
    ['wrong input', { rawJSON: '[]' }],
    ['reformatted input', { rawJSON: JSON.stringify(plans, null, 2) }],
    ['foreign environment', { environment: {} }],
    ['red control', { red: true }],
    ['wrong timeout', { timeout: 9999 }],
    ['v2 combination', { diagnostic: {} }],
])
    test(`binding rejects ${name} before recording or native effects`, () => {
        const h = setup();
        assert.throws(() =>
            h.binding.run(
                (token, native) =>
                    runSecurityCommand(
                        change.sourceRoot ?? root,
                        change.powershell ?? powershell,
                        change.rawJSON ?? raw,
                        { ...h.options, ...change, parentLaunchEvidence: token, spawn: native },
                    ),
                h.native,
            ),
        );
        assert.equal(h.records.length, 0);
        assert.equal(h.launches.length, 0);
        assert.throws(() => h.execute());
    });
test('foreign token and reusing one claimed token refuse before effects', () => {
    const h = setup();
    assert.throws(() =>
        runSecurityCommand(root, powershell, raw, {
            ...h.options,
            parentLaunchEvidence: {},
            spawn: h.native,
        }),
    );
    assert.equal(h.launches.length, 0);
    let tokenSaved;
    h.binding.run((token, native) => {
        tokenSaved = token;
        const reply = runSecurityCommand(root, powershell, raw, {
            ...h.options,
            parentLaunchEvidence: token,
            spawn: native,
        });
        assert.throws(() =>
            runSecurityCommand(root, powershell, raw, {
                ...h.options,
                parentLaunchEvidence: token,
                spawn: native,
            }),
        );
        return reply;
    }, h.native);
    assert.throws(() =>
        runSecurityCommand(root, powershell, raw, {
            ...h.options,
            parentLaunchEvidence: tokenSaved,
            spawn: h.native,
        }),
    );
    assert.equal(h.launches.length, 1);
});
test('expired native callback cannot launch after input/persistence refusal', () => {
    const h = setup();
    let saved;
    assert.throws(() =>
        h.binding.run((token, native) => {
            saved = native;
            return runSecurityCommand(root, powershell, raw, {
                ...h.options,
                parentLaunchEvidence: token,
                record: () => {
                    throw Error('writer');
                },
                spawn: native,
            });
        }, h.native),
    );
    assert.throws(() => saved());
    assert.equal(h.launches.length, 0);
    assert.throws(() => h.execute());
});
test('unknown result writer failure preserves custody and prior raw fragments without retry', () => {
    const h = setup({
        reply: bad(),
        recordHook: (stage) => {
            if (stage === 'security-command-closed') throw Error('result writer');
        },
    });
    assert.throws(() => h.execute());
    assert(h.life.held);
    assert.equal(h.states[0].closed, false);
    assert.equal(h.launches.length, 1);
    assert(h.records.some((r) => r.stage === 'security-output'));
    assert.throws(() => h.execute());
});
test('custody callback failure cannot be caught by optional telemetry or produce false completion', () => {
    const h = setup({
        reply: bad(),
        holdHook: () => {
            throw Error('hold persistence');
        },
    });
    assert.throws(() => h.execute());
    assert(h.life.held);
    assert(!h.records.some((r) => r.stage === 'security-output'));
    assert(!h.records.some((r) => r.stage === 'security-command-closed'));
    assert.throws(() => h.execute());
});
test('maximum streams plus input/error/telemetry fit original eight-row serialization reservation', () => {
    const p = plans.map((v) => ({ ...v, path: v.path + 'x'.repeat(5200) }));
    const reply = bad();
    reply.stdout = 'x'.repeat(65536);
    reply.stderr = 'y'.repeat(65536);
    reply.error = Error('😀'.repeat(1024));
    const h = setup({ reply, inputPlans: p });
    h.execute();
    assert.equal(h.records.length, 8);
    const rows = h.records.map(
        (r, sequence) =>
            JSON.stringify({ schema: 1, sequence, stage: r.stage, data: r.data }) + '\n',
    );
    assert(rows.every((r) => Buffer.byteLength(r) <= preparationEvidenceLimits.rowBytes));
    assert(
        rows.reduce((n, r) => n + Buffer.byteLength(r), 0) <= preparationEvidenceLimits.queryBytes,
    );
    assert(
        Buffer.byteLength(JSON.stringify(inputRow(h).parentLaunch)) <=
            plainParentEvidenceLimits.inputBytes,
    );
    assert(
        Buffer.byteLength(JSON.stringify(finalRow(h).parentLaunch)) <=
            plainParentEvidenceLimits.resultBytes,
    );
    assert.equal(finalRow(h).streams.stdout.sha256, sha(reply.stdout));
    assert.equal(finalRow(h).streams.stderr.sha256, sha(reply.stderr));
});
test('existing budget refusal still stops input before native effects', () => {
    const h = setup({
        recordHook: () => {
            throw Error('original row/accounting budget');
        },
    });
    assert.throws(() => h.execute());
    assert.equal(h.launches.length, 0);
    assert.equal(h.states.length, 0);
    assert.throws(() => h.execute());
});
test('default command records/launch and successful/negative behavior stay unchanged', () => {
    for (const status of [0, 1]) {
        const h = setup({ reply: { ...ok(), status } });
        const r = runSecurityCommand(root, powershell, raw, { ...h.options, spawn: h.native });
        assert.equal(r.result.status, status);
        assert(!Object.hasOwn(r.result, 'parentLaunch'));
        assert(!Object.hasOwn(inputRow(h), 'parentLaunch'));
        assert(!Object.hasOwn(h.launches[0][2], 'cwd'));
        assert.equal(h.clockCount(), 0);
    }
});
test('later plain parent commands have no telemetry even after an observed first success', () => {
    const h = setup();
    h.execute();
    runSecurityCommand(root, powershell, raw, { ...h.options, spawn: h.native });
    assert.equal(h.launches.length, 2);
    assert.equal(h.clockCount(), 2);
    assert(!Object.hasOwn(h.records.at(-1).data, 'parentLaunch'));
});
test('source wiring limits observation to first admitted plain parent and preserves all plans/guards', () => {
    const runtime = fs.readFileSync(
        path.join(root, 'scripts/lib/security-query-diagnostic-runtime.mjs'),
        'utf8',
    );
    assert(
        runtime.includes(
            "const initialParentPlans = [context.parent, root, path.join(root, 'collection')]",
        ),
    );
    assert(runtime.includes("life.admit('parent', { cleanup });"));
    assert(runtime.includes('life.counts.parent === 1 && !cleanup'));
    assert(runtime.includes('firstParentEvidence.run(invoke, spawnSync)'));
    assert(runtime.includes('ownerEnvironment.beforeSpawn('));
    assert(runtime.includes('life.check({ cleanup, headroom: policy.queryMs })'));
    const core = fs.readFileSync(path.join(root, 'scripts/lib/pilot-security-command.mjs'), 'utf8');
    assert(
        core.indexOf('onProcessState(processState);') <
            core.indexOf('parentObservation?.afterCustody();'),
    );
    assert(
        core.indexOf("for (const name of ['stdout', 'stderr'])") <
            core.indexOf('parentObservation.result(r, processState)'),
    );
});

for (const [name, invalid] of [
    ['one plan', plans.slice(0, 1)],
    ['four plans', [...plans, plans[0]]],
    ['file kind', [{ ...plans[0], kind: 'file' }, ...plans.slice(1)]],
    ['relative path', [{ path: 'relative', kind: 'directory' }, ...plans.slice(1)]],
    ['extra plan field', [{ ...plans[0], arbitrary: true }, ...plans.slice(1)]],
])
    test(`first plain parent constructor rejects ${name}`, () => {
        assert.throws(() => setup({ inputPlans: invalid }));
    });
test('a valid one-directory v2 capability cannot be combined with the plain three-plan token', () => {
    const h = setup();
    const v2 = firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true, clock: () => 1 });
    assert.throws(() => h.execute({}, v2), /cannot activate v2/);
    assert.equal(h.records.length, 0);
    assert.equal(h.launches.length, 0);
});
test('the guarded native callback is single-use and expires after successful return', () => {
    const h = setup();
    let saved;
    h.binding.run((token, native) => {
        saved = native;
        const value = runSecurityCommand(root, powershell, raw, {
            ...h.options,
            parentLaunchEvidence: token,
            spawn: native,
        });
        assert.throws(() => native());
        return value;
    }, h.native);
    assert.throws(() => saved());
    assert.equal(h.launches.length, 1);
    assert.throws(() => h.execute());
});
test('largest supported numeric facts remain within the fixed metadata bounds', () => {
    const reply = bad();
    reply.pid = Number.MAX_SAFE_INTEGER;
    reply.error.errno = -2147483648;
    const h = setup({ reply, clock: () => Number.MAX_SAFE_INTEGER });
    h.execute();
    const e = finalRow(h).parentLaunch;
    assert.equal(e.returnedPID, Number.MAX_SAFE_INTEGER);
    assert.equal(e.errno, -2147483648);
    assert.equal(e.observedElapsedMs, 0);
    assert.equal(e.actualExitOrPipeCloseObserved, false);
    assert(Buffer.byteLength(JSON.stringify(e)) <= 1024);
});
test('truncated capture retains the original full digest and bounded prefix semantics', () => {
    const reply = bad();
    reply.stdout = 'x'.repeat(65537);
    reply.stderr = 'y'.repeat(65537);
    const h = setup({ reply });
    h.execute();
    for (const name of ['stdout', 'stderr']) {
        const s = finalRow(h).streams[name];
        assert.equal(s.bytes, 65537);
        assert.equal(s.retainedBytes, 65536);
        assert.equal(s.truncated, true);
        assert.equal(s.sha256, sha(reply[name]));
    }
    assert(h.life.held);
});
test('interleaved hold reporting may exhaust the original query partition without new allowance or retry', () => {
    const reply = bad();
    reply.stdout = 'x'.repeat(65536);
    reply.stderr = 'y'.repeat(65536);
    let h;
    h = setup({
        reply,
        recordHook: () =>
            assert(
                h.records.length < preparationEvidenceLimits.queryRows,
                'injected existing query-row refusal',
            ),
        holdHook: () =>
            h.options.record('ownership-held.json', { phase: 'injected existing hold' }),
    });
    assert.throws(() => h.execute(), /query-row refusal/);
    assert.equal(h.records.length, 8);
    assert(h.life.held);
    assert.equal(h.launches.length, 1);
    assert(!h.records.some((r) => r.stage === 'security-command-closed'));
    assert.throws(() => h.execute());
});
