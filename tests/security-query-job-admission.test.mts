// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
    requirePreinstalledQueryRuntime,
    queryRuntimeVersion,
    queryJobLimits,
    validateQueryJobTime,
    requireQueryJobAdmission,
    admitQueryJobTime,
    fetchQueryJobMetadata,
} from '../scripts/lib/security-query-job-admission.mjs';
import { queryOwner } from '../scripts/lib/security-query-diagnostic-runtime.mjs';
import {
    queryPolicy,
    querySourceRoot,
    oldQueryInputs,
} from '../scripts/lib/security-query-diagnostic.mjs';
import { fixtureJobEnvironment } from './fixtures/security-query-job-admission.mjs';
const require = createRequire(import.meta.url),
    { load } = require('js-yaml');
const current = fs.readFileSync(
    path.join(querySourceRoot, '.github/workflows/windows-portable.yml'),
    'utf8',
);
const accepted61NonQueryPrefixSHA256 =
    '50d6d49782be5a408d33e3065ce84f1a6eb55df8d04e05b740e57078447df657';
test('B1 only query-job body changes; two immutable reviewed Actions, no setup-node/install/fallback', () => {
    assert.equal(
        createHash('sha256')
            .update(current.split('    windows-security-query-only:')[0])
            .digest('hex'),
        accepted61NonQueryPrefixSHA256,
        'All non-query workflow bytes must match independently accepted61',
    );
    const flow = load(current),
        job = flow.jobs['windows-security-query-only'];
    assert.equal(Object.keys(flow.jobs).length, 8);
    assert.equal(job.steps.length, 3);
    assert.deepEqual(
        job.steps.filter((s) => s.uses).map((s) => s.uses),
        [
            'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
            'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
        ],
    );
    assert.equal(job.steps[0].with['persist-credentials'], false);
    assert.equal(job['timeout-minutes'], 15);
    assert.deepEqual(job.permissions, { contents: 'read' });
    assert.equal(job.steps[1].shell, 'cmd');
    assert.match(
        job.steps[1].run.trim().split(/\r?\n/).at(-1),
        /^"%RUNNER_TOOL_CACHE%\\node\\24\.22\.0\\x64\\node\.exe" --experimental-transform-types scripts\/windows-security-query-diagnostic\.mjs$/,
    );
    assert.doesNotMatch(
        job.steps.map((s) => s.run ?? s.uses).join('\n'),
        /setup-node|npm|npx|yarn|curl|Invoke-WebRequest|extract|install|fallback/i,
    );
    assert.equal(job.steps[2].if, 'always()');
    assert.equal(job.steps[2].with['retention-days'], 14);
    assert.equal(queryJobLimits.outerMs, queryPolicy.jobMinutes * 60000);
    assert.equal(queryJobLimits.ownerMs, queryPolicy.ownerMs);
    assert.equal(queryPolicy.cleanupMs, 60000);
    assert.equal(queryPolicy.queryMs, 10000);
    assert.equal(queryPolicy.powershellProcesses, 45);
    assert.equal(queryPolicy.nodeProcesses, 2);
});
function runtime(fault) {
    const cache = 'C:\\hostedtoolcache\\windows',
        file = cache + '\\node\\24.22.0\\x64\\node.exe',
        marker = cache + '\\node\\24.22.0\\x64.complete';
    const io = {
        lstatSync(p) {
            if (
                (fault === 'missing-node' && p === file) ||
                (fault === 'missing-marker' && p === marker)
            )
                throw Error('ENOENT');
            const isFile = p === file || p === marker;
            return {
                isFile: () => isFile,
                isDirectory: () => !isFile,
                isSymbolicLink: () => fault === 'alias' && p.endsWith('x64'),
                nlink: fault === 'hardlink' && p === file ? 2 : 1,
                size: p === marker ? (fault === 'incomplete-marker' ? 1 : 0) : 100,
            };
        },
        realpathSync: (p) => (fault === 'rebound' ? p + '-other' : p),
    };
    return {
        env: { RUNNER_TOOL_CACHE: cache },
        opts: { platform: 'win32', arch: 'x64', version: queryRuntimeVersion, execPath: file, io },
    };
}
test('B2 exact completed preinstalled cache runtime admits with no tool/version child', () => {
    const { env, opts } = runtime();
    const r = requirePreinstalledQueryRuntime(env, opts);
    assert.equal(r.version, 'v24.22.0');
    assert.equal(r.installation, false);
    assert.equal(r.fallback, false);
});
for (const fault of [
    'missing-node',
    'missing-marker',
    'incomplete-marker',
    'alias',
    'rebound',
    'hardlink',
    'version',
    'architecture',
    'platform',
    'path',
    'cache',
])
    test('B2 runtime ' + fault + ' refuses without alternate runtime/installation', () => {
        const { env, opts } = runtime(fault);
        if (fault === 'version') opts.version = 'v24.22.1';
        if (fault === 'architecture') opts.arch = 'arm64';
        if (fault === 'platform') opts.platform = 'darwin';
        if (fault === 'path') opts.execPath = 'C:\\other\\node.exe';
        if (fault === 'cache') delete env.RUNNER_TOOL_CACHE;
        assert.throws(() => requirePreinstalledQueryRuntime(env, opts));
    });
