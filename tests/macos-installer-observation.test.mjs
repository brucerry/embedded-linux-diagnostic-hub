import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createMacInstallerObservation,
    publishMacInstallerObservation,
    MAC_FIXTURE_STAGES,
    INSTALLER_RECEIPT_LIMIT,
    INSTALLER_STAGE_LIMIT,
    macInstallerLifecycleDefinitions,
    assertMacInstallerHelperReturn,
    allocateMacInstallerFixture,
    macInstallerPublishRoot,
    macInstallerAllocationDiagnostic,
} from '../scripts/lib/macos-installer-observation.mjs';
import {
    digest,
    laneFiles,
    installerCases,
    validateInstallerReceipt,
} from '../scripts/lib/staged-artifact-gate.mjs';

// Synthetic values and memory-only IO: never import or invoke the installer smoke entry point.
const at = '2026-10-26T10:00:00.000Z';
function inputs(arch = 'arm64') {
    return {
        context: {
            version: '0.6.0',
            sourceCommit: 'a'.repeat(40),
            sourceTree: 'b'.repeat(40),
        },
        runtime: {
            platform: 'darwin',
            arch,
            node: '24.22.0',
            osRelease: 'synthetic',
            executable: '/synthetic/node',
            executableSHA256: 'c'.repeat(64),
        },
        artifacts: laneFiles('0.6.0', 'darwin-' + arch).map((name) => ({
            name,
            bytes: 7,
            sha256: digest('fixture'),
        })),
        command: [
            '/synthetic/node',
            '/synthetic/tests/macos-installer-smoke.mjs',
        ],
        startedAt: at,
    };
}
function completed(change = {}) {
    const observation = createMacInstallerObservation({
        ...inputs(),
        ...change,
    });
    for (const { id } of MAC_FIXTURE_STAGES) {
        observation.start(id, at);
        observation.verify(at);
    }
    observation.complete(at);
    return observation;
}
function memoryIO(fail = '') {
    const files = new Map();
    const events = [];
    const handles = [];
    return {
        files,
        events,
        handles,
        async open(file, flag, mode) {
            events.push(['open', file, flag, mode]);
            assert.equal(flag, 'wx');
            assert.equal(mode, 0o600);
            assert.ok(!files.has(file));
            files.set(file, Buffer.alloc(0));
            return {
                async writeFile(bytes) {
                    events.push(['write', file]);
                    if (
                        fail === 'write' ||
                        (fail === 'receipt-write' &&
                            file.endsWith('observation.json'))
                    ) {
                        files.set(file, bytes.subarray(0, 7));
                        throw Error('inert write refusal');
                    }
                    files.set(file, Buffer.from(bytes));
                },
                async sync() {
                    events.push(['sync', file]);
                },
                async close() {
                    events.push(['close', file]);
                },
            };
        },
        async readFile(file) {
            events.push(['read', file]);
            return fail === 'readback'
                ? Buffer.from('mismatch')
                : Buffer.from(files.get(file));
        },
    };
}

test('complete fixture assertions produce nine unqualified cases and no observed process exit', () => {
    const { receiptBytes, stageBytes } = completed().serialize();
    const receipt = JSON.parse(receiptBytes);
    const stages = JSON.parse(stageBytes);
    assert.equal(receipt.kind, 'native-installer-lifecycle');
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.fixtureStatus, 'verified');
    assert.equal(receipt.review, null);
    assert.equal(receipt.exitObserved, false);
    assert.equal(receipt.exitCode, null);
    assert.equal(receipt.signal, null);
    assert.deepEqual(
        receipt.cases.map((item) => item.id),
        installerCases('darwin-arm64'),
    );
    assert.ok(
        receipt.cases.every(
            (item) =>
                item.status === 'unexecuted' &&
                item.exitCode === null &&
                !item.exitObserved,
        ),
    );
    assert.ok(stages.stages.every((item) => item.status === 'verified'));
    assert.ok(
        receiptBytes.length <= INSTALLER_RECEIPT_LIMIT &&
            stageBytes.length <= INSTALLER_STAGE_LIMIT,
    );
});

