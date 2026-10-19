import assert from 'node:assert/strict';
import { scheduledCatalog, serialLifecycleCoverage } from './memory-product-aggregate-contract';
export function phasePlan(input: {
    samples: number;
    warmupCycles: number;
    measuredCycles: number;
    viewer: boolean;
    gcMode: 'normal' | 'forced';
    extraWarmGroups?: number;
    polls?: number;
}) {
    assert(Number.isSafeInteger(input.samples) && input.samples > 0 && input.samples <= 12000);
    assert(
        Number.isSafeInteger(input.warmupCycles) &&
            input.warmupCycles >= 4 &&
            Number.isSafeInteger(input.measuredCycles) &&
            input.measuredCycles >= 100,
    );
    assert(['normal', 'forced'].includes(input.gcMode));
    const extra = input.extraWarmGroups ?? 0,
        polls = input.polls ?? 1;
    assert(
        Number.isSafeInteger(extra) &&
            extra >= 0 &&
            extra <= 256 &&
            Number.isSafeInteger(polls) &&
            polls >= 1 &&
            polls <= 501,
    );
    const names = Object.keys(serialLifecycleCoverage),
        cycles = [];
    for (const phase of ['warmup', 'measured'] as const)
        for (
            let ordinal = 0;
            ordinal < (phase === 'warmup' ? input.warmupCycles : input.measuredCycles);
            ordinal++
        ) {
            const catalogMode = ordinal % 2 ? 'growing' : 'constant';
            cycles.push({
                phase,
                ordinal,
                catalogMode,
                catalogRecords: scheduledCatalog(ordinal, catalogMode),
                crossPage: ordinal % 8 === 0,
                crossPageRecords: ordinal % 8 === 0 ? 21 : 1,
                lifecycle: names[ordinal % names.length],
                ssh: [
                    'stream',
                    'manual-pty',
                    ...(ordinal % 4 === 2 ? ['server-loss-rearm'] : []),
                    ...(ordinal % 4 === 3 ? ['client-reload-rearm'] : []),
                ],
                viewerFormats: input.viewer ? ['svg', 'png', 'pdf'] : [],
                heldViewer: ordinal % 8 === 0,
                viewer: input.viewer,
                checkpoints: 3,
                extraWarmCheckpoints: phase === 'measured' && ordinal === 0 ? extra * 3 : 0,
                forceGc: input.gcMode === 'forced',
                polls,
            });
        }
    const checkpointSamples = cycles.reduce(
        (sum, c) => sum + c.checkpoints + c.extraWarmCheckpoints,
        0,
    );
    assert(
        checkpointSamples <= input.samples,
        'Phase checkpoint count exceeds total sample ceiling',
    );
    const regular = input.samples - checkpointSamples;
    const perCycle = cycles.map(
        (_, i) => Math.floor(regular / cycles.length) + (i < regular % cycles.length ? 1 : 0),
    );
    return {
        input,
        cycles: cycles.map((c, i) => ({ ...c, regularSamples: perCycle[i] })),
        checkpointSamples,
        regularSamples: regular,
        totalSamples: input.samples,
        meaning:
            'Capacity-only source-derived schedule. Counts do not predict host cadence or certify elapsed warmup/measurement/deadline conditions.',
    };
}
