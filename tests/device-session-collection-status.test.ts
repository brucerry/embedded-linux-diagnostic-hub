import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {ConnectionOperation} from '../src/services/connection-operation';
import {bind,spans,disposalSpan} from './fixtures/device-session-collection-callbacks';
const source=readFileSync('src/hooks/useDeviceSession.ts','utf8');for(const span of [...spans,disposalSpan])assert.ok(source.includes(span));
function gate(){let reject!:(error:Error)=>void;const promise=new Promise<never>((_r,no)=>{reject=no;});return{promise,reject};}
async function until(check:()=>boolean){for(let i=0;i<128;i++){if(check())return;await Promise.resolve();}assert.fail('Memory session did not settle in128microtasks');}
const key=['setTimeout','clearTimeout','setInterval','clearInterval'] as const;
for(const loss of ['unexpected','update','none','disposed'] as const)test(`initial collection failure preserves ${loss} connection diagnostic ownership`,async()=>{
  const descriptors=key.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));const pending=gate(),listeners=new Set<(reason?:'update')=>void>();let collections=0,auth=0,disconnects=0,resets=0;
  const original={endpoint:'previous.invalid:22',results:[{id:'wireless',stdout:'synthetic retained raw evidence'}]};const ui={connected:false,error:'',busy:false,connecting:false,snapshot:original,active:null as unknown,live:true,notice:''};
  const operation=new ConnectionOperation({set(){assert.fail('No retry timer expected');},clear(){assert.fail('No timer expected');}},()=> '1'.repeat(32));
  const bridge={async connect(){auth++;},async cancelConnect(){assert.fail('Successful handshake already settled');},async collect(){collections++;return pending.promise;},async disconnect(){disconnects++;},onDisconnected(f:(reason?:'update')=>void){listeners.add(f);return()=>listeners.delete(f);}};
  const ctx={resettingRef:{current:false},collectingRef:{current:false},disconnectingRef:{current:false},dataGeneration:{current:0},connectedRef:{current:false},connectionGeneration:{current:0},connectionOperation:{current:operation},connected:false,bridge,transport:bridge,liveRef:{current:true},livePreference:{current:true},idleWaiters:{current:new Set<()=>void>()},setConnecting:(x:boolean)=>{ui.connecting=x;},setConnectionProgress:(_x:string)=>{},setActiveDevice:(x:unknown)=>{ui.active=x;},setError:(x:string)=>{ui.error=x;},setConnected:(x:boolean)=>{ui.connected=x;},setGateway:()=>assert.fail('No Gateway'),setImported:()=>{},setUpdateReport:()=>{},setWorkspaceReady:()=>{},setBusy:(x:boolean)=>{ui.busy=x;},onResetView:()=>{resets++;},retainSnapshot:async()=>assert.fail('Rejected collection cannot replace retained evidence'),setLiveState:(x:boolean)=>{ui.live=x;},setNotice:(x:string)=>{ui.notice=x;},setShowConnect:()=>{}};
  const owner=bind(ctx);let finished=false;const work=owner.connect({host:'synthetic.invalid',port:22,username:'synthetic-user',auth:'password',password:'SYNTHETIC_PLACEHOLDER'}).then(()=>{finished=true;});
  try{
   await until(()=>collections===1);assert.equal(auth,1);assert.equal(ui.connected,true);assert.equal(ctx.collectingRef.current,true);assert.equal(operation.running,false);
   await owner.connect({host:'other.invalid',port:22,username:'synthetic-user',auth:'password'});assert.equal(auth,1);assert.equal(collections,1);
   if(loss==='disposed'){owner.dispose();ui.error='Newer owner diagnostic';}else if(loss!=='none')for(const notify of listeners)notify(loss==='update'?'update':undefined);
   assert.equal(ui.connected,loss==='none'||loss==='disposed');pending.reject(Error('Synthetic WLAN collection failure'));await work;assert.equal(finished,true);assert.strictEqual(ui.snapshot,original);assert.equal(ui.busy,false);assert.equal(ctx.collectingRef.current,false);assert.equal(ui.connecting,false);assert.equal(resets,1);
   if(loss==='disposed')assert.equal(ui.error,'Newer owner diagnostic');
   else if(loss==='none')assert.equal(ui.error,'SSH is connected, but diagnostic collection failed: Synthetic WLAN collection failure The previous snapshot, if any, is unchanged; collect again when ready.');
   else{assert.equal(ui.error,'SSH disconnected before diagnostic collection completed: Synthetic WLAN collection failure The previous snapshot, if any, is unchanged; reconnect to collect again.');assert.doesNotMatch(ui.error,/SSH is connected/);}
   assert.equal(ui.connected,loss==='none'||loss==='disposed');assert.equal(disconnects,loss==='unexpected'?1:0);assert.equal(operation.running,false);
  }finally{pending.reject(Error('Private gate final settlement'));await work;owner.unsubscribe?.();assert.equal(listeners.size,0);key.forEach((k,i)=>assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,k),descriptors[i]));}
});

