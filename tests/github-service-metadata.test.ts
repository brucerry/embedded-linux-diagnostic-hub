import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseGitHubMetadataJSON,
    githubMetadataNumericLexeme,
} from '../scripts/lib/github-metadata-json.mjs';
import {
    createGitHubServiceMetadata,
    createGitHubServiceMetadataModel,
    validateGitHubMetadataEnvironment,
    GitHubMetadataError,
} from '../scripts/lib/github-service-metadata.mjs';
import {
    observeArchiveReadback,
    archiveReadbackSnapshot,
    requireArchiveReleaseProvenance,
} from '../scripts/lib/archive-service-readback.mjs';
import { metadataFixture } from './fixtures/github-service-metadata-memory';

const request = (id = 1) => ({
    owner: 'a'.repeat(32),
    id,
    kind: 'service',
    resource: 'selected-service-observation',
});
const tick = async (predicate: () => boolean) => {
    for (let i = 0; i < 5000 && !predicate(); i++) await Promise.resolve();
    assert.ok(predicate(), 'Bounded fake lifecycle not reached.');
};
async function consume(handle: any) {
    const chunks: Buffer[] = [];
    for (;;) {
        const part = await handle.read(65536);
        if (part === null) break;
        chunks.push(Buffer.from(part));
    }
    return JSON.parse(Buffer.concat(chunks).toString());
}

test('wire metadata rejects duplicate/invalid JSON and preserves unsafe numeric identities without rounding', () => {
    const parsed = parseGitHubMetadataJSON(
        Buffer.from('{ "id":18446744073709551615,"x":1e309,"y":1.5,"z":-0,"n":23,"s":"42\\n😀" }'),
    );
    for (const [key, token] of Object.entries({
        id: '18446744073709551615',
        x: '1e309',
        y: '1.5',
        z: '-0',
    })) {
        assert.equal(githubMetadataNumericLexeme(parsed[key]), token);
        assert.equal(typeof parsed[key], 'object');
        assert.ok(Object.isFrozen(parsed[key]));
    }
    assert.equal(parsed.n, 23);
    assert.equal(parsed.s, '42\n😀');
    for (const value of ['18446744073709551615', { token: '18446744073709551615' }, {}, null, 23])
        assert.equal(githubMetadataNumericLexeme(value), null);
    const prototype: any = parseGitHubMetadataJSON(Buffer.from('{"__proto__":{"polluted":true}}'));
    assert.equal(Object.getPrototypeOf(prototype), Object.prototype);
    assert.equal(({} as any).polluted, undefined);
    for (const text of [
        '{"id":1,"\\u0069d":2}',
        '{18446744073709551615:1}',
        '{"id":01}',
        '{"id":1e}',
        '[1,]',
        '{"x":1} trailing',
        '\ufeff{}',
        '['.repeat(34) + '0' + ']'.repeat(34),
    ])
        assert.throws(() => parseGitHubMetadataJSON(Buffer.from(text)));
    assert.throws(() => parseGitHubMetadataJSON(Buffer.from([0xff])));
});

test('wire numeric tokens cannot masquerade as string names or SHAs; exact numeric IDs remain usable', async () => {
    const digits = '18446744073709551615';
    for (const bare of [false, true]) {
        const f = await metadataFixture();
        f.scope.service.artifactName = digits;
        f.rawArtifact.name = digits;
        f.controls.plan = (_: number, options: any) =>
            options.path.includes('/artifacts/')
                ? {
                      body: Buffer.from(
                          JSON.stringify(f.rawArtifact).replace(
                              '"name":"' + digits + '"',
                              '"name":' + (bare ? digits : JSON.stringify(digits)),
                          ),
                      ),
                  }
                : {};
        const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
            handle = await port.openService(request());
        if (bare) await assert.rejects(consume(handle), GitHubMetadataError);
        else assert.equal((await consume(handle)).artifact.name, digits);
        await handle.close();
        assert.equal(f.active.size, 0);
    }
    for (const bare of [false, true]) {
        const f = await metadataFixture(),
            sha = '1'.repeat(40);
        f.scope.context.sourceCommit = sha;
        f.rawRun.head_sha = f.rawJob.head_sha = f.rawArtifact.workflow_run.head_sha = sha;
        f.controls.plan = (_: number, options: any) =>
            options.path.endsWith('/attempts/1')
                ? {
                      body: Buffer.from(
                          JSON.stringify(f.rawRun).replace(
                              '"head_sha":"' + sha + '"',
                              '"head_sha":' + (bare ? sha : JSON.stringify(sha)),
                          ),
                      ),
                  }
                : {};
        const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
            handle = await port.openService(request());
        if (bare) await assert.rejects(consume(handle), GitHubMetadataError);
        else assert.equal((await consume(handle)).run.headSHA, sha);
        await handle.close();
        assert.equal(f.active.size, 0);
    }
    for (const token of [digits, JSON.stringify(digits), '1e20', '1.5', '-0']) {
        const f = await metadataFixture();
        f.scope.service.artifactId = digits;
        f.controls.plan = (_: number, options: any) =>
            options.path.includes('/artifacts/')
                ? {
                      body: Buffer.from(
                          JSON.stringify(f.rawArtifact).replace('"id":600', '"id":' + token),
                      ),
                  }
                : {};
        const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
            handle = await port.openService(request());
        if (token === digits) assert.equal((await consume(handle)).artifact.id, digits);
        else await assert.rejects(consume(handle), GitHubMetadataError);
        await handle.close();
        assert.equal(f.active.size, 0);
    }
});

