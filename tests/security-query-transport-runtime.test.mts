// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
    decodeQueryInputTransport,
    requireQueryInputs,
    oldQueryInputs,
    queryPolicy,
    querySourceRoot,
} from '../scripts/lib/security-query-diagnostic.mjs';
import { queryOwner } from '../scripts/lib/security-query-diagnostic-runtime.mjs';
import {
    requirePreinstalledQueryRuntime,
    queryRuntimeAdmissionReceipt,
} from '../scripts/lib/security-query-job-admission.mjs';
const captured = JSON.parse(
    fs.readFileSync(
        new URL('./fixtures/security-query-input-context-39472996516.json', import.meta.url),
        'utf8',
    ),
);
const request = captured.security_query_request_json;
const wire = {
    ...oldQueryInputs,
    windows_security_query_only: true,
    security_query_request_json: request,
};
const optional = Object.keys(oldQueryInputs).filter((k) => oldQueryInputs[k] === '');
const required = Object.keys(wire).filter((k) => !optional.includes(k));
assert.equal(optional.length, 11);
assert.equal(required.length, 7);
test('transport accepts captured7 and sealed18 while the unchanged canonical validator still requires18', () => {
    const before = JSON.stringify(captured),
        a = decodeQueryInputTransport(captured, request),
        b = decodeQueryInputTransport(wire, request);
    assert.deepEqual(a, wire);
    assert.deepEqual(b, wire);
    assert(Object.isFrozen(a));
    assert.notEqual(a, captured);
    assert.equal(JSON.stringify(captured), before);
    assert.throws(() => requireQueryInputs(captured, request));
    assert.doesNotThrow(() => requireQueryInputs(wire, request));
});
test('all2048 subsets of only the11known empty omissions preserve exact canonical input', () => {
    for (let mask = 0; mask < 2048; mask++) {
        const value = { ...wire };
        for (let i = 0; i < 11; i++) if (mask & (1 << i)) delete value[optional[i]];
        assert.deepEqual(decodeQueryInputTransport(value, request), wire);
    }
});
for (const key of required)
    test('required transport field is never synthesized: ' + key, () => {
        const v = { ...wire };
        delete v[key];
        assert.throws(() => decodeQueryInputTransport(v, request), /Required/);
    });
for (const key of optional)
    for (const bad of ['x', ' ', '\n', null, false, 0, [], {}, new String('')])
        test(
            'ancillary transport rejects nonempty/wrong type ' + key + ' ' + JSON.stringify(bad),
            () => {
                assert.throws(() =>
                    decodeQueryInputTransport({ ...captured, [key]: bad }, request),
                );
            },
        );
for (const key of required.filter((k) => k !== 'security_query_request_json'))
    for (const bad of [undefined, null, 0, 1, 'true', 'false', {}, []])
        test(
            'boolean remains explicit and strictly typed ' + key + ' ' + JSON.stringify(bad),
            () => {
                assert.throws(() =>
                    decodeQueryInputTransport({ ...captured, [key]: bad }, request),
                );
            },
        );
for (const key of [
    'unknown',
    '__proto__',
    'constructor',
    'hasOwnProperty',
    'PTY_SOURCE_SHA256',
    'pty_source_sha25６',
])
    for (const value of ['', false, null])
        test('unknown transport field never discarded ' + key + ' ' + JSON.stringify(value), () => {
            const v = JSON.parse(JSON.stringify(captured));
            Object.defineProperty(v, key, { value, enumerable: true });
            assert.throws(() => decodeQueryInputTransport(v, request), /Unknown/);
        });
for (const bad of [null, [], false, '{}', Object.create(null)])
    test(
        'malformed transport object refuses ' +
            String(bad === null ? 'null' : Array.isArray(bad) ? 'array' : typeof bad),
        () => {
            assert.throws(() => decodeQueryInputTransport(bad, request));
        },
    );
for (const bad of [
    '',
    request + ' ',
    request + '\n',
    request.replace('f4089a1', 'e4089a1'),
    null,
    false,
    {},
])
    test('request transport byte/type drift refuses ' + JSON.stringify(bad).slice(0, 45), () => {
        assert.throws(() =>
            decodeQueryInputTransport({ ...captured, security_query_request_json: bad }, request),
        );
    });
for (const bad of [null, undefined, ''])
    test('missing trusted request never filled ' + String(bad), () => {
        assert.throws(() => decodeQueryInputTransport(captured, bad));
    });
