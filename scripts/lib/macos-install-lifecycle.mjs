import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateMacManifest } from './macos-release.mjs';
import { validateMacInstalledPayloadSample } from './macos-payload-identity.mjs';
import { inspectMacInstallHelper, macHelperRecordPath } from './macos-installer-child.mjs';
import { validateMacInstallOnlyAction } from './macos-installer-actions.mjs';

export const MAC_INSTALL_RECORD_LIMITS = Object.freeze({
    actionCase: 65536,
    helperChild: 65536,
    installedPayload: 8192,
    shippingBuildInfo: 65536,
});
const roles = Object.keys(MAC_INSTALL_RECORD_LIMITS);
const caseId = 'macos-bundle:install';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function keys(value, fields) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
}
function references(records) {
    keys(records, roles);
    const paths = new Set(),
        hashes = new Set();
    for (const role of roles) {
        const ref = records[role];
        keys(ref, ['path', 'bytes', 'sha256']);
        assert.ok(typeof ref.path === 'string' && Buffer.byteLength(ref.path) <= 1024);
        assert.ok(!/[\\\x00-\x1f\x7f]/.test(ref.path));
        assert.ok(ref.path.split('/').every((part) => part && part !== '.' && part !== '..'));
        assert.ok(
            Number.isSafeInteger(ref.bytes) &&
                ref.bytes > 0 &&
                ref.bytes <= MAC_INSTALL_RECORD_LIMITS[role],
        );
        assert.match(ref.sha256, /^[a-f0-9]{64}$/);
        assert.ok(!paths.has(ref.path) && !hashes.has(ref.sha256));
        paths.add(ref.path);
        hashes.add(ref.sha256);
    }
    assert.equal(records.actionCase.path, 'evidence/install-only-case.json');
    assert.match(records.helperChild.path, /^evidence\/child-(?:[0-9]|[12][0-9]|3[01])\.json$/);
    assert.equal(records.installedPayload.path, 'install/evidence/installed-payload-1.json');
    assert.equal(records.shippingBuildInfo.path, 'evidence/current-shipping-build-info.json');
}
function parsed(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    assert.ok(
        [
            JSON.stringify(value),
            JSON.stringify(value) + '\n',
            JSON.stringify(value, null, 2) + '\n',
        ].includes(text),
        'Require complete canonical Mac install records.',
    );
    return value;
}
async function exactBytes(ref, maximum, readBytes) {
    const returned = await readBytes(ref.path, maximum);
    assert.ok(
        Buffer.isBuffer(returned) && returned.length === ref.bytes && returned.length <= maximum,
    );
    const bytes = Buffer.from(returned);
    assert.equal(hash(bytes), ref.sha256, 'Original Mac install record changed.');
    return bytes;
}
async function readRecords(records, readBytes) {
    assert.equal(typeof readBytes, 'function');
    references(records);
    const values = {};
    for (const role of roles)
        values[role] = parsed(
            await exactBytes(records[role], MAC_INSTALL_RECORD_LIMITS[role], readBytes),
        );
    const row = values.helperChild;
    assert.equal(records.helperChild.path, macHelperRecordPath(row.index));
    // Original stream files are committed by the child row. Empty streams may have
    // identical digests, so they are not invented distinct top-level case records.
    keys(row.streams, ['stdout', 'stderr']);
    for (const name of ['stdout', 'stderr']) {
        const ref = row.streams[name];
        keys(ref, ['path', 'bytes', 'sha256']);
        assert.equal(ref.path, 'child-' + row.index + '.' + name);
        assert.ok(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= 65536);
        assert.match(ref.sha256, /^[a-f0-9]{64}$/);
        await exactBytes({ ...ref, path: 'evidence/' + ref.path }, 65536, readBytes);
    }
    return values;
}
function selected(rawExpected) {
    const expected = structuredClone(rawExpected);
    assert.ok(['darwin-arm64', 'darwin-x64'].includes(expected.lane));
    assert.ok(
        typeof expected.version === 'string' &&
            /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(expected.version),
    );
    for (const field of ['sourceCommit', 'sourceTree'])
        assert.match(expected[field], /^[a-f0-9]{40}$/);
    for (const field of ['runId', 'runAttempt'])
        assert.ok(
            typeof expected[field] === 'string' && /^[1-9][0-9]{0,31}$/.test(expected[field]),
        );
    assert.ok(Array.isArray(expected.artifacts));
    const matches = expected.artifacts.filter(
        (row) => row.name === 'Diagnostic-Hub-macos-' + expected.lane.slice(7) + '.zip',
    );
    assert.equal(matches.length, 1);
    const archive = matches[0];
    keys(archive, ['name', 'bytes', 'sha256']);
    assert.ok(Number.isSafeInteger(archive.bytes) && archive.bytes > 0);
    assert.match(archive.sha256, /^[a-f0-9]{64}$/);
    return { expected, archive };
}

