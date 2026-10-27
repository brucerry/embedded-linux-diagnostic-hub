import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
    runMacInstallerActions,
    validateMacInstallerActionResult,
} from '../scripts/lib/macos-installer-actions.mjs';
import { createMacInstallerObservation } from '../scripts/lib/macos-installer-observation.mjs';
import {
    digest,
    installerCases,
    laneFiles,
    validateInstallerReceipt,
} from '../scripts/lib/staged-artifact-gate.mjs';

// Every effect below is an in-memory substitute. No native adapter/entry is imported.
function inputs() {
    return {
        lane: 'darwin-arm64',
        fixtureParent: '/mock/mac-fixtures',
        bundleIdentifier: 'dev.diagnostichub.desktop',
        current: {
            version: '0.6.0',
            sourceCommit: 'a'.repeat(40),
            zipPath: '/mock/current.zip',
            zipSHA256: digest('fixture'),
            asarSHA256: 'c'.repeat(64),
        },
        previous: {
            version: '0.5.2',
            sourceCommit: 'b'.repeat(40),
            zipPath: '/mock/previous.zip',
            zipSHA256: 'd'.repeat(64),
            asarSHA256: 'e'.repeat(64),
        },
    };
}
function memoryEffects(options = {}, selected = inputs()) {
    const states = new Map(),
        log = [],
        backups = new Map();
    const returned = {
        exitObserved: true,
        exitCode: 0,
        signal: null,
        error: 'none',
        command: ['mock-helper-no-process'],
    };
    const empty = () => ({
        exists: false,
        version: null,
        asarSHA256: null,
        profileFiles: [],
        reportFiles: [],
    });
    const label = (fixture) => fixture.id.slice('macos-bundle:'.length);
    const effects = { kind: 'mock' };
    function record(method, fixture, detail = null) {
        log.push({
            method,
            id: typeof fixture === 'string' ? fixture : fixture.id,
            detail,
        });
        if (options.rejectMethod === method)
            throw Error('PRIVATE_ERROR_CANARY');
    }
    effects.prepare = async (id) => {
        record('prepare', id);
        const root = path.posix.join(
            selected.fixtureParent,
            id.slice('macos-bundle:'.length),
        );
        const value = {
            id,
            root,
            target: path.posix.join(root, 'Applications', 'Diagnostic Hub.app'),
            fresh: true,
        };
        if (options.wrongTarget)
            value.target = '/mock/unrelated/Diagnostic Hub.app';
        if (options.notFresh) value.fresh = false;
        states.set(id, empty());
        options.onPrepare?.();
        return value;
    };
    effects.snapshot = async (fixture) => {
        record('snapshot', fixture);
        return structuredClone(states.get(fixture.id));
    };
    effects.install = async (fixture, input, config) => {
        record('install', fixture, { version: input.version, ...config });
        if (options.failCase === label(fixture))
            return { ...returned, exitCode: 1 };
        if (config.expectBusy) {
            if (options.busyMutation)
                states.get(fixture.id).asarSHA256 = 'f'.repeat(64);
            return {
                ...returned,
                exitCode: 1,
                busyRefusalVerified: true,
                ...options.abnormalBusy,
            };
        }
        if (config.fault) {
            if (options.failedRollback)
                states.get(fixture.id).asarSHA256 = 'f'.repeat(64);
            return { ...returned, exitCode: 70, faultObserved: config.fault };
        }
        Object.assign(states.get(fixture.id), {
            exists: true,
            version: input.version,
            asarSHA256: input.asarSHA256,
        });
        if (
            options.repairCorruption &&
            label(fixture) === 'repair' &&
            states.get(fixture.id).profileFiles.length
        )
            states.get(fixture.id).profileFiles[0].sha256 = 'f'.repeat(64);
        return { ...returned };
    };
    effects.launchOwned = async (fixture, config) => {
        record('launchOwned', fixture, config);
        return {
            id: 'mock-owner:' + fixture.id,
            ready: !options.notReady,
            offlineLaunchVerified: config.offline && !options.offlineUnverified,
        };
    };
    effects.quitOwned = async (fixture, owner) => {
        record('quitOwned', fixture);
        return {
            ownerId: owner.id,
            exitObserved: true,
            exitCode: options.abnormalExit ? 1 : 0,
            signal: null,
            error: 'none',
            closeObserved: true,
            stdoutEOF: true,
            stderrEOF: !options.missingEOF,
        };
    };
    effects.seedApplicationData = async (fixture) => {
        record('seedApplicationData', fixture);
        Object.assign(states.get(fixture.id), {
            profileFiles: [
                {
                    path: 'profile/settings.json',
                    bytes: 7,
                    sha256: digest('profile'),
                },
            ],
            reportFiles: [
                {
                    path: 'reports/report.json',
                    bytes: 6,
                    sha256: digest('report'),
                },
            ],
        });
        return { origin: 'application' }; // Simulated API output, not genuine app creation evidence.
    };
    effects.readApplicationData = async (fixture) => {
        record('readApplicationData', fixture);
        const state = structuredClone(states.get(fixture.id));
        if (options.appReadMismatch)
            state.reportFiles[0].sha256 = 'f'.repeat(64);
        return {
            origin: 'application',
            profileFiles: state.profileFiles,
            reportFiles: state.reportFiles,
        };
    };
    effects.inspectOwnedIntegrations = async (fixture) => {
        record('inspectOwnedIntegrations', fixture);
        return {
            scope: 'owned-application-bundle',
            target: fixture.target,
            bundleIdentifier: selected.bundleIdentifier,
            verified: true,
        };
    };
    effects.backupOwnedInstallation = async (fixture) => {
        record('backupOwnedInstallation', fixture);
        const value = {
            target: fixture.target,
            verified: !options.badBackup,
            completeBundle: true,
            snapshotSHA256: digest(JSON.stringify(states.get(fixture.id))),
            manifestSHA256: digest('complete mocked bundle manifest'),
        };
        backups.set(fixture.id, value);
        return value;
    };
    effects.removeOwnedInstallation = async (fixture, backup) => {
        record('removeOwnedInstallation', fixture);
        assert.equal(backups.get(fixture.id), backup);
        assert.equal(backup.verified, true);
        Object.assign(states.get(fixture.id), {
            exists: false,
            version: null,
            asarSHA256: null,
        });
        return {
            target: fixture.target,
            returned: true,
            verifiedBackupRetained: !options.backupLost,
            manifestSHA256: backup.manifestSHA256,
        };
    };
    return { effects, states, log };
}
async function run(options = {}, data = inputs()) {
    const mock = memoryEffects(options, data);
    const outcome = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    validateMacInstallerActionResult(outcome.result);
    return { ...mock, ...outcome };
}

