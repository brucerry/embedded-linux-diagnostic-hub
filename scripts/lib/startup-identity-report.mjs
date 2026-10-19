import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const identityReportLimits = Object.freeze({
    schema: 1,
    partBytes: 32768,
    logicalBytes: 4194304,
    frameBytes: 65536,
    rows: 1024,
    totalBytes: 10485760,
    pendingBytes: 262144,
    // Covers the complete channel and prefixed journal envelopes, including counters.
    envelopeBytes: 1024,
});
export const startupIdentityStages = Object.freeze([
    'aggregate-native-input-identity',
    'aggregate-input-identity',
    'aggregate-actual-process-launches',
    'actual-native-product',
]);
// Observational reports only. Control/admission/final/hold frames cannot use this route.
export const lifecycleEvidenceStages = Object.freeze([
    'gateway-process-history',
    'gateway-node-memory',
    'gateway-host-resources',
    'gateway-host-teardown',
    'gateway-host-abort',
    'native-product-shutdown-request',
    'native-will-quit',
]);
export const losslessReportStages = Object.freeze([
    ...startupIdentityStages,
    ...lifecycleEvidenceStages,
]);
const lifecycle = (stage) => lifecycleEvidenceStages.includes(stage);
const ordinalFields = (stage, ordinal) => {
    if (!lifecycle(stage)) {
        assert(ordinal === undefined, 'Startup identity cannot carry lifecycle ordinal');
        return {};
    }
    assert(
        Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= identityReportLimits.rows,
        'Lifecycle report ordinal',
    );
    return { ordinal };
};
export const identityManifestStage = 'startup-identity-manifest';
export const identityPartStage = 'startup-identity-part';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allowed = (stage) => losslessReportStages.includes(stage);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => {
    assert(object(value), 'Identity record must be an object');
    assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Identity schema keys');
};
export function reportingRefusal(stage, counter, encodedBytes, current, limit) {
    const details = {
        stage: String(stage).slice(0, 128),
        counter,
        encodedBytes,
        current,
        limit,
    };
    const error = Error('Runtime diagnostic envelope: ' + JSON.stringify(details));
    error.reportingFailure = details;
    return error;
}
export const identityFrameCharge = (stage, data) =>
    Buffer.byteLength(JSON.stringify({ stage, data })) + identityReportLimits.envelopeBytes;

