// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    firstCollectorSecurityQuery,
    runSecurityCommand,
} from '../scripts/lib/pilot-security-command.mjs';
import {
    PreparationEvidence,
    preparationEvidenceLimits,
    readPreparationEvidence,
} from '../scripts/lib/observation-preparation-evidence.mjs';
import { progressReply } from './fixtures/security-diagnostic-progress.mjs';
const sourceRoot = path.resolve(import.meta.dirname, '..');
const diagnosticVariable = 'HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC';
const raw = (root) => JSON.stringify([{ path: root, kind: 'directory' }]);
function ports(result = { status: 0, signal: null, stdout: '{}', stderr: '' }) {
    const records = [],
        launches = [],
        states = [];
    return {
        records,
        launches,
        states,
        options: {
            environment: {
                SystemRoot: 'fixture-Windows',
                PATH: 'fixture-path',
                PSModulePath: 'fixture-module',
                USERNAME: 'private-name',
                GITHUB_TOKEN: 'NEVER_RECORD_THIS_TOKEN',
                UNSAFE_SECRET: 'NEVER_RECORD_THIS_VALUE',
                [diagnosticVariable]: 'first-collector-query-v2',
            },
            identity: (file) => ({
                path: file,
                sha256: 'a'.repeat(64),
                pe: { architecture: 'x64' },
            }),
            record: (stage, data) => records.push({ stage, data }),
            onProcessState: (state) => states.push(state),
            spawn(exe, args, options) {
                launches.push({ exe, args, options });
                if (
                    options.env[diagnosticVariable] === 'first-collector-query-v2' &&
                    result.status === 0 &&
                    !result.error &&
                    !result.signal &&
                    result.stdout === '{}'
                )
                    return { ...result, ...progressReply() };
                return result;
            },
        },
    };
}
test('default query and default factory have unchanged records; inherited diagnostic flag cannot activate tracing', () => {
    const root = os.tmpdir(),
        f = ports(),
        query = firstCollectorSecurityQuery();
    runSecurityCommand(sourceRoot, 'fixture-winps.exe', raw(root), f.options);
    query(sourceRoot, 'fixture-winps.exe', raw(root), f.options);
    assert.deepEqual(f.records.slice(0, 3), f.records.slice(3));
    for (const launch of f.launches) {
        assert.equal(launch.options.timeout, 10000);
        assert.equal(launch.options.maxBuffer, 65536);
        assert.equal(launch.options.env[diagnosticVariable], undefined);
        assert.equal(launch.options.env.PSModulePath, undefined);
        assert.equal(launch.options.shell, false);
    }
    assert(f.records.every((r) => r.data.diagnostic === undefined));
});
test('only the bound first query receives safe metadata and phase tracing; timeout remains unclosed', () => {
    const root = os.tmpdir(),
        order = [],
        ticks = [100, 110, 210],
        query = firstCollectorSecurityQuery({
            outputRoot: root,
            diagnostic: true,
            clock() {
                order.push('clock');
                return ticks.shift();
            },
        }),
        error = Object.assign(Error('fixture timeout'), {
            code: 'ETIMEDOUT',
            errno: -110,
            syscall: 'spawnSync fixture-winps.exe',
        }),
        f = ports({ pid: 2468, status: null, signal: 'SIGTERM', error, stdout: '', stderr: '' });
    const options = {
        ...f.options,
        onProcessState(state) {
            order.push('hold-first');
            f.states.push(state);
        },
    };
    query(sourceRoot, 'fixture-winps.exe', raw(root), options);
    query(sourceRoot, 'fixture-winps.exe', raw(root), options);
    assert.deepEqual(order, ['clock', 'clock', 'hold-first', 'clock', 'hold-first']);
    assert.equal(f.launches[0].options.env[diagnosticVariable], 'first-collector-query-v2');
    assert.equal(f.launches[1].options.env[diagnosticVariable], undefined);
    const input = f.records[0].data.diagnostic,
        result = f.records[1].data.diagnostic;
    assert(input.inheritedPresence.PSModulePath);
    assert.equal(input.effectivePresence.PSModulePath, false);
    assert(input.effectivePresence.PATH);
    assert(input.effectivePresence.USERNAME);
    assert.equal(result.spawnStartedAtMs, 110);
    assert.equal(result.returnedObservedAtMs, 210);
    assert.equal(result.observedElapsedMs, 100);
    assert.equal(result.returnedPID, 2468);
    assert.equal(result.errorCode, 'ETIMEDOUT');
    assert.equal(result.errno, -110);
    assert.equal(result.syscall, 'spawnSync');
    assert.equal(result.actualExitOrPipeCloseObserved, false);
    assert.equal(f.states[0].closed, false);
    assert(f.records.slice(2).every((r) => !r.data.diagnostic));
    const retained = JSON.stringify(f.records);
    for (const value of [
        'NEVER_RECORD_THIS_TOKEN',
        'NEVER_RECORD_THIS_VALUE',
        'private-name',
        'fixture-path',
        'fixture-module',
        'UNSAFE_SECRET',
        'GITHUB_TOKEN',
    ])
        assert(!retained.includes(value));
    assert(Buffer.byteLength(JSON.stringify(input)) <= 2048);
    assert(Buffer.byteLength(JSON.stringify(result)) <= 1024);
});
for (const after of [
    () => {
        throw Error('clock failed');
    },
    () => 109,
])
    test('post-result diagnostic clock failure cannot suppress the original uncertain-process callback', () => {
        let call = 0,
            held = false;
        const query = firstCollectorSecurityQuery({
                outputRoot: os.tmpdir(),
                diagnostic: true,
                clock() {
                    if (++call < 3) return call === 1 ? 100 : 110;
                    assert(held);
                    return after();
                },
            }),
            f = ports({
                status: null,
                signal: 'SIGTERM',
                error: Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }),
                stdout: '',
                stderr: '',
            });
        query(sourceRoot, 'fixture-winps.exe', raw(os.tmpdir()), {
            ...f.options,
            onProcessState(state) {
                assert.equal(state.closed, false);
                held = true;
            },
        });
        assert(held);
        assert.equal(f.records.at(-1).data.diagnostic.clockComplete, false);
        assert.equal(f.records.at(-1).data.diagnostic.observedElapsedMs, null);
        assert.match(f.records.at(-1).data.error, /timeout/);
    });
