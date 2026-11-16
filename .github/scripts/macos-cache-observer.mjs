// No CLI, network, credentials, timers, filesystem or default transport. A future
// authorized owner must bind a supported bounded metadata port; fixtures are not CI.
import {
    CACHE_BRANCH,
    CACHE_REPOSITORY,
    CACHE_WORKFLOW,
    CACHE_REASONS,
    ENTRY_REASONS,
} from './macos-cache-observation.mjs';
export const CACHE_OBSERVER_LIMITS = Object.freeze({
    requests: 3,
    durationMs: 360000,
    requestTimeoutMs: 10000,
    responseBytes: 131072,
});
const active = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const id = (v) => Number.isSafeInteger(v) && v > 0;
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
function decode(response) {
    if (
        response?.status !== 200 ||
        typeof response.body !== 'string' ||
        Buffer.byteLength(response.body) > CACHE_OBSERVER_LIMITS.responseBytes
    )
        throw 0;
    return JSON.parse(response.body);
}
function classification(job, arch) {
    if (!Array.isArray(job.steps) || job.steps.length > 12) throw 0;
    const observe = job.steps.filter((s) => s.name === 'Observe fixed cache metadata');
    const reports = job.steps.filter(
        (s) => typeof s.name === 'string' && s.name.startsWith('Cache '),
    );
    if (observe.length > 1 || reports.length > 1) throw 0;
    if (job.status !== 'completed') return null;
    if (observe.length !== 1 || reports.length !== 1 || reports[0].status !== 'completed')
        return { status: 'NOT_OBSERVED', reason: 'entry-report', custody: 'NOT_OBSERVED' };
    const pattern = new RegExp(
        `^Cache ${arch} — (CACHE_METADATA_CANDIDATE|REFUSED|NOT_OBSERVED) / ([a-z-]+) / (NO_DESCRIPTOR|CLOSED|RETAINED_UNKNOWN|NOT_OBSERVED)$`,
    );
    const match = reports[0].name.match(pattern);
    if (!match) throw 0;
    const [, status, reason, custody] = match;
    if (status === 'CACHE_METADATA_CANDIDATE') {
        if (
            reason !== 'none' ||
            custody !== 'CLOSED' ||
            job.conclusion !== 'success' ||
            observe[0].status !== 'completed' ||
            observe[0].conclusion !== 'success' ||
            reports[0].conclusion !== 'success'
        )
            throw 0;
    } else {
        if (job.conclusion === 'success' || reports[0].conclusion !== 'failure') throw 0;
        if (
            status === 'REFUSED' &&
            (!CACHE_REASONS.includes(reason) ||
                custody === 'NOT_OBSERVED' ||
                observe[0].conclusion !== 'success')
        )
            throw 0;
        if (status === 'NOT_OBSERVED' && !ENTRY_REASONS.includes(reason)) throw 0;
    }
    return { status, reason, custody };
}

