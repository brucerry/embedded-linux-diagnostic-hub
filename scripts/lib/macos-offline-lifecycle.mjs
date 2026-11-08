import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateMacManifest } from './macos-release.mjs';
import { validateMacInstalledPayloadSample } from './macos-payload-identity.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keys = (value, fields) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
};
export const MAC_OFFLINE_RECORD_LIMITS = Object.freeze({
    prequit: 8192,
    closed: 8192,
    installedPayload: 8192,
    shippingBuildInfo: 65536,
});
const roles = Object.keys(MAC_OFFLINE_RECORD_LIMITS);
const caseId = 'macos-bundle:offline-launch';
function references(records) {
    keys(records, roles);
    const paths = new Set(),
        hashes = new Set();
    for (const role of roles) {
        const ref = records[role];
        keys(ref, ['path', 'bytes', 'sha256']);
        assert.ok(typeof ref.path === 'string' && Buffer.byteLength(ref.path) <= 1024);
        assert.ok(
            ref.path && !path.posix.isAbsolute(ref.path) && !/[\\\x00-\x1f\x7f]/.test(ref.path),
        );
        assert.equal(path.posix.normalize(ref.path), ref.path);
        assert.ok(ref.path.split('/').every((p) => p && p !== '.' && p !== '..'));
        assert.ok(
            Number.isSafeInteger(ref.bytes) &&
                ref.bytes > 0 &&
                ref.bytes <= MAC_OFFLINE_RECORD_LIMITS[role],
        );
        assert.match(ref.sha256, /^[a-f0-9]{64}$/);
        assert.ok(
            !paths.has(ref.path) && !hashes.has(ref.sha256),
            'Mac lifecycle input records must be distinct.',
        );
        paths.add(ref.path);
        hashes.add(ref.sha256);
    }
}
function parsed(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    // Actual build metadata may be compact; adapter records use two-space JSON + LF.
    // Roundtrip rejects duplicate keys, trailing data and ambiguous/non-finite numbers.
    assert.ok(
        [
            JSON.stringify(value),
            JSON.stringify(value) + '\n',
            JSON.stringify(value, null, 2) + '\n',
        ].includes(text),
        'Noncanonical retained Mac record.',
    );
    return value;
}
/** Descriptor/ownership semantics belong to readBytes. No filesystem, process, native
 * factory, archive download, write, command-success claim or qualification default exists. */
async function readRecords(records, readBytes) {
    assert.equal(typeof readBytes, 'function');
    references(records);
    const values = {};
    for (const role of roles) {
        const ref = records[role],
            returned = await readBytes(ref.path, MAC_OFFLINE_RECORD_LIMITS[role]);
        assert.ok(
            Buffer.isBuffer(returned) &&
                returned.length === ref.bytes &&
                returned.length <= MAC_OFFLINE_RECORD_LIMITS[role],
        );
        const bytes = Buffer.from(returned);
        assert.equal(hash(bytes), ref.sha256, 'Retained Mac lifecycle record changed.');
        values[role] = parsed(bytes);
    }
    return values;
}
/** Correlates existing actual adapter shapes with a selected shipping package. Still
 * unqualified: installed named-file samples do not prove loaded code or group retirement. */
export function inspectMacOfflinePayload(observation, item, expected) {
    keys(observation, ['kind', ...roles, 'records']);
    assert.equal(observation.kind, 'macos-owned-offline-launch/v2');
    assert.equal(item.id, caseId);
    assert.ok(['darwin-x64', 'darwin-arm64'].includes(expected.lane));
    references(observation.records);
    for (const ref of Object.values(observation.records))
        assert.equal(
            item.evidence.filter(
                (row) =>
                    row.path === ref.path && row.bytes === ref.bytes && row.sha256 === ref.sha256,
            ).length,
            1,
            'Missing exact retained Mac record reference.',
        );
    const packages = expected.artifacts.filter(
        (row) => row.name === 'Diagnostic-Hub-macos-' + expected.lane.slice(7) + '.zip',
    );
    assert.equal(packages.length, 1);
    const archive = packages[0],
        info = observation.shippingBuildInfo;
    validateMacManifest(info, {
        arch: expected.lane.slice(7),
        version: expected.version,
        commit: expected.sourceCommit,
        sha256: archive.sha256,
    });
    assert.ok(info.payloadIdentity, 'Missing shipping payload identity.');
    validateMacInstalledPayloadSample(observation.installedPayload, {
        caseId,
        version: expected.version,
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
        archive,
        payloadIdentity: info.payloadIdentity,
    });
    const owner = observation.prequit.ownerId;
    assert.match(
        owner,
        /^[a-f0-9]{32}:macos-bundle:offline-launch:[1-9][0-9]{0,7}:[1-9][0-9]{0,15}$/,
    );
    assert.equal(owner.split(':').at(-1), String(observation.prequit.identity.pid));
    inspectMacOfflineDirectChild(
        {
            kind: 'macos-owned-offline-launch/v1',
            prequit: observation.prequit,
            closed: observation.closed,
        },
        expected,
    );
    return 'shipping-payload-and-direct-child-consistent-unqualified';
}
/** Re-read the four exact retained records at both ingestion and final readback. */
export async function readMacOfflineRecords(rawObservation, readBytes) {
    const observation = structuredClone(rawObservation);
    const values = await readRecords(observation.records, readBytes);
    for (const role of roles)
        assert.deepEqual(
            values[role],
            observation[role],
            'Mac lifecycle projection differs from retained ' + role,
        );
}
/** Small real-record producer. Inputs are retained native-adapter/build-info references,
 * not synthetic callbacks or summary booleans. Call only with independently selected
 * source/run/artifacts and an owned bounded reader. No writes or entire passed receipt. */