test('unchanged release consumer rejects a successful fixture observation', () => {
    const receipt = JSON.parse(completed().serialize().receiptBytes);
    assert.throws(() =>
        validateInstallerReceipt(receipt, {
            ...inputs().context,
            lane: receipt.lane,
            artifacts: receipt.artifacts,
        }),
    );
    // Relabelling only the outer status/review cannot promote the unrun cases.
    receipt.status = 'passed';
    receipt.review = { reviewer: 'synthetic', reviewedAt: at };
    assert.throws(() =>
        validateInstallerReceipt(receipt, {
            ...inputs().context,
            lane: receipt.lane,
            artifacts: receipt.artifacts,
        }),
    );
});

test('consumer compatibility control requires nine normal-return evidenced native cases', () => {
    const receipt = JSON.parse(completed().serialize().receiptBytes);
    Object.assign(receipt, {
        status: 'passed',
        review: { reviewer: 'synthetic-control-only', reviewedAt: at },
    });
    for (const item of receipt.cases)
        Object.assign(item, {
            status: 'passed',
            exitCode: 0,
            signal: null,
            exitObserved: true,
        });
    const expected = {
        ...inputs().context,
        lane: receipt.lane,
        artifacts: receipt.artifacts,
    };
    assert.equal(validateInstallerReceipt(receipt, expected), receipt);
    for (const status of ['unexecuted', 'verified', 'failed', 'unsupported']) {
        const altered = structuredClone(receipt);
        altered.cases[0].status = status;
        assert.throws(() => validateInstallerReceipt(altered, expected));
    }
});

test('stage failure retains verified predecessors, marks related failure and leaves later stages unexecuted', () => {
    const observation = createMacInstallerObservation(inputs());
    observation.start('package-shape', at);
    observation.verify(at);
    observation.start('cancelled-review', at);
    observation.fail(at);
    const stages = JSON.parse(observation.serialize().stageBytes).stages;
    const receipt = JSON.parse(observation.serialize().receiptBytes);
    assert.equal(stages[0].status, 'verified');
    assert.equal(stages[1].status, 'failed');
    assert.ok(stages.slice(2).every((item) => item.status === 'unexecuted'));
    assert.equal(receipt.fixtureStatus, 'failed');
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.cases[0].status, 'failed');
    assert.ok(
        receipt.cases.slice(1).every((item) => item.status === 'unexecuted'),
    );
});

test('pre-stage failure is terminal and never claims a failed native operation', () => {
    const observation = createMacInstallerObservation(inputs());
    observation.fail(at);
    const receipt = JSON.parse(observation.serialize().receiptBytes);
    assert.equal(receipt.reason, 'BETWEEN_STAGES_FAILURE');
    assert.ok(receipt.cases.every((item) => item.status === 'unexecuted'));
    assert.throws(() => observation.start('package-shape', at));
});

test('fixed stage order, one terminal transition and no arbitrary reset', () => {
    const observation = createMacInstallerObservation(inputs());
    assert.throws(() => observation.start('initial-install', at));
    assert.throws(() => observation.verify(at));
    assert.throws(() => observation.complete(at));
    observation.start('package-shape', at);
    assert.throws(() => observation.start('cancelled-review', at));
    observation.verify(at);
    assert.throws(() => observation.start('package-shape', at));
    observation.fail(at);
    assert.throws(() => observation.fail(at));
    assert.throws(() => observation.complete(at));
});

test('nonterminal observations cannot be published', async () => {
    const observation = createMacInstallerObservation(inputs());
    const io = memoryIO();
    await assert.rejects(
        publishMacInstallerObservation(observation, '/synthetic/root', io),
    );
    assert.equal(io.events.length, 0);
});

