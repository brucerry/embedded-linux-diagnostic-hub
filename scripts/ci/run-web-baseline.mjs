// Real, explicit CI entrypoint. Import is inert; no final-Web/release admission.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { createOwnedWebFiles } from '../lib/owned-web-files.mjs';
import { createOwnedWebCapabilities } from '../lib/owned-web-capabilities.mjs';
import { localSourceProvider } from '../lib/committed-source-provider.mjs';
import { observeSourceBridge } from '../lib/committed-source-bridge.mjs';
import { readStableArtifactFile } from '../lib/stable-artifact-file.mjs';
import { prepareWebBaselineArchive } from '../lib/web-baseline-archive.mjs';
import { runWebBaseline, startWebDriver, WEB_BASELINE_HOST } from '../lib/web-baseline-driver.mjs';
import { startInstrumentedChildOutput } from '../lib/instrumented-gateway-output.mjs';
import { REPORT_IMPORT_A } from '../../tests/ui/fixtures/report-import-data.ts';

const retained = new Set();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nodeInput = Object.freeze({
    version: 'v24.22.2',
    bytes: 126881248,
    sha256: '904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52',
});
const absolute = (file) =>
    typeof file === 'string' &&
    file.startsWith('/') &&
    path.posix.normalize(file) === file &&
    !/[\\\x00-\x20\x7f]/.test(file);

/** Pure refusal policy only; this object is not host or service authentication. */
export function webBaselineEntryContext(actual) {
    const { environment: env } = actual;
    assert.equal(actual.platform, 'linux');
    assert.equal(actual.arch, 'x64');
    assert.ok(Number.isSafeInteger(actual.uid) && actual.uid > 0 && actual.uid === actual.euid);
    assert.equal(actual.version, nodeInput.version);
    assert.deepEqual(actual.execArgv, []);
    assert.deepEqual(actual.args, []);
    const fixed = {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/ci/v060-web-sandbox-baseline-20261117',
        GITHUB_JOB: 'web_baseline',
        GITHUB_RUN_ATTEMPT: '1',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
    };
    for (const [name, value] of Object.entries(fixed)) assert.equal(env[name], value);
    assert.match(env.GITHUB_RUN_ID, /^[1-9][0-9]{0,19}$/);
    assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
    assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA);
    assert.equal(
        env.GITHUB_WORKFLOW_REF,
        'brucerry/embedded-linux-diagnostic-hub/.github/workflows/web-public-baseline.yml@' +
            env.GITHUB_REF,
    );
    assert.ok(
        absolute(env.RUNNER_TEMP) &&
            absolute(env.GITHUB_WORKSPACE) &&
            absolute(env.GITHUB_EVENT_PATH),
    );
    for (const name of Object.keys(env)) {
        assert.ok(!name.startsWith('VITE_'));
        assert.ok(
            ![
                'NODE_OPTIONS',
                'NODE_PATH',
                'NODE_COMPILE_CACHE',
                'NODE_V8_COVERAGE',
                'ESBUILD_BINARY_PATH',
                'LD_PRELOAD',
                'LD_LIBRARY_PATH',
                'DYLD_INSERT_LIBRARIES',
                'NODE_EXTRA_CA_CERTS',
                'SSL_CERT_FILE',
                'SSL_CERT_DIR',
                'OPENSSL_CONF',
                'CHROME_BIN',
                'CHROMEDRIVER_PATH',
                'CHROMIUM_FLAGS',
            ].includes(name),
        );
    }
    assert.ok(
        env.NODE_TLS_REJECT_UNAUTHORIZED === undefined || env.NODE_TLS_REJECT_UNAUTHORIZED === '1',
    );
    const prefix = env.RUNNER_TEMP + '/web-baseline-inputs-' + env.GITHUB_RUN_ID + '-1';
    assert.equal(actual.executable, prefix + '/node/bin/node');
    return Object.freeze({
        root: env.GITHUB_WORKSPACE,
        prefix,
        executable: actual.executable,
        stateDirectory: env.RUNNER_TEMP + '/web-baseline-state-' + env.GITHUB_RUN_ID + '-1',
        sourceCommit: env.GITHUB_SHA,
        uid: actual.uid,
    });
}

function identity(stat) {
    const value = {};
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) {
        assert.ok(
            Number.isFinite(stat[key]) &&
                stat[key] >= 0 &&
                (['mtimeMs', 'ctimeMs'].includes(key) || Number.isSafeInteger(stat[key])),
        );
        value[key] = stat[key];
    }
    return Object.freeze(value);
}
/** Read metadata before following each fixed parent; then hold/read/recheck an ELF header.
 * Returned identity is a readback fact, not an independently authenticated publisher digest. */
