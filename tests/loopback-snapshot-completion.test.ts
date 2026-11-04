import assert from 'node:assert/strict';
import {snapshotCompletion,SNAPSHOT_WAIT_MS} from './ui/fixtures/loopback-snapshot-completion';
import {createLoopbackDiagnostics} from './ui/fixtures/loopback-diagnostics';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const make=(completed=49)=>({commandCounts:{started:52,completed,timedOut:0,failed:0,pending:52-completed,unproved:false},diagnostic:createLoopbackDiagnostics().snapshot()});
const complete=(x:ReturnType<typeof make>)=>{x.diagnostic.passive.counts['snapshot-status-2xx']=1;x.diagnostic.passive.counts['snapshot-finished']=1;return x;};
const checks:string[]=[];
{
 const state=make();assert.equal(snapshotCompletion(state),'pending');state.commandCounts.completed=52;state.commandCounts.pending=0;
 assert.equal(snapshotCompletion(state),'pending');state.diagnostic.passive.counts['snapshot-status-2xx']=1;
 assert.equal(snapshotCompletion(state),'pending');state.diagnostic.passive.counts['snapshot-finished']=1;assert.equal(snapshotCompletion(state),'complete');
 checks.push('49/52 pending transitions through all closes and transport completion without treating starts or status alone as completion');
}
{
 for(const kind of ['timedOut','failed'] as const){const state=complete(make());state.commandCounts[kind]=1;state.commandCounts.pending=2;assert.equal(snapshotCompletion(state),'probe-error');}
 const state=complete(make(52));state.diagnostic.passive.counts['snapshot-status-5xx']=1;assert.equal(snapshotCompletion(state),'snapshot-error');
 state.diagnostic.passive.counts['snapshot-status-5xx']=0;state.diagnostic.passive.counts['snapshot-finish-failed']=1;assert.equal(snapshotCompletion(state),'snapshot-error');
 checks.push('transport failure and deadline/error results stop the pending wait with a failing fixed status');
}
{
 const state=complete(make(52));state.diagnostic.passive.counts['snapshot-status-2xx']=2;assert.equal(snapshotCompletion(state),'unexpected-snapshot');
 state.diagnostic.passive.counts['snapshot-status-2xx']=1;state.commandCounts.started=53;state.commandCounts.completed=53;assert.equal(snapshotCompletion(state),'unexpected-snapshot');
 assert.equal(snapshotCompletion(complete(make())),'invalid-observation');
 checks.push('duplicates, extra command admission and premature response completion refuse success');
}
{
 const state=complete(make(52));for(const field of ['overflow'] as const){state.diagnostic[field]=true;assert.equal(snapshotCompletion(state),'invalid-observation');state.diagnostic[field]=false;}
 state.diagnostic.passive.failed=true;assert.equal(snapshotCompletion(state),'invalid-observation');state.diagnostic.passive.failed=false;
 state.commandCounts.unproved=true;assert.equal(snapshotCompletion(state),'invalid-observation');
 assert.equal(snapshotCompletion(undefined),'invalid-observation');
 checks.push('missing/malformed or unproved/overflowed observation cannot become complete');
}
{
 const state=complete(make(52)),before=JSON.stringify(state);assert.equal(snapshotCompletion(state),'complete');assert.equal(JSON.stringify(state),before);
 assert.equal(snapshotCompletion({...state,commandCounts:null}),'pending');assert.equal(SNAPSHOT_WAIT_MS,15000);
 checks.push('predicate is read-only and absent early session counters remain bounded pending evidence');
}
{
 const source=readFileSync(path.join(__dirname,'ui/loopback-console.spec.ts'),'utf8');
 const click=source.indexOf("await modal.getByRole('button', { name: 'Connect via SSH' }).click();"),poll=source.indexOf('await expect.poll(() => {'),assertion=source.indexOf('await expect(modal).not.toBeVisible();');
 assert.ok(click<poll&&poll<assertion);assert.ok(source.includes("expect(completion).toBe('complete');"));
 assert.equal((source.match(/snapshotCompletion\(owner.snapshot\(\)\)/g)??[]).length,1);
 assert.ok(source.includes('{timeout: SNAPSHOT_WAIT_MS, intervals: [100, 250, 500]}'));
 checks.push('actual spec waits on metadata then retains the original five-second modal assertion without repeating Connect');
}
console.log(JSON.stringify({status:'passed',checks,count:checks.length,hostedBrowserOrTimersExecuted:false}));
