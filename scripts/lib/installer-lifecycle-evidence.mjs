import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WINDOWS_SETUP_ASSET } from './windows-setup-release.mjs';
import {
    inspectWindowsNativeLifecycle,
    readWindowsNativeRecords,
    inspectWindowsNativeOwnedLifecycle,
    readWindowsNativeOwnedRecords,
    inspectWindowsNativeOwnedSiblingLifecycle,
    readWindowsNativeOwnedSiblingRecords,
} from './windows-native-lifecycle.mjs';
import {
    inspectMacOfflineDirectChild,
    inspectMacOfflinePayload,
    readMacOfflineRecords,
} from './macos-offline-lifecycle.mjs';

export const INSTALLER_CASE_LIMIT = 128 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keys = (value, wanted) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...wanted].sort());
};
export function validateInstallerRun(receipt, expected) {
    for (const key of ['runId', 'runAttempt']) {
        for (const value of [receipt[key], expected[key]])
            assert.ok(
                typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value),
                'Missing or invalid installer ' + key,
            );
        assert.equal(receipt[key], expected[key], 'Installer evidence belongs to another ' + key);
    }
}
/** Metadata only; presence of these references is never a native qualification verdict. */
export function validateInstallerReferences(receipt) {
    const paths = new Set(),
        hashes = new Set();
    for (const item of receipt.cases) {
        keys(item.lifecycleEvidence, ['path', 'bytes', 'sha256']);
        assert.ok(
            Number.isSafeInteger(item.lifecycleEvidence.bytes) && item.lifecycleEvidence.bytes > 0,
        );
        assert.match(item.lifecycleEvidence.sha256, hashPattern);
        assert.equal(item.lifecycleEvidence.path, 'cases/' + item.id.replace(':', '/') + '.json');
        assert.ok(item.lifecycleEvidence.bytes <= INSTALLER_CASE_LIMIT);
        assert.equal(
            item.evidence.filter(
                (entry) =>
                    entry.path === item.lifecycleEvidence.path &&
                    entry.bytes === item.lifecycleEvidence.bytes &&
                    entry.sha256 === item.lifecycleEvidence.sha256,
            ).length,
            1,
        );
        for (const entry of item.evidence) {
            assert.ok(
                !paths.has(entry.path) && !hashes.has(entry.sha256),
                'Installer cases must not reuse evidence paths or content.',
            );
            paths.add(entry.path);
            hashes.add(entry.sha256);
        }
    }
}
function packageName(lane, caseId) {
    if (lane === 'win32-x64') return WINDOWS_SETUP_ASSET;
    if (lane.startsWith('darwin-')) return 'Diagnostic-Hub-macos-' + lane.slice(7) + '.zip';
    assert.equal(lane, 'linux-x64');
    return caseId.startsWith('linux-folder:')
        ? 'Diagnostic-Hub-linux-x64.tar.gz'
        : 'Diagnostic-Hub-linux-x64.AppImage';
}
/** Versioned semantic projection, not a producer, provenance authenticator or pass issuer. */
export function inspectInstallerCaseObservation(value, item, expected) {
    keys(value, [
        'schemaVersion',
        'kind',
        'version',
        'sourceCommit',
        'sourceTree',
        'runId',
        'runAttempt',
        'lane',
        'caseId',
        'package',
        'observation',
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, 'installer-case-observation');
    validateInstallerRun(value, expected);
    for (const key of ['version', 'sourceCommit', 'sourceTree', 'lane'])
        assert.equal(value[key], expected[key]);
    assert.equal(value.caseId, item.id);
    const name = packageName(expected.lane, item.id);
    const packages = expected.artifacts.filter((entry) => entry.name === name);
    assert.equal(packages.length, 1, 'Missing exact installer package binding.');
    assert.deepEqual(value.package, packages[0], 'Installer case belongs to a different package.');
    assert.match(value.package.sha256, hashPattern);
    if (expected.lane.startsWith('darwin-') && item.id === 'macos-bundle:offline-launch')
        return value.observation?.kind === 'macos-owned-offline-launch/v2'
            ? inspectMacOfflinePayload(value.observation, item, expected)
            : inspectMacOfflineDirectChild(value.observation, expected);
    if (
        expected.lane === 'win32-x64' &&
        item.id === 'windows-nsis:offline-launch' &&
        value.observation?.kind === 'windows-native-readonly-consistency/v1'
    )
        return inspectWindowsNativeLifecycle(value.observation, item, expected);
    if (
        expected.lane === 'win32-x64' &&
        item.id === 'windows-nsis:offline-launch' &&
        value.observation?.kind === 'windows-native-owned-runtime/v1'
    )
        return inspectWindowsNativeOwnedLifecycle(value.observation, item, expected);
    if (
        expected.lane === 'win32-x64' &&
        item.id === 'windows-nsis:offline-launch' &&
        value.observation?.kind === 'windows-native-owned-runtime/v2'
    )
        return inspectWindowsNativeOwnedSiblingLifecycle(value.observation, item, expected);
    assert.equal(value.observation, null, 'Unsupported installer observation contract.');
    return 'unsupported-native-case';
}
/** Reads all case projections before returning a blocked verdict. This can validate real
 * records when supplied, but currently no admitted qualifying installer producer exists. */
export async function consumeInstallerLifecycleEvidence(rawReceipt, rawExpected, readBytes) {
    const receipt = structuredClone(rawReceipt),
        expected = structuredClone(rawExpected);
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.kind, 'native-installer-lifecycle');
    validateInstallerRun(receipt, expected);
    validateInstallerReferences(receipt);
    const observations = [];
    for (const item of receipt.cases) {
        const ref = item.lifecycleEvidence;
        const bytes = await readBytes(ref.path, INSTALLER_CASE_LIMIT);
        assert.ok(
            Buffer.isBuffer(bytes) &&
                bytes.length === ref.bytes &&
                bytes.length <= INSTALLER_CASE_LIMIT &&
                hash(bytes) === ref.sha256,
            'Installer lifecycle evidence changed after verification.',
        );
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const value = JSON.parse(text);
        assert.equal(
            JSON.stringify(value) + '\n',
            text,
            'Require canonical complete installer case JSON.',
        );
        const status = inspectInstallerCaseObservation(value, item, expected);
        if (value.observation?.kind === 'macos-owned-offline-launch/v2')
            await readMacOfflineRecords(value.observation, readBytes);
        if (value.observation?.kind === 'windows-native-readonly-consistency/v1')
            await readWindowsNativeRecords(value.observation, readBytes);
        if (value.observation?.kind === 'windows-native-owned-runtime/v1')
            await readWindowsNativeOwnedRecords(value.observation, readBytes);
        if (value.observation?.kind === 'windows-native-owned-runtime/v2')
            await readWindowsNativeOwnedSiblingRecords(value.observation, readBytes);
        observations.push({ caseId: item.id, status });
    }
    return { status: 'installer-lifecycle-unqualified', releaseAcceptance: false, observations };
}