test('all nine actual action bodies run in fixed order with memory effects and remain unqualified', async () => {
    const { result, custody, log } = await run();
    assert.equal(result.status, 'verified');
    assert.equal(result.executionScope, 'mock');
    assert.equal(result.qualificationStatus, 'unverified');
    assert.deepEqual(
        result.cases.map((item) => item.id),
        installerCases('darwin-arm64'),
    );
    assert.ok(
        result.cases.every(
            (item) => item.status === 'verified' && item.actions.length > 0,
        ),
    );
    assert.equal(custody.fixtures.length, 9);
    assert.ok(custody.owners.every((item) => item.closed));
    assert.equal(custody.pending, null);
    assert.deepEqual(
        log.filter((item) => item.method === 'prepare').map((item) => item.id),
        result.cases.map((item) => item.id),
    );
    assert.ok(
        result.cases.every((item) =>
            item.actions.every((action) => action.returned && action.facts),
        ),
    );
});

test('distinct replacement installs an identified previous version before current and records both', async () => {
    const { result, log } = await run();
    const id = 'macos-bundle:update-distinct-version';
    assert.deepEqual(
        log
            .filter((item) => item.id === id && item.method === 'install')
            .map((item) => item.detail.version),
        ['0.5.2', '0.6.0'],
    );
    assert.equal(
        result.cases.find((item) => item.id === id).priorVersion,
        '0.5.2',
    );
    assert.equal(
        result.bindings.previous.zipSHA256,
        inputs().previous.zipSHA256,
    );
});

