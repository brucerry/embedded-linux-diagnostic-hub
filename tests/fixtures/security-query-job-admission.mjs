import { validateQueryJobTime } from '../../scripts/lib/security-query-job-admission.mjs';
import { queryRuntimeImages } from '../../scripts/lib/security-query-runtime-selection.mjs';
export const fixtureJobEnvironment = {
    ImageOS: 'win25-vs2026',
    ImageVersion: '20261007.264.1',
    RUNNER_OS: 'Windows',
    RUNNER_ARCH: 'X64',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_JOB: 'windows-security-query-only',
    RUNNER_NAME: 'controlled query admission fixture',
};
export function fixtureRuntime() {
    return {
        kind: 'exact-preinstalled-query-runtime',
        version: queryRuntimeImages[0].node,
        selection: queryRuntimeImages[0],
        fixture: true,
        installation: false,
        fallback: false,
    };
}
export async function fixtureJobTime(environment, { ownerStartedAt, now }) {
    const observed = now(),
        date = 'Tue, 20 Oct 2026 12:00:00 GMT',
        wall = Date.parse(date) + 500;
    const job = {
        id: 123,
        run_id: Number(environment.GITHUB_RUN_ID),
        run_attempt: 1,
        head_sha: environment.GITHUB_SHA,
        head_branch: environment.GITHUB_REF.slice('refs/heads/'.length),
        workflow_name: 'Verify and build Windows application',
        name: 'One Windows security metadata query (nonqualifying)',
        status: 'in_progress',
        conclusion: null,
        completed_at: null,
        runner_id: 456,
        runner_name: environment.RUNNER_NAME,
        run_url:
            'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/actions/runs/' +
            environment.GITHUB_RUN_ID,
        started_at: '2026-10-20T12:00:00Z',
    };
    return validateQueryJobTime({
        environment,
        ownerStartedAt,
        requestStartedAt: observed,
        responseObservedAt: observed,
        wallStartedAt: wall,
        wallObservedAt: wall,
        response: {
            transport: { responseComplete: true, socketClosed: true },
            status: 200,
            headers: { date, 'x-github-request-id': 'controlled-fixture' },
            body: Buffer.from(JSON.stringify({ total_count: 1, jobs: [job] })),
        },
    });
}
