import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    releaseAssets,
    releaseCatalog,
    includesWindowsSetup,
} from '../scripts/lib/release-assets.mjs';
import { publishedCatalog } from '../scripts/lib/published-release.mjs';
import {
    WINDOWS_SETUP_ASSET,
    windowsSetupInfoName,
    createWindowsSetupInfo,
} from '../scripts/lib/windows-setup-release.mjs';
import {
    PLATFORM_LANES,
    laneFiles,
    installerCases,
    consumerCases,
    digest,
    hashFile,
    validateInstallerReceipt,
    validatePlatformReceipt,
    verifyEvidence,
    producerFiles,
    producerCases,
    validateProducerReceipt,
} from '../scripts/lib/staged-artifact-gate.mjs';

const selected = {
    version: '0.6.0',
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    runId: '123',
    runAttempt: '2',
};
const evidence = [{ path: 'fixture.log', bytes: 7, sha256: digest('fixture') }];
const cases = (ids: string[]) =>
    ids.map((id) => ({
        id,
        status: 'passed',
        command: ['synthetic-model-control', id],
        exitCode: 0,
        signal: null,
        evidence: structuredClone(evidence),
    }));
function productReceipt(
    scope: string,
    artifacts: { name: string; bytes: number; sha256: string }[],
) {
    const lane =
        PLATFORM_LANES.find((item) => item.id === scope.replace(/^desktop-/, '')) ??
        PLATFORM_LANES[1];
    const boundCases = cases(producerCases(scope));
    boundCases[0].evidence.push(
        ...['a', 'b', 'c', 'd', 'e'].map((letter) => ({
            path: letter + '.json',
            bytes: 7,
            sha256: letter.repeat(64),
        })),
    );
    return {
        schemaVersion: 1,
        kind: 'staged-artifact-producer',
        status: 'passed',
        ...selected,
        scope,
        artifacts,
        runtime: {
            platform: lane.platform,
            arch: lane.arch,
            osRelease: 'synthetic OS fixture',
            node: '24.21.0',
            executable: lane.platform === 'win32' ? 'C:\\fixture\\node.exe' : '/fixture/node',
            executableSHA256: 'c'.repeat(64),
        },
        cases: boundCases,
        qualificationScope: 'full-product',
        reviewedPolicySHA256: 'a'.repeat(64),
        runtimeProfileSHA256: 'b'.repeat(64),
        normalGC: {
            status: 'passed',
            elapsedMs: 1800000,
            completedCycles: 100,
            receiptSHA256: 'c'.repeat(64),
        },
        forcedGC: {
            status: 'passed',
            elapsedMs: 1800000,
            completedCycles: 100,
            receiptSHA256: 'd'.repeat(64),
        },
        browserVersions: { chromium: 'synthetic', firefox: 'synthetic', webkit: 'synthetic' },
        optionalNativeAddon: 'absent',
        loaderProvenanceSHA256: 'e'.repeat(64),
        electronVersion: '44.5.1',
    };
}
function example(id: string) {
    const lane = PLATFORM_LANES.find((item) => item.id === id)!;
    const artifacts = laneFiles(selected.version, id).map((name: string) => ({
        name,
        bytes: 7,
        sha256: digest('fixture'),
    }));
    const runtime = {
        platform: lane.platform,
        arch: lane.arch,
        osRelease: 'synthetic OS fixture',
        node: '24.21.0',
        executable: lane.platform === 'win32' ? 'C:\\fixture\\node.exe' : '/fixture/node',
        executableSHA256: 'c'.repeat(64),
    };
    const expected = { ...selected, lane: id, artifacts };
    const installer = {
        schemaVersion: 1,
        kind: 'native-installer-lifecycle',
        status: 'passed',
        ...expected,
        runtime,
        cases: cases(installerCases(id)),
        review: { reviewer: 'synthetic-review-control', reviewedAt: '2026-10-15T00:00:00Z' },
    };
    const app = {
        packaged: true,
        version: selected.version,
        platform: lane.platform,
        arch: lane.arch,
        executableSHA256: 'd'.repeat(64),
        asarSHA256: 'e'.repeat(64),
        versions: { electron: '44.5.1', node: '24.21.0', chrome: 'fixture' },
        sandbox: true,
    };
    const assets =
        lane.platform === 'linux'
            ? ['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz']
            : lane.platform === 'win32'
              ? ['Diagnostic-Hub.exe']
              : [`Diagnostic-Hub-macos-${lane.arch}.zip`];
    const nativeCases = cases(consumerCases(id));
    for (const item of nativeCases.filter((entry) => entry.id.endsWith('runtime-identity')))
        item.evidence.push({
            path: `${lane.id}/${item.id}.json`,
            bytes: 7,
            sha256: digest('fixture'),
        });
    const receipt = {
        schemaVersion: 1,
        kind: 'staged-native-consumer',
        status: 'passed',
        ...expected,
        runtime,
        cases: nativeCases,
        installer,
        installerReceiptSHA256: 'f'.repeat(64),
        product: productReceipt('desktop-' + id, artifacts),
        productReceiptSHA256: 'f'.repeat(64),
        applications: assets.map((asset) => ({ ...app, asset })),
    };
    return { expected, installer, receipt };
}

