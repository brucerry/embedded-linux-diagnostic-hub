import assert from 'node:assert/strict';
import { macAsset, macManifest, validateMacManifest } from './macos-release.mjs';

// These identities are immutable receipts from the completed b0f94d7 native qualification.
export const MAC_SOURCE_RUN = 38348257545;
export const MAC_TOOLING_SHA = '4f88e28fedf44a50a12a8f4350265beebd54a564';
export const MAC_DRAFT_ID = 411238491;
export const MAC_ASAR_SHA = '121abd4312d7b04202ccae3d4a70cc000a05d1d33670c36e874172d3b8657356';
export const REUSED_MAC_ASSETS = [
    {
        name: macAsset('arm64'),
        id: 635950548,
        size: 134402909,
        sha256: '47acde5572112e3d4d388d73c2defd38c218633aa9ca44c8a67fba765a3dae7e',
    },
    {
        name: macAsset('arm64') + '.sha256',
        id: 635950804,
        size: 97,
        sha256: '89973b8c915b7227d2e623d9728be707eccd6fcbea8d8afdff85723517e1a1e3',
    },
    {
        name: macManifest('arm64'),
        id: 635950851,
        size: 658,
        sha256: '20d6014523dd440a633d8dbc378bfdad24bca5395907f7885150f2bfe7807f87',
    },
    {
        name: macAsset('x64'),
        id: 635958297,
        size: 140196334,
        sha256: '113cd80241977aa2ffd5243e9c6b9ed4e48231bd8c630fe01e54dffad0b3e290',
    },
    {
        name: macAsset('x64') + '.sha256',
        id: 635958534,
        size: 95,
        sha256: 'ad2328c223f003af99a70717f367bd73160cc53382ddae964eb31542f7179203',
    },
    {
        name: macManifest('x64'),
        id: 635958565,
        size: 654,
        sha256: '147b2121a7f794a30aeac4013d1f18453963e915ec54d73d4a4c1c4f4f118d31',
    },
];
export function validateReusedMacInventory(release) {
    assert.equal(release.id, MAC_DRAFT_ID);
    assert.equal(release.draft, true);
    assert.equal(release.tag_name, SOURCE_TAG);
    assert.equal(release.target_commitish, SOURCE_SHA);
    assert.equal(new Set(release.assets.map((asset) => asset.name)).size, release.assets.length);
    for (const expected of REUSED_MAC_ASSETS) {
        const asset = release.assets.find((candidate) => candidate.name === expected.name);
        assert.ok(asset, 'Missing pinned Mac asset: ' + expected.name);
        assert.equal(asset.id, expected.id);
        assert.equal(asset.size, expected.size);
        assert.equal(asset.digest, 'sha256:' + expected.sha256);
    }
    return release;
}
export function validateReusedMacFiles(files, arch) {
    const payload = REUSED_MAC_ASSETS.find((asset) => asset.name === macAsset(arch));
    assert.ok(payload);
    const sidecar = files[macAsset(arch) + '.sha256'].toString();
    assert.equal(sidecar, payload.sha256 + '  ' + payload.name + '\n');
    const manifest = JSON.parse(files[macManifest(arch)].toString());
    validateMacManifest(manifest, {
        arch,
        version: '0.4.0',
        commit: SOURCE_SHA,
        sha256: payload.sha256,
    });
    assert.equal(manifest.source, SOURCE_SHA);
    assert.equal(manifest.minimumMacOSVersion, '13.0.0');
    assert.equal(manifest.asarSHA256, MAC_ASAR_SHA);
    assert.equal(manifest.packagedSourceMatches, true);
    return manifest;
}
export function validateReusedMacQualification(run, jobs) {
    assert.equal(run.id, MAC_SOURCE_RUN);
    assert.equal(run.head_sha, MAC_TOOLING_SHA);
    assert.equal(run.head_branch, 'main');
    assert.equal(run.event, 'push');
    assert.equal(run.name, 'Recover verified v0.4.0 publication');
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'failure');
    const identities = [
        [115134646145, 'arm64', 'failure'],
        [115134646165, 'x64', 'success'],
    ];
    for (const [id, arch, conclusion] of identities) {
        const job = jobs.find((candidate) => candidate.id === id);
        assert.ok(job && job.name.startsWith('macos / build ') && job.name.includes(arch));
        assert.equal(job.status, 'completed');
        assert.equal(job.conclusion, conclusion);
        assert.ok(
            job.steps.some(
                (step) =>
                    step.name === 'Run ./.github/actions/macos-build' &&
                    step.conclusion === 'success',
            ),
        );
        assert.deepEqual(
            job.steps.filter((step) => step.conclusion === 'failure').map((step) => step.name),
            arch === 'arm64' ? ['Stage only this architecture in the guarded private draft'] : [],
        );
    }
    assert.equal(jobs.filter((job) => ['version', 'draft'].includes(job.name)).length, 2);
    assert.equal(jobs.filter((job) => ['publish', 'published-macos'].includes(job.name)).length, 2);
    assert.ok(
        jobs
            .filter((job) => ['version', 'draft'].includes(job.name))
            .every((job) => job.conclusion === 'success'),
    );
    assert.ok(
        jobs
            .filter((job) => ['publish', 'published-macos'].includes(job.name))
            .every((job) => job.conclusion === 'skipped'),
    );
    assert.equal(jobs.length, 6);
    return {
        run: MAC_SOURCE_RUN,
        tooling: MAC_TOOLING_SHA,
        app: SOURCE_SHA,
        nativeQualificationPassed: true,
        assetIdentities: REUSED_MAC_ASSETS,
    };
}

