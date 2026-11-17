// Same-job local archive wiring only. Import starts no build, server or browser.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mainLocal } from '../produce-web-archive.mjs';
import { createOwnedWebCapabilities } from './owned-web-capabilities.mjs';
import { localSourceProvider } from './committed-source-provider.mjs';
import { observeSourceBridge } from './committed-source-bridge.mjs';
import {
    readLocalWebStartupInput,
    inspectLocalWebStartupInput,
} from './final-web-startup-producer.mjs';
import { createLocalWebHost } from './final-web-runtime.mjs';
import { readStableArtifactFile } from './web-archive-producer.mjs';
import { WebBuildCustodyFailure } from './owned-web-build.mjs';
import { types } from 'node:util';

const retained = new Set();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blocked = [
    'native-executor-group-and-profile-admission',
    'independent-service-build-provenance',
    'installed-toolchain-provenance',
    'product-runtime',
    'loader',
    'per-GC-policies-and-measurements',
    'normal-retirement',
];
function closed(value, names) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}

/** Retain only the existing producer's own build-failure owner, never a serialized count.
 * Null means the failure cannot establish whether compiler acquisition/closure occurred. */
export function webBaselineBuildFailureOwner(error) {
    if (
        !error ||
        typeof error !== 'object' ||
        types.isProxy(error) ||
        !types.isNativeError(error) ||
        !(error instanceof WebBuildCustodyFailure)
    )
        return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'owner');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    const owner = descriptor.value;
    if (!owner || typeof owner !== 'object' || types.isProxy(owner) || !Object.isFrozen(owner))
        return null;
    for (const name of ['snapshot', 'waitForDirectClosure']) {
        const method = Object.getOwnPropertyDescriptor(owner, name);
        if (!method || !Object.hasOwn(method, 'value') || typeof method.value !== 'function')
            return null;
    }
    return owner;
}

/** Compare the ORIGINAL producer output with independently read actual archive inputs.
 * This authenticates neither an external service nor the original writer of a record file. */
export function inspectWebBaselineArchive(stdout, input, expected, environmentSHA256) {
    assert.ok(Buffer.isBuffer(stdout) && stdout.length > 0 && stdout.length <= 4096);
    assert.match(environmentSHA256, /^[a-f0-9]{64}$/);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout);
    const original = JSON.parse(text);
    assert.equal(text, JSON.stringify(original) + '\n');
    closed(original, [
        'status',
        'archive',
        'completeChildEnvironmentSHA256',
        'releaseAcceptance',
        'blocked',
    ]);
    assert.equal(original.status, 'built');
    assert.equal(original.releaseAcceptance, false);
    assert.deepEqual(original.blocked, blocked);
    assert.equal(original.completeChildEnvironmentSHA256, environmentSHA256);
    assert.deepEqual(input.context, expected);
    assert.deepEqual(input.observer, {
        diagnosticId: expected.diagnosticId,
        toolingCommit: expected.sourceCommit,
    });
    const inspected = inspectLocalWebStartupInput(input);
    assert.deepEqual(original.archive, inspected.record.archive);
    assert.equal(digest(input.archiveBytes), original.archive.sha256);
    assert.equal(input.archiveBytes.length, original.archive.bytes);
    return Object.freeze({
        fingerprint: inspected.fingerprint,
        originalStdoutSHA256: digest(stdout),
        archiveSHA256: digest(input.archiveBytes),
        buildRecordSHA256: digest(input.buildRecordBytes),
        checksumSHA256: digest(input.checksumBytes),
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
        completeChildEnvironmentSHA256: environmentSHA256,
        releaseAcceptance: false,
    });
}

/** Caller supplies actual filesystem/process/timer/server ports in its already-owned scope.
 * The actual canonical producer and existing stable readers cannot be replaced through these ports.
 * No default native effects, service IDs, final-Web admission receipt or failure cleanup. */