export async function inspectWebBaselineExecutable(file, files, uid, rootOwned = true) {
    assert.ok(absolute(file));
    let cursor = '/';
    const parents = ['/', ...path.posix.dirname(file).split('/').filter(Boolean)];
    for (const part of parents) {
        cursor = part === '/' ? '/' : path.posix.join(cursor, part);
        const stat =
            cursor === '/' ? await files.systemRoot.lstat() : await files.filesystem.lstat(cursor);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
        assert.ok(rootOwned ? stat.uid === 0 : stat.uid === 0 || stat.uid === uid);
        assert.equal(stat.mode & 0o7022, 0);
        assert.equal(
            cursor === '/'
                ? await files.systemRoot.realpath()
                : await files.filesystem.realpath(cursor),
            cursor,
        );
    }
    const io = files.filesystem,
        before = await io.lstat(file);
    assert.ok(
        before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size >= 64,
    );
    assert.equal(before.uid, rootOwned ? 0 : uid);
    assert.equal(before.mode & 0o7022, 0);
    assert.ok(before.mode & 0o100);
    assert.equal(await io.realpath(file), file);
    const selected = identity(before);
    let handle,
        first,
        failed = false,
        result;
    try {
        handle = await io.open(file, 'r');
        assert.deepEqual(identity(await handle.stat()), selected);
        const bytes = Buffer.alloc(64);
        let offset = 0;
        while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset);
            assert.ok(
                Number.isSafeInteger(read.bytesRead) &&
                    read.bytesRead > 0 &&
                    read.bytesRead <= bytes.length - offset,
            );
            offset += read.bytesRead;
        }
        assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
        assert.equal(bytes[4], 2);
        assert.equal(bytes[5], 1);
        assert.ok([2, 3].includes(bytes.readUInt16LE(16)));
        assert.equal(bytes.readUInt16LE(18), 62);
        assert.deepEqual(identity(await handle.stat()), selected);
        assert.deepEqual(identity(await io.lstat(file)), selected);
        assert.equal(await io.realpath(file), file);
        result = selected;
    } catch (error) {
        failed = true;
        first = error;
    }
    if (handle)
        try {
            await handle.close();
        } catch (error) {
            first = failed
                ? new AggregateError([first, error], 'Executable read/close failed.', {
                      cause: first,
                  })
                : error;
            failed = true;
        }
    if (failed) throw first;
    return result;
}

/** Future explicit invocation only. The keeper precedes asynchronous acquisitions; opaque or
 * incomplete actors stay held. No process signal, retry, deletion or global environment patch. */
