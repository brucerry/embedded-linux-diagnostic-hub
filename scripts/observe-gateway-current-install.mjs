// Same-job built-byte observation only. Importing this CLI starts no operation.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createOwnedWebFiles } from './lib/owned-web-files.mjs';
import { createOwnedWebCapabilities } from './lib/owned-web-capabilities.mjs';
import { localSourceProvider } from './lib/committed-source-provider.mjs';
import { observeSourceBridge } from './lib/committed-source-bridge.mjs';
import { parseGatewayArchiveBuildRecord } from './lib/gateway-build-record.mjs';
import { openGatewayArchiveBytes } from './lib/inner-archive-inspection.mjs';
import { prepareDiagnosticGatewayInstall } from './lib/diagnostic-gateway-install.mjs';
import { gatewayInstallPlan } from './lib/diagnostic-gateway-runtime.mjs';
import { startDiagnosticGatewayCommand } from './lib/diagnostic-gateway-command.mjs';
import { createFinalGatewayObserver } from './lib/final-gateway-runtime.mjs';
import { startInstrumentedChildOutput } from './lib/instrumented-gateway-output.mjs';
import {
    CURRENT_GATEWAY_BUILD_LEAF,
    readCurrentGatewayBuildFile,
    validateCurrentGatewayBuildContext,
} from './lib/current-gateway-build.mjs';

const retained = new Set();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
let activated = false;
const npmTrustKeys = Object.freeze([
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'npm_config_proxy',
    'npm_config_https_proxy',
    'npm_config_noproxy',
    'npm_config_cafile',
    'npm_config_ca',
    'NPM_CONFIG_PROXY',
    'NPM_CONFIG_HTTPS_PROXY',
    'NPM_CONFIG_NOPROXY',
    'NPM_CONFIG_CAFILE',
    'NPM_CONFIG_CA',
]);
function npmEnvironment(base, inherited) {
    const selected = { ...base, NODE_ENV: 'production' };
    for (const key of npmTrustKeys)
        if (inherited[key] !== undefined) {
            assert.ok(
                typeof inherited[key] === 'string' &&
                    !inherited[key].includes('\0') &&
                    Buffer.byteLength(inherited[key]) <= 16384,
            );
            selected[key] = inherited[key];
        }
    return Object.freeze(selected);
}
function withoutTrustValues(bytes, environment) {
    let text = bytes.toString('latin1');
    for (const key of npmTrustKeys)
        if (environment[key])
            text = text
                .split(Buffer.from(environment[key]).toString('latin1'))
                .join('[inherited-proxy-or-trust-value]');
    return Buffer.from(text, 'latin1');
}

function fail(state, value) {
    if (!state.failed) {
        state.failed = true;
        state.first = value; // A separate bit preserves a first raw undefined.
    } else if (state.secondary.length < 16) state.secondary.push(value);
}
function gate(state) {
    if (state.failed) throw state.first;
}
function censusFilesystem(filesystem) {
    return Object.freeze({
        ...filesystem,
        open(file, flags) {
            assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            // owned-web-files.open('r') issues this EXACT numeric triple to native.open.
            // This adapts the spelling, not the kernel flags or the descriptor owner.
            return filesystem.open(file, 'r');
        },
    });
}
function cacheContentPath(directory, integrity) {
    assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    const bytes = Buffer.from(integrity.slice(7), 'base64');
    assert.equal(bytes.length, 64);
    assert.equal(bytes.toString('base64'), integrity.slice(7));
    const hex = bytes.toString('hex');
    return (
        directory +
        '/cache/_cacache/content-v2/sha512/' +
        hex.slice(0, 2) +
        '/' +
        hex.slice(2, 4) +
        '/' +
        hex.slice(4)
    );
}