/** Exact manifest validation precedes any allocation, reservation or accepted part. */
export function identityManifestBudget(value) {
    exact(value, [
        'schema',
        'stage',
        'bytes',
        'parts',
        'sha256',
        ...(lifecycle(value?.stage) ? ['ordinal'] : []),
    ]);
    ordinalFields(value.stage, value.ordinal);
    assert(value.schema === 1 && allowed(value.stage), 'Identity schema/stage');
    assert(
        Number.isSafeInteger(value.bytes) &&
            value.bytes > 0 &&
            value.bytes <= identityReportLimits.logicalBytes,
        'Identity logical byte bound',
    );
    assert(
        Number.isSafeInteger(value.parts) &&
            value.parts === Math.ceil(value.bytes / identityReportLimits.partBytes),
        'Identity part count',
    );
    assert(
        typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256),
        'Identity SHA256',
    );
    let wireBytes = identityFrameCharge(identityManifestStage, value);
    let peakBytes = wireBytes;
    for (let index = 0; index < value.parts; index++) {
        const n = Math.min(
            identityReportLimits.partBytes,
            value.bytes - index * identityReportLimits.partBytes,
        );
        // Base64 is ASCII without JSON escapes; exact payload length predicts encoded size.
        const data = {
            schema: 1,
            stage: value.stage,
            ...ordinalFields(value.stage, value.ordinal),
            sha256: value.sha256,
            index,
            base64: 'A'.repeat(4 * Math.ceil(n / 3)),
        };
        const bytes = identityFrameCharge(identityPartStage, data);
        assert(bytes <= identityReportLimits.frameBytes, 'Complete identity frame bound');
        wireBytes += bytes;
        peakBytes = Math.max(peakBytes, bytes);
    }
    const budget = Object.freeze({
        logicalBytes: value.bytes,
        wireBytes,
        chargedBytes: value.bytes + wireBytes,
        rows: value.parts + 1,
        peakBytes,
    });
    if (budget.chargedBytes > identityReportLimits.totalBytes)
        throw reportingRefusal(
            value.stage,
            'logicalAndWireBytes',
            budget.chargedBytes,
            0,
            identityReportLimits.totalBytes,
        );
    return budget;
}
const plans = new WeakSet();
export function planStartupIdentity(stage, data, ordinal) {
    const extra = ordinalFields(stage, ordinal);
    assert(allowed(stage), 'Startup identity stage allowlist');
    const serialized = JSON.stringify({ stage, data });
    exact(JSON.parse(serialized), ['stage', 'data']);
    const bytes = Buffer.from(serialized);
    if (bytes.length > identityReportLimits.logicalBytes)
        throw reportingRefusal(
            stage,
            'logicalBytes',
            bytes.length,
            0,
            identityReportLimits.logicalBytes,
        );
    const manifest = Object.freeze({
        schema: 1,
        stage,
        ...extra,
        bytes: bytes.length,
        parts: Math.ceil(bytes.length / identityReportLimits.partBytes),
        sha256: sha(bytes),
    });
    const budget = identityManifestBudget(manifest);
    const plan = Object.freeze({
        manifest,
        budget,
        *frames() {
            yield { stage: identityManifestStage, data: manifest };
            for (let index = 0; index < manifest.parts; index++)
                yield {
                    stage: identityPartStage,
                    data: {
                        schema: 1,
                        stage,
                        ...extra,
                        sha256: manifest.sha256,
                        index,
                        base64: bytes
                            .subarray(
                                index * identityReportLimits.partBytes,
                                (index + 1) * identityReportLimits.partBytes,
                            )
                            .toString('base64'),
                    },
                };
        },
    });
    plans.add(plan);
    return plan;
}
export function requireIdentityPlan(plan) {
    assert(plans.has(plan), 'Identity publication requires a validated plan');
    return plan;
}
const ordinaryLedgers = new WeakMap();
/** Native pilot emitters reserve atomically; ordinary aggregate reporters await every frame. */
export async function reportStartupIdentity(emit, stage, data) {
    if (typeof emit.publishIdentity === 'function') return emit.publishIdentity(stage, data);
    let ledger = ordinaryLedgers.get(emit);
    if (!ledger)
        ordinaryLedgers.set(
            emit,
            (ledger = {
                rows: 0,
                bytes: 0,
                tail: Promise.resolve(),
                failure: null,
                lifecycleOrdinal: 0,
            }),
        );
    if (ledger.failure) throw ledger.failure;
    const plan = planStartupIdentity(
        stage,
        data,
        lifecycle(stage) ? ledger.lifecycleOrdinal + 1 : undefined,
    );
    if (ledger.rows + plan.budget.rows > identityReportLimits.rows)
        throw reportingRefusal(
            stage,
            'rows',
            plan.budget.chargedBytes,
            ledger.rows,
            identityReportLimits.rows,
        );
    if (ledger.bytes + plan.budget.chargedBytes > identityReportLimits.totalBytes)
        throw reportingRefusal(
            stage,
            'totalBytes',
            plan.budget.chargedBytes,
            ledger.bytes,
            identityReportLimits.totalBytes,
        );
    if (lifecycle(stage)) ledger.lifecycleOrdinal++;
    ledger.rows += plan.budget.rows;
    ledger.bytes += plan.budget.chargedBytes;
    const task = ledger.tail.then(async () => {
        if (ledger.failure) throw ledger.failure;
        for (const frame of plan.frames()) await emit(frame.stage, frame.data);
    });
    ledger.tail = task.catch((error) => {
        ledger.failure ??= error;
    });
    return task;
}

/** Same lossless wire/ACK protocol, with a distinct ordinal for repeated observations. */
export async function reportLifecycleEvidence(emit, stage, data) {
    assert(lifecycle(stage), 'Lifecycle evidence stage allowlist');
    return reportStartupIdentity(emit, stage, data);
}

