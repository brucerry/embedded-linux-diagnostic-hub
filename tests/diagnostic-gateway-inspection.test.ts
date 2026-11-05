import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'fflate';
import { readbackFixture } from './fixtures/archive-readback-memory';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { inspectDiagnosticGatewayBuild, DIAGNOSTIC_GATEWAY_POLICY, DIAGNOSTIC_GATEWAY_RECEIPT_BYTES } from '../scripts/lib/diagnostic-gateway-inspection.mjs';

const outcome = () => ({ completed: true, exitCode: 0, signal: null, timedOut: false });
async function fixture() {
    const f = await readbackFixture('gateway');
    const record = f.files.get('gateway-build.json')!;
    const parsed = JSON.parse(record.toString('utf8'));
    return { record, parsed, archive: f.files.get(parsed.archive.name)!, checksum: f.files.get(parsed.checksum.name)!, context: parsed.context };
}
function inspect(f: Awaited<ReturnType<typeof fixture>>) {
    return inspectDiagnosticGatewayBuild(f.record, f.archive, f.checksum, f.context, outcome(), DIAGNOSTIC_GATEWAY_POLICY);
}
test('Gateway receipt requires actual eight-file tar bytes and remains diagnostic only', async () => {
    const f = await fixture(), r = inspect(f);
    assert.equal(r.receipt.payloadMembers, 8);
    assert.equal(r.receipt.context.scope, 'gateway');
    assert.equal(r.receipt.context.sourceCommit, f.context.sourceCommit);
    assert.equal(r.receipt.archive.sha256, sourceDigest(f.archive));
    assert.equal(r.receipt.wholeGroupRetirement, null);
    assert.equal(r.receipt.releaseAcceptance, false);
    assert.equal(r.receipt.provenance, 'same-run-consistency-not-independent-service-attestation');
    assert.equal(r.receipt.timeoutCancellation, 'may-use-runner-teardown-no-graceful-group-proof');
    assert.match(r.receipt.tarInventorySHA256, /^[a-f0-9]{64}$/);
    assert.ok(r.bytes.length <= DIAGNOSTIC_GATEWAY_RECEIPT_BYTES);
    assert.deepEqual(JSON.parse(r.bytes.toString('utf8')), r.receipt);
});
for (const [name, change] of [
    ['missing completion', (v: any) => { delete v.completed; }],
    ['nonzero exit', (v: any) => { v.exitCode = 1; }],
    ['signal', (v: any) => { v.signal = 'SIGTERM'; }],
    ['timeout', (v: any) => { v.timedOut = true; }],
] as const) test('a passed record cannot mask ' + name, async () => {
    const f = await fixture(), command = outcome(); change(command);
    assert.throws(() => inspectDiagnosticGatewayBuild(f.record, f.archive, f.checksum, f.context, command, DIAGNOSTIC_GATEWAY_POLICY));
});
test('receipt refuses source, tree, run, attempt and job mismatches', async () => {
    const f = await fixture();
    for (const changed of [{ sourceCommit: 'a'.repeat(40) }, { sourceTree: 'b'.repeat(40) }, { runId: '123456' }, { runAttempt: '2' }, { jobKey: 'sibling' }])
        assert.throws(() => inspectDiagnosticGatewayBuild(f.record, f.archive, f.checksum, { ...f.context, ...changed }, outcome(), DIAGNOSTIC_GATEWAY_POLICY));
});
test('changed compressed bytes or checksum cannot yield a receipt', async () => {
    const f = await fixture(), changed = Buffer.from(f.archive); changed[0] ^= 1;
    assert.throws(() => inspect({ ...f, archive: changed }));
    assert.throws(() => inspect({ ...f, checksum: Buffer.from('bad checksum\n') }));
});
test('self-consistent outer hashes cannot conceal different inner tar members', async () => {
    const f = await fixture();
    f.archive = Buffer.from(gzipSync(Buffer.alloc(1024), { mtime: 0 }));
    f.parsed.archive.bytes = f.archive.length;
    f.parsed.archive.sha256 = sourceDigest(f.archive);
    f.checksum = Buffer.from(f.parsed.archive.sha256 + '  ' + f.parsed.archive.name + '\n');
    f.parsed.checksum.bytes = f.checksum.length;
    f.parsed.checksum.sha256 = sourceDigest(f.checksum);
    f.record = Buffer.from(JSON.stringify(f.parsed) + '\n');
    assert.throws(() => inspect(f));
});
test('build or lock acknowledgement and unproved retirement cannot be promoted', async () => {
    const f = await fixture();
    for (const mutate of [
        (v: any) => { v.build.lifecycle.closeObserved = false; },
        (v: any) => { v.lockPreparation.lifecycle.code = v.lockPreparation.lifecycle.closeCode = 1; },
        (v: any) => { v.lockPreparation.owner = 'a'.repeat(32); },
        (v: any) => { v.retirement = { passed: true }; },
        (v: any) => { v.releaseAcceptance = true; },
    ]) {
        const changed = structuredClone(f.parsed); mutate(changed);
        assert.throws(() => inspect({ ...f, record: Buffer.from(JSON.stringify(changed) + '\n') }));
    }
});
test('unknown or absent diagnostic policy is not execution authority', async () => {
    const f = await fixture();
    for (const policy of [undefined, null, 'release-qualified'])
        assert.throws(() => inspectDiagnosticGatewayBuild(f.record, f.archive, f.checksum, f.context, outcome(), policy));
});