const date = 'Tue, 20 Oct 2026 12:00:00 GMT',
    server = Date.parse(date);
function timing({ elapsed = 10000, rtt = 100 } = {}) {
    const env = {
        ...fixtureJobEnvironment,
        GITHUB_RUN_ID: '123456',
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_REF: 'refs/heads/validation/windows-metadata-3577982-20261018',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
    };
    const job = {
        id: 123,
        run_id: 123456,
        run_attempt: 1,
        head_sha: env.GITHUB_SHA,
        head_branch: env.GITHUB_REF.slice('refs/heads/'.length),
        workflow_name: 'Verify and build Windows application',
        name: 'One Windows security metadata query (nonqualifying)',
        runner_id: 456,
        runner_name: env.RUNNER_NAME,
        status: 'in_progress',
        conclusion: null,
        completed_at: null,
        run_url:
            'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/actions/runs/123456',
        started_at: new Date(server - elapsed).toISOString().replace('.000', ''),
    };
    const body = { total_count: 1, jobs: [job] },
        response = {
            transport: { responseComplete: true, socketClosed: true },
            status: 200,
            headers: { date, 'x-github-request-id': 'trusted-fixture' },
            body: Buffer.from(JSON.stringify(body)),
        };
    return {
        env,
        job,
        body,
        response,
        value: {
            environment: env,
            ownerStartedAt: 10000,
            requestStartedAt: 10010,
            responseObservedAt: 10010 + rtt,
            wallStartedAt: server + 500 - rtt,
            wallObservedAt: server + 500,
            response,
        },
    };
}
function replaceBody(c) {
    c.response.body = Buffer.from(JSON.stringify(c.body));
}
test('B3 causal API/RTT map leaves original600s owner plus explicit120s retention/post reserve', () => {
    const c = timing(),
        { admission, raw } = validateQueryJobTime(c.value);
    assert.equal(raw.length, c.response.body.length);
    assert.equal(admission.retentionPostMs, 120000);
    assert.equal(admission.ownerDeadline, 610000);
    assert(admission.remainingOuterMs > 720000);
    assert.equal(admission.outerDeadline, c.value.responseObservedAt + admission.remainingOuterMs);
    assert.doesNotThrow(() =>
        requireQueryJobAdmission(admission, c.env, { ownerStartedAt: 10000, now: () => 10110 }),
    );
    assert.throws(
        () =>
            requireQueryJobAdmission(admission, c.env, {
                ownerStartedAt: 10000,
                now: () => admission.ownerDeadline,
            }),
        /Original owner deadline/,
    );
    assert.throws(() =>
        requireQueryJobAdmission({ ...admission }, c.env, {
            ownerStartedAt: 10000,
            now: () => 10110,
        }),
    );
    assert.throws(() =>
        requireQueryJobAdmission(
            admission,
            { ...c.env, GITHUB_SHA: 'b'.repeat(40) },
            { ownerStartedAt: 10000, now: () => 10110 },
        ),
    );
    assert.throws(() =>
        requireQueryJobAdmission(admission, c.env, {
            ownerStartedAt: 10000,
            now: () => admission.outerDeadline - admission.retentionPostMs,
        }),
    );
});
for (const elapsed of [177000, 180000, 300000, 899000, 900000])
    test('B3 late/exact-boundary job ' + elapsed + ' refuses before owner effects', () => {
        const c = timing({ elapsed, rtt: 0 });
        assert.throws(() => validateQueryJobTime(c.value), /Insufficient outer/);
    });
