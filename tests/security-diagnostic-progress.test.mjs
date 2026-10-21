import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    decodeDiagnosticProgress,
    diagnosticProgressLimits,
} from '../scripts/lib/security-diagnostic-progress.mjs';
import {
    firstCollectorSecurityQuery,
    runSecurityCommand,
    requireSecurityProcess,
} from '../scripts/lib/pilot-security-command.mjs';
import { metadataReport, progressReply } from './fixtures/security-diagnostic-progress.mjs';

const root = path.resolve(import.meta.dirname, '..');
const raw = JSON.stringify([{ path: root, kind: 'directory' }]);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const decode = (r) => decodeDiagnosticProgress(r.stdout, r.stderr, r.pid);
function changeLine(text, index, mutate) {
    const lines = text.split('\r\n');
    lines[index] = mutate(lines[index]);
    return lines.join('\r\n');
}
function withPhase(r, stream, index, mutate) {
    return {
        ...r,
        [stream]: changeLine(r[stream], index, (line) => JSON.stringify(mutate(JSON.parse(line)))),
    };
}
function ports(reply) {
    const records = [],
        states = [],
        launches = [],
        order = [];
    return {
        records,
        states,
        launches,
        order,
        options: {
            environment: { SystemRoot: 'fixture-Windows', PATH: 'fixture-PATH' },
            identity: (file) => ({
                path: file,
                sha256: 'a'.repeat(64),
                pe: { architecture: 'x64' },
            }),
            record(stage, data) {
                order.push(stage);
                records.push({ stage, data });
            },
            onProcessState(state) {
                order.push('process-state');
                states.push(state);
            },
            spawn(exe, args, options) {
                launches.push({ exe, args, options });
                return reply;
            },
        },
    };
}

for (const eol of ['\n', '\r\n'])
    test(`ordered progress returns the exact original metadata report (${JSON.stringify(eol)})`, () => {
        const r = progressReply({ eol });
        assert.equal(decode(r), r.reportText);
        assert.deepEqual(JSON.parse(decode(r)), metadataReport());
        assert.deepEqual(diagnosticProgressLimits, {
            rows: 16,
            rowBytes: 256,
            bytes: 4096,
            streamBytes: 65536,
        });
    });
for (let prefix = 3; prefix <= 9; prefix++)
    test(`complete framed refusal prefix ${prefix} is decoded without becoming a success`, () => {
        const report = {
            ...metadataReport(),
            complete: false,
            error: { message: 'fixture refusal' },
        };
        const r = progressReply({ report, prefix });
        assert.equal(decode(r), r.reportText);
        assert.throws(() =>
            requireSecurityProcess({ status: 1, signal: null, error: null, streams: {} }),
        );
    });