export function createCacheMetadataObserver(binding, ports) {
    if (
        !sha(binding?.sha) ||
        binding.ref !== CACHE_BRANCH ||
        binding.attempt !== 1 ||
        !Number.isSafeInteger(binding.startedAt) ||
        binding.startedAt < 0 ||
        typeof ports?.now !== 'function' ||
        typeof ports?.readMetadata !== 'function'
    )
        throw new Error('observer-binding');
    const source = Object.freeze({
        sha: binding.sha,
        ref: CACHE_BRANCH,
        attempt: 1,
        startedAt: binding.startedAt,
    });
    let count = 0,
        pending = false,
        closed = false,
        reason = null,
        runId = null,
        lastTime = source.startedAt;
    let requestCompletion = 'not-started';
    const jobs = new Map();
    const stop = (why) => {
        closed = true;
        reason ??= why;
    };
    function time() {
        const now = ports.now();
        if (!Number.isSafeInteger(now) || now < lastTime) {
            stop('clock');
            return null;
        }
        lastTime = now;
        if (now >= source.startedAt + CACHE_OBSERVER_LIMITS.durationMs) {
            stop('deadline');
            return null;
        }
        return now;
    }
    const state = () => ({
        sourceSHA: source.sha,
        runId,
        requests: count,
        pending,
        closed,
        reason,
        deadline: source.startedAt + CACHE_OBSERVER_LIMITS.durationMs,
        requestCompletion,
        jobs: [...jobs.values()].map((j) => ({
            ...j,
            classification: j.classification ? { ...j.classification } : null,
        })),
        nativeQualification: false,
        releaseAcceptance: false,
        resourceRetirement: 'unverified',
    });
    async function next() {
        if (closed || pending) return state();
        const now = time();
        if (closed) return state();
        if (count >= 3) {
            stop('request-limit');
            return state();
        }
        if (source.startedAt + 360000 - now < 10000) {
            stop('deadline');
            return state();
        }
        pending = true;
        count++;
        requestCompletion = 'pending';
        try {
            const response = await ports.readMetadata(
                Object.freeze({
                    kind: runId ? 'jobs' : 'runs',
                    repository: CACHE_REPOSITORY,
                    sha: source.sha,
                    ref: source.ref,
                    event: 'push',
                    attempt: 1,
                    runId,
                    timeoutMs: 10000,
                    maxBytes: 131072,
                }),
            );
            requestCompletion = response?.requestComplete === true ? 'returned' : 'unknown';
            if (requestCompletion !== 'returned') throw 0;
            if (closed) throw 0;
            const returnedAt = time();
            if (returnedAt === null) throw 0;
            if (returnedAt - now > 10000) {
                stop('request-timeout');
                throw 0;
            }
            const data = decode(response);
            if (runId === null) {
                if (
                    data.total_count !== 1 ||
                    !Array.isArray(data.workflow_runs) ||
                    data.workflow_runs.length !== 1
                )
                    throw 0;
                const r = data.workflow_runs[0];
                if (
                    !id(r.id) ||
                    r.head_sha !== source.sha ||
                    r.head_branch !== source.ref.slice(11) ||
                    r.event !== 'push' ||
                    r.run_attempt !== 1 ||
                    r.path !== CACHE_WORKFLOW ||
                    r.repository?.id !== 1405501450 ||
                    r.repository.full_name !== CACHE_REPOSITORY ||
                    r.repository.private !== false ||
                    ![...active, 'completed'].includes(r.status)
                )
                    throw 0;
                runId = r.id;
            } else {
                if (
                    !Array.isArray(data.jobs) ||
                    data.total_count !== data.jobs.length ||
                    data.jobs.length > 2
                )
                    throw 0;
                const seen = new Set();
                for (const j of data.jobs) {
                    const arch =
                        j.name === 'Cache metadata (x64)'
                            ? 'x64'
                            : j.name === 'Cache metadata (arm64)'
                              ? 'arm64'
                              : null;
                    if (
                        !arch ||
                        seen.has(arch) ||
                        !id(j.id) ||
                        j.run_id !== runId ||
                        j.run_attempt !== 1 ||
                        j.head_sha !== source.sha ||
                        ![...active, 'completed'].includes(j.status) ||
                        !Array.isArray(j.labels) ||
                        !j.labels.includes(arch === 'x64' ? 'macos-15-intel' : 'macos-15') ||
                        (jobs.has(arch) && jobs.get(arch).id !== j.id) ||
                        [...jobs.values()].some((old) => old.arch !== arch && old.id === j.id)
                    )
                        throw 0;
                    seen.add(arch);
                    const prior = jobs.get(arch);
                    if (
                        prior?.status === 'completed' &&
                        (j.status !== 'completed' || prior.conclusion !== j.conclusion)
                    )
                        throw 0;
                    const result = classification(j, arch);
                    jobs.set(arch, {
                        id: j.id,
                        arch,
                        status: j.status,
                        conclusion: j.conclusion ?? null,
                        classification: result,
                    });
                }
                if (jobs.size === 2 && [...jobs.values()].every((j) => j.status === 'completed'))
                    stop('terminal-two-jobs');
                else if (![...jobs.values()].some((j) => active.includes(j.status)))
                    stop('incomplete-jobs');
            }
        } catch {
            if (requestCompletion === 'pending') requestCompletion = 'unknown';
            stop('metadata-uncertain');
        } finally {
            pending = false;
        }
        if (!closed && count >= 3) stop('request-limit');
        return state();
    }
    return Object.freeze({
        next,
        state,
        pause: () => {
            stop('pause');
            return state();
        },
    });
}