export async function runWebBaselineEntry() {
    const state = {
        stage: 'admission',
        first: undefined,
        failed: false,
        archive: null,
        actor: null,
        actorFailure: null,
        source: null,
        files: null,
        output: null,
        keeper: null,
        settled: false,
    };
    state.keeper = setInterval(() => {}, 60000);
    const owner = Object.freeze({
        snapshot: () =>
            Object.freeze({
                stage: state.stage,
                failed: state.failed,
                settled: state.settled,
                archive: state.archive?.snapshot() ?? null,
                actor: state.actorFailure?.snapshot() ?? null,
                files: state.files?.owner.snapshot() ?? null,
                qualification: 'public-baseline-only',
                releaseAcceptance: false,
            }),
    });
    retained.add(owner);
    let result;
    try {
        const environment = { ...process.env };
        const context = webBaselineEntryContext({
            environment,
            platform: process.platform,
            arch: process.arch,
            uid: process.getuid?.(),
            euid: process.geteuid?.(),
            executable: process.execPath,
            version: process.version,
            execArgv: [...process.execArgv],
            args: process.argv.slice(2),
        });
        assert.equal(context.root, root);
        const native = {
            realpath: fs.realpath,
            lstat: fs.lstat,
            opendir: fs.opendir,
            mkdir: (file) => fs.mkdir(file, { mode: 0o700 }),
            open: (file, flags) => fs.open(file, flags, 0o600),
        };
        const files = createOwnedWebFiles(native);
        state.files = files;
        const io = files.filesystem;
        assert.equal(await io.realpath(root), root);
        state.stage = 'node-input';
        const nodeIdentity = await inspectWebBaselineExecutable(
            context.executable,
            files,
            context.uid,
            false,
        );
        const node = (
            await readStableArtifactFile(
                path.dirname(context.executable),
                'node',
                128 * 1024 ** 2,
                io,
            )
        ).bytes;
        assert.equal(node.length, nodeInput.bytes);
        assert.equal(hash(node), nodeInput.sha256);
        assert.deepEqual(identity(await fs.stat('/proc/self/exe')), nodeIdentity);
        assert.deepEqual(
            await inspectWebBaselineExecutable(context.executable, files, context.uid, false),
            nodeIdentity,
        );
        const profileBytes = (
            await readStableArtifactFile(root, 'scripts/ci/web-build-inputs.json', 32768, io)
        ).bytes;
        const profile = JSON.parse(profileBytes);
        assert.equal(profile.node.version, nodeInput.version.slice(1));
        assert.equal(profile.node.bytes, nodeInput.bytes);
        assert.equal(profile.node.sha256, nodeInput.sha256);
        state.stage = 'host-metadata';
        const chrome = await inspectWebBaselineExecutable(
            WEB_BASELINE_HOST.chrome,
            files,
            context.uid,
        );
        const driver = await inspectWebBaselineExecutable(
            WEB_BASELINE_HOST.driver,
            files,
            context.uid,
        );
        const gitIdentity = await inspectWebBaselineExecutable('/usr/bin/git', files, context.uid);
        const git = (await readStableArtifactFile('/usr/bin', 'git', 16 * 1024 ** 2, io)).bytes;
        const event = JSON.parse(
            (
                await readStableArtifactFile(
                    path.dirname(environment.GITHUB_EVENT_PATH),
                    path.basename(environment.GITHUB_EVENT_PATH),
                    4 * 1024 ** 2,
                    io,
                )
            ).bytes,
        );
        assert.equal(event.repository?.private, false);
        assert.equal(event.repository?.full_name, environment.GITHUB_REPOSITORY);
        assert.equal(event.after, context.sourceCommit);
        assert.equal(event.ref, environment.GITHUB_REF);
        assert.equal(event.deleted, false);
        const childEnvironment = {
            PATH: path.dirname(context.executable) + ':/usr/bin:/bin',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            TZ: 'UTC',
        };
        const commandPorts = {
            filesystem: native,
            launch: spawn,
            now: () => performance.now(),
            setTimer: setTimeout,
            clearTimer: clearTimeout,
        };
        const source = createOwnedWebCapabilities(
            { gitPath: '/usr/bin/git', gitSHA256: hash(git), environment: childEnvironment },
            commandPorts,
        );
        state.source = source;
        state.stage = 'source-binding';
        const provider = await localSourceProvider(root, {
            filesystem: source.filesystem,
            execute: source.executeGit,
            asynchronous: true,
            platform: process.platform,
            environment: source.gitEnvironment,
        });
        const observed = await provider.state();
        assert.equal(observed.sourceCommit, context.sourceCommit);
        await observeSourceBridge(
            { sourceCommit: context.sourceCommit, sourceTree: observed.sourceTree },
            provider,
        );
        const packageBytes = (await provider.file('package.json')).bytes;
        const lockBytes = (await provider.file('package-lock.json')).bytes;
        assert.equal(hash(packageBytes), profile.sourcePackageSHA256);
        assert.equal(hash(lockBytes), profile.sourceLockSHA256);
        const version = JSON.parse(packageBytes).version;
        source.assertSettled();
        state.stage = 'fixture';
        await io.mkdir(context.stateDirectory);
        const directory = await io.lstat(context.stateDirectory);
        assert.ok(
            directory.isDirectory() &&
                !directory.isSymbolicLink() &&
                directory.uid === context.uid &&
                (directory.mode & 0o7777) === 0o700,
        );
        const fixture = structuredClone(REPORT_IMPORT_A);
        const fixtureFile = context.stateDirectory + '/report-import-a.json';
        const fixtureBytes = Buffer.from(JSON.stringify(fixture) + '\n');
        await io.writeFile(fixtureFile, fixtureBytes, { flag: 'wx' });
        assert.ok(
            (
                await readStableArtifactFile(
                    context.stateDirectory,
                    'report-import-a.json',
                    65536,
                    io,
                )
            ).bytes.equals(fixtureBytes),
        );
        assert.equal((await io.lstat(fixtureFile)).mode & 0o7777, 0o600);
        await io.mkdir(root + '/validation');
        files.owner.assertSettled();
        state.stage = 'archive-build';
        const archive = await prepareWebBaselineArchive(
            {
                root,
                version,
                sourceCommit: context.sourceCommit,
                sourceTree: observed.sourceTree,
                diagnosticId: randomBytes(16).toString('hex'),
                gitPath: '/usr/bin/git',
                gitSHA256: hash(git),
                environment: childEnvironment,
            },
            { ...commandPorts, createServer: (handler) => http.createServer(handler) },
        );
        state.archive = archive;
        state.stage = 'host-recheck';
        assert.deepEqual(
            await inspectWebBaselineExecutable(WEB_BASELINE_HOST.chrome, files, context.uid),
            chrome,
        );
        assert.deepEqual(
            await inspectWebBaselineExecutable(WEB_BASELINE_HOST.driver, files, context.uid),
            driver,
        );
        state.stage = 'owned-browser';
        // Actual version157 matching is observed by the owned session/capabilities stage,
        // never inferred from image documentation or these metadata-only file observations.
        result = await runWebBaseline(
            { stateDirectory: context.stateDirectory, fixtureFile, fixture },
            {
                archive,
                startDriver: (directory) => startWebDriver(directory, { launch: spawn }),
                now: () => performance.now(),
                setTimer: setTimeout,
                clearTimer: clearTimeout,
            },
        );
        state.actor = result;
        assert.equal(result.directClosure, true);
        assert.deepEqual(
            await inspectWebBaselineExecutable(WEB_BASELINE_HOST.chrome, files, context.uid),
            chrome,
        );
        assert.deepEqual(
            await inspectWebBaselineExecutable(WEB_BASELINE_HOST.driver, files, context.uid),
            driver,
        );
        assert.deepEqual(
            await inspectWebBaselineExecutable('/usr/bin/git', files, context.uid),
            gitIdentity,
        );
        assert.ok(
            (
                await readStableArtifactFile(
                    context.stateDirectory,
                    'report-import-a.json',
                    65536,
                    io,
                )
            ).bytes.equals(fixtureBytes),
        );
        files.owner.assertSettled();
        source.assertSettled();
        assert.equal(archive.snapshot().producerClosureAcknowledged, true);
        assert.equal(archive.host.snapshot().listenerClosed, true);
        state.settled = true;
        state.stage = 'complete';
    } catch (error) {
        state.failed = true;
        state.first = error;
        const descriptor =
            error &&
            typeof error === 'object' &&
            !types.isProxy(error) &&
            types.isNativeError(error)
                ? Object.getOwnPropertyDescriptor(error, 'owner')
                : null;
        if (
            descriptor &&
            Object.hasOwn(descriptor, 'value') &&
            descriptor.value &&
            typeof descriptor.value === 'object' &&
            !types.isProxy(descriptor.value)
        ) {
            const method = Object.getOwnPropertyDescriptor(descriptor.value, 'snapshot');
            if (method && Object.hasOwn(method, 'value') && typeof method.value === 'function')
                state.actorFailure = descriptor.value;
        }
        // Pure admission refusal or an explicitly settled metadata/source-only scope can end.
        // A failed invoked archive, compiler, driver or browser is never cleared by zero counts.
        if (
            ['admission', 'node-input', 'host-metadata', 'source-binding', 'fixture'].includes(
                state.stage,
            )
        ) {
            try {
                state.files?.owner.assertSettled();
                state.source?.assertSettled();
                state.settled = true;
            } catch {
                /* existing owner retained */
            }
        } else if (state.stage === 'archive-build' && state.actorFailure?.failureOwner?.()) {
            try {
                await state.actorFailure.waitForDirectClosure();
                state.actorFailure.assertSettled();
                state.files.owner.assertSettled();
                state.source.assertSettled();
                state.settled = true;
            } catch {
                /* the original compiler/filesystem owner remains held */
            }
        } else if (
            state.stage === 'host-recheck' &&
            state.archive?.snapshot().producerClosureAcknowledged === true &&
            state.archive.host.snapshot().phase === 'prepared'
        ) {
            try {
                await state.archive.host.close(); // Unbound, newly owned byte host only; no listener exists.
                state.files.owner.assertSettled();
                state.source.assertSettled();
                state.settled = true;
            } catch {
                /* the original metadata or host owner remains held */
            }
        } else if (
            state.stage === 'owned-browser' &&
            state.actorFailure?.snapshot?.().closed === true
        ) {
            try {
                state.files.owner.assertSettled();
                state.source.assertSettled();
                state.settled = true;
            } catch {
                /* existing owner retained */
            }
        }
    }
    const bytes = Buffer.from(
        JSON.stringify({
            status: state.failed ? 'nonpassing' : 'passed',
            stage: state.stage,
            closure: state.settled ? 'known-direct-scope' : 'retained-unknown',
            qualification: 'public-baseline-only',
            releaseAcceptance: false,
        }) + '\n',
    );
    try {
        const output = startInstrumentedChildOutput(bytes, process.stdout, () => {
            process.exitCode = 1;
        });
        state.output = output;
        await output.result;
        await output.closed;
        if (state.settled) {
            clearInterval(state.keeper);
            state.keeper = null;
            retained.delete(owner);
        }
    } catch {
        state.failed = true; /* keeper and original report owner retained, never retried */
    }
    if (state.failed) process.exitCode = 1;
    return { owner, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void runWebBaselineEntry().catch(() => {
        process.exitCode = 1;
    });
}