function ackGate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
for(const loss of ['unexpected','none'] as const)test(`successful collection notice preserves ${loss} connection state after preparation`,async()=>{
  const descriptors=key.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));const pending=ackGate(),listeners=new Set<(reason?:'update')=>void>();let collections=0,auth=0,disconnects=0,resets=0,preparing=false;
  const original={endpoint:'previous.invalid:22',results:[{id:'wireless',stdout:'synthetic retained raw evidence'}]};const next={...original,endpoint:'newly-collected.invalid:22'};const ui={connected:false,error:'',busy:false,connecting:false,snapshot:original,active:null as unknown,live:true,notice:''};
  const operation=new ConnectionOperation({set(){assert.fail('No retry timer expected');},clear(){assert.fail('No timer expected');}},()=> '1'.repeat(32));
  const bridge={async connect(){auth++;},async cancelConnect(){assert.fail('Successful handshake already settled');},async collect(){collections++;return next;},async disconnect(){disconnects++;},onDisconnected(f:(reason?:'update')=>void){listeners.add(f);return()=>listeners.delete(f);}};
  const ctx={resettingRef:{current:false},collectingRef:{current:false},disconnectingRef:{current:false},dataGeneration:{current:0},connectedRef:{current:false},connectionGeneration:{current:0},connectionOperation:{current:operation},connected:false,bridge,transport:bridge,liveRef:{current:true},livePreference:{current:true},idleWaiters:{current:new Set<()=>void>()},setConnecting:(x:boolean)=>{ui.connecting=x;},setConnectionProgress:(_x:string)=>{},setActiveDevice:(x:unknown)=>{ui.active=x;},setError:(x:string)=>{ui.error=x;},setConnected:(x:boolean)=>{ui.connected=x;},setGateway:()=>assert.fail('No Gateway'),setImported:()=>{},setUpdateReport:()=>{},setWorkspaceReady:()=>{},setBusy:(x:boolean)=>{ui.busy=x;},onResetView:()=>{resets++;},retainSnapshot:async(data:typeof original)=>{preparing=true;await pending.promise;ui.snapshot=data;},setLiveState:(x:boolean)=>{ui.live=x;},setNotice:(x:string)=>{ui.notice=x;},setShowConnect:()=>{}};
  const owner=bind(ctx);let finished=false;const work=owner.connect({host:'synthetic.invalid',port:22,username:'synthetic-user',auth:'password',password:'SYNTHETIC_PLACEHOLDER'}).then(()=>{finished=true;});
  try{
   await until(()=>preparing);assert.equal(auth,1);assert.equal(ui.connected,true);assert.equal(ctx.collectingRef.current,true);assert.equal(operation.running,false);
   await owner.connect({host:'other.invalid',port:22,username:'synthetic-user',auth:'password'});assert.equal(auth,1);assert.equal(collections,1);
   if(loss==='unexpected')for(const notify of listeners)notify();
   assert.equal(ui.connected,loss==='none');pending.resolve();await work;assert.equal(finished,true);assert.strictEqual(ui.snapshot,next);assert.equal(ui.busy,false);assert.equal(ctx.collectingRef.current,false);assert.equal(ui.connecting,false);assert.equal(resets,1);
   assert.equal(ui.notice,loss==='none'?'SSH connected — diagnostic snapshot collected':'Diagnostic snapshot collected; SSH is disconnected.');assert.equal(ui.error,loss==='none'?'':'SSH closed unexpectedly. Reconnect to resume updates.');
   assert.equal(ui.connected,loss==='none');assert.equal(disconnects,loss==='unexpected'?1:0);assert.equal(operation.running,false);
  }finally{pending.resolve();await work;owner.unsubscribe?.();assert.equal(listeners.size,0);key.forEach((k,i)=>assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,k),descriptors[i]));}
});