test('real factory construction and pure environment validation are inert and never alter TLS settings', async () => {
    const f = await metadataFixture(),
        port = createGitHubServiceMetadata(f.scope, null);
    assert.equal(port.snapshot().observations, 0);
    assert.equal(port.snapshot().active, null);
    assert.equal(port.snapshot().qualification, false);
    assert.equal(
        validateGitHubMetadataEnvironment({
            tls: undefined,
            nodeOptions: undefined,
            nodePath: undefined,
        }),
        true,
    );
    for (const value of [
        { tls: '0', nodeOptions: undefined, nodePath: undefined },
        { tls: '1', nodeOptions: '--require=x', nodePath: undefined },
        { tls: '1', nodeOptions: undefined, nodePath: 'x' },
    ])
        assert.throws(() => validateGitHubMetadataEnvironment(value));
    assert.deepEqual(f.requests, []);
});

test('pinned model metadata observes attempt membership/check-run and joins every request/response/socket', async () => {
    const f = await metadataFixture(),
        port = createGitHubServiceMetadataModel(
            f.scope,
            'synthetic-private-token',
            f.host,
            f.clock,
        ),
        handle = await port.openService(request());
    assert.equal(f.requests.length, 0);
    assert.equal(Object.hasOwn(f.rawJob, 'run_attempt'), false);
    assert.deepEqual(await consume(handle), f.normalized);
    await handle.close();
    const root = '/repos/brucerry/embedded-linux-diagnostic-hub/actions';
    assert.deepEqual(
        f.requests.map((v) => v.options.path),
        [
            root + '/runs/123/attempts/1',
            root + '/runs/123/attempts/1/jobs?per_page=100&page=1',
            root + '/artifacts/600',
        ],
    );
    for (const frame of f.requests) {
        assert.equal(frame.options.hostname, 'api.github.com');
        assert.equal(frame.options.servername, 'api.github.com');
        assert.equal(frame.options.agent, false);
        assert.equal(frame.options.rejectUnauthorized, true);
        assert.equal(frame.options.method, 'GET');
        assert.equal(frame.options.headers['X-GitHub-Api-Version'], '2026-03-10');
    }
    const snapshot = port.snapshot();
    assert.equal(snapshot.mode, 'injected-model-unqualified');
    assert.equal(snapshot.last.jobMembership.checkRunId, '805');
    assert.equal(snapshot.last.jobMembership.jobId, '700');
    assert.equal(snapshot.last.jobMembership.runAttempt, '1');
    assert.equal(snapshot.last.requests.length, 3);
    assert.equal(f.active.size, 0);
    assert.equal(f.timers.size, 0);
    assert.ok(
        snapshot.last.requests.every(
            (v: any) =>
                v.retired &&
                v.requestClose &&
                v.responseClose &&
                v.responseEnd &&
                v.tlsAuthorized &&
                v.sockets.every((s: any) => s.closed),
        ),
    );
    assert.ok(!JSON.stringify(snapshot).includes('synthetic-private-token'));
    assert.equal(snapshot.artifactUploadAttribution, null);
});

test('metadata port composes with real readback code without promoting model facts or losing either observation', async () => {
    const f = await metadataFixture(),
        port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock);
    const capability = await observeArchiveReadback(f.scope, {
            openService: port.openService,
            openArtifact: f.ports.openArtifact,
        }),
        facts = archiveReadbackSnapshot(capability);
    assert.equal(facts.releaseAcceptance, false);
    assert.equal(facts.serviceAuthentication, null);
    assert.equal(facts.artifactJobAttribution, null);
    assert.throws(() => requireArchiveReleaseProvenance(capability), /release remains blocked/);
    assert.equal(f.requests.length, 6);
    assert.equal(port.snapshot().completed.length, 2);
    assert.ok(
        port
            .snapshot()
            .completed.every(
                (v: any) => v.mode === 'injected-model-unqualified' && v.qualification === false,
            ),
    );
    assert.equal(f.active.size, 0);
});

