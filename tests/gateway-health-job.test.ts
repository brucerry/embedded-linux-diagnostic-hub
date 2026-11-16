// Pure producer plus authored callback/adapter boundary controls. No native IO or package execution.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { produceGatewayArchive } from '../scripts/lib/gateway-archive-producer.mjs';
import { createGatewayHealthJob, HEALTH_JOB_BRANCH } from '../scripts/lib/gateway-health-job.mjs';
import { GATEWAY_RUNTIME_CHILD_FILES } from '../scripts/lib/gateway-runtime-input-bridge.mjs';
import { pipelineFixture } from './fixtures/gateway-producer-memory';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
async function fixture() {
    const runId = '123',
        sourceRoot = '/project',
        temporaryRoot = '/job-temp';
    const nodePath = temporaryRoot + '/gateway-publisher-node-' + runId + '-1/bin/node';
    const nodeBytes = Buffer.from('authored Node reference data; never executed');
    const pythonBytes = Buffer.from('authored Python reference data; never executed');
    const profile = Buffer.from(
        JSON.stringify({
            node: { version: '24.22.2', bytes: nodeBytes.length, sha256: hash(nodeBytes) },
        }),
    );
    const additional = new Map<string, Buffer>([
        ['scripts/ci/gateway-four-tool-inputs.json', profile],
        ...GATEWAY_RUNTIME_CHILD_FILES.map(
            (name: string) =>
                [name, Buffer.from('authored source data only: ' + name)] as [string, Buffer],
        ),
    ]);
    const f = pipelineFixture(additional);
    f.options.leaf = 'gateway-current-build';
    Object.assign(f.tools.runtime, {
        executablePath: nodePath,
        executableSHA256: hash(nodeBytes),
        node: 'v24.22.2',
        versions: { node: '24.22.2' },
    });
    const context = { ...f.context, runId, jobKey: 'gateway_build' };
    const { record } = await produceGatewayArchive(context, f.options, f.io);
    const stage = sourceRoot + '/validation/gateway-current-build';
    const recordBytes = f.filesystem.bytes(stage + '/artifacts/gateway-build.json');
    const originalBuildRecord = {
        name: 'gateway-build.json',
        bytes: recordBytes.length,
        sha256: hash(recordBytes),
    };
    const controls: any = {},
        events: string[] = [],
        reports: any[] = [],
        selectedAdapters: any[] = [],
        runInputs: any[] = [];
    const physicalState: any = {
        pendingCalls: 0,
        nativeHandles: 0,
        unknownReturns: 0,
        files: { pending: 0, handles: 0, uncertainPublications: 0 },
        bridges: [],
        children: [],
    };
    const files = new Map<string, Buffer>([
        [stage + '/artifacts/gateway-build.json', recordBytes],
        [
            stage + '/artifacts/' + record.archive.name,
            f.filesystem.bytes(stage + '/artifacts/' + record.archive.name),
        ],
        [
            stage + '/artifacts/' + record.checksum.name,
            f.filesystem.bytes(stage + '/artifacts/' + record.checksum.name),
        ],
        [stage + '/build/main.cjs', f.filesystem.bytes(stage + '/build/main.cjs')],
        ['/usr/bin/python3.12', pythonBytes],
        ...[...additional].map(
            ([name, bytes]) => [sourceRoot + '/' + name, bytes] as [string, Buffer],
        ),
    ]);
    const frame: any = {
        sourceRoot,
        context,
        sourceSelection: { sourceCommit: context.sourceCommit, sourceTree: context.sourceTree },
        record,
        originalBuildRecord,
        async readFile(file: string, maximum: number) {
            events.push('read:' + file);
            const bytes = files.get(file);
            assert.ok(bytes && bytes.length <= maximum, 'Only fixed authored files can be read.');
            return Buffer.from(bytes);
        },
        async sourceFile(name: string) {
            events.push('source:' + name);
            assert.ok(f.files.has(name));
            return Buffer.from(f.files.get(name)!);
        },
        async realpath(file: string) {
            return file === '/usr/bin/python3' ? '/usr/bin/python3.12' : file;
        },
        async lstat(file: string) {
            events.push('stat:' + file);
            const directory = ['/', '/usr', '/usr/bin'].includes(file),
                link = file === '/usr/bin/python3';
            assert.ok(directory || link || file === nodePath || file === '/usr/bin/python3.12');
            return {
                uid: file === nodePath ? 1000 : 0,
                nlink: 1,
                mode: directory ? 0o40755 : link ? 0o120777 : 0o100755,
                size: file === nodePath ? nodeBytes.length : pythonBytes.length,
                isDirectory: () => directory,
                isFile: () => !directory && !link,
                isSymbolicLink: () => link,
            };
        },
    };
    const bootstrap = {
        snapshot: () => ({ authoredMemoryOwner: true }),
        quiescent: () => (controls.bootstrapUnknown ? false : true),
    };
    const adapter = {
        owner: {
            snapshot: () =>
                controls.physicalThenable
                    ? Promise.resolve(physicalState)
                    : structuredClone(physicalState),
        },
        async run(input: any) {
            events.push('adapter-run');
            runInputs.push(input);
            if (controls.entered) controls.entered.resolve();
            if (controls.wait) await controls.wait.promise;
            if (controls.adapterFailure) throw undefined;
            return { releaseAcceptance: false, authoredBoundaryOnly: true };
        },
        ports: {
            async writeExclusive(file: string, bytes: Buffer) {
                events.push('report-write');
                reports.push({ file, bytes: Buffer.from(bytes) });
                if (controls.writeFailure) {
                    physicalState.files.uncertainPublications = 1;
                    throw undefined;
                }
            },
            assertSettled() {
                events.push('assert-settled');
                if (controls.settlementFailure) throw undefined;
            },
        },
    };
    const ports: any = {
        async build(callback: Function, onOwner: Function) {
            events.push('build');
            onOwner(bootstrap);
            if (controls.buildFailure) throw undefined;
            if (controls.skipCallback) return { healthSmoke: { releaseAcceptance: false } };
            const healthSmoke = await callback(frame);
            events.push('build-return');
            return { healthSmoke };
        },
        makeAdapter(selection: any) {
            events.push('make-adapter');
            selectedAdapters.push(selection);
            return controls.asyncAdapter ? Promise.reject(undefined) : adapter;
        },
    };
    const ref = 'refs/heads/' + HEALTH_JOB_BRANCH;
    const runtime: any = {
        environment: {
            GITHUB_ACTIONS: 'true',
            GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
            GITHUB_REF: ref,
            GITHUB_EVENT_NAME: 'push',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_JOB: 'gateway_build',
            RUNNER_ENVIRONMENT: 'github-hosted',
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
            GITHUB_SHA: context.sourceCommit,
            GITHUB_RUN_ID: runId,
            GITHUB_WORKFLOW_SHA: context.sourceCommit,
            GITHUB_WORKFLOW_REF:
                'brucerry/embedded-linux-diagnostic-hub/.github/workflows/gateway-same-job-health-smoke.yml@' +
                ref,
            GITHUB_WORKSPACE: sourceRoot,
            RUNNER_TEMP: temporaryRoot,
        },
        platform: 'linux',
        arch: 'x64',
        version: 'v24.22.2',
        uid: 1000,
        execArgv: [],
        execPath: nodePath,
        entryFile: sourceRoot + '/scripts/observe-gateway-health-job.mjs',
        argv: [
            nodePath,
            sourceRoot + '/scripts/observe-gateway-health-job.mjs',
            '--qualify-branch',
        ],
    };
    return {
        controls,
        events,
        reports,
        selectedAdapters,
        runInputs,
        frame,
        runtime,
        ports,
        physicalState,
        bootstrap,
        adapter,
        profile,
        pythonBytes,
        files,
    };
}

