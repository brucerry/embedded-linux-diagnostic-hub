import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';

import {
    selectQueryRuntime,
    requireQueryRuntimeSelection,
    queryRuntimePaths,
    requireSelectedQueryVersion,
} from './security-query-runtime-selection.mjs';

// Core-only and inert on import: entry starts its clock before calling any preflight.
export const queryJobLimits = Object.freeze({
    outerMs: 900000,
    ownerMs: 600000,
    retentionPostMs: 120000,
    metadataMs: 10000,
    metadataBytes: 65536,
    clockSlackMs: 2000,
});
const admissions = new WeakSet();
const runtimeAdmissions = new WeakSet();
const tick = () => Number(process.hrtime.bigint() / 1000000n);
function sameWindowsPath(a, b) {
    return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}
/** No PATH lookup, download, extraction, package command or fallback. */
export function requirePreinstalledQueryRuntime(
    environment = process.env,
    {
        platform = process.platform,
        arch = process.arch,
        version = process.version,
        execPath = process.execPath,
        io = fs,
    } = {},
) {
    const selection = selectQueryRuntime(environment);
    requireSelectedQueryVersion(selection, version, platform, arch);
    const cache = environment.RUNNER_TOOL_CACHE;
    const { executable: expected, completeMarker: marker } = queryRuntimePaths(selection, cache);
    assert(sameWindowsPath(execPath, expected), 'Runtime must be the exact tool-cache executable');
    for (let p = path.win32.dirname(expected); ; p = path.win32.dirname(p)) {
        const s = io.lstatSync(p);
        assert(s.isDirectory() && !s.isSymbolicLink(), 'Runtime cache ancestry');
        assert(sameWindowsPath(io.realpathSync(p), p), 'Runtime cache alias');
        if (path.win32.dirname(p) === p) break;
    }
    const node = io.lstatSync(expected),
        complete = io.lstatSync(marker);
    assert(node.isFile() && !node.isSymbolicLink() && node.nlink === 1);
    assert(
        complete.isFile() &&
            !complete.isSymbolicLink() &&
            complete.nlink === 1 &&
            complete.size === 0,
        'Completed preinstalled cache entry required',
    );
    assert(sameWindowsPath(io.realpathSync(expected), expected));
    assert(sameWindowsPath(io.realpathSync(marker), marker));
    const admission = Object.freeze({
        kind: 'exact-preinstalled-query-runtime',
        selection,
        toolCache: cache,
        version,
        platform,
        arch,
        executable: expected,
        completeMarker: marker,
        installation: false,
        fallback: false,
    });
    runtimeAdmissions.add(admission);
    return admission;
}
/** Revalidate the parent's durable bound selection without forwarding image metadata to a leaf.
 * The caller must first verify the existing binding-file proof. No environment changes or launch. */
export function requireBoundQueryRuntime(binding, options = {}) {
    const selection = requireQueryRuntimeSelection(binding?.selection);
    const keys = [
        'kind',
        'selection',
        'toolCache',
        'version',
        'platform',
        'arch',
        'executable',
        'completeMarker',
        'installation',
        'fallback',
    ];
    assert(
        binding &&
            Reflect.ownKeys(binding).length === keys.length &&
            keys.every((key) => Object.hasOwn(binding, key)),
        'Exact bound runtime fields required',
    );
    assert(
        binding.kind === 'exact-preinstalled-query-runtime' &&
            binding.installation === false &&
            binding.fallback === false,
        'Exact bound runtime required',
    );
    requireSelectedQueryVersion(selection, binding.version, binding.platform, binding.arch);
    const paths = queryRuntimePaths(selection, binding.toolCache);
    assert(
        binding.executable === paths.executable && binding.completeMarker === paths.completeMarker,
        'Bound runtime paths required',
    );
    // This validates the current process, not merely the strings recorded by its parent.
    const admission = requirePreinstalledQueryRuntime(
        {
            ImageOS: selection.imageOS,
            ImageVersion: selection.imageVersion,
            RUNNER_OS: 'Windows',
            RUNNER_ARCH: 'X64',
            RUNNER_TOOL_CACHE: binding.toolCache,
        },
        options,
    );
    assert(
        admission.version === binding.version &&
            admission.executable === binding.executable &&
            admission.completeMarker === binding.completeMarker,
        'Parent and leaf runtime binding required',
    );
    return admission;
}
/** Runtime-only receipt, after successful launch and all fixed-runtime checks.
 * No file writes, helpers, provider imports or job/query/closure admission. */