export async function prepareWebBaselineArchive(selection, ports) {
    closed(selection, [
        'root',
        'version',
        'sourceCommit',
        'sourceTree',
        'diagnosticId',
        'gitPath',
        'gitSHA256',
        'environment',
    ]);
    const chosen = structuredClone(selection);
    assert.ok(path.isAbsolute(chosen.root) && path.posix.normalize(chosen.root) === chosen.root);
    assert.equal(chosen.root, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    assert.match(chosen.sourceCommit, /^[a-f0-9]{40}$/);
    assert.match(chosen.sourceTree, /^[a-f0-9]{40}$/);
    assert.match(chosen.diagnosticId, /^[a-f0-9]{32}$/);
    assert.match(
        chosen.version,
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?$/,
    );
    for (const name of ['launch', 'setTimer', 'clearTimer', 'now', 'createServer'])
        assert.equal(typeof ports?.[name], 'function');
    const supplied = Object.freeze({ ...ports });
    const context = Object.freeze({
        scope: 'local-web-diagnostic',
        version: chosen.version,
        sourceCommit: chosen.sourceCommit,
        sourceTree: chosen.sourceTree,
        diagnosticId: chosen.diagnosticId,
    });
    const artifactDirectory = 'validation/local-web-baseline-' + chosen.diagnosticId;
    const selectionFile = artifactDirectory + '/local-web-startup-selection.json';
    const state = {
        phase: 'admitted',
        failed: false,
        first: undefined,
        pending: true,
        producerInvoked: false,
        producerClosureAcknowledged: false,
        buildFailureOwner: null,
        capability: null,
        source: null,
        stdout: null,
        input: null,
        host: null,
        binding: null,
    };
    const snapshot = () =>
        Object.freeze({
            phase: state.phase,
            failed: state.failed,
            pending: state.pending,
            producerInvoked: state.producerInvoked,
            producerClosureAcknowledged: state.producerClosureAcknowledged,
            unknownProducerCustody:
                state.failed && state.producerInvoked && !state.producerClosureAcknowledged,
            build: state.buildFailureOwner?.snapshot() ?? null,
            summaryRetained: state.stdout !== null,
            archiveRetained: state.input !== null,
            host: state.host?.snapshot() ?? null,
            files: state.capability?.snapshot() ?? null,
            serviceProvenance: null,
            releaseAcceptance: false,
        });
    const owner = Object.freeze({
        snapshot,
        failureOwner: () => state.buildFailureOwner,
        assertSettled() {
            assert.equal(state.pending, false);
            assert.ok(
                !state.producerInvoked || state.producerClosureAcknowledged,
                'Original producer closure is unknown.',
            );
            if (state.host) assert.equal(state.host.snapshot().listenerClosed, true);
            state.capability?.assertSettled();
        },
        async waitForDirectClosure() {
            assert.ok(state.buildFailureOwner, 'No original compiler owner; closure is unknown.');
            const result = await state.buildFailureOwner.waitForDirectClosure();
            assert.ok(
                result.childAcquired &&
                    result.spawned &&
                    result.exited &&
                    result.childClosed &&
                    result.stdoutClosed &&
                    result.stderrClosed,
            );
            state.producerClosureAcknowledged = true;
            return result;
        },
    });
    retained.add(owner); // Before any filesystem/process acquisition.
    const fail = (error) => {
        if (!state.failed) {
            state.failed = true;
            state.first = error;
        }
        state.phase = 'failed';
    };
    try {
        const capability = createOwnedWebCapabilities(
            {
                gitPath: chosen.gitPath,
                gitSHA256: chosen.gitSHA256,
                environment: chosen.environment,
            },
            supplied,
        );
        state.capability = capability;
        assert.equal(await capability.filesystem.realpath(chosen.root), chosen.root);
        const provider = await localSourceProvider(chosen.root, {
            filesystem: capability.filesystem,
            execute: capability.executeGit,
            asynchronous: true,
            platform: process.platform,
            environment: capability.gitEnvironment,
        });
        state.source = provider;
        await observeSourceBridge(
            { sourceCommit: chosen.sourceCommit, sourceTree: chosen.sourceTree },
            provider,
        );
        state.phase = 'building';
        state.producerInvoked = true;
        await mainLocal(
            [
                '--scope=local-web-diagnostic',
                '--version=' + chosen.version,
                '--source-commit=' + chosen.sourceCommit,
                '--source-tree=' + chosen.sourceTree,
                '--diagnostic-id=' + chosen.diagnosticId,
                '--output=' + artifactDirectory,
            ],
            capability,
            (bytes) => {
                assert.equal(state.stdout, null, 'Producer summary is one-use.');
                assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4096);
                state.stdout = Buffer.from(bytes);
            },
        );
        state.producerClosureAcknowledged = true; // Actual producer returned after its custody validator and assertSettled.
        assert.ok(state.stdout !== null, 'Original producer summary is required.');
        state.phase = 'reading-originals';
        const selectedBytes = Buffer.from(
            JSON.stringify({
                artifactDirectory,
                context,
                observer: { diagnosticId: chosen.diagnosticId, toolingCommit: chosen.sourceCommit },
            }) + '\n',
        );
        await capability.filesystem.writeFile(
            path.join(chosen.root, selectionFile),
            selectedBytes,
            { flag: 'wx' },
        );
        const original = await readLocalWebStartupInput(
            chosen.root,
            selectionFile,
            capability.filesystem,
        );
        assert.ok(
            (
                await readStableArtifactFile(
                    chosen.root,
                    selectionFile,
                    16 * 1024,
                    capability.filesystem,
                )
            ).bytes.equals(selectedBytes),
        );
        state.input = Object.freeze({
            context,
            observer: Object.freeze({
                diagnosticId: chosen.diagnosticId,
                toolingCommit: chosen.sourceCommit,
            }),
            archiveBytes: Buffer.from(original.input.archiveBytes),
            buildRecordBytes: Buffer.from(original.input.buildRecordBytes),
            checksumBytes: Buffer.from(original.input.checksumBytes),
        });
        state.binding = inspectWebBaselineArchive(
            state.stdout,
            state.input,
            context,
            capability.profile.sha256,
        );
        assert.equal(original.fingerprint, state.binding.fingerprint);
        await observeSourceBridge(
            { sourceCommit: chosen.sourceCommit, sourceTree: chosen.sourceTree },
            provider,
        );
        capability.assertSettled();
        state.phase = 'prepared';
        state.host = createLocalWebHost(
            state.input.archiveBytes,
            state.input.buildRecordBytes,
            context,
            {},
            { createServer: supplied.createServer },
        );
        async function revalidate() {
            assert.ok(
                !state.failed && !state.pending,
                'Failed or concurrent archive revalidation is unsupported.',
            );
            state.pending = true;
            try {
                assert.ok(
                    (
                        await readStableArtifactFile(
                            chosen.root,
                            selectionFile,
                            16 * 1024,
                            capability.filesystem,
                        )
                    ).bytes.equals(selectedBytes),
                );
                const current = await readLocalWebStartupInput(
                    chosen.root,
                    selectionFile,
                    capability.filesystem,
                );
                const checked = inspectWebBaselineArchive(
                    state.stdout,
                    current.input,
                    context,
                    capability.profile.sha256,
                );
                assert.deepEqual(checked, state.binding);
                assert.ok(current.input.archiveBytes.equals(state.input.archiveBytes));
                assert.ok(current.input.buildRecordBytes.equals(state.input.buildRecordBytes));
                assert.ok(current.input.checksumBytes.equals(state.input.checksumBytes));
                await observeSourceBridge(
                    { sourceCommit: chosen.sourceCommit, sourceTree: chosen.sourceTree },
                    provider,
                );
                capability.assertSettled();
                return state.binding;
            } catch (error) {
                fail(error);
                throw error;
            } finally {
                state.pending = false;
            }
        }
        state.pending = false;
        return Object.freeze({ host: state.host, revalidate, snapshot, binding: state.binding });
    } catch (error) {
        state.buildFailureOwner = webBaselineBuildFailureOwner(error);
        fail(error);
        state.pending = false;
        throw Object.assign(
            Error('Same-job Web archive preparation failed; original custody retained.', {
                cause: error,
            }),
            { owner },
        );
    }
}