test('helper returned facts preserve actual exit and stream hashes without duplicating raw output', () => {
    const observation = createMacInstallerObservation(inputs());
    observation.start('package-shape', at);
    observation.helperReturn({
        command: ['/synthetic/bash', 'fixture'],
        exitCode: 22,
        signal: null,
        error: 'none',
        stdout: 'OUTPUT_CANARY',
        stderr: 'ERROR_CANARY',
    });
    observation.fail(at);
    const { stageBytes } = observation.serialize();
    const helper = JSON.parse(stageBytes).helperReturns[0];
    assert.equal(helper.exitCode, 22);
    assert.equal(helper.stdout.sha256, digest('OUTPUT_CANARY'));
    assert.equal(helper.stderr.bytes, Buffer.byteLength('ERROR_CANARY'));
    assert.ok(
        !stageBytes.includes(Buffer.from('OUTPUT_CANARY')) &&
            !stageBytes.includes(Buffer.from('ERROR_CANARY')),
    );
});

test('timeout or spawn failure stays actual failure data, never a normal exit', () => {
    for (const error of ['timeout', 'spawn-error']) {
        const observation = createMacInstallerObservation(inputs());
        observation.start('package-shape', at);
        observation.helperReturn({
            command: ['synthetic'],
            exitCode: null,
            signal: error === 'timeout' ? 'SIGTERM' : null,
            error,
            stdout: '',
            stderr: '',
        });
        observation.fail(at);
        assert.equal(
            JSON.parse(observation.serialize().stageBytes).helperReturns[0]
                .exitCode,
            null,
        );
    }
});

test('identity admission rejects wrong platform/runtime, foreign or duplicate artifacts and context injection', () => {
    for (const mutate of [
        (x) => {
            x.runtime.platform = 'linux';
        },
        (x) => {
            x.runtime.node = '22.0.0';
        },
        (x) => {
            x.context.sourceCommit = null;
        },
        (x) => {
            x.context.status = 'passed';
        },
        (x) => {
            x.artifacts.pop();
        },
        (x) => {
            x.artifacts[0] = x.artifacts[1];
        },
        (x) => {
            x.artifacts[0].sha256 = 'bad';
        },
        (x) => {
            x.runtime.executable = 'relative';
        },
    ]) {
        const data = inputs();
        mutate(data);
        assert.throws(() => createMacInstallerObservation(data));
    }
    const intel = createMacInstallerObservation(inputs('x64'));
    intel.fail(at);
    assert.equal(JSON.parse(intel.serialize().receiptBytes).lane, 'darwin-x64');
});

test('closed input copies and repeated serialization cannot mutate retained facts', () => {
    const data = inputs();
    const observation = createMacInstallerObservation(data);
    data.context.sourceCommit = 'd'.repeat(40);
    data.artifacts[0].bytes = 42;
    observation.fail(at);
    const first = observation.serialize();
    first.receiptBytes.fill(0);
    const receipt = JSON.parse(observation.serialize().receiptBytes);
    assert.equal(receipt.sourceCommit, 'a'.repeat(40));
    assert.equal(receipt.artifacts[0].bytes, 7);
});

test('complete UTF-8 receipt guard runs before any allocation', async () => {
    const io = memoryIO();
    const observation = completed({ command: ['synthetic', 'é'.repeat(1800)] });
    await assert.rejects(
        publishMacInstallerObservation(observation, '/synthetic/root', io),
        /UTF-8 bound/,
    );
    assert.equal(io.events.length, 0);
    assert.equal(io.files.size, 0);
});