test('missing or same-version prior payload refuses before every effect', async () => {
    for (const mutate of [
        (x) => {
            x.previous = null;
        },
        (x) => {
            x.previous.version = x.current.version;
        },
        (x) => {
            x.previous.zipSHA256 = x.current.zipSHA256;
        },
    ]) {
        const data = inputs();
        mutate(data);
        const mock = memoryEffects({}, data);
        const { result } = await runMacInstallerActions({
            inputs: data,
            effects: mock.effects,
        });
        assert.equal(result.status, 'unavailable');
        assert.equal(result.reason, 'DISTINCT_PRIOR_PACKAGE_UNAVAILABLE');
        assert.equal(mock.log.length, 0);
        validateMacInstallerActionResult(result);
    }
});

test('missing native adapter or current binding refuses without native fallback', async () => {
    const mock = memoryEffects();
    delete mock.effects.quitOwned;
    const unavailable = await runMacInstallerActions({
        inputs: inputs(),
        effects: mock.effects,
    });
    assert.equal(
        unavailable.result.reason,
        'NATIVE_EFFECT_ADAPTER_UNAVAILABLE',
    );
    assert.equal(mock.log.length, 0);
    const data = inputs();
    data.current.sourceCommit = null;
    const badInput = await runMacInstallerActions({
        inputs: data,
        effects: memoryEffects().effects,
    });
    assert.equal(badInput.result.reason, 'CURRENT_PACKAGE_BINDING_UNAVAILABLE');
});

test('removal follows verified full backup and preserves profile/report and backup facts', async () => {
    const { result, log, states } = await run();
    const id = 'macos-bundle:remove';
    const methods = log
        .filter((item) => item.id === id)
        .map((item) => item.method);
    assert.ok(
        methods.indexOf('backupOwnedInstallation') <
            methods.indexOf('removeOwnedInstallation'),
    );
    const state = states.get(id);
    assert.equal(state.exists, false);
    assert.equal(state.profileFiles.length, 1);
    assert.equal(state.reportFiles.length, 1);
    const actions = result.cases.find((item) => item.id === id).actions;
    assert.equal(
        actions.find((item) => item.method === 'backupOwnedInstallation').facts
            .manifestSHA256,
        actions.find((item) => item.method === 'removeOwnedInstallation').facts
            .manifestSHA256,
    );
});

test('invalid backup prevents removal and leaves fixture installed', async () => {
    const { result, log, states } = await run({ badBackup: true });
    assert.equal(result.status, 'failed');
    assert.equal(states.get('macos-bundle:remove').exists, true);
    assert.ok(!log.some((item) => item.method === 'removeOwnedInstallation'));
});

test('wrong target or nonfresh fixture stops before snapshot/install and retains returned identity', async () => {
    for (const options of [{ wrongTarget: true }, { notFresh: true }]) {
        const { result, custody, log } = await run(options);
        assert.equal(result.status, 'failed');
        assert.equal(custody.fixtures.length, 1);
        assert.deepEqual(
            log.map((item) => item.method),
            ['prepare'],
        );
    }
});

test('offline launch needs verified offline readiness and normal observed exit plus both EOFs', async () => {
    for (const options of [
        { offlineUnverified: true },
        { notReady: true },
        { abnormalExit: true },
        { missingEOF: true },
    ]) {
        const { result, custody, log } = await run(options);
        assert.equal(result.status, 'failed');
        assert.equal(custody.owners.length, 1);
        assert.equal(custody.owners[0].closed, false);
        assert.ok(!log.some((item) => item.id === 'macos-bundle:busy-refusal'));
    }
});

