import assert from 'node:assert/strict';
import path from 'node:path';
import { createOwnedWebCapabilities, webChildEnvironments } from './owned-web-capabilities.mjs';
import { ownedGitRequestKind } from './owned-git-read.mjs';
import { startDiagnosticGatewayCommand } from './diagnostic-gateway-command.mjs';
import { DIAGNOSTIC_GATEWAY_POLICY } from './diagnostic-gateway-inspection.mjs';

export const DIAGNOSTIC_GATEWAY_BRANCH = 'ci/gateway-build-diagnostic-96a56cd-20261105';
export const DIAGNOSTIC_GATEWAY_RUNTIME_BRANCH = 'ci/gateway-runtime-diagnostic-96a56cd-20261105';
export function validateDiagnosticGatewayContext(value) { return validateContext(value, DIAGNOSTIC_GATEWAY_BRANCH); }
export function validateDiagnosticGatewayRuntimeContext(value) { return validateContext(value, DIAGNOSTIC_GATEWAY_RUNTIME_BRANCH); }
function validateContext(value, branch) {
    assert.deepEqual(Object.keys(value).sort(), ['arch', 'attempt', 'event', 'policy', 'private', 'ref', 'repository', 'run', 'runner', 'sha', 'system']);
    assert.equal(value.repository, 'brucerry/embedded-linux-diagnostic-hub');
    assert.equal(value.private, false);
    assert.equal(value.ref, 'refs/heads/' + branch);
    assert.equal(value.event, 'push'); assert.equal(value.attempt, '1');
    assert.equal(value.runner, 'github-hosted'); assert.equal(value.system, 'Linux'); assert.equal(value.arch, 'X64');
    assert.equal(value.policy, DIAGNOSTIC_GATEWAY_POLICY);
    assert.match(value.sha, /^[a-f0-9]{40}$/); assert.match(value.run, /^[1-9][0-9]*$/);
    return Object.freeze({ ...value }); // Preconditions, not independent service identity or permission.
}

/** One owned build followed by one offline lock command; no native defaults or cleanup escape. */
export function createDiagnosticGatewayExecution(selection, ports) { return createExecution(selection, ports, validateDiagnosticGatewayContext); }
export function createDiagnosticGatewayRuntimeBuildExecution(selection, ports) { return createExecution(selection, ports, validateDiagnosticGatewayRuntimeContext); }
function createExecution(selection, ports, validate) {
    ports = Object.freeze({ ...ports });
    const selected = structuredClone(selection), context = validate(selected.context);
    for (const name of ['root', 'gitPath', 'nodePath', 'esbuildPath', 'npmPath'])
        assert.ok(typeof selected[name] === 'string' && selected[name].startsWith('/') &&
            path.posix.normalize(selected[name]) === selected[name] && !/[\\\x00-\x20\x7f]/.test(selected[name]));
    assert.equal(selected.gitPath, '/usr/bin/git');
    assert.equal(selected.esbuildPath, selected.root + '/node_modules/esbuild/bin/esbuild');
    assert.equal(selected.npmPath, path.dirname(path.dirname(selected.nodePath)) + '/lib/node_modules/npm/bin/npm-cli.js');
    const profile = webChildEnvironments(selected.environment);
    assert.equal(profile.git.PATH, path.dirname(selected.nodePath) + ':/usr/bin:/bin');
    const environment = Object.freeze({ ...selected.environment, NODE_ENV: 'production' });
    const cap = createOwnedWebCapabilities({ gitPath: selected.gitPath, gitSHA256: selected.gitSHA256, environment: selected.environment }, {
        ...ports,
        launch(executable, args, options) {
            assert.equal(executable, selected.gitPath);
            const batch = ownedGitRequestKind(args) === 'batch';
            assert.equal(options.cwd, selected.root); assert.equal(options.shell, false);
            assert.deepEqual(options.env, profile.git);
            assert.deepEqual(options.stdio, [batch ? 'pipe' : 'ignore', 'pipe', 'pipe']);
            return ports.launch(executable, args, options);
        },
    });
    const directory = selected.root + '/validation/gateway-diagnostic', owners = new Set();
    let phase = 'build', ownerIdentity = null, previousId = 0, primary;
    return Object.freeze({
        context, filesystem: cap.filesystem, executeGit: cap.executeGit, gitEnvironment: cap.gitEnvironment,
        writeExclusive: (file, bytes) => cap.filesystem.writeFile(file, bytes, { flag: 'wx' }),
        async execute(plan) {
            assert.ok(!primary && owners.size === 0);
            assert.deepEqual(Object.keys(plan).sort(), ['command', 'cwd', 'id', 'owner', 'role']);
            assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.command));
            assert.equal(plan.role, phase);
            assert.match(plan.owner, /^[a-f0-9]{32}$/);
            assert.ok(Number.isSafeInteger(plan.id) && plan.id > previousId);
            if (ownerIdentity !== null) assert.equal(plan.owner, ownerIdentity);
            const expected = phase === 'build' ? [selected.nodePath, selected.esbuildPath, selected.root + '/gateway/main.ts',
                '--bundle', '--platform=node', '--format=cjs', '--outfile=' + directory + '/build/main.cjs', '--external:ssh2']
                : [selected.nodePath, selected.npmPath, 'install', '--package-lock-only', '--offline', '--ignore-scripts',
                    '--omit=optional', '--no-audit', '--no-fund', '--global=false', '--workspaces=false',
                    '--prefix=' + directory + '/stage', '--cache=' + directory + '/cache',
                    '--userconfig=' + directory + '/config/user.npmrc', '--globalconfig=' + directory + '/config/global.npmrc'];
            assert.deepEqual(plan.command, expected);
            assert.equal(plan.cwd, phase === 'build' ? selected.root : directory + '/stage');
            ownerIdentity = plan.owner; previousId = plan.id;
            phase = phase === 'build' ? 'lock' : 'complete'; // Before dispatch: no replay on uncertain acquisition.
            const lease = { owner: null, closed: false, done: false }; owners.add(lease);
            try {
                const owned = startDiagnosticGatewayCommand(plan, environment, ports); lease.owner = owned;
                void owned.closed.then(() => { lease.closed = true; if (lease.done) owners.delete(lease); });
                return await owned.result;
            } catch (error) { primary ??= error; throw error; }
            finally { lease.done = true; if (lease.closed) owners.delete(lease); }
        },
        assertSettled() {
            assert.equal(phase, 'complete'); assert.equal(owners.size, 0);
            cap.assertSettled(); if (primary) throw primary;
        },
        snapshot: () => ({ phase, commandOwners: owners.size, failed: Boolean(primary), processGroupRetirement: null }),
    });
}
