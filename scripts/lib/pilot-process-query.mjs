import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const processQueryStage = 'startup-process-query-closed';
export const processQueryBatchLimit = 16;
export function processQueryCommand(platform) {
    assert(['win32', 'darwin'].includes(platform));
    return platform === 'win32'
        ? {
              file: 'powershell.exe',
              args: [
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="Created";e={$_.CreationDate.ToUniversalTime().ToString("o")}},WorkingSetSize | ConvertTo-Json -Compress',
              ],
          }
        : { file: 'ps', args: ['-axo', 'pid=,ppid=,lstart=,rss='] };
}
export function processQueryDigest(platform) {
    return createHash('sha256')
        .update(JSON.stringify(processQueryCommand(platform)))
        .digest('hex');
}
function pid(value) {
    assert(Number.isSafeInteger(value) && value > 0, 'Query process PID missing');
}
function creation(value) {
    assert(
        typeof value === 'string' &&
            value.length > 0 &&
            Buffer.byteLength(JSON.stringify(value)) <= 128,
        'Query creation identity missing',
    );
}
/** Source-bound child exit/pipe receipts, never process-name or PID-only authority. */
export function validateProcessQueryProof(proof) {
    assert(proof && typeof proof === 'object' && !Array.isArray(proof));
    assert.deepEqual(
        Object.keys(proof).sort(),
        [
            'close',
            'closeCode',
            'closeSignal',
            'created',
            'exit',
            'exitCode',
            'exitSignal',
            'ownerCreated',
            'ownerPID',
            'parentPID',
            'pid',
            'platform',
            'querySHA256',
            'schema',
            'spawn',
            'tableSHA256',
            'querySequence',
        ].sort(),
    );
    assert.equal(proof.schema, 1);
    pid(proof.pid);
    pid(proof.ownerPID);
    pid(proof.parentPID);
    creation(proof.created);
    creation(proof.ownerCreated);
    assert.equal(proof.parentPID, proof.ownerPID);
    assert.notEqual(proof.pid, proof.ownerPID);
    assert.equal(proof.querySHA256, processQueryDigest(proof.platform));
    assert.match(proof.tableSHA256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(proof.querySequence) && proof.querySequence > 0);
    for (const field of ['spawn', 'exit', 'close']) assert.equal(proof[field], true);
    assert.equal(proof.exitCode, 0);
    assert.equal(proof.closeCode, 0);
    assert.equal(proof.exitSignal, null);
    assert.equal(proof.closeSignal, null);
    assert(Buffer.byteLength(JSON.stringify(proof)) <= 1024, 'Query closure proof bound');
    return Object.freeze({ ...proof });
}
export function validateProcessQueryBatch(batch) {
    assert(batch && typeof batch === 'object' && !Array.isArray(batch));
    assert.deepEqual(Object.keys(batch).sort(), ['queries', 'schema']);
    assert.equal(batch.schema, 1);
    assert(
        Array.isArray(batch.queries) &&
            batch.queries.length > 0 &&
            batch.queries.length <= processQueryBatchLimit,
    );
    const proofs = batch.queries.map(validateProcessQueryProof);
    assert.equal(
        new Set(proofs.map((p) => JSON.stringify([p.pid, p.created]))).size,
        proofs.length,
    );
    return proofs;
}
