import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessLoopbackDiagnostic } from './loopback-console-diagnostic.mjs';
import { assessLoopbackOutcome } from './loopback-console-outcome.mjs';
import { createLoopbackDiagnostics, sanitizeLoopbackDiagnostics } from '../tests/ui/fixtures/loopback-diagnostics.ts';

const checks = [];
const sample = observer => observer.sampleCommands([{probeCommands:{started:1,completed:1,timedOut:0,failed:0,pending:0,unproved:false}}]);
const clean = () => { const observer=createLoopbackDiagnostics();observer.observerStopped();sample(observer);return observer.snapshot(); };
const gate = (j,a) => assessLoopbackDiagnostic(j,a,sanitizeLoopbackDiagnostics);
const outcome = (issues=[]) => assessLoopbackOutcome({result:{status:'passed',errors:[]},
    globalErrors:[],command:{schema:1,exitCode:0},stepOutcome:'success',issues});
const both = gate(clean(),clean());
assert.equal(both.diagnostic.reconciliation,'same'); assert.equal(outcome(both.issues).passed,true);
checks.push('complete clean evidence permits a passing command/result');
const owner=createLoopbackDiagnostics();
owner.observerStopped();sample(owner);
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
const failedObserver=clean();failedObserver.passive.failed=true;
assert.equal(outcome(gate(clean(),failedObserver).issues).passed,false);
checks.push('observer failure refuses passed receipt');
const stillOpen=clean();stillOpen.passive.stopped=false;
assert.equal(outcome(gate(clean(),stillOpen).issues).passed,false);
assert.equal(outcome(gate(stillOpen,clean()).issues).passed,true);
checks.push('final attachment must acknowledge detachment; earlier journal may precede it');
const observed=createLoopbackDiagnostics();sample(observed);const earlier=observed.snapshot();
observed.observe('snapshot-status-2xx');observed.observe('snapshot-finished');
observed.observe('history-worker-created');observed.observe('history-worker-closed');observed.observerStopped();
const later=gate(earlier,observed.snapshot());assert.equal(later.diagnostic.reconciliation,'different');
assert.equal(later.diagnostic.attachment.passive.counts['history-worker-closed'],1);
assert.equal('validHistory' in later.diagnostic.attachment.passive,false);
assert.equal(outcome(later.issues).passed,true);
checks.push('passive counters survive reconciliation without inventing valid history');
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
{
 const missing=clean();missing.commands=null;assert.equal(outcome(gate(clean(),missing).issues).passed,false);
 const unknown=clean();unknown.commands.unproved=true;assert.equal(outcome(gate(clean(),unknown).issues).passed,false);
 checks.push('missing or unproved completion accounting refuses passed evidence');
}
{
 for(const changes of [{pending:true},{completed:NaN},{started:2}]){
  const value=clean();Object.assign(value.commands,changes);assert.equal(outcome(gate(clean(),value).issues).passed,false);
 }
 checks.push('malformed counters or conservation mismatch cannot pass');
}
{
 const observed=createLoopbackDiagnostics();sample(observed);observed.observerStopped();
 observed.caseFailure({commandCounts:{started:1,completed:0,timedOut:0,failed:1,pending:0,unproved:true}});
 const value=gate(clean(),observed.snapshot());assert.equal(outcome(value.issues).passed,false);
 const cleanValue=clean();cleanValue.commands.command='SECRET';cleanValue.commands.id='SECRET';
 assert.equal(JSON.stringify(gate(cleanValue,cleanValue)).includes('SECRET'),false);
 checks.push('earlier unknown settlement cannot be erased by later counts; only fixed numbers retained');
}
console.log(JSON.stringify({status:'passed',checks,count:checks.length,targetOrSDKExecuted:false}));
