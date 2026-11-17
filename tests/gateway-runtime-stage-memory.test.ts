// Benign in-memory orchestration only: no sockets, real child, package execution or deletion.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { memoryFilesystem } from './fixtures/gateway-producer-memory';
import {
    selectRuntimeStage,
    runRuntimeStage,
    createRuntimeStage,
    TWO_STAGE_BRANCH,
} from '../scripts/run-gateway-runtime-stage.mjs';
import { GATEWAY_RUNTIME_CHILD_FILES } from '../scripts/lib/gateway-runtime-input-bridge.mjs';

const hash = (x: Buffer) => createHash('sha256').update(x).digest('hex');
function fixture() {
    const environment: any = {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/' + TWO_STAGE_BRANCH,
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'gateway_build',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
        GITHUB_RUN_ID: '123',
        GITHUB_WORKSPACE: '/project',
        RUNNER_TEMP: '/private',
    };
    environment.GITHUB_WORKFLOW_REF =
        environment.GITHUB_REPOSITORY +
        '/.github/workflows/gateway-publisher-node-buildonly.yml@' +
        environment.GITHUB_REF;
    const runtime = {
        environment,
        platform: 'linux',
        arch: 'x64',
        version: 'v24.22.2',
        execArgv: [],
        uid: 1000,
        execPath: '/private/gateway-publisher-node-123-1/bin/node',
    };
    const descriptor = (name: string) => ({ name, bytes: 23, sha256: 'b'.repeat(64) });
    const name = 'Diagnostic-Hub-Gateway-0.6.0.tar.gz';
    const expected = {
        context: {
            scope: 'gateway',
            version: '0.6.0',
            sourceCommit: environment.GITHUB_SHA,
            sourceTree: 'c'.repeat(40),
            runId: '123',
            runAttempt: '1',
            jobKey: 'gateway_build',
        },
        buildRecord: descriptor('gateway-build.json'),
        artifacts: [descriptor(name), descriptor(name + '.sha256')],
    };
    const bytes = Buffer.from(JSON.stringify(expected));
    const f = memoryFilesystem(),
        sourceFiles: any = {},
        inventory: any[] = [];
    const profile = Buffer.from(
        JSON.stringify({ node: { version: '24.22.2', bytes: 15, sha256: 'd'.repeat(64) } }),
    );
    for (const [file, body] of [
        ['scripts/ci/gateway-four-tool-inputs.json', profile],
        ...GATEWAY_RUNTIME_CHILD_FILES.map((x: string) => [
            x,
            Buffer.from('ordinary memory source'),
        ]),
    ] as [string, Buffer][]) {
        f.write('/project/' + file, body);
        inventory.push({ path: file, bytes: body.length, sha256: hash(body), mode: '100644' });
        sourceFiles[file] = body;
    }
    f.write(runtime.execPath, Buffer.alloc(15));
    f.write('/usr/bin/python3.12', Buffer.from('inert Python'));
    const stat = async (file: string) => ({
        ...(await f.fs.lstat(file)),
        uid: 0,
        gid: 0,
        ...(file === '/usr/bin/python3.12' ? { mode: 0o100755 } : {}),
    });
    const filesystem: any = {
        ...f.fs,
        lstat: (file: string) => stat(file === '/usr/bin/python3' ? '/usr/bin/python3.12' : file),
        realpath: async (file: string) =>
            file === '/usr/bin/python3' ? '/usr/bin/python3.12' : f.fs.realpath(file),
        async open(file: string, flags: string) {
            const h = await f.fs.open(file, flags);
            return { ...h, stat: () => stat(file) };
        },
    };
    const record = {
        builder: {
            runtime: {
                executablePath: runtime.execPath,
                node: 'v24.22.2',
                executableSHA256: 'd'.repeat(64),
            },
        },
        sourceBridge: { inventory },
    };
    let reads = 0,
        makes = 0,
        runs = 0,
        settled = 0;
    const ports: any = {
        files: {
            filesystem,
            systemRoot: { lstat: () => stat('/'), realpath: async () => '/' },
            owner: {
                snapshot: () => ({ pending: 0, handles: f.handles.size }),
                assertSettled() {
                    assert.equal(f.handles.size, 0);
                },
            },
        },
        async readPackage(body: Buffer, original: string, selected: any) {
            reads++;
            assert.equal(hash(body), original);
            assert.deepEqual(selected, {
                sourceCommit: environment.GITHUB_SHA,
                sourceTree: expected.context.sourceTree,
            });
            return { record, readback: { sentinel: 'original' } };
        },
        makeAdapter(selected: any) {
            makes++;
            assert.equal(selected.pythonPath, '/usr/bin/python3.12');
            return {
                owner: {
                    snapshot: () => ({
                        pendingCalls: 0,
                        nativeHandles: 0,
                        unknownReturns: 0,
                        files: { pending: 0, handles: 0 },
                        bridges: [],
                        children: [],
                    }),
                },
                ports: {
                    assertSettled() {
                        settled++;
                    },
                },
                async run(input: any) {
                    runs++;
                    assert.equal(input.readback.sentinel, 'original');
                    assert.deepEqual(input.expected, expected);
                    return {
                        releaseAcceptance: false,
                        originalBuildRecord: expected.buildRecord,
                        runtime: {
                            receipt: {
                                status: 'cli-health-auth-and-direct-close-observed',
                                checks: [200, 401, 403].map((status) => ({ status })),
                            },
                        },
                    };
                },
            };
        },
    };
    return {
        runtime,
        expected,
        bytes,
        f,
        ports,
        record,
        stats: () => ({ reads, makes, runs, settled }),
        run: () => runRuntimeStage(runtime, bytes, hash(bytes), ports),
    };
}
test('separate stage consumes the original selection and invokes only one runtime adapter', async () => {
    const f = fixture();
    const result = await f.run();
    assert.equal(result.releaseAcceptance, false);
    assert.deepEqual(f.stats(), { reads: 1, makes: 1, runs: 1, settled: 1 });
    assert.equal(f.f.handles.size, 0);
});
test('changed original hash refuses before all package and runtime ports', async () => {
    const f = fixture();
    await assert.rejects(runRuntimeStage(f.runtime, f.bytes, 'e'.repeat(64), f.ports));
    assert.deepEqual(f.stats(), { reads: 0, makes: 0, runs: 0, settled: 0 });
});
test('package readback failure cannot submit runtime', async () => {
    const f = fixture();
    f.ports.readPackage = async () => {
        throw Error('authored readback refusal');
    };
    await assert.rejects(f.run());
    assert.equal(f.stats().makes, 0);
});
test('source-file mismatch refuses before adapter construction', async () => {
    const f = fixture();
    f.f.write('/project/' + GATEWAY_RUNTIME_CHILD_FILES[0], Buffer.from('changed memory input'));
    await assert.rejects(f.run());
    assert.equal(f.stats().makes, 0);
    assert.equal(f.f.handles.size, 0);
});
test('different original job cannot submit a runtime', async () => {
    const f = fixture();
    f.expected.context.runId = '456';
    const body = Buffer.from(JSON.stringify(f.expected));
    await assert.rejects(runRuntimeStage(f.runtime, body, hash(body), f.ports));
    assert.equal(f.stats().makes, 0);
});
test('runtime failure stays failed and does not retry or claim settlement', async () => {
    const f = fixture();
    let calls = 0;
    f.ports.makeAdapter = () => ({
        owner: {
            snapshot: () => ({
                pendingCalls: 0,
                nativeHandles: 0,
                unknownReturns: 0,
                files: { pending: 0, handles: 0 },
                bridges: [],
                children: [],
            }),
        },
        async run() {
            calls++;
            throw Error('authored runtime failure');
        },
        ports: {
            assertSettled() {
                throw Error('must not settle');
            },
        },
    });
    await assert.rejects(f.run());
    assert.equal(calls, 1);
});
test('outside keeper retains uncertain runtime custody until the owned snapshot is known zero', async () => {
    const { observeOwnedGatewayJob } = await import('../scripts/observe-gateway-health-job.mjs');
    const f = fixture();
    let live = true,
        cleared = 0,
        tick: Function;
    f.ports.makeAdapter = () => ({
        owner: {
            snapshot: () => ({
                pendingCalls: live ? 1 : 0,
                nativeHandles: 0,
                unknownReturns: 0,
                files: { pending: 0, handles: 0 },
                bridges: [],
                children: [],
            }),
        },
        async run() {
            throw Error('authored runtime failure with pending ownership');
        },
    });
    const owner = createRuntimeStage(f.runtime, f.bytes, hash(f.bytes), f.ports);
    await assert.rejects(
        observeOwnedGatewayJob(owner, {
            setInterval(callback: Function) {
                tick = callback;
                return { hasRef: () => true };
            },
            clearInterval() {
                cleared++;
            },
        }),
    );
    assert.equal(cleared, 0);
    assert.equal(owner.quiescent(), false);
    live = false;
    tick!();
    assert.equal(cleared, 1);
    assert.equal(owner.quiescent(), true);
});
test('unsupported asynchronous factory remains retained and cannot become runtime success', async () => {
    const f = fixture();
    f.ports.makeAdapter = () => Promise.resolve({});
    const owner = createRuntimeStage(f.runtime, f.bytes, hash(f.bytes), f.ports);
    await assert.rejects(owner.run());
    assert.equal(owner.quiescent(), false);
});
test('unsupported rejected snapshot is consumed and refuses quiescence', async () => {
    const f = fixture();
    const owner = createRuntimeStage(f.runtime, f.bytes, hash(f.bytes), f.ports);
    f.ports.files.owner.snapshot = () =>
        Promise.reject(Error('ordinary synthetic snapshot refusal'));
    assert.equal(owner.quiescent(), false);
    await Promise.resolve();
    assert.equal(owner.quiescent(), false);
});
test('refused context and startup injection stop before package reads', async () => {
    for (const change of [
        { GITHUB_REF: 'refs/heads/other' },
        { GITHUB_RUN_ATTEMPT: '2' },
        { NODE_OPTIONS: 'ordinary fixture' },
        { GITHUB_WORKFLOW_SHA: 'f'.repeat(40) },
    ]) {
        const f = fixture();
        Object.assign(f.runtime.environment, change);
        await assert.rejects(f.run());
        assert.equal(f.stats().reads, 0);
    }
});
test('runtime identity and noncanonical paths fail closed', () => {
    for (const change of [
        { uid: 0 },
        { version: 'v22.0.0' },
        { arch: 'arm64' },
        { execPath: '/other/node' },
    ])
        assert.throws(() => selectRuntimeStage({ ...fixture().runtime, ...change }));
    const f = fixture();
    f.runtime.environment.RUNNER_TEMP = '/private/../other';
    assert.throws(() => selectRuntimeStage(f.runtime));
});