export function queryRuntimeAdmissionReceipt(admission) {
    assert(runtimeAdmissions.has(admission), 'Validated runtime admission required');
    const line =
        JSON.stringify({
            kind: 'query-runtime-admitted',
            selection: admission.selection,
            version: admission.version,
            platform: admission.platform,
            arch: admission.arch,
            executable: admission.executable,
            completeMarker: admission.completeMarker,
            checks: 'Exact version/architecture/executable; nonaliased ancestry; regular single-link executable and empty complete marker',
            jobAdmitted: false,
            queryAdmitted: false,
            closureAttested: false,
        }) + '\n';
    assert(Buffer.byteLength(line) <= 4096, 'Runtime receipt bound');
    return line;
}
function hostBinding(env) {
    for (const [k, v] of Object.entries({
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_API_URL: 'https://api.github.com',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'windows-security-query-only',
    }))
        assert.equal(env[k], v, 'Query job metadata binding ' + k);
    assert(/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID));
    assert(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA));
    assert.equal(env.GITHUB_REF, 'refs/heads/validation/windows-metadata-3577982-20261018');
    assert(
        typeof env.RUNNER_NAME === 'string' &&
            env.RUNNER_NAME.length > 0 &&
            env.RUNNER_NAME.length <= 128,
    );
    return {
        run: env.GITHUB_RUN_ID,
        attempt: '1',
        commit: env.GITHUB_SHA,
        ref: env.GITHUB_REF,
        runnerName: env.RUNNER_NAME,
        jobKey: env.GITHUB_JOB,
    };
}
const iso = (text) => {
    assert(
        typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text),
        'Exact job start time required',
    );
    const n = Date.parse(text);
    assert(Number.isSafeInteger(n) && new Date(n).toISOString().replace('.000', '') === text);
    return n;
};
/** One HTTPS GET, total deadline/body cap, no redirects/retry/credentials/installer. */
export function fetchQueryJobMetadata(
    url,
    {
        timeoutMs = queryJobLimits.metadataMs,
        maximum = queryJobLimits.metadataBytes,
        request = https.request,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = {},
) {
    assert(
        /^https:\/\/api\.github\.com\/repos\/brucerry\/embedded-linux-diagnostic-hub\/actions\/runs\/[1-9]\d{0,19}\/attempts\/1\/jobs\?per_page=100$/.test(
            url,
        ),
    );
    assert.equal(timeoutMs, queryJobLimits.metadataMs);
    assert.equal(maximum, queryJobLimits.metadataBytes);
    return new Promise((resolve, reject) => {
        let settled = false,
            req,
            timer;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimer(timer);
            if (error) reject(error);
            else resolve(value);
        };
        try {
            req = request(
                url,
                {
                    method: 'GET',
                    agent: false,
                    rejectUnauthorized: true,
                    headers: {
                        Accept: 'application/vnd.github+json',
                        'Accept-Encoding': 'identity',
                        'X-GitHub-Api-Version': '2022-11-28',
                        'User-Agent': 'diagnostic-hub-query-job-admission',
                        'Cache-Control': 'no-cache, max-age=0',
                        Pragma: 'no-cache',
                        Connection: 'close',
                    },
                },
                (res) => {
                    let count = 0;
                    const chunks = [];
                    const socket = res.socket;
                    if (!socket) {
                        req.destroy();
                        finish(Error('Job metadata socket unknown'));
                        return;
                    }
                    let ended = false,
                        closed = false;
                    const completed = () => {
                        if (ended && closed)
                            finish(null, {
                                status: res.statusCode,
                                headers: res.headers,
                                body: Buffer.concat(chunks),
                                transport: { responseComplete: true, socketClosed: true },
                            });
                    };
                    socket.once('close', (hadError) => {
                        if (hadError) {
                            finish(Error('Job metadata socket close failed'));
                            return;
                        }
                        closed = true;
                        completed();
                    });
                    res.on('error', (error) => finish(error));
                    res.on('aborted', () => finish(Error('Job metadata response aborted')));
                    res.on('data', (chunk) => {
                        if (settled) return;
                        const b = Buffer.from(chunk);
                        count += b.length;
                        if (count > maximum) {
                            res.destroy();
                            req.destroy();
                            finish(Error('Job metadata response bound'));
                            return;
                        }
                        chunks.push(b);
                    });
                    res.on('end', () => {
                        if (res.complete !== true) {
                            finish(Error('Job metadata response incomplete'));
                            return;
                        }
                        ended = true;
                        completed();
                    });
                },
            );
            req.on('error', (error) => finish(error));
            timer = setTimer(() => {
                req.destroy();
                finish(Error('Job metadata total deadline'));
            }, timeoutMs);
            req.end();
        } catch (error) {
            finish(error);
        }
    });
}
/** Date and started_at share GitHub's UTC domain. Monotonic RTT bounds delivery;
 * local UTC is only a freshness/jump check. Trust assumption: GitHub honors the
 * no-cache request; Age/HIT/stale/future/unknown clock replies are refused. */
