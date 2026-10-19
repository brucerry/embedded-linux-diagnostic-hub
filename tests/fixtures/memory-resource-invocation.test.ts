import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { requirements } from './memory-resource-verdict';
import {
    median,
    argumentsOf,
    soakCoverage,
    viewerCoverage,
    ownerKinds,
    viewerOwnerKinds,
} from './memory-resource-core';
import {
    calibrationProfile,
    validateCalibrationMeasurement,
    validateFastMemoryPolicy,
    stageReviewedPolicy,
    writeQualificationMetadata,
    type FastConfig,
    soakAssessmentConfig,
} from './memory-resource-policy';
import { sha256 } from './memory-resource-identity';
import { mockFastIdentity, mockLife, mockMemory } from './memory-fast-test-input';

// Schema-only fixtures. These identities can never match an actual Node/source gate.
const config: FastConfig = {
    node: 'mock',
    platform: 'test',
    arch: 'fixture',
    runtimeIdentity: { executableSHA256: 'b'.repeat(64), execArgv: ['mock-flags'] },
    observerMode: 'sampled',
    gcMode: 'forced-diagnostic',
    payloadBytes: 1024 ** 2,
    sourceSHA256: 'a'.repeat(64),
    profile: 'fast',
    contract: mockFastIdentity(),
};
const hashes = Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(64, '0'));
const fastPolicy = () => ({
    reviewed: true,
    slopeUnit: 'bytes-per-comparable-checkpoint',
    runtime: 'test/fixture/mock',
    ...config,
    cleanRuns: hashes,
    ceilings: { heapUsed: 1, arrayBuffers: 1 },
});
async function privateRoot() {
    const base = path.resolve('validation/invocation-tests');
    await fs.mkdir(base, { recursive: true });
    return fs.mkdtemp(path.join(base, 'run-'));
}

test('fast/scale calibration profiles and shared policy validator keep exact payload/runtime/source identity', () => {
    assert.equal(calibrationProfile().payloadBytes, 1024 ** 2);
    assert.equal(calibrationProfile('scale').payloadBytes, 64 * 1024 ** 2);
    assert.throws(() => calibrationProfile('unknown'));
    validateFastMemoryPolicy(fastPolicy(), config);
    for (const field of [
        'sourceSHA256',
        'runtimeIdentity',
        'observerMode',
        'gcMode',
        'payloadBytes',
        'profile',
    ] as const)
        assert.throws(() =>
            validateFastMemoryPolicy({ ...fastPolicy(), [field]: 'wrong' }, config),
        );
    assert.throws(() => validateFastMemoryPolicy({ ...fastPolicy(), reviewed: false }, config));
    assert.throws(() =>
        validateFastMemoryPolicy({ ...fastPolicy(), cleanRuns: hashes.slice(1) }, config),
    );
});

test('calibration input rejects signal, timeout, sampler, profile and incomplete-receipt failures', () => {
    const measurement = {
        status: 'passed-provisional-diagnostic',
        policySHA256: null,
        config: {
            control: 'none',
            warmup: 3,
            measured: 12,
            ...calibrationProfile('fast'),
            gcMode: 'forced-diagnostic',
            observerMode: 'sampled',
            contract: mockFastIdentity(),
        },
        baseline: mockMemory(),
        samples: Array.from({ length: 12 }, () => mockMemory()),
        summary: { heapUsed: { maxDelta: 0 }, arrayBuffers: { maxDelta: 0 } },
    };
    const parent = {
        status: 'collected-provisional-diagnostic',
        code: 0,
        signal: null,
        timedOut: false,
        samplerFailure: null,
        childExit: 'normal-success',
        lifecycle: mockLife(),
        evidenceClosed: true,
        verdict: 'PROVISIONAL_DIAGNOSTIC',
        rssEvidence: { usable: 1 },
        observedPeakRSSBytes: 100,
        contractSHA256: sha256(JSON.stringify(mockFastIdentity())),
        policySHA256: null,
    };
    validateCalibrationMeasurement(measurement, parent, 'fast', true);
    for (const change of [
        { signal: 'SIGTERM' },
        { timedOut: true },
        { samplerFailure: 'fixture failure' },
        { code: 1 },
        { childExit: 'signal' },
    ])
        assert.throws(() =>
            validateCalibrationMeasurement(measurement, { ...parent, ...change }, 'fast', true),
        );
    assert.throws(() => validateCalibrationMeasurement(measurement, parent, 'scale', true));
    assert.throws(() => validateCalibrationMeasurement(measurement, parent, 'fast', false));
    assert.throws(() =>
        validateCalibrationMeasurement({ ...measurement, samples: [] }, parent, 'fast', true),
    );
    assert.throws(() =>
        validateCalibrationMeasurement(
            { ...measurement, policySHA256: 'a'.repeat(64) },
            parent,
            'fast',
            true,
        ),
    );
});

