import assert from 'node:assert/strict';
import path from 'node:path';
import { digest, installerCases, laneFiles } from './staged-artifact-gate.mjs';
import { validateMacInstallerActionResult } from './macos-installer-actions.mjs';

export const INSTALLER_RECEIPT_LIMIT = 8192;
export const INSTALLER_STAGE_LIMIT = 65536;
export const MAC_FIXTURE_STAGES = Object.freeze(
    [
        ['package-shape', ['install']],
        ['cancelled-review', ['install']],
        ['initial-install', ['install']],
        ['input-refusals', ['install', 'profile-report-preservation']],
        ['busy-refusal', ['busy-refusal']],
        ['interrupted-replacement', ['interrupted-recovery']],
        ['launch-refusal-rollback', ['interrupted-recovery']],
        ['same-version-repair', ['repair']],
        ['installed-package-integrity', ['install', 'repair']],
        ['manual-helper-launch', ['offline-launch']],
        ['fixture-teardown', []],
    ].map(([id, cases]) => Object.freeze({ id, cases: Object.freeze(cases) })),
);

// These are the nine existing consumer requirements, not additional acceptance policy.
// Related helper fixtures identify partial coverage; they never implement a native case.
const MAC_NATIVE_REQUIREMENTS = Object.freeze({
    install: [
        'Install the final staged package on the native Mac lane.',
        'Actual final-package native installation evidence.',
    ],
    'offline-launch': [
        'Launch the installed final package offline.',
        'Actual offline launch evidence; a CDP launch alone is insufficient.',
    ],
    'busy-refusal': [
        'Refuse installer work while the owned application is busy.',
        'Actual busy-refusal evidence tied to the owned installation.',
    ],
    repair: ['Repair the installed final package.', 'Actual native repair evidence.'],
    'update-distinct-version': [
        'Replace a distinct installed version with the final package using manual native bundle replacement.',
        'Distinct prior-version payload and actual native replacement evidence.',
    ],
    'interrupted-recovery': [
        'Recover an interrupted installer operation.',
        'Actual interruption and recovery evidence; the method needs separate effects review.',
    ],
    'profile-report-preservation': [
        'Preserve application profiles and reports through the installer lifecycle.',
        'Actual application profile/report preservation evidence; the sibling marker is insufficient.',
    ],
    'owned-integrations': [
        'Verify the installation-owned integrations.',
        'Native evidence of the integrations this installer actually owns; do not invent Mac registry or shortcut requirements.',
    ],
    remove: [
        'Remove the owned installation.',
        'Actual owned-installation removal evidence; deleting fixture helpers is insufficient.',
    ],
});

export function macInstallerLifecycleDefinitions(lane) {
    assert.ok(['darwin-x64', 'darwin-arm64'].includes(lane));
    return Object.freeze(
        installerCases(lane).map((id) => {
            const name = id.slice('macos-bundle:'.length);
            assert.ok(Object.hasOwn(MAC_NATIVE_REQUIREMENTS, name));
            const [requirement, missingNativeProof] = MAC_NATIVE_REQUIREMENTS[name];
            return Object.freeze({
                id,
                requirement,
                contract: 'docs/platform-artifact-gates.md:required installer qualification inputs',
                fixtureStages: Object.freeze(
                    MAC_FIXTURE_STAGES.filter((stage) => stage.cases.includes(name)).map(
                        (stage) => stage.id,
                    ),
                ),
                executionStatus: 'unexecuted',
                qualificationStatus: 'unverified',
                requiresDistinctVersion: name === 'update-distinct-version',
                missingNativeProof,
            });
        }),
    );
}

const canonicalTime = (value) => {
    assert.equal(typeof value, 'string');
    assert.equal(new Date(value).toISOString(), value);
    return value;
};
const hash = (value) => assert.match(value, /^[a-f0-9]{64}$/);
function commandVector(command) {
    assert.ok(Array.isArray(command) && command.length > 0 && command.length <= 32);
    for (const part of command)
        assert.ok(typeof part === 'string' && part.length > 0 && part.length <= 4096);
}
function boundedJSON(value, maximum) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
    assert.ok(bytes.length <= maximum, 'Installer evidence exceeds its complete UTF-8 bound.');
    return bytes;
}

