import assert from 'node:assert/strict';
import test from 'node:test';
import { SOURCE,TITLES,MAX_RAW,MAX_PROJECTION,MAX_LOG,project,encode,frame,parseLog,validateSuccess } from './cleanup-log-receipt.mjs';
const aa='10000000-0000-4000-8000-000000000217',bb='20000000-0000-4000-8000-000000000217';
const serial={acquireRequests:2,grants:[aa,bb],releaseRequests:[aa,aa,bb],acknowledged:[aa,bb],hostEffects:2,hostLease:null,grantPending:false,retryPending:false,opens:1,closes:1,writes:0,sshConnects:0};
const consoleState={schema:1,boundary:'mock-local-client',reads:2,opens:1,commands:['FAIL_ONCE'],finishes:2,retryPending:false,retryAcknowledged:true,ownerReleased:1,activityAcquires:1,activityReleases:1,catalogLists:3,calls:8,leaseHeld:false};
const expected=()=>({source:SOURCE,tooling:'a'.repeat(40),run:'12345',attempt:'1',producerJobId:'23456',receiptJobId:'34567'});
const service=()=>({...expected(),workflowStatus:'completed',producerStatus:'completed',receiptStatus:'completed',sdkStatus:'completed',workflowConclusion:'success',producerConclusion:'success',receiptConclusion:'success',sdkConclusion:'success'});
function raw(){
 return {source:SOURCE,tooling:'a'.repeat(40),run:'12345',attempt:'1',command:{schema:1,exitCode:0},sdkStepOutcome:'success',
 report:{errors:[],stats:{expected:2,unexpected:0,skipped:0,flaky:0},suites:[{specs:Object.entries(TITLES).map(([file,title])=>({
 file,title,ok:true,tests:[{expectedStatus:'passed',status:'expected',results:[{status:'passed',retry:0,errors:[],
 attachments:[{name:file.startsWith('activity-')?'activity-release-retry-observation':'cleanup-retry-summary',contentType:'application/json',
 body:Buffer.from(JSON.stringify(file.startsWith('activity-')?serial:consoleState)).toString('base64')}]}]}]}))}]}};
}
test('one lossless bounded qualification projection roundtrips a receipt-only timestamped log',()=>{
 const e=encode(raw()),line=frame(e),v=parseLog('2026-11-04T00:00:00.1234567Z '+line+'\n');
 assert.equal(v.receiptSHA256,e.digest);assert.equal(v.receiptBytes,e.bytes);
 assert.equal(validateSuccess(v.receipt,expected(),service()).passed,2);
 assert.ok(e.bytes<MAX_PROJECTION);assert.equal(project(raw()).report.suites[0].specs.length,2);
});
test('global teardown errors survive projection and cannot be masked by empty result errors',()=>{
 const x=raw();x.report.errors=[{message:'synthetic teardown failure',detail:'preserved'}];
 const p=project(x);assert.deepEqual(p.report.errors,x.report.errors);
 assert.throws(()=>validateSuccess(p,expected(),service()),/GLOBAL_ERROR/);
});
test('case primary error survives alongside empty errors and rejects acceptance',()=>{
 const x=raw();x.report.suites[0].specs[0].tests[0].results[0].error={message:'primary failure'};
 const p=project(x);assert.equal(p.report.suites[0].specs[0].tests[0].results[0].error.message,'primary failure');
 assert.throws(()=>validateSuccess(p,expected(),service()),/CASE_FAILURE/);
});
test('nonzero missing or cancelled SDK outcomes never become a successful projection',()=>{
 for(const change of [x=>x.command.exitCode=1,x=>delete x.command,x=>x.sdkStepOutcome='cancelled']){
  const x=raw();change(x);const p=project(x);assert.throws(()=>validateSuccess(p,expected(),service()),/SDK/);
 }
});
test('incomplete duplicate unknown failed skipped and retry results remain failures',()=>{
 for(const change of [x=>x.report.suites[0].specs.pop(),x=>x.report.suites[0].specs.push(x.report.suites[0].specs[0]),
 x=>x.report.suites[0].specs[0].file='automation.spec.ts',
 x=>x.report.suites[0].specs[0].tests[0].results[0].status='failed',
 x=>x.report.stats.skipped=1,x=>x.report.suites[0].specs[0].tests[0].results[0].retry=1]){
  const x=raw();change(x);assert.throws(()=>validateSuccess(project(x),expected(),service()));
 }
});
test('both independently observed jobs and exact run attempt source tooling must match',()=>{
 const p=project(raw());
 for(const key of ['run','attempt','source','tooling','producerJobId','receiptJobId']){
  assert.throws(()=>validateSuccess(p,expected(),{...service(),[key]:'999'}),/SERVICE_ID/);
  const missing=service();delete missing[key];assert.throws(()=>validateSuccess(p,expected(),missing));
 }
 assert.throws(()=>validateSuccess(p,{...expected(),receiptJobId:expected().producerJobId},service()),/EXPECTED/);
 for(const key of ['workflowConclusion','producerConclusion','receiptConclusion','sdkConclusion'])
  assert.throws(()=>validateSuccess(p,expected(),{...service(),[key]:'failure'}),/SERVICE_FAILURE/);
 assert.throws(()=>validateSuccess(p,expected(),{...service(),producerStatus:'in_progress'}),/SERVICE_PENDING/);
});
test('publication before later failed producer or receipt teardown cannot pass',()=>{
 const p=parseLog(frame(encode(raw()))).receipt;
 assert.throws(()=>validateSuccess(p,expected(),{...service(),producerConclusion:'failure'}));
 assert.throws(()=>validateSuccess(p,expected(),{...service(),receiptConclusion:'failure'}));
});
test('held cleanup custody or lost observations cannot be replaced by a passed case status',()=>{
 const x=raw();let a=x.report.suites[0].specs[1].tests[0].results[0].attachments[0];
 a.body=Buffer.from(JSON.stringify({...consoleState,leaseHeld:true,ownerReleased:0})).toString('base64');
 assert.throws(()=>validateSuccess(project(x),expected(),service()),/OWNER_NOT_RETIRED/);
 const y=raw();y.report.suites[0].specs[0].tests[0].results[0].attachments=[];
 assert.throws(()=>validateSuccess(project(y),expected(),service()),/OBSERVATION/);
});
test('unexpected or oversized attachments fail instead of silent dropping',()=>{
 const x=raw();x.report.suites[0].specs[0].tests[0].results[0].attachments.push({name:'unexpected',contentType:'application/json',body:'e30='});
 assert.throws(()=>project(x),/ATTACHMENT/);
 const y=raw();y.report.suites[0].specs[0].tests[0].results[0].attachments[0].body=Buffer.alloc(4097).toString('base64');
 assert.throws(()=>project(y),/ATTACHMENT/);
});
test('raw and projection caps refuse oversized evidence without truncation',()=>{
 const x=raw();x.extra='x'.repeat(MAX_RAW);assert.throws(()=>project(x),/RAW_CAP/);
 const y=raw();y.report.errors=[{message:'x'.repeat(MAX_PROJECTION)}];assert.throws(()=>project(y),/PROJECTION_CAP/);
});
test('missing duplicate redacted truncated corrupt or changed frame is unqualified',()=>{
 const e=encode(raw()),line=frame(e);
 for(const log of ['',line+'\n'+line,line.replace(e.digest,'0'.repeat(64)),line.slice(0,-7),
 line.replace(e.payload,'***'),line.replace(e.payload,e.payload.slice(0,-4)+'AAAA')]) assert.throws(()=>parseLog(log));
 assert.throws(()=>parseLog('x'.repeat(MAX_LOG+1)),/LOG_CAP/);
});
test('script echo text is not evidence and receipt hash is over actual decoded bytes',()=>{
 const e=encode(raw());assert.throws(()=>parseLog("printf '"+frame(e)+"'\n"),/FRAME_COUNT/);
 assert.throws(()=>parseLog(frame(e).replace(' '+e.bytes+' ',' '+(e.bytes+1)+' ')),/FRAME_INTEGRITY/);
});