function ownerEnvironment(input) {
    const r = JSON.parse(request),
        raw = JSON.stringify(r);
    return {
        GITHUB_SHA: r.commit,
        GITHUB_REF: r.ref,
        SECURITY_QUERY_REQUEST_JSON: raw,
        SECURITY_QUERY_INPUTS_JSON: typeof input === 'string' ? input : JSON.stringify(input),
    };
}
for (const input of [captured, wire])
    test(
        'actual owner accepts reviewed transport then stops at controlled context, before owned effects ' +
            Object.keys(input).length,
        async () => {
            let contexts = 0,
                effects = 0;
            await assert.rejects(
                queryOwner(
                    { startedAt: 1, environment: ownerEnvironment(input) },
                    {
                        argv: ['node', 'entry'],
                        execArgv: queryPolicy.runtimeArgs,
                        version: queryPolicy.node,
                        context() {
                            contexts++;
                            throw Error('controlled-after-input-decoding');
                        },
                        runtime() {
                            effects++;
                        },
                        jobTime() {
                            effects++;
                        },
                        spawn() {
                            effects++;
                        },
                        hold() {
                            effects++;
                        },
                    },
                ),
                /controlled-after-input-decoding/,
            );
            assert.equal(contexts, 1);
            assert.equal(effects, 0);
        },
    );
for (const input of [
    { ...captured, unknown: '' },
    { ...captured, windows_native_pilot: true },
    { ...captured, pty_source_sha256: 'not-empty' },
    Object.fromEntries(Object.entries(captured).filter(([k]) => k !== 'windows_preflight_only')),
    '{malformed',
])
    test(
        'actual owner bad transport refuses before context/runtime/owned effects ' +
            JSON.stringify(input).slice(0, 70),
        async () => {
            let effects = 0;
            await assert.rejects(
                queryOwner(
                    { startedAt: 1, environment: ownerEnvironment(input) },
                    {
                        argv: ['node', 'entry'],
                        execArgv: queryPolicy.runtimeArgs,
                        version: queryPolicy.node,
                        context() {
                            effects++;
                        },
                        runtime() {
                            effects++;
                        },
                        jobTime() {
                            effects++;
                        },
                        spawn() {
                            effects++;
                        },
                        hold() {
                            effects++;
                        },
                    },
                ),
            );
            assert.equal(effects, 0);
        },
    );
function runtimeFixture(fault, cache = 'D:\\hosted tool cache\\windows') {
    const file = path.win32.join(cache, 'node', '24.22.0', 'x64', 'node.exe'),
        marker = path.win32.join(cache, 'node', '24.22.0', 'x64.complete');
    const missing = {
        base: cache,
        tool: path.win32.join(cache, 'node'),
        version: path.win32.join(cache, 'node', '24.22.0'),
        arch: path.win32.join(cache, 'node', '24.22.0', 'x64'),
        exe: file,
        marker,
    };
    const calls = [];
    const io = {
        lstatSync(p) {
            calls.push(['lstat', p]);
            if (p === missing[fault]) throw Error('fixture missing component');
            const isFile = p === file || p === marker;
            return {
                isDirectory: () => !isFile,
                isFile: () => isFile,
                isSymbolicLink: () => fault === 'alias' && p === missing.arch,
                nlink: fault === 'hardlink' && p === file ? 2 : 1,
                size: p === marker && fault === 'incomplete' ? 1 : 0,
            };
        },
        realpathSync(p) {
            calls.push(['realpath', p]);
            return fault === 'rebound' ? p + '-alias' : p;
        },
        openSync() {
            throw Error('must never open owned file');
        },
    };
    const env = { RUNNER_TOOL_CACHE: cache, UNSAFE_SECRET: 'never-include-this-value' };
    const opts = { platform: 'win32', arch: 'x64', version: 'v24.22.0', execPath: file, io };
    if (fault === 'wrong-version') opts.version = 'v24.22.1';
    if (fault === 'wrong-arch') opts.arch = 'arm64';
    if (fault === 'quoted-exec') opts.execPath = '"' + file + '"';
    if (fault === 'missing-env') delete env.RUNNER_TOOL_CACHE;
    return { env, opts, calls, file, marker };
}
test('runtime receipt comes only from successful exact checks, and is runtime-only/bounded/captured-safe', () => {
    const f = runtimeFixture(),
        admission = requirePreinstalledQueryRuntime(f.env, f.opts),
        line = queryRuntimeAdmissionReceipt(admission),
        r = JSON.parse(line);
    assert(Buffer.byteLength(line) <= 4096);
    assert.equal(r.kind, 'query-runtime-admitted');
    assert.equal(r.version, 'v24.22.0');
    assert.equal(r.platform, 'win32');
    assert.equal(r.arch, 'x64');
    assert.equal(r.executable, f.file);
    assert.equal(r.completeMarker, f.marker);
    assert.equal(r.jobAdmitted, false);
    assert.equal(r.queryAdmitted, false);
    assert.equal(r.closureAttested, false);
    assert(!line.includes(f.env.UNSAFE_SECRET));
    assert.throws(() => queryRuntimeAdmissionReceipt({ ...admission }), /Validated/);
});
for (const fault of [
    'base',
    'tool',
    'version',
    'arch',
    'exe',
    'marker',
    'alias',
    'hardlink',
    'incomplete',
    'rebound',
    'wrong-version',
    'wrong-arch',
    'quoted-exec',
    'missing-env',
])
    test('fixed-runtime ' + fault + ' cannot produce an admission receipt or owned effect', () => {
        const f = runtimeFixture(fault);
        assert.throws(() =>
            queryRuntimeAdmissionReceipt(requirePreinstalledQueryRuntime(f.env, f.opts)),
        );
        assert(f.calls.every((x) => ['lstat', 'realpath'].includes(x[0])));
    });
