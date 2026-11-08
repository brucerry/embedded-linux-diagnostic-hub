import assert from 'node:assert/strict';
import test from 'node:test';
import {
    validateCurrentGatewayBuildContext,
    currentGatewayBuildCommand,
    createCurrentGatewayBuildExecution,
    readCurrentGatewayBuildFile,
} from '../scripts/lib/current-gateway-build.mjs';

// Explicit input models only: no process.env changes, native CLI import, producer or receipt.
const repository = 'brucerry/embedded-linux-diagnostic-hub';
const context = () => ({
    repository,
    private: false,
    event: 'push',
    ref: 'refs/heads/current-build',
    sha: 'a'.repeat(40),
    runId: '123',
    runAttempt: '1',
    jobKey: 'gateway_build',
    workflowRef: repository + '/.github/workflows/current-build.yml@refs/heads/current-build',
    workflowSHA: 'a'.repeat(40),
    runner: 'github-hosted',
    system: 'Linux',
    arch: 'X64',
});
const selected = () => ({
    root: '/owned/source',
    nodePath: '/owned/toolchain/bin/node',
    esbuildPath: '/owned/source/node_modules/esbuild/bin/esbuild',
    npmPath: '/owned/toolchain/lib/node_modules/npm/bin/npm-cli.js',
});

test('current branch push and workflow dispatch validate without a historical branch or Node-minor claim', () => {
    for (const event of ['push', 'workflow_dispatch']) {
        const input = { ...context(), event },
            value = validateCurrentGatewayBuildContext(input);
        assert.deepEqual(value, input);
        assert.ok(Object.isFrozen(value));
        assert.notEqual(value, input);
    }
});
for (const [name, delta] of [
    ['other repository', { repository: 'other/repository' }],
    ['private repository', { private: true }],
    ['pull request', { event: 'pull_request' }],
    ['rerun', { runAttempt: '2' }],
    ['zero run', { runId: '0' }],
    ['leading-zero run', { runId: '0123' }],
    ['non-numeric run', { runId: 'local-task' }],
    ['invalid job key', { jobKey: 'gateway build' }],
    ['self-hosted runner', { runner: 'self-hosted' }],
    ['wrong OS', { system: 'Windows' }],
    ['wrong architecture', { arch: 'ARM64' }],
    ['wrong source SHA', { sha: 'not-a-sha' }],
    ['different workflow source', { workflowSHA: 'b'.repeat(40) }],
    ['tag source', { ref: 'refs/tags/v0.6.0' }],
    ['parent-like branch', { ref: 'refs/heads/current/../build' }],
    [
        'wrong workflow owner',
        {
            workflowRef:
                'other/repository/.github/workflows/current-build.yml@refs/heads/current-build',
        },
    ],
    [
        'different workflow ref',
        { workflowRef: repository + '/.github/workflows/current-build.yml@refs/heads/other' },
    ],
    [
        'nested workflow path',
        {
            workflowRef:
                repository + '/.github/workflows/nested/build.yml@refs/heads/current-build',
        },
    ],
    ['unknown context field', { arbitraryGrant: true }],
])
    test('current-job preconditions reject ' + name, () =>
        assert.throws(() => validateCurrentGatewayBuildContext({ ...context(), ...delta })),
    );

test('the build command names the actual source, tools and fresh output exactly', () => {
    const s = selected(),
        command = currentGatewayBuildCommand(s, 'build');
    assert.deepEqual(command, [
        s.nodePath,
        s.esbuildPath,
        s.root + '/gateway/main.ts',
        '--bundle',
        '--platform=node',
        '--format=cjs',
        '--outfile=/owned/source/validation/gateway-current-build/build/main.cjs',
        '--external:ssh2',
    ]);
    assert.ok(Object.isFrozen(command));
});
test('lock command is offline with scripts, workspaces, global scope and ambient config disabled', () => {
    const s = selected();
    assert.deepEqual(currentGatewayBuildCommand(s, 'lock'), [
        s.nodePath,
        s.npmPath,
        'install',
        '--package-lock-only',
        '--offline',
        '--ignore-scripts',
        '--omit=optional',
        '--no-audit',
        '--no-fund',
        '--global=false',
        '--workspaces=false',
        '--prefix=/owned/source/validation/gateway-current-build/stage',
        '--cache=/owned/source/validation/gateway-current-build/cache',
        '--userconfig=/owned/source/validation/gateway-current-build/config/user.npmrc',
        '--globalconfig=/owned/source/validation/gateway-current-build/config/global.npmrc',
    ]);
});
for (const [name, delta] of [
    ['filesystem root', { root: '/' }],
    ['relative source', { root: 'source' }],
    ['noncanonical source', { root: '/owned/../source' }],
    ['injected whitespace', { nodePath: '/owned/tool chain/bin/node' }],
    ['different compiler', { esbuildPath: '/other/esbuild/bin/esbuild' }],
    ['different npm prefix', { npmPath: '/other/npm/bin/npm-cli.js' }],
])
    test('fixed command rejects ' + name, () =>
        assert.throws(() => currentGatewayBuildCommand({ ...selected(), ...delta }, 'build')),
    );