test('v0.6 setup catalog uses the existing packager names and preserves historical catalogs', () => {
    const old = releaseAssets('0.5.2');
    assert.equal(old.length, 10);
    assert.equal(releaseCatalog('0.5.2').length, 24);
    assert.equal(includesWindowsSetup('0.5.99'), false);
    for (const version of ['0.6.0-rc.1', '0.6.0', '1.0.0']) {
        assert.ok(releaseAssets(version).includes(WINDOWS_SETUP_ASSET));
        assert.ok(releaseCatalog(version).includes(windowsSetupInfoName(WINDOWS_SETUP_ASSET)));
        assert.equal(releaseCatalog(version).length, 27);
        assert.deepEqual(publishedCatalog(version), releaseCatalog(version));
        for (const name of old.filter((name: string) => !name.includes('-0.5.2.')))
            assert.ok(releaseAssets(version).includes(name));
    }
    assert.throws(() => releaseAssets('latest'));
});

test('four native receipt contracts require exact artifact/source/runtime and complete cases', () => {
    assert.deepEqual(
        PLATFORM_LANES.map((lane) => lane.id),
        ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'],
    );
    for (const lane of PLATFORM_LANES) {
        const f = example(lane.id);
        assert.equal(validatePlatformReceipt(f.receipt, f.expected), f.receipt);
        for (const update of [
            { status: 'unsupported' },
            { sourceCommit: '0'.repeat(40) },
            { sourceTree: '0'.repeat(40) },
            { runId: '122' },
            { runAttempt: '1' },
            { artifacts: f.receipt.artifacts.slice(1) },
            { artifacts: [...f.receipt.artifacts, f.receipt.artifacts[0]] },
            { cases: f.receipt.cases.slice(1) },
            { runtime: { ...f.receipt.runtime, arch: 'ia32' } },
            { runtime: { ...f.receipt.runtime, node: '22.0.0' } },
            { applications: f.receipt.applications.map((app) => ({ ...app, packaged: false })) },
            { applications: f.receipt.applications.map((app) => ({ ...app, sandbox: false })) },
            {
                applications: f.receipt.applications.map((app) => ({
                    ...app,
                    asset: 'foreign.zip',
                })),
            },
            {
                applications: f.receipt.applications.map((app) => ({
                    ...app,
                    versions: { ...app.versions, electron: '43.0.0' },
                })),
            },
            { product: { ...f.receipt.product, qualificationScope: 'component' } },
        ])
            assert.throws(() => validatePlatformReceipt({ ...f.receipt, ...update }, f.expected));
        for (const field of ['sha256', 'bytes']) {
            const altered = structuredClone(f.receipt);
            Object.assign(altered.artifacts[0], {
                [field]: field === 'sha256' ? '0'.repeat(64) : 8,
            });
            assert.throws(() => validatePlatformReceipt(altered, f.expected));
        }
    }
});