export function validateQueryJobTime({
    environment,
    ownerStartedAt,
    requestStartedAt,
    responseObservedAt,
    wallStartedAt,
    wallObservedAt,
    response,
}) {
    const binding = hostBinding(environment),
        l = queryJobLimits;
    for (const n of [
        ownerStartedAt,
        requestStartedAt,
        responseObservedAt,
        wallStartedAt,
        wallObservedAt,
    ])
        assert(Number.isSafeInteger(n) && n >= 0, 'Job clock observation');
    assert(ownerStartedAt <= requestStartedAt && requestStartedAt <= responseObservedAt);
    const rtt = responseObservedAt - requestStartedAt;
    assert(rtt < l.metadataMs, 'Job metadata admission deadline');
    assert(
        wallObservedAt >= wallStartedAt &&
            Math.abs(wallObservedAt - wallStartedAt - rtt) <= l.clockSlackMs,
        'Local clock changed during job metadata read',
    );
    assert(
        response.transport?.responseComplete === true && response.transport?.socketClosed === true,
        'Complete job metadata and observed socket closure required',
    );
    assert.equal(response.status, 200, 'Fresh successful GitHub job metadata required');
    const headers = response.headers;
    assert(headers && typeof headers.date === 'string');
    assert(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(headers.date));
    const server = Date.parse(headers.date);
    assert(
        Number.isSafeInteger(server) && new Date(server).toUTCString() === headers.date,
        'Trusted GitHub Date header',
    );
    assert(headers.age === undefined || headers.age === '0', 'Cached job time refused');
    for (const key of ['x-cache', 'cf-cache-status'])
        assert(
            headers[key] === undefined || !/HIT|STALE|UPDATING/i.test(String(headers[key])),
            'Cached job time refused',
        );
    assert(headers['content-encoding'] === undefined || headers['content-encoding'] === 'identity');
    assert(
        typeof headers['x-github-request-id'] === 'string' &&
            /^[A-Za-z0-9:.-]{1,128}$/.test(headers['x-github-request-id']),
        'GitHub response identity',
    );
    assert(
        wallObservedAt >= server - l.clockSlackMs &&
            wallObservedAt <= server + 1000 + rtt + l.clockSlackMs,
        'Stale/future job metadata time',
    );
    const raw = Buffer.from(response.body);
    assert(raw.length > 0 && raw.length <= l.metadataBytes);
    const value = JSON.parse(raw.toString('utf8'));
    assert(
        Array.isArray(value.jobs) &&
            value.total_count === value.jobs.length &&
            value.jobs.length > 0 &&
            value.jobs.length <= 8,
        'Complete bounded current-attempt job list',
    );
    const selected = value.jobs.filter(
        (j) => j.name === 'One Windows security metadata query (nonqualifying)',
    );
    assert.equal(selected.length, 1);
    const job = selected[0];
    for (const j of value.jobs) {
        assert(
            Number.isSafeInteger(j.run_id) &&
                String(j.run_id) === binding.run &&
                (j.run_attempt === undefined || j.run_attempt === 1) &&
                j.head_sha === binding.commit &&
                j.head_branch === binding.ref.slice('refs/heads/'.length),
            'Job/run/attempt/head binding',
        );
        assert.equal(j.workflow_name, 'Verify and build Windows application');
        if (j !== job)
            assert(
                j.status === 'completed' && j.conclusion === 'skipped',
                'Unexpected additional eligible job',
            );
    }
    assert(
        Number.isSafeInteger(job.id) &&
            job.id > 0 &&
            Number.isSafeInteger(job.runner_id) &&
            job.runner_id > 0,
    );
    assert.equal(job.status, 'in_progress');
    assert.equal(job.conclusion, null);
    assert.equal(job.completed_at, null);
    assert.equal(job.runner_name, binding.runnerName);
    assert.equal(
        job.run_url,
        'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/actions/runs/' +
            binding.run,
    );
    const jobStartedAt = iso(job.started_at);
    assert(jobStartedAt <= server + 1000, 'Future job start');
    const serverUpperAtReceipt = server + 1000 + rtt + l.clockSlackMs;
    const remaining = l.outerMs - (serverUpperAtReceipt - jobStartedAt);
    assert(
        remaining > l.ownerMs + l.retentionPostMs,
        'Insufficient outer job time for owner plus retention/post reserve',
    );
    const admission = Object.freeze({
        kind: 'query-only-outer-job-admission',
        binding: Object.freeze({ ...binding, jobId: job.id, runnerId: job.runner_id }),
        ownerStartedAt,
        ownerDeadline: ownerStartedAt + l.ownerMs,
        requestStartedAt,
        responseObservedAt,
        roundTripMs: rtt,
        jobStartedAtUTC: job.started_at,
        serverDate: headers.date,
        githubRequestId: headers['x-github-request-id'],
        serverUpperAtReceipt,
        remainingOuterMs: remaining,
        outerDeadline: responseObservedAt + remaining,
        retentionPostMs: l.retentionPostMs,
        metadataBytes: raw.length,
        metadataSHA256: createHash('sha256').update(raw).digest('hex'),
        noCacheRequested: true,
        trust: 'GitHub HTTPS Date/start time and no-cache semantics; local UTC freshness guard; no common monotonic origin assumed',
    });
    admissions.add(admission);
    return { admission, raw };
}
export async function admitQueryJobTime(
    environment,
    { ownerStartedAt, now = tick, wall = Date.now, fetch = fetchQueryJobMetadata } = {},
) {
    const binding = hostBinding(environment);
    const requestStartedAt = now(),
        wallStartedAt = wall();
    const url =
        'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/actions/runs/' +
        binding.run +
        '/attempts/1/jobs?per_page=100';
    const response = await fetch(url);
    return validateQueryJobTime({
        environment,
        ownerStartedAt,
        requestStartedAt,
        responseObservedAt: now(),
        wallStartedAt,
        wallObservedAt: wall(),
        response,
    });
}
export function requireQueryJobAdmission(
    admission,
    environment,
    { ownerStartedAt, now = tick } = {},
) {
    assert(admissions.has(admission), 'Foreign/unknown outer-job admission');
    assert.equal(admission.ownerStartedAt, ownerStartedAt);
    const b = hostBinding(environment);
    for (const key of Object.keys(b))
        assert.equal(admission.binding[key], b[key], 'Outer job admission rebound');
    const current = now();
    assert(current < admission.ownerDeadline, 'Original owner deadline exhausted');
    assert(
        Number.isSafeInteger(current) && current >= admission.responseObservedAt,
        'Outer job monotonic clock',
    );
    assert(
        admission.ownerDeadline + admission.retentionPostMs < admission.outerDeadline,
        'Original owner and retention reserve',
    );
    assert(
        current < admission.outerDeadline - admission.retentionPostMs,
        'Outer job retention reserve exhausted',
    );
}