test('qualification matrix matches the enforcing coverage and exact owner contracts', async () => {
    const matrix = JSON.parse(await fs.readFile('docs/memory-qualification-matrix.json', 'utf8'));
    assert.deepEqual(matrix.requiredCoverage, [...soakCoverage]);
    assert.deepEqual(matrix.viewerCoverage, [...viewerCoverage]);
    assert.deepEqual(matrix.requiredOwners, [...ownerKinds]);
    assert.deepEqual(matrix.viewerOwners, [...viewerOwnerKinds]);
    assert.equal(matrix.lanes.length, 8);
    assert.ok(matrix.commands.productCalibration.includes('--calibration=1'));
    assert.ok(
        !matrix.commands.productCalibration.some((arg: string) => arg.startsWith('--component')),
    );
    assert.ok(matrix.commands.negativeControls.some((arg: string) => arg.startsWith('--policy=')));
});

test('externally reviewed policy byte staging is content addressed, source excluded and immutable on reuse', async () => {
    const root = await privateRoot(),
        json = JSON.stringify(fastPolicy()),
        expectedSHA256 = sha256(json);
    await assert.rejects(
        stageReviewedPolicy({ root, json, expectedSHA256: 'f'.repeat(64), kind: 'fast', config }),
        /bytes changed/,
    );
    await assert.rejects(fs.stat(path.join(root, 'validation')), { code: 'ENOENT' });
    const result = await stageReviewedPolicy({ root, json, expectedSHA256, kind: 'fast', config });
    assert.ok(result.policyPath.startsWith(path.join(root, 'validation') + path.sep));
    assert.equal(await fs.readFile(result.policyPath, 'utf8'), json);
    assert.equal(
        (await stageReviewedPolicy({ root, json, expectedSHA256, kind: 'fast', config }))
            .policyPath,
        result.policyPath,
    );
    await fs.writeFile(result.policyPath, 'deliberate private tamper');
    await assert.rejects(
        stageReviewedPolicy({ root, json, expectedSHA256, kind: 'fast', config }),
        /Existing qualification bytes changed/,
    );
    await assert.rejects(
        writeQualificationMetadata(root, 'source-policy.json', json),
        /under validation/,
    );
});

test('product policy staging requires reviewed actual assessment context and never accepts component scope', async () => {
    const root = await privateRoot();
    const context = {
        sourceSHA256: config.sourceSHA256,
        adapterHash: 'd'.repeat(64),
        harness: config.runtimeIdentity,
        scope: {
            roles: ['gateway'],
            runtimeIdentity: {
                gateway: {
                    executablePath: 'mock-only',
                    executableSHA256: 'b'.repeat(64),
                    launch: { fixtureOnly: true },
                },
            },
            unsupported: {},
        },
        config: soakAssessmentConfig({
            lane: 'gateway',
            gcMode: 'normal',
            observer: '250ms',
            component: false,
            viewer: false,
            requirements: requirements(false, [], false),
        }),
    };
    const budget = {
        maxDeltaBytes: 1,
        maxSlopeBytesPerComparableCheckpoint: 1,
        calibrationRuns: hashes,
    };
    const assessment = { assessmentIdentity: sha256(JSON.stringify(context)), context };
    const json = JSON.stringify({
        reviewed: true,
        slopeUnit: 'bytes-per-comparable-checkpoint',
        identitySHA256: assessment.assessmentIdentity,
        roles: { gateway: { heapUsedBytes: budget, arrayBuffersBytes: budget } },
    });
    const input = {
        root,
        json,
        expectedSHA256: sha256(json),
        kind: 'soak' as const,
        config,
        assessment,
        driverSHA256: context.adapterHash,
        lane: 'gateway',
        gcMode: 'normal',
    };
    await stageReviewedPolicy(input);
    await assert.rejects(
        stageReviewedPolicy({ ...input, assessment: undefined }),
        /actual calibration assessment/,
    );
    await assert.rejects(stageReviewedPolicy({ ...input, driverSHA256: 'e'.repeat(64) }));
    const component = { ...context, config: { ...context.config, component: true } };
    await assert.rejects(
        stageReviewedPolicy({
            ...input,
            assessment: {
                context: component,
                assessmentIdentity: sha256(JSON.stringify(component)),
            },
        }),
        /Component evidence/,
    );
});

