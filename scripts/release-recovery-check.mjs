import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    SOURCE_TAG,
    SOURCE_SHA,
    SOURCE_RUN,
    validateRecoverySource,
} from './lib/release-recovery.mjs';
const repository = process.env.GITHUB_REPOSITORY;
assert.equal(repository, 'brucerry/embedded-linux-diagnostic-hub');
const api = 'https://api.github.com/repos/' + repository;
const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(process.env.GH_TOKEN ? { Authorization: 'Bearer ' + process.env.GH_TOKEN } : {}),
};
async function read(path) {
    const response = await fetch(api + path, { headers, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, 'Recovery evidence lookup failed: ' + response.status);
    return response.json();
}
const mode = process.argv[2];
if (mode === 'original') {
    const [run, data, artifacts] = await Promise.all([
        read('/actions/runs/' + SOURCE_RUN),
        read('/actions/runs/' + SOURCE_RUN + '/jobs?per_page=100'),
        read('/actions/runs/' + SOURCE_RUN + '/artifacts?per_page=100'),
    ]);
    const receipt = validateRecoverySource(run, data.jobs, artifacts.artifacts);
    const actual = execFileSync('git', ['rev-parse', 'refs/tags/' + SOURCE_TAG + '^{commit}'], {
        encoding: 'utf8',
    }).trim();
    assert.equal(actual, SOURCE_SHA);
    const allowed = new Set([
        'scripts/lib/release-draft.mjs',
        'scripts/release-draft.mjs',
        'scripts/lib/release-recovery.mjs',
        'scripts/release-recovery-check.mjs',
        'tests/release-draft-discovery.test.ts',
        'tests/release-recovery.test.ts',
        '.github/actions/macos-build/action.yml',
        '.github/workflows/macos-release.yml',
        '.github/workflows/release-recovery.yml',
        'docs/delivery.md',
    ]);
    const changes = execFileSync(
        'git',
        ['diff', '--name-only', SOURCE_SHA, process.env.GITHUB_SHA],
        { encoding: 'utf8' },
    )
        .trim()
        .split('\n');
    assert.ok(
        changes.every((file) => allowed.has(file)),
        'Recovery tooling must not change app/helper/version bytes: ' + changes.join(','),
    );
    console.log(JSON.stringify({ ...receipt, operationalOnlyChanges: changes }));
} else if (mode === 'tooling') {
    const source = process.env.HUB_TOOLING_SHA;
    assert.match(source, /^[a-f0-9]{40}$/);
    const names = new Map([
        ['Qualify macOS desktop (free runners)', 2],
        ['Verify and deploy website', 2],
        ['Verify and build Linux application', 8],
        ['Verify and build Windows application', 1],
    ]);
    const deadline = Date.now() + 15 * 60 * 1000;
    while (true) {
        const response = await read('/actions/runs?head_sha=' + source + '&per_page=100');
        const runs = response.workflow_runs.filter(
            (run) => run.event === 'push' && run.head_branch === 'main' && names.has(run.name),
        );
        assert.ok(runs.length <= 4, 'Duplicate operational qualification runs.');
        if (runs.some((run) => run.status === 'completed' && run.conclusion !== 'success'))
            throw Error('Operational main qualification failed; publication remains private.');
        if (runs.length === 4 && runs.every((run) => run.status === 'completed')) {
            let count = 0;
            for (const run of runs) {
                assert.equal(run.head_sha, source);
                const jobs = (await read('/actions/runs/' + run.id + '/jobs?per_page=100')).jobs;
                assert.equal(jobs.length, names.get(run.name));
                assert.ok(
                    jobs.every((job) => job.status === 'completed' && job.conclusion === 'success'),
                );
                count += jobs.length;
            }
            assert.equal(count, 13);
            console.log(
                JSON.stringify({
                    toolingSource: source,
                    all13OperationalMainJobsPassed: true,
                    appSource: SOURCE_SHA,
                }),
            );
            break;
        }
        assert.ok(Date.now() < deadline, 'Operational qualification deadline; no publication.');
        await new Promise((resolve) => setTimeout(resolve, 30000));
    }
} else throw Error('Usage: release-recovery-check.mjs original|tooling');
