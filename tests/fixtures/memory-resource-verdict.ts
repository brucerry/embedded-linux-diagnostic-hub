import {
    median,
    ownerKinds,
    viewerOwnerKinds,
    soakCoverage,
    viewerCoverage,
    type QualificationDriver,
} from './memory-resource-core';
import { requireObservedClosure } from '../../scripts/lib/owned-child.mjs';

export class QualificationBlocked extends Error {
    name = 'QualificationBlocked';
}
export function requirements(component: boolean, supported: string[], viewer: boolean) {
    return {
        coverage: [
            ...new Set([
                ...(component ? supported : soakCoverage),
                ...(viewer ? viewerCoverage : []),
            ]),
        ],
        owners: [...(!component ? ownerKinds : []), ...(viewer ? viewerOwnerKinds : [])],
    };
}
export type Exit = { code: number | null; signal: string | null; timedOut?: boolean };
export function childTermination(exit: Exit) {
    return exit.timedOut
        ? 'terminated-after-timeout'
        : exit.signal !== null
          ? 'signalled'
          : exit.code === 0
            ? 'normal-success'
            : exit.code === 1
              ? 'normal-failure'
              : 'unexpected-exit-code';
}
export function requireNegativeDetection(
    control: string,
    outer: Exit,
    receipt: Exit & { childExit?: string; samplerFailure?: unknown },
    log: string,
    expected: RegExp,
    expectedPolicySHA256: string | null = null,
) {
    requireObservedClosure(outer);
    requireObservedClosure((receipt as any).lifecycle);
    if (
        (receipt as any).evidenceClosed !== true ||
        (receipt as any).verdict !== 'EXPECTED_NEGATIVE_DETECTED'
    )
        throw Error(`${control}: incomplete or unrelated negative receipt.`);
    if ((receipt as any).policySHA256 !== expectedPolicySHA256)
        throw Error(`${control}: exact policy bytes were not enforced.`);
    if (outer.code !== 1 || outer.signal !== null)
        throw Error(`${control}: outer diagnostic did not exit normally with code 1.`);
    if (
        receipt.code !== 1 ||
        receipt.signal !== null ||
        receipt.timedOut !== false ||
        receipt.samplerFailure != null ||
        receipt.childExit !== 'normal-failure'
    )
        throw Error(`${control}: abnormal/unknown child exit is not leak detection.`);
    if (!expected.test(log)) throw Error(`${control}: failed for an unrelated reason.`);
}