test('foreign capability, wrong plan and pre-spawn clock drift refuse before process effects; consumed attempt is not traced again', () => {
    const root = os.tmpdir(),
        f = ports();
    assert.throws(
        () =>
            runSecurityCommand(sourceRoot, 'fixture-winps.exe', raw(root), {
                ...f.options,
                diagnostic: {},
            }),
        /Foreign diagnostic/,
    );
    const query = firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true });
    assert.throws(() =>
        query(
            sourceRoot,
            'fixture-winps.exe',
            JSON.stringify([{ path: root, kind: 'file' }]),
            f.options,
        ),
    );
    assert.equal(f.launches.length, 0);
    query(sourceRoot, 'fixture-winps.exe', raw(root), f.options);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].options.env[diagnosticVariable], undefined);
    const ticks = [100, 99],
        drift = firstCollectorSecurityQuery({
            outputRoot: root,
            diagnostic: true,
            clock: () => ticks.shift(),
        });
    assert.throws(() => drift(sourceRoot, 'fixture-winps.exe', raw(root), f.options));
    assert.equal(f.launches.length, 1);
});
function ledgerFixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-query-diagnostic-'))),
        ledger = new PreparationEvidence(root, {
            check() {},
            admit() {},
            hold() {
                assert.fail('Unexpected unknown ledger');
            },
        });
    return {
        root,
        ledger,
        record: (stage, data) => ledger.record(stage, data),
        close() {
            fs.rmSync(root, { recursive: true });
        },
    };
}
test('opt-in metadata fits the unchanged eight-row whole-query reservation with both maximum captured streams', () => {
    const f = ledgerFixture(),
        p = ports(),
        ticks = [100, 110, 120];
    const body = () => {
        const bytes = Buffer.alloc(65536);
        let seed = 0x1a2b3c4d;
        for (let i = 0; i < bytes.length; i++) {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            bytes[i] = 32 + ((seed >>> 0) % 95);
        }
        return bytes.toString('ascii');
    };
    const query = f.ledger.securityQuery(
        firstCollectorSecurityQuery({
            outputRoot: f.root,
            diagnostic: true,
            clock: () => ticks.shift(),
        }),
    );
    try {
        query(sourceRoot, 'fixture-winps.exe', raw(f.root), {
            ...p.options,
            record: f.record,
            spawn: () => ({
                pid: 99,
                status: null,
                signal: 'SIGTERM',
                error: Object.assign(Error('fixture timeout'), { code: 'ETIMEDOUT' }),
                stdout: body(),
                stderr: body(),
            }),
        });
        assert.equal(f.ledger.snapshot().rows, preparationEvidenceLimits.queryRows);
        assert(f.ledger.snapshot().bytes <= preparationEvidenceLimits.queryBytes);
        const rows = [...readPreparationEvidence(f.root)];
        assert.equal(rows.length, 8);
        assert(rows[0].data.diagnostic);
        assert(rows.at(-1).data.diagnostic);
        for (const name of fs.readdirSync(f.root))
            assert(fs.statSync(path.join(f.root, name)).size <= preparationEvidenceLimits.rowBytes);
    } finally {
        f.close();
    }
});
test('first-query telemetry leaves subsequent stable query compression and original preparation limits intact', () => {
    const f = ledgerFixture(),
        p = ports(),
        ticks = [100, 110, 120],
        query = f.ledger.securityQuery(
            firstCollectorSecurityQuery({
                outputRoot: f.root,
                diagnostic: true,
                clock: () => ticks.shift(),
            }),
        );
    try {
        for (let i = 0; i < 120; i++)
            query(sourceRoot, 'fixture-winps.exe', raw(f.root), { ...p.options, record: f.record });
        const physical = fs
            .readdirSync(f.root)
            .map((name) => JSON.parse(fs.readFileSync(path.join(f.root, name), 'utf8')));
        assert.equal(physical.length, 360);
        // Framed diagnostic stdout and later plain stdout require separate durable origins.
        assert.equal(physical.filter((r) => r.reference).length, 354);
        const decoded = [...readPreparationEvidence(f.root)];
        assert(decoded.slice(3).every((r) => !r.data.diagnostic));
        assert(
            f.ledger.snapshot().bytes <
                preparationEvidenceLimits.bytes - preparationEvidenceLimits.terminalBytes,
        );
        assert(
            f.ledger.snapshot().rows <
                preparationEvidenceLimits.rows - preparationEvidenceLimits.terminalRows,
        );
        assert(f.ledger.snapshot().complete);
    } finally {
        f.close();
    }
});

