import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PRODUCT_SOAK_TIMING,
    SOAK_EVIDENCE_LIMITS,
    validateSoakMeasurementWindow,
    validateStagedGCModes,
    consumeStagedGCEvidence,
} from '../scripts/lib/product-soak-contract.mjs';
import {
    SUPERVISOR_TIMELINE_LIMIT,
    SUPERVISOR_LINE_LIMIT,
} from '../scripts/lib/product-supervisor-contract.mjs';
import { stagedGCFixture, gcHash, gcJSON } from './fixtures/staged-gc-evidence-memory.mjs';
import { soakAssessmentConfig, stageReviewedPolicy } from './fixtures/memory-resource-policy';
import { validateMemoryPolicy, requirements } from './fixtures/memory-resource-verdict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function fixture() {
    const f = stagedGCFixture();
    const evidence = [...f.files].map(([path, bytes]) => ({
        path,
        bytes: bytes.length,
        sha256: gcHash(bytes),
    }));
    const receipt: any = {
        schemaVersion: 2,
        scope: 'gateway',
        normalGC: f.normalGC,
        forcedGC: f.forcedGC,
        cases: [{ id: 'gateway-product-resource-qualification', evidence }],
    };
    const read = async (path: string, maximum: number) => {
        const bytes = f.files.get(path)!;
        assert.ok(bytes.length <= maximum);
        return Buffer.from(bytes);
    };
    const consume = () => consumeStagedGCEvidence(receipt, { scope: 'gateway' }, read);
    const change = (mode: 'normal' | 'forced', update: (rows: any[]) => void) => {
        const rows = structuredClone(f.timelines[mode]);
        update(rows);
        const bytes = Buffer.concat(rows.map(gcJSON));
        f.files.set(mode + '.jsonl', bytes);
        const sha256 = gcHash(bytes);
        receipt[mode + 'GC'].receiptSHA256 = sha256;
        Object.assign(
            evidence.find((row) => row.path === mode + '.jsonl')!,
            { bytes: bytes.length, sha256 },
        );
    };
    return { f, receipt, evidence, consume, change };
}
test('actual assessment configuration requires five warm-up plus thirty measured minutes and preserves ownership budget', () => {
    const config = soakAssessmentConfig({
        lane: 'gateway',
        gcMode: 'normal',
        observer: '250ms',
        viewer: false,
        component: false,
        requirements: requirements(false, [], false),
    });
    assert.equal(config.warmupMs, 300000);
    assert.equal(config.measuredMs, 1800000);
    assert.equal(config.measuredDeadlineMs, 1980000);
    assert.equal(config.minCycles, 100);
    assert.equal(config.ownership.budgetMs, 2400000);
    assert.equal(config.ownership.cleanupReserveMs, 60000);
    assert.equal(SOAK_EVIDENCE_LIMITS.timelineBytes, SUPERVISOR_TIMELINE_LIMIT);
    assert.equal(SOAK_EVIDENCE_LIMITS.lineBytes, SUPERVISOR_LINE_LIMIT);
});
test('existing policy validator rejects the other GC assessment identity', () => {
    const f = fixture(),
        normal = JSON.parse(f.f.files.get('normal-policy.json')!.toString());
    validateMemoryPolicy(normal, f.f.normalGC.assessmentIdentity, ['synthetic']);
    assert.notEqual(f.f.normalGC.assessmentIdentity, f.f.forcedGC.assessmentIdentity);
    assert.throws(
        () => validateMemoryPolicy(normal, f.f.forcedGC.assessmentIdentity, ['synthetic']),
        /identity mismatch/,
    );
});
test('actual policy staging refuses a normal policy under a forced assessment before writing metadata', async (t) => {
    const parent = await fs.realpath(os.tmpdir()),
        root = await fs.mkdtemp(path.join(parent, 'hub-gc-policy-'));
    t.after(async () => {
        assert.equal(path.dirname(root), parent);
        assert.ok(path.basename(root).startsWith('hub-gc-policy-'));
        await fs.rm(root, { recursive: true });
    });
    const scope = {
        roles: ['synthetic'],
        unsupported: {},
        runtimeIdentity: {
            synthetic: {
                executablePath: '/synthetic/node',
                executableSHA256: 'a'.repeat(64),
                launch: { synthetic: true },
            },
        },
    };
    const runtime = { synthetic: true },
        source = 'b'.repeat(64),
        adapter = 'c'.repeat(64);
    const context = (gcMode: string) => ({
        sourceSHA256: source,
        adapterHash: adapter,
        harness: runtime,
        scope,
        config: soakAssessmentConfig({
            lane: 'gateway',
            gcMode,
            observer: '250ms',
            viewer: false,
            component: false,
            requirements: requirements(false, [], false),
        }),
    });
    const normal = context('normal'),
        forced = context('forced');
    const policy = JSON.parse(stagedGCFixture().files.get('normal-policy.json')!.toString());
    policy.identitySHA256 = gcHash(JSON.stringify(normal));
    const json = JSON.stringify(policy);
    await assert.rejects(
        stageReviewedPolicy({
            root,
            json,
            expectedSHA256: gcHash(json),
            kind: 'soak',
            config: {
                node: 'v24.21.0',
                platform: 'linux',
                arch: 'x64',
                runtimeIdentity: runtime,
                observerMode: '250ms',
                gcMode: 'forced',
                payloadBytes: 1,
                sourceSHA256: source,
                profile: 'fast',
            },
            assessment: { assessmentIdentity: gcHash(JSON.stringify(forced)), context: forced },
            driverSHA256: adapter,
            lane: 'gateway',
            gcMode: 'forced',
            viewer: false,
        }),
        /identity mismatch/,
    );
    assert.deepEqual(await fs.readdir(root), []);
});
test('actual emitter-format policy and separate measured timelines bind each mode but remain unqualified', async () => {
    const f = fixture();
    validateStagedGCModes(f.receipt);
    const value = await f.consume();
    assert.equal(value.releaseAcceptance, false);
    assert.equal(value.status, 'gc-policy-measurement-consistent-unqualified');
    assert.deepEqual(
        value.observations.map((v) => [v.gcMode, v.achievedMeasuredMs]),
        [
            ['normal', 1800000],
            ['forced', 1800000],
        ],
    );
});
for (const [label, mutate] of [
    [
        'five warm-up plus twenty-five measured',
        (r: any) => {
            r.normalGC.achievedMeasuredMs = 1500000;
            r.normalGC.totalMs = 1800000;
        },
    ],
    [
        'legacy elapsed-only mode',
        (r: any) => {
            delete r.normalGC.achievedMeasuredMs;
            r.normalGC.elapsedMs = 1800000;
        },
    ],
    [
        'shared policy',
        (r: any) => {
            r.forcedGC.policySHA256 = r.normalGC.policySHA256;
        },
    ],
    [
        'shared assessment identity',
        (r: any) => {
            r.forcedGC.assessmentIdentity = r.normalGC.assessmentIdentity;
        },
    ],
    [
        'shared measurement',
        (r: any) => {
            r.forcedGC.receiptSHA256 = r.normalGC.receiptSHA256;
        },
    ],
    [
        'wrong mode',
        (r: any) => {
            r.normalGC.gcMode = 'forced';
        },
    ],
    [
        'version one',
        (r: any) => {
            r.schemaVersion = 1;
        },
    ],
    [
        'legacy shared policy field',
        (r: any) => {
            r.reviewedPolicySHA256 = r.normalGC.policySHA256;
        },
    ],
    [
        'nonfinite measured time',
        (r: any) => {
            r.normalGC.achievedMeasuredMs = Infinity;
        },
    ],
    [
        'cycles below minimum',
        (r: any) => {
            r.normalGC.completedCycles = 99;
        },
    ],
] as const)
    test('summary rejects ' + label, () => {
        const f = fixture();
        mutate(f.receipt);
        assert.throws(() => validateStagedGCModes(f.receipt));
    });
