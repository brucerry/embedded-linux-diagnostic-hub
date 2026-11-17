// Standalone runtime stage. It never calls a producer or creates an SSH fixture.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createOwnedWebFiles } from './lib/owned-web-files.mjs';
import { readCurrentGatewayBuildFile } from './lib/current-gateway-build.mjs';
import { GATEWAY_RUNTIME_CHILD_FILES } from './lib/gateway-runtime-input-bridge.mjs';
import { createGatewaySmokePhysicalAdapter } from './lib/gateway-smoke-physical.mjs';
import { parseGatewayPackageHandoff } from './lib/gateway-package-handoff.mjs';
import { readGatewayRuntimePackage } from './check-gateway-runtime-package.mjs';
import { startInstrumentedChildOutput } from './lib/instrumented-gateway-output.mjs';

export const TWO_STAGE_BRANCH = 'ci/v060-gateway-two-stage-20261117';
export const RUNTIME_COMPLETE =
    'Gateway runtime health/auth/normal-close complete; no SSH or release qualification.\n';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function selectRuntimeStage(runtime) {
    const e = runtime.environment;
    for (const [key, value] of Object.entries({
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/' + TWO_STAGE_BRANCH,
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'gateway_build',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
    }))
        assert.equal(e[key], value);
    assert.match(e.GITHUB_SHA, /^[a-f0-9]{40}$/);
    assert.match(e.GITHUB_RUN_ID, /^[1-9][0-9]{0,31}$/);
    assert.equal(e.GITHUB_WORKFLOW_SHA, e.GITHUB_SHA);
    assert.equal(
        e.GITHUB_WORKFLOW_REF,
        'brucerry/embedded-linux-diagnostic-hub/.github/workflows/gateway-publisher-node-buildonly.yml@' +
            e.GITHUB_REF,
    );
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ESBUILD_BINARY_PATH'])
        assert.equal(e[name], undefined);
    assert.equal(runtime.platform, 'linux');
    assert.equal(runtime.arch, 'x64');
    assert.equal(runtime.version, 'v24.22.2');
    assert.deepEqual(runtime.execArgv, []);
    assert.ok(Number.isSafeInteger(runtime.uid) && runtime.uid > 0);
    for (const value of [e.GITHUB_WORKSPACE, e.RUNNER_TEMP]) {
        assert.ok(
            typeof value === 'string' &&
                value !== '/' &&
                value.startsWith('/') &&
                value.length <= 4096,
        );
        assert.equal(path.posix.normalize(value), value);
        assert.ok(!/[\\\x00-\x20\x7f]/.test(value));
    }
    const nodePath = e.RUNNER_TEMP + '/gateway-publisher-node-' + e.GITHUB_RUN_ID + '-1/bin/node';
    assert.equal(runtime.execPath, nodePath);
    return {
        sourceRoot: e.GITHUB_WORKSPACE,
        temporaryRoot: e.RUNNER_TEMP,
        nodePath,
        uid: runtime.uid,
        sourceCommit: e.GITHUB_SHA,
    };
}

