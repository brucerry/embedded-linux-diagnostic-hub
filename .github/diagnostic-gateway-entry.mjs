// Non-shipping diagnostic entry. Never imported by shipping code or local memory tests.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createOwnedWebFiles } from '../scripts/lib/owned-web-files.mjs';
import { createDiagnosticGatewayExecution, validateDiagnosticGatewayContext } from '../scripts/lib/diagnostic-gateway-execution.mjs';
import { inspectDiagnosticGatewayBuild, DIAGNOSTIC_GATEWAY_POLICY } from '../scripts/lib/diagnostic-gateway-inspection.mjs';
import { produceGatewayArchive } from '../scripts/lib/gateway-archive-producer.mjs';
import { localSourceProvider } from '../scripts/lib/committed-source-provider.mjs';
import { readStableArtifactFile } from '../scripts/lib/web-archive-producer.mjs';

try {
    const env = process.env;
    const context = validateDiagnosticGatewayContext({ repository: env.GITHUB_REPOSITORY, private: env.HUB_REPOSITORY_PRIVATE === 'false' ? false : true,
        ref: env.GITHUB_REF, event: env.GITHUB_EVENT_NAME, attempt: env.GITHUB_RUN_ATTEMPT, runner: env.RUNNER_ENVIRONMENT,
        system: env.RUNNER_OS, arch: env.RUNNER_ARCH, sha: env.GITHUB_SHA, run: env.GITHUB_RUN_ID, policy: env.HUB_DIAGNOSTIC_GATEWAY_POLICY });
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.deepEqual(process.execArgv, []);
    assert.equal(process.version, 'v24.22.0');
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ESBUILD_BINARY_PATH']) assert.equal(env[key], undefined);
    const bootstrap = createOwnedWebFiles(fs), io = bootstrap.filesystem;
    const root = await io.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    assert.equal(await io.realpath(env.GITHUB_WORKSPACE), root);
    const installed = await io.lstat(root + '/node_modules');
    assert.ok(installed.isDirectory() && !installed.isSymbolicLink());
    assert.equal(await io.realpath(root + '/node_modules'), root + '/node_modules');
    const nodePath = await io.realpath(process.execPath), gitPath = await io.realpath('/usr/bin/git');
    assert.equal(gitPath, '/usr/bin/git');
    const read = async (file, maximum, filesystem = io) => (await readStableArtifactFile(path.dirname(file), path.basename(file), maximum, filesystem)).bytes;
    const digest = (b) => createHash('sha256').update(b).digest('hex');
    const gitSHA256 = digest(await read(gitPath, 16 * 1024 ** 2));
    const esbuildPath = root + '/node_modules/esbuild/bin/esbuild';
    assert.equal(await io.realpath(esbuildPath), esbuildPath);
    const npmPath = path.dirname(path.dirname(nodePath)) + '/lib/node_modules/npm/bin/npm-cli.js';
    assert.equal(await io.realpath(npmPath), npmPath);
    bootstrap.owner.assertSettled();
    const admitted = createDiagnosticGatewayExecution({ context, root, gitPath, gitSHA256, nodePath, esbuildPath, npmPath,
        environment: { PATH: path.dirname(nodePath) + ':/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' } }, {
        filesystem: fs, launch: (file, args, options) => spawn(file, args, options),
        setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: (timer) => { clearTimeout(timer); }, now: () => performance.now(),
    });
    const filesystem = admitted.filesystem;
    const sourceFactory = (selectedRoot) => localSourceProvider(selectedRoot, { filesystem, execute: admitted.executeGit,
        asynchronous: true, platform: process.platform, environment: admitted.gitEnvironment });
    const expected = { scope: 'gateway', version: env.SELECTED_VERSION, sourceCommit: env.GITHUB_SHA,
        sourceTree: env.SELECTED_TREE, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, jobKey: env.GITHUB_JOB };
    const { owner } = await produceGatewayArchive(expected, { sourceRoot: root, leaf: 'gateway-diagnostic' }, {
        filesystem, sourceFactory, execute: admitted.execute, writeExclusive: admitted.writeExclusive,
        async observeToolchain() {
            const esbuildEntryBytes = await read(esbuildPath, 64 * 1024, filesystem);
            const npmPackageBytes = await read(path.dirname(path.dirname(npmPath)) + '/package.json', 1024 ** 2, filesystem);
            return { runtime: { executablePath: nodePath, executableSHA256: digest(await read(nodePath, 128 * 1024 ** 2, filesystem)),
                node: process.version, platform: process.platform, arch: process.arch, versions: { ...process.versions },
                execArgv: [...process.execArgv], nodeOptions: null },
                esbuildEntryPath: esbuildPath, esbuildEntryBytes, esbuildEntrySHA256: digest(esbuildEntryBytes), esbuildEntryFormat: 'node-script',
                npmEntryPath: npmPath, npmEntrySHA256: digest(await read(npmPath, 1024 ** 2, filesystem)),
                npmVersion: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(npmPackageBytes)).version,
                npmPackageSHA256: digest(npmPackageBytes) };
        },
    });
    assert.equal(owner.failed, false); assert.equal(owner.sealed, true);
    assert.equal(owner.command, null); assert.deepEqual(owner.pendingFiles, []);
    const output = root + '/validation/gateway-diagnostic/artifacts', name = 'Diagnostic-Hub-Gateway-' + expected.version + '.tar.gz';
    const record = await read(output + '/gateway-build.json', 16 * 1024 ** 2, filesystem);
    const archive = await read(output + '/' + name, 128 * 1024 ** 2, filesystem);
    const checksum = await read(output + '/' + name + '.sha256', 1024, filesystem);
    const { bytes } = inspectDiagnosticGatewayBuild(record, archive, checksum, expected,
        { completed: true, exitCode: 0, signal: null, timedOut: false }, DIAGNOSTIC_GATEWAY_POLICY);
    admitted.assertSettled();
    process.stdout.write('HUB_DIAGNOSTIC_GATEWAY_RECEIPT=' + bytes.toString('utf8'));
} catch {
    process.exitCode = 1;
    console.error('Gateway diagnostic failed or remains held. No retry, signal or cleanup was attempted.');
}
