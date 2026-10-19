import test from 'node:test';
import assert from 'node:assert/strict';
import { phasePlan } from './fixtures/soak-phase-plan.mts';
for (const samples of [7200, 9600, 12000])
    for (const gcMode of ['normal', 'forced'] as const)
        for (const warmupCycles of [6, 12, 24])
            test(`source phase coverage ${samples}/${gcMode}/warm${warmupCycles}`, () => {
                const p = phasePlan({
                    samples,
                    warmupCycles,
                    measuredCycles: 100,
                    viewer: true,
                    gcMode,
                    extraWarmGroups: 3,
                });
                assert.equal(p.regularSamples + p.checkpointSamples, samples);
                assert.deepEqual(
                    [...new Set(p.cycles.map((c) => c.catalogRecords))].sort(),
                    [1, 2, 3],
                );
                assert.equal(new Set(p.cycles.map((c) => c.lifecycle)).size, 8);
                assert(
                    p.cycles.some((c) => c.ssh.includes('server-loss-rearm')) &&
                        p.cycles.some((c) => c.ssh.includes('client-reload-rearm')),
                );
                assert(p.cycles.filter((c) => c.heldViewer).every((c) => c.ordinal % 8 === 0));
                assert(p.cycles.every((c) => c.viewerFormats.length === 3));
                assert(p.cycles.filter((c) => c.phase === 'measured').length >= 100);
                assert(p.cycles.every((c) => c.forceGc === (gcMode === 'forced')));
            });
test('variable cycles and checkpoint extras conserve samples; invalid/deadline bypass inputs refuse', () => {
    for (const [warmupCycles, measuredCycles] of [
        [4, 100],
        [50, 150],
        [100, 200],
    ]) {
        const p = phasePlan({
            samples: 12000,
            warmupCycles,
            measuredCycles,
            viewer: false,
            gcMode: 'normal',
            polls: 501,
        });
        assert.equal(p.cycles.length, warmupCycles + measuredCycles);
        assert(p.cycles.every((c) => c.viewerFormats.length === 0));
        assert.equal(
            p.cycles.reduce(
                (n, c) => n + c.regularSamples + c.checkpoints + c.extraWarmCheckpoints,
                0,
            ),
            12000,
        );
    }
    for (const bad of [
        { samples: 12001 },
        { warmupCycles: 3 },
        { measuredCycles: 99 },
        { polls: 502 },
        { extraWarmGroups: 257 },
    ])
        assert.throws(() =>
            phasePlan({
                samples: 7200,
                warmupCycles: 6,
                measuredCycles: 100,
                viewer: true,
                gcMode: 'normal',
                ...bad,
            }),
        );
});

test('real cycle boundary includes all six pre-lifecycle exports/retirements and held Save/empty guards', async () => {
    const { partitionNativeCycleTrace } = await import('./fixtures/soak-phase-trace.mts');
    const row = (stage: string) => ({ stage, data: {} }),
        core = [
            ...Array.from({ length: 6 }, () => [
                row('actual-native-results-file'),
                row('native-artifact-retired'),
            ]).flat(),
            row('actual-native-save-control'),
            row('actual-native-save-control'),
            row('native-empty-destination-guard'),
            row('actual-product-serial-lifecycle'),
            row('aggregate-native-cycle'),
        ];
    const split = partitionNativeCycleTrace([
        row('native-renderer-build'),
        ...core,
        row('native-actual-close'),
    ]);
    assert.equal(split.startup.length, 1);
    assert.equal(split.counts.results, 6);
    assert.equal(split.counts.retirements, 6);
    assert.equal(split.counts.heldSave, 2);
    assert.equal(split.cycle[0].stage, 'actual-native-results-file');
    for (const earlier of ['actual-product-serial-geometry', 'actual-native-download']) {
        const next = partitionNativeCycleTrace([
            row('native-renderer-build'),
            row(earlier),
            ...core,
        ]);
        assert.equal(next.cycle[0].stage, earlier);
        assert.equal(next.startup.length, 1);
    }
    assert.throws(
        () =>
            partitionNativeCycleTrace([
                row('actual-product-serial-lifecycle'),
                row('aggregate-native-cycle'),
            ]),
        /boundary/,
    );
    assert.throws(
        () =>
            partitionNativeCycleTrace(core.filter((r) => r.stage !== 'actual-native-save-control')),
        /held Save/,
    );
});
