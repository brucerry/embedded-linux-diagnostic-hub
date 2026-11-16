import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createOwnedWebFiles } from './owned-web-files.mjs';
import { localSourceProvider } from './committed-source-provider.mjs';
import { observeSourceBridge } from './committed-source-bridge.mjs';
import {
    createGitHubSourceSelector,
    createGitHubSourceSelectorModel,
} from './github-service-metadata.mjs';
import {
    createCurrentGatewayBuildExecution,
    createTagGatewayBuildExecution,
    validateCurrentGatewayBuildContext,
    validateTagGatewayBuildContext,
    readCurrentGatewayBuildFile,
    CURRENT_GATEWAY_BUILD_LEAF,
} from './current-gateway-build.mjs';
import {
    createGatewayReleaseDraftCaller,
    createGatewayBranchBuildCaller,
} from './gateway-release-caller.mjs';
const digest = (b) => createHash('sha256').update(b).digest('hex');
const retained = new Map();
let nativeUsed = false;
export class GatewayJobBootstrapFailure extends Error {
    constructor(cause, owner) {
        super('Gateway native bootstrap failed; outputs and uncertain custody retained.', {
            cause,
        });
        this.owner = owner;
    }
}
function makeBootstrap(input, ports, selectorFactory, mode) {
    const runtime = structuredClone(input);
    let used = false,
        failed = false,
        complete = false,
        phase = 'ready',
        coverage = null,
        selector = null,
        execution = null,
        files = null,
        callbackActive = false;
    const noActiveFiles = (value) =>
        value &&
        ['pending', 'handles'].every((key) => Number.isSafeInteger(value[key]) && value[key] === 0);
    const bootstrap = Object.freeze({
        snapshot: () =>
            Object.freeze({
                mode,
                used,
                failed,
                complete,
                phase,
                coverage,
                selector: selector?.snapshot() ?? null,
                execution: execution?.snapshot() ?? null,
                files: files?.owner.snapshot() ?? null,
                callbackActive,
                jobAuthentication: null,
                uploadAttribution: null,
                releaseAcceptance: false,
            }),
        quiescent() {
            // Known-zero owned IO permits a failed worker to exit. Publication tombstones remain
            // retained data uncertainty, not an open handle. These counters are not success,
            // authentication, whole-group retirement or permission to erase retained data.
            try {
                if (callbackActive || (files && !noActiveFiles(files.owner.snapshot())))
                    return false;
                if (selector && selector.snapshot().pending !== 0) return false;
                if (execution) {
                    const value = execution.snapshot();
                    if (
                        value.commandOwners !== 0 ||
                        value.files?.gitOwners !== 0 ||
                        !noActiveFiles(value.files?.files)
                    )
                        return false;
                }
                return true;
            } catch {
                return false;
            }
        },
        async run() {
            assert.ok(!used, 'Gateway job bootstrap is one-shot.');
            used = true;
            retained.set(bootstrap, null);
            try {
                phase = 'runtime';
                const env = runtime.environment;
                assert.equal(env.GITHUB_ACTIONS, 'true');
                assert.equal(runtime.platform, 'linux');
                assert.equal(runtime.arch, 'x64');
                assert.match(runtime.version, /^v24\./);
                assert.deepEqual(runtime.execArgv, []);
                assert.ok(Number.isSafeInteger(runtime.uid) && runtime.uid > 0);
                assert.equal(runtime.argv[1], runtime.entryFile);
                if (runtime.argv.length === 2) coverage = 'tag-job';
                else {
                    assert.equal(runtime.argv.length, 3);
                    assert.equal(runtime.argv[2], '--qualify-branch');
                    coverage = 'branch-qualification';
                }
                for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ESBUILD_BINARY_PATH'])
                    assert.equal(env[name], undefined);
                files = createOwnedWebFiles(ports.filesystem);
                const io = files.filesystem;
                const read = (file, maximum, filesystem = io) =>
                    readCurrentGatewayBuildFile(file, maximum, runtime.uid, filesystem);
                const root = await io.realpath(path.resolve(path.dirname(runtime.entryFile), '..'));
                assert.equal(await io.realpath(env.GITHUB_WORKSPACE), root);
                assert.equal(await io.realpath(env.GITHUB_EVENT_PATH), env.GITHUB_EVENT_PATH);
                const event = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(
                        await read(env.GITHUB_EVENT_PATH, 4 * 1024 ** 2),
                    ),
                );
                const labels = {
                    repository: env.GITHUB_REPOSITORY,
                    private: event.repository?.private,
                    event: env.GITHUB_EVENT_NAME,
                    ref: env.GITHUB_REF,
                    sha: env.GITHUB_SHA,
                    runId: env.GITHUB_RUN_ID,
                    runAttempt: env.GITHUB_RUN_ATTEMPT,
                    jobKey: env.GITHUB_JOB,
                    workflowRef: env.GITHUB_WORKFLOW_REF,
                    workflowSHA: env.GITHUB_WORKFLOW_SHA,
                    runner: env.RUNNER_ENVIRONMENT,
                    system: env.RUNNER_OS,
                    arch: env.RUNNER_ARCH,
                };
                const context =
                    coverage === 'tag-job'
                        ? validateTagGatewayBuildContext(labels)
                        : validateCurrentGatewayBuildContext(labels);
                assert.equal(event.repository?.full_name, context.repository);
                assert.equal(event.ref, context.ref);
                assert.equal(event.deleted, false);
                assert.match(event.after, /^[a-f0-9]{40}$/);
                if (coverage === 'branch-qualification') assert.equal(event.after, context.sha);
                const dependencies = await io.lstat(root + '/node_modules');
                assert.ok(dependencies.isDirectory() && !dependencies.isSymbolicLink());
                assert.equal(await io.realpath(root + '/node_modules'), root + '/node_modules');
                const nodePath = await io.realpath(runtime.execPath);
                assert.equal(nodePath, runtime.execPath);
                assert.ok((await io.lstat(nodePath)).mode & 0o100);
                const gitPath = await io.realpath('/usr/bin/git');
                assert.equal(gitPath, '/usr/bin/git');
                const gitSHA256 = digest(await read(gitPath, 16 * 1024 ** 2));
                const esbuildPath = root + '/node_modules/esbuild/bin/esbuild';
                assert.equal(await io.realpath(esbuildPath), esbuildPath);
                const npmPath =
                    path.dirname(path.dirname(nodePath)) + '/lib/node_modules/npm/bin/npm-cli.js';
                assert.equal(await io.realpath(npmPath), npmPath);
                const observed = async (filesystem = io) => {
                    const entry = await read(esbuildPath, 64 * 1024, filesystem),
                        npmPackage = await read(
                            path.dirname(path.dirname(npmPath)) + '/package.json',
                            1024 ** 2,
                            filesystem,
                        );
                    return {
                        runtime: {
                            executablePath: nodePath,
                            executableSHA256: digest(
                                await read(nodePath, 128 * 1024 ** 2, filesystem),
                            ),
                            node: runtime.version,
                            platform: runtime.platform,
                            arch: runtime.arch,
                            versions: { ...runtime.versions },
                            execArgv: [...runtime.execArgv],
                            nodeOptions: null,
                        },
                        esbuildEntryPath: esbuildPath,
                        esbuildEntryBytes: entry,
                        esbuildEntrySHA256: digest(entry),
                        esbuildEntryFormat: 'node-script',
                        npmEntryPath: npmPath,
                        npmEntrySHA256: digest(await read(npmPath, 1024 ** 2, filesystem)),
                        npmVersion: JSON.parse(
                            new TextDecoder('utf-8', { fatal: true }).decode(npmPackage),
                        ).version,
                        npmPackageSHA256: digest(npmPackage),
                    };
                };
                await observed();
                files.owner.assertSettled();
                phase = 'independent-source';
                selector = selectorFactory({
                    repository: context.repository,
                    ref: context.ref,
                    sourceCommit: context.sha,
                    kind: coverage === 'tag-job' ? 'tag' : 'branch',
                });
                const pin = await selector.select();
                selector.assertSettled();
                if (coverage === 'tag-job')
                    assert.ok(
                        event.after === pin.objectID || event.after === pin.sourceCommit,
                        'Push source is outside the independently selected ref/source pins.',
                    );
                const environment = {
                    PATH: path.dirname(nodePath) + ':/usr/bin:/bin',
                    LANG: 'C.UTF-8',
                    LC_ALL: 'C.UTF-8',
                    TZ: 'UTC',
                };
                const selection = {
                    context,
                    root,
                    gitPath,
                    gitSHA256,
                    nodePath,
                    esbuildPath,
                    npmPath,
                    environment,
                };
                execution = (
                    coverage === 'tag-job'
                        ? createTagGatewayBuildExecution
                        : createCurrentGatewayBuildExecution
                )(selection, ports);
                const sourceFactory = (selectedRoot) =>
                    localSourceProvider(selectedRoot, {
                        filesystem: execution.filesystem,
                        execute: execution.executeGit,
                        asynchronous: true,
                        platform: runtime.platform,
                        environment: execution.gitEnvironment,
                    });
                phase = 'local-source';
                const provider = await sourceFactory(root),
                    state = await provider.state();
                assert.equal(state.sourceCommit, pin.sourceCommit);
                assert.equal(state.sourceTree, pin.sourceTree);
                await observeSourceBridge(
                    { sourceCommit: pin.sourceCommit, sourceTree: pin.sourceTree },
                    provider,
                );
                const sourcePackage = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(
                        (await provider.file('package.json')).bytes,
                    ),
                );
                const expected = {
                    scope: 'gateway',
                    version: sourcePackage.version,
                    sourceCommit: pin.sourceCommit,
                    sourceTree: pin.sourceTree,
                    runId: context.runId,
                    runAttempt: context.runAttempt,
                    jobKey: context.jobKey,
                };
                if (coverage === 'tag-job')
                    assert.equal(context.ref, `refs/tags/v${expected.version}`);
                await execution.filesystem.mkdir(root + '/validation'); // Fresh only, never adopt/retry/cleanup.
                const build = {
                    filesystem: execution.filesystem,
                    sourceFactory,
                    execute: execution.execute,
                    writeExclusive: execution.writeExclusive,
                    readArtifact: (file, maximum) => read(file, maximum, execution.filesystem),
                    observeToolchain: () => observed(execution.filesystem),
                };
                const options = { sourceRoot: root, leaf: CURRENT_GATEWAY_BUILD_LEAF };
                const callerSelection =
                    coverage === 'tag-job'
                        ? {
                              repository: context.repository,
                              tagRef: context.ref,
                              tagObjectID: pin.objectID,
                              context: expected,
                              options,
                              git: { gitPath, gitSHA256, environment },
                          }
                        : { repository: context.repository, context: expected, options };
                const callerPorts = {
                    build,
                    tag: ports,
                    assertSettled() {
                        execution.assertSettled();
                        files.owner.assertSettled();
                        selector.assertSettled();
                    },
                };
                phase = 'canonical-producer-readback';
                const result = await (
                    coverage === 'tag-job'
                        ? createGatewayReleaseDraftCaller
                        : createGatewayBranchBuildCaller
                )(callerSelection, callerPorts).run();
                if (coverage === 'tag-job')
                    assert.deepEqual(
                        result.binding.tag.chain.map((row) => ({ oid: row.oid, type: row.type })),
                        pin.chain,
                    );
                const bindingBytes = Buffer.from(
                    JSON.stringify({
                        schemaVersion: 1,
                        kind: 'gateway-native-source-binding',
                        mode,
                        coverage,
                        sourceSelection: pin,
                        sourceObservations: selector.diagnostics(),
                        originalBuildRecord: result.originalBuildRecord,
                        tag: result.binding?.tag ?? null,
                        jobAuthentication: null,
                        originalEventObjectAuthentication: null,
                        uploadAttribution: null,
                        nativeQualification: false,
                        releaseAcceptance: false,
                    }) + '\n',
                );
                assert.ok(bindingBytes.length <= 1024 ** 2);
                const bindingPath = root + '/validation/gateway-source-binding.json';
                await execution.writeExclusive(bindingPath, bindingBytes);
                assert.ok(
                    (await read(bindingPath, 1024 ** 2, execution.filesystem)).equals(bindingBytes),
                );
                let healthSmoke;
                if (ports.afterReadback !== undefined) {
                    assert.equal(coverage, 'branch-qualification');
                    assert.equal(typeof ports.afterReadback, 'function');
                    callbackActive = true;
                    try {
                        healthSmoke = await ports.afterReadback(
                            Object.freeze({
                                context: structuredClone(expected),
                                sourceSelection: structuredClone(pin),
                                sourceRoot: root,
                                record: structuredClone(result.record),
                                originalBuildRecord: { ...result.originalBuildRecord },
                                readFile: (file, maximum) =>
                                    read(file, maximum, execution.filesystem),
                                realpath: (file) => execution.filesystem.realpath(file),
                                lstat: (file) => execution.filesystem.lstat(file),
                                async sourceFile(name) {
                                    const rows = result.record.sourceBridge.inventory.filter(
                                        (row) => row.path === name,
                                    );
                                    assert.equal(rows.length, 1);
                                    const file = await provider.file(name);
                                    assert.ok(
                                        Buffer.isBuffer(file.bytes) &&
                                            file.bytes.length <= 4 * 1024 ** 2,
                                    );
                                    assert.equal(file.mode, rows[0].mode);
                                    assert.equal(file.bytes.length, rows[0].bytes);
                                    assert.equal(digest(file.bytes), rows[0].sha256);
                                    return Buffer.from(file.bytes);
                                },
                            }),
                        );
                    } finally {
                        callbackActive = false;
                    }
                }
                execution.assertSettled();
                files.owner.assertSettled();
                selector.assertSettled();
                complete = true;
                phase = 'complete';
                retained.delete(bootstrap);
                return Object.freeze({
                    coverage,
                    sourceSelection: pin,
                    sourceBinding: Object.freeze({
                        name: 'gateway-source-binding.json',
                        bytes: bindingBytes.length,
                        sha256: digest(bindingBytes),
                    }),
                    result,
                    jobAuthentication: null,
                    uploadAttribution: null,
                    nativeQualification: false,
                    releaseAcceptance: false,
                    ...(ports.afterReadback === undefined ? {} : { healthSmoke }),
                });
            } catch (cause) {
                failed = true;
                phase = 'failed';
                retained.set(bootstrap, cause);
                throw new GatewayJobBootstrapFailure(cause, bootstrap);
            }
        },
    });
    return bootstrap;
}
/** Real native entry: source and tools must already be admitted by the external job owner.
 * It performs bounded public metadata GETs and build/readback only, never installation/upload.
 */