export function assertMacInstallerHelperReturn(fact) {
    assert.equal(fact.error, 'none', 'Unexpected helper execution error.');
    assert.equal(fact.signal, null, 'Unexpected signalled helper return.');
    assert.ok(
        Number.isInteger(fact.exitCode) && fact.exitCode >= 0 && fact.exitCode <= 255,
        'A normal observed helper exit is required.',
    );
    const expected = fact.expectedReturn ?? 'normal';
    assert.ok(['normal', 'success', 'refusal', 'term-trap'].includes(expected));
    if (expected === 'success') assert.equal(fact.exitCode, 0);
    if (expected === 'refusal') assert.notEqual(fact.exitCode, 0);
    if (expected === 'term-trap') {
        assert.equal(fact.stage, 'interrupted-replacement');
        assert.equal(fact.exitCode, 143, 'The deliberate TERM trap must return normally with 143.');
    }
}

// Exactly one allocation, no retry/adoption/cleanup. Retain the returned path before realpath.
export async function allocateMacInstallerFixture(prefix, state, io) {
    assert.equal(state.allocation, 'unexecuted');
    assert.equal(state.allocatedPath, null);
    state.allocation = 'pending';
    try {
        state.allocatedPath = await io.mkdtemp(prefix);
    } catch {
        state.allocation = 'unknown';
        state.failure = 'FIXTURE_ALLOCATION_RETURN_UNKNOWN';
        throw new Error(state.failure);
    }
    state.allocation = 'returned';
    state.canonicalization = 'pending';
    try {
        assert.ok(
            typeof state.allocatedPath === 'string' && path.posix.isAbsolute(state.allocatedPath),
        );
        state.canonicalReturnedPath = await io.realpath(state.allocatedPath);
        assert.ok(
            typeof state.canonicalReturnedPath === 'string' &&
                path.posix.isAbsolute(state.canonicalReturnedPath),
        );
        state.canonicalRoot = state.canonicalReturnedPath;
        state.canonicalization = 'validated';
        return state.canonicalRoot;
    } catch {
        state.canonicalization = 'failed';
        state.failure = 'FIXTURE_CANONICALIZATION_FAILED';
        throw new Error(state.failure);
    }
}
export function macInstallerPublishRoot(state) {
    return state.allocation === 'returned' &&
        state.canonicalization === 'validated' &&
        typeof state.canonicalRoot === 'string' &&
        path.posix.isAbsolute(state.canonicalRoot)
        ? state.canonicalRoot
        : null;
}
export function macInstallerAllocationDiagnostic(state, reason, publicationAttempted = false) {
    assert.ok(
        [
            'FIXTURE_ALLOCATION_RETURN_UNKNOWN',
            'FIXTURE_CANONICALIZATION_FAILED',
            'QUALIFICATION_PUBLICATION_FAILED',
        ].includes(reason),
    );
    const safePath = (value) =>
        typeof value === 'string' && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 3000
            ? value
            : null;
    const canonicalRoot = macInstallerPublishRoot(state);
    const value = {
        kind: 'macos-installer-allocation-failure',
        reason,
        publicationAttempted,
        allocatedPath: safePath(state.allocatedPath),
        canonicalRoot: safePath(canonicalRoot),
        allocatedPathUnavailable:
            state.allocation === 'unknown' ||
            (state.allocatedPath !== null && safePath(state.allocatedPath) === null),
        canonicalRootUnavailable: canonicalRoot !== null && safePath(canonicalRoot) === null,
    };
    return boundedJSON(value, INSTALLER_RECEIPT_LIMIT);
}

