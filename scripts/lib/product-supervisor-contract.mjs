import assert from 'node:assert/strict';
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { requireObservedClosure } from './owned-child.mjs';

export const SUPERVISOR_TIMELINE_LIMIT = 512 * 1024 ** 2;
export const SUPERVISOR_METADATA_LIMIT = 32 * 1024;
export const SUPERVISOR_LINE_LIMIT = 1024 ** 2;
const hash = /^[a-f0-9]{64}$/;
export const HARNESS_OBSERVER_LIMIT = 16 * 1024;
function text(value, maximum, empty = false) {
    assert.ok(
        typeof value === 'string' &&
            (empty || value.length > 0) &&
            value.length <= maximum &&
            !value.includes('\0'),
    );
}
function normalizedObserver(value) {
    keys(value, ['schemaVersion', 'kind', 'role', 'qualification', 'runtime']);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, 'harness-observer-runtime');
    assert.equal(value.role, 'harness-observer');
    assert.equal(value.qualification, false);
    const runtime = value.runtime;
    keys(runtime, [
        'executablePath',
        'executableSHA256',
        'node',
        'platform',
        'arch',
        'versions',
        'execArgv',
        'nodeOptions',
    ]);
    assert.ok(['linux', 'darwin', 'win32'].includes(runtime.platform));
    assert.ok(['x64', 'arm64'].includes(runtime.arch));
    text(runtime.executablePath, 4096);
    assert.ok(
        (runtime.platform === 'win32' ? path.win32 : path.posix).isAbsolute(runtime.executablePath),
    );
    assert.match(runtime.executableSHA256, hash);
    assert.match(runtime.node, /^v24\.\d+\.\d+$/);
    assert.ok(
        runtime.versions &&
            typeof runtime.versions === 'object' &&
            !Array.isArray(runtime.versions),
    );
    const versionKeys = Object.keys(runtime.versions).sort();
    assert.ok(versionKeys.length > 0 && versionKeys.length <= 64);
    assert.ok(Object.hasOwn(runtime.versions, 'node'), 'Missing own Node version.');
    for (const key of versionKeys) {
        assert.match(key, /^[A-Za-z0-9_.-]{1,64}$/);
        text(runtime.versions[key], 256);
    }
    assert.equal(runtime.versions.node, runtime.node.slice(1));
    assert.ok(Array.isArray(runtime.execArgv) && runtime.execArgv.length <= 64);
    for (const flag of runtime.execArgv) text(flag, 4096, true);
    if (runtime.nodeOptions !== null) text(runtime.nodeOptions, 8192, true);
    const result = {
        schemaVersion: 1,
        kind: 'harness-observer-runtime',
        role: 'harness-observer',
        qualification: false,
        runtime: {
            executablePath: runtime.executablePath,
            executableSHA256: runtime.executableSHA256,
            node: runtime.node,
            platform: runtime.platform,
            arch: runtime.arch,
            versions: Object.fromEntries(versionKeys.map((key) => [key, runtime.versions[key]])),
            execArgv: [...runtime.execArgv],
            nodeOptions: runtime.nodeOptions,
        },
    };
    assert.ok(
        Buffer.byteLength(JSON.stringify(result)) <= HARNESS_OBSERVER_LIMIT,
        'Harness observer metadata bound exceeded.',
    );
    return result;
}
/** Snapshot nodeRuntimeIdentity fields without dropping or rewriting flags/environment. */
export function createHarnessObserver(runtime) {
    const value = normalizedObserver({
        schemaVersion: 1,
        kind: 'harness-observer-runtime',
        role: 'harness-observer',
        qualification: false,
        runtime,
    });
    Object.freeze(value.runtime.versions);
    Object.freeze(value.runtime.execArgv);
    Object.freeze(value.runtime);
    return Object.freeze(value);
}
export function validateHarnessObserver(value, expected = value) {
    assert.equal(
        JSON.stringify(normalizedObserver(value)),
        JSON.stringify(normalizedObserver(expected)),
        'Harness observer runtime identity mismatch.',
    );
    return value;
}
export function harnessObserverSHA256(value) {
    return createHash('sha256')
        .update(JSON.stringify(normalizedObserver(value)))
        .digest('hex');
}
const bindingKeys = [
    'adapterSHA256',
    'gcMode',
    'kind',
    'jobNonce',
    'lane',
    'qualification',
    'requestedMode',
    'observerSHA256',
    'schemaVersion',
    'sourceSHA256',
    'viewer',
];
/** Producer JSON.stringify bytes only: reject duplicate keys, lossy UTF8 and alternate encodings. */
export function parseSupervisorJSON(bytes) {
    assert.ok(bytes.length > 0 && bytes.length <= SUPERVISOR_METADATA_LIMIT);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    assert.equal(text, JSON.stringify(value) + '\n', 'Noncanonical supervisor JSON bytes.');
    return value;
}
function keys(value, expected) {
    assert.ok(
        value && typeof value === 'object' && !Array.isArray(value),
        'Expected supervisor contract object.',
    );
    assert.deepEqual(
        Object.keys(value).sort(),
        [...expected].sort(),
        'Unknown or missing supervisor contract field.',
    );
}
export function validateSourceBinding(value, expected = value) {
    keys(value, bindingKeys);
    assert.equal(value.schemaVersion, 2);
    assert.equal(value.kind, 'product-supervisor-source-binding');
    assert.equal(value.qualification, false);
    assert.match(value.jobNonce, /^[a-f0-9-]{36}$/);
    assert.match(value.sourceSHA256, hash);
    assert.match(value.adapterSHA256, hash);
    assert.match(value.observerSHA256, hash);
    assert.ok(['desktop', 'browser', 'gateway'].includes(value.lane));
    assert.ok(['normal', 'forced'].includes(value.gcMode));
    assert.ok(['full-product', 'component', 'calibration'].includes(value.requestedMode));
    assert.equal(typeof value.viewer, 'boolean');
    for (const field of bindingKeys)
        assert.equal(value[field], expected[field], 'Supervisor source binding mismatch: ' + field);
    return value;
}
/** Inputs must be derived by the caller's own static reads, never from a supplied manifest. */
export function createSourceBinding({
    sourceSHA256,
    jobNonce,
    adapterSHA256,
    observerSHA256,
    lane,
    gcMode,
    viewer,
    component,
    calibration,
}) {
    for (const flag of [viewer, component, calibration]) assert.equal(typeof flag, 'boolean');
    assert.ok(!(component && calibration), 'Calibration cannot request component scope.');
    return Object.freeze(
        validateSourceBinding({
            schemaVersion: 2,
            kind: 'product-supervisor-source-binding',
            qualification: false,
            sourceSHA256,
            jobNonce,
            adapterSHA256,
            observerSHA256,
            lane,
            gcMode,
            viewer,
            requestedMode: calibration ? 'calibration' : component ? 'component' : 'full-product',
        }),
    );
}
/** Preserve existing argumentsOf presence semantics, including --viewer=0 meaning present. */
export function sourceBindingFromArguments(args, sourceSHA256, adapterSHA256, jobNonce, observer) {
    if (args.has('calibration')) {
        assert.equal(args.get('calibration'), '1');
        assert.ok(
            !args.has('component') && !args.has('memory-policy'),
            'Calibration requires full product mode and no enforcement policy.',
        );
    }
    return createSourceBinding({
        sourceSHA256,
        jobNonce,
        adapterSHA256,
        observerSHA256: harnessObserverSHA256(observer),
        lane: args.get('lane'),
        gcMode: args.get('gc') ?? 'normal',
        viewer: args.has('viewer'),
        component: args.has('component'),
        calibration: args.has('calibration'),
    });
}
export function validateSupervisorJob(value, expected = value) {
    keys(value, ['schema', 'nonce', 'budgetMs', 'reserveMs', 'deadlineMs']);
    assert.equal(value.schema, 1);
    assert.match(value.nonce, /^[a-f0-9-]{36}$/);
    assert.equal(value.budgetMs, 2400000);
    assert.equal(value.reserveMs, 60000);
    assert.ok(Number.isSafeInteger(value.deadlineMs) && value.deadlineMs >= 0);
    for (const field of ['schema', 'nonce', 'budgetMs', 'reserveMs', 'deadlineMs'])
        assert.equal(value[field], expected[field], 'Supervisor job identity mismatch: ' + field);
    return value;
}
export function validateEvidenceReference(value, name, maximum) {
    keys(value, ['name', 'bytes', 'sha256']);
    assert.equal(value.name, name, 'Foreign supervisor evidence filename.');
    assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= maximum);
    assert.match(value.sha256, hash);
    return value;
}
function sameReference(actual, expected, name, maximum) {
    validateEvidenceReference(actual, name, maximum);
    validateEvidenceReference(expected, name, maximum);
    assert.equal(actual.bytes, expected.bytes, 'Supervisor retained evidence length differs.');
    assert.equal(actual.sha256, expected.sha256, 'Supervisor retained evidence hash differs.');
}
export function validateNormalSupervisorLifecycle(value) {
    keys(value, [
        'pid',
        'spawnObserved',
        'exitObserved',
        'closeObserved',
        'code',
        'closeCode',
        'signal',
        'closeSignal',
        'error',
        'timedOut',
        'terminationRequested',
        'killErrors',
        'elapsedMs',
    ]);
    requireObservedClosure(value);
    for (const field of ['spawnObserved', 'exitObserved', 'closeObserved'])
        assert.equal(value[field], true);
    assert.equal(value.code, 0, 'Product supervisor child did not exit normally with code zero.');
    assert.equal(value.terminationRequested, false);
    assert.ok(Array.isArray(value.killErrors) && value.killErrors.length === 0);
    assert.ok(Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0);
    return value;
}
export function validateClosedChild(value, { job, binding, observer, timeline }) {
    keys(value, [
        'schemaVersion',
        'kind',
        'qualification',
        'nonce',
        'binding',
        'observer',
        'timeline',
        'ownerCompletion',
    ]);
    assert.equal(
        value.schemaVersion,
        3,
        'Only observer-bound supervisor v3 evidence is supported.',
    );
    assert.equal(value.kind, 'product-child-closed-timeline');
    assert.equal(value.qualification, false);
    validateSupervisorJob(job);
    assert.equal(
        binding.jobNonce,
        job.nonce,
        'Source binding belongs to a foreign supervisor job.',
    );
    assert.equal(value.nonce, job.nonce, 'Foreign product evidence nonce.');
    validateSourceBinding(value.binding, binding);
    validateHarnessObserver(value.observer, observer);
    assert.equal(
        binding.observerSHA256,
        harnessObserverSHA256(observer),
        'Foreign expected harness observer.',
    );
    assert.equal(value.ownerCompletion, 'not-asserted');
    sameReference(value.timeline, timeline, 'timeline.jsonl', SUPERVISOR_TIMELINE_LIMIT);
    return value;
}
/** A semantic byte/reference/context check, never product or release qualification. */
export function validateCollectedSupervisorHeader(value, { job, binding, observer }) {
    validateSupervisorJob(job);
    validateSourceBinding(binding);
    validateHarnessObserver(observer);
    assert.equal(
        binding.observerSHA256,
        harnessObserverSHA256(observer),
        'Foreign expected harness observer.',
    );
    assert.equal(
        binding.jobNonce,
        job.nonce,
        'Source binding belongs to a foreign supervisor job.',
    );
    keys(value, [
        'schemaVersion',
        'kind',
        'qualification',
        'releaseAcceptance',
        'status',
        'job',
        'binding',
        'observer',
        'lifecycle',
        'childEvidence',
        'timeline',
        'failures',
        'scope',
    ]);
    assert.equal(
        value.schemaVersion,
        3,
        'Only observer-bound supervisor v3 evidence is supported.',
    );
    assert.equal(value.kind, 'product-supervisor-observation');
    assert.equal(value.qualification, false);
    assert.equal(value.releaseAcceptance, false);
    assert.equal(value.status, 'collected-non-qualifying-supervisor-evidence');
    assert.equal(
        value.scope,
        'Observed supervisor lifecycle and closed child evidence only; no product or release verdict.',
    );
    assert.ok(Array.isArray(value.failures) && value.failures.length === 0);
    validateSupervisorJob(value.job, job);
    validateSourceBinding(value.binding, binding);
    validateHarnessObserver(value.observer, observer);
    validateNormalSupervisorLifecycle(value.lifecycle);
    validateEvidenceReference(
        value.childEvidence,
        'child-evidence.json',
        SUPERVISOR_METADATA_LIMIT,
    );
    validateEvidenceReference(value.timeline, 'timeline.jsonl', SUPERVISOR_TIMELINE_LIMIT);
    return value;
}
export function validateCollectedSupervisor(
    value,
    child,
    { job, binding, observer, childReference, timeline },
) {
    validateCollectedSupervisorHeader(value, { job, binding, observer });
    validateClosedChild(child, { job, binding, observer, timeline });
    sameReference(
        value.childEvidence,
        childReference,
        'child-evidence.json',
        SUPERVISOR_METADATA_LIMIT,
    );
    sameReference(value.timeline, timeline, 'timeline.jsonl', SUPERVISOR_TIMELINE_LIMIT);
    return value;
}
/** Streaming JSONL check: one exact source/mode binding, with no metric/pass interpretation. */
export function sourceBindingTimeline(binding, observer) {
    validateSourceBinding(binding);
    validateHarnessObserver(observer);
    assert.equal(
        binding.observerSHA256,
        harnessObserverSHA256(observer),
        'Foreign timeline harness observer.',
    );
    let pending = Buffer.alloc(0),
        matches = 0,
        identities = 0,
        observers = 0,
        records = 0,
        ended = false;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    function line(bytes) {
        assert.ok(
            bytes.length > 0 && bytes.length <= SUPERVISOR_LINE_LIMIT,
            'Supervisor timeline line bound exceeded.',
        );
        const text = decoder.decode(bytes),
            value = JSON.parse(text);
        assert.equal(text, JSON.stringify(value), 'Noncanonical supervisor timeline JSON.');
        keys(value, ['time', 'stage', 'data']);
        assert.ok(Number.isSafeInteger(value.time) && value.time >= 0);
        assert.ok(
            typeof value.stage === 'string' && value.stage.length > 0 && value.stage.length <= 256,
        );
        if (records === 0)
            assert.equal(
                value.stage,
                'supervisor-source-binding',
                'Timeline must begin with its source binding.',
            );
        if (records++ === 1)
            assert.equal(
                value.stage,
                'supervisor-harness-observer',
                'Timeline must retain its harness observer second.',
            );
        if (value.stage === 'supervisor-source-binding') {
            matches++;
            assert.equal(matches, 1, 'Duplicate supervisor timeline binding.');
            validateSourceBinding(value.data, binding);
        }
        if (value.stage === 'identity') {
            assert.equal(++identities, 1, 'Duplicate timeline identity record.');
            const identity = value.data;
            assert.ok(identity && typeof identity === 'object' && !Array.isArray(identity));
            validateSupervisorJob(identity.productJob);
            assert.equal(
                identity.productJob.nonce,
                binding.jobNonce,
                'Foreign timeline identity nonce.',
            );
            for (const field of ['lane', 'gcMode', 'sourceSHA256', 'viewer'])
                assert.equal(
                    identity[field],
                    binding[field],
                    'Foreign timeline identity context: ' + field,
                );
            assert.equal(
                identity.adapterHash,
                binding.adapterSHA256,
                'Foreign timeline adapter identity.',
            );
        }
        if (value.stage === 'supervisor-harness-observer') {
            assert.equal(++observers, 1, 'Duplicate timeline harness observer.');
            validateHarnessObserver(value.data, observer);
        }
    }
    return {
        push(chunk) {
            assert.equal(ended, false);
            let start = 0;
            for (;;) {
                const end = chunk.indexOf(10, start);
                const bytes = chunk.subarray(start, end < 0 ? chunk.length : end);
                assert.ok(
                    pending.length + bytes.length <= SUPERVISOR_LINE_LIMIT,
                    'Supervisor timeline line bound exceeded.',
                );
                pending = Buffer.concat([pending, bytes]);
                if (end < 0) break;
                line(pending);
                pending = Buffer.alloc(0);
                start = end + 1;
            }
        },
        finish() {
            assert.equal(ended, false);
            ended = true;
            assert.equal(
                pending.length,
                0,
                'Supervisor timeline must end at a complete JSONL record.',
            );
            assert.equal(matches, 1, 'Missing supervisor timeline binding.');
            assert.equal(observers, 1, 'Missing timeline harness observer.');
        },
    };
}