test('runtime receipt refuses oversized validated path metadata before dynamic/owned effects', () => {
    const f = runtimeFixture(undefined, 'D:\\' + 'a'.repeat(5000));
    const a = requirePreinstalledQueryRuntime(f.env, f.opts);
    assert.throws(() => queryRuntimeAdmissionReceipt(a), /receipt bound/);
});
const { load } = createRequire(import.meta.url)('js-yaml');
const flow = load(
        fs.readFileSync(
            path.join(querySourceRoot, '.github/workflows/windows-portable.yml'),
            'utf8',
        ),
    ),
    script = flow.jobs['windows-security-query-only'].steps[1].run;
test('CMD diagnostics are fixed bounded facts, all targets quoted, sole original runtime invocation last', () => {
    const lines = script.trimEnd().split(/\r?\n/);
    assert.equal(lines[0], '@echo off');
    const names = [
        'cache-env',
        'cache-base',
        'node-tool',
        'version-24.22.0',
        'arch-x64',
        'node-exe-path',
        'complete-marker-path',
        'entry-script-path',
    ];
    const echo = lines
        .filter((x) => x.trimStart().startsWith('echo '))
        .map((x) => JSON.parse(x.trimStart().slice(5)));
    assert.equal(echo.length, 16);
    assert.deepEqual([...new Set(echo.map((x) => x.component))], names);
    assert(
        echo.every(
            (x) =>
                x.kind === 'query-runtime-prelaunch' &&
                Buffer.byteLength(JSON.stringify(x) + '\r\n') <= 160,
        ),
    );
    assert(8 * 160 <= 1280);
    assert(script.includes('if defined RUNNER_TOOL_CACHE ('));
    assert(script.includes('present":false}\n  exit /b 1'));
    const checks = lines.filter((x) => x.startsWith('if exist '));
    assert.equal(checks.length, 7);
    assert(checks.every((x) => /^if exist "[^"\r\n]+" \($/.test(x)));
    assert(
        checks.every(
            (x) =>
                x.includes('%RUNNER_TOOL_CACHE%') ||
                x.includes('scripts\\windows-security-query-diagnostic.mjs'),
        ),
    );
    const invoke =
        '"%RUNNER_TOOL_CACHE%\\node\\24.22.0\\x64\\node.exe" --experimental-transform-types scripts/windows-security-query-diagnostic.mjs';
    assert.equal(lines.at(-1), invoke);
    assert.equal(lines.filter((x) => x === invoke).length, 1);
    assert.doesNotMatch(
        script,
        /\b(?:where|powershell|pwsh|npm|npx|yarn|curl|wget|for|start|call|set)\b|--version|setup-node/i,
    );
    assert(script.includes('pathExists'));
    assert(!echo.some((x) => Object.hasOwn(x, 'admitted') || Object.hasOwn(x, 'executable')));
});
test('entry checks and bounds receipt before capture/import; receipt follows captured stdout installation', () => {
    const entry = fs.readFileSync(
        path.join(querySourceRoot, 'scripts/windows-security-query-diagnostic.mjs'),
        'utf8',
    );
    const gate = entry.indexOf(
            'runtimeReceipt = queryRuntimeAdmissionReceipt(requirePreinstalledQueryRuntime())',
        ),
        capture = entry.indexOf('ownerStdioCapture().install()'),
        write = entry.indexOf('process.stdout.write(runtimeReceipt)'),
        dynamic = entry.indexOf("void import('./lib/security-query-diagnostic-runtime.mjs')");
    assert(gate >= 0 && gate < capture && capture < write && write < dynamic);
    assert(entry.indexOf('entryStartedAt =') < gate);
    assert.equal(queryPolicy.node, 'v24.22.0');
    assert.equal(queryPolicy.ownerMs, 600000);
    assert.equal(queryPolicy.cleanupMs, 60000);
    assert.equal(queryPolicy.queryMs, 10000);
    assert.equal(queryPolicy.powershellProcesses, 45);
    assert.equal(queryPolicy.nodeProcesses, 2);
});

test('transport never drops nonenumerable/symbol fields or invokes accessors', () => {
    const hidden = { ...wire };
    Object.defineProperty(hidden, 'unknown', { value: '', enumerable: false });
    assert.throws(() => decodeQueryInputTransport(hidden, request), /Unknown/);
    const symbol = { ...wire, [Symbol('unknown')]: '' };
    assert.throws(() => decodeQueryInputTransport(symbol, request), /Unknown/);
    let invoked = 0;
    const accessor = { ...wire };
    Object.defineProperty(accessor, 'pty_source_sha256', {
        get() {
            invoked++;
            return '';
        },
        enumerable: true,
    });
    assert.throws(() => decodeQueryInputTransport(accessor, request), /JSON data/);
    assert.equal(invoked, 0);
});