test('attempt pagination proves selected membership without latest-name inference and bounded absence stays unproved', async () => {
    const f = await metadataFixture();
    f.controls.jobsPage = (page: number) => ({
        total_count: 101,
        jobs:
            page === 1
                ? Array.from({ length: 100 }, (_, i) => ({ ...f.rawJob, id: 10000 + i }))
                : [f.rawJob],
    });
    const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
        handle = await port.openService(request());
    await consume(handle);
    await handle.close();
    assert.equal(port.snapshot().last.jobMembership.page, 2);
    assert.equal(f.requests.length, 4);
    const g = await metadataFixture();
    g.controls.jobsPage = (page: number) => ({
        total_count: 10000,
        jobs: [{ ...g.rawJob, id: 10000 + page }],
    });
    const missing = createGitHubServiceMetadataModel(g.scope, null, g.host, g.clock),
        other = await missing.openService(request());
    await assert.rejects(
        consume(other),
        (error: any) => error.details.code === 'JOB_MEMBERSHIP_UNPROVED',
    );
    await other.close();
    assert.equal(g.requests.length, 11);
    assert.ok(!g.requests.some((v) => v.options.path.includes('/artifacts/')));
    assert.equal(missing.snapshot().qualification, false);
});

test('redirects, failed TLS/status/representation/version/framing and malformed wire data fail without retries', async () => {
    for (const plan of [
        { status: 302, headers: { location: 'https://untrusted.invalid/secret' } },
        { status: 403 },
        { status: 429 },
        { authorized: false },
        { headers: { 'content-encoding': 'gzip' } },
        { headers: { 'x-github-api-version-selected': undefined } },
        { headers: { 'content-length': '1' } },
        { complete: false },
        { body: Buffer.from('{"id":1,"id":2}') },
    ]) {
        const f = await metadataFixture();
        f.controls.plans = [plan];
        const port = createGitHubServiceMetadataModel(
                f.scope,
                'synthetic-private-token',
                f.host,
                f.clock,
            ),
            handle = await port.openService(request());
        await assert.rejects(consume(handle), GitHubMetadataError);
        await handle.close();
        assert.equal(f.requests.length, 1);
        assert.equal(f.active.size, 0);
        assert.equal(f.timers.size, 0);
        assert.equal(port.snapshot().last.status, 'failed-observation');
        assert.ok(!JSON.stringify(port.snapshot()).includes('synthetic-private-token'));
    }
});

test('held physical close acknowledgements cannot be replaced by body or RPC completion', async () => {
    for (const key of ['holdSocketClose', 'holdRequestClose', 'holdResponseClose']) {
        const f = await metadataFixture();
        f.controls.plans = [{ [key]: true }];
        const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
            handle = await port.openService(request());
        let done = false;
        const task = consume(handle).then((v) => {
            done = true;
            return v;
        });
        await tick(() => f.requests.length === 1 && f.requests[0].responseEnded);
        assert.equal(done, false);
        assert.equal(port.snapshot().active!.pending.length, 1);
        await assert.rejects(port.openService(request(2)), /custody remains/);
        const release =
            key === 'holdSocketClose'
                ? 'releaseSocketClose'
                : key === 'holdRequestClose'
                  ? 'releaseRequestClose'
                  : 'releaseResponseClose';
        f.requests[0][release]();
        await task;
        await handle.close();
        assert.equal(f.requests.length, 3);
        assert.equal(f.active.size, 0);
    }
});

test('explicit close joins cancellation without starting the next request or claiming unknown retirement', async () => {
    const f = await metadataFixture();
    f.controls.plans = [{ holdResponse: true, holdSocketClose: true }];
    const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
        handle = await port.openService(request());
    const task = consume(handle);
    task.catch(() => {});
    await tick(() => f.requests.length === 1 && port.snapshot().active!.pending.length === 1);
    let closed = false;
    const closing = handle.close().then(() => {
        closed = true;
    });
    await assert.rejects(task, GitHubMetadataError);
    await tick(() => f.requests[0].requestClosed);
    assert.equal(closed, false);
    assert.equal(f.requests.length, 1);
    f.requests[0].releaseSocketClose();
    await closing;
    assert.equal(closed, true);
    assert.equal(f.active.size, 0);
    assert.equal(port.snapshot().last.requests[0].primary.code, 'READER_CANCELLED');
});

