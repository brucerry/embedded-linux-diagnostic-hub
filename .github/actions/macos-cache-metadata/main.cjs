// Only runner-managed node24 executes this entry. Imports in tests do not run it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const heldSources = new Map();
const heldOutputs = new Map();
const sourceSpecs = Object.freeze([
    [
        'macos-node-cache.mjs',
        7023,
        '708cacf618fdafe46a4b6f89de8116b5d0478a45ec46c785f1304fc2e9d57137',
    ],
    [
        'macos-node-cache-reader.mjs',
        14511,
        '47356866a8ea576b228f6a68edea7187b68497adbed3a4be81356e7f552041e7',
    ],
]);
const fields = ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
function fixedFailure(code) {
    const e = new Error(code);
    e.code = code;
    return e;
}
function safeFile(s, uid) {
    return (
        s?.isFile() &&
        fields.every((k) => typeof s[k] === 'bigint') &&
        s.dev >= 0n &&
        s.ino > 0n &&
        s.nlink === 1n &&
        s.size >= 0n &&
        (s.uid === 0n || s.uid === BigInt(uid)) &&
        (s.mode & 0o7022n) === 0n
    );
}
function same(a, b) {
    return fields.every((k) => a[k] === b[k]);
}

// Bounded source data reads. Test IO is explicit; it cannot issue host evidence.
function readBoundSource(file, spec, uid, io = fs) {
    if (heldSources.size) throw fixedFailure('entry-source-custody');
    let fd = null,
        failed = false,
        primary,
        closeFailed = false,
        closeError;
    let data;
    try {
        const before = io.lstatSync(file, { bigint: true });
        if (!safeFile(before, uid) || before.size !== BigInt(spec[1]))
            throw fixedFailure('entry-source');
        fd = io.openSync(
            file,
            io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK,
        );
        if (!Number.isSafeInteger(fd) || fd < 0) throw fixedFailure('entry-source');
        if (!same(before, io.fstatSync(fd, { bigint: true }))) throw fixedFailure('entry-source');
        data = Buffer.alloc(spec[1]);
        let offset = 0,
            calls = 0;
        while (offset < data.length) {
            if (++calls > 64) throw fixedFailure('entry-source');
            const n = io.readSync(fd, data, offset, data.length - offset, offset);
            if (!Number.isSafeInteger(n) || n <= 0 || n > data.length - offset)
                throw fixedFailure('entry-source');
            offset += n;
        }
        if (
            !same(before, io.fstatSync(fd, { bigint: true })) ||
            !same(before, io.lstatSync(file, { bigint: true })) ||
            crypto.createHash('sha256').update(data).digest('hex') !== spec[2]
        )
            throw fixedFailure('entry-source');
    } catch (e) {
        failed = true;
        primary = e;
    } finally {
        if (fd !== null && Number.isSafeInteger(fd) && fd >= 0) {
            try {
                const ack = io.closeSync(fd);
                if (ack !== undefined) {
                    closeFailed = true;
                    closeError = ack;
                }
            } catch (error) {
                closeFailed = true;
                closeError = error;
            }
            if (closeFailed) heldSources.set(fd, { failed, primary, closeError });
        }
    }
    if (closeFailed) throw fixedFailure('entry-source-custody');
    if (failed) throw primary;
}