test('uncertain effect keeps pending operation and owner custody without follow-up or error reflection', async () => {
    const { result, custody, log } = await run({ rejectMethod: 'quitOwned' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'UNKNOWN_EFFECT_RETURN');
    assert.equal(custody.pending.method, 'quitOwned');
    assert.equal(custody.pending.phase, 'submitted');
    assert.equal(custody.owners[0].closed, false);
    assert.equal(log.at(-1).method, 'quitOwned');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR_CANARY'));
});

test('busy refusal checks original installed bytes before normal quit and never force-releases', async () => {
    const { result, log, custody } = await run({ busyMutation: true });
    assert.equal(result.status, 'failed');
    assert.equal(custody.owners.at(-1).closed, false);
    const actions = log.filter(
        (item) => item.id === 'macos-bundle:busy-refusal',
    );
    assert.ok(actions.some((item) => item.detail?.expectBusy));
    assert.ok(!actions.some((item) => item.method === 'quitOwned'));
});

test('R1 action refusals also reject timeout spawn error unknown status and unexpected signal', async () => {
    for (const abnormalBusy of [
        { exitCode: null, signal: 'SIGTERM', error: 'timeout' },
        { exitCode: null, signal: null, error: 'spawn-error' },
        { exitCode: null, signal: null, error: 'none' },
        { exitCode: 1, signal: 'SIGTERM', error: 'none' },
        { exitCode: -1, signal: null, error: 'none' },
    ]) {
        const { result, custody, log } = await run({ abnormalBusy });
        assert.equal(result.status, 'failed');
        assert.equal(custody.owners.at(-1).closed, false);
        assert.ok(!log.some((item) => item.id === 'macos-bundle:repair'));
        const refused = result.cases
            .find((item) => item.id === 'macos-bundle:busy-refusal')
            .actions.filter((item) => item.method === 'install')
            .at(-1);
        assert.equal(refused.facts.exitCode, abnormalBusy.exitCode);
        assert.equal(refused.facts.error, abnormalBusy.error);
    }
});

test('repair and application readback detect preservation failures', async () => {
    for (const options of [
        { repairCorruption: true },
        { appReadMismatch: true },
    ]) {
        const { result } = await run(options);
        assert.equal(result.status, 'failed');
        assert.ok(result.cases.some((item) => item.status === 'unexecuted'));
    }
});

test('interruption is explicit injected helper-operation failure followed by verified rollback/recovery', async () => {
    const { result, log } = await run();
    const id = 'macos-bundle:interrupted-recovery';
    assert.deepEqual(
        log
            .filter((item) => item.id === id && item.method === 'install')
            .map((item) => item.detail.fault ?? 'normal'),
        ['normal', 'activation-return-failure', 'normal'],
    );
    assert.equal(
        result.cases.find((item) => item.id === id).interruptionScope,
        'injected-helper-operation-failure-not-crash-durability',
    );
    const bad = await run({ failedRollback: true });
    assert.equal(bad.result.status, 'failed');
    assert.ok(
        !bad.log.some(
            (item) => item.id === 'macos-bundle:profile-report-preservation',
        ),
    );
});

test('owned integration scope is explicit bundle identity, without global registration assertions', async () => {
    const { result } = await run();
    const selected = result.cases.find(
        (item) => item.id === 'macos-bundle:owned-integrations',
    );
    assert.equal(
        selected.integrationScope,
        'owned-bundle-only-no-global-registration-claim',
    );
    assert.equal(
        selected.actions.find(
            (item) => item.method === 'inspectOwnedIntegrations',
        ).facts.bundleIdentifier,
        'dev.diagnostichub.desktop',
    );
});

test('caller mutation cannot change admitted current input during actions', async () => {
    const data = inputs();
    const mock = memoryEffects(
        {
            onPrepare: () => {
                data.current.version = '99.0.0';
            },
        },
        data,
    );
    const { result } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    assert.equal(result.status, 'verified');
    assert.equal(result.bindings.current.version, '0.6.0');
});

test('returned command facts are copied before a later effect mutates its own buffer', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        commands = [];
    const originalInstall = mock.effects.install,
        originalSnapshot = mock.effects.snapshot;
    mock.effects.install = async (...args) => {
        const value = await originalInstall(...args);
        commands.push(value.command);
        return value;
    };
    mock.effects.snapshot = async (...args) => {
        if (commands.length) commands[0][0] = 'MUTATED_LATER_BY_MOCK';
        return originalSnapshot(...args);
    };
    const { result } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    assert.equal(result.status, 'verified');
    assert.equal(
        result.cases[0].actions.find((item) => item.method === 'install').facts
            .command[0],
        'mock-helper-no-process',
    );
});