for (const [label, mutate] of [
    [
        'warmup overlap',
        (w: any) => {
            w.measuredStartMs = w.warmupStartMs;
        },
    ],
    [
        'only twenty-five measured',
        (w: any) => {
            w.measuredEndMs = w.measuredStartMs + 1500000;
        },
    ],
    [
        'wall clock',
        (w: any) => {
            w.clock = 'Date.now';
        },
    ],
    [
        'measurement beyond admission',
        (w: any) => {
            w.measuredEndMs = w.measuredStartMs + PRODUCT_SOAK_TIMING.measuredDeadlineMs + 1;
        },
    ],
] as const)
    test('window rejects ' + label, () => {
        const f = fixture();
        const w = structuredClone(
            f.f.timelines.normal.find((r) => r.stage === 'measurement-window')!.data,
        );
        mutate(w);
        assert.throws(() => validateSoakMeasurementWindow(w));
    });
for (const [label, mutate] of [
    [
        'wrong retained mode',
        (rows: any[]) => {
            rows.at(-1).data.gcMode = 'forced';
        },
    ],
    [
        'wrong retained policy',
        (rows: any[]) => {
            rows.at(-1).data.policySHA256 = 'f'.repeat(64);
        },
    ],
    [
        'unreviewed calibration',
        (rows: any[]) => {
            rows[0].data.mode = 'unreviewed-product-calibration';
        },
    ],
    [
        'old measured configuration',
        (rows: any[]) => {
            rows[0].data.context.config.measuredMs = 1500000;
        },
    ],
    [
        'component result',
        (rows: any[]) => {
            rows.at(-1).data.status = 'passed-component-reviewed-memory';
        },
    ],
    [
        'duration laundering',
        (rows: any[]) => {
            rows.at(-1).data.achievedMeasuredMs = rows.at(-1).data.totalMs;
        },
    ],
    [
        'missing window',
        (rows: any[]) => {
            rows.splice(
                rows.findIndex((r) => r.stage === 'measurement-window'),
                1,
            );
        },
    ],
    [
        'missing measured checkpoint',
        (rows: any[]) => {
            rows.splice(
                rows.findIndex(
                    (r) => r.stage === 'quiescent-checkpoint' && r.data.phase === 'measured',
                ),
                1,
            );
        },
    ],
    [
        'duplicate final receipt',
        (rows: any[]) => {
            rows.push(structuredClone(rows.at(-1)));
        },
    ],
] as const)
    test('honestly rehashed timeline rejects ' + label, async () => {
        const f = fixture();
        f.change('normal', mutate);
        await assert.rejects(f.consume());
    });
test('policy with other mode identity is rejected even when references are honestly updated', async () => {
    const f = fixture();
    const policy = JSON.parse(f.f.files.get('normal-policy.json')!.toString());
    policy.identitySHA256 = f.f.forcedGC.assessmentIdentity;
    const bytes = gcJSON(policy),
        sha256 = gcHash(bytes);
    f.f.files.set('normal-policy.json', bytes);
    f.receipt.normalGC.policySHA256 = sha256;
    Object.assign(
        f.evidence.find((row) => row.path === 'normal-policy.json')!,
        { bytes: bytes.length, sha256 },
    );
    await assert.rejects(f.consume());
});
test('parsed timeline bytes must still match the exact retained snapshot', async () => {
    const f = fixture();
    f.f.files.set('normal.jsonl', Buffer.from('changed'));
    await assert.rejects(f.consume(), /changed after retained verification/);
});
