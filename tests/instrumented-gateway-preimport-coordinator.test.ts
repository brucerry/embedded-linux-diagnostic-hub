import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {preimportMemory} from './fixtures/gateway-preimport-memory';
import {startPreimportCompatibility,PREIMPORT_RECEIPT_MARKER} from '../scripts/lib/instrumented-gateway-preimport-coordinator.mjs';
import {readPreimportCompatibilityReceipt} from '../scripts/lib/instrumented-gateway-preimport-receipt.mjs';
import {observedLifecycle} from './fixtures/gateway-producer-memory';
import {startInstrumentedChildOutput} from '../scripts/lib/instrumented-gateway-output.mjs';
import {EventEmitter} from 'node:events';
const until=async(predicate:()=>boolean)=>{for(let i=0;i<30000&&!predicate();i++)await Promise.resolve();assert.ok(predicate(),'Bounded fake event not reached');};
const pulse=async()=>{for(let i=0;i<1000;i++)await Promise.resolve();};
async function setup(mode='compatibility'){
 const f=await preimportMemory(mode),controls:any={},events:string[]=[],timers:any[]=[],writes:Buffer[]=[];let failure=0,clear=0,deadlineClear=0,writeCallback:Function|undefined;
 const stream=new EventEmitter() as any;stream.write=(bytes:Buffer,callback:Function)=>{writes.push(Buffer.from(bytes));writeCallback=callback;if(!controls.holdOutput)callback(controls.outputError?Error('authored write error'):undefined);return true;};
 const ports:any={...f.ports,startHold(){events.push('hold');if(controls.badHold)return controls.badHold;return{};},clearHold(){events.push('clear-hold');clear++;if(controls.badClear)return Promise.resolve();},
  setTimer(fn:Function,ms:number){const t={fn,ms};timers.push(t);if(ms===60000){events.push('deadline');if(controls.badDeadline)return controls.badDeadline;}return t;},clearTimer(t:any){assert.ok(t);events.push('clear-timer:'+t.ms);if(t.ms===60000)deadlineClear++;},
  prepareContainmentClose(failed:boolean){events.push('guard:'+failed);if(controls.guardClose)throw Error('authored guard unknown');},assertContainmentClosed(){},setFailure(){failure++;},
  writeOutput(bytes:Buffer){events.push('output');return startInstrumentedChildOutput(bytes,stream,()=>{failure++;});},
 };
 const start=()=>startPreimportCompatibility(f.inputPath,ports);
 return{f,controls,ports,events,timers,writes,stream,start,releaseOutput(){writeCallback!();},expire(){timers.find(t=>t.ms===60000).fn();},get failure(){return failure;},get clears(){return clear;},get deadlineClears(){return deadlineClear;},record(){return JSON.parse(writes[0].toString().slice(PREIMPORT_RECEIPT_MARKER.length));}};
}
test('coordinator starts root hold/deadline before IO, uses one Session and acknowledges output before retiring',async()=>{
 const t=await setup();t.controls.holdOutput=true;const o=t.start();await until(()=>t.writes.length===1);assert.deepEqual(t.events.slice(0,2),['hold','deadline']);assert.equal(t.clears,0);assert.equal(t.f.factories,1);assert.equal(t.record().status,'completed-local-compatibility');let done=false;o.result.then(()=>{done=true;});await pulse();assert.equal(done,false);t.releaseOutput();await o.result;await o.closed;assert.equal(t.clears,1);assert.equal(t.deadlineClears,1);assert.equal(t.failure,0);assert.equal(t.f.events.filter(x=>x==='disconnect').length,1);
});
test('deadline during pending input reports once and fences late Session/import; only acknowledged IO may retire',async()=>{
 const t=await setup();t.f.controls.readHeld=true;const o=t.start(),bad=assert.rejects(o.result);t.expire();await bad;await o.reported;assert.equal(t.record().identity,null);assert.equal(t.clears,0);t.f.reads.resolve();await o.closed;assert.equal(t.clears,1);assert.equal(t.f.factories,0);assert.equal(t.writes.length,1);
});
test('deadline during held enable reports promptly but retains actual Session until callback/disable joins',async()=>{
 const t=await setup();t.f.controls.holdEnable=true;const o=t.start(),bad=assert.rejects(o.result);await until(()=>t.f.factories===1);t.expire();await bad;await o.reported;assert.equal(t.clears,0);assert.equal(t.f.imports,0);t.f.enable.resolve();await o.closed;assert.equal(t.clears,1);assert.equal(t.f.imports,0);assert.equal(t.writes.length,1);
});
test('cancel while async initialization pending does not infer retirement or replay factory',async()=>{
 const t=await setup();t.f.controls.holdReady=true;const o=t.start(),bad=assert.rejects(o.result);await until(()=>t.f.imports===1);o.cancel();await bad;await o.reported;assert.equal(t.clears,0);t.f.ready.resolve();await o.closed;assert.equal(t.f.imports,1);assert.equal(t.f.factories,1);assert.equal(t.clears,1);
});
for(const kind of ['importThrows','readyRejected'])test('failed initialization '+kind+' retains root custody after bounded failure receipt',async()=>{
 const t=await setup();t.f.controls[kind]=true;const o=t.start();await assert.rejects(o.result);await o.reported;await pulse();assert.equal(t.clears,0);assert.equal(o.snapshot().localRetired,false);assert.equal(t.writes.length,1);assert.equal(t.record().releaseAcceptance,false);
});
test('cancellation after dispatching success bytes cannot become a successful result or dispatch another write',async()=>{
 const t=await setup();t.controls.holdOutput=true;const o=t.start(),bad=assert.rejects(o.result);await until(()=>t.writes.length===1);o.cancel();await bad;assert.equal(t.record().status,'completed-local-compatibility');assert.ok(t.failure>0);assert.equal(t.clears,0);t.releaseOutput();await o.closed;assert.equal(o.snapshot().failed,true);assert.equal(t.writes.length,1);
});
for(const effect of ['outputError','badClear','guardClose'])test('unacknowledged '+effect+' never claims closed or clears root twice',async()=>{
 const t=await setup();t.controls[effect]=true;const o=t.start();await assert.rejects(o.result);await pulse();assert.equal(o.snapshot().finished,false);assert.ok(t.clears<2);assert.equal(t.writes.length,1);
});
for(const method of ['badHold','badDeadline'])for(const shape of ['promise','thenable','getter'])test('unknown '+method+' '+shape+' remains held without invoking getters',async()=>{
 const t=await setup();let calls=0;t.controls[method]=shape==='promise'?Promise.resolve({}):shape==='thenable'?{then(){calls++;}}:Object.defineProperty({},'then',{get(){calls++;throw Error('must not invoke');}});const o=t.start();await assert.rejects(o.result);await o.reported;await pulse();assert.equal(o.snapshot().unknown,true);assert.equal(t.clears,0);assert.equal(calls,0);assert.equal(t.f.factories,0);
});
for(const mutate of [
 (v:any)=>{v.earlyArtifactSHA256='PRIVATE_CANARY';},(v:any)=>{v.earlyArtifactSHA256={secret:'PRIVATE_CANARY'};},(v:any)=>{v.earlyArtifactSHA256='PRIVATE_CANARY'.repeat(100000);},
 (v:any)=>{v.child.binding.source.secret='PRIVATE_CANARY';},(v:any)=>{v.child.binding.source.sourceCommit='PRIVATE_CANARY';},(v:any)=>{v.child.selection.artifactSHA256={secret:'PRIVATE_CANARY'};},
])test('malformed projected identity never leaks arbitrary input to failure receipt',async()=>{
 const t=await setup();const value=structuredClone(t.f.outer);mutate(value);t.ports.readInput=async()=>Buffer.from(JSON.stringify(value)+'\n');const o=t.start();await assert.rejects(o.result);await o.reported;await o.closed;assert.equal(t.record().identity,null);assert.ok(t.writes[0].length<=16384);assert.equal(t.writes[0].includes(Buffer.from('PRIVATE_CANARY')),false);assert.equal(t.f.factories,0);
});
test('ownership cannot be silently enabled by compatibility coordinator',async()=>{
 const t=await setup('ownership'),o=t.start();await assert.rejects(o.result);await o.closed;assert.equal(t.f.factories,0);assert.equal(t.record().identity,null);
});
test('native activation owns deadline before early imports and transfers same hold/timer without fresh budget',()=>{
 const text=readFileSync(new URL('./fixtures/instrumented-gateway-preimport-activate.cjs',import.meta.url),'utf8'),entry=readFileSync(new URL('./fixtures/instrumented-gateway-preimport-entry.mjs',import.meta.url),'utf8');
 const order=(s:string,a:string,b:string)=>{const x=s.indexOf(a),y=s.indexOf(b);assert.ok(x>=0&&y>x);};order(text,'const deadline=setTimeout',"require('./resolution-guard.cjs')");order(text,'const hold=setInterval','const deadline=setTimeout');assert.throws(()=>order(text.replace('const deadline=setTimeout',''),'const deadline=setTimeout',"require('./resolution-guard.cjs')"));assert.ok(text.includes('assert.equal(expired,false)'));assert.ok(text.includes('return deadline;'));assert.ok(entry.includes('holdPorts.startDeadline(callback,ms)'));assert.ok(!text.includes("require('./ownership.cjs')"));assert.ok(!entry.includes("from '../../gateway/server'"));
});