test('fixture target drift is refused before the next effect submission', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        originalSnapshot = mock.effects.snapshot;
    mock.effects.snapshot = async (fixture) => {
        const value = await originalSnapshot(fixture);
        fixture.target = '/mock/unrelated/app';
        return value;
    };
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    assert.equal(result.status, 'failed');
    assert.equal(custody.pending, null);
    assert.deepEqual(
        mock.log.map((item) => item.method),
        ['prepare', 'snapshot'],
    );
});

test('action evidence attaches without pretending legacy fixtures or native cases ran', async () => {
    const { result } = await run();
    const data = inputs();
    const observation = createMacInstallerObservation({
        context: {
            version: data.current.version,
            sourceCommit: data.current.sourceCommit,
            sourceTree: 'b'.repeat(40),
        },
        runtime: {
            platform: 'darwin',
            arch: 'arm64',
            node: '24.22.0',
            osRelease: 'synthetic',
            executable: '/mock/node',
            executableSHA256: 'c'.repeat(64),
        },
        artifacts: laneFiles('0.6.0', 'darwin-arm64').map((name) => ({
            name,
            bytes: 7,
            sha256: digest('fixture'),
        })),
        command: ['/mock/action-test'],
        startedAt: '2026-10-26T10:00:00.000Z',
    });
    const wrong = structuredClone(result);
    wrong.bindings.current.zipSHA256 = '0'.repeat(64);
    assert.throws(() => observation.attachNativeActions(wrong));
    observation.attachNativeActions(result);
    assert.throws(() => observation.attachNativeActions(result));
    observation.completeNativeActions('2026-10-26T10:00:01.000Z');
    const { receiptBytes, stageBytes } = observation.serialize();
    const receipt = JSON.parse(receiptBytes),
        stages = JSON.parse(stageBytes);
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.fixtureStatus, 'unexecuted');
    assert.ok(stages.stages.every((item) => item.status === 'unexecuted'));
    assert.deepEqual(stages.nativeActionResults, result);
    assert.ok(
        receipt.cases.every(
            (item) =>
                item.status === 'unexecuted' &&
                item.qualificationStatus === 'unverified',
        ),
    );
    assert.equal(receipt.cases[0].evidence[0].sha256, digest(stageBytes));
    assert.throws(() =>
        validateInstallerReceipt(receipt, {
            version: '0.6.0',
            sourceCommit: 'a'.repeat(40),
            sourceTree: 'b'.repeat(40),
            lane: 'darwin-arm64',
            artifacts: receipt.artifacts,
        }),
    );
});

test('public action grammar rejects raw custody, arbitrary diagnostics and forged case lists', async () => {
    const { result, custody } = await run();
    for (const mutate of [
        (x) => {
            x.custody = custody;
        },
        (x) => {
            x.reason = 'PRIVATE_ERROR_CANARY';
        },
        (x) => {
            x.cases.pop();
        },
        (x) => {
            x.cases[0].actions[0].facts.extra = {
                secret: 'PRIVATE_ERROR_CANARY',
            };
        },
    ]) {
        const altered = structuredClone(result);
        mutate(altered);
        assert.throws(() => validateMacInstallerActionResult(altered));
    }
});