export async function produceMacOfflineLifecycle(rawExpected, rawRecords, readBytes) {
    const expected = structuredClone(rawExpected),
        records = structuredClone(rawRecords);
    assert.ok(['darwin-arm64', 'darwin-x64'].includes(expected.lane));
    assert.ok(
        typeof expected.version === 'string' &&
            /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(expected.version),
    );
    assert.ok(Array.isArray(expected.artifacts));
    const packages = expected.artifacts.filter(
        (row) => row.name === 'Diagnostic-Hub-macos-' + expected.lane.slice(7) + '.zip',
    );
    assert.equal(packages.length, 1);
    const artifact = packages[0];
    keys(artifact, ['name', 'bytes', 'sha256']);
    assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    for (const field of ['runId', 'runAttempt'])
        assert.ok(
            typeof expected[field] === 'string' && /^[1-9][0-9]{0,31}$/.test(expected[field]),
        );
    for (const field of ['sourceCommit', 'sourceTree'])
        assert.match(expected[field], /^[a-f0-9]{40}$/);
    const values = await readRecords(records, readBytes);
    const observation = { kind: 'macos-owned-offline-launch/v2', ...values, records };
    const envelope = {
        schemaVersion: 1,
        kind: 'installer-case-observation',
        version: expected.version,
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
        runId: expected.runId,
        runAttempt: expected.runAttempt,
        lane: expected.lane,
        caseId,
        package: artifact,
        observation,
    };
    const evidence = Object.values(records).map((ref) => ({ ...ref }));
    inspectMacOfflinePayload(observation, { id: caseId, evidence }, expected);
    const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
    assert.ok(bytes.length <= 128 * 1024);
    const lifecycleEvidence = {
        path: 'cases/macos-bundle/offline-launch.json',
        bytes: bytes.length,
        sha256: hash(bytes),
    };
    assert.ok(
        !evidence.some(
            (ref) => ref.path === lifecycleEvidence.path || ref.sha256 === lifecycleEvidence.sha256,
        ),
    );
    return {
        caseId,
        bytes,
        lifecycleEvidence,
        evidence: [lifecycleEvidence, ...evidence],
        releaseAcceptance: false,
    };
}
/** A case-bound projection of existing macos-native-adapter prequit/closure records.
 * It observes direct-child closure only. It cannot prove final payload identity, external
 * review, whole-group retirement or the other eight installer operations. */
export function inspectMacOfflineDirectChild(observation, expected) {
    keys(observation, ['kind', 'prequit', 'closed']);
    assert.equal(observation.kind, 'macos-owned-offline-launch/v1');
    keys(observation.prequit, ['ownerId', 'identity', 'scope', 'closure']);
    keys(observation.closed, ['ownerId', 'closure']);
    const before = observation.prequit,
        after = observation.closed;
    assert.ok(
        typeof before.ownerId === 'string' &&
            before.ownerId.length > 0 &&
            before.ownerId.length <= 4096,
    );
    assert.equal(after.ownerId, before.ownerId);
    assert.equal(before.scope, 'installer-case');
    const identity = before.identity,
        held = before.closure,
        closed = after.closure;
    assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
    assert.equal(identity.pid, held.pid);
    assert.equal(identity.pid, closed.pid);
    assert.equal(identity.version, expected.version);
    for (const key of ['ready', 'packaged', 'offline']) assert.equal(identity[key], true);
    assert.equal(held.exitObserved, false);
    assert.equal(held.closeObserved, false);
    assert.equal(held.reason, null);
    assert.equal(closed.reason, null);
    for (const key of [
        'exitObserved',
        'closeObserved',
        'quitIntent',
        'quitScheduledAck',
        'quitComplete',
    ])
        assert.equal(closed[key], true, 'Missing acknowledged installer process closure: ' + key);
    assert.equal(closed.exitCode, 0);
    assert.equal(closed.signal, null);
    for (const key of ['stdoutEOF', 'stderrEOF'])
        assert.equal(closed.streams[key], true, 'Missing installer pipe EOF: ' + key);
    for (const key of [
        'genericPending',
        'shutdownPending',
        'mainPendingCount',
        'publicationFDCount',
        'mainPending',
        'rejectedOwnedCalls',
    ])
        assert.equal(closed[key], 0, 'Installer closure still has pending ownership: ' + key);
    assert.equal(closed.mainTransportClosed, true);
    assert.equal(closed.rendererTransportClosed, true);
    assert.equal(closed.shutdown.complete, true);
    assert.equal(closed.shutdown.incident, null);
    // The actual emitter explicitly cannot observe physical descendants. Never turn this
    // source limitation into a successful group-retirement assertion.
    assert.equal(closed.physicalDescendantClosure, false);
    return 'direct-child-and-pipes-consistent-unqualified';
}
