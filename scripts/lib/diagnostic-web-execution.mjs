import assert from 'node:assert/strict';
import path from 'node:path';
import { createOwnedWebCapabilities, webChildEnvironments } from './owned-web-capabilities.mjs';
import { ownedGitRequestKind } from './owned-git-read.mjs';

export const DIAGNOSTIC_WEB_BRANCH = 'ci/web-build-diagnostic-96a56cd-20261105';
export const DIAGNOSTIC_WEB_POLICY = 'github-hosted-diagnostic-teardown-unproved-group-v1';
/** Preconditions only: these values are not an independent service identity or permission token.
 * The controller must separately verify the approved exact public branch/commit/run via GitHub.
 */
export function validateDiagnosticWebContext(value) {
    assert.deepEqual(Object.keys(value).sort(), ['arch', 'attempt', 'event', 'policy', 'private', 'ref',
        'repository', 'run', 'runner', 'sha', 'system']);
    assert.equal(value.repository, 'brucerry/embedded-linux-diagnostic-hub');
    assert.equal(value.private, false);
    assert.equal(value.ref, 'refs/heads/' + DIAGNOSTIC_WEB_BRANCH);
    assert.equal(value.event, 'push'); assert.equal(value.attempt, '1');
    assert.equal(value.runner, 'github-hosted'); assert.equal(value.system, 'Linux'); assert.equal(value.arch, 'X64');
    assert.equal(value.policy, DIAGNOSTIC_WEB_POLICY);
    assert.match(value.sha, /^[a-f0-9]{40}$/); assert.match(value.run, /^[1-9][0-9]*$/);
    return Object.freeze({ ...value });
}

/** Explicit diagnostic-only capability, with no native defaults. It narrows the existing owned
 * Git/file/build ports to one source root, Git executable, Node/Vite entry and fresh output scope.
 * No signal, deletion, retry, credential, endpoint, or whole-group retirement capability is added.
 */
export function createDiagnosticWebExecution(selection, ports) {
    const context = validateDiagnosticWebContext(selection.context);
    const selected = structuredClone(selection);
    for (const name of ['root', 'gitPath', 'nodePath', 'vitePath']) {
        assert.ok(typeof selected[name] === 'string' && selected[name].startsWith('/') &&
            path.posix.normalize(selected[name]) === selected[name] && !/[\\\x00-\x20\x7f]/.test(selected[name]));
    }
    assert.equal(selected.gitPath, '/usr/bin/git');
    assert.equal(selected.vitePath, selected.root + '/node_modules/vite/bin/vite.js');
    assert.match(selected.gitSHA256, /^[a-f0-9]{64}$/);
    const profile = webChildEnvironments(selected.environment);
    assert.equal(profile.build.PATH, path.dirname(selected.nodePath) + ':/usr/bin:/bin');
    for (const name of ['launch', 'setTimer', 'clearTimer', 'now']) assert.equal(typeof ports[name], 'function');
    const launch = ports.launch, setTimer = ports.setTimer, clearTimer = ports.clearTimer, now = ports.now;
    let buildIssued = false;
    const cap = createOwnedWebCapabilities({ gitPath: selected.gitPath, gitSHA256: selected.gitSHA256,
        environment: selected.environment }, {
        filesystem: ports.filesystem, setTimer, clearTimer, now,
        launch(executable, args, options) {
            assert.equal(options.cwd, selected.root); assert.equal(options.shell, false);
            assert.ok(!Object.hasOwn(options, 'timeout') && !Object.hasOwn(options, 'signal') && !Object.hasOwn(options, 'detached'));
            if (executable === selected.gitPath) {
                // Actual batch input/callback custody is validated by the existing Git owner.
                const batch = ownedGitRequestKind(args) === 'batch';
                assert.deepEqual(options.env, profile.git);
                assert.deepEqual(options.stdio, [batch ? 'pipe' : 'ignore', 'pipe', 'pipe']);
            } else {
                assert.equal(buildIssued, false, 'No diagnostic build replay');
                assert.equal(executable, selected.nodePath);
                assert.deepEqual(args, [selected.vitePath, 'build', '--config', selected.root + '/vite.config.mts',
                    '--mode', 'web', '--outDir', selected.root + '/validation/web-source/site']);
                assert.deepEqual(options.env, profile.build);
                assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
                buildIssued = true; // Register before dispatch; an uncertain launch is never retried.
            }
            return launch(executable, args, options);
        },
    });
    return Object.freeze({ capability: cap, context,
        policy: Object.freeze({ kind: DIAGNOSTIC_WEB_POLICY, timeoutCancellation: 'may-use-runner-teardown',
            gracefulWholeGroupRetirement: null, releaseAcceptance: false }) });
}