test('native-labelled synthetic result stays blocked and uncertain result preserves UNKNOWN', async () => {
    const makeObservation = () =>
        createMacInstallerObservation({
            context: {
                version: '0.6.0',
                sourceCommit: 'a'.repeat(40),
                sourceTree: 'b'.repeat(40),
            },
            runtime: {
                platform: 'darwin',
                arch: 'arm64',
                node: '24.22.0',
                osRelease: 'synthetic',
                executable: '/mock/node',
                executableSHA256: 'c'.repeat(64),
            },
            artifacts: laneFiles('0.6.0', 'darwin-arm64').map((name) => ({
                name,
                bytes: 7,
                sha256: digest('fixture'),
            })),
            command: ['/mock/synthetic-control'],
            startedAt: '2026-10-26T10:00:00.000Z',
        });
    const successfulMock = await run();
    const syntheticNativeTag = structuredClone(successfulMock.result);
    syntheticNativeTag.executionScope = 'native'; // Schema control only, not native execution.
    const first = makeObservation();
    first.attachNativeActions(syntheticNativeTag);
    first.completeNativeActions('2026-10-26T10:00:01.000Z');
    const receipt = JSON.parse(first.serialize().receiptBytes);
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.exitCode, null);
    assert.ok(
        receipt.cases.every(
            (item) =>
                item.status === 'verified' &&
                item.qualificationStatus === 'unverified',
        ),
    );
    assert.equal(receipt.review, null);
    const uncertain = await run({ rejectMethod: 'quitOwned' });
    const second = makeObservation();
    second.attachNativeActions(uncertain.result);
    second.completeNativeActions('2026-10-26T10:00:01.000Z');
    const unknown = JSON.parse(second.serialize().receiptBytes);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.reason, 'NATIVE_ACTIONS_UNKNOWN');
    assert.equal(unknown.exitObserved, false);
    assert.equal(uncertain.custody.owners[0].closed, false);
});

for (const id of installerCases('darwin-arm64')) {
    test('known failed action stops all subsequent cases: ' + id, async () => {
        const { result, log } = await run({
            failCase: id.slice('macos-bundle:'.length),
        });
        const index = result.cases.findIndex((item) => item.id === id);
        assert.equal(result.status, 'failed');
        assert.equal(result.cases[index].status, 'failed');
        assert.ok(
            result.cases
                .slice(index + 1)
                .every((item) => item.status === 'unexecuted'),
        );
        assert.equal(log.at(-1).id, id);
    });
}

test('R3 effect-mutated package cannot rewrite the admitted current comparison identity', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        original = mock.effects.install;
    mock.effects.install = async (fixture, input, config) => {
        if (fixture.id === 'macos-bundle:install') {
            input.version = '99.0.0';
            input.asarSHA256 = 'f'.repeat(64);
        }
        return original(fixture, input, config);
    };
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    validateMacInstallerActionResult(result);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'EFFECT_PACKAGE_IDENTITY_DRIFT');
    assert.equal(result.bindings.current.version, '0.6.0');
    assert.equal(mock.states.get('macos-bundle:install').version, '99.0.0');
    assert.equal(custody.installArguments[0].admitted.version, '0.6.0');
    assert.equal(custody.installArguments[0].argument.version, '99.0.0');
    assert.ok(Object.isFrozen(custody.installArguments[0].admitted));
    assert.ok(
        result.cases.slice(1).every((item) => item.status === 'unexecuted'),
    );
    assert.deepEqual(
        mock.log.map((item) => item.method),
        ['prepare', 'snapshot', 'install'],
    );
});

