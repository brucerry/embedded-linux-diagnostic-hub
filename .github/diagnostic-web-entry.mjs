// Non-shipping, explicitly admitted one-job entry. CI preconditions precede native acquisition.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createOwnedWebFiles } from '../scripts/lib/owned-web-files.mjs';
import { createDiagnosticWebExecution, validateDiagnosticWebContext, DIAGNOSTIC_WEB_POLICY } from '../scripts/lib/diagnostic-web-execution.mjs';
import { main } from '../scripts/produce-web-archive.mjs';
import { readStableArtifactFile } from '../scripts/lib/web-archive-producer.mjs';
import { inspectDiagnosticWebBuild } from '../scripts/lib/diagnostic-web-inspection.mjs';
import { runHeldWebProducer } from '../scripts/lib/owned-web-build.mjs';

await runHeldWebProducer(async () => {
    const env = process.env;
    validateDiagnosticWebContext({ repository: env.GITHUB_REPOSITORY, private: env.HUB_REPOSITORY_PRIVATE === 'false' ? false : true,
        ref: env.GITHUB_REF, event: env.GITHUB_EVENT_NAME, attempt: env.GITHUB_RUN_ATTEMPT, runner: env.RUNNER_ENVIRONMENT,
        system: env.RUNNER_OS, arch: env.RUNNER_ARCH, sha: env.GITHUB_SHA, run: env.GITHUB_RUN_ID, policy: env.HUB_DIAGNOSTIC_WEB_POLICY });
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.deepEqual(process.execArgv, []);
    for (const key of ['NODE_OPTIONS', 'NODE_PATH']) assert.equal(env[key], undefined);
    assert.ok(!Object.keys(env).some((key) => key.startsWith('VITE_')));
    const bootstrap = createOwnedWebFiles(fs), io = bootstrap.filesystem;
    const root = await io.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    assert.equal(await io.realpath(env.GITHUB_WORKSPACE), root);
    const nodePath = await io.realpath(process.execPath), gitPath = await io.realpath('/usr/bin/git');
    assert.equal(gitPath, '/usr/bin/git');
    const gitBytes = (await readStableArtifactFile('/usr/bin', 'git', 16 * 1024 ** 2, io)).bytes;
    const gitSHA256 = createHash('sha256').update(gitBytes).digest('hex');
    const vitePath = await io.realpath(root + '/node_modules/vite/bin/vite.js');
    bootstrap.owner.assertSettled();
    const context = { repository: env.GITHUB_REPOSITORY, private: false, ref: env.GITHUB_REF, event: env.GITHUB_EVENT_NAME,
        attempt: env.GITHUB_RUN_ATTEMPT, runner: env.RUNNER_ENVIRONMENT, system: env.RUNNER_OS, arch: env.RUNNER_ARCH,
        sha: env.GITHUB_SHA, run: env.GITHUB_RUN_ID, policy: DIAGNOSTIC_WEB_POLICY };
    const admitted = createDiagnosticWebExecution({ context, root, gitPath, gitSHA256, nodePath, vitePath,
        environment: { PATH: path.dirname(nodePath) + ':/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' } }, {
        filesystem: fs, launch: (file, args, options) => spawn(file, args, options),
        setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: (timer) => { clearTimeout(timer); }, now: () => performance.now(),
    });
    const expected = { scope: 'web', version: env.SELECTED_VERSION, sourceCommit: env.GITHUB_SHA,
        sourceTree: env.SELECTED_TREE, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, jobKey: env.GITHUB_JOB };
    await main(Object.entries({ scope: expected.scope, version: expected.version, 'source-commit': expected.sourceCommit,
        'source-tree': expected.sourceTree, 'run-id': expected.runId, 'run-attempt': expected.runAttempt,
        'job-key': expected.jobKey, output: 'validation/web-source' }).map(([k, v]) => '--' + k + '=' + v), admitted.capability);
    const output = root + '/validation/web-source', name = 'Diagnostic-Hub-Web-' + expected.version + '.zip';
    const read = async (file, maximum) => (await readStableArtifactFile(output, file, maximum, admitted.capability.filesystem)).bytes;
    const record = await read('web-build.json', 16 * 1024 ** 2), archive = await read(name, 128 * 1024 ** 2), checksum = await read(name + '.sha256', 1024);
    const { bytes } = inspectDiagnosticWebBuild(record, archive, checksum, expected,
        { completed: true, exitCode: 0, signal: null, timedOut: false }, admitted.policy.kind);
    admitted.capability.assertSettled();
    process.stdout.write('HUB_DIAGNOSTIC_WEB_RECEIPT=' + bytes.toString('utf8'));
}, { setExitCode: (code) => { process.exitCode = code; }, report: (message) => console.error(message) });