const mutations = [
    ['missing progress', (r) => ({ ...r, stdout: r.stdout.split('\r\n').slice(1).join('\r\n') })],
    [
        'duplicate progress',
        (r) => withPhase(r, 'stdout', 1, () => JSON.parse(r.stdout.split('\r\n')[0])),
    ],
    ['unknown progress', (r) => withPhase(r, 'stdout', 0, (p) => ({ ...p, phase: 'unknown' }))],
    ['stderr phase in stdout', (r) => withPhase(r, 'stdout', 0, (p) => ({ ...p, phase: 'entry' }))],
    [
        'stdout phase in stderr',
        (r) => withPhase(r, 'stderr', 0, (p) => ({ ...p, phase: 'after-process-path' })),
    ],
    [
        'duplicate stderr phase',
        (r) => withPhase(r, 'stderr', 1, () => JSON.parse(r.stderr.split('\r\n')[0])),
    ],
    [
        'reordered progress',
        (r) => ({
            ...r,
            stdout: r.stdout
                .split('\r\n')
                .map((line, i, all) => (i === 0 ? all[1] : i === 1 ? all[0] : line))
                .join('\r\n'),
        }),
    ],
    [
        'missing stderr phase',
        (r) => ({ ...r, stderr: r.stderr.split('\r\n').slice(1).join('\r\n') }),
    ],
    [
        'missing metadata',
        (r) => ({ ...r, stdout: r.stdout.split('\r\n').slice(0, 4).join('\r\n') + '\r\n' }),
    ],
    ['two metadata records', (r) => ({ ...r, stdout: r.stdout + r.reportText })],
    ['trailing record', (r) => ({ ...r, stdout: r.stdout + '{}\r\n' })],
    ['trailing blank line', (r) => ({ ...r, stdout: r.stdout + '\r\n' })],
    ['partial terminal newline', (r) => ({ ...r, stdout: r.stdout.slice(0, -1) })],
    ['partial stderr newline', (r) => ({ ...r, stderr: r.stderr.slice(0, -1) })],
    ['mixed line endings', (r) => ({ ...r, stderr: r.stderr.replace('\r\n', '\n') })],
    ['BOM prefix', (r) => ({ ...r, stdout: '\uFEFF' + r.stdout })],
    ['stderr non-JSON error', (r) => ({ ...r, stderr: r.stderr + 'fixture error\r\n' })],
    [
        'phase extra field',
        (r) => withPhase(r, 'stdout', 0, (p) => ({ ...p, secret: 'NEVER_ECHO_THIS' })),
    ],
    [
        'phase missing field',
        (r) =>
            withPhase(r, 'stdout', 0, (p) => {
                delete p.ticks;
                return p;
            }),
    ],
    ['wrong schema', (r) => withPhase(r, 'stdout', 0, (p) => ({ ...p, schema: 2 }))],
    ['wrong kind', (r) => withPhase(r, 'stdout', 0, (p) => ({ ...p, kind: 'other' }))],
    ['wrong PID', (r) => withPhase(r, 'stdout', 0, (p) => ({ ...p, pid: p.pid + 1 }))],
    ['wrong PID type', (r) => withPhase(r, 'stdout', 0, (p) => ({ ...p, pid: String(p.pid) }))],
    ['noncanonical progress whitespace', (r) => ({ ...r, stdout: r.stdout.replace('{', '{ ') })],
    [
        'duplicate phase JSON key',
        (r) => ({ ...r, stdout: r.stdout.replace('"schema":1', '"schema":1,"schema":1') }),
    ],
    [
        'duplicate terminal JSON key',
        (r) => ({
            ...r,
            stdout: changeLine(r.stdout, 4, (line) =>
                line.replace('"schema":1', '"schema":1,"schema":1'),
            ),
        }),
    ],
    [
        'escaped duplicate nested key',
        (r) => ({
            ...r,
            stdout: changeLine(r.stdout, 4, (line) =>
                line.replace('"trace":{}', '"trace":{"same":1,"\\u0073ame":2}'),
            ),
        }),
    ],
    [
        'invalid JSON escape',
        (r) => ({
            ...r,
            stdout: changeLine(r.stdout, 4, (line) =>
                line.replace('"trace":{}', '"trace":{"x":"\\q"}'),
            ),
        }),
    ],
    [
        'extra metadata key',
        (r) => ({
            ...r,
            stdout: changeLine(r.stdout, 4, (line) =>
                line.replace('"trace":{}', '"trace":{},"unexpected":"NEVER_ECHO_THIS"'),
            ),
        }),
    ],
    [
        'metadata root array',
        (r) => ({ ...r, stdout: changeLine(r.stdout, 4, (line) => '[' + line + ']') }),
    ],
    ['metadata null', (r) => ({ ...r, stdout: changeLine(r.stdout, 4, () => 'null') })],
    [
        'metadata leading whitespace',
        (r) => ({ ...r, stdout: changeLine(r.stdout, 4, (line) => ' ' + line) }),
    ],
    [
        'metadata trailing whitespace',
        (r) => ({ ...r, stdout: changeLine(r.stdout, 4, (line) => line + '\t') }),
    ],
    [
        'metadata missing report fields',
        (r) => ({ ...r, stdout: changeLine(r.stdout, 4, () => '{}') }),
    ],
    [
        'complete report plus refused phase',
        (r) => ({
            ...r,
            stderr: r.stderr.replace('"phase":"before-serialize"', '"phase":"refused"'),
        }),
    ],
    [
        'retired stderr tag',
        (r) => withPhase(r, 'stderr', 10, (p) => ({ ...p, phase: 'after-stdout' })),
    ],
];
for (const [name, mutate] of mutations)
    test(`${name} refuses with fixed error text and no input disclosure`, () => {
        assert.throws(
            () => decode(mutate(progressReply())),
            (error) => error.message === 'Diagnostic progress protocol refused.',
        );
    });
