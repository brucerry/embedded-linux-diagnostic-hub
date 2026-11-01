import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFileSync} from 'node:fs';
import {bindCaptureCallbacks,boundSpans,type MemoryCaptureState,type CaptureCallbackContext} from './fixtures/capture-results-callbacks';
import {CaptureStorageError,type CaptureRepository} from '../shared/capture-store';
const keys=['setTimeout','clearTimeout','setInterval','clearInterval'] as const;
const timers=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
const source=readFileSync('src/features/automation/capture/StoredSerialResults.tsx','utf8');
for(const span of boundSpans)assert.equal(source.includes(span),true,'Actual capture callback span drifted; regenerate only after review.');
after(()=>keys.forEach((key,i)=>assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,key),timers[i])));
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};}
async function until(check:()=>boolean){for(let i=0;i<160;i++){if(check())return;await Promise.resolve();}assert.fail('Bounded memory callback did not settle.');}
function fixture(transport:'serial'|'ssh'='serial'){
 const state:MemoryCaptureState={failure:'',catalogFailure:'',notice:'',rows:[],next:null,loading:false,busy:false,selected:new Set(['capture-a','capture-b']),cursor:0,back:[],revision:0,confirmClear:true};
 const gates:ReturnType<typeof gate>[]=[];const calls={pages:0,deletes:[] as string[],busy:[] as boolean[]};let pending=0;
 let pageWork:()=>Promise<void>=async()=>{},deleteWork:(id:string)=>Promise<void>=async()=>{throw Error('No synthetic clear IO admitted.');};
 const forbidden=async():Promise<never>=>{throw Error('Unadmitted repository route.');};
 const store:CaptureRepository={begin:forbidden,append:forbidden,seal:forbidden,fail:forbidden,pin:forbidden,close:forbidden,async *read(){throw Error('No reader admitted.');},page:async(after,limit,through)=>{assert.equal(after,0);assert.equal(limit,undefined);assert.equal(through,undefined);calls.pages++;pending++;try{await pageWork();return{records:[],next:null};}finally{pending--; }},delete:async id=>{calls.deletes.push(id);pending++;try{await deleteWork(id);}finally{pending--;}}};
 const setters:Record<string,(v:unknown)=>void>={};for(const key of Object.keys(state) as(keyof MemoryCaptureState)[])setters['set'+key[0].toUpperCase()+key.slice(1)]=(v:unknown)=>{(state as unknown as Record<string,unknown>)[key]=typeof v==='function'?(v as(o:unknown)=>unknown)(state[key]):v;};
 const ctx:CaptureCallbackContext={state,setters:setters as CaptureCallbackContext['setters'],store,props:{visible:true,running:false,onBusy:v=>calls.busy.push(v)},transport,filter:{transport}};
 const bind=()=>bindCaptureCallbacks(ctx);const ownedGate=()=>{const g=gate();gates.push(g);return g;};
 return{state,ctx,calls,bind,ownedGate,setPage:(v:typeof pageWork)=>{pageWork=v;},setDelete:(v:typeof deleteWork)=>{deleteWork=v;},async refresh(){const cleanup=bind().refreshCatalog();await until(()=>!state.loading);for(let i=0;i<16;i++)await Promise.resolve();cleanup?.();},async finish(){gates.forEach(g=>g.release());await until(()=>pending===0);for(let i=0;i<16;i++)await Promise.resolve();assert.equal(state.busy,false);}};
}
async function partialClear(transport:'serial'|'ssh'){
 const f=fixture(transport),first=f.ownedGate(),primary=new CaptureStorageError('io','Synthetic capture delete acknowledgement failed.');
 try{
  f.setDelete(async id=>{if(id==='capture-a'){await first.promise;return;}throw primary;});
  const clearing=f.bind().clear(false);await until(()=>f.calls.deletes.length===1);assert.equal(f.state.busy,true);
  f.state.selected=new Set(['capture-next']);first.release();await clearing;
  const detail='Deleted 1 captures before cleanup stopped: '+primary.message;assert.equal(f.bind().message,detail);assert.deepEqual(f.calls.deletes,['capture-a','capture-b']);assert.deepEqual([...f.state.selected],['capture-next']);assert.equal(f.state.revision,1);assert.equal(f.state.confirmClear,true);
  await f.refresh();assert.equal(f.bind().message,detail);
  const catalogError=new CaptureStorageError('io','Synthetic follow-up catalog failure.');f.setPage(async()=>{throw catalogError;});await f.refresh();assert.equal(f.bind().message,detail+' · '+catalogError.message);f.setPage(async()=>{});await f.refresh();assert.equal(f.bind().message,detail);
  f.setDelete(async()=>{});await f.bind().clear(false);assert.equal(f.bind().message,'');assert.equal(f.state.notice,'Deleted 1 stored '+(transport==='ssh'?'SSH':'Serial')+' capture.');assert.equal(f.state.confirmClear,false);assert.equal(f.state.selected.size,0);assert.deepEqual(f.calls.deletes,['capture-a','capture-b','capture-next']);assert.deepEqual(f.calls.busy,[true,false,true,false]);
  await f.refresh();assert.equal(f.bind().message,'');
 }finally{await f.finish();}
}
test('Serial partial-clear detail survives refresh and explicit successful retry recovers',()=>partialClear('serial'));
test('independent SSH partial-clear detail survives refresh and explicit successful retry recovers',()=>partialClear('ssh'));
test('capture catalog failure recovers on successful read without a successful clear claim',async()=>{
 const f=fixture(),failure=new CaptureStorageError('io','Synthetic capture catalog unavailable.');
 try{f.setPage(async()=>{throw failure;});await f.refresh();assert.equal(f.bind().message,failure.message);f.setPage(async()=>{});await f.refresh();assert.equal(f.bind().message,'');assert.equal(f.calls.deletes.length,0);assert.equal(f.state.notice,'');}finally{await f.finish();}
});
test('aborted catalog reply and hidden Serial action cannot replace current or SSH-view diagnostics',async()=>{
 const f=fixture(),other=fixture('ssh'),old=f.ownedGate(),late=new CaptureStorageError('io','Obsolete catalog reply.'),primary=new CaptureStorageError('io','Current Serial action failed.'),ssh=new CaptureStorageError('permission','Independent SSH action failed.');
 try{
  f.setPage(async()=>{await old.promise;throw late;});const abort=f.bind().refreshCatalog();await until(()=>f.calls.pages===1);abort?.();f.setPage(async()=>{});await f.refresh();assert.equal(f.state.loading,false);
  const actionAck=f.ownedGate();f.state.selected=new Set(['current-serial']);f.setDelete(async()=>{await actionAck.promise;throw primary;});const clearing=f.bind().clear(false);await until(()=>f.calls.deletes.length===1);assert.equal(f.state.busy,true);const detail='Deleted 0 captures before cleanup stopped: '+primary.message;
  other.state.selected=new Set(['other-ssh']);other.setDelete(async()=>{throw ssh;});await other.bind().clear(false);const otherMessage=other.bind().message;
  f.ctx.props.visible=false;await f.bind().clear(false);assert.deepEqual(f.calls.deletes,['current-serial']);assert.equal(f.state.busy,true);actionAck.release();await clearing;assert.equal(f.state.busy,false);old.release();await f.finish();assert.equal(f.bind().message,detail);assert.equal(f.state.loading,false);assert.equal(other.bind().message,otherMessage);assert.notEqual(other.bind().message,f.bind().message);assert.deepEqual(other.calls.deletes,['other-ssh']);
 }finally{await f.finish();await other.finish();}
});
