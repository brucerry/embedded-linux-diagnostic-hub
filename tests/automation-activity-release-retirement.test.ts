import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ActivityReleaseQueue } from '../src/features/automation/activity-release';
import { bindPage, boundSpan, activityReleaseSpan, type PageContext } from './fixtures/automation-page-arm-callbacks';
import { bindPageRunnerChanged } from './fixtures/automation-page-runner-change';
import { bindHeader, clockSpans } from './fixtures/header-clock-callbacks';
import { FlowRunner, type FlowBackend, type FlowState, type RunClock } from '../src/features/automation/runner';
import type { AutomationPlan } from '../shared/automation';
import type { FlowInspection } from '../src/features/automation/flow/inspection';
const pageText=readFileSync('src/features/automation/AutomationPage.tsx','utf8');
assert.ok(pageText.includes(boundSpan));assert.ok(pageText.includes(activityReleaseSpan));
assert.ok(pageText.includes("(!runner.current?.busy && activityFailure) ? 'Retry cleanup'"));
const hookText=readFileSync('src/hooks/useDeviceClock.ts','utf8');assert.ok(hookText.includes(clockSpans[2]));
const changedText=readFileSync('tests/fixtures/automation-page-runner-change.ts','utf8');
const changedSpan=changedText.slice(changedText.indexOf('            (next) => {'),changedText.indexOf('    ];')).trimEnd();
assert.ok(changedSpan.length>100&&pageText.includes(changedSpan));
async function until(check:()=>boolean){for(let n=0;n<256;n++){if(check())return;await Promise.resolve();}assert.fail('Bounded Promise turns exhausted.');}
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};}
for(const stage of ['normal-finally','transport-retry','pre-arm-cancel','no-flow-finalizer'] as const)
for(const effect of ['not-applied','applied-reply-lost'] as const)
test('Page retains and explicitly retries '+stage+' host release '+effect,async()=>{
 const clockReservation={current:null as symbol|null};let headerState:any={status:'unavailable',sample:null};let intervals=0,clears=0;
 const header=bindHeader({generation:1,transport:{},reset:0,blocked:false,visible:true,
  retained:{current:{sample:null}},flight:{current:null},queued:{current:null},refresh:{current:null},observed:{current:{uptime:null}},
  document:{visibilityState:'visible'},reservation:clockReservation,setState:(v:any)=>{headerState=typeof v==='function'?v(headerState):v;},
  setInterval:()=>{intervals++;return 1;},clearInterval:(id:number)=>{assert.equal(id,1);clears++;}});
 const criterion={role:'shell-prompt' as const,literals:['memory# ']};
 const plan:AutomationPlan={transport:'ssh',ssh:{mode:'console',ready:criterion,completion:criterion},
  steps:[{id:'only-step',name:'No command admitted',enabled:true,command:'never executed',delaySeconds:0,ssh:{intent:'script'}}],
  timeoutSeconds:10,repeatSeconds:null,start:null,serial:{lineEnding:'CR',prompt:'',timestampPrefix:''}};
 const ui:{running:boolean;error:string;activityFailure:string;state:FlowState;inspection:FlowInspection|null;busy:boolean[]}={running:false,error:'',activityFailure:'',state:{state:'idle',message:'Ready'},inspection:null,busy:[]};
 const lease='memory-release-owner-0001',liveLeases=new Set<string>(),retry=gate(),acquisition=gate();
 let releaseCalls=0,acquires=0,backendCloses=0,catalogHeld=false,catalogResumes=0,executions=0;
 const fault=Error('Synthetic host activity-release acknowledgement lost.');
 const clock:RunClock={local:()=>Date.UTC(2028,1,29),mono:()=>0,watch:()=>()=>{},sleep:async()=>{throw Error('No real wait admitted.');}};
 const transport={automationConnection:()=> 'memory-release-connection-0001'};
 const ctx:any={cleanupClock:{current:undefined},pendingClockSamples:{current:0},manualClockSample:{current:null},runner:{current:null},
  arming:{current:false},armAttempt:{current:null},activityEpoch:{current:0},flowInspectionId:{current:null},cleanupActivity:{current:undefined},cleanupConsoleResults:{current:undefined},
  consoleResultsAdmission:{current:{async quiesce(){assert.equal(catalogHeld,false);catalogHeld=true;let done=false;return()=>{if(!done){done=true;catalogHeld=false;catalogResumes++;}};}}},
  props:{clockAdmission:{quiesce:header.quiesce},connected:true,transport,serial:{current:{generation:1,label:'unused'},framing:'unused'},target:{endpoint:'synthetic only'},busy:false,blocked:false,onBusy:(v:boolean)=>ui.busy.push(v)},
  latest:{current:{transport,connected:true,blocked:false,onBusy:(v:boolean)=>ui.busy.push(v)}},fieldIssues:[],focusIssue:()=>assert.fail(),build:()=>plan,hidden:false,connected:true,captureActionBusy:false,
  desktop:{async acquireAutomationActivity(){assert.equal(liveLeases.size,0);acquires++;liveLeases.add(lease);if(stage==='pre-arm-cancel')await acquisition.promise;return lease;},async releaseAutomationActivity(id:string){assert.equal(id,lease);releaseCalls++;if(releaseCalls===1){if(effect==='applied-reply-lost')liveLeases.delete(id);throw fault;}await retry.promise;liveLeases.delete(id);}},
  setActivityFailure:(v:string)=>{ui.activityFailure=v;},setError:(v:string)=>{ui.error=v;},setRunning:(v:boolean)=>{ui.running=v;},setState:(v:FlowState)=>{ui.state=v;},setFlowInspection:(v:any)=>{ui.inspection=typeof v==='function'?v(ui.inspection):v;},
  openCaptureRepository:async()=>assert.fail('No raw repository.'),openConsoleJournal:async()=>assert.fail('No browser journal.'),sample:async()=>assert.fail('No clock read.'),serialCaptureBackend:()=>assert.fail(),sshCaptureBackend:()=>assert.fail(),
  sshConsoleBackend:(...args:any[])=>{const backend:FlowBackend={target:{endpoint:'synthetic only'},connection:transport.automationConnection,available:()=>true,acquire:()=>()=>{},
   async prepare(_p,_s,check){check();await args[6]();throw Error('Synthetic initial readiness failure.');},async execute(){executions++;throw Error('No command admitted.');},
   async finishFlow(){if(++backendCloses===1&&stage==='transport-retry')throw Error('Synthetic transport cleanup unavailable.');return{failure:'Retained evidence failure after actual transport retirement.'};}};return stage==='no-flow-finalizer'?{...backend,finishFlow:undefined}:backend;}};
 const page=bindPage(ctx as PageContext);
 const changed=bindPageRunnerChanged({activityRetirements:ctx.activityRetirements,flowInspectionId:ctx.flowInspectionId,latest:ctx.latest,setState:ctx.setState,setFlowInspection:ctx.setFlowInspection,setRunning:ctx.setRunning});
 const runner=new FlowRunner(changed,()=>assert.fail('No record admitted.'),clock);ctx.runner.current=runner;
 try{
  const started=page.start();
  if(stage==='pre-arm-cancel'){await until(()=>acquires===1);page.cancel();acquisition.release();}
  await started;
  if(stage==='transport-retry'){assert.equal(runner.cleanupPending,true);page.cancel();}
  await until(()=>Boolean(ui.activityFailure));
  assert.equal(runner.cleanupPending,false);assert.equal(runner.busy,false);assert.equal(ctx.activityRetirements.current.hasFailures,true);
  assert.equal(ui.running,true);assert.equal(ui.busy.at(-1),true);assert.match(ui.activityFailure,/Synthetic host activity-release acknowledgement lost/);
  assert.equal(clockReservation.current!==null,stage==='pre-arm-cancel'||stage==='no-flow-finalizer');assert.equal(catalogHeld,stage==='no-flow-finalizer');assert.equal(catalogResumes,stage==='pre-arm-cancel'||stage==='no-flow-finalizer'?0:1);
  assert.match(ui.state.message,stage==='pre-arm-cancel'?/cancelled before arming/:stage==='no-flow-finalizer'?/Synthetic initial readiness failure/:/Retained evidence failure/);
  if(stage==='pre-arm-cancel'||stage==='no-flow-finalizer')await assert.rejects(header.quiesce(),/Wait for the current clock reader admission/);
  else {const clockAgain=await header.quiesce();clockAgain();}
  await page.start();assert.equal(acquires,1);assert.equal(executions,0);
  const closes=backendCloses;page.cancel();page.cancel();await until(()=>releaseCalls===2);
  assert.equal(ctx.activityRetirements.current.hasFailures,true);assert.equal(ui.running,true);assert.equal(catalogHeld,stage==='no-flow-finalizer');assert.equal(clockReservation.current!==null,stage==='pre-arm-cancel'||stage==='no-flow-finalizer');assert.equal(backendCloses,closes);
  retry.release();await until(()=>!ui.running&&!ctx.activityRetirements.current.hasFailures);
  assert.equal(ui.activityFailure,'');assert.equal(clockReservation.current,null);assert.equal(catalogHeld,false);assert.equal(catalogResumes,stage==='pre-arm-cancel'?0:1);assert.equal(liveLeases.size,0);
  assert.match(ui.state.message,stage==='pre-arm-cancel'?/cancelled before arming/:stage==='no-flow-finalizer'?/Synthetic initial readiness failure/:/Retained evidence failure after actual transport retirement/);assert.equal(executions,0);assert.equal(releaseCalls,2);
  page.cancel();for(let i=0;i<16;i++)await Promise.resolve();assert.equal(releaseCalls,2);
 }finally{acquisition.release();retry.release();header.cleanup?.();assert.equal(intervals,1);assert.equal(clears,1);}
});