test('parent readback requires terminal success, exact challenge and closed direct pipes as well as printed success',async()=>{
 const t=await setup(),o=t.start();await o.result;await o.closed;const life=await observedLifecycle(),bytes=Buffer.from(JSON.stringify(t.f.outer)+'\n'),direct={spawned:true,exited:true,closed:true,pid:life.pid,inputAck:true,inputFinish:true,inputClosed:true,stdoutClosed:true,stderrClosed:true,listeners:0,unknownOperations:0,primaryFailure:false,diagnostics:0,directRetired:true,processGroupRetirement:null};
 assert.equal(readPreimportCompatibilityReceipt(t.writes[0],Buffer.alloc(0),bytes,t.ports.root,life,direct).releaseAcceptance,false);
 for(const mutate of [(v:any)=>v.code=1,(v:any)=>v.closeObserved=false,(v:any)=>v.timedOut=true,(v:any)=>v.terminationRequested=true]){const v=structuredClone(life);mutate(v);assert.throws(()=>readPreimportCompatibilityReceipt(t.writes[0],Buffer.alloc(0),bytes,t.ports.root,v,direct));}
 for(const key of ['spawnObserved','exitObserved','closeObserved'])for(const value of ['false',1,undefined])assert.throws(()=>readPreimportCompatibilityReceipt(t.writes[0],Buffer.alloc(0),bytes,t.ports.root,{...life,[key]:value},direct));
 assert.throws(()=>readPreimportCompatibilityReceipt(t.writes[0],Buffer.alloc(0),bytes,t.ports.root,life,{...direct,directRetired:false}));
 for(const key of ['spawned','exited','closed','inputAck','inputFinish','inputClosed','stdoutClosed','stderrClosed','primaryFailure','unknownOperations','listeners','diagnostics','pid']){for(const value of [undefined,key==='primaryFailure'?true:false])assert.throws(()=>readPreimportCompatibilityReceipt(t.writes[0],Buffer.alloc(0),bytes,t.ports.root,life,{...direct,[key]:value}));}
 const changed=structuredClone(t.f.outer);changed.child.nonce='0'.repeat(32);assert.throws(()=>readPreimportCompatibilityReceipt(t.writes[0],Buffer.alloc(0),Buffer.from(JSON.stringify(changed)+'\n'),t.ports.root,life,direct));
 assert.throws(()=>readPreimportCompatibilityReceipt(Buffer.concat([t.writes[0],t.writes[0]]),Buffer.alloc(0),bytes,t.ports.root,life,direct));
});

test('a live async Wasm notification without creator proof still fails compatibility',async()=>{
 const t=await setup();t.f.controls.holdReady=true;const o=t.start(),bad=assert.rejects(o.result);await until(()=>t.f.imports===1);t.f.session.emit('Debugger.scriptParsed',{params:{scriptId:'authored-async-wasm',url:'wasm://wasm/authored',scriptLanguage:'WebAssembly',executionContextId:0}});t.f.ready.resolve();await bad;await o.reported;await o.closed;assert.equal(t.record().status,'failed-or-held');assert.equal(t.record().receipt,null);assert.equal(t.record().failure.observer.inspectorFailure,'script-unadmitted');assert.equal(t.writes[0].includes(Buffer.from('wasm://wasm/authored')),false);assert.equal(t.f.factories,1);assert.equal(t.f.imports,1);assert.equal(t.f.products,0);assert.equal(t.clears,1);
});
