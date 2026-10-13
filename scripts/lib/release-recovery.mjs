import assert from 'node:assert/strict';
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