test('deadline and destroy failure preserve the primary code and cleanup diagnostics until later real close events', async () => {
    const f = await metadataFixture(),
        secret = 'synthetic-private-token';
    f.controls.plans = [{ holdResponse: true, holdSocketClose: true, destroyThrows: true, secret }];
    const port = createGitHubServiceMetadataModel(f.scope, secret, f.host, f.clock),
        handle = await port.openService(request());
    const task = consume(handle);
    task.catch(() => {});
    await tick(() => f.requests.length === 1);
    f.clock.advance(10000);
    let failure: any;
    await assert.rejects(task, (error: any) => {
        failure = error;
        return true;
    });
    let closed = false;
    const close = handle.close().then(() => {
        closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    assert.equal(failure.details.request.primary.code, 'REQUEST_DEADLINE');
    assert.ok(failure.details.request.cleanup.some((v: any) => v.code === 'CANCEL_REQUEST_THROW'));
    assert.ok(!JSON.stringify(failure.details).includes(secret));
    f.requests[0].releaseAll();
    await close;
    assert.equal(f.requests[0].destroyCalls, 1);
    assert.equal(f.active.size, 0);
    assert.equal(port.snapshot().last.requests[0].primary.code, 'REQUEST_DEADLINE');
});

test('unknown acquisition retains immutable-job custody and has no forced completion path', async () => {
    const f = await metadataFixture();
    f.controls.plans = [{ throwAcquisition: true, secret: 'synthetic-private-token' }];
    const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
        handle = await port.openService(request());
    await assert.rejects(consume(handle), GitHubMetadataError);
    let closed = false;
    handle.close().then(() => {
        closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    assert.equal(port.snapshot().active!.pending[0].unknownAcquisition, true);
    assert.equal(f.timers.size, 0);
    const relabeled = structuredClone(f.scope);
    relabeled.reader.runId = '999';
    const replacement = createGitHubServiceMetadataModel(relabeled, null, f.host, f.clock);
    await assert.rejects(replacement.openService(request()), /custody remains/);
    assert.ok(!JSON.stringify(port.snapshot()).includes('synthetic-private-token'));
});

test('dispatch failure with acknowledged closure retires honestly without trapping known failed requests', async () => {
    const f = await metadataFixture();
    f.controls.plans = [{ throwEnd: true }];
    const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
        handle = await port.openService(request());
    await assert.rejects(consume(handle), GitHubMetadataError);
    await handle.close();
    assert.equal(port.snapshot().active, null);
    assert.equal(f.active.size, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(port.snapshot().last.requests[0].retired, true);
});

test('timer retirement failure remains owned until its actual expiry callback and keeps its original diagnostic', async () => {
    const f = await metadataFixture();
    f.controls.timerClearThrows = true;
    const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
        handle = await port.openService(request());
    let done = false;
    const task = consume(handle).finally(() => {
        done = true;
    });
    task.catch(() => {});
    await tick(() => f.requests.length === 1 && f.requests[0].socketClosed);
    assert.equal(done, false);
    assert.equal(port.snapshot().active!.pending.length, 1);
    f.clock.advance(10000);
    await assert.rejects(task, GitHubMetadataError);
    await handle.close();
    assert.equal(port.snapshot().last.requests[0].primary.code, 'TIMER_CLEAR_FAILED');
    assert.equal(f.timers.size, 0);
});

test('late old callbacks and duplicate close cannot retire a later observation owner', async () => {
    const f = await metadataFixture(),
        port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
        first = await port.openService(request());
    await consume(first);
    await first.close();
    const old = f.requests[0];
    f.controls.plans = [, , , { holdSocketClose: true }];
    const next = await port.openService(request(2));
    let done = false;
    const task = consume(next).then((v) => {
        done = true;
        return v;
    });
    await tick(() => f.requests.length === 4 && f.requests[3].responseEnded);
    old.socket.emit('close', false);
    old.request.emit('close');
    await first.close();
    assert.equal(done, false);
    assert.equal(port.snapshot().active!.pending.length, 1);
    f.requests[3].releaseSocketClose();
    await task;
    await next.close();
    assert.equal(port.snapshot().completed.length, 2);
    await assert.rejects(port.openService(request(3)), /profile exhausted/);
    assert.equal(f.requests.length, 6);
});

test('body bounds and check-run scope reject without fetching a URL supplied by service data', async () => {
    const f = await metadataFixture();
    f.controls.plans = [
        {
            body: Buffer.from('"' + 'a'.repeat(1024 ** 2 - 1) + '"'),
            headers: { 'content-length': undefined },
        },
    ];
    const port = createGitHubServiceMetadataModel(f.scope, null, f.host, f.clock),
        handle = await port.openService(request());
    await assert.rejects(consume(handle), GitHubMetadataError);
    await handle.close();
    assert.equal(port.snapshot().last.requests[0].primary.code, 'BODY_BOUND');
    const g = await metadataFixture();
    g.rawJob.check_run_url = 'https://untrusted.invalid/check-runs/805';
    const other = createGitHubServiceMetadataModel(g.scope, null, g.host, g.clock),
        h = await other.openService(request());
    await assert.rejects(consume(h), GitHubMetadataError);
    await h.close();
    assert.equal(g.requests.length, 2);
    assert.ok(g.requests.every((v) => v.options.hostname === 'api.github.com'));
});
