import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOwnedWebFiles } from './owned-web-files.mjs';
import { startOwnedGitRead, validateOwnedGitRequest } from './owned-git-read.mjs';
import path from 'node:path';
import { readStableArtifactFile } from './stable-artifact-file.mjs';
const admitted = new WeakSet();
/** Explicit complete child profile. It never reads ambient environment or redirects HOME. */
export function webChildEnvironments(value) {
    assert.deepEqual(Object.keys(value).sort(), ['LANG', 'LC_ALL', 'PATH', 'TZ']);
    assert.equal(value.LANG, 'C.UTF-8');
    assert.equal(value.LC_ALL, 'C.UTF-8');
    assert.equal(value.TZ, 'UTC');
    assert.ok(
        typeof value.PATH === 'string' &&
            value.PATH.length <= 4096 &&
            value.PATH.split(':').every(
                (p) =>
                    p.startsWith('/') &&
                    path.posix.normalize(p) === p &&
                    !/[\\\x00-\x20\x7f]/.test(p),
            ),
    );
    const base = Object.freeze({
            PATH: value.PATH,
            LANG: value.LANG,
            LC_ALL: value.LC_ALL,
            TZ: value.TZ,
        }),
        git = Object.freeze({
            ...base,
            GIT_NO_LAZY_FETCH: '1',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
        }),
        build = Object.freeze({ ...base, NODE_ENV: 'production', WEB_BASE_PATH: './' });
    const sha256 = createHash('sha256').update(JSON.stringify({ git, build })).digest('hex');
    return Object.freeze({ git, build, sha256 });
}
/** Source-owned capability, not a serialized permission or OS-group receipt. No native defaults. */
export function createOwnedWebCapabilities(selection, ports) {
    for (const k of ['launch', 'setTimer', 'clearTimer', 'now'])
        assert.equal(typeof ports?.[k], 'function');
    assert.deepEqual(Object.keys(selection).sort(), ['environment', 'gitPath', 'gitSHA256']);
    selection = structuredClone(selection);
    assert.ok(
        selection.gitPath?.startsWith('/') &&
            path.posix.normalize(selection.gitPath) === selection.gitPath,
    );
    assert.match(selection.gitSHA256, /^[a-f0-9]{64}$/);
    const profile = webChildEnvironments(selection.environment),
        files = createOwnedWebFiles(ports.filesystem),
        gitOwners = new Set();
    let primary;
    async function verifyGit() {
        const bytes = (
            await readStableArtifactFile(
                path.posix.dirname(selection.gitPath),
                path.posix.basename(selection.gitPath),
                16 * 1024 ** 2,
                files.filesystem,
            )
        ).bytes;
        assert.equal(createHash('sha256').update(bytes).digest('hex'), selection.gitSHA256);
    }
    const capability = Object.freeze({
        filesystem: files.filesystem,
        files: files.owner,
        profile,
        gitEnvironment: profile.git,
        buildEnvironment: profile.build,
        launch: ports.launch,
        setTimer: ports.setTimer,
        clearTimer: ports.clearTimer,
        now: ports.now,
        async executeGit(binary, args, options) {
            args = structuredClone(args);
            options = structuredClone(options);
            validateOwnedGitRequest(args, options.input);
            assert.ok(options.missing === undefined || typeof options.missing === 'boolean');
            assert.ok(
                !options.missing || args.includes('config'),
                'Missing-result policy is only for the fixed config query.',
            );
            assert.equal(binary, 'git');
            assert.ok(!primary && gitOwners.size === 0);
            assert.equal(options.timeout, undefined);
            assert.deepEqual(options.env, profile.git);
            const lease = { owner: null, closed: false, done: false };
            gitOwners.add(lease);
            try {
                await verifyGit();
                const owner = startOwnedGitRead(
                    {
                        executable: selection.gitPath,
                        args,
                        cwd: options.cwd,
                        env: profile.git,
                        input: options.input,
                        maximum: options.maxBuffer,
                    },
                    ports,
                );
                lease.owner = owner;
                void owner.closed.then(() => {
                    lease.closed = true;
                    if (lease.done) gitOwners.delete(lease);
                });
                const result = await owner.result;
                await verifyGit();
                if (
                    result.code === 1 &&
                    options.missing &&
                    result.stdout.length === 0 &&
                    result.stderr.length === 0
                )
                    return Buffer.alloc(0);
                assert.equal(result.code, 0);
                return result.stdout;
            } catch (e) {
                primary ??= e;
                throw e;
            } finally {
                lease.done = true;
                if (!lease.owner || lease.closed) gitOwners.delete(lease);
            }
        },
        assertSettled() {
            assert.equal(gitOwners.size, 0);
            files.owner.assertSettled();
            if (primary) throw primary;
        },
        snapshot: () => ({
            files: files.owner.snapshot(),
            gitOwners: gitOwners.size,
            primaryFailure: Boolean(primary),
            completeChildEnvironmentSHA256: profile.sha256,
            processGroupRetirement: null,
        }),
    });
    admitted.add(capability);
    return capability;
}
export function requireOwnedWebCapabilities(value) {
    assert.ok(
        value && admitted.has(value),
        'Default producer execution held: source-owned Git/file/environment capabilities required.',
    );
    return value;
}