test('R3 prior-package aliases also retain the original distinct identity', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        original = mock.effects.install;
    mock.effects.install = async (fixture, input, config) => {
        if (
            fixture.id.endsWith(':update-distinct-version') &&
            input.version === '0.5.2'
        )
            input.zipSHA256 = 'f'.repeat(64);
        return original(fixture, input, config);
    };
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    validateMacInstallerActionResult(result);
    assert.equal(result.reason, 'EFFECT_PACKAGE_IDENTITY_DRIFT');
    assert.equal(result.bindings.previous.zipSHA256, data.previous.zipSHA256);
    const record = custody.installArguments.find((item) =>
        item.caseId.endsWith(':update-distinct-version'),
    );
    assert.equal(record.admitted.zipSHA256, data.previous.zipSHA256);
    assert.equal(record.argument.zipSHA256, 'f'.repeat(64));
    assert.ok(
        result.cases.slice(0, 4).every((item) => item.status === 'verified'),
    );
    assert.ok(
        result.cases.slice(5).every((item) => item.status === 'unexecuted'),
    );
});

test('R3 quit owner mutation cannot close a different logical identity', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        original = mock.effects.quitOwned;
    mock.effects.quitOwned = async (fixture, owner) => {
        owner.id = 'CHANGED_AFTER_LAUNCH';
        return original(fixture, owner);
    };
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    validateMacInstallerActionResult(result);
    assert.equal(result.reason, 'EFFECT_OWNER_IDENTITY_DRIFT');
    assert.equal(
        custody.owners[0].identity.id,
        'mock-owner:macos-bundle:offline-launch',
    );
    assert.equal(custody.owners[0].value.id, 'CHANGED_AFTER_LAUNCH');
    assert.equal(custody.owners[0].closed, false);
    const actions = result.cases[1].actions;
    assert.equal(
        actions.find((item) => item.method === 'launchOwned').facts.id,
        custody.owners[0].identity.id,
    );
    assert.equal(
        actions.find((item) => item.method === 'quitOwned').facts.ownerId,
        'CHANGED_AFTER_LAUNCH',
    );
    assert.ok(
        result.cases.slice(2).every((item) => item.status === 'unexecuted'),
    );
});

test('R3 contradictory quit evidence is refused even without raw owner mutation', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        original = mock.effects.quitOwned;
    mock.effects.quitOwned = async (...args) => ({
        ...(await original(...args)),
        ownerId: 'UNRELATED_OWNER',
    });
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    assert.equal(result.reason, 'EFFECT_OWNER_IDENTITY_DRIFT');
    assert.equal(custody.owners[0].value.id, custody.owners[0].identity.id);
    assert.equal(custody.owners[0].closed, false);
});

test('R3 removal cannot replace the originally verified backup manifest baseline', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        original = mock.effects.removeOwnedInstallation;
    mock.effects.removeOwnedInstallation = async (fixture, backup) => {
        backup.manifestSHA256 = 'f'.repeat(64);
        return original(fixture, backup);
    };
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    validateMacInstallerActionResult(result);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'EFFECT_BACKUP_IDENTITY_DRIFT');
    const admitted = digest('complete mocked bundle manifest');
    assert.equal(custody.backups[0].identity.manifestSHA256, admitted);
    assert.equal(custody.backups[0].value.manifestSHA256, 'f'.repeat(64));
    const actions = result.cases.at(-1).actions;
    assert.equal(
        actions.find((item) => item.method === 'backupOwnedInstallation').facts
            .manifestSHA256,
        admitted,
    );
    assert.equal(
        actions.find((item) => item.method === 'removeOwnedInstallation').facts
            .manifestSHA256,
        'f'.repeat(64),
    );
    assert.equal(actions.at(-1).method, 'removeOwnedInstallation');
});

