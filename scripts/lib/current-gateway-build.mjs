import assert from 'node:assert/strict';
import path from 'node:path';
import { createOwnedWebCapabilities, webChildEnvironments } from './owned-web-capabilities.mjs';
import { ownedGitRequestKind } from './owned-git-read.mjs';
import { startDiagnosticGatewayCommand } from './diagnostic-gateway-command.mjs';
import { readStableArtifactFile } from './stable-artifact-file.mjs';

const retained = new Set();
export const CURRENT_GATEWAY_BUILD_LEAF = 'gateway-current-build';
function absolute(value) {
    assert.ok(
        typeof value === 'string' && value.startsWith('/') && value !== '/' && value.length <= 4096,
    );
    assert.ok(path.posix.normalize(value) === value && !/[\\\x00-\x20\x7f]/.test(value));
}

/** Tie metadata admission to every pathname/descriptor observation in the existing bounded reader.
 * Filesystem must be the already-owned binding; it retains open/close uncertainty. This does not
 * prove immutability after the read or replace external ownership of executable/tool inputs. */
export async function readCurrentGatewayBuildFile(file, maximum, uid, filesystem) {
    absolute(file);
    assert.ok(Number.isSafeInteger(uid) && uid > 0);
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 128 * 1024 ** 2);
    const baseline = await filesystem.lstat(file);
    function checked(value) {
        assert.ok(value.isFile() && !value.isSymbolicLink() && value.nlink === 1);
        for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size'])
            assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0);
        assert.ok((value.uid === uid || value.uid === 0) && !(value.mode & 0o7022));
        assert.ok(Number.isFinite(value.mtimeMs) && Number.isFinite(value.ctimeMs));
        for (const key of [
            'dev',
            'ino',
            'uid',
            'gid',
            'mode',
            'nlink',
            'size',
            'mtimeMs',
            'ctimeMs',
        ])
            assert.equal(
                value[key],
                baseline[key],
                'Build input identity changed after admission.',
            );
        return value;
    }
    checked(baseline);
    const bound = {
        realpath: (value) => filesystem.realpath(value),
        lstat: async (value) => checked(await filesystem.lstat(value)),
        async open(value, flags) {
            const handle = await filesystem.open(value, flags);
            return {
                stat: async () => checked(await handle.stat()),
                read: (...args) => handle.read(...args),
                close: () => handle.close(),
            };
        },
    };
    return (await readStableArtifactFile(path.dirname(file), path.basename(file), maximum, bound))
        .bytes;
}

/** Current service metadata preconditions, not service authentication, permission or custody.
 * Native caller reads these from the real job/event. No old branch, source or Node-minor pin is
 * reinterpreted here. Authentic run/job/attempt association remains the external controller's job. */
export function validateCurrentGatewayBuildContext(value) {
    assert.deepEqual(Object.keys(value).sort(), [
        'arch',
        'event',
        'jobKey',
        'private',
        'ref',
        'repository',
        'runAttempt',
        'runId',
        'runner',
        'sha',
        'system',
        'workflowRef',
        'workflowSHA',
    ]);
    assert.equal(value.repository, 'brucerry/embedded-linux-diagnostic-hub');
    assert.equal(value.private, false);
    assert.ok(['push', 'workflow_dispatch'].includes(value.event));
    assert.equal(value.runAttempt, '1');
    assert.match(value.runId, /^[1-9][0-9]{0,31}$/);
    assert.match(value.jobKey, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/);
    assert.equal(value.runner, 'github-hosted');
    assert.equal(value.system, 'Linux');
    assert.equal(value.arch, 'X64');
    assert.match(value.sha, /^[a-f0-9]{40}$/);
    assert.equal(value.workflowSHA, value.sha);
    assert.match(value.ref, /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/);
    const branch = value.ref.slice('refs/heads/'.length);
    assert.ok(
        !branch.includes('..') &&
            !branch.includes('//') &&
            !branch.endsWith('/') &&
            !branch.endsWith('.lock'),
    );
    const prefix = value.repository + '/.github/workflows/',
        suffix = '@' + value.ref;
    assert.ok(
        typeof value.workflowRef === 'string' &&
            value.workflowRef.startsWith(prefix) &&
            value.workflowRef.endsWith(suffix),
    );
    assert.match(
        value.workflowRef.slice(prefix.length, -suffix.length),
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.ya?ml$/,
    );
    return Object.freeze({ ...value });
}