test('B3 just enough remains conservatively admissible; no clock or reserve is extended', () => {
    const c = timing({ elapsed: 176000, rtt: 0 }),
        { admission } = validateQueryJobTime(c.value);
    assert.equal(admission.remainingOuterMs, 721000);
    assert.equal(admission.ownerDeadline, 610000);
    assert.equal(queryJobLimits.outerMs, 900000);
});
for (const fault of [
    'missing-date',
    'bad-date',
    'stale-date',
    'future-date',
    'age',
    'cache-hit',
    'clock-backward',
    'clock-jump',
    'rtt',
    'unknown-start',
    'future-start',
    'wrong-run',
    'attempt2',
    'wrong-commit',
    'wrong-branch',
    'wrong-runner',
    'no-runner-id',
    'wrong-workflow',
    'wrong-url',
    'wrong-job',
    'duplicate-job',
    'other-eligible',
    'pagination',
    'truncated-body',
    'overflow',
    'status429',
    'redirect',
    'encoding',
    'missing-request-id',
])
    test('B3 unknown or mismatched ' + fault + ' is fail-closed', () => {
        const c = timing();
        switch (fault) {
            case 'missing-date':
                delete c.response.headers.date;
                break;
            case 'bad-date':
                c.response.headers.date = 'garbage';
                break;
            case 'stale-date':
                c.response.headers.date = new Date(server - 60000).toUTCString();
                break;
            case 'future-date':
                c.response.headers.date = new Date(server + 60000).toUTCString();
                break;
            case 'age':
                c.response.headers.age = '1';
                break;
            case 'cache-hit':
                c.response.headers['x-cache'] = 'HIT';
                break;
            case 'clock-backward':
                c.value.wallObservedAt = c.value.wallStartedAt - 1;
                break;
            case 'clock-jump':
                c.value.wallObservedAt += 10000;
                break;
            case 'rtt':
                c.value.responseObservedAt = c.value.requestStartedAt + 10000;
                break;
            case 'unknown-start':
                c.job.started_at = null;
                break;
            case 'future-start':
                c.job.started_at = '2026-10-20T12:01:00Z';
                break;
            case 'wrong-run':
                c.job.run_id++;
                break;
            case 'attempt2':
                c.job.run_attempt = 2;
                break;
            case 'wrong-commit':
                c.job.head_sha = 'b'.repeat(40);
                break;
            case 'wrong-branch':
                c.job.head_branch = 'main';
                break;
            case 'wrong-runner':
                c.job.runner_name = 'other';
                break;
            case 'no-runner-id':
                c.job.runner_id = null;
                break;
            case 'wrong-workflow':
                c.job.workflow_name = 'other';
                break;
            case 'wrong-url':
                c.job.run_url = 'https://other/';
                break;
            case 'wrong-job':
                c.job.name = 'build';
                break;
            case 'duplicate-job':
                c.body.jobs.push({ ...c.job });
                c.body.total_count++;
                break;
            case 'other-eligible':
                c.body.jobs.push({ ...c.job, id: 124, name: 'build', status: 'queued' });
                c.body.total_count++;
                break;
            case 'pagination':
                c.body.total_count = 9;
                break;
            case 'status429':
                c.response.status = 429;
                break;
            case 'redirect':
                c.response.status = 302;
                break;
            case 'encoding':
                c.response.headers['content-encoding'] = 'gzip';
                break;
            case 'missing-request-id':
                delete c.response.headers['x-github-request-id'];
                break;
        }
        replaceBody(c);
        if (fault === 'truncated-body') c.response.body = Buffer.from('{');
        if (fault === 'overflow') c.response.body = Buffer.alloc(65537);
        assert.throws(() => validateQueryJobTime(c.value));
    });