test('runtime inspection uses actual fast/soak Node flags without a product driver or memory sample', async () => {
    for (const target of ['fast', 'soak']) {
        const result = spawnSync(
            process.execPath,
            ['scripts/memory-runtime.mjs', '--entry=identity', '--identity-for=' + target],
            { encoding: 'utf8', windowsHide: true, timeout: 15000, env: process.env },
        );
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0);
        assert.equal(result.signal, null);
        const identity = JSON.parse(result.stdout);
        assert.equal(identity.kind, 'memory-harness-runtime-inspection');
        assert.equal(
            identity.config.runtimeIdentity.execArgv.includes('--expose-gc'),
            target === 'fast',
        );
        assert.match(identity.config.sourceSHA256, /^[a-f0-9]{64}$/);
        assert.equal(identity.sshRuntime.bindingAvailable, false);
        assert.match(identity.scope, /No product role identity, workload, memory sample/);
    }
});

test('actual calibration orchestration forwards fast/scale to twenty serialized mock runs and leaves review/ceilings unset', async () => {
    for (const profile of ['fast', 'scale']) {
        const file = path.resolve('tests/fixtures/memory-resource-calibrate.ts');
        const source = (await fs.readFile(file, 'utf8')).replaceAll(
            'import.meta.url',
            JSON.stringify(pathToFileURL(file).href),
        );
        const compiled = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText;
        const calls: string[][] = [];
        let latest: string[] = [],
            active = 0,
            draft: any;
        let finish!: () => void, fail!: (error: unknown) => void;
        const done = new Promise<void>((resolve, reject) => {
            finish = resolve;
            fail = reject;
        });
        const context = vm.createContext({
            Buffer,
            JSON,
            URL,
            process: {
                argv: ['node', file, '--out=C:/virtual', '--profile=' + profile],
                execPath: 'C:/virtual/node.exe',
                execArgv: [],
            },
            performance: { now: () => calls.length * 10 },
            console: { error: fail },
        });
        const realRequire = createRequire(import.meta.url);
        const mockRequire = (name: string): unknown => {
            if (name === './memory-resource-policy')
                return { calibrationProfile, validateCalibrationMeasurement };
            if (name === './memory-resource-core') return { median, argumentsOf };
            if (name === 'node:child_process')
                return {
                    spawn: (_exe: string, args: string[], options: any) => {
                        assert.equal(
                            JSON.stringify(options.stdio),
                            JSON.stringify(['ignore', 'inherit', 'inherit', 'ipc']),
                        );
                        const job = JSON.parse(options.env.HUB_MEMORY_JOB);
                        assert.equal(job.budgetMs, profile === 'fast' ? 120000 : 900000);
                        assert.equal(job.reserveMs, 1000);
                        assert.match(job.nonce, /^[a-f0-9-]{36}$/);
                        assert.equal(active++, 0);
                        calls.push(args);
                        latest = args;
                        const child = Object.assign(new EventEmitter(), { pid: 42 });
                        queueMicrotask(() => {
                            active--;
                            child.emit('spawn');
                            child.emit('exit', 0, null);
                            child.emit('close', 0, null);
                        });
                        return child;
                    },
                };
            if (name === 'node:fs/promises')
                return {
                    mkdir: async () => {},
                    mkdtemp: async () => 'C:/virtual/calibration',
                    readdir: async () => ['run'],
                    readFile: async (file: string) => {
                        if (file.endsWith('receipt.json'))
                            return Buffer.from(
                                JSON.stringify({
                                    status: 'collected-provisional-diagnostic',
                                    code: 0,
                                    signal: null,
                                    timedOut: false,
                                    samplerFailure: null,
                                    childExit: 'normal-success',
                                    lifecycle: mockLife(),
                                    evidenceClosed: true,
                                    verdict: 'PROVISIONAL_DIAGNOSTIC',
                                    rssEvidence: {
                                        usable: latest.includes('--no-sampler=1') ? 0 : 1,
                                    },
                                    observedPeakRSSBytes: latest.includes('--no-sampler=1')
                                        ? null
                                        : 100,
                                    policySHA256: null,
                                    contractSHA256: sha256(
                                        JSON.stringify({
                                            ...mockFastIdentity(),
                                            observer: latest.includes('--no-sampler=1')
                                                ? 'disabled'
                                                : 'sampled',
                                        }),
                                    ),
                                }),
                            );
                        const mode = latest.find((arg) => arg.startsWith('--profile='))!.slice(10);
                        return Buffer.from(
                            JSON.stringify({
                                fixtureOnly: true,
                                iteration: calls.length,
                                status: 'passed-provisional-diagnostic',
                                policySHA256: null,
                                baseline: mockMemory(),
                                samples: Array.from({ length: 12 }, () => mockMemory()),
                                config: {
                                    node: 'mock',
                                    platform: 'mock',
                                    arch: 'mock',
                                    sourceSHA256: 'a'.repeat(64),
                                    profile: mode,
                                    control: 'none',
                                    warmup: 3,
                                    measured: 12,
                                    observerMode: latest.includes('--no-sampler=1')
                                        ? 'disabled'
                                        : 'sampled',
                                    payloadBytes: calibrationProfile(mode).payloadBytes,
                                    runtimeIdentity: {},
                                    gcMode: 'forced-diagnostic',
                                    contract: {
                                        ...mockFastIdentity(),
                                        observer: latest.includes('--no-sampler=1')
                                            ? 'disabled'
                                            : 'sampled',
                                    },
                                },
                                summary: {
                                    heapUsed: { maxDelta: 0 },
                                    arrayBuffers: { maxDelta: 0 },
                                },
                            }),
                        );
                    },
                    writeFile: async (_file: string, bytes: string) => {
                        draft = JSON.parse(bytes);
                        finish();
                    },
                };
            return realRequire(name);
        };
        vm.runInContext('(function(require,module,exports){' + compiled + '\n})', context)(
            mockRequire,
            { exports: {} },
            {},
        );
        await done;
        assert.equal(calls.length, 20);
        assert.ok(
            calls.every(
                (args) => args.includes('--profile=' + profile) && args.includes('--diagnostic=1'),
            ),
        );
        assert.equal(calls.filter((args) => args.includes('--no-sampler=1')).length, 10);
        assert.equal(draft.profile, profile);
        assert.equal(draft.payloadBytes, calibrationProfile(profile).payloadBytes);
        assert.equal(draft.reviewed, false);
        assert.equal(draft.ceilings, null);
        assert.equal(new Set(draft.cleanRuns).size, 10);
        assert.equal(new Set(draft.unsampledReceiptSHA256s).size, 10);
    }
});

test('CI policy metadata failure preserves a bounded non-workload receipt', async () => {
    const root = await privateRoot(),
        output = path.join(root, 'policy-failure.json');
    const result = spawnSync(
        process.execPath,
        ['scripts/memory-runtime.mjs', '--entry=policy', '--out=' + output],
        {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 15000,
            env: { ...process.env, HUB_MEMORY_POLICY_JSON: '', HUB_MEMORY_POLICY_SHA256: '' },
        },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    const receipt = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(receipt.status, 'failed-metadata-check');
    assert.equal(receipt.workloadStarted, false);
    assert.match(receipt.firstFailure, /externally reviewed/);
});