for (const ticks of [
    '',
    '-0',
    '00',
    '1.5',
    '1e2',
    '9223372036854775808',
    '-9223372036854775809',
    'x'.repeat(400),
    null,
    102,
])
    test(`invalid tick representation ${typeof ticks}/${String(ticks).length} refuses`, () => {
        assert.throws(() =>
            decode(withPhase(progressReply(), 'stdout', 0, (p) => ({ ...p, ticks }))),
        );
    });
for (const frequency of ['0', '-1', '01', '9223372036854775808', '1e2', null, 10])
    test(`invalid frequency ${typeof frequency}/${String(frequency).length} refuses`, () => {
        assert.throws(() =>
            decode(withPhase(progressReply(), 'stdout', 0, (p) => ({ ...p, frequency }))),
        );
    });
test('frequency disagreement and cross-stream clock regression refuse', () => {
    assert.throws(() =>
        decode(withPhase(progressReply(), 'stderr', 0, (p) => ({ ...p, frequency: '1' }))),
    );
    assert.throws(() =>
        decode(withPhase(progressReply(), 'stdout', 0, (p) => ({ ...p, ticks: '1' }))),
    );
    assert.throws(() =>
        decode(withPhase(progressReply(), 'stderr', 2, (p) => ({ ...p, ticks: '101' }))),
    );
});
test('signed clock extremes and equal causal timestamps fit existing budgets', () => {
    for (const ticks of ['-9223372036854775808', '9223372036854775807', '0']) {
        const r = progressReply();
        for (const stream of ['stdout', 'stderr'])
            r[stream] = r[stream]
                .split('\r\n')
                .map((line) => {
                    if (!line) return line;
                    const p = JSON.parse(line);
                    return p.kind === 'security-phase'
                        ? JSON.stringify({ ...p, ticks, frequency: '9223372036854775807' })
                        : line;
                })
                .join('\r\n');
        assert.equal(decode(r), r.reportText);
    }
});
test('65536-byte total stdout passes; one extra byte and deep JSON refuse', () => {
    const report = metadataReport();
    report.trace.padding = '';
    const base = progressReply({ report });
    report.trace.padding = 'x'.repeat(65536 - Buffer.byteLength(base.stdout));
    const r = progressReply({ report });
    assert.equal(Buffer.byteLength(r.stdout), 65536);
    assert.equal(decode(r), r.reportText);
    report.trace.padding += 'x';
    assert.throws(() => decode(progressReply({ report })));
    assert.throws(() =>
        decode({
            ...base,
            stdout: changeLine(base.stdout, 4, () => '['.repeat(65) + '0' + ']'.repeat(65)),
        }),
    );
});
test('raw outcome and both streams are retained before decoding; returned stdout is only original report', () => {
    const r = progressReply(),
        f = ports(r);
    const query = firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true });
    const result = query(root, 'fixture-winps.exe', raw, f.options);
    assert.equal(result.stdout, r.reportText);
    assert.equal(result.stderr, r.stderr);
    assert.equal(result.result.streams.stdout.sha256, sha(r.stdout));
    assert.equal(result.result.streams.stderr.sha256, sha(r.stderr));
    assert.equal(f.launches[0].options.cwd, root);
    assert.equal(
        f.launches[0].options.env.HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC,
        'first-collector-query-v2',
    );
    assert(f.order.indexOf('process-state') < f.order.indexOf('security-output'));
    assert.equal(f.records.at(-1).stage, 'security-command-closed');
    assert.equal(f.records.at(-1).data.diagnostic.actualExitOrPipeCloseObserved, false);
});
test('malformed completed response cannot return an admitted report, and raw records survive', () => {
    const r = { ...progressReply(), stdout: 'NEVER_ECHO_THIS\r\n' },
        f = ports(r);
    assert.throws(
        () =>
            firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true })(
                root,
                'fixture-winps.exe',
                raw,
                f.options,
            ),
        /Diagnostic progress protocol refused/,
    );
    assert.equal(f.records.at(-1).stage, 'security-command-closed');
    assert.equal(f.records.at(-1).data.streams.stdout.sha256, sha(r.stdout));
    assert.equal(f.states.length, 1);
});
test('timeout preserves partial raw progress and latches uncertainty without requiring complete framing', () => {
    const r = {
            ...progressReply(),
            status: null,
            signal: 'SIGTERM',
            error: Object.assign(Error('fixture timeout'), { code: 'ETIMEDOUT' }),
            stdout: '{partial',
            stderr: 'partial',
        },
        f = ports(r);
    const result = firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true })(
        root,
        'fixture-winps.exe',
        raw,
        f.options,
    );
    assert.equal(f.states[0].closed, false);
    assert.equal(result.stdout, r.stdout);
    assert.equal(result.result.diagnostic.errorCode, 'ETIMEDOUT');
    assert.equal(f.order[1], 'process-state');
    assert.throws(() => requireSecurityProcess(result.result));
});
test('default path does not decode or activate framing, even with inherited diagnostic flags', () => {
    const r = { pid: 2468, status: 0, signal: null, stdout: 'unframed', stderr: '' },
        f = ports(r);
    f.options.environment.HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC = 'first-collector-query-v2';
    assert.equal(runSecurityCommand(root, 'fixture-winps.exe', raw, f.options).stdout, 'unframed');
    assert.equal(f.launches[0].options.cwd, undefined);
    assert.equal(f.launches[0].options.env.HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC, undefined);
});

