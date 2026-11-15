import assert from 'node:assert/strict';
import { TextDecoder } from 'node:util';
import { sourceDigest, SOURCE_LIMITS } from './committed-source-bridge.mjs';
import { parseGatewayArchiveBuildRecord } from './gateway-build-record.mjs';
import { openGatewayArchiveBytes } from './inner-archive-inspection.mjs';
import {
    gatewayReadme,
    projectGatewayLock,
    validatePreparedGatewayLock,
} from './gateway-lock-plan.mjs';
import { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';

function fields(value, names) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
function snapshot(value, maximum) {
    assert.ok(Buffer.isBuffer(value) && value.length > 0 && value.length <= maximum);
    return Buffer.from(value);
}
const json = (bytes) =>
    JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));

/** Correlates bounded byte snapshots with a caller-selected source/run/job and artifacts.
 * The caller must obtain those selections independently of the record being checked and
 * retain ownership of its reads. No filesystem, process, install or runtime operation occurs.
 * Returns only the existing partial `built` record: neither this function nor a successful
 * fixture authenticates the service/producer or grants product/release qualification.
 */
export function verifyGatewayArchiveReadback(input, expected) {
    fields(input, [
        'recordBytes',
        'archiveBytes',
        'checksumBytes',
        'sourcePackageBytes',
        'sourceLockBytes',
        'compiledBytes',
    ]);
    fields(expected, ['context', 'buildRecord', 'artifacts']);
    const selected = structuredClone(expected),
        recordBytes = snapshot(input.recordBytes, 16 * 1024 ** 2),
        archiveBytes = snapshot(input.archiveBytes, WEB_ARCHIVE_LIMITS.archive),
        checksumBytes = snapshot(input.checksumBytes, 1024),
        sourcePackageBytes = snapshot(input.sourcePackageBytes, SOURCE_LIMITS.blob),
        sourceLockBytes = snapshot(input.sourceLockBytes, SOURCE_LIMITS.blob),
        compiledBytes = snapshot(input.compiledBytes, WEB_ARCHIVE_LIMITS.member),
        record = parseGatewayArchiveBuildRecord(recordBytes, selected.context);
    fields(selected.buildRecord, ['name', 'bytes', 'sha256']);
    assert.equal(selected.buildRecord.name, 'gateway-build.json');
    assert.equal(recordBytes.length, selected.buildRecord.bytes);
    assert.equal(sourceDigest(recordBytes), selected.buildRecord.sha256);
    assert.ok(Array.isArray(selected.artifacts) && selected.artifacts.length === 2);
    for (const [wanted, bytes] of [
        [record.archive, archiveBytes],
        [record.checksum, checksumBytes],
    ]) {
        const matches = selected.artifacts.filter((row) => row.name === wanted.name);
        assert.equal(matches.length, 1, 'Require one independently selected artifact identity.');
        fields(matches[0], ['name', 'bytes', 'sha256']);
        assert.deepEqual(matches[0], wanted, 'Producer differs from selected artifact.');
        assert.equal(bytes.length, wanted.bytes);
        assert.equal(sourceDigest(bytes), wanted.sha256);
    }
    assert.ok(
        checksumBytes.equals(Buffer.from(`${record.archive.sha256}  ${record.archive.name}\n`)),
        'Noncanonical or mismatched Gateway checksum sidecar.',
    );
    function sourceMember(name, bytes) {
        const matches = record.sourceBridge.inventory.filter((row) => row.path === name);
        assert.equal(matches.length, 1, 'Missing or ambiguous selected source member.');
        assert.equal(bytes.length, matches[0].bytes, 'Source member byte length differs.');
        assert.equal(sourceDigest(bytes), matches[0].sha256, 'Source member bytes differ.');
    }
    sourceMember('package.json', sourcePackageBytes);
    sourceMember('package-lock.json', sourceLockBytes);
    const sourcePackage = json(sourcePackageBytes),
        sourceLock = json(sourceLockBytes),
        projected = projectGatewayLock(sourcePackage, sourceLock);
    assert.equal(sourcePackage.version, selected.context.version);
    assert.equal(sourceDigest(sourceLockBytes), record.sourceLockSHA256);
    assert.equal(
        sourceDigest(Buffer.from(JSON.stringify(projected.lock, null, 2) + '\n')),
        record.projectedLockSHA256,
        'Source lock projection differs from producer record.',
    );
    const contents = openGatewayArchiveBytes(archiveBytes, record);
    try {
        for (const name of [
            '.env.gateway.example',
            'LICENSE',
            'docs/gateway.md',
            'gateway/Caddyfile.example',
        ])
            sourceMember(name, contents.read(name));
        assert.ok(
            contents.read('dist-gateway/main.cjs').equals(compiledBytes),
            'Archive entry differs from the independently observed compiler output.',
        );
        assert.ok(contents.read('README.md').equals(Buffer.from(gatewayReadme())));
        assert.deepEqual(json(contents.read('package.json')), projected.manifest);
        validatePreparedGatewayLock(
            json(contents.read('package-lock.json')),
            projected.manifest,
            sourceLock,
        );
    } finally {
        contents.releaseBytes(); // Only in-memory member snapshots; no filesystem cleanup.
    }
    return record;
}