test('failed input admission cannot start the diagnostic helper or transfer its token to a retry', () => {
    const root = os.tmpdir(),
        f = ports(),
        query = firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true });
    assert.throws(
        () =>
            query(sourceRoot, 'fixture-winps.exe', raw(root), {
                ...f.options,
                record() {
                    throw Error('pre-write budget refusal');
                },
            }),
        /pre-write budget/,
    );
    assert.equal(f.launches.length, 0);
    assert.equal(f.states.length, 0);
    query(sourceRoot, 'fixture-winps.exe', raw(root), f.options);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].options.env[diagnosticVariable], undefined);
});
test('declared active WinPS phase sites fit the combined stdout/stderr trace budget without extra query rows', () => {
    // Static cross-language bound only; this does not execute or syntax-validate Windows PowerShell.
    const source = fs.readFileSync(
            path.join(sourceRoot, 'scripts/lib/hosted-pilot-security.ps1'),
            'utf8',
        ),
        phases = [...source.matchAll(/Write-HubSecurityPhase -Phase '([a-z-]+)'/g)]
            .map((m) => m[1])
            .filter((phase) => !['before-stdout', 'after-stdout'].includes(phase));
    assert(phases.length > 0 && phases.length <= 16);
    let bytes = 0;
    for (const phase of phases) {
        const row =
            JSON.stringify({
                schema: 1,
                kind: 'security-phase',
                phase,
                pid: 2147483647,
                ticks: '9223372036854775807',
                frequency: '9223372036854775807',
            }) + '\r\n';
        assert(Buffer.byteLength(row) <= 256);
        bytes += Buffer.byteLength(row);
    }
    assert(bytes <= 4096);
    assert(source.includes('[Console]::Error.WriteLine($line)'));
    assert(source.includes('[Console]::Error.Flush()'));
});