export async function buildGatewayArchiveFromSelectedJob() {
    return runNativeEntry(
        fileURLToPath(new URL('../build-gateway-tag-archive.mjs', import.meta.url)),
    );
}
/** Fixed branch-only sibling for the current-job health driver; old build/tag callers have no hook. */
export async function buildGatewayArchiveForHealthJob(afterReadback, onOwner) {
    assert.equal(typeof afterReadback, 'function');
    assert.equal(typeof onOwner, 'function');
    assert.equal(process.argv[2], '--qualify-branch');
    return runNativeEntry(
        fileURLToPath(new URL('../observe-gateway-health-job.mjs', import.meta.url)),
        afterReadback,
        onOwner,
    );
}
async function runNativeEntry(entryFile, afterReadback, onOwner) {
    assert.equal(nativeUsed, false);
    nativeUsed = true;
    const names = [
        'GITHUB_ACTIONS',
        'GITHUB_WORKSPACE',
        'GITHUB_EVENT_PATH',
        'GITHUB_REPOSITORY',
        'GITHUB_EVENT_NAME',
        'GITHUB_REF',
        'GITHUB_SHA',
        'GITHUB_RUN_ID',
        'GITHUB_RUN_ATTEMPT',
        'GITHUB_JOB',
        'GITHUB_WORKFLOW_REF',
        'GITHUB_WORKFLOW_SHA',
        'RUNNER_ENVIRONMENT',
        'RUNNER_OS',
        'RUNNER_ARCH',
        'NODE_OPTIONS',
        'NODE_PATH',
        'ESBUILD_BINARY_PATH',
    ];
    const environment = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const runtime = {
        environment,
        entryFile,
        argv: [...process.argv],
        execArgv: [...process.execArgv],
        execPath: process.execPath,
        version: process.version,
        versions: { ...process.versions },
        platform: process.platform,
        arch: process.arch,
        uid: process.getuid(),
    };
    const bootstrap = makeBootstrap(
        runtime,
        {
            filesystem: fs,
            launch: (file, args, options) => spawn(file, args, options),
            now: () => performance.now(),
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (timer) => clearTimeout(timer),
            ...(afterReadback === undefined ? {} : { afterReadback }),
        },
        createGitHubSourceSelector,
        'native-unqualified',
    );
    onOwner?.(bootstrap);
    return bootstrap.run();
}
/** Same orchestration and selector algorithms with explicit inert host boundaries only. */
export function createGatewayJobBootstrapModel(runtime, ports, httpsHost, httpClock) {
    return makeBootstrap(
        runtime,
        ports,
        (selection) => createGitHubSourceSelectorModel(selection, httpsHost, httpClock),
        'injected-model-unqualified',
    );
}
