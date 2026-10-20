import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, fileIdentity } from './windows-preflight.mjs';
const diagnosticVariable = 'HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC';
const diagnosticTokens = new WeakMap();
const diagnosticEnvironmentKeys = Object.freeze([
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'COMSPEC',
    'PATHEXT',
    'PSModulePath',
    'PATH',
    'ProgramFiles',
    'ProgramW6432',
    'ProgramData',
    'PUBLIC',
    'USERNAME',
    'USERDOMAIN',
    'OS',
    'SESSIONNAME',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
]);
const diagnosticTick = (clock) => {
    const value = clock();
    assert(Number.isSafeInteger(value) && value >= 0, 'Diagnostic monotonic clock');
    return value;
};
function environmentPresence(environment) {
    const names = new Set(Object.keys(environment).map((key) => key.toUpperCase()));
    return Object.fromEntries(
        diagnosticEnvironmentKeys.map((key) => [key, names.has(key.toUpperCase())]),
    );
}
/** Inert until explicitly supplied by a separately reviewed diagnostic caller. No route/env activation. */
export function firstCollectorSecurityQuery({
    outputRoot,
    diagnostic = false,
    clock = () => Number(process.hrtime.bigint() / 1000000n),
} = {}) {
    assert.equal(typeof diagnostic, 'boolean');
    if (diagnostic) {
        assert(typeof outputRoot === 'string' && path.isAbsolute(outputRoot));
        assert.equal(typeof clock, 'function');
    }
    const token = Object.freeze({});
    diagnosticTokens.set(token, { outputRoot, clock, consumed: false });
    let first = true;
    return (sourceRoot, powershell, rawJSON, options = {}) => {
        assert.equal(options.diagnostic, undefined, 'Diagnostic capability cannot be overridden');
        const enabled = first && diagnostic;
        first = false;
        return runSecurityCommand(sourceRoot, powershell, rawJSON, {
            ...options,
            ...(enabled ? { diagnostic: token } : {}),
        });
    };
}
export function securityLaunch(
    sourceRoot,
    powershell,
    rawJSON,
    environment = process.env,
    { red = false, timeout = 10000 } = {},
) {
    assert(typeof rawJSON === 'string' && Buffer.byteLength(rawJSON) <= 16384);
    assert(timeout > 0 && timeout <= 10000);
    const script = path.join(sourceRoot, 'scripts/lib/hosted-pilot-security.ps1');
    const env = { ...environment, HUB_NATIVE_PILOT_SECURITY_PATHS: rawJSON };
    for (const key of Object.keys(env))
        if (
            key.toUpperCase() === 'PSMODULEPATH' ||
            key === 'HUB_NATIVE_PILOT_SECURITY_RED_CONTROL' ||
            key.toUpperCase() === diagnosticVariable
        )
            delete env[key];
    if (red) env.HUB_NATIVE_PILOT_SECURITY_RED_CONTROL = '1';
    return {
        executable: powershell,
        args: ['-NoProfile', '-NonInteractive', '-File', script],
        options: {
            encoding: 'utf8',
            windowsHide: true,
            timeout,
            maxBuffer: 65536,
            shell: false,
            env,
        },
        script,
    };
}
/** Raw input/result are acknowledged durably before any process or parser assertion. */
export function runSecurityCommand(
    sourceRoot,
    powershell,
    rawJSON,
    {
        environment = process.env,
        red = false,
        timeout = 10000,
        record,
        spawn = spawnSync,
        identity = fileIdentity,
        check = () => {},
        onProcessState = () => {},
        diagnostic,
    } = {},
) {
    const launch = securityLaunch(sourceRoot, powershell, rawJSON, environment, { red, timeout });
    const diagnosticState = diagnostic === undefined ? null : diagnosticTokens.get(diagnostic);
    assert(diagnostic === undefined || diagnosticState, 'Foreign diagnostic capability');
    let diagnosticInput;
    if (diagnosticState) {
        assert(!diagnosticState.consumed, 'First-query diagnostic already consumed');
        diagnosticState.consumed = true;
        assert.equal(red, false);
        assert.deepEqual(JSON.parse(rawJSON), [
            { path: diagnosticState.outputRoot, kind: 'directory' },
        ]);
        diagnosticInput = {
            schema: 1,
            kind: 'first-collector-security-query',
            admittedAtMs: diagnosticTick(diagnosticState.clock),
            pid: process.pid,
            parentPID: process.ppid,
            cwdMatchesSourceRoot: path.resolve(process.cwd()) === path.resolve(sourceRoot),
            ipcConnected: process.connected === true,
            inheritedPresence: environmentPresence(environment),
            effectivePresence: environmentPresence(launch.options.env),
        };
        assert(Buffer.byteLength(JSON.stringify(diagnosticInput)) <= 2048);
        launch.options.env[diagnosticVariable] = 'first-collector-query-v1';
    }
    check();
    const executable = identity(powershell, { pe: true, check }),
        script = identity(launch.script, { check });
    assert.equal(executable.pe.architecture, 'x64');
    record('security-input', {
        json: rawJSON,
        bytes: Buffer.byteLength(rawJSON),
        sha256: digest(Buffer.from(rawJSON)),
        launch: {
            executable: powershell,
            args: launch.args,
            timeout,
            maxBuffer: 65536,
            shell: false,
            PSModulePathIsolatedInChild: true,
            executionPolicyChanged: false,
        },
        executable,
        script,
        red,
        ...(diagnosticInput ? { diagnostic: diagnosticInput } : {}),
    });
    let r;
    const spawnStartedAtMs = diagnosticState ? diagnosticTick(diagnosticState.clock) : null;
    if (diagnosticState) assert(spawnStartedAtMs >= diagnosticInput.admittedAtMs);
    try {
        r = spawn(launch.executable, launch.args, launch.options);
    } catch (error) {
        r = { error, status: null, signal: null, stdout: '', stderr: '' };
    }
    // Latch the process outcome before raw writes, cancellation/deadline checks or
    // identity readbacks. An uncertain callback must hold ownership before reporting.
    const processState = Object.freeze({
        attempted: true,
        closed: Number.isInteger(r.status) && !r.signal && !r.error,
        status: Number.isInteger(r.status) ? r.status : null,
        signal: r.signal ?? null,
        errorPresent: Boolean(r.error),
    });
    onProcessState(processState);
    // The original hold callback always runs before any diagnostic clock/readback can fail.
    let diagnosticResult;
    if (diagnosticState) {
        let returnedObservedAtMs = null;
        try {
            const value = diagnosticTick(diagnosticState.clock);
            if (value >= spawnStartedAtMs) returnedObservedAtMs = value;
        } catch {
            /* Missing diagnostic time never changes the actual process result or hold. */
        }
        diagnosticResult = {
            schema: 1,
            kind: 'first-collector-security-query',
            clockComplete: returnedObservedAtMs !== null,
            spawnStartedAtMs,
            returnedObservedAtMs,
            observedElapsedMs:
                returnedObservedAtMs === null ? null : returnedObservedAtMs - spawnStartedAtMs,
            returnedPID: Number.isSafeInteger(r.pid) && r.pid > 0 ? r.pid : null,
            errorCode: ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOBUFS', 'ECANCELED'].includes(
                r.error?.code,
            )
                ? r.error.code
                : r.error
                  ? 'OTHER'
                  : null,
            errno: Number.isSafeInteger(r.error?.errno) ? r.error.errno : null,
            syscall:
                typeof r.error?.syscall === 'string' && r.error.syscall.startsWith('spawnSync')
                    ? 'spawnSync'
                    : null,
            actualExitOrPipeCloseObserved: false,
        };
        assert(Buffer.byteLength(JSON.stringify(diagnosticResult)) <= 1024);
    }
    const streams = {};
    for (const name of ['stdout', 'stderr']) {
        const full = Buffer.from(typeof r[name] === 'string' ? r[name] : '', 'utf8'),
            bytes = full.subarray(0, 65536);
        streams[name] = {
            bytes: full.length,
            sha256: digest(full),
            retainedBytes: bytes.length,
            truncated: full.length > bytes.length,
        };
        for (let offset = 0; offset < bytes.length; offset += 24576)
            record('security-output', {
                stream: name,
                offset,
                bytes: Math.min(24576, bytes.length - offset),
                base64: bytes.subarray(offset, offset + 24576).toString('base64'),
            });
    }
    const result = {
        status: Number.isInteger(r.status) ? r.status : null,
        signal: r.signal ?? null,
        error: r.error ? String(r.error).slice(0, 1024) : null,
        streams,
        ...(diagnosticResult ? { diagnostic: diagnosticResult } : {}),
    };
    record('security-command-closed', result);
    check();
    assert.deepEqual(identity(powershell, { pe: true, check }), executable);
    assert.deepEqual(identity(launch.script, { check }), script);
    return {
        processState,
        result,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        script,
        executable,
    };
}
export function requireSecurityProcess(result) {
    assert.equal(result.error, null);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, 'Security provider refused; raw evidence retained.');
    assert(
        Object.values(result.streams).every((s) => !s.truncated),
        'Provider transport exceeded bound; raw prefix retained.',
    );
}