test('R3 all verified backup descriptor fields remain independent of effect mutation', async () => {
    for (const change of [
        { target: '/mock/unrelated/app' },
        { snapshotSHA256: 'f'.repeat(64) },
        { completeBundle: false },
        { verified: false },
    ]) {
        const data = inputs(),
            mock = memoryEffects({}, data),
            original = mock.effects.removeOwnedInstallation;
        mock.effects.removeOwnedInstallation = async (fixture, backup) => {
            const returned = await original(fixture, backup);
            Object.assign(backup, change);
            return returned;
        };
        const { result, custody } = await runMacInstallerActions({
            inputs: data,
            effects: mock.effects,
        });
        assert.equal(result.reason, 'EFFECT_BACKUP_IDENTITY_DRIFT');
        assert.ok(
            custody.identityDrifts.some(
                (item) => item.reason === result.reason,
            ),
        );
        assert.ok(
            custody.backups[0].identity.completeBundle &&
                custody.backups[0].identity.verified,
        );
    }
});

test('R3 borrowed helper options cannot change a planned refusal into installation', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        original = mock.effects.install;
    mock.effects.install = async (fixture, input, config) => {
        if (config.expectBusy) config.expectBusy = false;
        return original(fixture, input, config);
    };
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    assert.equal(result.reason, 'EFFECT_HELPER_OPTIONS_DRIFT');
    const argument = custody.installArguments.find(
        (item) => item.admittedOptions.expectBusy,
    );
    assert.equal(argument.admittedOptions.expectBusy, true);
    assert.equal(argument.argumentOptions.expectBusy, false);
    assert.equal(custody.owners.at(-1).closed, false);
    assert.ok(
        result.cases.slice(3).every((item) => item.status === 'unexecuted'),
    );
});

test('R3 open owner identity is checked after adjacent effects before any later submission', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        originalLaunch = mock.effects.launchOwned,
        originalSnapshot = mock.effects.snapshot;
    let retained;
    mock.effects.launchOwned = async (...args) => {
        const owner = await originalLaunch(...args);
        if (args[0].id.endsWith(':busy-refusal')) retained = owner;
        return owner;
    };
    mock.effects.snapshot = async (...args) => {
        const value = await originalSnapshot(...args);
        if (retained) retained.id = 'CHANGED_DURING_SNAPSHOT';
        return value;
    };
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    assert.equal(result.reason, 'EFFECT_OWNER_IDENTITY_DRIFT');
    assert.equal(mock.log.at(-1).method, 'snapshot');
    assert.equal(custody.owners.at(-1).closed, false);
    assert.equal(
        custody.owners.at(-1).identity.id,
        'mock-owner:macos-bundle:busy-refusal',
    );
});

test('R3 rejected aliased effect retains UNKNOWN and private original comparisons', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data);
    mock.effects.install = async (fixture, input) => {
        input.version = '99.0.0';
        throw Error('PRIVATE_ALIAS_ERROR');
    };
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    validateMacInstallerActionResult(result);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'UNKNOWN_EFFECT_RETURN');
    assert.equal(custody.pending.method, 'install');
    assert.equal(custody.pending.phase, 'submitted');
    assert.equal(custody.installArguments[0].admitted.version, '0.6.0');
    assert.equal(custody.installArguments[0].argument.version, '99.0.0');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_ALIAS_ERROR'));
});

test('R3 reused raw owner objects cannot rewrite previous closed identity records', async () => {
    const data = inputs(),
        mock = memoryEffects({}, data),
        original = mock.effects.launchOwned;
    const reused = {};
    mock.effects.launchOwned = async (...args) => {
        Object.assign(reused, await original(...args));
        return reused;
    };
    const { result, custody } = await runMacInstallerActions({
        inputs: data,
        effects: mock.effects,
    });
    validateMacInstallerActionResult(result);
    assert.equal(result.status, 'verified');
    assert.ok(custody.owners.every((item) => item.closed));
    assert.equal(
        new Set(custody.owners.map((item) => item.identity.id)).size,
        custody.owners.length,
    );
    assert.equal(
        custody.owners[0].identity.id,
        'mock-owner:macos-bundle:offline-launch',
    );
});
