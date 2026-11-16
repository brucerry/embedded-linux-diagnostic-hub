import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GATEWAY_RUNTIME_CHILD_FILES } from './gateway-runtime-input-bridge.mjs';
import { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';

export const HEALTH_JOB_BRANCH = 'ci/v060-gateway-health-root-metadata-20261116';
const repository = 'brucerry/embedded-linux-diagnostic-hub';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const held = new Set();
const zeroFiles = (s) =>
    s && ['pending', 'handles'].every((key) => Number.isSafeInteger(s[key]) && s[key] === 0);
function absolute(value) {
    assert.ok(
        typeof value === 'string' &&
            value.startsWith('/') &&
            value !== '/' &&
            value.length <= 4096 &&
            !/[\\\x00-\x20\x7f]/.test(value),
    );
    assert.equal(path.posix.normalize(value), value);
}
function synchronous(value) {
    if (value && typeof value.then === 'function') {
        Promise.resolve(value).catch(() => {});
        throw new Error('Unknown custody.');
    }
    assert.ok(value && typeof value === 'object');
    return value;
}
export class GatewayHealthJobFailure extends Error {
    constructor(cause, owner) {
        super('Gateway health job failed; original state retained.', { cause });
        this.owner = owner;
    }
}

/** One current-job orchestration. All IO is supplied; imports never run a producer or Gateway.
 * The callback receives the original producer binding from the native bootstrap, rather than
 * deriving expected identities from a staged receipt. This is local smoke, not CI authentication,
 * SSH/resource qualification, installation, upload provenance or release admission.
 */
export function createGatewayHealthJob(input, ports) {
    const runtime = structuredClone(input);
    assert.equal(typeof ports.build, 'function');
    assert.equal(typeof ports.makeAdapter, 'function');
    let used = false,
        active = false,
        bootstrap,
        adapter,
        failed = false,
        phase = 'admission',
        reportAttempted = false,
        reportWritten = false;
    const unknownFactories = new Set();
    const owner = Object.freeze({
        snapshot: () => ({
            used,
            active,
            failed,
            phase,
            reportAttempted,
            reportWritten,
            unknownFactories: unknownFactories.size,
            bootstrap: bootstrap?.snapshot() ?? null,
            physical: adapter?.owner.snapshot() ?? null,
            releaseAcceptance: false,
        }),
        quiescent() {
            try {
                if (active || unknownFactories.size) return false;
                if (bootstrap && bootstrap.quiescent() !== true) return false;
                if (adapter) {
                    const s = synchronous(adapter.owner.snapshot());
                    if (
                        !['pendingCalls', 'nativeHandles', 'unknownReturns'].every(
                            (k) => s[k] === 0,
                        ) ||
                        !zeroFiles(s.files) ||
                        !Array.isArray(s.bridges) ||
                        !Array.isArray(s.children)
                    )
                        return false;
                    if (
                        !s.bridges.every(
                            (b) =>
                                b.pendingCalls === 0 &&
                                b.unknownReturns === 0 &&
                                (b.directClosed === true ||
                                    (b.child?.directRetired === true &&
                                        b.child.unknownOperations === 0)),
                        )
                    )
                        return false;
                    // EOF remains mandatory for success in the command/physical adapter. A
                    // failed pipe that is known closed does not become live IO merely because
                    // EOF was missing. Publication uncertainty stays retained on disk.
                    if (
                        !s.children.every((c) =>
                            ['exit', 'close', 'stdin', 'stdout', 'stderr'].every(
                                (k) => c[k] === true,
                            ),
                        )
                    )
                        return false;
                }
                return true;
            } catch {
                return false;
            }
        },
        async run() {
            assert.ok(!used, 'Gateway health job is one-shot.');
            used = true;
            active = true;
            held.add(owner);
            let selected;
            const publish = async (result, reason) => {
                assert.ok(!reportAttempted && adapter);
                reportAttempted = true;
                const bytes = Buffer.from(
                    JSON.stringify({
                        schemaVersion: 1,
                        kind: 'gateway-current-job-health-diagnostic',
                        repository,
                        ref: selected.ref,
                        sourceCommit: selected.sourceCommit,
                        runId: selected.runId,
                        runAttempt: '1',
                        jobKey: 'gateway_build',
                        result,
                        phase,
                        reason,
                        releaseAcceptance: false,
                    }) + '\n',
                );
                assert.ok(bytes.length <= 8192);
                await adapter.ports.writeExclusive(selected.reportPath, bytes);
                reportWritten = true;
            };
            try {
                const e = runtime.environment;
                for (const [k, v] of Object.entries({
                    GITHUB_ACTIONS: 'true',
                    GITHUB_REPOSITORY: repository,
                    GITHUB_REF: 'refs/heads/' + HEALTH_JOB_BRANCH,
                    GITHUB_EVENT_NAME: 'push',
                    GITHUB_RUN_ATTEMPT: '1',
                    GITHUB_JOB: 'gateway_build',
                    RUNNER_ENVIRONMENT: 'github-hosted',
                    RUNNER_OS: 'Linux',
                    RUNNER_ARCH: 'X64',
                }))
                    assert.equal(e[k], v);
                assert.match(e.GITHUB_SHA, /^[a-f0-9]{40}$/);
                assert.match(e.GITHUB_RUN_ID, /^[1-9][0-9]{0,31}$/);
                assert.equal(e.GITHUB_WORKFLOW_SHA, e.GITHUB_SHA);
                assert.equal(
                    e.GITHUB_WORKFLOW_REF,
                    repository +
                        '/.github/workflows/gateway-same-job-health-smoke.yml@' +
                        e.GITHUB_REF,
                );
                assert.equal(runtime.platform, 'linux');
                assert.equal(runtime.arch, 'x64');
                assert.equal(runtime.version, 'v24.22.2');
                assert.ok(Number.isSafeInteger(runtime.uid) && runtime.uid > 0);
                assert.deepEqual(runtime.execArgv, []);
                absolute(e.RUNNER_TEMP);
                absolute(e.GITHUB_WORKSPACE);
                absolute(runtime.entryFile);
                const nodePath =
                    e.RUNNER_TEMP + '/gateway-publisher-node-' + e.GITHUB_RUN_ID + '-1/bin/node';
                assert.equal(runtime.execPath, nodePath);
                assert.equal(
                    runtime.entryFile,
                    e.GITHUB_WORKSPACE + '/scripts/observe-gateway-health-job.mjs',
                );
                assert.deepEqual(runtime.argv, [nodePath, runtime.entryFile, '--qualify-branch']);
                selected = {
                    ref: e.GITHUB_REF,
                    sourceCommit: e.GITHUB_SHA,
                    runId: e.GITHUB_RUN_ID,
                    reportPath:
                        e.RUNNER_TEMP + '/gateway-health-job-' + e.GITHUB_RUN_ID + '-1.json',
                };
                phase = 'canonical-build';
                let callbackCount = 0;
                const result = await ports.build(
                    async (frame) => {
                        assert.equal(++callbackCount, 1);
                        phase = 'package-readback';
                        assert.equal(frame.sourceRoot, e.GITHUB_WORKSPACE);
                        assert.deepEqual(frame.context, {
                            scope: 'gateway',
                            version: '0.6.0',
                            sourceCommit: e.GITHUB_SHA,
                            sourceTree: frame.sourceSelection.sourceTree,
                            runId: e.GITHUB_RUN_ID,
                            runAttempt: '1',
                            jobKey: 'gateway_build',
                        });
                        assert.equal(frame.sourceSelection.sourceCommit, e.GITHUB_SHA);
                        assert.match(frame.context.sourceTree, /^[a-f0-9]{40}$/);
                        const record = frame.record;
                        assert.deepEqual(record.context, frame.context);
                        const stage = frame.sourceRoot + '/validation/gateway-current-build';
                        const archiveName = 'Diagnostic-Hub-Gateway-0.6.0.tar.gz';
                        assert.equal(record.archive.name, archiveName);
                        assert.equal(record.checksum.name, archiveName + '.sha256');
                        const readback = {
                            recordBytes: await frame.readFile(
                                stage + '/artifacts/gateway-build.json',
                                16 * 1024 ** 2,
                            ),
                            archiveBytes: await frame.readFile(
                                stage + '/artifacts/' + archiveName,
                                WEB_ARCHIVE_LIMITS.archive,
                            ),
                            checksumBytes: await frame.readFile(
                                stage + '/artifacts/' + archiveName + '.sha256',
                                1024,
                            ),
                            sourcePackageBytes: await frame.sourceFile('package.json'),
                            sourceLockBytes: await frame.sourceFile('package-lock.json'),
                            compiledBytes: await frame.readFile(
                                stage + '/build/main.cjs',
                                WEB_ARCHIVE_LIMITS.member,
                            ),
                        };
                        assert.equal(readback.recordBytes.length, frame.originalBuildRecord.bytes);
                        assert.equal(sha(readback.recordBytes), frame.originalBuildRecord.sha256);
                        phase = 'tool-selection';
                        const profile = JSON.parse(
                            (
                                await frame.sourceFile('scripts/ci/gateway-four-tool-inputs.json')
                            ).toString('utf8'),
                        );
                        assert.equal(profile.node.version, '24.22.2');
                        assert.equal(record.builder.runtime.executablePath, nodePath);
                        assert.equal(record.builder.runtime.node, 'v24.22.2');
                        assert.equal(record.builder.runtime.executableSHA256, profile.node.sha256);
                        assert.equal((await frame.lstat(nodePath)).size, profile.node.bytes);
                        // Fixed system alias: inspect its parents before following it. Never copy,
                        // change modes, substitute a downloaded Python or traverse a refused parent.
                        // The source-file facade intentionally refuses the filesystem root.
                        // Use its distinct fixed metadata capability for that one observation.
                        const root = await frame.systemRoot.lstat();
                        assert.ok(
                            root.isDirectory() &&
                                !root.isSymbolicLink() &&
                                root.uid === 0 &&
                                !(root.mode & 0o7022),
                        );
                        assert.equal(await frame.systemRoot.realpath(), '/');
                        for (const p of ['/usr', '/usr/bin']) {
                            const row = await frame.lstat(p);
                            assert.ok(
                                row.isDirectory() &&
                                    !row.isSymbolicLink() &&
                                    row.uid === 0 &&
                                    !(row.mode & 0o7022),
                            );
                            assert.equal(await frame.realpath(p), p);
                        }
                        const alias = await frame.lstat('/usr/bin/python3');
                        assert.equal(alias.uid, 0);
                        assert.ok(
                            alias.isSymbolicLink() || (alias.isFile() && !(alias.mode & 0o7022)),
                        );
                        const pythonPath = await frame.realpath('/usr/bin/python3');
                        absolute(pythonPath);
                        assert.ok(/^\/usr\/bin\/python3\.\d{1,2}$/.test(pythonPath));
                        const py = await frame.lstat(pythonPath);
                        assert.ok(
                            py.isFile() &&
                                !py.isSymbolicLink() &&
                                py.uid === 0 &&
                                py.nlink === 1 &&
                                !(py.mode & 0o7022) &&
                                py.mode & 0o111,
                        );
                        const pythonSHA256 = sha(await frame.readFile(pythonPath, 32 * 1024 ** 2));
                        const sourceFiles = {};
                        for (const name of GATEWAY_RUNTIME_CHILD_FILES) {
                            const original = await frame.sourceFile(name);
                            assert.ok(
                                (
                                    await frame.readFile(
                                        frame.sourceRoot + '/' + name,
                                        4 * 1024 ** 2,
                                    )
                                ).equals(original),
                            );
                            sourceFiles[name] = sha(original);
                        }
                        const created = ports.makeAdapter({
                            sourceRoot: frame.sourceRoot,
                            temporaryRoot: e.RUNNER_TEMP,
                            uid: runtime.uid,
                            nodePath,
                            pythonPath,
                            pythonSHA256,
                            sourceFiles,
                        });
                        // The physical factory is synchronous and inert until .run(). Never
                        // normalize an unsupported factory Promise or lose its possible owner.
                        if (created && typeof created.then === 'function') {
                            unknownFactories.add(created);
                            Promise.resolve(created).catch(() => {});
                            throw new Error('Unsupported adapter factory return.');
                        }
                        adapter = created;
                        assert.equal(typeof adapter?.run, 'function');
                        assert.equal(typeof adapter?.owner?.snapshot, 'function');
                        assert.equal(typeof adapter?.ports?.writeExclusive, 'function');
                        assert.equal(typeof adapter?.ports?.assertSettled, 'function');
                        phase = 'health';
                        return adapter.run({
                            readback,
                            expected: {
                                context: frame.context,
                                buildRecord: frame.originalBuildRecord,
                                artifacts: [record.archive, record.checksum],
                            },
                            builder: record.builder,
                            sourceRoot: frame.sourceRoot,
                            temporaryRoot: e.RUNNER_TEMP,
                            uid: runtime.uid,
                        });
                    },
                    (value) => {
                        assert.ok(!bootstrap);
                        bootstrap = value;
                    },
                );
                assert.equal(callbackCount, 1);
                assert.equal(result.healthSmoke?.releaseAcceptance, false);
                assert.ok(bootstrap && adapter);
                phase = 'complete';
                await publish('passed', 'none');
                adapter.ports.assertSettled();
                return {
                    result: 'passed',
                    sameJobAuthentication: null,
                    uploadAttribution: null,
                    nativeQualification: false,
                    releaseAcceptance: false,
                };
            } catch (cause) {
                failed = true;
                if (adapter && !reportAttempted) {
                    try {
                        await publish('failed', 'operation-failed');
                    } catch {
                        /* Original cause wins; uncertain report custody remains in adapter. */
                    }
                }
                throw new GatewayHealthJobFailure(cause, owner);
            } finally {
                active = false;
                if (owner.quiescent()) held.delete(owner);
            }
        },
    });
    return owner;
}
