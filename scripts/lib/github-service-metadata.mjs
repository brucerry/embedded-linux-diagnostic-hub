import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { sourceDigest } from './committed-source-bridge.mjs';
import {
    validateArchiveReadbackSelection,
    validateArchiveServiceObservation,
} from './archive-service-readback.mjs';
import {
    parseGitHubMetadataJSON,
    githubMetadataNumericLexeme,
    GITHUB_METADATA_BYTES,
} from './github-metadata-json.mjs';

export const GITHUB_SERVICE_PROFILE = Object.freeze({
    apiVersion: '2026-03-10',
    requestMs: 10000,
    jobPageSize: 100,
    maxJobPages: 10,
    observations: 2,
});
const activeJobs = new Map();
const decimal = /^[1-9][0-9]{0,31}$/;
const safeCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_STREAM_PREMATURE_CLOSE',
]);
const integer = (value) => {
    if (typeof value === 'number') {
        assert.ok(Number.isSafeInteger(value) && value > 0);
        return String(value);
    }
    const token = githubMetadataNumericLexeme(value);
    assert.equal(typeof token, 'string', 'Wire identity must be a numeric token.');
    assert.match(token, decimal);
    return token;
};
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
}
function safeIssue(code, error) {
    let detail = 'UNSPECIFIED';
    try {
        if (safeCodes.has(error?.code)) detail = error.code;
    } catch {}
    return { code, detail };
}
export class GitHubMetadataError extends Error {
    constructor(snapshot) {
        super('GitHub metadata operation failed; inspect bounded custody diagnostics.');
        Object.defineProperty(this, 'details', { get: () => snapshot() });
    }
}
function requestOperation(context, host, path, role, credential, clock) {
    const completed = deferred(),
        retired = deferred();
    const row = {
        id: ++context.next,
        role,
        path,
        request: null,
        response: null,
        sockets: new Map(),
        requestFinish: false,
        requestClose: false,
        responseEnd: false,
        responseClose: false,
        responseComplete: false,
        secureConnect: false,
        tlsAuthorized: false,
        status: null,
        bytes: 0,
        sha256: null,
        primary: null,
        cleanup: [],
        diagnosticOverflow: false,
        abortRequested: false,
        retired: false,
        timer: null,
        timerDone: false,
        unknownAcquisition: false,
        body: null,
        expectedLength: null,
        finalSnapshot: null,
        started: clock.now(),
    };
    context.pending.set(row.id, row); // Custody precedes constructor, dispatch and all awaits.
    const snapshot = () =>
        row.finalSnapshot
            ? structuredClone(row.finalSnapshot)
            : {
                  id: row.id,
                  role: row.role,
                  path: row.path,
                  origin: 'https://api.github.com',
                  method: 'GET',
                  apiVersion: GITHUB_SERVICE_PROFILE.apiVersion,
                  status: row.status,
                  bytes: row.bytes,
                  sha256: row.sha256,
                  requestFinish: row.requestFinish,
                  requestClose: row.requestClose,
                  responseEnd: row.responseEnd,
                  responseClose: row.responseClose,
                  responseComplete: row.responseComplete,
                  secureConnect: row.secureConnect,
                  tlsAuthorized: row.tlsAuthorized,
                  sockets: [...row.sockets.values()].map((v) => ({
                      closed: v.closed,
                      hadError: v.hadError,
                  })),
                  abortRequested: row.abortRequested,
                  unknownAcquisition: row.unknownAcquisition,
                  timerDone: row.timerDone,
                  retired: row.retired,
                  primary: row.primary,
                  cleanup: row.cleanup.slice(),
                  diagnosticOverflow: row.diagnosticOverflow,
                  elapsedMs: Math.max(0, clock.now() - row.started),
              };
    const error = () => new GitHubMetadataError(() => ({ request: snapshot() }));
    const issue = (code, cause, cleanup = false) => {
        const v = safeIssue(code, cause);
        if (!row.primary) row.primary = v;
        else if (row.cleanup.length < 16) row.cleanup.push(v);
        else row.diagnosticOverflow = true;
        completed.reject(error());
    };
    const abort = (code, cause) => {
        if (row.retired) return;
        if (code) issue(code, cause);
        if (row.abortRequested) return;
        row.abortRequested = true;
        try {
            if (row.request) row.request.destroy();
        } catch (error) {
            issue('CANCEL_REQUEST_THROW', error, true);
        }
    };
    const tryRetire = () => {
        if (
            row.retired ||
            row.unknownAcquisition ||
            !row.requestClose ||
            (row.response && !row.responseClose) ||
            [...row.sockets.values()].some((v) => !v.closed)
        )
            return;
        if (
            !row.primary &&
            (!row.requestFinish ||
                !row.responseEnd ||
                !row.responseComplete ||
                !row.tlsAuthorized ||
                !row.secureConnect)
        )
            issue('NORMAL_COMPLETION_UNPROVED');
        if (!row.timerDone) {
            try {
                clock.clear(row.timer);
                row.timerDone = true;
            } catch (error) {
                issue('TIMER_CLEAR_FAILED', error, true);
                return;
            }
        }
        row.retired = true;
        if (context.pending.get(row.id) === row) context.pending.delete(row.id);
        const record = snapshot();
        row.finalSnapshot = record;
        context.observed.push(record);
        row.request = null;
        row.response = null;
        row.sockets.clear();
        row.body = null;
        row.timer = null;
        retired.resolve(record);
    };
    row.cancel = () => abort('READER_CANCELLED');
    row.retirement = retired.promise;
    row.snapshot = snapshot;
    try {
        row.timer = clock.set(() => {
            row.timerDone = true;
            abort('REQUEST_DEADLINE');
            tryRetire();
        }, GITHUB_SERVICE_PROFILE.requestMs);
        const headers = {
            Accept: 'application/vnd.github+json',
            'Accept-Encoding': 'identity',
            'X-GitHub-Api-Version': GITHUB_SERVICE_PROFILE.apiVersion,
            'User-Agent': 'Diagnostic-Hub-metadata-readback',
            Connection: 'close',
        };
        if (credential !== null) headers['Authorization'] = 'Bearer ' + credential;
        row.request = host.request({
            protocol: 'https:',
            hostname: 'api.github.com',
            port: 443,
            servername: 'api.github.com',
            method: 'GET',
            path,
            agent: false,
            rejectUnauthorized: true,
            headers,
        });
        const request = row.request;
        request.on('socket', (socket) => {
            if (row.retired) return;
            if (row.sockets.has(socket)) {
                abort('DUPLICATE_SOCKET');
                return;
            }
            const state = { closed: false, hadError: null };
            row.sockets.set(socket, state);
            socket.on('secureConnect', () => {
                if (row.retired) return;
                row.secureConnect = true;
                row.tlsAuthorized = socket.encrypted === true && socket.authorized === true;
                if (!row.tlsAuthorized) abort('TLS_AUTHORIZATION_FAILED');
            });
            socket.on('error', (error) => {
                abort('SOCKET_ERROR', error);
            });
            socket.on('close', (hadError) => {
                if (row.retired) return;
                state.closed = true;
                state.hadError = hadError;
                if (hadError !== false) issue('SOCKET_CLOSE_ERROR');
                tryRetire();
            });
            if (row.sockets.size !== 1) abort('MULTIPLE_SOCKETS');
        });
        request.on('finish', () => {
            if (!row.retired) {
                row.requestFinish = true;
                tryRetire();
            }
        });
        request.on('error', (error) => {
            abort('REQUEST_ERROR', error);
        });
        request.on('close', () => {
            if (row.retired) return;
            row.requestClose = true;
            if (!row.response && !row.primary) issue('REQUEST_CLOSED_WITHOUT_RESPONSE');
            tryRetire();
        });
        request.on('response', (response) => {
            if (row.retired) return;
            if (row.response) {
                abort('MULTIPLE_RESPONSES');
                return;
            }
            row.response = response;
            row.status =
                Number.isInteger(response.statusCode) &&
                response.statusCode >= 100 &&
                response.statusCode <= 599
                    ? response.statusCode
                    : null;
            response.on('aborted', () => {
                abort('RESPONSE_ABORTED');
            });
            response.on('error', (error) => {
                abort('RESPONSE_ERROR', error);
            });
            response.on('close', () => {
                if (row.retired) return;
                row.responseClose = true;
                if (!row.responseEnd && !row.primary) abort('RESPONSE_PREMATURE_CLOSE');
                tryRetire();
            });
            response.on('end', () => {
                if (row.retired) return;
                row.responseEnd = true;
                row.responseComplete = response.complete === true;
                if (!row.responseComplete) {
                    abort('INCOMPLETE_HTTP_MESSAGE');
                    return;
                }
                if (row.expectedLength !== null && row.bytes !== row.expectedLength) {
                    abort('CONTENT_LENGTH_MISMATCH');
                    return;
                }
                if (!row.primary) {
                    const body = Buffer.from(row.body.subarray(0, row.bytes));
                    row.sha256 = sourceDigest(body);
                    completed.resolve(body);
                }
                tryRetire();
            });
            const type = response.headers?.['content-type'],
                encoding = response.headers?.['content-encoding'],
                length = response.headers?.['content-length'];
            if (row.status !== 200) {
                abort(
                    'HTTP_STATUS_' +
                        (Number.isInteger(row.status) && row.status >= 100 && row.status <= 599
                            ? row.status
                            : 'INVALID'),
                );
                return;
            }
            if (!row.secureConnect || !row.tlsAuthorized) {
                abort('TLS_AUTHORIZATION_UNPROVED');
                return;
            }
            if (
                typeof type !== 'string' ||
                type.split(';')[0].trim().toLowerCase() !== 'application/json' ||
                (encoding !== undefined && encoding !== 'identity')
            ) {
                abort('UNSUPPORTED_HTTP_REPRESENTATION');
                return;
            }
            if (
                length !== undefined &&
                (typeof length !== 'string' ||
                    !/^(0|[1-9][0-9]*)$/.test(length) ||
                    !Number.isSafeInteger(Number(length)) ||
                    Number(length) > GITHUB_METADATA_BYTES)
            ) {
                abort('CONTENT_LENGTH_BOUND');
                return;
            }
            if (
                response.headers?.['x-github-api-version-selected'] !==
                GITHUB_SERVICE_PROFILE.apiVersion
            ) {
                abort('API_VERSION_UNPROVED');
                return;
            }
            row.expectedLength = length === undefined ? null : Number(length);
            row.body = Buffer.alloc(GITHUB_METADATA_BYTES);
            response.on('data', (chunk) => {
                if (row.retired || row.primary) return;
                if (
                    !(chunk instanceof Uint8Array) ||
                    !chunk.byteLength ||
                    row.bytes + chunk.byteLength > GITHUB_METADATA_BYTES
                ) {
                    abort('BODY_BOUND');
                    return;
                }
                row.body.set(chunk, row.bytes);
                row.bytes += chunk.byteLength;
            });
        });
        request.end();
    } catch (error) {
        issue('REQUEST_ACQUISITION_OR_DISPATCH_FAILED', error);
        if (!row.request) {
            row.unknownAcquisition = true;
            try {
                clock.clear(row.timer);
                row.timerDone = true;
            } catch (error) {
                issue('TIMER_CLEAR_FAILED', error, true);
            }
        } else abort();
    }
    return {
        row,
        completed: completed.promise,
        retired: retired.promise,
        cancel: () => abort('READER_CANCELLED'),
        snapshot,
        error,
    };
}