export type ProcessSample = Awaited<ReturnType<QualificationDriver['sampleProcesses']>>[number];
export const memoryMetrics = [
    'heapUsedBytes',
    'arrayBuffersBytes',
    'externalBytes',
    'rssBytes',
] as const;
type Metric = (typeof memoryMetrics)[number];
type Budget = { maxDeltaBytes: number; maxSlopeBytesPerCycle: number; calibrationRuns: string[] };
export type MemoryPolicy = {
    reviewed: true;
    identitySHA256: string;
    roles: Record<string, Partial<Record<Metric, Budget>>>;
};
const isHash = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validateMemoryPolicy(policy: MemoryPolicy, identity: string, roles: string[]) {
    if (policy.reviewed !== true || policy.identitySHA256 !== identity)
        throw new QualificationBlocked('Reviewed memory policy identity mismatch.');
    if (
        !roles.length ||
        new Set(roles).size !== roles.length ||
        JSON.stringify(Object.keys(policy.roles).sort()) !== JSON.stringify([...roles].sort())
    )
        throw new QualificationBlocked(
            'Memory policy must cover the exact declared process roles.',
        );
    for (const [role, metrics] of Object.entries(policy.roles)) {
        if (!Object.keys(metrics).length)
            throw new QualificationBlocked(`No reviewed metrics for ${role}.`);
        for (const [metric, budget] of Object.entries(metrics)) {
            if (
                !memoryMetrics.includes(metric as Metric) ||
                !budget ||
                !Number.isFinite(budget.maxDeltaBytes) ||
                budget.maxDeltaBytes < 0 ||
                !Number.isFinite(budget.maxSlopeBytesPerCycle) ||
                budget.maxSlopeBytesPerCycle < 0 ||
                !Array.isArray(budget.calibrationRuns) ||
                budget.calibrationRuns.length < 10 ||
                !budget.calibrationRuns.every(isHash) ||
                new Set(budget.calibrationRuns).size !== budget.calibrationRuns.length
            )
                throw new QualificationBlocked(`Uncalibrated memory budget ${role}/${metric}.`);
        }
    }
}
export function validateProcessSample(sample: ProcessSample) {
    if (
        !Number.isSafeInteger(sample.pid) ||
        sample.pid <= 0 ||
        typeof sample.created !== 'string' ||
        !sample.created ||
        typeof sample.role !== 'string' ||
        !sample.role ||
        !['running', 'terminated'].includes(sample.state)
    )
        throw Error('Invalid/unknown process identity or liveness.');
    for (const metric of memoryMetrics) {
        const value = sample[metric];
        if (
            sample.state === 'terminated'
                ? value !== null
                : value !== null && (!Number.isSafeInteger(value) || value < 0)
        )
            throw Error(`Invalid ${metric} for ${sample.pid}/${sample.created}.`);
        if (sample.state === 'running' && value === null && !sample.unsupported.length)
            throw new QualificationBlocked(`Unavailable ${metric} lacks an explicit reason.`);
    }
}
type Stats = {
    role: string;
    metric: Metric;
    count: number;
    meanX: number;
    meanY: number;
    sXX: number;
    sXY: number;
    first: number[];
    last: number[];
    maxDelta: number;
    baseline: number;
};
/** Only acknowledged quiescent checkpoints enter retention comparisons; peaks remain separate. */
export class MemoryAssessment {
    private warmed = new Map<string, number[]>();
    private measured = new Map<string, Stats>();
    private unqualified = new Map<string, { role: string; metric: Metric; reason: string }>();
    constructor(private policy: MemoryPolicy) {}
    private visit(
        samples: ProcessSample[],
        stateKey: string,
        visit: (key: string, value: number, budget: Budget, role: string, metric: Metric) => void,
    ) {
        if (!samples.length) throw new QualificationBlocked('No process memory checkpoints.');
        for (const sample of samples) {
            validateProcessSample(sample);
            if (sample.state !== 'running') continue;
            const budgets = this.policy.roles[sample.role];
            if (!Object.hasOwn(this.policy.roles, sample.role))
                throw new QualificationBlocked(`Unreviewed process role ${sample.role}.`);
            for (const metric of memoryMetrics)
                if (!budgets[metric]) {
                    this.unqualified.set(JSON.stringify([sample.role, metric]), {
                        role: sample.role,
                        metric,
                        reason:
                            sample[metric] === null
                                ? sample.unsupported.join('; ').slice(0, 512)
                                : 'Diagnostic only; no independently calibrated budget.',
                    });
                    if (this.unqualified.size > 1024)
                        throw new QualificationBlocked('Metric scope bound exceeded.');
                }
            for (const metric of ['heapUsedBytes', 'arrayBuffersBytes'] as const)
                if (sample[metric] !== null && !budgets[metric])
                    throw new QualificationBlocked(
                        `Available retained metric ${sample.role}/${metric} has no reviewed assessment.`,
                    );
            for (const [metric, budget] of Object.entries(budgets) as [Metric, Budget][]) {
                const value = sample[metric];
                if (value === null)
                    throw new QualificationBlocked(
                        `Required retained metric ${sample.role}/${metric} is unsupported.`,
                    );
                visit(
                    JSON.stringify([stateKey, sample.pid, sample.created, sample.role, metric]),
                    value,
                    budget,
                    sample.role,
                    metric,
                );
            }
        }
    }
    warm(samples: ProcessSample[], stateKey: string) {
        this.visit(samples, stateKey, (key, value) => {
            const values = this.warmed.get(key) ?? [];
            values.push(value);
            if (values.length > 3) values.shift();
            this.warmed.set(key, values);
            if (this.warmed.size > 1024)
                throw new QualificationBlocked('Memory checkpoint identity/state bound exceeded.');
        });
    }
    observe(samples: ProcessSample[], stateKey: string) {
        this.visit(samples, stateKey, (key, value, budget, role, metric) => {
            const warm = this.warmed.get(key);
            if (!warm || warm.length < 3)
                throw new QualificationBlocked(
                    `Missing three matched warmed checkpoints for ${key}.`,
                );
            const stats = this.measured.get(key) ?? {
                role,
                metric,
                count: 0,
                meanX: 0,
                meanY: 0,
                sXX: 0,
                sXY: 0,
                first: [],
                last: [],
                maxDelta: -Infinity,
                baseline: median(warm),
            };
            const delta = value - stats.baseline;
            if (delta > budget.maxDeltaBytes)
                throw Error(
                    `retained-memory-growth ${key}: ${delta} exceeds reviewed delta ${budget.maxDeltaBytes}.`,
                );
            const index = stats.count++,
                dx = index - stats.meanX,
                dy = value - stats.meanY;
            stats.meanX += dx / stats.count;
            stats.meanY += dy / stats.count;
            stats.sXX += dx * (index - stats.meanX);
            stats.sXY += dx * (value - stats.meanY);
            if (stats.first.length < 3) stats.first.push(value);
            stats.last.push(value);
            if (stats.last.length > 3) stats.last.shift();
            stats.maxDelta = Math.max(stats.maxDelta, delta);
            this.measured.set(key, stats);
            if (this.measured.size > 1024)
                throw new QualificationBlocked('Memory assessment bound exceeded.');
        });
    }
    finish() {
        if (!this.measured.size)
            throw new QualificationBlocked('No assessed retained-memory checkpoints.');
        for (const [role, metrics] of Object.entries(this.policy.roles))
            for (const metric of Object.keys(metrics))
                if (
                    ![...this.measured.values()].some(
                        (stats) => stats.role === role && stats.metric === metric,
                    )
                )
                    throw new QualificationBlocked(
                        `Process role/metric ${role}/${metric} was not measured.`,
                    );
        return [...this.measured].map(([key, stats]) => {
            if (stats.count < 3)
                throw new QualificationBlocked(
                    `Fewer than three comparable measured checkpoints for ${key}.`,
                );
            const n = stats.count,
                slope = stats.sXY / stats.sXX;
            if (!Number.isFinite(slope)) throw Error(`Invalid retained-memory slope for ${key}.`);
            const budget = this.policy.roles[stats.role][stats.metric]!;
            if (slope > budget.maxSlopeBytesPerCycle)
                throw Error(
                    `retained-memory-slope ${key}: ${slope} exceeds reviewed slope ${budget.maxSlopeBytesPerCycle}.`,
                );
            return {
                key,
                role: stats.role,
                metric: stats.metric,
                samples: n,
                baseline: stats.baseline,
                maxDelta: stats.maxDelta,
                firstMedian: median(stats.first),
                lastMedian: median(stats.last),
                bytesPerCycle: slope,
            };
        });
    }
    unqualifiedMetrics() {
        return [...this.unqualified.values()];
    }
}
