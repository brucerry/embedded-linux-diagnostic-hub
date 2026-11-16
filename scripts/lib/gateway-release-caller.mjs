import assert from 'node:assert/strict';
import path from 'node:path';
import { createExpectedGatewayTagReader } from './gateway-tag-reader.mjs';
import { validateExpectedGatewayTagRef } from './owned-git-read.mjs';
import { produceGatewayArchive } from './gateway-archive-producer.mjs';
import { parseGatewayArchiveBuildRecord } from './gateway-build-record.mjs';
import { bindGatewayReleaseProducer } from './gateway-release-producer.mjs';
import { readStableArtifactFile } from './stable-artifact-file.mjs';
import { sourceDigest, SOURCE_LIMITS } from './committed-source-bridge.mjs';
import { verifyGatewayArchiveReadback } from './gateway-archive-readback.mjs';
import { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';

const retained = new Map();
function fields(value, names) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
function absolute(value) {
    assert.ok(
        typeof value === 'string' &&
            value.startsWith('/') &&
            value !== '/' &&
            value.length <= 4096 &&
            path.posix.normalize(value) === value &&
            !/[\\\x00-\x20\x7f]/.test(value),
    );
}
export class GatewayReleaseCallerFailure extends Error {
    constructor(cause, caller) {
        super('Local Gateway release draft failed; outputs and uncertain custody retained.', {
            cause,
        });
        this.caller = caller;
    }
}
/** Offline draft composition, not a release entrypoint or external service authority.
 * Explicit producer IO only. No default source factory/launcher, workflow or upload.
 * Same invocation and matching job labels do not authenticate an actual CI job.
 */
export function createGatewayReleaseDraftCaller(selection, ports) {
    return makeBuildCaller(selection, ports, 'tag');
}
/** Branch qualification shares the real producer/readback without inventing a tag. */
export function createGatewayBranchBuildCaller(selection, ports) {
    return makeBuildCaller(selection, ports, 'branch');
}
function makeBuildCaller(selection, ports, kind) {
    fields(
        selection,
        kind === 'tag'
            ? ['repository', 'tagRef', 'tagObjectID', 'context', 'options', 'git']
            : ['repository', 'context', 'options'],
    );
    const selected = structuredClone(selection);
    assert.equal(selected.repository, 'brucerry/embedded-linux-diagnostic-hub');
    if (kind === 'tag') validateExpectedGatewayTagRef(selected.tagRef);
    fields(selected.context, [
        'scope',
        'version',
        'sourceCommit',
        'sourceTree',
        'runId',
        'runAttempt',
        'jobKey',
    ]);
    assert.equal(selected.context.scope, 'gateway');
    if (kind === 'tag') assert.equal(selected.tagRef, `refs/tags/v${selected.context.version}`);
    for (const key of ['sourceCommit', 'sourceTree'])
        assert.match(selected.context[key], /^[a-f0-9]{40}$/);
    assert.match(selected.context.runId, /^[1-9][0-9]{0,31}$/);
    assert.equal(selected.context.runAttempt, '1');
    assert.match(selected.context.jobKey, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/);
    fields(selected.options, ['sourceRoot', 'leaf']);
    absolute(selected.options.sourceRoot);
    assert.match(selected.options.leaf, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
    if (kind === 'tag') fields(selected.git, ['gitPath', 'gitSHA256', 'environment']);
    fields(ports, ['build', 'tag', 'assertSettled']);
    assert.equal(typeof ports.assertSettled, 'function');
    fields(ports.build, [
        'filesystem',
        'sourceFactory',
        'execute',
        'observeToolchain',
        ...(Object.hasOwn(ports.build ?? {}, 'writeExclusive') ? ['writeExclusive'] : []),
        ...(Object.hasOwn(ports.build ?? {}, 'readArtifact') ? ['readArtifact'] : []),
    ]);
    if (Object.hasOwn(ports.build, 'writeExclusive'))
        assert.equal(typeof ports.build.writeExclusive, 'function');
    if (Object.hasOwn(ports.build, 'readArtifact'))
        assert.equal(typeof ports.build.readArtifact, 'function');
    const build = Object.freeze({ ...ports.build });
    assert.ok(build.filesystem);
    for (const key of ['sourceFactory', 'execute', 'observeToolchain'])
        assert.equal(typeof build[key], 'function');
    for (const key of ['realpath', 'lstat', 'open', 'mkdir', 'readdir'])
        assert.equal(typeof build.filesystem[key], 'function');
    const settle = ports.assertSettled;
    const tagSelection =
        kind === 'tag'
            ? {
                  ...selected.git,
                  root: selected.options.sourceRoot,
                  tagRef: selected.tagRef,
                  tagObjectID: selected.tagObjectID,
                  sourceCommit: selected.context.sourceCommit,
                  sourceTree: selected.context.sourceTree,
              }
            : null;
    const tagPorts = Object.freeze({ ...ports.tag });
    const beforeReader =
        kind === 'tag' ? createExpectedGatewayTagReader(tagSelection, tagPorts) : null;
    const afterReader =
        kind === 'tag' ? createExpectedGatewayTagReader(tagSelection, tagPorts) : null;
    let used = false,
        failed = false,
        complete = false,
        phase = 'ready',
        readersCompleted = 0,
        producerSealed = false,
        readbackVerified = false,
        portsAcknowledged = false;
    const caller = Object.freeze({
        snapshot() {
            return Object.freeze({
                used,
                failed,
                complete,
                phase,
                readersCompleted,
                producerSealed,
                readbackVerified,
                portsAcknowledged,
                sameJobAuthentication: null,
                processGroupRetirement: null,
                releaseAcceptance: false,
            });
        },
        async run() {
            assert.ok(!used, 'Gateway release draft caller is one-shot.');
            used = true;
            retained.set(caller, null);
            try {
                let before = null;
                if (beforeReader) {
                    phase = 'tag-before';
                    before = await beforeReader.read();
                    beforeReader.assertSettled();
                    readersCompleted++;
                }
                phase = 'producer';
                const produced = await produceGatewayArchive(
                    selected.context,
                    selected.options,
                    build,
                );
                // Pin the original function return before any staged read or further callback.
                const originalBytes = Buffer.from(JSON.stringify(produced.record) + '\n');
                assert.ok(originalBytes.length > 0 && originalBytes.length <= 16 * 1024 ** 2);
                const original = parseGatewayArchiveBuildRecord(originalBytes, selected.context);
                const expected = {
                    context: structuredClone(selected.context),
                    buildRecord: {
                        name: 'gateway-build.json',
                        bytes: originalBytes.length,
                        sha256: sourceDigest(originalBytes),
                    },
                    artifacts: [
                        structuredClone(original.archive),
                        structuredClone(original.checksum),
                    ],
                };
                assert.equal(produced.owner.failed, false);
                assert.equal(produced.owner.sealed, true);
                assert.deepEqual(produced.owner.pendingFiles, []);
                assert.deepEqual(produced.owner.plannedCommands, []);
                assert.equal(produced.owner.command, null);
                assert.equal(produced.owner.fileAction, null);
                producerSealed = true;
                phase = 'readback';
                const root = selected.options.sourceRoot;
                const provider = await build.sourceFactory(root);
                const state = await provider.state();
                assert.equal(state.sourceCommit, selected.context.sourceCommit);
                assert.equal(state.sourceTree, selected.context.sourceTree);
                const read = async (relative, maximum) => {
                    const bytes = build.readArtifact
                        ? await build.readArtifact(root + '/' + relative, maximum)
                        : (await readStableArtifactFile(root, relative, maximum, build.filesystem))
                              .bytes;
                    assert.ok(
                        Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum,
                    );
                    return Buffer.from(bytes);
                };
                const stage = 'validation/' + selected.options.leaf;
                const name = `Diagnostic-Hub-Gateway-${selected.context.version}.tar.gz`;
                const recordBytes = await read(
                    stage + '/artifacts/gateway-build.json',
                    16 * 1024 ** 2,
                );
                // The actual files cannot redefine the original record or artifact selections.
                assert.equal(
                    sourceDigest(recordBytes),
                    expected.buildRecord.sha256,
                    'Staged Gateway record differs from the original producer return.',
                );
                assert.equal(recordBytes.length, expected.buildRecord.bytes);
                const archiveBytes = await read(
                    stage + '/artifacts/' + name,
                    WEB_ARCHIVE_LIMITS.archive,
                );
                const checksumBytes = await read(stage + '/artifacts/' + name + '.sha256', 1024);
                const compiledBytes = await read(
                    stage + '/build/main.cjs',
                    WEB_ARCHIVE_LIMITS.member,
                );
                const sourceFile = async (name) => {
                    const file = await provider.file(name);
                    assert.ok(
                        Buffer.isBuffer(file.bytes) &&
                            file.bytes.length > 0 &&
                            file.bytes.length <= SOURCE_LIMITS.blob,
                    );
                    return Buffer.from(file.bytes);
                };
                const sourcePackageBytes = await sourceFile('package.json');
                const sourceLockBytes = await sourceFile('package-lock.json');
                let binding = null,
                    branchRecord = null;
                if (afterReader) {
                    phase = 'tag-after';
                    const after = await afterReader.read();
                    afterReader.assertSettled();
                    readersCompleted++;
                    assert.deepEqual(
                        after,
                        before,
                        'Selected tag/source observations differ across the producer invocation.',
                    );
                    phase = 'binding';
                    binding = bindGatewayReleaseProducer(
                        {
                            build: {
                                recordBytes,
                                archiveBytes,
                                checksumBytes,
                                compiledBytes,
                                sourcePackageBytes,
                                sourceLockBytes,
                            },
                            refBefore: before.refBefore,
                            refAfter: after.refAfter,
                            objects: after.objects,
                        },
                        {
                            repository: selected.repository,
                            tagRef: selected.tagRef,
                            tagObjectID: selected.tagObjectID,
                            build: expected,
                        },
                    );
                } else {
                    phase = 'binding';
                    branchRecord = verifyGatewayArchiveReadback(
                        {
                            recordBytes,
                            archiveBytes,
                            checksumBytes,
                            compiledBytes,
                            sourcePackageBytes,
                            sourceLockBytes,
                        },
                        expected,
                    );
                }
                readbackVerified = true;
                phase = 'settling';
                assert.equal(
                    await settle(),
                    undefined,
                    'Local custody acknowledgement must return undefined.',
                );
                portsAcknowledged = true;
                const result = Object.freeze({
                    kind:
                        kind === 'tag'
                            ? 'gateway-release-local-caller-draft'
                            : 'gateway-branch-local-build',
                    status: 'local-package-readback-complete',
                    binding,
                    originalBuildRecord: Object.freeze({ ...expected.buildRecord }),
                    ...(kind === 'branch' ? { record: branchRecord } : {}),
                    local: Object.freeze({
                        sameInvocation: true,
                        readersCompleted,
                        producerSealed,
                        readbackVerified,
                        portsAcknowledged,
                    }),
                    sameJobAuthentication: null,
                    nativeQualification: false,
                    releaseAcceptance: false,
                });
                phase = 'complete';
                complete = true;
                retained.delete(caller);
                return result;
            } catch (cause) {
                failed = true;
                phase = 'failed';
                retained.set(caller, cause);
                throw new GatewayReleaseCallerFailure(cause, caller);
            }
        },
    });
    return caller;
}
