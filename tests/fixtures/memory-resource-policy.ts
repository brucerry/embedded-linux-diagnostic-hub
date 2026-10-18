import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './memory-resource-identity';
import {
    requirements,
    QualificationBlocked,
    validateMemoryPolicy,
    type MemoryPolicy,
} from './memory-resource-verdict';
import type { QualificationDriver } from './memory-resource-core';
import { assertMemorySample } from './memory-resource-core';
import { validateFastIdentity, type FastIdentity } from './memory-fast-identity';
import { requireObservedClosure } from '../../scripts/lib/owned-child.mjs';

const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const calibrationProfile = (profile = 'fast') => {
    assert.ok(['fast', 'scale'].includes(profile), 'Calibration profile must be fast or scale.');
    return { profile, payloadBytes: profile === 'fast' ? 1024 ** 2 : 64 * 1024 ** 2 };
};
export type FastConfig = {
    node: string;
    platform: string;
    arch: string;
    runtimeIdentity: unknown;
    observerMode: string;
    gcMode: string;
    payloadBytes: number;
    sourceSHA256: string;
    profile: string;
    contract?: FastIdentity;
};
export function soakAssessmentConfig(input: {
    lane: string;
    gcMode: string;
    observer: string;
    viewer: boolean;
    component: boolean;
    requirements: ReturnType<typeof requirements>;
}) {
    return {
        lane: input.lane,
        gcMode: input.gcMode,
        observer: input.observer,
        warmupMs: 300000,
        measuredMs: 1500000,
        minCycles: 100,
        payloadBytes: 33 * 1024 ** 2,
        checkpointGrouping: 'catalog-mode/disk-records/process-instance/v1',
        ownership: {
            protocol: 'cancel-product-job/v1',
            budgetMs: 2400000,
            cleanupReserveMs: 60000,
        },
        shutdownObserver: {
            cadenceMs: 250,
            scope: 'owned-pid-creation-os-rss-history',
            finalJoinedSample: true,
            forceGc: false,
            retainedInNoSamplerControl: true,
        },
        viewer: input.viewer,
        component: input.component,
        requirements: input.requirements,
    };
}
export function validateDeclaredMemoryScope(scope: QualificationDriver['memoryScope']) {
    if (!scope || Object.keys(scope.unsupported).length)
        throw new QualificationBlocked('Driver memory scope is unsupported or incomplete.');
    if (
        !Array.isArray(scope.roles) ||
        !scope.roles.length ||
        new Set(scope.roles).size !== scope.roles.length ||
        !scope.roles.every((role) => typeof role === 'string' && role.trim().length)
    )
        throw new QualificationBlocked('Memory scope must declare unique retained process roles.');
    const identities = scope.runtimeIdentity as Record<
        string,
        { executablePath?: string; executableSHA256?: string; launch?: unknown }
    >;
    for (const role of scope.roles)
        if (
            !identities?.[role]?.executablePath ||
            !hash(identities[role].executableSHA256) ||
            !identities[role].launch
        )
            throw new QualificationBlocked(`Missing executable/launch identity for ${role}.`);
    return scope;
}
export function validateFastMemoryPolicy(policy: any, config: FastConfig) {
    assert.equal(policy.reviewed, true, 'Calibration must be reviewed before enforcement.');
    assert.equal(policy.runtime, `${config.platform}/${config.arch}/${config.node}`);
    validateFastIdentity(config.contract);
    assert.equal(config.contract.observer, config.observerMode);
    assert.deepEqual(
        policy.contract,
        config.contract,
        'Full fast collector/profile/protocol identity changed.',
    );
    assert.deepEqual(
        policy.runtimeIdentity,
        config.runtimeIdentity,
        'Executable hash and launch/GC environment must match calibration.',
    );
    for (const field of [
        'observerMode',
        'gcMode',
        'payloadBytes',
        'sourceSHA256',
        'profile',
    ] as const)
        assert.equal(policy[field], config[field]);
    assert.ok(
        Array.isArray(policy.cleanRuns) &&
            policy.cleanRuns.length >= 10 &&
            new Set(policy.cleanRuns).size === policy.cleanRuns.length,
    );
    assert.ok(policy.cleanRuns.every(hash));
    assert.deepEqual(Object.keys(policy.ceilings).sort(), ['arrayBuffers', 'heapUsed']);
    assert.ok(
        Object.values(policy.ceilings).every(
            (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
        ),
    );
    return policy.ceilings as { heapUsed: number; arrayBuffers: number };
}
export function parseFastPolicy(json: string, expectedSHA256: string, config: FastConfig) {
    assert.ok(hash(expectedSHA256), 'Provide the independently reviewed policy SHA256.');
    assert.equal(sha256(json), expectedSHA256, 'Reviewed policy bytes changed.');
    const policy = JSON.parse(json);
    return { policySHA256: expectedSHA256, ceilings: validateFastMemoryPolicy(policy, config) };
}
export function validateCalibrationMeasurement(
    measurement: any,
    parent: any,
    profile: string,
    sampled: boolean,
) {
    assert.equal(parent.status, 'collected-provisional-diagnostic');
    assert.equal(parent.code, 0);
    assert.equal(parent.signal, null);
    assert.equal(parent.timedOut, false);
    assert.equal(parent.samplerFailure, null);
    assert.equal(parent.childExit, 'normal-success');
    requireObservedClosure(parent.lifecycle);
    assert.equal(parent.evidenceClosed, true);
    assert.equal(parent.verdict, 'PROVISIONAL_DIAGNOSTIC');
    if (sampled)
        assert.ok(
            parent.rssEvidence?.usable > 0 &&
                Number.isSafeInteger(parent.observedPeakRSSBytes) &&
                parent.observedPeakRSSBytes >= 0,
        );
    validateFastIdentity(measurement.config.contract);
    assert.equal(measurement.config.contract.observer, sampled ? 'sampled' : 'disabled');
    assert.equal(parent.contractSHA256, sha256(JSON.stringify(measurement.config.contract)));
    assert.equal(parent.policySHA256, null);
    assert.equal(measurement.status, 'passed-provisional-diagnostic');
    assert.equal(measurement.policySHA256, null);
    assert.equal(measurement.config.control, 'none');
    assert.equal(measurement.config.warmup, 3);
    assert.equal(measurement.config.measured, 12);
    const selected = calibrationProfile(profile);
    assert.equal(measurement.config.profile, selected.profile);
    assert.equal(measurement.config.payloadBytes, selected.payloadBytes);
    assert.equal(measurement.config.gcMode, 'forced-diagnostic');
    assert.equal(measurement.config.observerMode, sampled ? 'sampled' : 'disabled');
    assert.equal(measurement.samples.length, 12);
    assertMemorySample(measurement.baseline);
    measurement.samples.forEach(assertMemorySample);
    for (const metric of ['heapUsed', 'arrayBuffers'])
        assert.ok(Number.isFinite(measurement.summary[metric].maxDelta));
}
/** Generated metadata only. Refuse source destinations, aliases and overwriting unrelated evidence. */
export async function writeQualificationMetadata(
    root: string,
    relative: string,
    bytes: string | Uint8Array,
    reuseIdentical = false,
) {
    root = await fs.realpath(root);
    const destination = path.resolve(root, relative),
        allowed = path.join(root, 'validation') + path.sep;
    assert.ok(
        destination.startsWith(allowed),
        'Qualification metadata must stay under validation/.',
    );
    let directory = root;
    for (const segment of path.relative(root, destination).split(path.sep)) {
        directory = path.join(directory, segment);
        try {
            assert.ok(
                !(await fs.lstat(directory)).isSymbolicLink(),
                'Qualification metadata refuses aliases.',
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
        await fs.writeFile(destination, bytes, { flag: 'wx' });
    } catch (error) {
        if (!reuseIdentical || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assert.equal(
            sha256(await fs.readFile(destination)),
            sha256(bytes),
            'Existing qualification bytes changed.',
        );
    }
    return destination;
}
export async function stageReviewedPolicy(input: {
    root: string;
    json: string;
    expectedSHA256: string;
    kind: 'fast' | 'soak';
    config: FastConfig;
    assessment?: {
        assessmentIdentity: string;
        context: {
            sourceSHA256: string;
            adapterHash: string;
            harness: unknown;
            scope: NonNullable<QualificationDriver['memoryScope']>;
            config: ReturnType<typeof soakAssessmentConfig>;
        };
    };
    driverSHA256?: string;
    lane?: string;
    gcMode?: string;
    viewer?: boolean;
}) {
    assert.ok(
        Buffer.byteLength(input.json) <= 256 * 1024,
        'Policy document exceeds metadata budget.',
    );
    assert.ok(hash(input.expectedSHA256), 'Provide the independently reviewed policy SHA256.');
    assert.equal(sha256(input.json), input.expectedSHA256, 'Reviewed policy bytes changed.');
    const policy = JSON.parse(input.json);
    if (input.kind === 'fast') validateFastMemoryPolicy(policy, input.config);
    else {
        const record = input.assessment;
        assert.ok(
            record,
            'Product policy needs its reviewed actual calibration assessment context.',
        );
        assert.equal(
            record.assessmentIdentity,
            sha256(JSON.stringify(record.context)),
            'Assessment context identity changed.',
        );
        assert.equal(record.context.sourceSHA256, input.config.sourceSHA256);
        assert.deepEqual(record.context.harness, input.config.runtimeIdentity);
        assert.ok(hash(input.driverSHA256));
        assert.equal(record.context.adapterHash, input.driverSHA256);
        assert.equal(
            record.context.config.component,
            false,
            'Component evidence cannot stage a product policy.',
        );
        assert.ok(input.lane && ['desktop', 'browser', 'gateway'].includes(input.lane));
        assert.ok(input.gcMode && ['normal', 'forced'].includes(input.gcMode));
        assert.deepEqual(
            record.context.config,
            soakAssessmentConfig({
                lane: input.lane,
                gcMode: input.gcMode,
                observer: input.config.observerMode === 'disabled' ? 'disabled' : '250ms',
                viewer: Boolean(input.viewer),
                component: false,
                requirements: requirements(false, [], Boolean(input.viewer)),
            }),
        );
        validateDeclaredMemoryScope(record.context.scope);
        validateMemoryPolicy(
            policy as MemoryPolicy,
            record.assessmentIdentity,
            record.context.scope.roles,
        );
    }
    const policyPath = await writeQualificationMetadata(
        input.root,
        `validation/memory-policies/${input.expectedSHA256}.json`,
        input.json,
        true,
    );
    return {
        status: 'staged-reviewed-policy-bytes',
        policyPath,
        policySHA256: input.expectedSHA256,
        sourceSHA256: input.config.sourceSHA256,
        scope: 'Metadata/identity check only; the enforcing fast child or actual product driver validates again. No workload, measurement or calibration was performed.',
    };
}