test('stage byte guard and helper-count limit refuse without truncation', async () => {
    const observation = createMacInstallerObservation(inputs());
    observation.start('package-shape', at);
    for (let i = 0; i < 64; i++)
        observation.helperReturn({
            command: ['x'.repeat(2048)],
            exitCode: 0,
            signal: null,
            error: 'none',
            stdout: '',
            stderr: '',
        });
    assert.throws(() =>
        observation.helperReturn({
            command: ['x'],
            exitCode: 0,
            signal: null,
            error: 'none',
            stdout: '',
            stderr: '',
        }),
    );
    observation.fail(at);
    const io = memoryIO();
    await assert.rejects(
        publishMacInstallerObservation(observation, '/synthetic/root', io),
        /UTF-8 bound/,
    );
    assert.equal(io.events.length, 0);
});

test('exclusive publication writes syncs closes and exactly verifies evidence before receipt', async () => {
    const io = memoryIO();
    const result = await publishMacInstallerObservation(
        completed(),
        '/synthetic/root',
        io,
    );
    assert.deepEqual(
        io.events.map(([action]) => action),
        [
            'open',
            'write',
            'sync',
            'close',
            'read',
            'open',
            'write',
            'sync',
            'close',
            'read',
        ],
    );
    assert.ok(io.handles.every((entry) => entry.closed));
    const receiptBytes = io.files.get(result.receiptPath);
    const receipt = JSON.parse(receiptBytes);
    assert.equal(result.receiptSHA256, digest(receiptBytes));
    assert.equal(result.receiptBytes, receiptBytes.length);
    assert.deepEqual(receipt.cases[0].evidence[0], {
        path: 'stages.json',
        bytes: io.files.get('/synthetic/root/stages.json').length,
        sha256: digest(io.files.get('/synthetic/root/stages.json')),
    });
});

test('write refusal preserves partial evidence and retained handle, with no receipt or retry', async () => {
    const io = memoryIO('write');
    await assert.rejects(
        publishMacInstallerObservation(completed(), '/synthetic/root', io),
    );
    assert.equal(io.files.get('/synthetic/root/stages.json').length, 7);
    assert.equal(io.files.size, 1);
    assert.equal(io.handles.length, 1);
    assert.equal(io.handles[0].closed, false);
    assert.deepEqual(
        io.events.map(([action]) => action),
        ['open', 'write'],
    );
});

test('mismatched evidence readback prevents receipt publication', async () => {
    const io = memoryIO('readback');
    await assert.rejects(
        publishMacInstallerObservation(completed(), '/synthetic/root', io),
        /readback differs/,
    );
    assert.equal(io.files.size, 1);
    assert.ok(io.handles[0].closed);
});

test('receipt write failure preserves verified stage bytes and partial receipt', async () => {
    const io = memoryIO('receipt-write');
    await assert.rejects(
        publishMacInstallerObservation(completed(), '/synthetic/root', io),
    );
    assert.ok(io.files.get('/synthetic/root/stages.json').length > 7);
    assert.equal(io.files.get('/synthetic/root/observation.json').length, 7);
    assert.equal(io.handles[0].closed, true);
    assert.equal(io.handles[1].closed, false);
});

test('native lifecycle definitions exactly match both Mac consumer lanes without adding requirements', () => {
    for (const lane of ['darwin-arm64', 'darwin-x64']) {
        const definitions = macInstallerLifecycleDefinitions(lane);
        assert.deepEqual(
            definitions.map((item) => item.id),
            installerCases(lane),
        );
        assert.ok(Object.isFrozen(definitions));
        for (const item of definitions) {
            assert.ok(
                Object.isFrozen(item) && Object.isFrozen(item.fixtureStages),
            );
            assert.equal(item.executionStatus, 'unexecuted');
            assert.equal(item.qualificationStatus, 'unverified');
            assert.ok(
                item.requirement.length > 0 &&
                    item.missingNativeProof.length > 0,
            );
            for (const id of item.fixtureStages)
                assert.ok(MAC_FIXTURE_STAGES.some((stage) => stage.id === id));
        }
    }
    for (const lane of ['win32-x64', 'linux-x64', 'darwin-unknown'])
        assert.throws(() => macInstallerLifecycleDefinitions(lane));
});