// Fixture observations never become native qualification, even if every assertion returns.
// Exit/EOF and independent review belong to the later external owner/reviewer.
export function createMacInstallerObservation({
    context,
    runtime,
    artifacts,
    command,
    startedAt,
    compactCommandEvidence = false,
}) {
    assert.equal(typeof compactCommandEvidence, 'boolean');
    assert.deepEqual(Object.keys(context).sort(), ['sourceCommit', 'sourceTree', 'version']);
    assert.deepEqual(Object.keys(runtime).sort(), [
        'arch',
        'executable',
        'executableSHA256',
        'node',
        'osRelease',
        'platform',
    ]);
    assert.match(context.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
    for (const key of ['sourceCommit', 'sourceTree']) assert.match(context[key], /^[a-f0-9]{40}$/);
    assert.equal(runtime.platform, 'darwin');
    assert.ok(['x64', 'arm64'].includes(runtime.arch));
    assert.match(runtime.node, /^24\./);
    assert.ok(path.posix.isAbsolute(runtime.executable));
    assert.ok(
        typeof runtime.osRelease === 'string' &&
            runtime.osRelease.length > 0 &&
            runtime.osRelease.length < 256,
    );
    hash(runtime.executableSHA256);
    commandVector(command);
    const lane = 'darwin-' + runtime.arch;
    const nativeCases = macInstallerLifecycleDefinitions(lane);
    assert.ok(Array.isArray(artifacts));
    assert.deepEqual(artifacts.map((item) => item.name).sort(), laneFiles(context.version, lane));
    for (const item of artifacts) {
        assert.deepEqual(Object.keys(item).sort(), ['bytes', 'name', 'sha256']);
        assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 0);
        hash(item.sha256);
    }
    const bound = structuredClone({
        context,
        runtime,
        artifacts,
        command,
        startedAt: canonicalTime(startedAt),
    });
    const stages = MAC_FIXTURE_STAGES.map(({ id }) => ({
        id,
        status: 'unexecuted',
    }));
    const helpers = [];
    let next = 0;
    let active = null;
    let terminal = false;
    let failure = null;
    let completedAt = null;
    let nativeActionResults = null;
    let actionOnly = false;
    return Object.freeze({
        attachNativeActions(value) {
            assert.ok(!terminal && active === null && nativeActionResults === null);
            validateMacInstallerActionResult(value);
            assert.equal(value.lane, lane);
            if (value.bindings) {
                assert.equal(value.bindings.current.version, bound.context.version);
                assert.equal(value.bindings.current.sourceCommit, bound.context.sourceCommit);
                assert.equal(
                    value.bindings.current.zipSHA256,
                    bound.artifacts.find(
                        (item) =>
                            item.name === 'Diagnostic-Hub-macos-' + bound.runtime.arch + '.zip',
                    ).sha256,
                );
            }
            boundedJSON(value, INSTALLER_STAGE_LIMIT);
            nativeActionResults = structuredClone(value);
        },
        start(id, at) {
            assert.ok(!terminal && active === null && next < stages.length);
            assert.equal(id, stages[next].id, 'Fixture stages must retain their fixed order.');
            const startedAt = canonicalTime(at);
            active = next;
            Object.assign(stages[active], { status: 'running', startedAt });
        },
        verify(at) {
            assert.ok(!terminal && active !== null);
            for (const fact of helpers.filter((item) => item.stage === stages[active].id))
                assertMacInstallerHelperReturn(fact);
            const returnedAt = canonicalTime(at);
            Object.assign(stages[active], { status: 'verified', returnedAt });
            next++;
            active = null;
        },
        helperReturn({
            command,
            exitCode,
            signal,
            error,
            stdout,
            stderr,
            expectedReturn = 'normal',
        }) {
            assert.ok(!terminal && active !== null && helpers.length < 64);
            commandVector(command);
            assert.ok(exitCode === null || Number.isSafeInteger(exitCode));
            assert.ok(signal === null || /^SIG[A-Z0-9]{1,16}$/.test(signal));
            assert.ok(['none', 'timeout', 'spawn-error'].includes(error));
            assert.equal(typeof stdout, 'string');
            assert.equal(typeof stderr, 'string');
            assert.ok(['normal', 'success', 'refusal', 'term-trap'].includes(expectedReturn));
            // Retain complete returned-stream identities once; never duplicate raw output.
            helpers.push({
                stage: stages[active].id,
                command: [...command],
                exitCode,
                signal,
                error,
                expectedReturn,
                stdout: {
                    bytes: Buffer.byteLength(stdout),
                    sha256: digest(stdout),
                },
                stderr: {
                    bytes: Buffer.byteLength(stderr),
                    sha256: digest(stderr),
                },
            });
            return structuredClone(helpers.at(-1));
        },
        fail(at) {
            assert.ok(!terminal);
            completedAt = canonicalTime(at);
            failure =
                active === null ? 'BETWEEN_STAGES_FAILURE' : 'STAGE_ASSERTION_OR_OPERATION_FAILURE';
            if (active !== null)
                Object.assign(stages[active], {
                    status: 'failed',
                    returnedAt: completedAt,
                    reason: failure,
                });
            terminal = true;
        },
        complete(at) {
            assert.ok(!terminal && active === null && next === stages.length);
            completedAt = canonicalTime(at);
            terminal = true;
        },
        completeNativeActions(at) {
            assert.ok(!terminal && active === null && next === 0 && nativeActionResults !== null);
            completedAt = canonicalTime(at);
            actionOnly = true;
            terminal = true;
        },
        serialize() {
            assert.ok(terminal, 'Publish only a terminal fixture observation.');
            const stageBytes = boundedJSON(
                {
                    schemaVersion: 1,
                    scope: actionOnly
                        ? 'macos-installer-actions'
                        : 'macos-installer-helper-fixture',
                    ...bound,
                    completedAt,
                    stages,
                    nativeCaseDefinitions: nativeCases.map((item) => ({
                        ...item,
                        executionStatus:
                            nativeActionResults?.executionScope === 'native' &&
                            nativeActionResults.cases.find((entry) => entry.id === item.id).actions
                                .length > 0
                                ? 'observed-actions'
                                : 'unexecuted',
                    })),
                    nativeActionResults,
                    helperReturns: helpers,
                },
                INSTALLER_STAGE_LIMIT,
            );
            const evidence = {
                path: 'stages.json',
                bytes: stageBytes.length,
                sha256: digest(stageBytes),
            };
            const receipt = {
                schemaVersion: 1,
                kind: 'native-installer-lifecycle',
                status: failure
                    ? 'failed'
                    : ['failed', 'unknown'].includes(nativeActionResults?.status)
                      ? nativeActionResults.status
                      : 'blocked',
                ...bound.context,
                lane,
                runtime: bound.runtime,
                artifacts: bound.artifacts,
                startedAt: bound.startedAt,
                completedAt,
                fixtureStatus: failure ? 'failed' : actionOnly ? 'unexecuted' : 'verified',
                reason:
                    failure ??
                    (['failed', 'unknown', 'unavailable'].includes(nativeActionResults?.status)
                        ? 'NATIVE_ACTIONS_' + nativeActionResults.status.toUpperCase()
                        : 'NATIVE_LIFECYCLE_NOT_QUALIFIED'),
                ...(compactCommandEvidence
                    ? { commandReference: { path: 'stages.json', pointer: '/command' } }
                    : { command: bound.command }),
                exitObserved: false,
                exitCode: null,
                signal: null,
                review: null,
                cases: nativeCases.map(({ id, fixtureStages }) => {
                    const nativeAction =
                        nativeActionResults?.executionScope === 'native'
                            ? nativeActionResults.cases.find((item) => item.id === id)
                            : null;
                    const observedStages = fixtureStages.map((stageId) =>
                        stages.find((item) => item.id === stageId),
                    );
                    return {
                        id,
                        status: observedStages.some((stage) => stage.status === 'failed')
                            ? 'failed'
                            : nativeAction &&
                                ['verified', 'failed', 'unknown', 'unavailable'].includes(
                                    nativeAction.status,
                                )
                              ? nativeAction.status
                              : 'unexecuted',
                        qualificationStatus: 'unverified',
                        reason: 'REQUIRED_NATIVE_CASE_NOT_QUALIFIED',
                        ...(compactCommandEvidence
                            ? { commandReference: { path: 'stages.json', pointer: '/command' } }
                            : { command: bound.command }),
                        exitCode: null,
                        signal: null,
                        exitObserved: false,
                        observedStages: observedStages
                            .filter((stage) => stage.status !== 'unexecuted')
                            .map((stage) => stage.id),
                        evidence: [evidence],
                    };
                }),
            };
            const receiptBytes = boundedJSON(receipt, INSTALLER_RECEIPT_LIMIT);
            return { stageBytes, receiptBytes };
        },
    });
}

// The caller owns the fresh directory. No overwrite, cleanup, retry or pass promotion.
// IO is mandatory/injected so contract tests can use memory-only effects.
export async function publishMacInstallerObservation(observation, directory, io) {
    assert.ok(
        io &&
            typeof io.open === 'function' &&
            typeof io.readFile === 'function' &&
            Array.isArray(io.handles),
    );
    const { stageBytes, receiptBytes } = observation.serialize(); // BOTH guards before first write.
    for (const [name, bytes] of [
        ['stages.json', stageBytes],
        ['observation.json', receiptBytes],
    ]) {
        const file = path.join(directory, name);
        const handle = await io.open(file, 'wx', 0o600);
        const custody = { file, handle, closed: false };
        io.handles.push(custody); // Retain returned identity before any further asynchronous operation.
        // Failed writes deliberately retain the handle/partial file for the external owner.
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        custody.closed = true;
        assert.deepEqual(await io.readFile(file), bytes, 'Installer publication readback differs.');
    }
    return {
        receiptPath: path.join(directory, 'observation.json'),
        receiptBytes: receiptBytes.length,
        receiptSHA256: digest(receiptBytes),
    };
}