/** Same producer-issued build/lock commands, with an actual selected toolchain and fresh stage. */
export function currentGatewayBuildCommand(selection, role) {
    assert.deepEqual(Object.keys(selection).sort(), ['esbuildPath', 'nodePath', 'npmPath', 'root']);
    for (const value of Object.values(selection)) absolute(value);
    assert.equal(selection.esbuildPath, selection.root + '/node_modules/esbuild/bin/esbuild');
    assert.equal(
        selection.npmPath,
        path.dirname(path.dirname(selection.nodePath)) + '/lib/node_modules/npm/bin/npm-cli.js',
    );
    assert.ok(['build', 'lock'].includes(role));
    const stage = selection.root + '/validation/' + CURRENT_GATEWAY_BUILD_LEAF;
    return Object.freeze(
        role === 'build'
            ? [
                  selection.nodePath,
                  selection.esbuildPath,
                  selection.root + '/gateway/main.ts',
                  '--bundle',
                  '--platform=node',
                  '--format=cjs',
                  '--outfile=' + stage + '/build/main.cjs',
                  '--external:ssh2',
              ]
            : [
                  selection.nodePath,
                  selection.npmPath,
                  'install',
                  '--package-lock-only',
                  '--offline',
                  '--ignore-scripts',
                  '--omit=optional',
                  '--no-audit',
                  '--no-fund',
                  '--global=false',
                  '--workspaces=false',
                  '--prefix=' + stage + '/stage',
                  '--cache=' + stage + '/cache',
                  '--userconfig=' + stage + '/config/user.npmrc',
                  '--globalconfig=' + stage + '/config/global.npmrc',
              ],
    );
}

/** Existing native/fake ports only. No default launch, new process framework, cleanup, retry,
 * signal or service-lifetime grant. External service scope must own this caller before activation. */
export function createCurrentGatewayBuildExecution(selection, ports) {
    const selected = structuredClone(selection);
    assert.deepEqual(Object.keys(selected).sort(), [
        'context',
        'environment',
        'esbuildPath',
        'gitPath',
        'gitSHA256',
        'nodePath',
        'npmPath',
        'root',
    ]);
    const context = validateCurrentGatewayBuildContext(selected.context);
    const commandSelection = Object.freeze({
        root: selected.root,
        nodePath: selected.nodePath,
        esbuildPath: selected.esbuildPath,
        npmPath: selected.npmPath,
    });
    currentGatewayBuildCommand(commandSelection, 'build');
    assert.equal(selected.gitPath, '/usr/bin/git');
    const profile = webChildEnvironments(selected.environment);
    assert.equal(profile.git.PATH, path.dirname(selected.nodePath) + ':/usr/bin:/bin');
    ports = Object.freeze({ ...ports });
    const cap = createOwnedWebCapabilities(
        {
            gitPath: selected.gitPath,
            gitSHA256: selected.gitSHA256,
            environment: selected.environment,
        },
        {
            ...ports,
            launch(file, args, options) {
                assert.equal(file, selected.gitPath);
                const batch = ownedGitRequestKind(args) === 'batch';
                assert.equal(options.cwd, selected.root);
                assert.equal(options.shell, false);
                assert.deepEqual(options.env, profile.git);
                assert.deepEqual(options.stdio, [batch ? 'pipe' : 'ignore', 'pipe', 'pipe']);
                return ports.launch(file, args, options);
            },
        },
    );
    const environment = Object.freeze({ ...selected.environment, NODE_ENV: 'production' }),
        owners = new Set();
    let phase = 'build',
        ownerIdentity = null,
        previousId = 0,
        primary;
    const execution = Object.freeze({
        context,
        filesystem: cap.filesystem,
        executeGit: cap.executeGit,
        gitEnvironment: cap.gitEnvironment,
        writeExclusive: (file, bytes) => cap.filesystem.writeFile(file, bytes, { flag: 'wx' }),
        async execute(plan) {
            assert.ok(!primary && owners.size === 0);
            assert.deepEqual(Object.keys(plan).sort(), ['command', 'cwd', 'id', 'owner', 'role']);
            assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.command));
            assert.equal(plan.role, phase);
            assert.match(plan.owner, /^[a-f0-9]{32}$/);
            assert.ok(Number.isSafeInteger(plan.id) && plan.id > previousId);
            if (ownerIdentity !== null) assert.equal(plan.owner, ownerIdentity);
            assert.deepEqual(plan.command, currentGatewayBuildCommand(commandSelection, phase));
            assert.equal(
                plan.cwd,
                phase === 'build'
                    ? selected.root
                    : selected.root + '/validation/' + CURRENT_GATEWAY_BUILD_LEAF + '/stage',
            );
            ownerIdentity = plan.owner;
            previousId = plan.id;
            phase = phase === 'build' ? 'lock' : 'complete'; // Consume before dispatch; never retry uncertain effects.
            const lease = { owner: null, closed: false, done: false };
            owners.add(lease);
            retained.add(execution);
            try {
                const owner = startDiagnosticGatewayCommand(plan, environment, {
                    ...ports,
                    requireSpawnIdentity: true,
                });
                lease.owner = owner;
                void owner.closed.then(
                    () => {
                        lease.closed = true;
                        if (lease.done) owners.delete(lease);
                    },
                    (error) => {
                        primary ??= error;
                    },
                );
                const result = await owner.result;
                await owner.closed;
                return result;
            } catch (error) {
                primary ??= error;
                throw error;
            } finally {
                lease.done = true;
                if (lease.closed) owners.delete(lease);
            }
        },
        assertSettled() {
            assert.equal(phase, 'complete');
            assert.equal(owners.size, 0);
            cap.assertSettled();
            if (primary) throw primary;
            retained.delete(execution);
        },
        snapshot: () =>
            Object.freeze({
                phase,
                commandOwners: owners.size,
                failed: Boolean(primary),
                files: cap.snapshot(),
                wholeGroupRetirement: null,
                releaseAcceptance: false,
            }),
    });
    return execution;
}
