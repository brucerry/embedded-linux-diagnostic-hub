// Real build CLI. Activate only inside an independently admitted external service-owned scope.
// Import defines functions only; no bootstrap, build, listener, hook or process is started.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createOwnedWebFiles } from './lib/owned-web-files.mjs';
import { localSourceProvider } from './lib/committed-source-provider.mjs';
import { observeSourceBridge } from './lib/committed-source-bridge.mjs';
import { produceGatewayArchive } from './lib/gateway-archive-producer.mjs';
import { parseGatewayArchiveBuildRecord } from './lib/gateway-build-record.mjs';
import { openGatewayArchiveBytes } from './lib/inner-archive-inspection.mjs';
import { startInstrumentedChildOutput } from './lib/instrumented-gateway-output.mjs';
import {
    CURRENT_GATEWAY_BUILD_LEAF,
    createCurrentGatewayBuildExecution,
    validateCurrentGatewayBuildContext,
    readCurrentGatewayBuildFile,
} from './lib/current-gateway-build.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let activated = false,
    outputAttempted = false;
function emit(which, bytes) {
    assert.equal(outputAttempted, false);
    outputAttempted = true;
    let inherited;
    const stream = {
        on(event, listener) {
            inherited ??= process[which];
            const value = inherited.on(event, listener);
            return value === inherited ? stream : value;
        },
        write(value, callback) {
            assert.ok(inherited);
            return inherited.write(value, callback);
        },
    };
    return startInstrumentedChildOutput(bytes, stream, () => {
        process.exitCode = 1;
    });
}

/** Native build, not a custody/provenance authenticator. The external controller must establish
 * the real job, fresh source/dependencies and supported whole-process scope BEFORE invoking this.
 * No env flag, JSON receipt, child exit or command timeout substitutes for that admission. */