test('driver consumes original canonical producer bytes before selecting its adapter and records only the current job', async () => {
    const f = await fixture(),
        job = createGatewayHealthJob(f.runtime, f.ports);
    const result = await job.run();
    assert.equal(result.result, 'passed');
    assert.equal(result.nativeQualification, false);
    assert.equal(result.releaseAcceptance, false);
    assert.equal(f.selectedAdapters.length, 1);
    assert.equal(f.runInputs.length, 1);
    assert.equal(f.reports.length, 1);
    const selection = f.selectedAdapters[0],
        passed = f.runInputs[0];
    assert.equal(selection.pythonSHA256, hash(f.pythonBytes));
    for (const name of GATEWAY_RUNTIME_CHILD_FILES)
        assert.equal(selection.sourceFiles[name], hash(f.files.get('/project/' + name)!));
    assert.ok(
        passed.readback.recordBytes.equals(
            f.files.get('/project/validation/gateway-current-build/artifacts/gateway-build.json')!,
        ),
    );
    assert.deepEqual(passed.expected.context, f.frame.context);
    assert.equal(f.events.at(-2), 'report-write');
    assert.equal(f.events.at(-1), 'assert-settled');
    assert.equal(f.reports[0].file, '/job-temp/gateway-health-job-123-1.json');
    const report = JSON.parse(f.reports[0].bytes.toString());
    assert.equal(report.sourceCommit, f.runtime.environment.GITHUB_SHA);
    assert.equal(report.runId, '123');
    assert.equal(report.releaseAcceptance, false);
    assert.equal(job.quiescent(), true);
});

