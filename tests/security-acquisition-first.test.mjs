import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    acquisitionFirstProgressProfile as v3,
    diagnosticProgressProfile as v2,
    diagnosticProgressLimits,
    acquisitionFirstStdoutPhases,
    decodeDiagnosticProgress,
} from '../scripts/lib/security-diagnostic-progress.mjs';
import {
    firstCollectorSecurityQuery,
    runSecurityCommand,
} from '../scripts/lib/pilot-security-command.mjs';
import { matchedOneDirectoryCommand } from '../scripts/lib/security-query-contract-profile.mjs';
import { createQueryContractEvidence } from '../scripts/lib/query-contract-failure-evidence.mjs';
import { QueryLifecycle } from '../scripts/lib/security-query-diagnostic.mjs';
import {
    winpsContractCases,
    requireWinpsContractReply,
} from '../scripts/lib/pilot-winps-contract.mjs';
import { projectCollectorEnvironment } from '../scripts/lib/product-collector-environment.mjs';
import { metadataReport, progressReply } from './fixtures/security-diagnostic-progress.mjs';

const root = path.resolve(import.meta.dirname, '..'),
    exe = path.join(root, 'injected-winps/powershell.exe');
const raw = JSON.stringify([{ path: root, kind: 'directory' }]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const outNames = ['interpreter-metadata-ready', 'stderr-write-returned', 'stderr-flush-returned'];
const mainNames = [
    'logger-batch-entry',
    'logger-batch-probe',
    'logger-batch-returned',
    'before-plan-parse',
    'after-plan-parse',
    'before-get-item',
    'after-get-item',
    'before-get-acl',
    'after-get-acl',
];
function reply({ eol = '\r\n', report = metadataReport(), prefix = 9, pid = 2468 } = {}) {
    const names = [
        ...mainNames.slice(0, report.complete ? 9 : prefix),
        ...(report.complete ? [] : ['refused']),
        'before-serialize',
        'after-serialize',
    ];
    const order = [outNames[0], ...names.slice(0, 2), ...outNames.slice(1), ...names.slice(2)];
    const records = new Map(
        order.map((phase, n) => [
            phase,
            {
                schema: 1,
                kind: 'security-phase',
                phase,
                pid,
                ticks: String(100 + n),
                frequency: '10000000',
            },
        ]),
    );
    const lines = (list) => list.map((name) => JSON.stringify(records.get(name)) + eol).join('');
    return {
        pid,
        status: report.complete ? 0 : 1,
        signal: null,
        stdout: lines(outNames) + JSON.stringify(report) + eol,
        stderr: lines(names),
        reportText: JSON.stringify(report) + eol,
        records,
    };
}
const decode = (r, profile = v3) => decodeDiagnosticProgress(r.stdout, r.stderr, r.pid, profile);
function harness(returned = reply()) {
    const events = [],
        records = [],
        launches = [],
        states = [];
    const environment = Object.freeze({
        SystemRoot: 'injected-Windows',
        WINDIR: 'injected-Windows',
        TEMP: 'temp',
        TMP: 'temp',
        PATH: 'ORIGINAL_OWNER_PATH',
        PSModulePath: 'strip',
        GITHUB_TOKEN: 'DO_NOT_FORWARD',
        PRIVATE_VALUE: 'DO_NOT_LOG',
        HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC: v3,
    });
    const life = new QueryLifecycle(0, { now: () => 1 });
    let ticks = 0;
    const options = {
        environment,
        red: false,
        timeout: 10000,
        identity: (p) => ({ path: p, sha256: 'a'.repeat(64), pe: { architecture: 'x64' } }),
        record: (stage, data) => {
            events.push(stage);
            records.push({ stage, data });
        },
        check: () => events.push('check'),
        onProcessState(state) {
            events.push('classified');
            states.push(state);
            if (!state.closed) {
                life.held = true;
                life.cancel('injected unknown');
                events.push('hold');
            }
        },
        spawn(...args) {
            events.push('native');
            launches.push(args);
            if (returned instanceof Error) throw returned;
            return returned;
        },
    };
    const factory = (profile = v3) =>
        firstCollectorSecurityQuery({
            outputRoot: root,
            diagnostic: true,
            progressProfile: profile,
            clock: () => ++ticks,
        });
    return {
        events,
        records,
        launches,
        states,
        life,
        environment,
        options,
        factory,
        execute: (query = factory(), changes = {}) =>
            query(root, exe, raw, { ...options, ...changes }),
    };
}
function mutate(r, stream, index, fn) {
    const rows = r[stream].trimEnd().split('\r\n');
    rows[index] = JSON.stringify(fn(JSON.parse(rows[index])));
    return { ...r, [stream]: rows.join('\r\n') + '\r\n' };
}

for (const eol of ['\n', '\r\n'])
    test(`v3 returns exactly the unchanged report and honors old limits ${JSON.stringify(eol)}`, () => {
        const r = reply({ eol });
        assert.equal(decode(r), r.reportText);
        assert.deepEqual(JSON.parse(decode(r)), metadataReport());
        assert.deepEqual(acquisitionFirstStdoutPhases, outNames);
        assert.deepEqual(diagnosticProgressLimits, {
            rows: 16,
            rowBytes: 256,
            bytes: 4096,
            streamBytes: 65536,
        });
        assert.equal(r.stdout.trimEnd().split(eol).length, 4);
    });
for (let prefix = 3; prefix <= 9; prefix++)
    test(`v3 framed refusal keeps original report and failure semantics prefix=${prefix}`, () => {
        const r = reply({
            report: { ...metadataReport(), complete: false, error: { message: 'injected' } },
            prefix,
        });
        assert.equal(decode(r), r.reportText);
        assert.equal(JSON.parse(decode(r)).complete, false);
    });
for (const [name, value, profile] of [
    ['v3-as-v2', () => reply(), v2],
    ['v2-as-v3', () => progressReply(), v3],
    ['unknown version', () => reply(), 'first-collector-query-v4'],
    ['wrong type', () => reply(), null],
])
    test(`strict selected profile refuses ${name}`, () =>
        assert.throws(() => decode(value(), profile), /Diagnostic progress protocol refused/));
for (const [name, change] of [
    ['missing-ready', (r) => ({ ...r, stdout: r.stdout.split('\r\n').slice(1).join('\r\n') })],
    ['duplicate-ready', (r) => mutate(r, 'stdout', 1, () => r.records.get(outNames[0]))],
    [
        'old-acquisition-marker',
        (r) => mutate(r, 'stdout', 0, (p) => ({ ...p, phase: 'after-process-acquisition' })),
    ],
    ['old-entry-tag', (r) => mutate(r, 'stderr', 0, (p) => ({ ...p, phase: 'entry' }))],
    [
        'unknown-phase',
        (r) => mutate(r, 'stdout', 0, (p) => ({ ...p, phase: 'PRIVATE_DO_NOT_ECHO' })),
    ],
    ['wrong-PID', (r) => mutate(r, 'stdout', 0, (p) => ({ ...p, pid: 999 }))],
    ['extra-key', (r) => mutate(r, 'stdout', 0, (p) => ({ ...p, secret: 'DO_NOT_ECHO' }))],
    ['phase-in-wrong-stream', (r) => mutate(r, 'stderr', 0, () => r.records.get(outNames[0]))],
    ['metadata-after-batch', (r) => mutate(r, 'stdout', 0, (p) => ({ ...p, ticks: '999' }))],
    ['logger-return-before-probe', (r) => mutate(r, 'stderr', 2, (p) => ({ ...p, ticks: '100' }))],
    ['frequency-change', (r) => mutate(r, 'stdout', 1, (p) => ({ ...p, frequency: '2' }))],
    ['partial-row', (r) => ({ ...r, stdout: r.stdout.slice(0, -1) })],
    ['trailing-row', (r) => ({ ...r, stdout: r.stdout + '{}\r\n' })],
    ['mixed-EOL', (r) => ({ ...r, stderr: r.stderr.replace('\r\n', '\n') })],
    [
        'duplicate-json-key',
        (r) => ({ ...r, stdout: r.stdout.replace('"schema":1', '"schema":1,"schema":1') }),
    ],
    [
        'escaped-duplicate-key',
        (r) => ({ ...r, stdout: r.stdout.replace('"schema":1', '"schema":1,"sch\\u0065ma":1') }),
    ],
    ['stream-overflow', (r) => ({ ...r, stdout: 'x'.repeat(65537) })],
    ['row-overflow', (r) => mutate(r, 'stdout', 0, (p) => ({ ...p, ticks: '9'.repeat(300) }))],
    [
        'missing-batch-return',
        (r) => ({
            ...r,
            stderr: r.stderr
                .split('\r\n')
                .filter((_, i) => i !== 2)
                .join('\r\n'),
        }),
    ],
])
    test(`v3 ${name} refuses with fixed private error text`, () =>
        assert.throws(
            () => decode(change(reply())),
            (e) => e.message === 'Diagnostic progress protocol refused.',
        ));
for (const field of ['ticks', 'frequency'])
    for (const value of [null, 1, '', '-0', '01', '1e2', '9223372036854775808'])
        test(`v3 ${field} strict integer representation ${typeof value}/${String(value).length}`, () => {
            assert.throws(() =>
                decode(mutate(reply(), 'stdout', 0, (p) => ({ ...p, [field]: value }))),
            );
        });
test('v2 transcripts/old default remain accepted without a v3 fallback', () => {
    const r = progressReply(),
        h = harness(r);
    assert.equal(decodeDiagnosticProgress(r.stdout, r.stderr, r.pid), r.reportText);
    const f = h.factory(v2);
    const a = h.execute(f),
        b = h.execute(f);
    assert.equal(a.stdout, r.reportText);
    assert.equal(b.stdout, r.stdout); // Existing v2 first-only behavior, unchanged.
    assert(!Object.hasOwn(h.records[0].data.diagnostic, 'progressProfile'));
    assert.equal(h.launches[0][2].env.HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC, v2);
    assert.equal(h.launches[1][2].env.HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC, undefined);
});
test('default launch strips inherited v3 and retains plain capture/cwd/arguments', () => {
    const r = { status: 0, signal: null, pid: 2, stdout: 'original plain report', stderr: '' },
        h = harness(r);
    assert.equal(runSecurityCommand(root, exe, raw, h.options).stdout, r.stdout);
    assert.equal(h.launches[0][2].cwd, undefined);
    assert.equal(h.launches[0][2].env.HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC, undefined);
    assert.equal(h.records[0].data.diagnostic, undefined);
});
for (const profile of [null, false, 3, '', 'FIRST-COLLECTOR-QUERY-V3', 'first-collector-query-v4'])
    test(`unknown capability profile is refused ${typeof profile}/${String(profile).length}`, () => {
        assert.throws(() =>
            firstCollectorSecurityQuery({
                outputRoot: root,
                diagnostic: true,
                progressProfile: profile,
            }),
        );
    });
test('v3 requires explicit diagnostic capability, consumes before override validation and refuses second call', () => {
    assert.throws(() => firstCollectorSecurityQuery({ outputRoot: root, progressProfile: v3 }));
    const h = harness(),
        f = h.factory();
    assert.throws(() => h.execute(f, { progressProfile: v2 }));
    assert.throws(() => h.execute(f), /already consumed/);
    assert.equal(h.launches.length, 0);
});
for (const [name, change] of [
    ['foreign capability', { diagnostic: {} }],
    ['red control', { red: true }],
])
    test(`v3 ${name} cannot fallback/retry`, () => {
        const h = harness(),
            f = h.factory();
        assert.throws(() => h.execute(f, change));
        assert.throws(() => h.execute(f), /already consumed/);
        assert.equal(h.launches.length, 0);
    });
test('v3 success retains raw framed hashes before decoding unchanged report', () => {
    const r = reply(),
        h = harness(r),
        f = h.factory();
    const value = h.execute(f),
        result = h.records.at(-1).data;
    assert.equal(value.stdout, r.reportText);
    assert.notEqual(sha(value.stdout), result.streams.stdout.sha256);
    assert.equal(result.streams.stdout.sha256, sha(r.stdout));
    assert.equal(result.streams.stderr.sha256, sha(r.stderr));
    assert.equal(h.records[0].data.diagnostic.progressProfile, v3);
    assert(Buffer.byteLength(JSON.stringify(h.records[0].data.diagnostic)) <= 2048);
    assert(Buffer.byteLength(JSON.stringify(result.diagnostic)) <= 1024);
    assert(!Object.hasOwn(result.diagnostic, 'progressProfile')); // Existing private failure schema.
    assert(h.events.indexOf('classified') < h.events.indexOf('security-output'));
    assert.equal(h.launches[0][2].env.HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC, v3);
    assert.equal(h.launches[0][2].timeout, 10000);
    assert.equal(h.launches[0][2].maxBuffer, 65536);
    assert.equal(h.launches[0][2].cwd, root);
    assert.throws(() => h.execute(f), /already consumed/);
    assert.equal(h.launches.length, 1);
    assert.throws(() =>
        requireWinpsContractReply(
            JSON.parse(value.stdout),
            { expected: 'green', plans: JSON.parse(raw) },
            exe,
            'different-script.ps1',
        ),
    );
});
test('malformed completed v3 response retains raw records and refuses without alternate profile', () => {
    const r = { ...reply(), stdout: 'PRIVATE_DO_NOT_ECHO\r\n' },
        h = harness(r),
        f = h.factory();
    assert.throws(() => h.execute(f), /Diagnostic progress protocol refused/);
    assert.equal(h.records.at(-1).data.streams.stdout.sha256, sha(r.stdout));
    assert.throws(() => h.execute(f), /already consumed/);
    assert.equal(h.launches.length, 1);
});
test('matched control and target bind the same v3 profile/env/PATH/launch, preserving fixture differences', () => {
    const h = harness(),
        node = path.join(root, 'node/node.exe'),
        fixture = path.join(root, "literal [x] $d 'q'");
    const control = matchedOneDirectoryCommand({
        sourceRoot: root,
        nodeExecutable: node,
        powershell: exe,
        environment: h.environment,
        command: runSecurityCommand,
        progressProfile: v3,
    });
    const controlRaw = JSON.stringify([{ path: fixture, kind: 'directory' }]);
    const a = control(root, exe, controlRaw, h.options);
    const childPATH = path.dirname(node) + ';' + path.dirname(exe);
    const b = h.execute(h.factory(), {
        environment: projectCollectorEnvironment(h.environment, childPATH),
    });
    assert.equal(a.stdout, b.stdout);
    const strip = (value) => {
        const r = { ...value, env: { ...value.env } };
        delete r.env.HUB_NATIVE_PILOT_SECURITY_PATHS;
        return r;
    };
    assert.deepEqual(strip(h.launches[0][2]), strip(h.launches[1][2]));
    assert.notEqual(
        h.launches[0][2].env.HUB_NATIVE_PILOT_SECURITY_PATHS,
        h.launches[1][2].env.HUB_NATIVE_PILOT_SECURITY_PATHS,
    );
    assert.equal(h.launches[0][2].env.PATH, childPATH);
    assert(!Object.hasOwn(h.launches[0][2].env, 'GITHUB_TOKEN'));
    assert.equal(h.launches[0][2].env.HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC, v3);
    assert.throws(() => control(root, exe, controlRaw, h.options));
    assert.equal(h.launches.length, 2); // Injected calls only, no OS children.
});

// Pure finite model of the reviewed source order, NOT a PowerShell interpreter.
// A stop after emission models lack of normal continuation without hanging tests.
function prefixModel(stop, budget = {}) {
    const completed = new Set(),
        attempted = [],
        emitted = [],
        values = {},
        count = { rows: budget.rows ?? 0, bytes: budget.bytes ?? 0, stdout: budget.stdout ?? 0 };
    const step = (name) => {
        attempted.push(name);
        if (name === stop) throw Error('injected lack of normal continuation');
        completed.add(name);
    };
    const phase = (name, stream) => {
        const line =
            JSON.stringify({
                schema: 1,
                kind: 'security-phase',
                phase: name,
                pid: 2468,
                ticks: String(100 + emitted.length),
                frequency: '10000000',
            }) + '\r\n';
        const bytes = budget.rowBytes ?? Buffer.byteLength(line);
        assert(count.rows < 16 && bytes <= 256 && count.bytes + bytes <= 4096, 'phase budget');
        if (stream === 'stdout') assert(count.stdout + bytes <= 65536, 'stdout budget');
        count.rows++;
        count.bytes += bytes;
        if (stream === 'stdout') count.stdout += bytes;
        step(name + ':write-enter');
        emitted.push({ name, stream, line });
        step(name + ':write-return');
        if (name === 'logger-batch-probe') phase('stderr-write-returned', 'stdout');
        step(name + ':flush-enter');
        step(name + ':flush-return');
        if (name === 'logger-batch-probe') phase('stderr-flush-returned', 'stdout');
        step(name + ':return');
    };
    let error;
    try {
        step('Get-Process');
        values.process = { original: true };
        step('Path');
        values.path = 'actual-original-path';
        step('metadata');
        values.interpreter = { path: values.path, original: values.process };
        phase('interpreter-metadata-ready', 'stdout');
        phase('logger-batch-entry', 'stderr');
        phase('logger-batch-probe', 'stderr');
        phase('logger-batch-returned', 'stderr');
    } catch (e) {
        error = e;
    }
    return {
        completed,
        attempted,
        emitted,
        values,
        count,
        error,
        stdout: emitted
            .filter((r) => r.stream === 'stdout')
            .map((r) => r.line)
            .join(''),
        stderr: emitted
            .filter((r) => r.stream === 'stderr')
            .map((r) => r.line)
            .join(''),
    };
}
test('finite ordering model acquires original values once before output and keeps original batch writer/flush order', () => {
    const m = prefixModel();
    assert.equal(m.error, undefined);
    assert.deepEqual(m.attempted.slice(0, 3), ['Get-Process', 'Path', 'metadata']);
    for (const name of ['Get-Process', 'Path', 'metadata'])
        assert.equal(m.attempted.filter((n) => n === name).length, 1);
    assert.equal(m.values.interpreter.path, m.values.path);
    assert.equal(m.values.interpreter.original, m.values.process);
    assert.deepEqual(
        m.emitted.map((r) => r.name),
        [
            'interpreter-metadata-ready',
            'logger-batch-entry',
            'logger-batch-probe',
            'stderr-write-returned',
            'stderr-flush-returned',
            'logger-batch-returned',
        ],
    );
    const i = (n) => m.attempted.indexOf(n);
    assert(i('logger-batch-probe:write-return') < i('stderr-write-returned:write-enter'));
    assert(i('stderr-write-returned:return') < i('logger-batch-probe:flush-enter'));
    assert(i('logger-batch-probe:flush-return') < i('stderr-flush-returned:write-enter'));
    assert(i('stderr-flush-returned:return') < i('logger-batch-probe:return'));
    assert(i('logger-batch-probe:return') < i('logger-batch-returned:write-enter'));
});
const stops = [
    'Get-Process',
    'Path',
    'metadata',
    ...[
        'interpreter-metadata-ready',
        'logger-batch-entry',
        'logger-batch-probe',
        'stderr-write-returned',
        'stderr-flush-returned',
        'logger-batch-returned',
    ].flatMap((p) =>
        ['write-enter', 'write-return', 'flush-enter', 'flush-return', 'return'].map(
            (op) => p + ':' + op,
        ),
    ),
];
for (const stop of stops)
    test(`injected acquisition/write/flush/return stop stays unknown: ${stop}`, () => {
        const m = prefixModel(stop);
        assert(m.error);
        assert(!m.completed.has(stop));
        if (m.emitted.some((r) => r.name === 'interpreter-metadata-ready'))
            assert(['Get-Process', 'Path', 'metadata'].every((n) => m.completed.has(n)));
        if (m.emitted.some((r) => r.name === 'logger-batch-returned')) {
            assert(m.completed.has('logger-batch-probe:return'));
            assert(m.completed.has('stderr-flush-returned:return'));
        }
        const r = {
            pid: 2468,
            status: null,
            signal: 'SIGTERM',
            error: Object.assign(Error('injected timeout'), { code: 'ETIMEDOUT' }),
            stdout: m.stdout,
            stderr: m.stderr,
        };
        const h = harness(r),
            f = h.factory();
        const value = h.execute(f);
        assert.equal(h.states[0].closed, false);
        assert(h.life.held && h.life.cancelled);
        assert(
            h.events.indexOf('hold') <
                h.events.indexOf(
                    m.stdout || m.stderr ? 'security-output' : 'security-command-closed',
                ),
        );
        assert.equal(value.stdout, m.stdout); // Unknown capture is never complete-framing admission.
        assert.equal(value.result.streams.stdout.sha256, sha(m.stdout));
        assert.equal(value.result.streams.stderr.sha256, sha(m.stderr));
        assert.throws(() => h.life.admit('node'));
        assert.throws(() => h.execute(f), /already consumed/);
        assert.equal(h.launches.length, 1);
    });
for (const name of ['interpreter-metadata-ready', 'stderr-flush-returned', 'logger-batch-returned'])
    test(`fully emitted ${name} cannot certify its own WriteLine return`, () => {
        const m = prefixModel(name + ':write-return');
        assert(m.emitted.some((r) => r.name === name));
        assert(!m.completed.has(name + ':write-return'));
        assert(!m.completed.has(name + ':flush-enter'));
    });
for (const [name, budget] of [
    ['row-count', { rows: 16 }],
    ['row-bytes', { rowBytes: 257 }],
    ['aggregate-bytes', { bytes: 4096 }],
    ['stdout-bytes', { stdout: 65536 }],
])
    test(`unchanged modeled pre-write ${name} refuses before emission`, () => {
        const m = prefixModel(undefined, budget);
        assert(m.error);
        assert.equal(m.emitted.length, 0);
    });
test('bounded integer representations keep every valid v3 phase below unchanged row/aggregate bounds', () => {
    const names = [...outNames, ...mainNames, 'refused', 'before-serialize', 'after-serialize'];
    assert.equal(names.length, 15);
    const bytes = names.map((phase) =>
        Buffer.byteLength(
            JSON.stringify({
                schema: 1,
                kind: 'security-phase',
                phase,
                pid: Number.MAX_SAFE_INTEGER,
                ticks: '-9223372036854775808',
                frequency: '9223372036854775807',
            }) + '\r\n',
        ),
    );
    assert(bytes.every((n) => n <= 256));
    assert(bytes.reduce((a, b) => a + b, 0) <= 4096);
});
test('v3 maximum uncertain streams and near16KiB input fit the original whole-query serialization reservation', () => {
    const captured = {
        pid: 2468,
        status: null,
        signal: 'SIGTERM',
        error: Object.assign(Error('😀'.repeat(1024)), { code: 'ETIMEDOUT' }),
        stdout: 'x'.repeat(65536),
        stderr: 'y'.repeat(65536),
    };
    const h = harness(captured),
        outputRoot = root + '/' + 'x'.repeat(15000);
    const input = JSON.stringify([{ path: outputRoot, kind: 'directory' }]);
    const f = firstCollectorSecurityQuery({
        outputRoot,
        diagnostic: true,
        progressProfile: v3,
        clock: () => 1,
    });
    const r = f(root, exe, input, h.options);
    assert.equal(h.records.length, 8);
    const rows = h.records.map(
        (record, sequence) =>
            JSON.stringify({ schema: 1, sequence, stage: record.stage, data: record.data }) + '\n',
    );
    assert(rows.every((s) => Buffer.byteLength(s) <= 65536));
    assert(rows.reduce((n, s) => n + Buffer.byteLength(s), 0) <= 245760);
    assert.equal(r.result.streams.stdout.sha256, sha(captured.stdout));
    assert.equal(r.result.streams.stderr.sha256, sha(captured.stderr));
    assert(h.life.held && h.life.cancelled);
});
for (const [name, budget, stop, expected] of [
    ['last row', { rows: 15 }, 'interpreter-metadata-ready:return', 16],
    ['exact row bytes', { rowBytes: 256 }, 'interpreter-metadata-ready:return', 1],
    [
        'exact aggregate bytes',
        { bytes: 3840, rowBytes: 256 },
        'interpreter-metadata-ready:return',
        1,
    ],
    [
        'exact stdout bytes',
        { stdout: 65280, rowBytes: 256 },
        'interpreter-metadata-ready:return',
        1,
    ],
])
    test(`modeled pre-write boundary admits ${name} without enlarging limits`, () => {
        const m = prefixModel(stop, budget);
        assert(m.error && m.emitted.length === 1); // Injected continuation stop AFTER the admitted write/flush.
        assert.equal(m.count.rows, expected);
        assert(m.count.bytes <= 4096 && m.count.stdout <= 65536);
    });
test('v3 raw writer refusal cannot swallow custody or trigger another invocation', () => {
    const h = harness({
            ...reply(),
            status: null,
            signal: 'SIGTERM',
            error: Error('injected unknown'),
        }),
        f = h.factory();
    h.options.record = (stage) => {
        if (stage === 'security-output') {
            assert(h.life.held);
            throw Error('original raw writer refusal');
        }
    };
    assert.throws(() => h.execute(f), /original raw writer refusal/);
    assert(h.life.held && h.life.cancelled);
    assert.throws(() => h.execute(f), /already consumed/);
    assert.equal(h.launches.length, 1);
});
for (const wrong of ['foreign source', 'foreign executable', 'red', 'invalid profile'])
    test(`v3 matched control refuses ${wrong} before native calls`, () => {
        const h = harness();
        const args = {
            sourceRoot: root,
            nodeExecutable: path.join(root, 'node/node.exe'),
            powershell: exe,
            environment: h.environment,
            command: runSecurityCommand,
            progressProfile: wrong === 'invalid profile' ? 'unreviewed' : v3,
        };
        if (wrong === 'invalid profile') {
            assert.throws(() => matchedOneDirectoryCommand(args));
            return;
        }
        const control = matchedOneDirectoryCommand(args);
        assert.throws(() =>
            control(
                wrong === 'foreign source' ? root + '-other' : root,
                wrong === 'foreign executable' ? exe + '-other' : exe,
                raw,
                { ...h.options, red: wrong === 'red' },
            ),
        );
        assert.throws(() => control(root, exe, raw, h.options));
        assert.equal(h.launches.length, 0);
    });

test('v3 unknown result still traverses actual private failure ledger after custody; no admission/release', () => {
    const file = { bytes: Buffer.alloc(0) },
        events = [],
        life = new QueryLifecycle(0, { now: () => 1 });
    const info = () => ({
        dev: 1n,
        ino: 1n,
        uid: BigInt(process.getuid?.() ?? 0),
        nlink: 1n,
        size: BigInt(file.bytes.length),
        isFile: () => true,
        isSymbolicLink: () => false,
    });
    const io = {
        openSync: () => 1,
        fstatSync: info,
        lstatSync: info,
        writeSync(_fd, b, off, n) {
            events.push('write');
            file.bytes = Buffer.concat([file.bytes, b.subarray(off, off + n)]);
            return n;
        },
        fsyncSync() {
            events.push('sync');
        },
        closeSync() {
            events.push('close');
        },
    };
    const hold = () => {
        events.push('hold');
        life.held = true;
        life.cancel('unknown');
    };
    const ledger = createQueryContractEvidence('/injected-contract', {
        io,
        check: () => life.check(),
        failureCheck: () => {
            assert(life.held && life.cancelled);
            assert(life.tick() < life.workDeadline);
        },
        admit: () => {},
        hold,
    });
    const bind = () => {
        life.admit('contract');
        return ledger.bindCommand({
            record: (s, d) => ledger.append(s, { case: 'one-directory', ...d }),
            check: () => assert(life.tick() < 150000),
            onProcessState: (s) => {
                if (!s.closed) hold();
            },
        });
    };
    const partial = prefixModel('stderr-flush-returned:write-return');
    const h = harness({
        pid: 2468,
        status: null,
        signal: 'SIGTERM',
        error: Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }),
        stdout: partial.stdout,
        stderr: partial.stderr,
    });
    const invoke = bind(),
        f = h.factory();
    assert.throws(
        () => invoke((callbacks) => h.execute(f, callbacks)),
        /Unknown contract custody remains held/,
    );
    const records = file.bytes.toString().trim().split('\n').map(JSON.parse);
    assert.equal(records.at(-1).stage, 'security-command-closed');
    assert.equal(records.at(-1).data.diagnostic.actualExitOrPipeCloseObserved, false);
    assert.equal(records.at(-1).data.streams.stdout.sha256, sha(partial.stdout));
    const holdIndex = events.indexOf('hold');
    assert(
        events.slice(holdIndex + 1).includes('write') &&
            events.slice(holdIndex + 1).includes('sync'),
    );
    assert.throws(bind);
    assert.throws(() => ledger.append('ordinary', {}));
    assert.throws(() => ledger.close());
});
test('original thirty contract inputs/assertions, helper metadata context and source routing are preserved', () => {
    assert.equal(
        sha(winpsContractCases.toString()),
        '0bb875d9da853c20bddbe3f9f921efc35d368dc132864b34750604825d6c0e6f',
    );
    assert.equal(
        sha(requireWinpsContractReply.toString()),
        '20286c9102bfce5a6ac5904f71cf0b7b61f3bd7615c4e7e18edd0d0f071f5a1f',
    );
    const helper = fs.readFileSync(
        path.join(root, 'scripts/lib/hosted-pilot-security.ps1'),
        'utf8',
    );
    const statements = [
        '$interpreterProcess = Get-Process -Id $PID',
        '$interpreterPath = $interpreterProcess.Path',
        '$interpreter = [ordered]@{ path = $interpreterPath; version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; x64 = [Environment]::Is64BitProcess; script = $PSCommandPath }',
    ];
    for (const text of statements) assert.equal(helper.split(text).length - 1, 1);
    assert(helper.indexOf(statements[0]) < helper.indexOf(statements[1]));
    assert(helper.indexOf(statements[1]) < helper.indexOf(statements[2]));
    assert(
        helper.indexOf(statements[2]) <
            helper.indexOf("Write-HubSecurityPhase -Phase 'interpreter-metadata-ready'"),
    );
    assert(
        helper.includes(
            "@('entry', 'before-interpreter', 'after-process-acquisition', 'after-process-path'))) { return }",
        ),
    );
    const inputs = JSON.parse(fs.readFileSync(path.join(root, '../source-inputs.json'), 'utf8'));
    const original = fs.readFileSync(
        path.join(inputs.sourceRoot, 'scripts/lib/hosted-pilot-security.ps1'),
        'utf8',
    );
    assert.equal(
        helper.slice(helper.indexOf('$report = $null')),
        original.slice(original.indexOf('$report = $null')),
    );
    const runtime = fs.readFileSync(
        path.join(root, 'scripts/lib/security-query-diagnostic-runtime.mjs'),
        'utf8',
    );
    assert.equal(runtime.match(/progressProfile: acquisitionFirstProgressProfile/g).length, 2);
    assert(runtime.includes('firstParentEvidence.run(invoke, spawnSync)'));
    assert(runtime.includes("life.admit('contract')"));
    assert(
        runtime.indexOf('life.contract(contract)') <
            runtime.indexOf("record('fresh-contract-closed'"),
    );
});