/** A single bounded logical report. No schema, integrity, ordering or completeness inference. */
export function startupIdentityDecoder({ reserve = () => {} } = {}) {
    let active,
        failed,
        nextLifecycleOrdinal = 1;
    const seen = new Set();
    let rows = 0,
        bytes = 0;
    const check = () => {
        if (failed) throw failed;
    };
    return {
        accept(stage, data) {
            check();
            try {
                if (stage === identityManifestStage) {
                    assert(!active, 'Identity manifest before previous report completed');
                    const budget = identityManifestBudget(data);
                    if (lifecycle(data.stage))
                        assert(
                            data.ordinal === nextLifecycleOrdinal,
                            'Lifecycle manifest ordering/uniqueness',
                        );
                    const key =
                        data.stage +
                        ':' +
                        (lifecycle(data.stage) ? data.ordinal + ':' : '') +
                        data.sha256;
                    assert(!seen.has(key), 'Duplicate identity manifest');
                    assert(rows + budget.rows <= identityReportLimits.rows, 'Identity rows');
                    assert(
                        bytes + budget.chargedBytes <= identityReportLimits.totalBytes,
                        'Identity total logical/wire bytes',
                    );
                    reserve(budget);
                    rows += budget.rows;
                    bytes += budget.chargedBytes;
                    active = {
                        manifest: { ...data },
                        budget,
                        key,
                        parts: [],
                        next: 0,
                        received: 0,
                    };
                    return null;
                }
                assert(stage === identityPartStage && active, 'Identity part without manifest');
                exact(data, [
                    'schema',
                    'stage',
                    'sha256',
                    'index',
                    'base64',
                    ...(lifecycle(data.stage) ? ['ordinal'] : []),
                ]);
                const h = active.manifest;
                assert(
                    data.schema === 1 &&
                        data.stage === h.stage &&
                        data.sha256 === h.sha256 &&
                        data.ordinal === h.ordinal,
                    'Identity part binding',
                );
                assert(
                    Number.isSafeInteger(data.index) &&
                        data.index === active.next &&
                        data.index < h.parts,
                    'Identity part ordering/uniqueness',
                );
                const n = Math.min(
                    identityReportLimits.partBytes,
                    h.bytes - data.index * identityReportLimits.partBytes,
                );
                assert(
                    typeof data.base64 === 'string' && data.base64.length === 4 * Math.ceil(n / 3),
                    'Identity encoded part length',
                );
                const decoded = Buffer.from(data.base64, 'base64');
                assert(
                    decoded.length === n && decoded.toString('base64') === data.base64,
                    'Identity canonical base64',
                );
                active.parts.push(decoded);
                active.received += decoded.length;
                active.next++;
                if (active.next !== h.parts) return null;
                assert(active.received === h.bytes, 'Identity exact byte count');
                const all = Buffer.concat(active.parts, h.bytes);
                assert(sha(all) === h.sha256, 'Identity SHA256 mismatch');
                const text = new TextDecoder('utf-8', { fatal: true }).decode(all);
                const value = JSON.parse(text);
                exact(value, ['stage', 'data']);
                assert(
                    value.stage === h.stage && allowed(value.stage),
                    'Identity original stage mismatch',
                );
                assert(
                    Buffer.from(JSON.stringify(value)).equals(all),
                    'Identity original canonical UTF8 JSON bytes',
                );
                seen.add(active.key);
                const result = {
                    ...value,
                    ...ordinalFields(h.stage, h.ordinal),
                    bytes: h.bytes,
                    parts: h.parts,
                    sha256: h.sha256,
                };
                if (lifecycle(h.stage)) nextLifecycleOrdinal++;
                active = null;
                return result;
            } catch (error) {
                failed ??= error;
                throw error;
            }
        },
        assertComplete() {
            check();
            if (active) {
                failed ??= Error('Identity report incomplete');
                throw failed;
            }
        },
        get pending() {
            return Boolean(active);
        },
    };
}
