import assert from 'node:assert/strict';
import { TextDecoder } from 'node:util';
import { requireObservedClosure } from './owned-child.mjs';

export const SUPERVISOR_TIMELINE_LIMIT = 512 * 1024 ** 2;
export const SUPERVISOR_METADATA_LIMIT = 32 * 1024;
export const SUPERVISOR_LINE_LIMIT = 1024 ** 2;
const hash = /^[a-f0-9]{64}$/;
const bindingKeys = [
    'adapterSHA256',
    'gcMode',
    'kind',
    'jobNonce',
    'lane',
    'qualification',
    'requestedMode',
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
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, 'product-supervisor-source-binding');
    assert.equal(value.qualification, false);
    assert.match(value.jobNonce, /^[a-f0-9-]{36}$/);
    assert.match(value.sourceSHA256, hash);
    assert.match(value.adapterSHA256, hash);
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
            schemaVersion: 1,
            kind: 'product-supervisor-source-binding',
            qualification: false,
            sourceSHA256,
            jobNonce,
            adapterSHA256,
            lane,
            gcMode,
            viewer,
            requestedMode: calibration ? 'calibration' : component ? 'component' : 'full-product',
        }),
    );
}
/** Preserve existing argumentsOf presence semantics, including --viewer=0 meaning present. */
export function sourceBindingFromArguments(args, sourceSHA256, adapterSHA256, jobNonce) {
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
export function validateClosedChild(value, { job, binding, timeline }) {
    keys(value, [
        'schemaVersion',
        'kind',
        'qualification',
        'nonce',
        'binding',
        'timeline',
        'ownerCompletion',
    ]);
    assert.equal(value.schemaVersion, 2, 'Only source-bound supervisor v2 evidence is supported.');
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
    assert.equal(value.ownerCompletion, 'not-asserted');
    sameReference(value.timeline, timeline, 'timeline.jsonl', SUPERVISOR_TIMELINE_LIMIT);
    return value;
}
/** A semantic byte/reference/context check, never product or release qualification. */
export function validateCollectedSupervisorHeader(value, { job, binding }) {
    validateSupervisorJob(job);
    validateSourceBinding(binding);
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
        'lifecycle',
        'childEvidence',
        'timeline',
        'failures',
        'scope',
    ]);
    assert.equal(value.schemaVersion, 2, 'Only source-bound supervisor v2 evidence is supported.');
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
    { job, binding, childReference, timeline },
) {
    validateCollectedSupervisorHeader(value, { job, binding });
    validateClosedChild(child, { job, binding, timeline });
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
export function sourceBindingTimeline(binding) {
    validateSourceBinding(binding);
    let pending = Buffer.alloc(0),
        matches = 0,
        identities = 0,
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
        if (records++ === 0)
            assert.equal(
                value.stage,
                'supervisor-source-binding',
                'Timeline must begin with its source binding.',
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
        },
    };
}
