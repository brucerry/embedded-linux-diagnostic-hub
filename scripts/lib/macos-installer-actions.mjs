import assert from 'node:assert/strict';
import path from 'node:path';
import { digest, installerCases } from './staged-artifact-gate.mjs';

export const MAC_INSTALLER_ACTION_METHODS = Object.freeze([
    'prepare',
    'snapshot',
    'install',
    'launchOwned',
    'quitOwned',
    'seedApplicationData',
    'readApplicationData',
    'inspectOwnedIntegrations',
    'backupOwnedInstallation',
    'removeOwnedInstallation',
]);
const hashPattern = /^[a-f0-9]{64}$/;
export const MAC_SEED_UNAVAILABLE_REASONS = Object.freeze([
    'CONSOLE_STORAGE_SEED_API_UNAVAILABLE',
    'LEGACY_REPORT_SEED_API_UNAVAILABLE',
    'LEGACY_SEED_API_BINDING_MISMATCH',
]);
function identifiedPackage(input) {
    assert.ok(
        input &&
            typeof input.version === 'string' &&
            /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.version),
    );
    assert.match(input.sourceCommit, /^[a-f0-9]{40}$/);
    assert.ok(path.posix.isAbsolute(input.zipPath));
    for (const key of ['zipSHA256', 'asarSHA256']) assert.match(input[key], hashPattern);
}
function files(records, prefix) {
    assert.ok(Array.isArray(records));
    const paths = new Set();
    return records
        .map((item) => {
            assert.ok(
                typeof item.path === 'string' &&
                    item.path.startsWith(prefix + '/') &&
                    !item.path.split('/').includes('..') &&
                    !item.path.includes('\\') &&
                    path.posix.normalize(item.path) === item.path,
            );
            assert.ok(!paths.has(item.path));
            paths.add(item.path);
            assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0);
            assert.match(item.sha256, hashPattern);
            return { path: item.path, bytes: item.bytes, sha256: item.sha256 };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
}
function snapshot(value) {
    assert.equal(typeof value.exists, 'boolean');
    const selected = {
        exists: value.exists,
        version: value.version,
        asarSHA256: value.asarSHA256,
        profileFiles: files(value.profileFiles, 'profile'),
        reportFiles: files(value.reportFiles, 'reports'),
    };
    if (selected.exists) {
        assert.equal(typeof selected.version, 'string');
        assert.match(selected.asarSHA256, hashPattern);
    } else {
        assert.equal(selected.version, null);
        assert.equal(selected.asarSHA256, null);
    }
    return selected;
}
function normalReturn(value) {
    assert.equal(value.error, 'none');
    assert.equal(value.exitObserved, true);
    assert.equal(value.exitCode, 0);
    assert.equal(value.signal, null);
}
function installed(value, input) {
    assert.equal(value.exists, true);
    assert.equal(value.version, input.version);
    assert.equal(value.asarSHA256, input.asarSHA256);
}
function preserved(before, after) {
    assert.deepEqual(after.profileFiles, before.profileFiles);
    assert.deepEqual(after.reportFiles, before.reportFiles);
}
function publicFacts(method, value) {
    const selected = (names) =>
        Object.fromEntries(
            names.filter((name) => name in value).map((name) => [name, value[name]]),
        );
    assert.ok(value && typeof value === 'object');
    if (method === 'seedApplicationData') {
        if (value.origin === 'unsupported') {
            assert.ok(MAC_SEED_UNAVAILABLE_REASONS.includes(value.reason));
            assert.equal(value.ownerSettled, true);
            return { origin: value.origin, reason: value.reason, ownerSettled: true };
        }
        assert.equal(value.origin, 'application');
        if ('reportFormat' in value) {
            assert.ok(
                ['console-schema2', 'legacy-diagnostic-schema1'].includes(value.reportFormat),
            );
            const legacy = value.reportFormat === 'legacy-diagnostic-schema1';
            assert.equal(
                value.profileFixture,
                legacy ? 'known-hosts-record-v052' : 'console-journal-schema2',
            );
            assert.equal(value.profileUseVerified, !legacy);
            return selected(['origin', 'reportFormat', 'profileFixture', 'profileUseVerified']);
        }
        return { origin: value.origin }; // Existing producer/memory-adapter contract remains compatible.
    }
    if (method === 'snapshot') return snapshot(value);
    if (method === 'install') {
        assert.ok(
            Array.isArray(value.command) &&
                value.command.length > 0 &&
                value.command.length <= 32 &&
                value.command.every(
                    (item) => typeof item === 'string' && item.length > 0 && item.length <= 4096,
                ),
        );
        assert.equal(typeof value.exitObserved, 'boolean');
        assert.ok(['none', 'timeout', 'spawn-error'].includes(value.error));
        assert.ok(value.exitCode === null || Number.isSafeInteger(value.exitCode));
        assert.ok(value.signal === null || /^SIG[A-Z0-9]+$/.test(value.signal));
        if ('busyRefusalVerified' in value)
            assert.equal(typeof value.busyRefusalVerified, 'boolean');
        if ('faultObserved' in value)
            assert.equal(value.faultObserved, 'activation-return-failure');
        return selected([
            'command',
            'exitObserved',
            'exitCode',
            'signal',
            'error',
            'busyRefusalVerified',
            'faultObserved',
        ]);
    }
    if (method === 'readApplicationData') {
        assert.equal(value.origin, 'application');
        return {
            origin: value.origin,
            profileFiles: files(value.profileFiles, 'profile'),
            reportFiles: files(value.reportFiles, 'reports'),
        };
    }
    const fields = {
        prepare: ['id', 'root', 'target', 'fresh'],
        launchOwned: ['id', 'ready', 'offlineLaunchVerified'],
        quitOwned: [
            'ownerId',
            'exitObserved',
            'exitCode',
            'signal',
            'error',
            'closeObserved',
            'stdoutEOF',
            'stderrEOF',
        ],
        seedApplicationData: ['origin'],
        inspectOwnedIntegrations: ['scope', 'target', 'bundleIdentifier', 'verified'],
        backupOwnedInstallation: [
            'target',
            'verified',
            'completeBundle',
            'snapshotSHA256',
            'manifestSHA256',
        ],
        removeOwnedInstallation: ['target', 'returned', 'verifiedBackupRetained', 'manifestSHA256'],
    };
    assert.ok(Object.hasOwn(fields, method));
    const output = selected(fields[method]);
    const booleans = [
        'fresh',
        'ready',
        'offlineLaunchVerified',
        'exitObserved',
        'closeObserved',
        'stdoutEOF',
        'stderrEOF',
        'verified',
        'completeBundle',
        'returned',
        'verifiedBackupRetained',
    ];
    for (const [key, fact] of Object.entries(output)) {
        if (booleans.includes(key)) assert.equal(typeof fact, 'boolean');
        else if (key === 'error') assert.ok(['none', 'timeout', 'spawn-error'].includes(fact));
        else if (key === 'exitCode') assert.ok(fact === null || Number.isSafeInteger(fact));
        else if (key === 'signal') assert.ok(fact === null || /^SIG[A-Z0-9]+$/.test(fact));
        else {
            assert.ok(typeof fact === 'string' && fact.length > 0 && fact.length <= 4096);
            if (key.endsWith('SHA256')) assert.match(fact, hashPattern);
        }
    }
    return output;
}

// Fixed nine-case action sequence. No filesystem, child, GUI or cleanup implementation lives
// here. A native caller must retain returned custody and supply a separately reviewed adapter.
// Mock verification is never converted into native evidence or a consumer `passed` status.
export async function runMacInstallerActions({ inputs, effects }) {
    inputs = structuredClone(inputs);
    const ids = installerCases(inputs.lane);
    assert.ok(['darwin-x64', 'darwin-arm64'].includes(inputs.lane));
    const cases = ids.map((id) => ({ id, status: 'unexecuted', actions: [] }));
    const custody = {
        fixtures: [],
        owners: [],
        backups: [],
        installArguments: [],
        returnedOperations: [],
        identityDrifts: [],
        pending: null,
    };
    const result = {
        schemaVersion: 1,
        kind: 'macos-installer-actions',
        executionScope: effects?.kind ?? 'unavailable',
        lane: inputs.lane,
        qualificationStatus: 'unverified',
        status: 'unavailable',
        cases,
    };
    if (!['mock', 'native'].includes(result.executionScope)) result.executionScope = 'unavailable';
    const unavailable = (reason, caseId) => {
        result.reason = reason;
        if (caseId) cases.find((item) => item.id === caseId).status = 'unavailable';
        return { result, custody };
    };
    try {
        identifiedPackage(inputs.current);
    } catch {
        return unavailable('CURRENT_PACKAGE_BINDING_UNAVAILABLE');
    }
    try {
        identifiedPackage(inputs.previous);
        assert.notEqual(inputs.previous.version, inputs.current.version);
        assert.notEqual(inputs.previous.zipSHA256, inputs.current.zipSHA256);
    } catch {
        return unavailable(
            'DISTINCT_PRIOR_PACKAGE_UNAVAILABLE',
            'macos-bundle:update-distinct-version',
        );
    }
    try {
        assert.ok(path.posix.isAbsolute(inputs.fixtureParent));
        assert.equal(inputs.bundleIdentifier, 'dev.diagnostichub.desktop');
    } catch {
        return unavailable('FIXTURE_SCOPE_UNAVAILABLE');
    }
    if (
        !['mock', 'native'].includes(effects?.kind) ||
        MAC_INSTALLER_ACTION_METHODS.some((name) => typeof effects[name] !== 'function')
    )
        return unavailable('NATIVE_EFFECT_ADAPTER_UNAVAILABLE');
    // These private baselines are never lent to an effect. Each install receives its own copy.
    const current = Object.freeze(structuredClone(inputs.current)),
        previous = Object.freeze(structuredClone(inputs.previous));
    const identity = ({ version, sourceCommit, zipSHA256, asarSHA256 }) => ({
        version,
        sourceCommit,
        zipSHA256,
        asarSHA256,
    });
    result.bindings = {
        current: identity(current),
        previous: identity(previous),
    };
    let active;
    const privateCopy = (value) => {
        try {
            return { value: structuredClone(value), available: true };
        } catch {
            return { value: null, available: false };
        }
    };
    function guardIdentity(actual, admitted, reason, raw = actual) {
        try {
            assert.deepEqual(actual, admitted);
        } catch {
            custody.identityDrifts.push({
                caseId: active.id,
                reason,
                admitted: privateCopy(admitted),
                observed: privateCopy(actual),
                raw,
            });
            throw Object.assign(new Error(reason), {
                identityDriftReason: reason,
            });
        }
    }
    function guardFixture(fixture) {
        const root = path.posix.join(inputs.fixtureParent, active.id.slice('macos-bundle:'.length));
        guardIdentity(
            {
                id: fixture?.id,
                fresh: fixture?.fresh,
                root: fixture?.root,
                target: fixture?.target,
            },
            {
                id: active.id,
                fresh: true,
                root,
                target: path.posix.join(root, 'Applications', 'Diagnostic Hub.app'),
            },
            'EFFECT_FIXTURE_IDENTITY_DRIFT',
            fixture,
        );
    }
    function guardOpenOwners() {
        for (const owner of custody.owners)
            if (!owner.closed && owner.identity)
                guardIdentity(
                    { id: owner.value?.id },
                    owner.identity,
                    'EFFECT_OWNER_IDENTITY_DRIFT',
                    owner.value,
                );
    }
    async function call(method, args, retain) {
        guardOpenOwners();
        if (method !== 'prepare') guardFixture(args[0]);
        const operation = { caseId: active.id, method, phase: 'submitted' };
        custody.pending = operation; // Before the first asynchronous effect submission.
        let returned;
        try {
            returned = await effects[method](...args);
        } catch {
            // Rejection does not prove physical completion; keep pending identity and stop.
            throw Object.assign(new Error('UNKNOWN_EFFECT_RETURN'), {
                uncertainEffect: true,
            });
        }
        operation.phase = 'returned';
        operation.returned = returned;
        if (retain) retain(returned); // Persist fixture/owner identity before assertion or next await.
        custody.returnedOperations.push(operation);
        const action = { method, returned: true };
        active.actions.push(action);
        try {
            action.facts = structuredClone(publicFacts(method, returned));
        } catch {
            action.invalidReturnedShape = true;
            throw new Error('INVALID_RETURNED_SHAPE');
        }
        custody.pending = null;
        if (method !== 'prepare') guardFixture(args[0]);
        guardOpenOwners();
        // Metadata comparisons use the first copied return facts, never a lent mutable buffer.
        return ['prepare', 'launchOwned', 'backupOwnedInstallation'].includes(method)
            ? returned
            : structuredClone(action.facts);
    }
    const get = async (fixture) => snapshot(await call('snapshot', [fixture]));
    const invokeInstall = async (fixture, input, options = {}) => {
        const argument = structuredClone(input),
            argumentOptions = structuredClone(options);
        const admittedOptions = Object.freeze(structuredClone(options));
        custody.installArguments.push({
            caseId: active.id,
            admitted: input,
            argument,
            admittedOptions,
            argumentOptions,
        });
        const returned = await call('install', [fixture, argument, argumentOptions]);
        guardIdentity(argument, input, 'EFFECT_PACKAGE_IDENTITY_DRIFT');
        guardIdentity(argumentOptions, admittedOptions, 'EFFECT_HELPER_OPTIONS_DRIFT');
        return returned;
    };
    const install = async (fixture, input, options = {}) => {
        const returned = await invokeInstall(fixture, input, options);
        normalReturn(returned);
        const value = await get(fixture);
        installed(value, input);
        return value;
    };
    const launch = async (fixture, offline = false) => {
        let retained;
        const owner = await call('launchOwned', [fixture, { offline }], (value) => {
            retained = {
                value,
                closed: false,
                identity: Object.freeze({ id: value?.id }),
                launchState: Object.freeze({
                    ready: value?.ready,
                    offlineLaunchVerified: value?.offlineLaunchVerified,
                }),
            };
            custody.owners.push(retained);
        });
        assert.ok(
            retained && typeof retained.identity.id === 'string' && retained.identity.id.length > 0,
        );
        guardIdentity({ id: owner.id }, retained.identity, 'EFFECT_OWNER_IDENTITY_DRIFT', owner);
        assert.equal(retained.launchState.ready, true);
        if (offline) assert.equal(retained.launchState.offlineLaunchVerified, true);
        return owner;
    };
    const quit = async (fixture, owner) => {
        const matches = custody.owners.filter((item) => item.value === owner && !item.closed);
        assert.equal(matches.length, 1);
        const retained = matches[0];
        assert.ok(retained?.identity);
        guardIdentity({ id: owner.id }, retained.identity, 'EFFECT_OWNER_IDENTITY_DRIFT', owner);
        const returned = await call('quitOwned', [fixture, owner]);
        guardIdentity({ id: owner.id }, retained.identity, 'EFFECT_OWNER_IDENTITY_DRIFT', owner);
        guardIdentity(
            { id: returned.ownerId },
            retained.identity,
            'EFFECT_OWNER_IDENTITY_DRIFT',
            returned,
        );
        normalReturn(returned);
        for (const key of ['closeObserved', 'stdoutEOF', 'stderrEOF'])
            assert.equal(returned[key], true);
        retained.closed = true;
    };
    const seed = async (fixture) => {
        const value = await call('seedApplicationData', [fixture]);
        if (value.origin === 'unsupported')
            throw Object.assign(new Error(value.reason), { unsupportedSeed: value.reason });
        assert.equal(value.origin, 'application');
        const before = await get(fixture);
        assert.ok(before.profileFiles.length > 0 && before.reportFiles.length > 0);
        return before;
    };
    try {
        for (active of cases) {
            active.status = 'running';
            const name = active.id.slice('macos-bundle:'.length);
            const fixture = await call('prepare', [active.id], (value) =>
                custody.fixtures.push(value),
            );
            guardFixture(fixture);
            assert.equal(fixture.id, active.id);
            assert.equal(fixture.fresh, true);
            assert.equal(fixture.root, path.posix.join(inputs.fixtureParent, name));
            assert.equal(
                fixture.target,
                path.posix.join(fixture.root, 'Applications', 'Diagnostic Hub.app'),
            );
            assert.equal((await get(fixture)).exists, false);
            if (name === 'update-distinct-version') {
                await install(fixture, previous);
                const before = await seed(fixture);
                const after = await install(fixture, current);
                preserved(before, after);
                active.priorVersion = previous.version;
                active.finalVersion = current.version;
            } else {
                await install(fixture, current);
                if (name === 'offline-launch') {
                    const owner = await launch(fixture, true);
                    await quit(fixture, owner);
                } else if (name === 'busy-refusal') {
                    const owner = await launch(fixture);
                    const before = await get(fixture);
                    const refused = await invokeInstall(fixture, current, {
                        expectBusy: true,
                    });
                    assert.equal(refused.exitObserved, true);
                    assert.equal(refused.error, 'none');
                    assert.equal(refused.signal, null);
                    assert.ok(
                        Number.isSafeInteger(refused.exitCode) &&
                            refused.exitCode > 0 &&
                            refused.exitCode <= 255,
                    );
                    assert.equal(refused.busyRefusalVerified, true);
                    assert.deepEqual(await get(fixture), before);
                    await quit(fixture, owner);
                } else if (name === 'repair') {
                    const before = await seed(fixture);
                    preserved(before, await install(fixture, current));
                } else if (name === 'interrupted-recovery') {
                    const before = await seed(fixture);
                    const interrupted = await invokeInstall(fixture, current, {
                        fault: 'activation-return-failure',
                    });
                    assert.equal(interrupted.exitObserved, true);
                    assert.equal(interrupted.error, 'none');
                    assert.equal(interrupted.signal, null);
                    assert.ok(
                        Number.isSafeInteger(interrupted.exitCode) &&
                            interrupted.exitCode > 0 &&
                            interrupted.exitCode <= 255,
                    );
                    assert.equal(interrupted.faultObserved, 'activation-return-failure');
                    assert.deepEqual(await get(fixture), before);
                    preserved(before, await install(fixture, current));
                    active.interruptionScope =
                        'injected-helper-operation-failure-not-crash-durability';
                } else if (name === 'profile-report-preservation') {
                    const before = await seed(fixture);
                    preserved(before, await install(fixture, current));
                    const owner = await launch(fixture, true);
                    const read = await call('readApplicationData', [fixture, owner]);
                    assert.equal(read.origin, 'application');
                    assert.deepEqual(files(read.profileFiles, 'profile'), before.profileFiles);
                    assert.deepEqual(files(read.reportFiles, 'reports'), before.reportFiles);
                    await quit(fixture, owner);
                } else if (name === 'owned-integrations') {
                    const observed = await call('inspectOwnedIntegrations', [fixture]);
                    assert.equal(observed.scope, 'owned-application-bundle');
                    assert.equal(observed.target, fixture.target);
                    assert.equal(observed.bundleIdentifier, inputs.bundleIdentifier);
                    assert.equal(observed.verified, true);
                    active.integrationScope = 'owned-bundle-only-no-global-registration-claim';
                } else if (name === 'remove') {
                    const before = await seed(fixture);
                    const backup = await call('backupOwnedInstallation', [fixture], (value) =>
                        custody.backups.push({
                            value,
                            identity: Object.freeze({
                                target: value?.target,
                                verified: value?.verified,
                                completeBundle: value?.completeBundle,
                                snapshotSHA256: value?.snapshotSHA256,
                                manifestSHA256: value?.manifestSHA256,
                            }),
                        }),
                    );
                    const retainedBackup = custody.backups.find((item) => item.value === backup);
                    guardIdentity(
                        {
                            target: backup.target,
                            verified: backup.verified,
                            completeBundle: backup.completeBundle,
                            snapshotSHA256: backup.snapshotSHA256,
                            manifestSHA256: backup.manifestSHA256,
                        },
                        retainedBackup.identity,
                        'EFFECT_BACKUP_IDENTITY_DRIFT',
                        backup,
                    );
                    assert.equal(retainedBackup.identity.target, fixture.target);
                    assert.equal(retainedBackup.identity.verified, true);
                    assert.equal(retainedBackup.identity.completeBundle, true);
                    assert.match(retainedBackup.identity.manifestSHA256, hashPattern);
                    assert.equal(
                        retainedBackup.identity.snapshotSHA256,
                        digest(JSON.stringify(before)),
                    );
                    const removed = await call('removeOwnedInstallation', [fixture, backup]);
                    guardIdentity(
                        {
                            target: backup.target,
                            verified: backup.verified,
                            completeBundle: backup.completeBundle,
                            snapshotSHA256: backup.snapshotSHA256,
                            manifestSHA256: backup.manifestSHA256,
                        },
                        retainedBackup.identity,
                        'EFFECT_BACKUP_IDENTITY_DRIFT',
                        backup,
                    );
                    guardIdentity(
                        {
                            target: removed.target,
                            manifestSHA256: removed.manifestSHA256,
                        },
                        {
                            target: retainedBackup.identity.target,
                            manifestSHA256: retainedBackup.identity.manifestSHA256,
                        },
                        'EFFECT_BACKUP_IDENTITY_DRIFT',
                        removed,
                    );
                    assert.equal(removed.returned, true);
                    assert.equal(removed.verifiedBackupRetained, true);
                    assert.equal(removed.manifestSHA256, retainedBackup.identity.manifestSHA256);
                    const after = await get(fixture);
                    assert.equal(after.exists, false);
                    preserved(before, after);
                }
            }
            active.status = 'verified';
        }
        result.status = 'verified'; // Action assertions only; never release qualification.
    } catch (error) {
        result.status = error.unsupportedSeed
            ? 'unavailable'
            : error.uncertainEffect
              ? 'unknown'
              : 'failed';
        result.reason =
            error.unsupportedSeed ??
            (error.uncertainEffect
                ? 'UNKNOWN_EFFECT_RETURN'
                : (error.identityDriftReason ?? 'ACTION_ASSERTION_FAILED'));
        if (active) active.status = result.status;
    }
    return { result, custody };
}

// Public evidence has a closed grammar and excludes the private custody object/returned handles.
export function validateMacInstallerActionResult(value) {
    const keys = (object, allowed) => {
        assert.ok(object && typeof object === 'object' && !Array.isArray(object));
        assert.ok(Object.keys(object).every((key) => allowed.includes(key)));
    };
    keys(value, [
        'schemaVersion',
        'kind',
        'executionScope',
        'lane',
        'qualificationStatus',
        'status',
        'cases',
        'bindings',
        'reason',
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, 'macos-installer-actions');
    assert.ok(['darwin-x64', 'darwin-arm64'].includes(value.lane));
    assert.ok(['mock', 'native', 'unavailable'].includes(value.executionScope));
    assert.equal(value.qualificationStatus, 'unverified');
    assert.ok(['unavailable', 'verified', 'failed', 'unknown'].includes(value.status));
    assert.deepEqual(
        value.cases.map((item) => item.id),
        installerCases(value.lane),
    );
    for (const item of value.cases) {
        keys(item, [
            'id',
            'status',
            'actions',
            'priorVersion',
            'finalVersion',
            'interruptionScope',
            'integrationScope',
        ]);
        assert.ok(
            ['unexecuted', 'unavailable', 'verified', 'failed', 'unknown'].includes(item.status),
        );
        assert.ok(Array.isArray(item.actions) && item.actions.length <= 32);
        for (const action of item.actions) {
            keys(action, ['method', 'returned', 'facts', 'invalidReturnedShape']);
            assert.ok(MAC_INSTALLER_ACTION_METHODS.includes(action.method));
            assert.equal(action.returned, true);
            if (action.invalidReturnedShape) {
                assert.equal(action.invalidReturnedShape, true);
                assert.ok(!('facts' in action));
            } else assert.deepEqual(publicFacts(action.method, action.facts), action.facts);
        }
        for (const key of ['priorVersion', 'finalVersion'])
            if (key in item)
                assert.ok(
                    typeof item[key] === 'string' &&
                        item[key].length <= 128 &&
                        /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(item[key]),
                );
        if ('interruptionScope' in item)
            assert.equal(
                item.interruptionScope,
                'injected-helper-operation-failure-not-crash-durability',
            );
        if ('integrationScope' in item)
            assert.equal(item.integrationScope, 'owned-bundle-only-no-global-registration-claim');
    }
    if (value.bindings) {
        keys(value.bindings, ['current', 'previous']);
        for (const input of [value.bindings.current, value.bindings.previous]) {
            keys(input, ['version', 'sourceCommit', 'zipSHA256', 'asarSHA256']);
            identifiedPackage({
                ...input,
                zipPath: '/admitted-input-identity-only',
            });
        }
        assert.notEqual(value.bindings.current.version, value.bindings.previous.version);
        assert.notEqual(value.bindings.current.zipSHA256, value.bindings.previous.zipSHA256);
    }
    if (value.status === 'verified') {
        assert.ok(value.bindings && value.cases.every((item) => item.status === 'verified'));
        assert.ok(!('reason' in value));
    } else {
        assert.ok(
            [
                'CURRENT_PACKAGE_BINDING_UNAVAILABLE',
                'DISTINCT_PRIOR_PACKAGE_UNAVAILABLE',
                'FIXTURE_SCOPE_UNAVAILABLE',
                'NATIVE_EFFECT_ADAPTER_UNAVAILABLE',
                'UNKNOWN_EFFECT_RETURN',
                'ACTION_ASSERTION_FAILED',
                'EFFECT_PACKAGE_IDENTITY_DRIFT',
                'EFFECT_HELPER_OPTIONS_DRIFT',
                'EFFECT_OWNER_IDENTITY_DRIFT',
                'EFFECT_BACKUP_IDENTITY_DRIFT',
                'EFFECT_FIXTURE_IDENTITY_DRIFT',
                ...MAC_SEED_UNAVAILABLE_REASONS,
            ].includes(value.reason),
        );
    }
    if (value.status === 'unavailable') {
        if (MAC_SEED_UNAVAILABLE_REASONS.includes(value.reason)) {
            const index = value.cases.findIndex((item) => item.status === 'unavailable');
            assert.ok(index >= 0);
            assert.ok(value.cases.slice(0, index).every((item) => item.status === 'verified'));
            assert.ok(
                value.cases
                    .slice(index + 1)
                    .every((item) => item.status === 'unexecuted' && item.actions.length === 0),
            );
            const last = value.cases[index].actions.at(-1);
            assert.equal(last?.method, 'seedApplicationData');
            assert.deepEqual(last.facts, {
                origin: 'unsupported',
                reason: value.reason,
                ownerSettled: true,
            });
        } else assert.ok(value.cases.every((item) => item.actions.length === 0));
    }
    return value;
}