for (const pid of [0, -1, undefined, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
    test(`invalid expected PID ${String(pid)} refuses`, () => {
        const r = progressReply();
        assert.throws(() => decodeDiagnosticProgress(r.stdout, r.stderr, pid));
    });
test('original terminal JSON escapes, Unicode and nested values are preserved without reserialization', () => {
    const report = metadataReport();
    report.trace.details = [
        "literal [brackets] $dollar 'quote' é",
        true,
        false,
        null,
        -1.25e3,
        { key: '\\path\n' },
    ];
    const r = progressReply({ report });
    r.stdout = r.stdout.replace('literal', '\\u006citeral');
    assert.equal(decode(r), r.reportText.replace('literal', '\\u006citeral'));
    assert.deepEqual(JSON.parse(decode(r)), report);
});
test('two maximum uncertain captured streams fit the unchanged eight-row whole-query reservation', () => {
    const r = {
        pid: 2468,
        status: null,
        signal: 'SIGTERM',
        error: Object.assign(Error('fixture timeout'), { code: 'ETIMEDOUT' }),
        stdout: 'x'.repeat(65536),
        stderr: 'y'.repeat(65536),
    };
    const f = ports(r);
    const result = firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true })(
        root,
        'fixture-winps.exe',
        raw,
        f.options,
    );
    assert.equal(f.records.length, 8);
    assert(
        f.records.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)) + 1, 0) <=
            245760,
    );
    assert(f.records.every((value) => Buffer.byteLength(JSON.stringify(value)) + 1 <= 65536));
    assert.equal(f.states[0].closed, false);
    assert.equal(result.result.streams.stdout.retainedBytes, 65536);
    assert.equal(result.result.streams.stderr.retainedBytes, 65536);
});
test('uncertain process callback precedes raw persistence failure; no report is returned', () => {
    const r = {
        pid: 2468,
        status: null,
        signal: 'SIGTERM',
        error: Error('fixture timeout'),
        stdout: 'partial',
        stderr: '',
    };
    const f = ports(r),
        record = f.options.record;
    f.options.record = (stage, data) => {
        if (stage === 'security-output') {
            assert.equal(f.states[0].closed, false);
            throw Error('fixture raw write refusal');
        }
        record(stage, data);
    };
    assert.throws(
        () =>
            firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true })(
                root,
                'fixture-winps.exe',
                raw,
                f.options,
            ),
        /fixture raw write refusal/,
    );
    assert.equal(f.states.length, 1);
});
