import test from 'node:test';
import assert from 'node:assert/strict';
import {
    webBaselineEntryContext,
    inspectWebBaselineExecutable,
} from '../scripts/ci/run-web-baseline.mjs';

// Pure admission data and controlled metadata/FD ports. Never call the real entrypoint.
function context() {
    const environment = {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/ci/v060-web-chromedriver-baseline-20261117',
        GITHUB_JOB: 'web_baseline',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_RUN_ID: '123',
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
        GITHUB_WORKFLOW_REF:
            'brucerry/embedded-linux-diagnostic-hub/.github/workflows/web-public-baseline.yml@refs/heads/ci/v060-web-chromedriver-baseline-20261117',
        GITHUB_WORKSPACE: '/memory/source',
        GITHUB_EVENT_PATH: '/memory/service/event.json',
        RUNNER_TEMP: '/memory/temporary',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
    };
    return {
        environment,
        platform: 'linux',
        arch: 'x64',
        uid: 1000,
        euid: 1000,
        version: 'v24.22.2',
        executable: '/memory/temporary/web-baseline-inputs-123-1/node/bin/node',
        execArgv: [],
        args: [],
    };
}
function metadata() {
    const file = '/opt/google/chrome/chrome',
        calls = [];
    const directories = new Map(
        ['/', '/opt', '/opt/google', '/opt/google/chrome'].map((name, i) => [
            name,
            {
                uid: 0,
                gid: 0,
                mode: 0o40755,
                dev: 1,
                ino: i + 1,
                nlink: 2,
                size: 4096,
                mtimeMs: 1,
                ctimeMs: 1,
                isDirectory: () => true,
                isFile: () => false,
                isSymbolicLink: () => false,
            },
        ]),
    );
    const stat = {
        uid: 0,
        gid: 0,
        mode: 0o100755,
        dev: 1,
        ino: 10,
        nlink: 1,
        size: 64,
        mtimeMs: 1,
        ctimeMs: 1,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
    };
    const header = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
    header[4] = 2;
    header[5] = 1;
    header.writeUInt16LE(3, 16);
    header.writeUInt16LE(62, 18);
    const controls = {
        reads: 0,
        closes: 0,
        closed: false,
        readFailure: null,
        closeFailure: null,
        change: false,
    };
    const lstat = async (name) => {
        calls.push('lstat:' + name);
        return name === file ? stat : directories.get(name);
    };
    const realpath = async (name) => {
        calls.push('realpath:' + name);
        return name;
    };
    const files = {
        systemRoot: { lstat: () => lstat('/'), realpath: () => realpath('/') },
        filesystem: {
            lstat,
            realpath,
            async open(name, flags) {
                calls.push('open:' + name);
                assert.equal(name, file);
                assert.equal(flags, 'r');
                return {
                    async stat() {
                        return controls.change && controls.reads ? { ...stat, ino: 11 } : stat;
                    },
                    async read(buffer, offset, length, position) {
                        controls.reads++;
                        if (controls.readFailure) throw controls.readFailure.value;
                        const count = Math.min(11, length); // Meaningful partial-read accumulation.
                        header.copy(buffer, offset, position, position + count);
                        return { bytesRead: count };
                    },
                    async close() {
                        controls.closes++;
                        if (controls.closeFailure) throw controls.closeFailure;
                        controls.closed = true;
                    },
                };
            },
        },
    };
    return { file, files, calls, directories, stat, header, controls };
}

test('entry policy binds one real-route shape without asserting that memory context is a host', () => {
    const selected = webBaselineEntryContext(context());
    assert.equal(selected.executable, '/memory/temporary/web-baseline-inputs-123-1/node/bin/node');
    assert.equal(selected.sourceCommit, 'a'.repeat(40));
    assert.equal(Object.isFrozen(selected), true);
    assert.equal(Object.hasOwn(selected, 'jobId'), false);
    assert.equal(Object.hasOwn(selected, 'releaseAcceptance'), false);
});