function jobCheckRun(job, expected) {
    const value = new URL(job.check_run_url),
        prefix = `/repos/${expected.service.repository}/check-runs/`;
    assert.equal(value.origin, 'https://api.github.com');
    assert.ok(
        !value.username &&
            !value.password &&
            !value.search &&
            !value.hash &&
            value.pathname.startsWith(prefix),
    );
    const checkRunId = value.pathname.slice(prefix.length);
    assert.match(checkRunId, decimal);
    return checkRunId;
}
function projectScoped(run, job, artifact, selected) {
    const expected = validateArchiveReadbackSelection(selected),
        repo = expected.service.repositoryId;
    assert.equal(run.repository.full_name, expected.service.repository);
    assert.equal(run.head_repository.full_name, expected.service.repository);
    for (const value of [
        run.repository.id,
        run.head_repository.id,
        artifact.workflow_run.repository_id,
        artifact.workflow_run.head_repository_id,
    ])
        assert.equal(integer(value), repo);
    if (job.run_attempt !== undefined)
        assert.equal(integer(job.run_attempt), expected.context.runAttempt);
    // Attempt comes from the successful attempt-scoped jobs request and observed membership,
    // not a fabricated raw REST job field or a producer's supplied attempt label.
    return validateArchiveServiceObservation(
        {
            apiOrigin: 'https://api.github.com',
            repository: expected.service.repository,
            repositoryId: repo,
            run: {
                id: integer(run.id),
                attempt: integer(run.run_attempt),
                headSHA: run.head_sha,
                workflowId: integer(run.workflow_id),
                workflowPath: run.path,
                status: run.status,
                conclusion: run.conclusion,
            },
            job: {
                id: integer(job.id),
                runId: integer(job.run_id),
                runAttempt: expected.context.runAttempt,
                headSHA: job.head_sha,
                name: job.name,
                status: job.status,
                conclusion: job.conclusion,
            },
            artifact: {
                id: integer(artifact.id),
                name: artifact.name,
                runId: integer(artifact.workflow_run.id),
                headSHA: artifact.workflow_run.head_sha,
                sizeInBytes: artifact.size_in_bytes,
                digest: artifact.digest,
                expired: artifact.expired,
            },
        },
        expected,
    );
}
function makeTransport(selection, credential, host, clock, mode) {
    const selected = validateArchiveReadbackSelection(selection);
    assert.ok(
        credential === null ||
            (typeof credential === 'string' &&
                credential.length > 0 &&
                credential.length <= 8192 &&
                /^[\x21-\x7e]+$/.test(credential)),
        'Unsupported credential.',
    );
    let observations = 0,
        current = null;
    const completedObservations = [];
    const snapshot = () => ({
        mode,
        observations,
        active: current
            ? {
                  owner: current.token,
                  closing: current.closing,
                  pending: [...current.pending.values()].map((row) => row.snapshot()),
              }
            : null,
        completed: structuredClone(completedObservations),
        last: completedObservations.length ? structuredClone(completedObservations.at(-1)) : null,
        qualification: false,
        artifactUploadAttribution: null,
    });
    const openService = async (request) => {
        assert.ok(request && Object.keys(request).sort().join(',') === 'id,kind,owner,resource');
        assert.match(request.owner, /^[a-f0-9]{32}$/);
        assert.ok(Number.isSafeInteger(request.id) && request.id > 0);
        assert.equal(request.kind, 'service');
        assert.equal(request.resource, 'selected-service-observation');
        assert.ok(
            !current && !activeJobs.has(selected.reader.jobId),
            'Metadata reader custody remains active.',
        );
        assert.ok(
            observations < GITHUB_SERVICE_PROFILE.observations,
            'Metadata observation profile exhausted.',
        );
        observations++;
        const context = {
            token: randomBytes(16).toString('hex'),
            pending: new Map(),
            observed: [],
            next: 0,
            closing: false,
            closed: false,
            started: false,
            job: null,
            buffer: null,
            at: 0,
            failure: null,
            membership: null,
            closeTask: null,
        };
        current = context;
        activeJobs.set(selected.reader.jobId, context);
        const root = `/repos/${selected.service.repository}/actions`,
            jobsRoot = `${root}/runs/${selected.context.runId}/attempts/${selected.context.runAttempt}/jobs`;
        const fetch = async (path, role) => {
            if (context.closing)
                throw new GitHubMetadataError(() => ({ code: 'READER_CANCELLED' }));
            const operation = requestOperation(context, host, path, role, credential, clock);
            const bytes = await operation.completed;
            await operation.retired;
            if (operation.row.primary) throw operation.error();
            return { value: parseGitHubMetadataJSON(bytes), witness: context.observed.at(-1) };
        };
        const collect = async () => {
            const run = (
                await fetch(
                    `${root}/runs/${selected.context.runId}/attempts/${selected.context.runAttempt}`,
                    'run-attempt',
                )
            ).value;
            let job = null,
                total = null;
            const seen = new Set();
            for (let page = 1; page <= GITHUB_SERVICE_PROFILE.maxJobPages; page++) {
                const result = await fetch(
                        `${jobsRoot}?per_page=100&page=${page}`,
                        'attempt-jobs:' + page,
                    ),
                    body = result.value;
                assert.ok(
                    Number.isSafeInteger(body.total_count) &&
                        body.total_count >= 0 &&
                        Array.isArray(body.jobs) &&
                        body.jobs.length <= 100,
                );
                if (total === null) total = body.total_count;
                else assert.equal(body.total_count, total, 'Attempt job listing changed.');
                for (const candidate of body.jobs) {
                    const candidateId = integer(candidate.id);
                    assert.ok(!seen.has(candidateId), 'Duplicate job identity.');
                    seen.add(candidateId);
                    assert.equal(integer(candidate.run_id), selected.context.runId);
                    assert.equal(candidate.head_sha, selected.context.sourceCommit);
                    if (candidateId === selected.service.jobId) {
                        assert.equal(job, null);
                        job = candidate;
                    }
                }
                if (job) {
                    context.membership = {
                        runId: selected.context.runId,
                        runAttempt: selected.context.runAttempt,
                        jobId: integer(job.id),
                        checkRunId: jobCheckRun(job, selected),
                        page,
                        requestId: result.witness.id,
                        requestPath: result.witness.path,
                        responseSHA256: result.witness.sha256,
                    };
                    break;
                }
                if (page * 100 >= total) break;
            }
            if (!job) throw new GitHubMetadataError(() => ({ code: 'JOB_MEMBERSHIP_UNPROVED' }));
            const artifact = (
                await fetch(`${root}/artifacts/${selected.service.artifactId}`, 'artifact-metadata')
            ).value;
            const normalized = projectScoped(run, job, artifact, selected);
            context.buffer = Buffer.from(JSON.stringify(normalized) + '\n');
        };
        const handle = {
            ...request,
            async read(maximum) {
                assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 65536);
                assert.ok(!context.closing && !context.closed, 'Metadata handle is closed.');
                if (!context.started) {
                    context.started = true;
                    context.job = collect().catch((error) => {
                        context.failure =
                            error instanceof GitHubMetadataError
                                ? error
                                : new GitHubMetadataError(() => ({
                                      code: 'METADATA_VALIDATION_FAILED',
                                  }));
                        throw context.failure;
                    });
                    context.job.catch(() => {});
                }
                await context.job;
                if (context.closing)
                    throw new GitHubMetadataError(() => ({ code: 'READER_CANCELLED' }));
                if (context.at === context.buffer.length) return null;
                const result = Buffer.from(
                    context.buffer.subarray(context.at, context.at + maximum),
                );
                context.at += result.length;
                return result;
            },
            close() {
                if (context.closeTask) return context.closeTask;
                context.closing = true;
                context.closeTask = (async () => {
                    for (const row of context.pending.values()) row.cancel();
                    // No dispatcher may start another request after closing; actual closure is joined.
                    await Promise.all([...context.pending.values()].map((row) => row.retirement));
                    if (context.job) await context.job.catch(() => {});
                    assert.equal(context.pending.size, 0);
                    context.closed = true;
                    const receipt = {
                        mode,
                        requests: context.observed.map((value) => structuredClone(value)),
                        jobMembership: context.membership,
                        normalizedSHA256: context.buffer ? sourceDigest(context.buffer) : null,
                        status: context.failure
                            ? 'failed-observation'
                            : context.started
                              ? 'closed-observation'
                              : 'closed-unused',
                        qualification: false,
                        artifactUploadAttribution: null,
                    };
                    completedObservations.push(receipt);
                    context.buffer = null;
                    if (current === context) current = null;
                    if (activeJobs.get(selected.reader.jobId) === context)
                        activeJobs.delete(selected.reader.jobId);
                })();
                return context.closeTask;
            },
        };
        return handle;
    };
    return Object.freeze({ openService, snapshot });
}
/** Pure preflight; never changes TLS settings or reads a credential. */
export function validateGitHubMetadataEnvironment(value) {
    assert.ok(value && Object.keys(value).sort().join(',') === 'nodeOptions,nodePath,tls');
    assert.ok(value.tls === undefined || value.tls === '1', 'Unsupported TLS environment.');
    assert.ok(
        value.nodeOptions === undefined && value.nodePath === undefined,
        'Unsupported ambient runtime injection.',
    );
    return true;
}
/** Inert until handle.read(). No artifact downloads, redirects, retries, installations or credential discovery.
 * @param {any} selection
 * @param {string|null} credential
 */
export function createGitHubServiceMetadata(selection, credential = null) {
    validateGitHubMetadataEnvironment({
        tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
        nodeOptions: process.env.NODE_OPTIONS,
        nodePath: process.env.NODE_PATH,
    });
    return makeTransport(
        selection,
        credential,
        { request: httpsRequest },
        {
            now: () => performance.now(),
            set: (fn, ms) => setTimeout(fn, ms),
            clear: (timer) => clearTimeout(timer),
        },
        'node-https-unqualified',
    );
}
/** Explicit fake-host boundary. It can never label its observations as real service evidence. */
export function createGitHubServiceMetadataModel(selection, credential, host, clock) {
    assert.ok(
        host &&
            typeof host.request === 'function' &&
            clock &&
            typeof clock.now === 'function' &&
            typeof clock.set === 'function' &&
            typeof clock.clear === 'function',
    );
    return makeTransport(selection, credential, host, clock, 'injected-model-unqualified');
}