const retained = new Set();
export function createRuntimeStage(runtime, handoff, originalHash, ports) {
    let active = false,
        used = false,
        adapter;
    const unknownFactories = new Set();
    const synchronous = (value) => {
        if (value && typeof value.then === 'function') {
            unknownFactories.add(value);
            Promise.resolve(value).catch(() => {});
            throw Error('Unsupported asynchronous custody snapshot.');
        }
        assert.ok(value && typeof value === 'object');
        return value;
    };
    const zeroFiles = (s) => s && ['pending', 'handles'].every((k) => s[k] === 0);
    const owner = {
        quiescent() {
            try {
                if (
                    active ||
                    unknownFactories.size ||
                    !zeroFiles(synchronous(ports.files.owner.snapshot()))
                )
                    return false;
                if (!adapter) return true;
                const s = synchronous(adapter.owner.snapshot());
                return (
                    ['pendingCalls', 'nativeHandles', 'unknownReturns'].every((k) => s[k] === 0) &&
                    zeroFiles(s.files) &&
                    Array.isArray(s.bridges) &&
                    s.bridges.every(
                        (b) =>
                            b.pendingCalls === 0 &&
                            b.unknownReturns === 0 &&
                            (b.directClosed === true ||
                                (b.child?.directRetired === true &&
                                    b.child.unknownOperations === 0)),
                    ) &&
                    Array.isArray(s.children) &&
                    s.children.every((c) =>
                        ['exit', 'close', 'stdin', 'stdout', 'stderr'].every((k) => c[k] === true),
                    )
                );
            } catch {
                return false;
            }
        },
        async run() {
            assert.equal(used, false);
            used = true;
            active = true;
            retained.add(owner);
            try {
                return await runStage(runtime, handoff, originalHash, ports, (created) => {
                    if (created && typeof created.then === 'function') {
                        unknownFactories.add(created);
                        Promise.resolve(created).catch(() => {});
                        throw Error('Unsupported adapter factory return.');
                    }
                    adapter = created;
                    assert.equal(typeof adapter?.owner?.snapshot, 'function');
                    return adapter;
                });
            } catch (cause) {
                throw Object.assign(
                    Error('Gateway runtime stage failed; original custody retained.', { cause }),
                    { owner },
                );
            } finally {
                active = false;
                if (owner.quiescent()) retained.delete(owner);
            }
        },
    };
    return owner;
}
export async function runRuntimeStage(...args) {
    return createRuntimeStage(...args).run();
}
async function runStage(runtime, handoff, originalHash, ports, takeAdapter) {
    const selected = selectRuntimeStage(runtime);
    assert.match(originalHash, /^[a-f0-9]{64}$/);
    assert.equal(digest(handoff), originalHash);
    const expected = parseGatewayPackageHandoff(handoff);
    // The tree is the original producer's service-selected identity, never a staged record label.
    const { record, readback } = await ports.readPackage(
        handoff,
        originalHash,
        { sourceCommit: selected.sourceCommit, sourceTree: expected.context.sourceTree },
        selected.sourceRoot,
        ports.files.filesystem,
        selected.uid,
    );
    assert.equal(expected.context.runId, runtime.environment.GITHUB_RUN_ID);
    assert.equal(expected.context.runAttempt, '1');
    assert.equal(expected.context.jobKey, 'gateway_build');
    const read = (name, maximum) =>
        readCurrentGatewayBuildFile(name, maximum, selected.uid, ports.files.filesystem);
    const sourceFile = async (name, maximum) => {
        const rows = record.sourceBridge.inventory.filter((row) => row.path === name);
        assert.equal(rows.length, 1);
        const file = selected.sourceRoot + '/' + name;
        const bytes = await read(file, maximum);
        assert.equal(bytes.length, rows[0].bytes);
        assert.equal(digest(bytes), rows[0].sha256);
        assert.equal(
            (await ports.files.filesystem.lstat(file)).mode & 0o100 ? '100755' : '100644',
            rows[0].mode,
        );
        return bytes;
    };
    const profile = JSON.parse(
        (await sourceFile('scripts/ci/gateway-four-tool-inputs.json', 16384)).toString(),
    );
    assert.equal(profile.node.version, '24.22.2');
    assert.equal(record.builder.runtime.executablePath, selected.nodePath);
    assert.equal(record.builder.runtime.node, 'v24.22.2');
    assert.equal(record.builder.runtime.executableSHA256, profile.node.sha256);
    assert.equal((await ports.files.filesystem.lstat(selected.nodePath)).size, profile.node.bytes);
    const systemRoot = await ports.files.systemRoot.lstat();
    assert.ok(
        systemRoot.isDirectory() &&
            !systemRoot.isSymbolicLink() &&
            systemRoot.uid === 0 &&
            !(systemRoot.mode & 0o7022),
    );
    assert.equal(await ports.files.systemRoot.realpath(), '/');
    for (const parent of ['/usr', '/usr/bin']) {
        const row = await ports.files.filesystem.lstat(parent);
        assert.ok(
            row.isDirectory() && !row.isSymbolicLink() && row.uid === 0 && !(row.mode & 0o7022),
        );
        assert.equal(await ports.files.filesystem.realpath(parent), parent);
    }
    const alias = await ports.files.filesystem.lstat('/usr/bin/python3');
    assert.equal(alias.uid, 0);
    assert.ok(alias.isSymbolicLink() || (alias.isFile() && !(alias.mode & 0o7022)));
    const pythonPath = await ports.files.filesystem.realpath('/usr/bin/python3');
    assert.match(pythonPath, /^\/usr\/bin\/python3\.\d{1,2}$/);
    const py = await ports.files.filesystem.lstat(pythonPath);
    assert.ok(
        py.isFile() &&
            !py.isSymbolicLink() &&
            py.uid === 0 &&
            py.nlink === 1 &&
            !(py.mode & 0o7022) &&
            py.mode & 0o111,
    );
    const pythonSHA256 = digest(await read(pythonPath, 32 * 1024 ** 2));
    const sourceFiles = {};
    for (const name of GATEWAY_RUNTIME_CHILD_FILES) {
        const bytes = await sourceFile(name, 4 * 1024 ** 2);
        sourceFiles[name] = digest(bytes);
    }
    ports.files.owner.assertSettled();
    const adapter = takeAdapter(
        ports.makeAdapter({
            sourceRoot: selected.sourceRoot,
            temporaryRoot: selected.temporaryRoot,
            nodePath: selected.nodePath,
            uid: selected.uid,
            pythonPath,
            pythonSHA256,
            sourceFiles,
        }),
    );
    assert.ok(adapter && typeof adapter.run === 'function');
    const result = await adapter.run({
        sourceRoot: selected.sourceRoot,
        temporaryRoot: selected.temporaryRoot,
        uid: selected.uid,
        readback,
        expected,
        builder: record.builder,
    });
    assert.equal(result.releaseAcceptance, false);
    assert.deepEqual(result.originalBuildRecord, expected.buildRecord);
    assert.equal(result.runtime.receipt.status, 'cli-health-auth-and-direct-close-observed');
    assert.deepEqual(
        result.runtime.receipt.checks.map((row) => row.status),
        [200, 401, 403],
    );
    adapter.ports.assertSettled();
    return result;
}

