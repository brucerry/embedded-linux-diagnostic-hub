import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    SOURCE_RUN,
    SOURCE_TAG,
    SOURCE_SHA,
    BUILD_ARTIFACTS,
    validateRecoverySource,
    MAC_SOURCE_RUN,
    MAC_TOOLING_SHA,
    MAC_DRAFT_ID,
    REUSED_MAC_ASSETS,
    validateReusedMacInventory,
    validateReusedMacQualification,
} from '../scripts/lib/release-recovery.mjs';

test('reused Mac inventory pins original draft, asset IDs, sizes and upload digests', () => {
    const draft = {
        id: MAC_DRAFT_ID,
        draft: true,
        tag_name: SOURCE_TAG,
        target_commitish: SOURCE_SHA,
        assets: REUSED_MAC_ASSETS.map((asset) => ({ ...asset, digest: 'sha256:' + asset.sha256 })),
    };
    validateReusedMacInventory(draft);
    for (const changed of [{ id: 1 }, { draft: false }, { target_commitish: 'b'.repeat(40) }])
        assert.throws(() => validateReusedMacInventory({ ...draft, ...changed }));
    for (const changed of [{ id: 1 }, { size: 1 }, { digest: 'sha256:' + 'b'.repeat(64) }])
        assert.throws(() =>
            validateReusedMacInventory({
                ...draft,
                assets: [{ ...draft.assets[0], ...changed }, ...draft.assets.slice(1)],
            }),
        );
    assert.throws(() => validateReusedMacInventory({ ...draft, assets: draft.assets.slice(1) }));
});
test('reused native qualification requires both successful app composites at the pinned tooling source', () => {
    const run = {
        id: MAC_SOURCE_RUN,
        head_sha: MAC_TOOLING_SHA,
        head_branch: 'main',
        event: 'push',
        name: 'Recover verified v0.4.0 publication',
        status: 'completed',
        conclusion: 'failure',
    };
    const jobs: Array<{
        id?: number;
        name: string;
        status?: string;
        conclusion: string;
        steps?: { name: string; conclusion: string }[];
    }> = [
        {
            id: 115134646145,
            name: 'macos / build (arm64)',
            status: 'completed',
            conclusion: 'failure',
            steps: [
                { name: 'Run ./.github/actions/macos-build', conclusion: 'success' },
                {
                    name: 'Stage only this architecture in the guarded private draft',
                    conclusion: 'failure',
                },
            ],
        },
        {
            id: 115134646165,
            name: 'macos / build (x64)',
            status: 'completed',
            conclusion: 'success',
            steps: [{ name: 'Run ./.github/actions/macos-build', conclusion: 'success' }],
        },
        ...['version', 'draft'].map((name) => ({ name, conclusion: 'success' })),
        ...['publish', 'published-macos'].map((name) => ({ name, conclusion: 'skipped' })),
    ];
    assert.equal(validateReusedMacQualification(run, jobs).app, SOURCE_SHA);
    assert.throws(() => validateReusedMacQualification({ ...run, head_sha: 'b'.repeat(40) }, jobs));
    jobs[0].steps![0].conclusion = 'failure';
    assert.throws(() => validateReusedMacQualification(run, jobs));
});

function fixture() {
    const run = {
        id: SOURCE_RUN,
        head_sha: SOURCE_SHA,
        head_branch: SOURCE_TAG,
        event: 'push',
        name: 'Publish verified release',
        status: 'completed',
        conclusion: 'failure',
    };
    const jobs = [
        ...['version', 'draft', 'website / build', 'desktop / build', 'linux / build'],
        ...Array.from({ length: 7 }, (_, i) => 'linux / gnome (' + i + ')'),
    ].map((name) => ({
        name,
        status: 'completed',
        conclusion: 'success',
        steps: [] as { name: string; conclusion: string }[],
    }));
    for (const arch of ['x64', 'arm64'])
        jobs.push({
            name: 'macos / build (' + arch + ')',
            status: 'completed',
            conclusion: 'failure',
            steps: [
                { name: 'Run ./.github/actions/macos-build', conclusion: 'success' },
                {
                    name: 'Stage only this architecture in the guarded private draft',
                    conclusion: 'failure',
                },
            ],
        });
    for (const name of ['publish', 'published-macos'])
        jobs.push({ name, status: 'completed', conclusion: 'skipped', steps: [] });
    const artifacts = BUILD_ARTIFACTS.map((name) => ({
        name,
        expired: false,
        digest: 'sha256:' + 'a'.repeat(64),
        workflow_run: { id: SOURCE_RUN, head_sha: SOURCE_SHA },
    }));
    return { run, jobs, artifacts };
}
test('recovery accepts only exact-source successful existing gates and the diagnosed staging failure', () => {
    const data = fixture();
    assert.equal(validateRecoverySource(data.run, data.jobs, data.artifacts).nonMacTagGates, 12);
    for (const field of ['head_sha', 'head_branch', 'name', 'event'])
        assert.throws(() =>
            validateRecoverySource(
                { ...data.run, [field]: 'unrelated' },
                data.jobs,
                data.artifacts,
            ),
        );
    data.jobs[0].conclusion = 'failure';
    assert.throws(() => validateRecoverySource(data.run, data.jobs, data.artifacts));
});
test('recovery cannot reuse expired, missing, altered-source artifacts or bypass a native qualification failure', () => {
    for (const change of [
        { expired: true },
        { workflow_run: { id: SOURCE_RUN, head_sha: 'b'.repeat(40) } },
        { digest: 'unknown' },
    ]) {
        const data = fixture();
        Object.assign(data.artifacts[0], change);
        assert.throws(() => validateRecoverySource(data.run, data.jobs, data.artifacts));
    }
    const data = fixture();
    data.jobs.find((job) => job.name.includes('arm64'))!.steps[0].conclusion = 'failure';
    assert.throws(() => validateRecoverySource(data.run, data.jobs, data.artifacts));
});
