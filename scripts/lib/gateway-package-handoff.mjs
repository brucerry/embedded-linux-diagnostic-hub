import assert from 'node:assert/strict';
import { valid } from 'semver';
import { sourceDigest } from './committed-source-bridge.mjs';
import { verifyGatewayArchiveReadback } from './gateway-archive-readback.mjs';

const maximum = 16 * 1024;
function fields(value, names) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
function descriptor(value, name, limit) {
    fields(value, ['name', 'bytes', 'sha256']);
    assert.equal(value.name, name);
    assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= limit);
    assert.match(value.sha256, /^[a-f0-9]{64}$/);
}
function selection(value) {
    fields(value, ['context', 'buildRecord', 'artifacts']);
    fields(value.context, [
        'scope',
        'version',
        'sourceCommit',
        'sourceTree',
        'runId',
        'runAttempt',
        'jobKey',
    ]);
    const c = value.context;
    assert.equal(c.scope, 'gateway');
    assert.ok(typeof c.version === 'string' && c.version.length <= 128);
    assert.equal(valid(c.version), c.version);
    for (const key of ['sourceCommit', 'sourceTree']) assert.match(c[key], /^[a-f0-9]{40}$/);
    for (const key of ['runId', 'runAttempt']) assert.match(c[key], /^[1-9][0-9]{0,31}$/);
    assert.match(c.jobKey, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/);
    descriptor(value.buildRecord, 'gateway-build.json', 16 * 1024 ** 2);
    assert.ok(Array.isArray(value.artifacts) && value.artifacts.length === 2);
    const name = `Diagnostic-Hub-Gateway-${c.version}.tar.gz`;
    descriptor(value.artifacts[0], name, 128 * 1024 ** 2);
    descriptor(value.artifacts[1], name + '.sha256', 1024);
    return value;
}

/** Capture only the already verified caller return. No staged read, file path, service
 * authentication or qualification is added. The transport is the existing readback selection. */
export function captureGatewayPackageHandoff(result) {
    assert.equal(result.status, 'local-package-readback-complete');
    assert.equal(result.sameJobAuthentication, null);
    assert.equal(result.nativeQualification, false);
    assert.equal(result.releaseAcceptance, false);
    for (const key of ['sameInvocation', 'producerSealed', 'readbackVerified', 'portsAcknowledged'])
        assert.equal(result.local[key], true);
    let context, artifacts;
    if (result.kind === 'gateway-branch-local-build') {
        const original = Buffer.from(JSON.stringify(result.record) + '\n');
        assert.equal(original.length, result.originalBuildRecord.bytes);
        assert.equal(sourceDigest(original), result.originalBuildRecord.sha256);
        context = result.record.context;
        artifacts = [result.record.archive, result.record.checksum];
    } else {
        assert.equal(result.kind, 'gateway-release-local-caller-draft');
        assert.equal(result.binding.status, 'bound-not-qualified');
        assert.deepEqual(result.binding.buildRecord, result.originalBuildRecord);
        context = result.binding.context;
        artifacts = result.binding.artifacts;
    }
    const selected = selection(
        structuredClone({
            context,
            buildRecord: result.originalBuildRecord,
            artifacts,
        }),
    );
    const bytes = Buffer.from(JSON.stringify(selected) + '\n');
    assert.ok(bytes.length <= maximum);
    return bytes;
}

export function parseGatewayPackageHandoff(bytes) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum);
    return selection(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

/** Inert verification before any runtime preparation. Source is independently selected by
 * the outside caller; expected record/artifacts remain bound to the original producer return. */
export function verifyGatewayRuntimePackage(bytes, input, source) {
    fields(source, ['sourceCommit', 'sourceTree']);
    const selected = parseGatewayPackageHandoff(bytes);
    for (const key of ['sourceCommit', 'sourceTree']) {
        assert.match(source[key], /^[a-f0-9]{40}$/);
        assert.equal(selected.context[key], source[key]);
    }
    return verifyGatewayArchiveReadback(input, selected);
}