// Private, fixed composition used by the real entry below. No caller-supplied census,
// permission receipt, runtime factory, process signal or namespace retirement is accepted.
async function installAndObserve(state, input, filesystem, writeExclusive, commandPorts) {
    gate(state);
    const record = parseGatewayArchiveBuildRecord(input.recordBytes, input.expected);
    assert.equal(input.root, record.build.cwd);
    assert.equal(digest(input.sourceLockBytes), record.sourceLockSHA256);
    assert.equal(input.archive.length, record.archive.bytes);
    assert.equal(digest(input.archive), record.archive.sha256);
    assert.ok(
        input.checksum.equals(
            Buffer.from(record.archive.sha256 + '  ' + record.archive.name + '\n'),
        ),
    );
    assert.deepEqual(input.builder, record.builder);
    assert.equal(input.nodePath, record.builder.runtime.executablePath);
    assert.equal(input.npmPath, record.builder.npmEntryPath);
    const contents = openGatewayArchiveBytes(input.archive, record);
    let lock;
    try {
        lock = JSON.parse(decoder.decode(contents.read('package-lock.json')));
    } finally {
        contents.releaseBytes();
    }
    const required = Object.keys(lock.packages)
        .filter((name) => name && !lock.packages[name].optional)
        .sort();
    assert.equal(required.length, 5, 'The current Gateway has five required original archives.');
    const directory = input.root + '/validation/gateway-runtime';
    state.phase = 'prepare-installation';
    state.prepared = await prepareDiagnosticGatewayInstall(
        input.archive,
        input.recordBytes,
        input.expected,
        directory,
        filesystem,
        writeExclusive,
    );
    gate(state);
    await filesystem.mkdir(directory + '/inputs');
    gate(state);
    await filesystem.mkdir(directory + '/observations');
    gate(state);
    for (const [name, bytes] of [
        ['gateway-build.json', input.recordBytes],
        [record.archive.name, input.archive],
        [record.checksum.name, input.checksum],
        ['source-package-lock.json', input.sourceLockBytes],
        ['github-event.json', input.eventBytes],
        ...input.toolchainOriginals,
    ]) {
        await writeExclusive(directory + '/inputs/' + name, bytes);
        gate(state);
    }
    const plan = gatewayInstallPlan(input.nodePath, input.npmPath, directory, record.stage.owner);
    // NETWORK npm ci is intentional: one fresh cache, public registry and the original lock's
    // resolved hosts (including GitHub codeload), pinned SRI,
    // --ignore-scripts, --omit=optional and --fetch-retries=0. No auxiliary downloader is used.
    state.phase = 'script-free-npm-ci';
    const issued = { owner: null, result: null, closed: false };
    state.commands.push(issued); // Before a synchronous launch can become uncertain.
    const command = startDiagnosticGatewayCommand(plan, input.environment, {
        ...commandPorts,
        requireSpawnIdentity: true,
    });
    issued.owner = command;
    void command.closed.then(
        () => {
            issued.closed = true;
        },
        (error) => fail(state, error),
    );
    issued.result = await command.result;
    await command.closed;
    gate(state);
    await writeExclusive(
        directory + '/observations/npm-ci.json',
        Buffer.from(JSON.stringify(issued.result) + '\n'),
    );
    gate(state);
    state.commandOutput = command.output();
    retained.add(state.commandOutput); // Original bounded bytes remain private; never print trust inputs.
    for (const [name, bytes] of Object.entries(state.commandOutput)) {
        await writeExclusive(
            directory + '/observations/npm-ci.' + name + '.redacted',
            withoutTrustValues(bytes, input.environment),
        );
        gate(state);
    }
    const observer = createFinalGatewayObserver(
        input.archive,
        input.recordBytes,
        input.expected,
        input.sourceLockBytes,
        {
            root: state.prepared.installRoot,
            node: { path: input.nodePath, sha256: input.builder.runtime.executableSHA256 },
            uid: input.uid,
        },
        censusFilesystem(filesystem),
    );
    state.observer = observer;
    state.phase = 'installation-census';
    state.installation = await observer.observeInstallation();
    gate(state);
    state.phase = 'original-dependency-archives';
    for (const name of required) {
        const row = { path: name, bytes: null };
        state.archives.push(row); // Retain the returned original before the following gate.
        row.bytes = await readCurrentGatewayBuildFile(
            cacheContentPath(directory, lock.packages[name].integrity),
            16 * 1024 ** 2,
            input.uid,
            filesystem,
        );
        gate(state);
        const number = String(state.archives.length).padStart(2, '0');
        await writeExclusive(directory + '/inputs/dependency-' + number + '.tgz', row.bytes);
        gate(state);
    }
    state.phase = 'dependency-origin-comparison';
    state.origin = observer.observeDependencyOrigin(state.archives);
    gate(state);
    assert.equal(state.origin.loadedCodeObserved, false);
    assert.equal(state.origin.packages.length, 5);
    // These are the EXISTING returned structures, not a new qualification/receipt schema.
    await writeExclusive(
        directory + '/observations/installation.json',
        Buffer.from(JSON.stringify(state.installation) + '\n'),
    );
    gate(state);
    await writeExclusive(
        directory + '/observations/dependency-origin.json',
        Buffer.from(JSON.stringify(state.origin) + '\n'),
    );
    gate(state);
    assert.equal(observer.snapshot().pendingIO + observer.snapshot().descriptors, 0);
    state.phase = 'built-census-only';
    return { installation: state.installation, dependencyOrigin: state.origin };
}

