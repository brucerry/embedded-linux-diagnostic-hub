import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalContentRecord, CONTENT_REPOSITORY } from './attested-content-policy.mjs';
import { parseWebArchiveBuildRecord } from './web-archive-producer.mjs';
import { parseGatewayArchiveBuildRecord } from './gateway-build-record.mjs';
import { openGatewayArchiveBytes, inspectInnerArchive } from './inner-archive-inspection.mjs';
import { validatePreparedGatewayLock } from './gateway-lock-plan.mjs';
import { verifySourceBridge, SOURCE_LIMITS } from './committed-source-bridge.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => Buffer.from(JSON.stringify(value) + '\n');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function keys(value, names) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
function json(bytes) {
    return JSON.parse(decoder.decode(bytes));
}

/** Post-build integration for the existing web/Gateway producers. Reads DATA only and returns
 * the existing policy's canonical content record plus its complete source-manifest bytes.
 * The provider must independently observe the selected Git/worktree closure. No IO defaults,
 * signatures, writer, process, service lookup, artifact authentication or release capability. */
export async function prepareArchiveContentRecord(raw, sourceProvider) {
    keys(raw, ['context', 'archiveBytes', 'buildRecordBytes', 'checksumBytes', 'producerJobID']);
    assert.match(raw.producerJobID, /^[1-9][0-9]{0,19}$/);
    for (const [name, cap] of [
        ['archiveBytes', 128 * 1024 ** 2],
        ['buildRecordBytes', 16 * 1024 ** 2],
        ['checksumBytes', 1024],
    ])
        assert.ok(Buffer.isBuffer(raw[name]) && raw[name].length > 0 && raw[name].length <= cap);
    for (const method of ['state', 'objects', 'entries', 'file'])
        assert.equal(typeof sourceProvider?.[method], 'function');
    const context = structuredClone(raw.context),
        archiveBytes = Buffer.from(raw.archiveBytes),
        recordBytes = Buffer.from(raw.buildRecordBytes),
        checksumBytes = Buffer.from(raw.checksumBytes),
        producerJobID = raw.producerJobID;
    assert.ok(['web', 'gateway'].includes(context.scope));
    assert.equal(context.version, '0.6.0');
    const record =
        context.scope === 'web'
            ? parseWebArchiveBuildRecord(recordBytes, context)
            : parseGatewayArchiveBuildRecord(recordBytes, context);
    assert.deepEqual(
        checksumBytes,
        Buffer.from(record.archive.sha256 + '  ' + record.archive.name + '\n'),
    );
    assert.equal(checksumBytes.length, record.checksum.bytes);
    assert.equal(hash(checksumBytes), record.checksum.sha256);
    inspectInnerArchive(archiveBytes, record, context.scope);
    const identity = { sourceCommit: context.sourceCommit, sourceTree: context.sourceTree };
    const source = await verifySourceBridge(record.sourceBridge, identity, sourceProvider);
    if (context.scope === 'gateway') {
        const opened = openGatewayArchiveBytes(archiveBytes, record);
        try {
            const file = await sourceProvider.file('package-lock.json'),
                pin = source.inventory.find((row) => row.path === 'package-lock.json');
            assert.ok(
                pin &&
                    file.bytes instanceof Uint8Array &&
                    file.bytes.length === pin.bytes &&
                    file.mode === pin.mode,
            );
            assert.equal(hash(file.bytes), pin.sha256);
            validatePreparedGatewayLock(
                json(opened.read('package-lock.json')),
                json(opened.read('package.json')),
                json(file.bytes),
            );
        } finally {
            opened.releaseBytes();
        }
    }
    // Full canonical inventory, including tracked files excluded from the runtime fingerprint.
    // Its LF is part of this manifest's digest; this differs deliberately from inventorySHA256.
    const manifestBytes = canonical(source.inventory);
    assert.ok(manifestBytes.length > 0 && manifestBytes.length <= SOURCE_LIMITS.metadata);
    const application = {
        commit: context.sourceCommit,
        tree: context.sourceTree,
        sourceManifestSHA256: hash(manifestBytes),
    };
    const value = {
        schemaVersion: 1,
        kind: 'diagnostic-hub-attested-content-record',
        repository: CONTENT_REPOSITORY,
        version: context.version,
        application,
        archive: { ...record.archive },
        producerClaims: {
            buildID: 'sha256:' + hash(recordBytes),
            buildRunID: context.runId,
            buildRunAttempt: context.runAttempt,
            buildJobID: producerJobID,
        },
    };
    const contentBytes = canonicalContentRecord(value);
    // No completed handoff if the independent source changed during inspection.
    await verifySourceBridge(source, identity, sourceProvider);
    const content = {
            name: context.scope + '-content.json',
            bytes: contentBytes.length,
            sha256: hash(contentBytes),
        },
        manifest = {
            name: context.scope + '-source-manifest.json',
            bytes: manifestBytes.length,
            sha256: hash(manifestBytes),
        };
    return Object.freeze({
        application: Object.freeze({ ...application }),
        archive: Object.freeze({ ...record.archive }),
        content: Object.freeze(content),
        sourceManifest: Object.freeze(manifest),
        contentBytes,
        sourceManifestBytes: manifestBytes,
        subjects: Object.freeze(
            [record.archive, content].map((row) =>
                Object.freeze({ name: row.name, digest: Object.freeze({ sha256: row.sha256 }) }),
            ),
        ),
        buildRecordSHA256: hash(recordBytes),
        producerJobAuthority: 'caller-claim-only-not-uploader-attribution',
        signerRun: null,
        authenticatedProvenance: null,
        compiledSourceProven: false,
        runtimeQualified: false,
        retirementQualified: false,
        releaseAcceptance: false,
    });
}
