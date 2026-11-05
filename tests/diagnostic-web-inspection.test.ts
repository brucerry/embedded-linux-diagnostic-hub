import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readbackFixture } from './fixtures/archive-readback-memory';
import { inspectDiagnosticWebBuild, DIAGNOSTIC_WEB_RECEIPT_BYTES } from '../scripts/lib/diagnostic-web-inspection.mjs';

const outcome = () => ({ completed: true, exitCode: 0, signal: null, timedOut: false });
async function fixture() {
    const f = await readbackFixture('web');
    const record = f.files.get('web-build.json')!;
    const parsed = JSON.parse(record.toString('utf8'));
    return { record, archive: f.files.get(parsed.archive.name)!, checksum: f.files.get(parsed.checksum.name)!, context: parsed.context };
}
test('same-run receipt checks actual archive members and checksum without promoting qualification', async () => {
    const f = await fixture(), r = inspectDiagnosticWebBuild(f.record, f.archive, f.checksum, f.context, outcome());
    assert.equal(r.receipt.payloadMembers, 4);
    assert.equal(r.receipt.context.sourceCommit, f.context.sourceCommit);
    assert.equal(r.receipt.wholeGroupRetirement, null); assert.equal(r.receipt.releaseAcceptance, false);
    assert.ok(r.bytes.length <= DIAGNOSTIC_WEB_RECEIPT_BYTES);
    assert.equal(r.receipt.provenance, 'same-run-consistency-not-independent-service-attestation');
});
for (const [name, change] of [
    ['missing completion', (v: any) => { delete v.completed; }],
    ['nonzero command exit', (v: any) => { v.exitCode = 1; }],
    ['signalled command', (v: any) => { v.signal = 'SIGTERM'; }],
    ['timeout', (v: any) => { v.timedOut = true; }],
] as const) test('passed record cannot mask ' + name, async () => {
    const f = await fixture(), command = outcome(); change(command);
    assert.throws(() => inspectDiagnosticWebBuild(f.record, f.archive, f.checksum, f.context, command));
});
test('source/run mismatch cannot reuse a sibling or prior-run receipt', async () => {
    const f = await fixture();
    for (const context of [{ ...f.context, sourceCommit: 'a'.repeat(40) }, { ...f.context, runId: '123456' }, { ...f.context, runAttempt: '2' }])
        assert.throws(() => inspectDiagnosticWebBuild(f.record, f.archive, f.checksum, context, outcome()));
});
test('changed archive bytes and changed checksum bytes fail closed', async () => {
    const f = await fixture(), changed = Buffer.from(f.archive); changed[0] ^= 1;
    assert.throws(() => inspectDiagnosticWebBuild(f.record, changed, f.checksum, f.context, outcome()));
    assert.throws(() => inspectDiagnosticWebBuild(f.record, f.archive, Buffer.from('bad checksum\n'), f.context, outcome()));
});
test('disabled workflow keeps execution held and has no artifact/cache/release upload', () => {
    const text = readFileSync(new URL('../.github/workflow-candidates/web-archive-producer.yml.disabled', import.meta.url), 'utf8');
    assert.ok(text.includes('if: ${{ false }}')); assert.ok(text.includes('runs-on: ubuntu-24.04'));
    assert.ok(text.includes('timeout-minutes: 20'));
    const guards = ['test "$GITHUB_RUN_ATTEMPT" = 1', 'test "${RUNNER_ENVIRONMENT:-}" = github-hosted'];
    function early(value: string) {
        const checkout = value.indexOf('uses: actions/checkout'); assert.ok(checkout >= 0);
        for (const guard of guards) { const at = value.indexOf(guard); assert.ok(at >= 0 && at < checkout); }
    }
    early(text);
    for (const guard of guards) assert.throws(() => early(text.replace(guard, '')));
    assert.equal(/uses: actions\/(?:upload|cache)/.test(text), false);
    assert.ok(text.includes('inspectDiagnosticWebBuild')); assert.ok(text.includes('HUB_DIAGNOSTIC_WEB_RECEIPT='));
});