/** Physical same-job entry. Metadata preconditions remain separate from GitHub authentication.
 * No supplied input paths, fabricated GitHub variables, old records or runtime activation. */
export async function observeGatewayInstallFromCurrentJob() {
    assert.equal(activated, false, 'Current-job install entry is one-use.');
    activated = true;
    const state = {
        phase: 'current-job-inputs',
        failed: false,
        first: undefined,
        secondary: [],
        pending: 0,
        commands: [],
        originals: [],
        archives: [],
        observer: null,
        prepared: null,
        installation: null,
        origin: null,
        output: null,
        outputAttempted: false,
        keeper: null,
        retired: false,
    };
    const owner = Object.freeze({
        snapshot: () =>
            Object.freeze({
                phase: state.phase,
                failed: state.failed,
                pending: state.pending,
                commandOwners: state.commands.filter((x) => !x.closed).length,
                files: state.files?.snapshot() ?? null,
                observer: state.observer?.snapshot() ?? null,
                loadedCodeObserved: false,
                runtimeGCObserved: false,
                wholeGroupRetirement: null,
                releaseAcceptance: false,
            }),
    });
    retained.add(owner); // Before any file/child acquisition, including a falsey failure.
    const env = process.env;
    let files, capabilities;
    async function nativeCall(operation, adopt, closing = false) {
        if (!closing) gate(state);
        state.pending++;
        try {
            const value = await operation();
            if (adopt) adopt(value);
            return value;
        } catch (error) {
            fail(state, error);
            throw error;
        } finally {
            state.pending--;
        }
    }
    // Existing Web FS owns every handle/publication. The tiny native port binding additionally
    // remembers raw Error/undefined before old helpers can reduce a falsey failure.
    function handlePorts(handle, directory = false) {
        const wrapped = {};
        for (const method of directory
            ? ['read', 'close']
            : ['read', 'write', 'stat', 'sync', 'close'])
            wrapped[method] = (...args) =>
                nativeCall(() => handle[method](...args), undefined, method === 'close');
        return wrapped;
    }
    const nativeFiles = {
        realpath: (...args) => nativeCall(() => fs.realpath(...args)),
        lstat: (...args) => nativeCall(() => fs.lstat(...args)),
        mkdir: (...args) => nativeCall(() => fs.mkdir(...args)),
        open: (...args) => nativeCall(async () => handlePorts(await fs.open(...args))),
        opendir: (...args) => nativeCall(async () => handlePorts(await fs.opendir(...args), true)),
    };
    function known() {
        if (state.pending || state.commands.some((x) => !x.owner || !x.closed)) return false;
        try {
            capabilities?.assertSettled();
            files?.owner.assertSettled();
        } catch {
            return false;
        }
        const snapshot = state.observer?.snapshot();
        return (
            !snapshot || snapshot.pendingIO + snapshot.descriptors + snapshot.listenersHeld === 0
        );
    }
    async function read(file, maximum, filesystem) {
        const row = { file, bytes: null };
        state.originals.push(row);
        row.bytes = await readCurrentGatewayBuildFile(file, maximum, process.getuid(), filesystem);
        gate(state);
        return row.bytes;
    }
    try {
        assert.equal(env.GITHUB_ACTIONS, 'true');
        assert.equal(process.platform, 'linux');
        assert.equal(process.arch, 'x64');
        assert.equal(process.version, 'v24.22.0');
        assert.deepEqual(process.execArgv, []);
        assert.equal(process.argv.length, 2);
        const uid = process.getuid();
        assert.ok(Number.isSafeInteger(uid) && uid > 0);
        for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ESBUILD_BINARY_PATH'])
            assert.equal(env[key], undefined);
        state.keeper = setInterval(() => {}, 60000); // Before the first acquisition; never unref.
        files = createOwnedWebFiles(nativeFiles);
        state.files = files.owner;
        const io = files.filesystem;
        const root = await io.realpath(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        );
        gate(state);
        assert.equal(await io.realpath(env.GITHUB_WORKSPACE), root);
        const eventBytes = await read(env.GITHUB_EVENT_PATH, 4 * 1024 ** 2, io);
        const event = JSON.parse(decoder.decode(eventBytes));
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
        assert.equal(context.event, 'push');
        assert.equal(event.after, context.sha);
        assert.equal(event.ref, context.ref);
        const nodePath = await io.realpath(process.execPath);
        assert.equal(nodePath, process.execPath);
        const gitPath = await io.realpath('/usr/bin/git');
        assert.equal(gitPath, '/usr/bin/git');
        const npmPath =
            path.dirname(path.dirname(nodePath)) + '/lib/node_modules/npm/bin/npm-cli.js';
        const esbuildPath = root + '/node_modules/esbuild/bin/esbuild';
        const nodeBytes = await read(nodePath, 128 * 1024 ** 2, io);
        const gitBytes = await read(gitPath, 16 * 1024 ** 2, io);
        const npmBytes = await read(npmPath, 1024 ** 2, io);
        const npmPackage = await read(
            path.dirname(path.dirname(npmPath)) + '/package.json',
            1024 ** 2,
            io,
        );
        const esbuildBytes = await read(esbuildPath, 64 * 1024, io);
        const environment = {
            PATH: path.dirname(nodePath) + ':/usr/bin:/bin',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            TZ: 'UTC',
        };
        const commandPorts = {
            launch: (file, args, options) => {
                gate(state);
                return spawn(file, args, options);
            },
            setTimer: setTimeout,
            clearTimer: (timer) => {
                clearTimeout(timer);
            },
            now: () => performance.now(),
        };
        capabilities = createOwnedWebCapabilities(
            { gitPath, gitSHA256: digest(gitBytes), environment },
            { ...commandPorts, filesystem: nativeFiles },
        );
        const provider = await localSourceProvider(root, {
            filesystem: capabilities.filesystem,
            execute: capabilities.executeGit,
            asynchronous: true,
            platform: process.platform,
            environment: capabilities.gitEnvironment,
        });
        const source = await provider.state();
        gate(state);
        assert.equal(source.sourceCommit, context.sha);
        const bridge = await observeSourceBridge(
            { sourceCommit: source.sourceCommit, sourceTree: source.sourceTree },
            provider,
        );
        gate(state);
        const sourcePackage = JSON.parse(
            decoder.decode((await provider.file('package.json')).bytes),
        );
        const expected = {
            scope: 'gateway',
            version: sourcePackage.version,
            sourceCommit: source.sourceCommit,
            sourceTree: source.sourceTree,
            runId: context.runId,
            runAttempt: context.runAttempt,
            jobKey: context.jobKey,
        };
        const sourceLockBytes = (await provider.file('package-lock.json')).bytes;
        gate(state);
        state.originals.push({
            file: root + '/package-lock.json',
            bytes: Buffer.from(sourceLockBytes),
        });
        const artifacts = root + '/validation/' + CURRENT_GATEWAY_BUILD_LEAF + '/artifacts';
        const recordBytes = await read(
            artifacts + '/gateway-build.json',
            16 * 1024 ** 2,
            capabilities.filesystem,
        );
        const record = parseGatewayArchiveBuildRecord(recordBytes, expected);
        assert.deepEqual(bridge, record.sourceBridge);
        const archive = await read(
            artifacts + '/' + record.archive.name,
            128 * 1024 ** 2,
            capabilities.filesystem,
        );
        const checksum = await read(
            artifacts + '/' + record.checksum.name,
            1024,
            capabilities.filesystem,
        );
        const builder = {
            runtime: {
                executablePath: nodePath,
                executableSHA256: digest(nodeBytes),
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                versions: { ...process.versions },
                execArgv: [],
                nodeOptions: null,
            },
            esbuildEntryPath: esbuildPath,
            esbuildEntrySHA256: digest(esbuildBytes),
            esbuildEntryFormat: 'node-script',
            npmEntryPath: npmPath,
            npmEntrySHA256: digest(npmBytes),
            npmVersion: JSON.parse(decoder.decode(npmPackage)).version,
            npmPackageSHA256: digest(npmPackage),
        };
        const toolchainOriginals = [
            ['selected-node.bin', nodeBytes],
            ['selected-git.bin', gitBytes],
            ['npm-cli.js', npmBytes],
            ['npm-package.json', npmPackage],
            ['esbuild-entry.cjs', esbuildBytes],
        ];
        const result = await installAndObserve(
            state,
            {
                root,
                uid,
                nodePath,
                npmPath,
                builder,
                expected,
                archive,
                recordBytes,
                checksum,
                sourceLockBytes,
                eventBytes,
                toolchainOriginals,
                environment: npmEnvironment(environment, env),
            },
            capabilities.filesystem,
            (file, bytes) => capabilities.filesystem.writeFile(file, bytes, { flag: 'wx' }),
            commandPorts,
        );
        gate(state);
        for (const [file, original, maximum] of [
            [nodePath, nodeBytes, 128 * 1024 ** 2],
            [gitPath, gitBytes, 16 * 1024 ** 2],
            [npmPath, npmBytes, 1024 ** 2],
            [path.dirname(path.dirname(npmPath)) + '/package.json', npmPackage, 1024 ** 2],
            [esbuildPath, esbuildBytes, 64 * 1024],
        ])
            assert.ok(
                (await read(file, maximum, capabilities.filesystem)).equals(original),
                'Selected tool bytes changed during installation/census.',
            );
        assert.ok(known(), 'Known file/command closure is required before a built-only result.');
        state.result = result;
        return { owner, ...result };
    } catch (error) {
        fail(state, error);
        throw Object.assign(
            Error(
                'Gateway same-job install/census failed; uncertain owners and originals retained.',
                { cause: state.first },
            ),
            { owner },
        );
    } finally {
        // Failed or unknown child/file owners keep the referenced keeper. No cleanup/signal/retry.
        if (known()) {
            if (state.keeper !== null) clearInterval(state.keeper);
            state.keeper = null;
            state.retired = true;
            retained.delete(owner);
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let attempted = false;
    async function report(stream, bytes) {
        const lease = { output: null, keeper: null, firstSet: false, first: undefined };
        retained.add(lease); // Before a fallible write/listener acquisition.
        lease.keeper = setInterval(() => {}, 60000);
        function outputFailure(value) {
            if (!lease.firstSet) {
                lease.firstSet = true;
                lease.first = value;
            }
            process.exitCode = 1;
        }
        const bound = {
            on(event, callback) {
                try {
                    const value = stream.on(event, (error) => {
                        outputFailure(error);
                        callback(error);
                    });
                    return value === stream ? bound : value;
                } catch (error) {
                    outputFailure(error);
                    throw error;
                }
            },
            write(value, callback) {
                try {
                    return stream.write(value, callback);
                } catch (error) {
                    outputFailure(error);
                    throw error;
                }
            },
        };
        try {
            lease.output = startInstrumentedChildOutput(bytes, bound, () => {
                process.exitCode = 1;
            });
            await lease.output.result;
            await lease.output.closed;
        } finally {
            if (
                lease.output?.snapshot().writeRetired &&
                !lease.output.snapshot().unknownOperation
            ) {
                clearInterval(lease.keeper);
                retained.delete(lease);
            }
        }
    }
    try {
        await observeGatewayInstallFromCurrentJob();
        attempted = true;
        await report(
            process.stdout,
            Buffer.from(
                'Gateway canonical install census and original dependency bytes compared; built-only, no runtime/GC/release acceptance.\n',
            ),
        );
    } catch {
        process.exitCode = 1;
        if (!attempted) {
            attempted = true;
            try {
                await report(
                    process.stderr,
                    Buffer.from(
                        'Gateway install/census failed or remains held; original inputs and uncertain owners retained, no retry or cleanup.\n',
                    ),
                );
            } catch {
                /* Existing output custody remains retained. No report retry. */
            }
        }
    }
}