test('distinct-version, integration and removal cases cannot borrow unrelated fixture assertions', () => {
    const definitions = macInstallerLifecycleDefinitions('darwin-arm64');
    const update = definitions.find((item) =>
        item.id.endsWith(':update-distinct-version'),
    );
    assert.equal(update.requiresDistinctVersion, true);
    assert.match(update.requirement, /manual native bundle replacement/);
    assert.ok(
        definitions
            .filter((item) => item !== update)
            .every((item) => !item.requiresDistinctVersion),
    );
    for (const name of [
        'update-distinct-version',
        'owned-integrations',
        'remove',
    ])
        assert.deepEqual(
            definitions.find((item) => item.id === 'macos-bundle:' + name)
                .fixtureStages,
            [],
        );
    assert.match(
        definitions.find((item) =>
            item.id.endsWith(':profile-report-preservation'),
        ).missingNativeProof,
        /sibling marker is insufficient/,
    );
});

test('verified helper stages publish all nine still-unverified native definitions in hash-bound evidence', () => {
    const { receiptBytes, stageBytes } = completed().serialize();
    const receipt = JSON.parse(receiptBytes),
        stages = JSON.parse(stageBytes);
    assert.deepEqual(
        stages.nativeCaseDefinitions,
        macInstallerLifecycleDefinitions(receipt.lane),
    );
    assert.ok(
        stages.nativeCaseDefinitions.every(
            (item) =>
                item.executionStatus === 'unexecuted' &&
                item.qualificationStatus === 'unverified',
        ),
    );
    assert.ok(receipt.cases.every((item) => item.status === 'unexecuted'));
    for (const item of receipt.cases)
        assert.equal(item.evidence[0].sha256, digest(stageBytes));
});

// These exercise consumer syntax with synthetic facts only. They do not establish native
// semantics, exit/EOF, evidence-file provenance or independent review for any real case.
for (const definition of macInstallerLifecycleDefinitions('darwin-arm64')) {
    test(
        'consumer contract refuses incomplete mocked native case: ' +
            definition.id,
        () => {
            const fixture = JSON.parse(completed().serialize().receiptBytes);
            Object.assign(fixture, {
                status: 'passed',
                review: { reviewer: 'synthetic-control-only', reviewedAt: at },
            });
            for (const item of fixture.cases)
                Object.assign(item, {
                    status: 'passed',
                    exitCode: 0,
                    signal: null,
                });
            const expected = {
                ...inputs().context,
                lane: fixture.lane,
                artifacts: fixture.artifacts,
            };
            assert.equal(validateInstallerReceipt(fixture, expected), fixture);
            for (const change of [
                { status: 'unexecuted' },
                { status: 'failed' },
                { status: 'verified' },
                { exitCode: null },
                { exitCode: 1 },
                { signal: 'SIGTERM' },
                { command: [] },
                { evidence: [] },
            ]) {
                const altered = structuredClone(fixture);
                Object.assign(
                    altered.cases.find((item) => item.id === definition.id),
                    change,
                );
                assert.throws(() =>
                    validateInstallerReceipt(altered, expected),
                );
            }
            const missing = structuredClone(fixture);
            missing.cases = missing.cases.filter(
                (item) => item.id !== definition.id,
            );
            assert.throws(() => validateInstallerReceipt(missing, expected));
            const duplicate = structuredClone(fixture);
            duplicate.cases.push(
                structuredClone(
                    duplicate.cases.find((item) => item.id === definition.id),
                ),
            );
            assert.throws(() => validateInstallerReceipt(duplicate, expected));
        },
    );
}

