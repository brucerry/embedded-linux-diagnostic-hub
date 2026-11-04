import assert from 'node:assert/strict';
import {ProbeObservation} from '../backend/ssh/probe-observation';
import {projectProbeObservation} from './ui/fixtures/loopback-probe-observation';
import {createLoopbackDiagnostics,sanitizeLoopbackDiagnostics} from './ui/fixtures/loopback-diagnostics';

const checks:string[]=[];
{
 const a=new ProbeObservation(),b=new ProbeObservation(),one=a.begin(),two=a.begin(),other=b.begin();
 one('completed');assert.deepEqual(a.snapshot,{started:2,completed:1,timedOut:0,failed:0,pending:1,unproved:false});
 other('timedOut');assert.equal(a.snapshot.pending,1);two('failed');
 const total=projectProbeObservation([{probeCommands:a.snapshot},{probeCommands:b.snapshot}]);
 assert.deepEqual(total,{started:3,completed:1,timedOut:1,failed:1,pending:0,unproved:false});
 checks.push('disjoint completion/deadline/error counts and separate owner custody');
}
{
 const a=new ProbeObservation(),done=a.begin();done('timedOut');done('completed');
 assert.deepEqual(a.snapshot,{started:1,completed:0,timedOut:1,failed:0,pending:0,unproved:true});
 checks.push('duplicate/late terminal observation cannot move a timed-out command into completed');
}
{
 const a=new ProbeObservation(2);a.begin();a.begin();a.begin();assert.equal(a.snapshot.started,2);assert.equal(a.snapshot.unproved,true);
 const snap=a.snapshot;snap.pending=0;assert.equal(a.snapshot.pending,2);
 checks.push('bounded counters flag saturation and return detached values');
}
{
 assert.equal(projectProbeObservation([]),null);assert.equal(projectProbeObservation(undefined),null);
 const good={started:1,completed:0,timedOut:0,failed:0,pending:1,unproved:false};
 for(const bad of [{...good,pending:true},{...good,started:Infinity},{...good,unproved:'false'}])assert.equal(projectProbeObservation([{probeCommands:bad}]),null);
 assert.equal(projectProbeObservation([{probeCommands:{...good,completed:1}}])!.unproved,true);
 assert.deepEqual(projectProbeObservation([{probeCommands:{...good,command:'discard',id:'discard'}}]),good);
 checks.push('malformed, absent and inconsistent accounting fails closed without retaining extra fields');
}
{
 const a=new ProbeObservation(),done=a.begin(),diag=createLoopbackDiagnostics();
 diag.caseFailure({commandCounts:a.snapshot});diag.sampleCommands([{probeCommands:a.snapshot}]);done('completed');
 const first=diag.snapshot();assert.equal(first.firstCaseFailure.commandCounts.pending,1);assert.equal(first.commands.pending,1);
 assert.deepEqual(sanitizeLoopbackDiagnostics(first),first);
 assert.equal(JSON.stringify(first).includes('discard'),false);assert.ok(Buffer.byteLength(JSON.stringify(first))<8192);
 checks.push('first-failure and before-cleanup samples remain frozen; projection roundtrip and byte cap');
}
console.log(JSON.stringify({status:'passed',checks,count:checks.length,targetRuntimeExecuted:false}));