for (const which of ['branch', 'attempt', 'startup-options', 'node'])
    test('refuses malformed ' + which + ' before invoking the producer', async () => {
        const f = await fixture();
        if (which === 'branch') f.runtime.environment.GITHUB_REF = 'refs/heads/foreign';
        if (which === 'attempt') f.runtime.environment.GITHUB_RUN_ATTEMPT = '2';
        if (which === 'startup-options') f.runtime.execArgv = ['--trace-warnings'];
        if (which === 'node') f.runtime.version = 'v24.22.0';
        const job = createGatewayHealthJob(f.runtime, f.ports);
        await assert.rejects(job.run());
        assert.deepEqual(f.events, []);
        assert.equal(f.selectedAdapters.length, 0);
        assert.equal(f.reports.length, 0);
    });

test('a producer failure or missing callback cannot create an adapter or manufacture a report', async () => {
    for (const flag of ['buildFailure', 'skipCallback']) {
        const f = await fixture();
        f.controls[flag] = true;
        const job = createGatewayHealthJob(f.runtime, f.ports);
        await assert.rejects(job.run());
        assert.equal(f.selectedAdapters.length, 0);
        assert.equal(f.reports.length, 0);
        assert.equal(job.snapshot().failed, true);
        assert.equal(job.quiescent(), true);
    }
});

test('original build record mismatch stops before adapter construction', async () => {
    const f = await fixture();
    f.frame.originalBuildRecord = { ...f.frame.originalBuildRecord, sha256: 'f'.repeat(64) };
    const job = createGatewayHealthJob(f.runtime, f.ports);
    await assert.rejects(job.run());
    assert.equal(f.selectedAdapters.length, 0);
    assert.equal(f.reports.length, 0);
});

test('delayed callback cannot publish before adapter completion or appear quiescent', async () => {
    const f = await fixture();
    f.controls.entered = deferred();
    f.controls.wait = deferred();
    const job = createGatewayHealthJob(f.runtime, f.ports),
        work = job.run();
    await Promise.race([
        f.controls.entered.promise,
        work.then(() => {
            throw Error('Adapter milestone missing.');
        }),
    ]);
    assert.equal(job.quiescent(), false);
    assert.equal(f.reports.length, 0);
    assert.ok(
        f.events.indexOf('adapter-run') >
            f.events.indexOf('source:scripts/ci/gateway-runtime-inputs.json'),
    );
    f.controls.wait.resolve();
    await work;
    assert.equal(f.reports.length, 1);
    assert.equal(job.quiescent(), true);
});

test('known closed callback failure stays failed while permitting quiescence', async () => {
    const f = await fixture();
    f.controls.adapterFailure = true;
    const job = createGatewayHealthJob(f.runtime, f.ports);
    const error: any = await job.run().catch((value: unknown) => value);
    assert.equal(error.cause, undefined);
    assert.equal(error.owner, job);
    assert.equal(job.snapshot().failed, true);
    assert.equal(job.quiescent(), true);
    assert.equal(f.reports.length, 1);
    assert.equal(JSON.parse(f.reports[0].bytes.toString()).result, 'failed');
});

test('an unknown producer or physical owner cannot be reported as quiescent', async () => {
    for (const flag of ['bootstrapUnknown', 'physicalThenable']) {
        const f = await fixture();
        f.controls.adapterFailure = true;
        f.controls[flag] = true;
        const job = createGatewayHealthJob(f.runtime, f.ports);
        await assert.rejects(job.run());
        assert.equal(job.quiescent(), false);
    }
});

test('a rejected Promise factory stays owned and cannot run an adapter or write a report', async () => {
    const f = await fixture();
    f.controls.asyncAdapter = true;
    const job = createGatewayHealthJob(f.runtime, f.ports);
    await assert.rejects(job.run());
    await Promise.resolve();
    assert.equal(job.snapshot().unknownFactories, 1);
    assert.equal(job.snapshot().failed, true);
    assert.equal(job.quiescent(), false);
    assert.equal(f.selectedAdapters.length, 1);
    assert.equal(f.runInputs.length, 0);
    assert.equal(f.reports.length, 0);
});

test('report write uncertainty is retained without a second publication attempt', async () => {
    const f = await fixture();
    f.controls.writeFailure = true;
    const job = createGatewayHealthJob(f.runtime, f.ports);
    const error: any = await job.run().catch((value: unknown) => value);
    assert.equal(error.cause, undefined);
    assert.equal(f.reports.length, 1);
    assert.equal(job.snapshot().reportAttempted, true);
    assert.equal(job.snapshot().reportWritten, false);
    assert.equal(job.snapshot().failed, true);
    assert.equal(job.quiescent(), true); // A publication tombstone is retained data, not a live handle.
});

