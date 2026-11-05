import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseWebArchiveBuildRecord } from './web-archive-producer.mjs';
import { inspectInnerArchive } from './inner-archive-inspection.mjs';

export const DIAGNOSTIC_WEB_RECEIPT_BYTES = 16_384;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Same-run byte consistency only. No native IO, build dispatch, service attestation or retirement
 * grant. The caller must independently bind expected to the admitted source and terminal job.
 * @param {string | null} [executionPolicy]
 */
export function inspectDiagnosticWebBuild(recordBytes, archiveBytes, checksumBytes, expected, command, executionPolicy = null) {
    assert.ok(executionPolicy === null || executionPolicy === 'github-hosted-diagnostic-teardown-unproved-group-v1');
    assert.deepEqual(Object.keys(command).sort(), ['completed', 'exitCode', 'signal', 'timedOut']);
    assert.equal(command.completed, true);
    assert.equal(command.exitCode, 0);
    assert.equal(command.signal, null);
    assert.equal(command.timedOut, false);
    const record = parseWebArchiveBuildRecord(recordBytes, expected);
    assert.ok(Buffer.isBuffer(checksumBytes) && checksumBytes.length <= 1024);
    assert.deepEqual(checksumBytes, Buffer.from(record.archive.sha256 + '  ' + record.archive.name + '\n'));
    assert.equal(sha(checksumBytes), record.checksum.sha256);
    const inspection = inspectInnerArchive(archiveBytes, record, 'web');
    assert.equal(inspection.status, 'matches-producer-inventory-unqualified');
    const receipt = {
        schema: 'same-run-diagnostic-web-inspection-v1',
        status: 'diagnostic-built-and-inspected',
        context: { ...record.context },
        recordSHA256: sha(recordBytes),
        archive: { ...record.archive },
        checksumSHA256: sha(checksumBytes),
        payloadMembers: inspection.payload.length,
        payloadBytes: inspection.payload.reduce((total, file) => total + file.bytes, 0),
        payloadInventorySHA256: sha(JSON.stringify(inspection.payload)),
        provenance: 'same-run-consistency-not-independent-service-attestation',
        executionPolicy,
        timeoutCancellation: executionPolicy === null ? null : 'may-use-runner-teardown-no-graceful-group-proof',
        wholeGroupRetirement: null,
        releaseAcceptance: false,
    };
    const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
    assert.ok(bytes.length <= DIAGNOSTIC_WEB_RECEIPT_BYTES);
    return Object.freeze({ receipt: Object.freeze(receipt), bytes });
}