test('entry policy refuses changed source, host, attempt and executable selections', () => {
    for (const change of [
        'root-user',
        'different-euid',
        'arch',
        'version',
        'attempt',
        'ref',
        'workflow-source',
        'workflow-name',
        'executable',
        'args',
    ]) {
        const actual = context();
        if (change === 'root-user') actual.uid = actual.euid = 0;
        if (change === 'different-euid') actual.euid = 0;
        if (change === 'arch') actual.arch = 'arm64';
        if (change === 'version') actual.version = 'v24.22.0';
        if (change === 'attempt') actual.environment.GITHUB_RUN_ATTEMPT = '2';
        if (change === 'ref') actual.environment.GITHUB_REF = 'refs/heads/main';
        if (change === 'workflow-source') actual.environment.GITHUB_WORKFLOW_SHA = 'b'.repeat(40);
        if (change === 'workflow-name')
            actual.environment.GITHUB_WORKFLOW_REF = actual.environment.GITHUB_WORKFLOW_REF.replace(
                'web-public-baseline.yml',
                'another.yml',
            );
        if (change === 'executable') actual.executable = '/hosted-cache/node';
        if (change === 'args') actual.args = ['--retry'];
        assert.throws(() => webBaselineEntryContext(actual));
    }
});

test('entry policy rejects inherited runtime, build and browser injection options', () => {
    for (const name of [
        'NODE_OPTIONS',
        'NODE_PATH',
        'NODE_COMPILE_CACHE',
        'NODE_V8_COVERAGE',
        'LD_PRELOAD',
        'ESBUILD_BINARY_PATH',
        'VITE_API',
        'CHROME_BIN',
        'CHROMIUM_FLAGS',
    ]) {
        const actual = context();
        actual.environment[name] = 'memory injected value';
        assert.throws(() => webBaselineEntryContext(actual));
    }
});

test('fixed executable inspection joins partial header reads and acknowledges its sole FD', async () => {
    const f = metadata();
    const result = await inspectWebBaselineExecutable(f.file, f.files, 1000);
    assert.equal(result.ino, 10);
    assert.ok(f.controls.reads > 1);
    assert.equal(f.controls.closes, 1);
    assert.equal(f.controls.closed, true);
    assert.equal(f.calls.filter((call) => call.startsWith('open:')).length, 1);
});

test('unsafe parent metadata is refused before following that parent or opening a binary', async () => {
    for (const change of ['symlink', 'writable', 'owner']) {
        const f = metadata(),
            parent = f.directories.get('/opt');
        if (change === 'symlink') parent.isSymbolicLink = () => true;
        if (change === 'writable') parent.mode = 0o40777;
        if (change === 'owner') parent.uid = 1000;
        await assert.rejects(inspectWebBaselineExecutable(f.file, f.files, 1000));
        assert.equal(f.calls.includes('realpath:/opt'), false);
        assert.equal(
            f.calls.some((call) => call.startsWith('open:')),
            false,
        );
    }
});

test('wrong architecture or changed held identity cannot pass executable inspection', async () => {
    for (const change of ['architecture', 'inode']) {
        const f = metadata();
        if (change === 'architecture') f.header.writeUInt16LE(183, 18);
        else f.controls.change = true;
        await assert.rejects(inspectWebBaselineExecutable(f.file, f.files, 1000));
        assert.equal(f.controls.closes, 1);
        assert.equal(f.controls.closed, true);
    }
});

test('primary falsey read failure survives an unresolved close without a retry', async () => {
    const f = metadata(),
        closeFailure = Error('memory close uncertainty');
    f.controls.readFailure = { value: undefined };
    f.controls.closeFailure = closeFailure;
    await assert.rejects(inspectWebBaselineExecutable(f.file, f.files, 1000), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], undefined);
        assert.equal(error.errors[1], closeFailure);
        return true;
    });
    assert.equal(f.controls.reads, 1);
    assert.equal(f.controls.closes, 1);
    assert.equal(f.controls.closed, false, 'only the memory FD remains unresolved');
});