test('postreport settlement failure remains a failed job and never overwrites the original report', async () => {
    const f = await fixture();
    f.controls.settlementFailure = true;
    const job = createGatewayHealthJob(f.runtime, f.ports);
    await assert.rejects(job.run());
    assert.equal(f.reports.length, 1);
    assert.equal(job.snapshot().reportWritten, true);
    assert.equal(job.snapshot().failed, true);
    assert.equal(job.quiescent(), true);
});

test('CLI import is inert and explicit fake keeper handles close only for known quiescence', async () => {
    const entry = await import('../scripts/observe-gateway-health-job.mjs');
    assert.equal(typeof entry.observeGatewayHealthJob, 'function');
    const f = await fixture(),
        keepers = new Set<any>(),
        registered: any[] = [];
    let clears = 0;
    const result = await entry.observeGatewayHealthJob(f.runtime, {
        ...f.ports,
        setInterval(callback: Function, delay: number) {
            assert.equal(delay, 1000);
            const lease = { callback, hasRef: () => true };
            keepers.add(lease);
            registered.push(lease);
            return lease;
        },
        clearInterval(lease: any) {
            clears++;
            keepers.delete(lease);
        },
    });
    assert.ok(result);
    assert.equal(result.releaseAcceptance, false);
    assert.equal(keepers.size, 0);
    assert.equal(clears, 1);
    registered[0].callback();
    assert.equal(clears, 1);
    const held = await fixture();
    held.controls.adapterFailure = true;
    held.controls.bootstrapUnknown = true;
    await assert.rejects(
        entry.observeGatewayHealthJob(held.runtime, {
            ...held.ports,
            setInterval(callback: Function) {
                const lease = { callback, hasRef: () => true };
                keepers.add(lease);
                return lease;
            },
            clearInterval(lease: any) {
                keepers.delete(lease);
            },
        }),
    );
    assert.equal(keepers.size, 1); // Authored memory lease only; no real interval was created.
});

test('an unsupported Promise keeper is consumed and refuses before the producer is called', async () => {
    const entry = await import('../scripts/observe-gateway-health-job.mjs');
    const f = await fixture();
    let clears = 0;
    await assert.rejects(
        entry.observeGatewayHealthJob(f.runtime, {
            ...f.ports,
            setInterval() {
                return Promise.reject(undefined);
            },
            clearInterval() {
                clears++;
            },
        }),
    );
    await Promise.resolve();
    assert.deepEqual(f.events, []);
    assert.equal(f.selectedAdapters.length, 0);
    assert.equal(f.reports.length, 0);
    assert.equal(clears, 0);
});

test('keeper close throw preserves the existing job failure including its raw undefined cause', async () => {
    const entry = await import('../scripts/observe-gateway-health-job.mjs');
    const f = await fixture();
    f.controls.buildFailure = true;
    let keeper: any,
        clears = 0;
    const cleanupFailure = Error('authored keeper close failure');
    const error = await entry
        .observeGatewayHealthJob(f.runtime, {
            ...f.ports,
            setInterval(callback: Function) {
                keeper = { callback, hasRef: () => true };
                return keeper;
            },
            clearInterval() {
                clears++;
                throw cleanupFailure;
            },
        })
        .catch((value: unknown) => value);
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Gateway health job failed; original state retained.');
    assert.equal(error.cause, undefined);
    assert.equal(Reflect.get(error, 'owner').snapshot().failed, true);
    assert.notEqual(error, cleanupFailure);
    assert.equal(clears, 1);
    keeper.callback();
    assert.equal(clears, 1);
    assert.equal(f.selectedAdapters.length, 0);
    assert.equal(f.reports.length, 0);
});

test('a rejected Promise keeper-close acknowledgment fails observation and cannot be resubmitted by a later tick', async () => {
    const entry = await import('../scripts/observe-gateway-health-job.mjs');
    const f = await fixture();
    let keeper: any,
        clears = 0;
    const error = await entry
        .observeGatewayHealthJob(f.runtime, {
            ...f.ports,
            setInterval(callback: Function) {
                keeper = { callback, hasRef: () => true };
                return keeper;
            },
            clearInterval() {
                clears++;
                return Promise.reject(undefined);
            },
        })
        .catch((value: unknown) => value);
    await Promise.resolve();
    assert.ok(error instanceof Error);
    assert.match(error.message, /Keeper closure uncertain/);
    assert.equal(f.runInputs.length, 1);
    assert.equal(f.reports.length, 1);
    assert.equal(clears, 1);
    keeper.callback();
    await Promise.resolve();
    assert.equal(clears, 1);
});
