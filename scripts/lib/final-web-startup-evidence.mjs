import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateWebArchiveBuildRecord } from './web-archive-producer.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const engines = ['chromium', 'firefox', 'webkit'];
const unproved = [
    'executableIdentity',
    'gatewayRuntime',
    'productOwnership',
    'processRetirement',
    'reviewedPolicy',
    'normalGC',
    'forcedGC',
];
function keys(value, fields) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
}
function count(value, maximum) {
    assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= maximum);
}

/** Consumes the existing public-UI observer's facts, not a product qualification receipt.
 * Build/source/run/job authentication and browser executable/retirement remain unproved.
 */
export function validateFinalWebStartupObservation(value, build, expected) {
    return validateObservation(value, build, expected, false);
}
export function validateLocalWebStartupObservation(value, build, expected) {
    return validateObservation(value, build, expected, true);
}
function validateObservation(value, build, expected, local) {
    if (local) {
        assert.equal(build.kind, 'local-web-source-build-archive');
        assert.equal(build.context.diagnosticId, expected.diagnosticId);
    }
    keys(value, [
        'schemaVersion',
        'kind',
        'scope',
        'observationProfile',
        'selectedSource',
        'archive',
        'observer',
        'host',
        'observations',
        ...unproved,
        'releaseAcceptance',
    ]);
    assert.equal(value.schemaVersion, 2);
    assert.equal(
        value.kind,
        local ? 'local-web-runtime-observation' : 'final-web-runtime-observation',
    );
    assert.equal(value.scope, local ? 'local-public-ui-startup' : 'public-ui-startup');
    assert.equal(value.releaseAcceptance, false);
    for (const field of unproved) assert.equal(value[field], null);
    assert.deepEqual(value.selectedSource, {
        commit: expected.sourceCommit,
        tree: expected.sourceTree,
        version: expected.version,
        buildRecordSHA256: expected.buildRecordSHA256,
    });
    assert.deepEqual(value.archive, build.archive);
    keys(value.observer, [
        ...(local ? ['diagnosticId'] : ['runId', 'runAttempt', 'jobId']),
        'toolingCommit',
        'engineReported',
        'browserVersionReported',
    ]);
    if (local) {
        assert.match(value.observer.diagnosticId, /^[a-f0-9]{32}$/);
        assert.equal(value.observer.diagnosticId, expected.diagnosticId);
    } else {
        assert.equal(value.observer.runId, expected.runId);
        assert.equal(value.observer.runAttempt, expected.runAttempt);
        for (const field of ['runId', 'runAttempt', 'jobId'])
            assert.match(value.observer[field], /^[1-9][0-9]{0,31}$/);
    }
    assert.match(value.observer.toolingCommit, /^[a-f0-9]{40}$/);
    assert.ok(engines.includes(expected.engine));
    assert.equal(value.observer.engineReported, expected.engine);
    assert.equal(value.observer.browserVersionReported, expected.browserVersion);
    assert.ok(
        typeof expected.browserVersion === 'string' &&
            expected.browserVersion.length > 0 &&
            expected.browserVersion.length <= 256,
    );
    keys(value.host, ['origin', 'prefix', 'hostOwner']);
    assert.match(value.host.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
    assert.ok(Number(new URL(value.host.origin).port) <= 65535);
    assert.match(value.host.prefix, /^\/(?:[A-Za-z0-9_-]+\/)+$/);
    assert.match(value.host.hostOwner, /^[a-f0-9]{64}$/);
    keys(value.observationProfile, ['maxResponseBytes', 'maxResponses']);
    const profile = value.observationProfile;
    count(profile.maxResponseBytes, 256 * 1024 ** 2);
    count(profile.maxResponses, 4096);
    assert.ok(profile.maxResponseBytes > 0 && profile.maxResponses > 0);
    const observed = value.observations;
    keys(observed, [
        'navigationDocumentSHA256',
        'resources',
        'responseObjectsRead',
        'responseBodyBytes',
        'startupControlsVisible',
        'observerCallbacksJoined',
        'pageState',
        'adapterInstalledHooks',
    ]);
    assert.equal(observed.startupControlsVisible, true);
    assert.equal(observed.observerCallbacksJoined, true);
    keys(observed.pageState, [
        'failedRequests',
        'crashes',
        'unexpectedClosures',
        'urlDrifts',
        'openAtCompletion',
        'finalURLMatches',
    ]);
    for (const field of ['failedRequests', 'crashes', 'unexpectedClosures', 'urlDrifts'])
        assert.equal(observed.pageState[field], 0);
    assert.equal(observed.pageState.openAtCompletion, true);
    assert.equal(observed.pageState.finalURLMatches, true);
    assert.deepEqual(observed.adapterInstalledHooks, []);
    count(observed.responseObjectsRead, profile.maxResponses);
    count(observed.responseBodyBytes, profile.maxResponseBytes);
    assert.ok(
        Array.isArray(observed.resources) &&
            observed.resources.length > 0 &&
            observed.resources.length <= observed.responseObjectsRead,
    );
    const inventory = new Map(build.payload.map((row) => [row.path, row]));
    let previous,
        bytes = 0,
        responses = 0;
    for (const row of observed.resources) {
        keys(row, ['path', 'bytes', 'sha256', 'responses']);
        assert.deepEqual(
            { path: row.path, bytes: row.bytes, sha256: row.sha256 },
            inventory.get(row.path),
            'Observed resource differs from archive inventory.',
        );
        assert.ok(
            previous === undefined || previous < row.path,
            'Duplicate or unsorted runtime resources.',
        );
        previous = row.path;
        count(row.responses, profile.maxResponses);
        assert.ok(row.responses > 0);
        bytes += row.bytes * row.responses;
        responses += row.responses;
    }
    const index = inventory.get('index.html');
    assert.ok(index && observed.resources.some((row) => row.path === 'index.html'));
    assert.equal(observed.navigationDocumentSHA256, index.sha256);
    assert.equal(responses, observed.responseObjectsRead, 'Per-resource response counts differ.');
    assert.equal(bytes, observed.responseBodyBytes, 'Per-resource response byte totals differ.');
    return value;
}

/** Caller must rehash all retained files before invoking this reader. The JSON callback must
 * return a bounded stable read of the fixed evidence path, not a summary supplied by the producer.
 * Canonical reconstruction binds those parsed values to the already verified retained bytes.
 */
export async function consumeFinalWebStartupEvidence(receipt, expected, readRetainedJSON) {
    assert.equal(expected.scope, 'web');
    assert.equal(receipt.scope, 'web');
    async function retained(caseId, file, maximum) {
        const item = receipt.cases.filter((row) => row.id === caseId);
        assert.equal(item.length, 1);
        const references = receipt.cases
            .flatMap((row) => row.evidence)
            .filter((entry) => entry.path === file);
        assert.equal(references.length, 1, 'Require one retained fixed web evidence path: ' + file);
        const reference = references[0];
        assert.ok(item[0].evidence.includes(reference), 'Web evidence belongs to the wrong case.');
        const value = await readRetainedJSON(file, maximum);
        const bytes = Buffer.from(JSON.stringify(value) + '\n');
        assert.ok(bytes.length > 0 && bytes.length <= maximum);
        assert.equal(bytes.length, reference.bytes);
        assert.equal(
            sha(bytes),
            reference.sha256,
            'Parsed web evidence differs from retained bytes.',
        );
        return { value, sha256: reference.sha256 };
    }
    const retainedBuild = await retained(
        'web-archive-source-integrity',
        'web/web-build.json',
        16 * 1024 ** 2,
    );
    const build = retainedBuild.value;
    // This checks the recorded job-key syntax, not authoritative job attribution.
    validateWebArchiveBuildRecord(build, {
        scope: 'web',
        version: expected.version,
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
        runId: expected.runId,
        runAttempt: expected.runAttempt,
        jobKey: build.context?.jobKey,
    });
    for (const record of [build.archive, build.checksum]) {
        const selected = expected.artifacts.filter((entry) => entry.name === record.name);
        assert.equal(selected.length, 1);
        assert.deepEqual(
            record,
            selected[0],
            'Web build differs from selected final archive/checksum.',
        );
    }
    for (const engine of engines) {
        const observation = await retained(
            'web-' + engine,
            'web/' + engine + '-startup.json',
            1024 ** 2,
        );
        validateFinalWebStartupObservation(observation.value, build, {
            ...expected,
            engine,
            browserVersion: receipt.browserVersions[engine],
            buildRecordSHA256: retainedBuild.sha256,
        });
    }
    return Object.freeze({
        status: 'startup-observations-correlated-unqualified',
        releaseAcceptance: false,
    });
}
