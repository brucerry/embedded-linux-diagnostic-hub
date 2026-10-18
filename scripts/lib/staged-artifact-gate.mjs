import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { includesWindowsSetup, releaseAssets, releaseMetadata } from './release-assets.mjs';
import { WINDOWS_SETUP_ASSET, windowsSetupInfoName } from './windows-setup-release.mjs';

export const PLATFORM_LANES = Object.freeze([
    { id: 'win32-x64', platform: 'win32', arch: 'x64' },
    { id: 'linux-x64', platform: 'linux', arch: 'x64' },
    { id: 'darwin-x64', platform: 'darwin', arch: 'x64' },
    { id: 'darwin-arm64', platform: 'darwin', arch: 'arm64' },
]);
const hashPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function laneDefinition(id) {
    const lane = PLATFORM_LANES.find((candidate) => candidate.id === id);
    assert.ok(lane, 'Unavailable platform lane: ' + id);
    return lane;
}
export function laneFiles(version, id) {
    const lane = laneDefinition(id);
    const assets = releaseAssets(version).filter((name) => {
        if (lane.platform === 'win32') return name.endsWith('.exe') || name === 'download-run.ps1';
        if (lane.platform === 'darwin')
            return (
                name === `Diagnostic-Hub-macos-${lane.arch}.zip` || name === 'download-run-macos.sh'
            );
        return name.includes('linux-') || name === 'download-run.sh';
    });
    const metadata = releaseMetadata(version).filter((name) => {
        if (lane.platform === 'win32')
            return name === 'build-info.json' || name === windowsSetupInfoName(WINDOWS_SETUP_ASSET);
        if (lane.platform === 'linux') return name === 'linux-build-info.json';
        return name === `macos-build-info-${lane.arch}.json`;
    });
    return [...assets.flatMap((name) => [name, name + '.sha256']), ...metadata].sort();
}
export function installerCases(id) {
    const common = [
        'install',
        'offline-launch',
        'busy-refusal',
        'repair',
        'update-distinct-version',
        'interrupted-recovery',
        'profile-report-preservation',
        'owned-integrations',
        'remove',
    ];
    if (id === 'linux-x64')
        return ['linux-folder', 'linux-appimage'].flatMap((layout) =>
            common.map((name) => layout + ':' + name),
        );
    return common.map(
        (name) => (id.startsWith('darwin') ? 'macos-bundle' : 'windows-nsis') + ':' + name,
    );
}
export function consumerCases(id) {
    if (id === 'win32-x64')
        return [
            'portable-runtime-identity',
            'portable-desktop',
            'portable-native-windows',
            'portable-host',
        ];
    if (id === 'linux-x64')
        return [
            'appimage-runtime-identity',
            'appimage-desktop',
            'appimage-native-windows',
            'archive-runtime-identity',
            'archive-desktop',
        ];
    return [
        'bundle-helper-installer',
        'installed-runtime-identity',
        'installed-desktop',
        'installed-native-windows',
    ];
}
export function producerFiles(version, scope) {
    if (scope.startsWith('desktop-')) return laneFiles(version, scope.slice('desktop-'.length));
    assert.ok(['web', 'gateway'].includes(scope), 'Unknown staged artifact producer scope.');
    const name = `Diagnostic-Hub-${scope === 'web' ? 'Web' : 'Gateway'}-${version}.${scope === 'web' ? 'zip' : 'tar.gz'}`;
    assert.ok(
        releaseAssets(version).includes(name),
        'Artifact scope is absent from the canonical release.',
    );
    return [name, name + '.sha256'];
}
export function producerCases(scope) {
    if (scope.startsWith('desktop-')) {
        laneDefinition(scope.slice('desktop-'.length));
        return ['desktop-production-runtime-profile', 'desktop-product-resource-qualification'];
    }
    if (scope === 'web')
        return [
            'web-archive-source-integrity',
            'web-chromium',
            'web-firefox',
            'web-webkit',
            'web-product-resource-qualification',
        ];
    assert.equal(scope, 'gateway');
    return [
        'gateway-archive-source-integrity',
        'gateway-production-runtime-profile',
        'gateway-product-resource-qualification',
    ];
}
export function validateProducerReceipt(receipt, expected) {
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, 'staged-artifact-producer');
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.scope, expected.scope);
    sameContext(receipt, expected);
    assert.equal(receipt.runId, expected.runId);
    assert.equal(receipt.runAttempt, expected.runAttempt);
    assert.ok(
        PLATFORM_LANES.some(
            (lane) =>
                lane.platform === receipt.runtime.platform && lane.arch === receipt.runtime.arch,
        ),
    );
    identity(receipt.runtime, receipt.runtime);
    if (expected.scope.startsWith('desktop-')) {
        const lane = laneDefinition(expected.scope.slice('desktop-'.length));
        assert.equal(receipt.runtime.platform, lane.platform);
        assert.equal(receipt.runtime.arch, lane.arch);
        assert.match(receipt.electronVersion, /^44\.5\.1$/);
    }
    validateArtifactRecords(receipt.artifacts, expected.artifacts);
    validateCases(receipt.cases, producerCases(expected.scope));
    assert.equal(
        receipt.qualificationScope,
        'full-product',
        'A component pass cannot close the final artifact gate.',
    );
    assert.match(receipt.reviewedPolicySHA256, hashPattern);
    assert.match(receipt.runtimeProfileSHA256, hashPattern);
    assert.equal(receipt.normalGC.status, 'passed');
    assert.equal(receipt.forcedGC.status, 'passed');
    for (const lane of [receipt.normalGC, receipt.forcedGC]) {
        assert.ok(Number.isSafeInteger(lane.elapsedMs) && lane.elapsedMs >= 30 * 60 * 1000);
        assert.ok(Number.isSafeInteger(lane.completedCycles) && lane.completedCycles >= 100);
        assert.match(lane.receiptSHA256, hashPattern);
    }
    if (expected.scope === 'web') {
        for (const engine of ['chromium', 'firefox', 'webkit']) {
            assert.ok(
                typeof receipt.browserVersions[engine] === 'string' &&
                    receipt.browserVersions[engine].length > 0,
            );
        }
    } else {
        assert.equal(receipt.optionalNativeAddon, 'absent');
        assert.match(receipt.loaderProvenanceSHA256, hashPattern);
    }
    const retained = new Set(
        receipt.cases.flatMap((item) => item.evidence.map((entry) => entry.sha256)),
    );
    for (const reference of [
        receipt.reviewedPolicySHA256,
        receipt.runtimeProfileSHA256,
        receipt.normalGC.receiptSHA256,
        receipt.forcedGC.receiptSHA256,
        ...(expected.scope === 'web' ? [] : [receipt.loaderProvenanceSHA256]),
    ])
        assert.ok(
            retained.has(reference),
            'Referenced policy/runtime/soak evidence is not retained.',
        );
    return receipt;
}
function sameContext(actual, expected) {
    for (const key of ['version', 'sourceCommit', 'sourceTree'])
        assert.equal(
            actual[key],
            expected[key],
            'Qualification ' + key + ' differs from final source.',
        );
    assert.match(actual.sourceCommit, commitPattern);
    assert.match(actual.sourceTree, commitPattern);
}
function identity(actual, expected) {
    assert.equal(actual.platform, expected.platform);
    assert.equal(actual.arch, expected.arch);
    assert.equal(typeof actual.osRelease, 'string');
    assert.ok(actual.osRelease.length > 0 && actual.osRelease.length < 256);
    assert.match(actual.node, /^24\./, 'Use the qualified Node24 observer runtime.');
    assert.match(actual.executableSHA256, hashPattern);
    const nativePath = expected.platform === 'win32' ? path.win32 : path.posix;
    assert.ok(
        nativePath.isAbsolute(actual.executable),
        'Actual observer executable path is required.',
    );
}
export function validateArtifactRecords(actual, expected) {
    assert.ok(Array.isArray(actual));
    assert.deepEqual(
        actual.map((item) => item.name).sort(),
        expected.map((item) => item.name).sort(),
        'Missing, duplicate or foreign qualified artifact.',
    );
    for (const wanted of expected) {
        const item = actual.find((candidate) => candidate.name === wanted.name);
        assert.deepEqual(
            item,
            wanted,
            'Artifact bytes differ from native qualification: ' + wanted.name,
        );
        assert.match(item.sha256, hashPattern);
        assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 0);
    }
}
export function validateCases(cases, required) {
    assert.ok(Array.isArray(cases));
    assert.deepEqual(
        cases.map((item) => item.id).sort(),
        [...required].sort(),
        'Required native cases are missing, duplicated or substituted.',
    );
    for (const item of cases) {
        assert.equal(
            item.status,
            'passed',
            'Unrun, unsupported, skipped or failed cases block publication.',
        );
        assert.equal(item.exitCode, 0);
        assert.equal(item.signal, null, 'A signalled or unknown exit is not a pass.');
        assert.ok(
            Array.isArray(item.command) &&
                item.command.length > 0 &&
                item.command.every((part) => typeof part === 'string' && part.length > 0),
        );
        assert.ok(
            Array.isArray(item.evidence) && item.evidence.length > 0,
            'A success label without evidence is not qualification.',
        );
        for (const evidence of item.evidence) {
            assert.equal(typeof evidence.path, 'string');
            assert.ok(
                evidence.path.length > 0 &&
                    !path.win32.isAbsolute(evidence.path) &&
                    !path.posix.isAbsolute(evidence.path) &&
                    !evidence.path.split(/[\\/]/).includes('..'),
            );
            assert.match(evidence.sha256, hashPattern);
            assert.ok(Number.isSafeInteger(evidence.bytes) && evidence.bytes > 0);
        }
    }
}
export function validateInstallerReceipt(receipt, expected) {
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, 'native-installer-lifecycle');
    assert.equal(receipt.status, 'passed');
    sameContext(receipt, expected);
    const lane = laneDefinition(expected.lane);
    assert.equal(receipt.lane, lane.id);
    identity(receipt.runtime, lane);
    validateArtifactRecords(receipt.artifacts, expected.artifacts);
    validateCases(receipt.cases, installerCases(lane.id));
    assert.ok(
        receipt.review &&
            typeof receipt.review.reviewer === 'string' &&
            receipt.review.reviewer.trim().length > 0,
        'Independent installer review is required.',
    );
    assert.ok(Number.isFinite(Date.parse(receipt.review.reviewedAt)));
    return receipt;
}
export function validatePlatformReceipt(receipt, expected) {
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, 'staged-native-consumer');
    assert.equal(receipt.status, 'passed');
    sameContext(receipt, expected);
    assert.equal(receipt.lane, expected.lane);
    const lane = laneDefinition(expected.lane);
    identity(receipt.runtime, lane);
    assert.equal(receipt.runId, expected.runId, 'Receipts must come from this publication run.');
    assert.equal(
        receipt.runAttempt,
        expected.runAttempt,
        'A previous attempt cannot qualify rebuilt bytes.',
    );
    validateArtifactRecords(receipt.artifacts, expected.artifacts);
    validateCases(receipt.cases, consumerCases(lane.id));
    assert.ok(
        Array.isArray(receipt.applications) &&
            receipt.applications.length === (lane.platform === 'linux' ? 2 : 1),
    );
    const applicationAssets =
        lane.platform === 'linux'
            ? ['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz']
            : lane.platform === 'win32'
              ? ['Diagnostic-Hub.exe']
              : [`Diagnostic-Hub-macos-${lane.arch}.zip`];
    assert.deepEqual(
        receipt.applications.map((app) => app.asset).sort(),
        applicationAssets.sort(),
        'Every staged application must have its own actual runtime identity.',
    );
    for (const app of receipt.applications) {
        assert.equal(app.packaged, true, 'Development bundles cannot qualify staged assets.');
        assert.equal(app.version, expected.version);
        assert.equal(app.platform, lane.platform);
        assert.equal(app.arch, lane.arch);
        assert.match(app.executableSHA256, hashPattern);
        assert.match(app.asarSHA256, hashPattern);
        assert.match(app.versions.electron, /^44\.5\.1$/);
        assert.match(app.versions.node, /^24\./);
        assert.ok(typeof app.versions.chrome === 'string' && app.versions.chrome.length > 0);
        assert.equal(app.sandbox, true);
    }
    for (const item of receipt.cases.filter((entry) => entry.id.endsWith('runtime-identity')))
        assert.ok(
            item.evidence.some((entry) => entry.path === `${lane.id}/${item.id}.json`),
            'Actual packaged runtime identity JSON is required.',
        );
    if (includesWindowsSetup(expected.version)) {
        validateInstallerReceipt(receipt.installer, expected);
        assert.match(receipt.installerReceiptSHA256, hashPattern);
        validateProducerReceipt(receipt.product, { ...expected, scope: 'desktop-' + lane.id });
        assert.match(receipt.productReceiptSHA256, hashPattern);
    }
    return receipt;
}
export async function hashFile(file, name = path.basename(file)) {
    const before = await lstat(file);
    assert.ok(
        before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
        'Qualification requires regular single-link files: ' + name,
    );
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(file)) {
        bytes += chunk.length;
        hash.update(chunk);
    }
    const after = await lstat(file);
    assert.ok(
        before.dev === after.dev &&
            before.ino === after.ino &&
            before.size === bytes &&
            after.size === bytes &&
            before.mtimeMs === after.mtimeMs &&
            before.ctimeMs === after.ctimeMs,
        'File changed during qualification: ' + name,
    );
    return { name, bytes, sha256: hash.digest('hex') };
}
export async function readBoundedJSON(file, maximum = 1024 * 1024) {
    const stat = await lstat(file);
    assert.ok(
        stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum,
        'Invalid or unbounded qualification receipt.',
    );
    return JSON.parse(await readFile(file, 'utf8'));
}
export async function verifyEvidence(root, cases) {
    const base = await realpath(root);
    for (const item of cases)
        for (const evidence of item.evidence) {
            const file = path.resolve(base, evidence.path);
            const relative = path.relative(base, await realpath(file));
            assert.ok(
                relative && !relative.startsWith('..') && !path.isAbsolute(relative),
                'Evidence escapes its receipt root.',
            );
            assert.deepEqual(await hashFile(file, evidence.path), {
                name: evidence.path,
                bytes: evidence.bytes,
                sha256: evidence.sha256,
            });
        }
}
