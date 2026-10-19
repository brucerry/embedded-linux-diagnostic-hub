import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, fileIdentity } from './windows-preflight.mjs';

const errorText = (error) => {
    if (!error) return null;
    return {
        name: String(error.name ?? 'Error').slice(0, 128),
        message: String(error.message ?? error).slice(0, 1024),
        code: error.code == null ? null : String(error.code).slice(0, 128),
        errno: error.errno == null ? null : String(error.errno).slice(0, 128),
        syscall: error.syscall == null ? null : String(error.syscall).slice(0, 256),
        stack: typeof error.stack === 'string' ? error.stack.slice(0, 4096) : null,
    };
};
export function prerequisiteFailure(error, prerequisite) {
    return {
        prerequisite,
        error: String(error).slice(0, 2048),
        stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4096) : null,
    };
}
/** Preserve the original where.exe search, first-path selection and 2s/8KiB bounds.
 * The basename launch does not attest the resolver's actual process image.
 */
export async function lookupPilotTool(
    name,
    {
        record,
        ordinal,
        workDeadline,
        clock = () => Number(process.hrtime.bigint() / 1000000n),
        clockDomain = 'node-hrtime-milliseconds',
        check = () => {},
        onProcessState = () => {},
        spawn = spawnSync,
        realpath = fs.realpathSync,
        absolute = path.isAbsolute,
        identity = fileIdentity,
        inheritedEnvironment = process.env,
        cwd = process.cwd(),
    },
) {
    assert(['git.exe', 'pwsh.exe'].includes(name), 'Unexpected prerequisite lookup');
    assert(Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= 2, 'Lookup ordinal required');
    assert.equal(name, ['git.exe', 'pwsh.exe'][ordinal - 1], 'Lookup order changed');
    assert(Number.isFinite(workDeadline), 'Absolute lookup work cutoff required');
    const admit = () => {
        check();
        const now = clock();
        assert(
            Number.isFinite(now) && now < workDeadline,
            'Prerequisite lookup work cutoff expired: ' + name,
        );
        return now;
    };
    const startedAt = admit();
    const emit = (stage, data) => record(stage, { ordinal, requestedTool: name, ...data });
    const pathValue =
        Object.entries(inheritedEnvironment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ??
        '';
    const pathBytes = Buffer.from(pathValue, 'utf8');
    await emit('tool-lookup-start', {
        startedAt,
        workDeadline,
        clockDomain,
        requestedTool: name,
        command: 'where.exe',
        args: [name],
        maxTimeoutMs: 2000,
        maxBuffer: 8192,
        encoding: 'utf8',
        shell: false,
        cwd: cwd.slice(0, 1024),
        cwdBytes: Buffer.byteLength(cwd),
        cwdSHA256: digest(Buffer.from(cwd)),
        cwdTruncated: cwd.length > 1024,
        inheritedPATH: {
            bytes: pathBytes.length,
            sha256: digest(pathBytes),
            prefixBase64: pathBytes.subarray(0, 4096).toString('base64'),
            truncated: pathBytes.length > 4096,
        },
        resolverIdentity: {
            available: false,
            reason: 'Basename spawnSync launch does not report the actual resolver process image.',
        },
    });
    // Start receipt persistence may consume time or deliver cancellation.
    const spawnStartedAt = admit();
    const timeoutMs = Math.min(2000, Math.floor(workDeadline - spawnStartedAt));
    assert(timeoutMs > 0, 'No prerequisite lookup execution budget: ' + name);
    let r;
    try {
        r = spawn('where.exe', [name], {
            windowsHide: true,
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 8192,
        });
    } catch (error) {
        r = { error, status: null, signal: null, stdout: '', stderr: '' };
    }
    const completedAt = clock();
    const state = Object.freeze({
        ordinal,
        requestedTool: name,
        attempted: true,
        pid: Number.isSafeInteger(r.pid) && r.pid > 0 ? r.pid : null,
        closed: Number.isInteger(r.status) && r.signal == null && !r.error,
        status: Number.isInteger(r.status) ? r.status : null,
        signal: r.signal ?? null,
        errorPresent: Boolean(r.error),
    });
    // Uncertainty must be latched before evidence persistence or further assertions.
    onProcessState(state);
    const streams = {};
    for (const stream of ['stdout', 'stderr']) {
        const full = Buffer.from(typeof r[stream] === 'string' ? r[stream] : '', 'utf8');
        const retained = full.subarray(0, 8192);
        streams[stream] = {
            bytes: full.length,
            sha256: digest(full),
            retainedBytes: retained.length,
            truncated: full.length > retained.length,
            decodedText: typeof r[stream] === 'string',
        };
        await emit('tool-lookup-output', {
            requestedTool: name,
            stream,
            encoding: 'UTF-8 re-encoding of spawnSync decoded text; not raw child bytes',
            base64: retained.toString('base64'),
        });
    }
    await emit('tool-lookup-result', {
        startedAt,
        spawnStartedAt,
        completedAt,
        workDeadline,
        clockDomain,
        timeoutMs,
        ...state,
        error: errorText(r.error),
        streams,
    });
    // Result and uncertainty are durable before fresh cancellation/deadline admission.
    admit();
    assert(state.closed && r.status === 0, 'Prerequisite lookup failed: ' + name);
    assert(
        Object.values(streams).every((s) => s.decodedText && !s.truncated),
        'Prerequisite lookup output incomplete: ' + name,
    );
    const selected = r.stdout.split(/\r?\n/).find((p) => absolute(p) && !/["\r\n]/.test(p));
    assert(selected, 'Prerequisite lookup returned no acceptable absolute path: ' + name);
    await emit('tool-lookup-selection', {
        requestedTool: name,
        selected: selected.slice(0, 1024),
        selectedBytes: Buffer.byteLength(selected),
        selectedSHA256: digest(Buffer.from(selected)),
        selectedTruncated: selected.length > 1024,
    });
    admit();
    const physical = realpath(selected);
    const selectedIdentity = identity(physical, { pe: true, check: admit });
    const identityJSON = JSON.stringify(selectedIdentity);
    await emit('tool-lookup-identity', {
        requestedTool: name,
        identity: Object.fromEntries(
            Object.entries(selectedIdentity).map(([key, value]) => [
                key,
                typeof value === 'string' ? value.slice(0, 1024) : value,
            ]),
        ),
        identityJSONBytes: Buffer.byteLength(identityJSON),
        identityJSONSHA256: digest(Buffer.from(identityJSON)),
        truncatedIdentityFields: Object.entries(selectedIdentity)
            .filter(([, value]) => typeof value === 'string' && value.length > 1024)
            .map(([key]) => key),
    });
    admit();
    return physical;
}