function writeBoundOutput(file, text, uid, io = fs) {
    if (
        heldOutputs.size ||
        typeof file !== 'string' ||
        !path.isAbsolute(file) ||
        path.normalize(file) !== file ||
        file.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(file) ||
        typeof text !== 'string' ||
        Buffer.byteLength(text) >= 1024
    )
        throw fixedFailure('entry-report');
    let fd = null,
        failed = false,
        primary,
        closeFailed = false,
        closeError;
    try {
        fd = io.openSync(
            file,
            io.constants.O_WRONLY |
                io.constants.O_APPEND |
                io.constants.O_NOFOLLOW |
                io.constants.O_NONBLOCK,
        );
        if (
            !Number.isSafeInteger(fd) ||
            fd < 0 ||
            !safeFile(io.fstatSync(fd, { bigint: true }), uid)
        )
            throw fixedFailure('entry-report');
        const bytes = Buffer.from(text);
        let offset = 0,
            calls = 0;
        while (offset < bytes.length) {
            if (++calls > 64) throw fixedFailure('entry-report');
            const n = io.writeSync(fd, bytes, offset, bytes.length - offset);
            if (!Number.isSafeInteger(n) || n <= 0 || n > bytes.length - offset)
                throw fixedFailure('entry-report');
            offset += n;
        }
    } catch (error) {
        failed = true;
        primary = error;
    } finally {
        if (fd !== null && Number.isSafeInteger(fd) && fd >= 0) {
            try {
                const ack = io.closeSync(fd);
                if (ack !== undefined) {
                    closeFailed = true;
                    closeError = ack;
                }
            } catch (error) {
                closeFailed = true;
                closeError = error;
            }
            if (closeFailed) heldOutputs.set(fd, { failed, primary, closeError });
        }
    }
    if (failed || closeFailed) throw fixedFailure('entry-report');
}

async function productionMain() {
    const m = await import('../../scripts/macos-cache-observation.mjs');
    const e = process.env;
    const config = {
        repository: e.GITHUB_REPOSITORY,
        repositoryId: e.GITHUB_REPOSITORY_ID,
        private: e.OBS_REPOSITORY_PRIVATE,
        actions: e.GITHUB_ACTIONS,
        event: e.GITHUB_EVENT_NAME,
        ref: e.GITHUB_REF,
        attempt: e.GITHUB_RUN_ATTEMPT,
        runId: e.GITHUB_RUN_ID,
        job: e.GITHUB_JOB,
        workflowRef: e.GITHUB_WORKFLOW_REF,
        sha: e.GITHUB_SHA,
        workflowSHA: e.GITHUB_WORKFLOW_SHA,
        runnerEnvironment: e.RUNNER_ENVIRONMENT,
        runnerOS: e.RUNNER_OS,
        runnerArch: e.RUNNER_ARCH,
        arch: e.INPUT_EXPECTED_ARCH,
        startup: Object.fromEntries(
            [
                'BASH_ENV',
                'ENV',
                'NODE_OPTIONS',
                'NODE_PATH',
                'NODE_COMPILE_CACHE',
                'NODE_DISABLE_COMPILE_CACHE',
                'ESBUILD_BINARY_PATH',
            ].map((k) => [k, e[k]]),
        ),
    };
    const identity = {
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        uid: process.getuid?.(),
        euid: process.geteuid?.(),
    };
    return m.executeObservation(
        e.INPUT_MODE,
        config,
        identity,
        {
            verifySources: () => {
                try {
                    for (const spec of sourceSpecs)
                        readBoundSource(
                            path.join(__dirname, '../../scripts', spec[0]),
                            spec,
                            identity.uid,
                        );
                } catch (error) {
                    if (error?.code === 'entry-source-custody')
                        throw new m.ObservationFailure('entry-source-custody');
                    throw error;
                }
            },
            inspect: async (arch) => {
                const reader = await import('../../scripts/macos-node-cache-reader.mjs');
                return reader.inspectMacCacheMetadata(arch);
            },
            writeOutput: (text) => writeBoundOutput(e.GITHUB_OUTPUT, text, identity.uid),
        },
        {
            outcome: e.OBS_OUTCOME,
            valid: e.OBS_VALID,
            status: e.OBS_STATUS,
            reason: e.OBS_REASON,
            custody: e.OBS_CUSTODY,
        },
    );
}
module.exports = { readBoundSource, writeBoundOutput, sourceSpecs };
if (require.main === module)
    productionMain().then(
        (code) => {
            process.exitCode = code;
        },
        () => {
            process.exitCode = 1;
        },
    );