/** Consistency of actual retained install inputs/outputs only. Neither a selected run
 * label nor a matching file sample authenticates a service run, loaded code or retirement. */
export function inspectMacInstallPayload(observation, item, rawExpected) {
    keys(observation, ['kind', ...roles, 'records']);
    assert.equal(observation.kind, 'macos-owned-install/v1');
    assert.equal(item.id, caseId);
    const { expected, archive } = selected(rawExpected);
    references(observation.records);
    for (const ref of Object.values(observation.records))
        assert.equal(
            item.evidence.filter(
                (row) =>
                    row.path === ref.path && row.bytes === ref.bytes && row.sha256 === ref.sha256,
            ).length,
            1,
        );
    const info = observation.shippingBuildInfo;
    validateMacManifest(info, {
        arch: expected.lane.slice(7),
        version: expected.version,
        commit: expected.sourceCommit,
        sha256: archive.sha256,
    });
    // The current shipping producer supplies these facts. Historical metadata
    // remains supported by its existing consumers, not by this fresh-install path.
    assert.equal(info.source, expected.sourceCommit);
    assert.equal(info.packagedSourceMatches, true);
    assert.equal(info.distribution, true);
    assert.ok(info.payloadIdentity);
    validateMacInstalledPayloadSample(observation.installedPayload, {
        caseId,
        version: expected.version,
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
        archive,
        payloadIdentity: info.payloadIdentity,
    });
    const child = observation.helperChild;
    inspectMacInstallHelper(child, expected);
    assert.equal(observation.records.helperChild.path, macHelperRecordPath(child.index));
    validateMacInstallOnlyAction(observation.actionCase, {
        version: expected.version,
        sourceCommit: expected.sourceCommit,
        zipSHA256: archive.sha256,
        asarSHA256: info.asarSHA256,
    });
    const [prepare, , install] = observation.actionCase.actions;
    assert.equal(prepare.facts.root, child.operation.fixtureRoot);
    assert.equal(
        prepare.facts.target,
        child.operation.fixtureRoot + '/Applications/Diagnostic Hub.app',
    );
    assert.deepEqual(install.facts.command, child.command);
    return 'installed-payload-and-helper-consistent-unqualified';
}

/** Read each original record and both original helper streams again at ingestion
 * and downstream readback. Reader ownership/path guarantees remain the caller's job. */
export async function readMacInstallRecords(rawObservation, readBytes) {
    const observation = structuredClone(rawObservation);
    const values = await readRecords(observation.records, readBytes);
    for (const role of roles)
        assert.deepEqual(
            values[role],
            observation[role],
            'Mac install projection differs from original ' + role,
        );
}

/** Produces the existing per-case envelope from actual retained records, without a
 * full nine-case receipt, native-origin issuer, filesystem effect or passing verdict. */
export async function produceMacInstallLifecycle(rawExpected, rawRecords, readBytes) {
    const { expected, archive } = selected(rawExpected),
        records = structuredClone(rawRecords);
    const values = await readRecords(records, readBytes);
    const observation = { kind: 'macos-owned-install/v1', ...values, records };
    const evidence = Object.values(records).map((ref) => ({ ...ref }));
    inspectMacInstallPayload(observation, { id: caseId, evidence }, expected);
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
        package: archive,
        observation,
    };
    const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
    assert.ok(bytes.length <= 128 * 1024);
    const lifecycleEvidence = {
        path: 'cases/macos-bundle/install.json',
        bytes: bytes.length,
        sha256: hash(bytes),
    };
    assert.ok(
        evidence.every(
            (ref) => ref.path !== lifecycleEvidence.path && ref.sha256 !== lifecycleEvidence.sha256,
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