export async function buildGatewayArchiveFromCurrentJob() {
    assert.equal(activated, false, 'Build entry is one-use.');
    activated = true;
    const env = process.env;
    assert.equal(env.GITHUB_ACTIONS, 'true');
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    assert.match(process.version, /^v24\./);
    assert.deepEqual(process.execArgv, []);
    assert.equal(process.argv.length, 2);
    const uid = process.getuid();
    assert.ok(Number.isSafeInteger(uid) && uid > 0);
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ESBUILD_BINARY_PATH'])
        assert.equal(env[key], undefined);
    const bootstrap = createOwnedWebFiles(fs),
        io = bootstrap.filesystem;
    const read = (file, maximum, filesystem = io) =>
        readCurrentGatewayBuildFile(file, maximum, uid, filesystem);
    const root = await io.realpath(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    );
    assert.equal(await io.realpath(env.GITHUB_WORKSPACE), root);
    assert.equal(await io.realpath(env.GITHUB_EVENT_PATH), env.GITHUB_EVENT_PATH);
    const event = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
            await read(env.GITHUB_EVENT_PATH, 4 * 1024 ** 2),
        ),
    );
    const context = validateCurrentGatewayBuildContext({
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
    });
    assert.equal(event.repository?.full_name, context.repository);
    if (context.event === 'push') {
        assert.equal(event.after, context.sha);
        assert.equal(event.ref, context.ref);
    }
    const dependencies = await io.lstat(root + '/node_modules');
    assert.ok(dependencies.isDirectory() && !dependencies.isSymbolicLink());
    assert.equal(await io.realpath(root + '/node_modules'), root + '/node_modules');
    const nodePath = await io.realpath(process.execPath);
    assert.equal(nodePath, process.execPath);
    const nodeStat = await io.lstat(nodePath);
    assert.ok(nodeStat.mode & 0o100);
    const gitPath = await io.realpath('/usr/bin/git');
    assert.equal(gitPath, '/usr/bin/git');
    const gitSHA256 = digest(await read(gitPath, 16 * 1024 ** 2));
    const esbuildPath = root + '/node_modules/esbuild/bin/esbuild';
    assert.equal(await io.realpath(esbuildPath), esbuildPath);
    const npmPath = path.dirname(path.dirname(nodePath)) + '/lib/node_modules/npm/bin/npm-cli.js';
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
                executableSHA256: digest(await read(nodePath, 128 * 1024 ** 2, filesystem)),
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                versions: { ...process.versions },
                execArgv: [...process.execArgv],
                nodeOptions: null,
            },
            esbuildEntryPath: esbuildPath,
            esbuildEntryBytes: entry,
            esbuildEntrySHA256: digest(entry),
            esbuildEntryFormat: 'node-script',
            npmEntryPath: npmPath,
            npmEntrySHA256: digest(await read(npmPath, 1024 ** 2, filesystem)),
            npmVersion: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(npmPackage))
                .version,
            npmPackageSHA256: digest(npmPackage),
        };
    };
    // Observe supplied tools before output creation; the producer validates its descriptors before staging.
    await observed();
    bootstrap.owner.assertSettled();
    const execution = createCurrentGatewayBuildExecution(
        {
            context,
            root,
            gitPath,
            gitSHA256,
            nodePath,
            esbuildPath,
            npmPath,
            environment: {
                PATH: path.dirname(nodePath) + ':/usr/bin:/bin',
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                TZ: 'UTC',
            },
        },
        {
            filesystem: fs,
            launch: (file, args, options) => spawn(file, args, options),
            setTimer: setTimeout,
            clearTimer: (timer) => {
                clearTimeout(timer);
            },
            now: () => performance.now(),
        },
    );
    const sourceFactory = (selectedRoot) =>
        localSourceProvider(selectedRoot, {
            filesystem: execution.filesystem,
            execute: execution.executeGit,
            asynchronous: true,
            platform: process.platform,
            environment: execution.gitEnvironment,
        });
    const provider = await sourceFactory(root),
        state = await provider.state();
    assert.equal(state.sourceCommit, context.sha);
    await observeSourceBridge(
        { sourceCommit: state.sourceCommit, sourceTree: state.sourceTree },
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
        sourceCommit: state.sourceCommit,
        sourceTree: state.sourceTree,
        runId: context.runId,
        runAttempt: context.runAttempt,
        jobKey: context.jobKey,
    };
    await execution.filesystem.mkdir(root + '/validation'); // Fresh checkout only; EEXIST retains failure, never adopts prior data.
    const result = await produceGatewayArchive(
        expected,
        { sourceRoot: root, leaf: CURRENT_GATEWAY_BUILD_LEAF },
        {
            filesystem: execution.filesystem,
            sourceFactory,
            execute: execution.execute,
            writeExclusive: execution.writeExclusive,
            observeToolchain: () => observed(execution.filesystem),
        },
    );
    assert.equal(result.owner.failed, false);
    assert.equal(result.owner.sealed, true);
    const directory = root + '/validation/' + CURRENT_GATEWAY_BUILD_LEAF + '/artifacts';
    const recordBytes = await read(
        directory + '/gateway-build.json',
        16 * 1024 ** 2,
        execution.filesystem,
    );
    const record = parseGatewayArchiveBuildRecord(recordBytes, expected);
    const archive = await read(
        directory + '/' + record.archive.name,
        128 * 1024 ** 2,
        execution.filesystem,
    );
    const checksum = await read(directory + '/' + record.checksum.name, 1024, execution.filesystem);
    assert.equal(archive.length, record.archive.bytes);
    assert.equal(digest(archive), record.archive.sha256);
    assert.ok(
        checksum.equals(Buffer.from(record.archive.sha256 + '  ' + record.archive.name + '\n')),
    );
    const contents = openGatewayArchiveBytes(archive, record);
    try {
        for (const row of record.payload) {
            const bytes = contents.read(row.path);
            assert.equal(bytes.length, row.bytes);
            assert.equal(digest(bytes), row.sha256);
        }
    } finally {
        contents.releaseBytes();
    }
    execution.assertSettled();
    bootstrap.owner.assertSettled();
    return { record, owner: result.owner };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await buildGatewayArchiveFromCurrentJob();
        await emit('stdout', Buffer.from('Gateway archive and canonical build record retained.\n'))
            .result;
    } catch {
        process.exitCode = 1;
        if (!outputAttempted) {
            try {
                await emit(
                    'stderr',
                    Buffer.from(
                        'Gateway build failed or custody remains uncertain; outputs retained, no retry or cleanup.\n',
                    ),
                ).result;
            } catch {
                /* Existing write owner retains unknown output custody; do not retry. */
            }
        }
    }
}