test('B3 metadata-only read is exactly one fixed HTTPS GET and contains no credentials/retry', async () => {
    const c = timing();
    let calls = 0;
    await admitQueryJobTime(c.env, {
        ownerStartedAt: 10000,
        now: () => 10010,
        wall: () => server + 500,
        fetch: async (url) => {
            calls++;
            assert.equal(
                url,
                'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/actions/runs/123456/attempts/1/jobs?per_page=100',
            );
            return c.response;
        },
    });
    assert.equal(calls, 1);
    c.response.status = 429;
    await assert.rejects(
        admitQueryJobTime(c.env, {
            ownerStartedAt: 10000,
            now: () => 10010,
            wall: () => server + 500,
            fetch: async () => {
                calls++;
                return c.response;
            },
        }),
    );
    assert.equal(calls, 2);
});
const url =
    'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/actions/runs/123456/attempts/1/jobs?per_page=100';
test('B3 transport is credential-free, bounded, nonredirecting; mock socket only', async () => {
    let options,
        cleared = 0;
    const req = Object.assign(new EventEmitter(), {
            destroy() {},
            end() {
                queueMicrotask(() => {
                    callback(res);
                    res.emit('data', Buffer.from('{}'));
                    res.emit('end');
                    res.socket.emit('close', false);
                });
            },
        }),
        res = Object.assign(new EventEmitter(), {
            statusCode: 200,
            headers: { date },
            complete: true,
            socket: new EventEmitter(),
            destroy() {},
        });
    let callback;
    const response = await fetchQueryJobMetadata(url, {
        request(u, o, cb) {
            assert.equal(u, url);
            options = o;
            callback = cb;
            return req;
        },
        setTimer(_fn, ms) {
            assert.equal(ms, 10000);
            return 1;
        },
        clearTimer() {
            cleared++;
        },
    });
    assert.equal(response.body.toString(), '{}');
    assert.equal(options.method, 'GET');
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['Cache-Control'], 'no-cache, max-age=0');
    assert.equal(cleared, 1);
});
for (const fault of ['overflow', 'total-timeout', 'network-error'])
    test(
        'B3 mock transport ' + fault + ' closes admission without retry or live timer',
        async () => {
            let starts = 0,
                callback,
                timer,
                req;
            const res = Object.assign(new EventEmitter(), {
                statusCode: 200,
                headers: { date },
                complete: true,
                socket: new EventEmitter(),
                destroy() {},
            });
            const promise = fetchQueryJobMetadata(url, {
                request(_u, _o, cb) {
                    starts++;
                    callback = cb;
                    req = Object.assign(new EventEmitter(), { destroy() {}, end() {} });
                    return req;
                },
                setTimer(fn) {
                    timer = fn;
                    return 1;
                },
                clearTimer() {},
            });
            if (fault === 'total-timeout') timer();
            else if (fault === 'network-error') req.emit('error', Error('fixture network'));
            else {
                callback(res);
                res.emit('data', Buffer.alloc(65537));
            }
            await assert.rejects(promise);
            assert.equal(starts, 1);
        },
    );