function atStage(name) {
    const observation = createMacInstallerObservation(inputs());
    for (const stage of MAC_FIXTURE_STAGES) {
        observation.start(stage.id, at);
        if (stage.id === name) return observation;
        observation.verify(at);
    }
    throw Error('Unknown synthetic stage');
}
function returnedFact(change = {}) {
    return {
        command: ['inert-helper-no-process'],
        exitCode: 1,
        signal: null,
        error: 'none',
        stdout: '',
        stderr: '',
        expectedReturn: 'refusal',
        ...change,
    };
}
test('R1 abnormal helper facts are retained before refusing stage verification', () => {
    for (const change of [
        { exitCode: null, signal: 'SIGTERM', error: 'timeout' },
        { exitCode: null, error: 'spawn-error' },
        { exitCode: null },
        { exitCode: 1, signal: 'SIGTERM' },
        { exitCode: -1 },
        { exitCode: 256 },
    ]) {
        const observation = atStage('input-refusals');
        const fact = observation.helperReturn(returnedFact(change));
        assert.throws(() => assertMacInstallerHelperReturn(fact));
        assert.throws(() => observation.verify(at));
        assert.throws(() => observation.complete(at));
        observation.fail(at);
        const { stageBytes, receiptBytes } = observation.serialize();
        const value = JSON.parse(stageBytes),
            receipt = JSON.parse(receiptBytes);
        assert.equal(receipt.fixtureStatus, 'failed');
        const failed = value.stages.findIndex(
            (stage) => stage.id === 'input-refusals',
        );
        assert.ok(
            value.stages
                .slice(0, failed)
                .every((stage) => stage.status === 'verified'),
        );
        assert.equal(value.stages[failed].status, 'failed');
        assert.ok(
            value.stages
                .slice(failed + 1)
                .every((stage) => stage.status === 'unexecuted'),
        );
        assert.deepEqual(value.helperReturns[0], fact);
    }
});
test('R1 genuine normal success and nonzero refusal have distinct expected semantics', () => {
    assert.doesNotThrow(() =>
        assertMacInstallerHelperReturn({
            ...returnedFact(),
            expectedReturn: 'success',
            exitCode: 0,
        }),
    );
    assert.doesNotThrow(() => assertMacInstallerHelperReturn(returnedFact()));
    assert.throws(() =>
        assertMacInstallerHelperReturn(returnedFact({ exitCode: 0 })),
    );
    assert.throws(() =>
        assertMacInstallerHelperReturn(
            returnedFact({ expectedReturn: 'success' }),
        ),
    );
    const observation = atStage('input-refusals');
    observation.helperReturn(returnedFact());
    observation.verify(at);
    observation.fail(at);
    assert.equal(
        JSON.parse(observation.serialize().stageBytes).stages.find(
            (stage) => stage.id === 'input-refusals',
        ).status,
        'verified',
    );
});
test('R1 only the deliberate interruption stage accepts the normal TERM-trap exit143', () => {
    const observation = atStage('interrupted-replacement');
    const fact = observation.helperReturn(
        returnedFact({ exitCode: 143, expectedReturn: 'term-trap' }),
    );
    assert.doesNotThrow(() => assertMacInstallerHelperReturn(fact));
    observation.verify(at);
    observation.fail(at);
    for (const change of [
        { exitCode: null, signal: 'SIGTERM' },
        { exitCode: 1 },
        { error: 'timeout' },
    ])
        assert.throws(() =>
            assertMacInstallerHelperReturn({ ...fact, ...change }),
        );
    const wrongStage = atStage('input-refusals');
    wrongStage.helperReturn(
        returnedFact({ exitCode: 143, expectedReturn: 'term-trap' }),
    );
    assert.throws(() => wrongStage.verify(at));
});
function allocationState() {
    return {
        allocation: 'unexecuted',
        allocatedPath: null,
        canonicalReturnedPath: null,
        canonicalRoot: null,
        canonicalization: 'unexecuted',
        failure: null,
    };
}
test('R2 returned allocation survives canonicalization failure without publication or cleanup', async () => {
    const state = allocationState(),
        calls = [];
    const io = {
        async mkdtemp(prefix) {
            calls.push(['allocate', prefix]);
            return '/mock/allocated-fixture';
        },
        async realpath(value) {
            assert.equal(state.allocatedPath, value);
            calls.push(['canonicalize', value]);
            throw Error('PRIVATE_ROOT_ERROR_CANARY');
        },
    };
    await assert.rejects(
        allocateMacInstallerFixture('/mock/prefix-', state, io),
        /FIXTURE_CANONICALIZATION_FAILED/,
    );
    assert.equal(state.allocatedPath, '/mock/allocated-fixture');
    assert.equal(state.canonicalRoot, null);
    assert.equal(macInstallerPublishRoot(state), null);
    assert.equal(state.canonicalization, 'failed');
    assert.deepEqual(calls, [
        ['allocate', '/mock/prefix-'],
        ['canonicalize', '/mock/allocated-fixture'],
    ]);
    const bytes = macInstallerAllocationDiagnostic(state, state.failure);
    const diagnostic = JSON.parse(bytes);
    assert.equal(diagnostic.allocatedPath, '/mock/allocated-fixture');
    assert.equal(diagnostic.publicationAttempted, false);
    assert.equal(diagnostic.canonicalRoot, null);
    assert.ok(!bytes.includes(Buffer.from('PRIVATE_ROOT_ERROR_CANARY')));
    await assert.rejects(
        allocateMacInstallerFixture('/mock/again-', state, io),
    );
    assert.equal(calls.length, 2);
});
test('R2 validated canonical root preserves original allocation provenance and permits its own publication path', async () => {
    const state = allocationState();
    const value = await allocateMacInstallerFixture('/mock/prefix-', state, {
        async mkdtemp() {
            return '/mock/alias/fresh';
        },
        async realpath(allocated) {
            assert.equal(state.allocatedPath, allocated);
            return '/mock/canonical/fresh';
        },
    });
    assert.equal(value, '/mock/canonical/fresh');
    assert.equal(state.allocatedPath, '/mock/alias/fresh');
    assert.equal(macInstallerPublishRoot(state), value);
    const diagnostic = JSON.parse(
        macInstallerAllocationDiagnostic(
            state,
            'QUALIFICATION_PUBLICATION_FAILED',
            true,
        ),
    );
    assert.equal(diagnostic.canonicalRoot, value);
    assert.equal(diagnostic.publicationAttempted, true);
});
test('R2 unknown allocation return does not canonicalize scan retry or claim no partial allocation', async () => {
    const state = allocationState();
    let canonicalCalls = 0;
    await assert.rejects(
        allocateMacInstallerFixture('/mock/prefix-', state, {
            async mkdtemp() {
                throw Error('private allocator detail');
            },
            async realpath() {
                canonicalCalls++;
            },
        }),
        /FIXTURE_ALLOCATION_RETURN_UNKNOWN/,
    );
    assert.equal(canonicalCalls, 0);
    assert.equal(macInstallerPublishRoot(state), null);
    const diagnostic = JSON.parse(
        macInstallerAllocationDiagnostic(state, state.failure),
    );
    assert.equal(diagnostic.allocatedPath, null);
    assert.equal(diagnostic.allocatedPathUnavailable, true);
});
test('R2 escaped oversized provenance remains retained in state and explicitly unavailable in bounded output', () => {
    const state = allocationState();
    state.allocation = 'returned';
    state.canonicalization = 'failed';
    state.allocatedPath = '/mock/' + '\\"'.repeat(6000);
    const original = state.allocatedPath;
    const bytes = macInstallerAllocationDiagnostic(
        state,
        'FIXTURE_CANONICALIZATION_FAILED',
    );
    assert.ok(bytes.length <= INSTALLER_RECEIPT_LIMIT);
    assert.equal(JSON.parse(bytes).allocatedPath, null);
    assert.equal(JSON.parse(bytes).allocatedPathUnavailable, true);
    assert.equal(state.allocatedPath, original);
});
