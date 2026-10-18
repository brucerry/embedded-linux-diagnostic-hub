import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, fileIdentity } from './windows-preflight.mjs';
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
        if (key.toUpperCase() === 'PSMODULEPATH' || key === 'HUB_NATIVE_PILOT_SECURITY_RED_CONTROL')
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
    } = {},
) {
    const launch = securityLaunch(sourceRoot, powershell, rawJSON, environment, { red, timeout });
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
    });
    let r;
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