test('skips, unsupported status, missing evidence and abnormal exits cannot qualify a required native case', () => {
    const f = example('win32-x64');
    for (const update of [
        { status: 'skipped' },
        { status: 'unrun' },
        { status: 'unsupported' },
        { status: 'failed' },
        { exitCode: 1 },
        { exitCode: null },
        { signal: 'SIGTERM' },
        { evidence: [] },
        { command: [] },
    ]) {
        const bad = structuredClone(f.receipt);
        Object.assign(bad.cases[0], update);
        assert.throws(() => validatePlatformReceipt(bad, f.expected));
    }
});

test('the publication verifier accepts each platform path convention and rejects relative executable/evidence paths', () => {
    for (const lane of PLATFORM_LANES) {
        const f = example(lane.id);
        validatePlatformReceipt(f.receipt, f.expected);
        assert.throws(() =>
            validatePlatformReceipt(
                { ...f.receipt, runtime: { ...f.receipt.runtime, executable: 'relative-node' } },
                f.expected,
            ),
        );
        for (const absolute of [
            'C:\\foreign\\evidence.log',
            '/foreign/evidence.log',
            '\\\\server\\share\\evidence.log',
        ]) {
            const bad = structuredClone(f.receipt);
            bad.cases[0].evidence[0].path = absolute;
            assert.throws(() => validatePlatformReceipt(bad, f.expected));
        }
    }
});

test('portable/model results cannot substitute for installer lifecycle or either Linux layout', () => {
    for (const lane of PLATFORM_LANES) {
        const f = example(lane.id);
        assert.equal(validateInstallerReceipt(f.installer, f.expected), f.installer);
        for (const update of [
            { kind: 'portable-smoke' },
            { status: 'unsupported' },
            { cases: cases(consumerCases(lane.id)) },
            { cases: [] },
            { review: null },
        ])
            assert.throws(() =>
                validateInstallerReceipt({ ...f.installer, ...update }, f.expected),
            );
        const bad = structuredClone(f.installer);
        bad.cases[0].status = 'skipped';
        assert.throws(() => validateInstallerReceipt(bad, f.expected));
    }
    assert.equal(installerCases('linux-x64').length, 18);
});

test('web and gateway final archive gates require actual scoped runtime and full product receipts', () => {
    for (const scope of ['web', 'gateway', ...PLATFORM_LANES.map((lane) => 'desktop-' + lane.id)]) {
        const artifacts = producerFiles(selected.version, scope).map((name: string) => ({
            name,
            bytes: 7,
            sha256: digest('fixture'),
        }));
        const expected = { ...selected, scope, artifacts };
        const receipt = productReceipt(scope, artifacts);
        assert.equal(validateProducerReceipt(receipt, expected), receipt);
        const missing = structuredClone(receipt);
        missing.cases[0].evidence = missing.cases[0].evidence.slice(0, 1);
        assert.throws(() => validateProducerReceipt(missing, expected), /not retained/);
        for (const update of [
            { qualificationScope: 'component' },
            { scope: 'foreign' },
            { status: 'unrun' },
            { reviewedPolicySHA256: '' },
            { runtimeProfileSHA256: '' },
            { cases: [] },
            { normalGC: { ...receipt.normalGC, elapsedMs: 1799999 } },
            { forcedGC: { ...receipt.forcedGC, completedCycles: 99 } },
            { forcedGC: { ...receipt.forcedGC, status: 'unsupported' } },
            ...(scope !== 'web'
                ? [{ optionalNativeAddon: 'available' }, { loaderProvenanceSHA256: '' }]
                : [{ browserVersions: {} }]),
        ])
            assert.throws(() => validateProducerReceipt({ ...receipt, ...update }, expected));
        assert.throws(() =>
            validateProducerReceipt(receipt, {
                ...expected,
                artifacts: [{ ...artifacts[0], sha256: '0'.repeat(64) }, artifacts[1]],
            }),
        );
    }
});