export const SOURCE_TAG = 'v0.4.0';
export const SOURCE_SHA = 'b0f94d7d49d36fecc97b87d516724280d840e727';
export const SOURCE_RUN = 38342913511;
export const BUILD_ARTIFACTS = [
    'Diagnostic-Hub-win-x64',
    'Diagnostic-Hub-linux-x64',
    'Diagnostic-Hub-web-portable',
    'Diagnostic-Hub-lab-gateway',
];
export function validateRecoverySource(run, jobs, artifacts) {
    assert.equal(run.id, SOURCE_RUN);
    assert.equal(run.head_sha, SOURCE_SHA);
    assert.equal(run.head_branch, SOURCE_TAG);
    assert.equal(run.event, 'push');
    assert.equal(run.name, 'Publish verified release');
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'failure', 'Only the diagnosed failed tag run can be recovered.');
    const required = jobs.filter(
        (job) =>
            ['version', 'draft', 'website / build', 'desktop / build', 'linux / build'].includes(
                job.name,
            ) || job.name.startsWith('linux / gnome '),
    );
    assert.equal(required.length, 12);
    assert.equal(
        new Set(required.map((job) => job.name)).size,
        12,
        'Each original gate must be distinct.',
    );
    assert.equal(required.filter((job) => job.name.startsWith('linux / gnome ')).length, 7);
    assert.ok(required.every((job) => job.status === 'completed' && job.conclusion === 'success'));
    const mac = jobs.filter((job) => job.name.startsWith('macos / build '));
    assert.equal(mac.length, 2);
    assert.ok(
        mac.some((job) => job.name.includes('arm64')) &&
            mac.some((job) => job.name.includes('x64')),
    );
    for (const job of mac) {
        assert.equal(job.conclusion, 'failure');
        assert.ok(
            job.steps.some(
                (step) =>
                    step.name === 'Run ./.github/actions/macos-build' &&
                    step.conclusion === 'success',
            ),
        );
        assert.deepEqual(
            job.steps.filter((step) => step.conclusion === 'failure').map((step) => step.name),
            ['Stage only this architecture in the guarded private draft'],
        );
    }
    const unpublished = jobs.filter((job) => ['publish', 'published-macos'].includes(job.name));
    assert.deepEqual(unpublished.map((job) => job.name).sort(), ['publish', 'published-macos']);
    assert.ok(
        unpublished.every((job) => job.status === 'completed' && job.conclusion === 'skipped'),
    );
    assert.equal(jobs.length, 16, 'Unexpected original workflow gate set.');
    for (const name of BUILD_ARTIFACTS) {
        const matching = artifacts.filter((artifact) => artifact.name === name);
        assert.equal(matching.length, 1);
        assert.equal(matching[0].expired, false);
        assert.equal(matching[0].workflow_run.head_sha, SOURCE_SHA);
        assert.equal(matching[0].workflow_run.id, SOURCE_RUN);
        assert.match(matching[0].digest, /^sha256:[a-f0-9]{64}$/);
    }
    return {
        source: SOURCE_SHA,
        tag: SOURCE_TAG,
        sourceRun: SOURCE_RUN,
        nonMacTagGates: 12,
        allSevenGnomeCases: true,
        onlyDiagnosedDraftDiscoveryFailed: true,
        artifactNames: BUILD_ARTIFACTS,
    };
}
