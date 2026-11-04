import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessLoopbackDiagnostic } from './loopback-console-diagnostic.mjs';
import { assessLoopbackOutcome } from './loopback-console-outcome.mjs';
import { createLoopbackDiagnostics, sanitizeLoopbackDiagnostics } from '../tests/ui/fixtures/loopback-diagnostics.ts';

const checks = [];
const clean = () => createLoopbackDiagnostics().snapshot();
const gate = (j,a) => assessLoopbackDiagnostic(j,a,sanitizeLoopbackDiagnostics);
const outcome = (issues=[]) => assessLoopbackOutcome({result:{status:'passed',errors:[]},
    globalErrors:[],command:{schema:1,exitCode:0},stepOutcome:'success',issues});
const both = gate(clean(),clean());
assert.equal(both.diagnostic.reconciliation,'same'); assert.equal(outcome(both.issues).passed,true);
checks.push('complete clean evidence permits a passing command/result');
const owner=createLoopbackDiagnostics();
for(let i=0;i<32;i++)owner.stage('page-ready');
assert.equal(outcome(gate(owner.snapshot(),owner.snapshot()).issues).passed,true);
checks.push('32 retained events with explicit no-overflow is complete');
owner.stage('page-ready');
const truncated=owner.snapshot(); assert.equal(truncated.overflow,true);
for(const [j,a] of [[clean(),truncated],[truncated,clean()],[truncated,truncated]]) {
    const actual=gate(j,a); assert.ok(actual.issues.includes('diagnostic-stage-overflow'));
    assert.equal(outcome(actual.issues).passed,false);
    assert.equal(actual.diagnostic.journal.overflow || actual.diagnostic.attachment.overflow,true);
}
checks.push('either overflow source refuses passing receipt and retains truncated evidence');
for(const value of [undefined,null,'false',0,{}]) {
    const invalid={...clean(),overflow:value};
    assert.equal(outcome(gate(clean(),invalid).issues).passed,false);
}
checks.push('missing or malformed overflow acknowledgement fails closed');
const first=createLoopbackDiagnostics();first.stage('finally');
const journal=first.snapshot();
first.cleanupFailure({sshClients:0,fileHandles:0,failedFileCloses:0,journalFailed:true,
    sshCloseAcknowledged:true,gatewayCloseAcknowledged:true,gateway:{sessions:0}},['journal-unacknowledged']);
const attachment=first.snapshot();
const reconciled=gate(journal,attachment);
assert.equal(reconciled.diagnostic.reconciliation,'different');
assert.equal(reconciled.diagnostic.journal.firstCleanupFailure,null);
assert.deepEqual(reconciled.diagnostic.attachment.firstCleanupFailure.codes,['journal-unacknowledged']);
assert.equal(reconciled.diagnostic.attachment.firstCleanupFailure.owner.journalFailed,true);
assert.equal(outcome([...reconciled.issues,'retirement-unproved']).passed,false);
checks.push('later attachment cleanup failure survives stale journal; retirement failure stays failed');
const conflict=gate({...attachment,modal:{visible:true,busy:true}},{...attachment,modal:{visible:false,busy:false}});
assert.equal(conflict.diagnostic.reconciliation,'different');
assert.equal(conflict.diagnostic.journal.modal.visible,true);assert.equal(conflict.diagnostic.attachment.modal.visible,false);
checks.push('differing bounded facts preserved separately without arbitrary merge');
assert.equal(gate(undefined,clean()).diagnostic.reconciliation,'attachment-only');
assert.equal(gate(clean(),undefined).diagnostic.reconciliation,'journal-only');
assert.equal(outcome(gate(undefined,undefined).issues).passed,false);
checks.push('single-source provenance explicit and absent evidence refused');
const sanitized=gate({...clean(),password:'SECRET_SENTINEL'}, {...attachment,transcript:'SECRET_SENTINEL'});
assert.equal(JSON.stringify(sanitized).includes('SECRET_SENTINEL'),false);
assert.ok(Buffer.byteLength(JSON.stringify(sanitized.diagnostic))<=8192);
checks.push('both projections retain sanitization and combined 8 KiB bound');
const overlarge=assessLoopbackDiagnostic({overflow:false},null,()=>({overflow:false,padding:'x'.repeat(8192)}));
assert.equal(overlarge.diagnostic,null);assert.equal(outcome(overlarge.issues).passed,false);
checks.push('combined diagnostic byte cap refuses oversize without passing');
const workflow=readFileSync(new URL('./workflows/loopback-console-candidate.yml',import.meta.url),'utf8');
assert.ok(workflow.includes('assessLoopbackDiagnostic(journal?.diagnostic, summary?.ownership?.diagnostic, sanitizeLoopbackDiagnostics)'));
assert.ok(workflow.includes('issues.push(...diagnosticEvidence.issues)'));
assert.equal(workflow.includes('journal?.diagnostic ?? summary?.ownership?.diagnostic'),false);
assert.ok(workflow.includes("if (!closed) issues.push('retirement-unproved')"));
assert.ok(workflow.includes('globalErrors:report && report.errors'));
const fixture=readFileSync(new URL('../tests/ui/fixtures/loopback-console-gateway.ts',import.meta.url),'utf8');
assert.ok(fixture.indexOf("state.phase = state.cleanupAcknowledged ? 'closed' : 'blocked'; record();") <
    fixture.indexOf("if (journalFailed) diagnostics.cleanupFailure(snapshot(), ['journal-unacknowledged'])"));
checks.push('actual workflow uses both-source gate and retains retirement/global command gates');
console.log(JSON.stringify({status:'passed',checks,count:checks.length,targetOrSDKExecuted:false}));