test('release retries coalesce and an acknowledged attempt cannot release twice',async()=>{
 const messages:string[]=[],queue=new ActivityReleaseQueue(v=>messages.push(v)),retry=gate();let calls=0,resumes=0;
 const release=queue.create(async()=>{if(++calls===1)throw Error('first');await retry.promise;},[()=>{resumes++;}],true);
 await assert.rejects(release(),/first/);const first=queue.retryFailures(),second=queue.retryFailures();await until(()=>calls===2);assert.equal(queue.hasFailures,true);assert.equal(resumes,1);
 retry.release();await Promise.all([first,second]);await release();assert.equal(calls,2);assert.equal(resumes,1);assert.equal(queue.hasFailures,false);assert.equal(messages.at(-1),'');
});
test('a failed older release cannot complete an already admitted replacement host release',async()=>{
 const queue=new ActivityReleaseQueue(()=>{}),old=gate(),replacement=gate();let oldCalls=0,oldResumes=0,newResumes=0;
 const releaseOld=queue.create(async()=>{if(++oldCalls===1){await old.promise;throw Error('old reply lost');}},[()=>{oldResumes++;}],true);
 const releaseNew=queue.create(async()=>{await replacement.promise;},[()=>{newResumes++;}],true);
 let replacementDone=false;const first=releaseOld(),next=releaseNew();void next.then(()=>{replacementDone=true;});const observed=assert.rejects(first,/old reply lost/);old.release();await observed;await queue.retryFailures();
 assert.equal(oldResumes,1);assert.equal(newResumes,1);assert.equal(replacementDone,false);assert.equal(queue.hasFailures,false);replacement.release();await next;await releaseOld();assert.equal(oldResumes,1);assert.equal(newResumes,1);
});
test('a synchronous release failure survives reporting errors and can be explicitly retried',async()=>{
 const primary=Error('synchronous primary'),queue=new ActivityReleaseQueue(()=>{throw Error('reporter');});let calls=0;
 const release=queue.create(()=>{if(++calls===1)throw primary;return Promise.resolve();},[]);
 await assert.rejects(release(),error=>error===primary);assert.equal(queue.hasFailures,true);await queue.retryFailures();assert.equal(calls,2);assert.equal(queue.hasFailures,false);
});
test('local resume failure retains its stage without reissuing an acknowledged host release',async()=>{
 const queue=new ActivityReleaseQueue(()=>{});let host=0,first=0,second=0;
 const release=queue.create(async()=>{host++;},[()=>{first++;},()=>{if(++second===1)throw Error('resume');}]);
 await assert.rejects(release(),/resume/);await queue.retryFailures();assert.equal(host,1);assert.equal(first,1);assert.equal(second,2);assert.equal(queue.hasFailures,false);
});
test('falsy release failures remain blocked rather than being mistaken for acknowledgement',async()=>{
 for(const primary of [undefined,null,0,'']){
  const queue=new ActivityReleaseQueue(()=>{});let calls=0;const release=queue.create(async()=>{if(++calls===1)throw primary;},[]);
  await assert.rejects(release(),error=>error===primary);assert.equal(queue.hasFailures,true);await queue.retryFailures();assert.equal(queue.hasFailures,false);assert.equal(calls,2);
 }
});


test('host failure stays primary when local admission retirement also fails',async()=>{
 const hostError=Error('host primary'),localError=Error('local diagnostic');let host=0,local=0;
 const queue=new ActivityReleaseQueue(()=>{});
 const release=queue.create(async()=>{if(++host===1)throw hostError;},[()=>{if(++local===1)throw localError;}],true);
 await assert.rejects(release(),error=>error instanceof AggregateError&&error.cause===hostError&&error.errors[0]===hostError&&error.errors[1]===localError);
 assert.equal(queue.hasFailures,true);await queue.retryFailures();assert.equal(host,2);assert.equal(local,2);assert.equal(queue.hasFailures,false);
});


test('an unformattable release rejection preserves the primary value and visible recovery',async()=>{
 const primary={toString(){throw Error('secondary formatting error');}},messages:string[]=[];
 const queue=new ActivityReleaseQueue(v=>messages.push(v));let calls=0;
 const release=queue.create(async()=>{if(++calls===1)throw primary;},[]);
 await assert.rejects(release(),error=>error===primary);assert.equal(queue.hasFailures,true);
 assert.match(messages.at(-1)!,/release diagnostic could not be formatted/);
 await queue.retryFailures();assert.equal(queue.hasFailures,false);assert.equal(calls,2);
});
