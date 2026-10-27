/** Impossible runtime identities and tiny numbers: schema fixtures, never an approved policy. */
import { fastProtocol, type FastIdentity } from './memory-fast-identity';
import { sha256 } from './memory-resource-identity';
import { retained } from './memory-resource-core';

export function mockFastIdentity(): FastIdentity {
    return {
        schema: 1,
        protocol: fastProtocol,
        files: Object.fromEntries(
            [
                'collector',
                'driver',
                'evidence',
                'identity',
                'invocation',
                'lifecycle',
                'negative',
                'owner',
                'policy',
                'receipt',
            ].map((k) => [k, 'b'.repeat(64)]),
        ),
        ssh: {
            id: 'c'.repeat(64),
            manifestSHA256: 'd'.repeat(64),
            files: { 'preload.cjs': 'e'.repeat(64), 'ssh2.cjs': 'f'.repeat(64) },
        },
        observer: 'sampled',
        launchInputs: { '/fixture-only/preload.cjs': 'e'.repeat(64) },
    };
}
export const mockLife = (code = 0) => ({
    pid: 42,
    spawnObserved: true,
    exitObserved: true,
    closeObserved: true,
    code,
    signal: null,
    closeCode: code,
    closeSignal: null,
    error: null,
    timedOut: false,
});
export const mockMemory = (heapUsed = 100, arrayBuffers = 100) => ({
    heapUsed,
    arrayBuffers,
    heapTotal: 100,
    external: 100,
    rss: 100,
});
export function collectionFixture(control = 'none') {
    const config = {
        node: 'mock',
        platform: 'test',
        arch: 'fixture',
        runtimeIdentity: { fixtureOnly: true },
        observerMode: 'sampled',
        gcMode: 'forced-diagnostic',
        payloadBytes: 1048576,
        sourceSHA256: 'a'.repeat(64),
        profile: 'fast',
        control,
        warmup: 3,
        measured: 12,
        contract: mockFastIdentity(),
    };
    // The true flag is confined to an impossible in-memory test identity, not staged policy metadata.
    const { control: _control, warmup: _warmup, measured: _measured, ...policyConfig } = config;
    const policy = {
        ...policyConfig,
        reviewed: true,
        runtime: 'test/fixture/mock',
        cleanRuns: Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(64, '0')),
        ceilings: { heapUsed: 10, arrayBuffers: 10 },
    };
    const json = JSON.stringify(policy),
        policySHA256 = sha256(json),
        rows: any[] = [
            {
                stage: 'identity',
                data: { ...config, configSHA256: sha256(JSON.stringify(config)) },
            },
        ];
    const checkpoint = (stage: string, cycle = -1) => {
        for (const gc of ['unforced', 'forced-first', 'forced-second'])
            rows.push({ stage, data: { cycle, gc, ...mockMemory() } });
    };
    const cycle = (phase: string, index: number) => {
        const emit = (stage: string, detail?: any) =>
            rows.push({
                stage,
                data: { phase, cycle: index, gc: 'unforced', ...mockMemory(), detail },
            });
        emit('work', { scenario: 'success', capturedBytes: 1 });
        for (const format of ['json', 'csv', 'markdown', 'text'])
            emit('export', { format, sha256: 'a'.repeat(64) });
        for (const scenario of ['cancel', 'quota-begin', 'quota-append'])
            emit('work', { scenario, capturedBytes: 1 });
        for (const stage of ['before-store-close', 'after-store-close', 'after-teardown']) {
            emit(
                stage,
                stage === 'after-teardown'
                    ? {
                          owners: [],
                          diskRecords: 0,
                          capturedBytes: 1,
                          exportedBytes: 4,
                          cache: 'closed; catalog removed; canonical captures explicitly cleared',
                      }
                    : undefined,
            );
            checkpoint(`${phase}-${stage}`, index);
        }
    };
    checkpoint('startup');
    for (let i = 0; i < 3; i++) cycle('warmup', i);
    checkpoint('warmed-baseline');
    for (let i = 0; i < 12; i++) {
        cycle('measured', i);
        checkpoint('closed-cycle', i);
    }
    let failure: string | null = null,
        retainedControls = 0;
    if (control !== 'none') {
        if (control === 'js' || control === 'buffer') {
            for (const row of rows)
                if (row.stage === 'closed-cycle' && row.data.gc === 'forced-second')
                    row.data[control === 'js' ? 'heapUsed' : 'arrayBuffers'] +=
                        (row.data.cycle + 1) * 11;
            failure = `Error: retained-${control === 'js' ? 'heapUsed' : 'arrayBuffers'}: cycle 1, delta 11, ceiling 10`;
            retainedControls = 12;
        } else {
            rows.splice(87);
            failure =
                control === 'timer'
                    ? 'AssertionError: Unreleased timer owners: [[1,"fixture timer site"]]'
                    : `Error: cycle 0: unsettled owners [{"kind":"${control}","label":"fixture","site":"fixture"}]`;
            retainedControls = control === 'pin' ? 2 : 1;
        }
        rows.push({ stage: 'failure', data: { message: failure } });
    }
    rows.push({
        stage: 'finished',
        data: {
            failure,
            retainedControls,
            policySHA256,
            contractSHA256: sha256(JSON.stringify(config.contract)),
        },
    });
    const baseline = mockMemory(),
        samples = Array.from({ length: 12 }, () => mockMemory());
    return {
        fixtureOnly: true,
        json,
        policy,
        config,
        policySHA256,
        lifecycle: mockLife(control === 'none' ? 0 : 1),
        rows,
        rss: [
            {
                pid: 42,
                startedMs: 0,
                completedMs: 2,
                latencyMs: 2,
                rssBytes: 100,
                unavailable: false,
            },
        ],
        evidenceClosed: true,
        samplerFailure: null,
        childEvidence: {
            timelineClosed: true,
            timelineSynced: true,
            policySHA256,
            contractSHA256: sha256(JSON.stringify(config.contract)),
        },
        childLog: failure ?? '',
        ceilings: policy.ceilings,
        measurement:
            control === 'none'
                ? {
                      config,
                      policySHA256,
                      baseline,
                      samples,
                      ceilings: policy.ceilings,
                      summary: retained(baseline, samples, policy.ceilings),
                  }
                : undefined,
    };
}
