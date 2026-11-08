import { createHash } from 'node:crypto';
import { PRODUCT_SOAK_TIMING } from '../../scripts/lib/product-soak-contract.mjs';

// Authored emitter-format records only. No clocks, calibration, processes or measurements run.
export const gcHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const gcJSON = (value) => Buffer.from(JSON.stringify(value) + '\n');
export function stagedGCFixture(scope = 'gateway') {
    const files = new Map();
    /** @type {Record<string, any>} */ const summaries = {};
    /** @type {Record<string, any>} */ const contexts = {};
    /** @type {Record<string, {time:number,stage:string,data:any}[]>} */ const timelines = {};
    const lane = scope === 'web' ? 'browser' : scope.startsWith('desktop-') ? 'desktop' : 'gateway';
    for (const mode of ['normal', 'forced']) {
        const context = {
            sourceSHA256: gcHash('synthetic-source'),
            adapterHash: gcHash('synthetic-adapter'),
            versions: { node: 'synthetic' },
            harness: { qualification: false },
            scope: { roles: ['synthetic'], unsupported: {} },
            config: {
                lane,
                gcMode: mode,
                component: false,
                warmupMs: PRODUCT_SOAK_TIMING.warmupMs,
                measuredMs: PRODUCT_SOAK_TIMING.measuredMs,
                measuredDeadlineMs: PRODUCT_SOAK_TIMING.measuredDeadlineMs,
                minCycles: PRODUCT_SOAK_TIMING.minCycles,
            },
        };
        const assessmentIdentity = gcHash(JSON.stringify(context));
        const policy = {
            reviewed: true,
            identitySHA256: assessmentIdentity,
            roles: {
                synthetic: {
                    heapUsedBytes: {
                        maxDeltaBytes: 1,
                        maxSlopeBytesPerCycle: 0,
                        calibrationRuns: Array.from({ length: 10 }, (_, i) =>
                            gcHash('synthetic-' + mode + i),
                        ),
                    },
                },
            },
        };
        const policyBytes = gcJSON(policy),
            policySHA256 = gcHash(policyBytes);
        const window = {
            schemaVersion: 1,
            clock: 'process-performance-now/v1',
            warmupStartMs: 1000,
            warmupEndMs: 301000,
            measuredStartMs: 301010,
            measuredEndMs: 2101010,
            completedCycles: 100,
        };
        const receipt = {
            status: 'passed-reviewed-memory-scope',
            failure: null,
            lane,
            gcMode: mode,
            sourceSHA256: context.sourceSHA256,
            adapterHash: context.adapterHash,
            assessmentIdentity,
            policySHA256,
            warmupCycles: 1,
            cycles: 100,
            achievedWarmupMs: 300000,
            achievedMeasuredMs: 1800000,
            totalMs: 2100100,
            measurementWindow: window,
            missing: [],
            coverage: ['synthetic-only'],
            memory: { status: 'passed-reviewed-metrics', assessmentIdentity, policySHA256 },
        };
        const rows = [],
            emit = (stage, data) => rows.push({ time: 1000000 + rows.length, stage, data });
        emit('assessment-context', {
            assessmentIdentity,
            context,
            mode: 'reviewed-policy-enforcement',
        });
        emit('quiescent-checkpoint', { phase: 'warmup', ordinal: 0 });
        emit('warmup-cycle', {});
        for (let i = 0; i < 100; i++) {
            emit('quiescent-checkpoint', { phase: 'measured', ordinal: i });
            emit('measured-cycle', { ordinal: i });
        }
        emit('measurement-window', window);
        emit('receipt', receipt);
        const timeline = Buffer.concat(rows.map(gcJSON));
        files.set(mode + '-policy.json', policyBytes);
        files.set(mode + '.jsonl', timeline);
        summaries[mode + 'GC'] = {
            status: 'passed',
            gcMode: mode,
            policySHA256,
            assessmentIdentity,
            sourceSHA256: context.sourceSHA256,
            adapterHash: context.adapterHash,
            achievedWarmupMs: 300000,
            achievedMeasuredMs: 1800000,
            totalMs: 2100100,
            completedCycles: 100,
            receiptSHA256: gcHash(timeline),
        };
        contexts[mode] = context;
        timelines[mode] = rows;
    }
    return {
        files,
        contexts,
        timelines,
        normalGC: summaries.normalGC,
        forcedGC: summaries.forcedGC,
    };
}