let outputAttempted = false;
async function emit(which, bytes) {
    assert.equal(outputAttempted, false);
    outputAttempted = true;
    await startInstrumentedChildOutput(bytes, process[which], () => {
        process.exitCode = 1;
    }).result;
}
async function main() {
    try {
        const { observeOwnedGatewayJob } = await import('./observe-gateway-health-job.mjs');
        assert.equal(process.argv.length, 3);
        const chunks = [];
        let total = 0,
            count = 0;
        for await (const bytes of process.stdin) {
            total += bytes.length;
            assert.ok(Buffer.isBuffer(bytes) && total <= 16384 && ++count <= 1024);
            chunks.push(bytes);
        }
        await observeOwnedGatewayJob(
            createRuntimeStage(
                {
                    environment: process.env,
                    platform: process.platform,
                    arch: process.arch,
                    version: process.version,
                    execArgv: process.execArgv,
                    uid: process.getuid(),
                    execPath: process.execPath,
                },
                Buffer.concat(chunks),
                process.argv[2],
                {
                    files: createOwnedWebFiles(fs),
                    readPackage: readGatewayRuntimePackage,
                    makeAdapter: createGatewaySmokePhysicalAdapter,
                },
            ),
            { setInterval, clearInterval },
        );
        await emit('stdout', Buffer.from(RUNTIME_COMPLETE));
    } catch {
        process.exitCode = 1;
        if (!outputAttempted)
            try {
                await emit(
                    'stderr',
                    Buffer.from('Gateway separate runtime stage failed; custody retained.\n'),
                );
            } catch {
                /* No uncertain output retry. */
            }
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    void main();
