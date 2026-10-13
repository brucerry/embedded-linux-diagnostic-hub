import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    SOURCE_RUN,
    SOURCE_TAG,
    SOURCE_SHA,
    BUILD_ARTIFACTS,
    validateRecoverySource,
} from '../scripts/lib/release-recovery.mjs';
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