for (const gate of ['runtime', 'unknown-job-time'])
    test(
        'actual owner ' + gate + ' refusal precedes fingerprint/hold/spawn/root/descriptor effects',
        async () => {
            const c = timing(),
                source = querySourceRoot,
                request = {
                    schema: 1,
                    kind: 'windows-security-query-only',
                    repository: c.env.GITHUB_REPOSITORY,
                    ref: c.env.GITHUB_REF,
                    commit: c.env.GITHUB_SHA,
                    sourceSHA256: 'b'.repeat(64),
                    policySHA256: 'c'.repeat(64),
                    workflowSHA256: 'd'.repeat(64),
                    lockfileSHA256: 'e'.repeat(64),
                    diagnostic: true,
                },
                raw = JSON.stringify(request),
                environment = {
                    ...c.env,
                    SECURITY_QUERY_REQUEST_JSON: raw,
                    SECURITY_QUERY_INPUTS_JSON: JSON.stringify({
                        ...oldQueryInputs,
                        windows_security_query_only: true,
                        security_query_request_json: raw,
                    }),
                };
            let owned = 0,
                timeCalls = 0;
            await assert.rejects(
                queryOwner(
                    { startedAt: 10000, environment, sourceRoot: source },
                    {
                        argv: ['node', 'entry'],
                        execArgv: queryPolicy.runtimeArgs,
                        version: queryPolicy.node,
                        context: () => ({ check() {}, parent: 'never-created', host: {} }),
                        runtime() {
                            if (gate === 'runtime') throw Error('cache unavailable');
                            return {};
                        },
                        async jobTime() {
                            timeCalls++;
                            throw Error('job time unknown');
                        },
                        fingerprint() {
                            owned++;
                        },
                        hold() {
                            owned++;
                        },
                        spawn() {
                            owned++;
                        },
                        command() {
                            owned++;
                        },
                        ownerStdio: {
                            attach() {
                                owned++;
                            },
                        },
                    },
                ),
            );
            assert.equal(owned, 0);
            assert.equal(timeCalls, gate === 'runtime' ? 0 : 1);
        },
    );

test('B3 documented attempt endpoint binds attempt when optional job run_attempt is absent', () => {
    const c = timing();
    delete c.job.run_attempt;
    replaceBody(c);
    assert.doesNotThrow(() => validateQueryJobTime(c.value));
});
for (const fault of ['missing', 'incomplete', 'unclosed'])
    test('B3 refuses ' + fault + ' metadata transport proof', () => {
        const c = timing();
        if (fault === 'missing') delete c.response.transport;
        if (fault === 'incomplete') c.response.transport.responseComplete = false;
        if (fault === 'unclosed') c.response.transport.socketClosed = false;
        assert.throws(() => validateQueryJobTime(c.value), /socket closure/);
    });
for (const fault of ['close-success', 'close-error', 'close-unknown', 'incomplete', 'no-socket'])
    test('B3 response end never admits before positive socket closure: ' + fault, async () => {
        let callback,
            timer,
            settled = false;
        const req = Object.assign(new EventEmitter(), { end() {}, destroy() {} });
        const res = Object.assign(new EventEmitter(), {
            statusCode: 200,
            headers: { date },
            complete: fault !== 'incomplete',
            socket: fault === 'no-socket' ? undefined : new EventEmitter(),
            destroy() {},
        });
        const promise = fetchQueryJobMetadata(url, {
            request(_url, _options, cb) {
                callback = cb;
                return req;
            },
            setTimer(fn) {
                timer = fn;
                return 1;
            },
            clearTimer() {},
        });
        promise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        callback(res);
        if (fault !== 'no-socket') {
            res.emit('data', Buffer.from('{}'));
            res.emit('end');
        }
        await Promise.resolve();
        if (fault.startsWith('close-')) assert.equal(settled, false);
        if (fault === 'close-success') res.socket.emit('close', false);
        if (fault === 'close-error') res.socket.emit('close', true);
        if (fault === 'close-unknown') timer();
        if (fault === 'close-success') {
            const response = await promise;
            assert.deepEqual(response.transport, { responseComplete: true, socketClosed: true });
        } else await assert.rejects(promise);
    });
