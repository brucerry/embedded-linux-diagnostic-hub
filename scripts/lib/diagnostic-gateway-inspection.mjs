import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseGatewayArchiveBuildRecord } from './gateway-build-record.mjs';
import { inspectInnerArchive } from './inner-archive-inspection.mjs';

export const DIAGNOSTIC_GATEWAY_RECEIPT_BYTES = 16_384;
export const DIAGNOSTIC_GATEWAY_POLICY = 'github-hosted-diagnostic-teardown-unproved-group-v1';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Pure same-run consistency inspection. No filesystem, process, execution admission, service
 * provenance or release grant. The controller must separately bind the original terminal job.
 */
export function inspectDiagnosticGatewayBuild(recordBytes, archiveBytes, checksumBytes, expected, command, executionPolicy) {
    assert.equal(executionPolicy, DIAGNOSTIC_GATEWAY_POLICY);
    assert.deepEqual(Object.keys(command).sort(), ['completed', 'exitCode', 'signal', 'timedOut']);
    assert.equal(command.completed, true);
    assert.equal(command.exitCode, 0);
    assert.equal(command.signal, null);
    assert.equal(command.timedOut, false);
    const record = parseGatewayArchiveBuildRecord(recordBytes, expected);
    assert.ok(Buffer.isBuffer(checksumBytes) && checksumBytes.length <= 1024);
    assert.deepEqual(checksumBytes, Buffer.from(record.archive.sha256 + '  ' + record.archive.name + '\n'));
    assert.equal(sha(checksumBytes), record.checksum.sha256);
    const inspection = inspectInnerArchive(archiveBytes, record, 'gateway');
    assert.equal(inspection.status, 'matches-producer-inventory-unqualified');
    const receipt = {
        schema: 'same-run-diagnostic-gateway-inspection-v1',
        status: 'diagnostic-built-and-inspected',
        context: { ...record.context },
        recordSHA256: sha(recordBytes),
        archive: { ...record.archive },
        checksumSHA256: sha(checksumBytes),
        payloadMembers: inspection.payload.length,
        payloadBytes: inspection.payload.reduce((total, file) => total + file.bytes, 0),
        payloadInventorySHA256: sha(JSON.stringify(inspection.payload)),
        tarInventorySHA256: sha(JSON.stringify(inspection.tarInventory)),
        provenance: 'same-run-consistency-not-independent-service-attestation',
        executionPolicy,
        timeoutCancellation: 'may-use-runner-teardown-no-graceful-group-proof',
        wholeGroupRetirement: null,
        releaseAcceptance: false,
    };
    const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
    assert.ok(bytes.length <= DIAGNOSTIC_GATEWAY_RECEIPT_BYTES);
    return Object.freeze({ receipt: Object.freeze(receipt), bytes });
}