test('no arbitrary command role or unknown selection field is admitted', () => {
    assert.throws(() => currentGatewayBuildCommand(selected(), 'install'));
    assert.throws(() =>
        currentGatewayBuildCommand({ ...selected(), command: ['unexpected'] }, 'build'),
    );
});
test('execution preparation has no filesystem, launch or timer effects and supplies no retirement authority', () => {
    let effects = 0;
    const forbidden = () => {
        effects++;
        throw Error('Unexpected native effect in pure preparation');
    };
    const ports = {
        filesystem: {
            realpath: forbidden,
            lstat: forbidden,
            open: forbidden,
            opendir: forbidden,
            mkdir: forbidden,
        },
        launch: forbidden,
        setTimer: forbidden,
        clearTimer: forbidden,
        now: forbidden,
    };
    const execution = createCurrentGatewayBuildExecution(
        {
            ...selected(),
            context: context(),
            gitPath: '/usr/bin/git',
            gitSHA256: 'c'.repeat(64),
            environment: {
                PATH: '/owned/toolchain/bin:/usr/bin:/bin',
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                TZ: 'UTC',
            },
        },
        ports,
    );
    assert.equal(effects, 0);
    assert.equal(execution.snapshot().phase, 'build');
    assert.equal(execution.snapshot().commandOwners, 0);
    assert.equal(execution.snapshot().wholeGroupRetirement, null);
    assert.equal(execution.snapshot().releaseAcceptance, false);
    assert.throws(() => execution.assertSettled());
    assert.equal(effects, 0);
});

function memoryFile(change) {
    const bytes = Buffer.from('tool-bytes');
    const metadata = {
        dev: 1,
        ino: 2,
        uid: 1000,
        gid: 1000,
        mode: 0o100700,
        nlink: 1,
        size: bytes.length,
        mtimeMs: 10,
        ctimeMs: 10,
        isFile: () => true,
        isSymbolicLink: () => false,
    };
    const counts = { lstat: 0, open: 0, stat: 0, read: 0, close: 0 };
    let position = 0;
    const filesystem = {
        async realpath(value) {
            return value;
        },
        async lstat() {
            counts.lstat++;
            return { ...metadata, ...change?.('lstat', counts.lstat) };
        },
        async open() {
            counts.open++;
            return {
                async stat() {
                    counts.stat++;
                    return { ...metadata, ...change?.('stat', counts.stat) };
                },
                async read(buffer, offset, length) {
                    counts.read++;
                    const size = Math.min(length, bytes.length - position);
                    bytes.copy(buffer, offset, position, position + size);
                    position += size;
                    return { bytesRead: size };
                },
                async close() {
                    counts.close++;
                },
            };
        },
    };
    return { filesystem, counts, bytes };
}
test('bounded build-input reader joins the same admitted pathname and descriptor through close', async () => {
    const f = memoryFile();
    assert.deepEqual(
        await readCurrentGatewayBuildFile('/owned/tool', 1024, 1000, f.filesystem),
        f.bytes,
    );
    assert.equal(f.counts.open, 1);
    assert.equal(f.counts.close, 1);
    assert.equal(f.counts.lstat, 3);
    assert.equal(f.counts.stat, 2);
});
for (const [name, field] of [
    ['replacement inode', { ino: 3 }],
    ['different allowed owner', { uid: 0 }],
    ['writable mode', { mode: 0o100722 }],
])
    test(
        'build-input reader refuses ' +
            name +
            ' between initial admission and bounded-reader baseline',
        async () => {
            const f = memoryFile((kind, count) => (kind === 'lstat' && count === 2 ? field : {}));
            await assert.rejects(
                readCurrentGatewayBuildFile('/owned/tool', 1024, 1000, f.filesystem),
            );
            assert.equal(f.counts.open, 0);
            assert.equal(f.counts.read, 0);
            assert.equal(f.counts.close, 0);
        },
    );
for (const [name, field] of [
    ['descriptor replacement', { ino: 3 }],
    ['descriptor owner change', { uid: 0 }],
])
    test(
        'build-input reader refuses ' + name + ' before reading and still closes the actual handle',
        async () => {
            const f = memoryFile((kind, count) => (kind === 'stat' && count === 1 ? field : {}));
            await assert.rejects(
                readCurrentGatewayBuildFile('/owned/tool', 1024, 1000, f.filesystem),
            );
            assert.equal(f.counts.open, 1);
            assert.equal(f.counts.read, 0);
            assert.equal(f.counts.close, 1);
        },
    );
for (const changed of ['lstat', 'stat'])
    test(
        'post-read ' + changed + ' replacement is refused with actual handle closure',
        async () => {
            const f = memoryFile((kind, count) =>
                kind === changed && count === (changed === 'lstat' ? 3 : 2) ? { ino: 3 } : {},
            );
            await assert.rejects(
                readCurrentGatewayBuildFile('/owned/tool', 1024, 1000, f.filesystem),
            );
            assert.equal(f.counts.open, 1);
            assert.ok(f.counts.read > 0);
            assert.equal(f.counts.close, 1);
        },
    );
