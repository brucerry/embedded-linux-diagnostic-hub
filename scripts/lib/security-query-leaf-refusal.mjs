import assert from 'node:assert/strict';
import {
    collectorEnvironmentKeys,
    projectCollectorEnvironment,
} from './product-collector-environment.mjs';

export const leafRefusalLimits = Object.freeze({
    bytes: 2048,
    classifications: 8,
    inspectedKeys: 256,
    reportedCount: 65535,
});
// Classification only. These names are NOT added to the admission allowlist.
const nativeNames = new Set(['LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME']);
const ipcNames = new Set(['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']);
const projectedNames = new Set([...collectorEnvironmentKeys, 'PATH']);
const foldedProjectedNames = new Set([...projectedNames].map((name) => name.toUpperCase()));
const fallback =
    '{"schema":1,"kind":"query-leaf-environment-refused","observedKeyCount":null,"scannedKeyCount":0,"unexpectedKeyCount":null,"countsComplete":false,"classifications":[],"truncated":true,"diagnosticUnavailable":true,"queryAdmitted":false,"closureAttested":false}\n';

function classify(key) {
    // Do not transform, hash, serialize or disclose arbitrary/oversized key text.
    if (typeof key !== 'string' || key.length > 64 || !/^[A-Za-z0-9_()]+$/.test(key))
        return { category: 'unknown' };
    const name = key.toUpperCase();
    if (nativeNames.has(name)) return { category: 'windows-runtime-required-name', name };
    if (ipcNames.has(name)) return { category: 'ipc-bootstrap-name', name };
    if (foldedProjectedNames.has(name))
        return {
            category: projectedNames.has(key)
                ? 'known-name-not-projected'
                : 'projected-name-case-variant',
            name,
        };
    return { category: 'unknown' };
}

/** Pure, bounded keys-only diagnostics. Never an admission or closure receipt. */
export function leafEnvironmentRefusalRow(observedKeys, expectedKeys) {
    try {
        if (
            !Array.isArray(observedKeys) ||
            !Array.isArray(expectedKeys) ||
            expectedKeys.length > 64 ||
            !expectedKeys.every((key) => typeof key === 'string' && key.length <= 64)
        )
            return fallback;
        const observedKeyCount = observedKeys.length;
        if (!Number.isSafeInteger(observedKeyCount) || observedKeyCount < 0) return fallback;
        const expected = new Set(expectedKeys);
        const scannedKeyCount = Math.min(observedKeyCount, leafRefusalLimits.inspectedKeys);
        let unexpectedKeyCount = 0;
        const classifications = [];
        for (let index = 0; index < scannedKeyCount; index++) {
            const key = observedKeys[index];
            if (typeof key === 'string' && key.length <= 64 && expected.has(key)) continue;
            unexpectedKeyCount++;
            if (classifications.length < leafRefusalLimits.classifications)
                classifications.push(classify(key));
        }
        const countsComplete =
            observedKeyCount <= leafRefusalLimits.inspectedKeys &&
            observedKeyCount <= leafRefusalLimits.reportedCount;
        const row =
            JSON.stringify({
                schema: 1,
                kind: 'query-leaf-environment-refused',
                observedKeyCount: Math.min(observedKeyCount, leafRefusalLimits.reportedCount),
                scannedKeyCount,
                unexpectedKeyCount,
                countsComplete,
                classifications,
                truncated:
                    !countsComplete || unexpectedKeyCount > leafRefusalLimits.classifications,
                queryAdmitted: false,
                closureAttested: false,
            }) + '\n';
        return Buffer.byteLength(row, 'utf8') <= leafRefusalLimits.bytes ? row : fallback;
    } catch {
        return fallback;
    }
}

/** Preserve the original exact-spelling predicate and assertion message. */
export function requireLeafEnvironment(environment, childPATH, writeRefusal) {
    const keys = Object.keys(environment);
    let expectedKeys;
    const accepted = keys.every((key) => {
        const projected = projectCollectorEnvironment(environment, childPATH);
        const allowed = Object.hasOwn(projected, key);
        if (!allowed) expectedKeys = Object.keys(projected);
        return allowed;
    });
    if (!accepted) {
        try {
            // One attempt on the existing bounded stderr pipe; no retry or new effects.
            writeRefusal(leafEnvironmentRefusalRow(keys, expectedKeys));
        } catch {
            // Diagnostic formatting/capture cannot turn refusal into admission.
        }
    }
    assert(accepted, 'Unexpected leaf environment key');
}
