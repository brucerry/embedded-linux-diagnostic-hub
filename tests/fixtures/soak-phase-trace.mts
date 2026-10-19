import assert from 'node:assert/strict';
import { soakEvidenceContract } from '../../scripts/lib/soak-evidence.mjs';
import { losslessReportStages } from '../../scripts/lib/startup-identity-report.mjs';
export function partitionNativeCycleTrace(trace: { stage: string; data: unknown }[]) {
    const anchors = new Set([
        'actual-product-serial-geometry',
        'actual-native-download',
        'actual-native-results-file',
        'actual-native-save-control',
    ]);
    const first = trace.findIndex((row) => anchors.has(row.stage)),
        last = trace.findIndex((row) => row.stage === 'aggregate-native-cycle');
    assert(first >= 0 && last > first, 'Missing complete native cycle boundary');
    const allowed = new Set([...soakEvidenceContract.ordinaryStages, ...losslessReportStages]);
    const startup = trace.slice(0, first).filter((row) => allowed.has(row.stage));
    const cycle = trace.slice(first, last + 1).filter((row) => allowed.has(row.stage));
    const cleanup = trace
        .slice(last + 1)
        .filter((row) => soakEvidenceContract.cleanupStages.includes(row.stage));
    const count = (stage: string) => cycle.filter((row) => row.stage === stage).length;
    assert.equal(
        count('actual-native-results-file'),
        6,
        'Every observed full native cycle has six Results exports',
    );
    assert(
        count('native-artifact-retired') >= 6,
        'Every Results export retains its retirement publication',
    );
    assert.equal(
        count('actual-native-save-control'),
        2,
        'Both native held Save cases repeat per cycle',
    );
    assert.equal(
        count('native-empty-destination-guard'),
        1,
        'Empty destination guard repeats per cycle',
    );
    assert(
        !startup.some((row) => anchors.has(row.stage) || row.stage === 'native-artifact-retired'),
    );
    return {
        first,
        last,
        startup,
        cycle,
        cleanup,
        counts: {
            results: count('actual-native-results-file'),
            retirements: count('native-artifact-retired'),
            heldSave: count('actual-native-save-control'),
            emptyDestination: count('native-empty-destination-guard'),
            viewer: count('actual-native-download'),
            geometry: count('actual-product-serial-geometry'),
        },
    };
}