test('retained evidence is rehashed and escaped paths are refused', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hub-platform-evidence-'));
    try {
        await writeFile(path.join(root, 'fixture.log'), 'fixture');
        await verifyEvidence(root, cases(['fixture-case']));
        await writeFile(path.join(root, 'fixture.log'), 'changed');
        await assert.rejects(verifyEvidence(root, cases(['fixture-case'])));
        const f = example('win32-x64');
        f.receipt.cases[0].evidence[0].path = '../escape.log';
        assert.throws(() => validatePlatformReceipt(f.receipt, f.expected));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('release checker validates actual setup bytes and descriptor without installer execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hub-platform-catalog-'));
    const checker = path.resolve('scripts/verify-release.mjs');
    const commit = selected.sourceCommit;
    const check = () =>
        spawnSync(process.execPath, [checker, '--assets'], {
            cwd: root,
            env: { ...process.env, GITHUB_REF_NAME: 'v0.6.0', GITHUB_SHA: commit },
            encoding: 'utf8',
        });
    try {
        await mkdir(path.join(root, 'release'));
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.6.0' }));
        const linux: Record<string, string> = {};
        for (const name of releaseAssets('0.6.0')) {
            const bytes = Buffer.from('synthetic nonexecutable ' + name);
            await writeFile(path.join(root, 'release', name), bytes);
            await writeFile(
                path.join(root, 'release', name + '.sha256'),
                digest(bytes) + '  ' + name + '\n',
            );
            if (name.includes('linux-')) linux[name] = digest(bytes);
        }
        await writeFile(
            path.join(root, 'release/build-info.json'),
            JSON.stringify({ version: '0.6.0', commit, signature: 'NotSigned' }),
        );
        await writeFile(
            path.join(root, 'release/linux-build-info.json'),
            JSON.stringify({
                version: '0.6.0',
                commit,
                platform: 'linux',
                arch: 'x64',
                assets: linux,
            }),
        );
        for (const arch of ['x64', 'arm64']) {
            const asset = `Diagnostic-Hub-macos-${arch}.zip`;
            await writeFile(
                path.join(root, `release/macos-build-info-${arch}.json`),
                JSON.stringify({
                    platform: 'darwin',
                    arch,
                    version: '0.6.0',
                    commit,
                    asset,
                    sha256: digest(await readFile(path.join(root, 'release', asset))),
                    asarSHA256: 'c'.repeat(64),
                    bundleIdentifier: 'dev.diagnostichub.desktop',
                    minimumMacOSVersion: '13.0.0',
                    signature: 'ad-hoc',
                    adHocIntegrityVerified: true,
                    notarized: false,
                    gatekeeperDownloadedAppQualified: false,
                }),
            );
        }
        const file = path.join(root, 'release', WINDOWS_SETUP_ASSET);
        const record = await hashFile(file);
        const descriptor = path.join(root, 'release', windowsSetupInfoName(WINDOWS_SETUP_ASSET));
        const info = createWindowsSetupInfo({
            version: '0.6.0',
            commit,
            asset: WINDOWS_SETUP_ASSET,
            bytes: record.bytes,
            sha256: record.sha256,
            payloadManifestSHA256: 'd'.repeat(64),
        });
        await writeFile(descriptor, JSON.stringify(info));
        assert.equal(check().status, 0);
        await writeFile(descriptor, JSON.stringify({ ...info, commit: 'b'.repeat(40) }));
        assert.notEqual(check().status, 0);
        await writeFile(descriptor, JSON.stringify(info));
        await writeFile(file, 'mutated setup');
        assert.notEqual(check().status, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('workflow orders exact staged native gates before publication and public URL checks after it', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    assert.match(workflow, /qualify-staged:[\s\S]*needs: \[website, desktop, linux, macos\]/);
    assert.match(workflow, /publish:\s+needs:[\s\S]*?qualify-staged-producers/);
    assert.match(workflow, /published-assets:\s+needs: publish/);
    assert.match(workflow, /published-macos:\s+needs: published-assets/);
    for (const lane of PLATFORM_LANES) assert.ok(workflow.includes('lane: ' + lane.id));
    assert.ok(workflow.includes('path: validation/platform/'));
    assert.ok(!workflow.includes('continue-on-error:'));
    const publisher = await readFile('scripts/release-draft.mjs', 'utf8');
    assert.equal(
        (publisher.match(/staged-artifact-gate\.mjs/g) ?? []).length,
        2,
        'Publication rechecks receipts immediately before the final write.',
    );
});
