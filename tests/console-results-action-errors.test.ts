import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { bindResultsCallbacks, boundSpans, type CallbackContext, type MemoryViewState } from './fixtures/console-results-callbacks';
import { ConsoleResultsOwner } from '../src/features/automation/capture/console-results-owner';
import { ConsoleExportDiagnostic } from '../src/features/automation/capture/console-export-diagnostic';
import { CaptureStorageError } from '../shared/capture-store';
import type { ConsoleArchive } from '../shared/console-storage';
import type { ConsoleReportScope } from '../shared/console-report';
const timerKeys = ['setTimeout','clearTimeout','setInterval','clearInterval'] as const;
const timers = timerKeys.map(key => Object.getOwnPropertyDescriptor(globalThis,key));
const source = readFileSync('src/features/automation/capture/use-console-results.ts','utf8');
for (const span of boundSpans) assert.equal(source.includes(span),true,'Verbatim active callback binding drifted; regenerate fixture after reviewing the change.');
after(() => {timerKeys.forEach((key,i) => assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,key),timers[i]));});
function gate() { let release!:()=>void; const promise = new Promise<void>(r=>{release=r;});return {promise,release}; }
async function until(check:()=>boolean) { for(let i=0;i<160;i++){if(check()) return;await Promise.resolve();}assert.fail('Bounded callback gate did not settle.'); }
async function fixture() {
 const state:MemoryViewState={status:'ready',failure:null,catalogFailure:null,rows:[],next:null,mode:'scan',preview:null,previewLoading:false,operation:null,revision:0,exportStatus:null,cleanupDiagnostic:null,selected:new Set(['capture-a']),notice:null,confirmation:null,cursor:undefined,back:[]};
 const calls={lists:0,deletes:[] as string[],reads:[] as string[],disposes:0,busy:[] as boolean[]};
 const gates:ReturnType<typeof gate>[]=[];
 let listWork:()=>Promise<void>=async()=>{}, deleteWork:(id:string)=>Promise<void>=async()=>{throw Error('Unexpected memory-delete path.');},readWork:(id:string)=>Promise<void>=async()=>{throw Error('Unexpected memory-reader path.');};
 const archive:ConsoleArchive={
  pin:async()=>{throw Error('No pin route admitted.');},
  list:async(after,limit)=>{calls.lists++;assert.equal(limit,25);assert.equal(after,undefined);await listWork();return {captures:[],next:null,mode:'scan'};},
  delete:async(id)=>{calls.deletes.push(id);await deleteWork(id);},
  async *read(id){calls.reads.push(id);await readWork(id);throw Error('Memory read must fail before yielding a record.');},
 };
 const owner=new ConsoleResultsOwner(async()=>({archive,dispose:async()=>{calls.disposes++;}}),v=>calls.busy.push(v));
 await owner.ready;await until(()=>owner.resourceSnapshot.pending===0);
 const setters:Record<string,(value:unknown)=>void>={};
 for(const key of Object.keys(state) as (keyof MemoryViewState)[]) setters['set'+key[0].toUpperCase()+key.slice(1)]=(value:unknown)=>{
  const next=typeof value==='function'?(value as (old:unknown)=>unknown)(state[key]):value;
  (state as unknown as Record<string,unknown>)[key]=next;
 };
 const ctx:CallbackContext={state,setters:setters as CallbackContext['setters'],options:{visible:true},owner,ready:true,current:{current:owner},latest:{current:{visible:true,running:false}},activeOperation:{current:null},armReservation:{current:null},previewGeneration:{current:0},exportDiagnosticOwner:{current:new ConsoleExportDiagnostic()},applied:{},filter:{},format:'json',selection:'selected',startConsoleExport:async()=>{throw Error('No export IO admitted.');}};
 const bind=()=>bindResultsCallbacks(ctx);
 const ownedGate=()=>{const g=gate();gates.push(g);return g;};
 return {ctx,state,calls,owner,bind,ownedGate,setList:(work:typeof listWork)=>{listWork=work;},setDelete:(work:typeof deleteWork)=>{deleteWork=work;},setRead:(work:typeof readWork)=>{readWork=work;},async refresh(){const cleanup=bind().refreshCatalog();await until(()=>state.status!=='loading');await until(()=>owner.resourceSnapshot.pending===0);cleanup?.();},async close(){gates.forEach(g=>g.release());await owner.close();assert.equal(calls.disposes,1);assert.deepEqual(owner.resourceSnapshot,{pending:0,export:false,closing:false,closed:true});assert.equal(calls.busy.at(-1),false);}};
}
test('settled export error survives automatic catalog refresh while submitted selection stays fixed',async()=>{
 const f=await fixture(),ack=f.ownedGate(),failure=new CaptureStorageError('permission','Synthetic export destination denied.');let scope:ConsoleReportScope|undefined;
 try{
  f.ctx.startConsoleExport=async(_format,input)=>{scope=input;return {completed:ack.promise.then(()=>{throw failure;}),cancel:async()=>{throw Error('No cancellation required for a settled synthetic job.');}};};
  const exporting=f.bind().exportClicked();f.state.selected=new Set(['capture-b']);
  await until(()=>scope!==undefined);assert.deepEqual(scope,{ids:['capture-a'],title:'Selected console flows'});
  ack.release();await exporting;assert.equal(f.bind().message,failure.message);assert.equal(f.state.revision,1);assert.equal(f.state.operation,null);
  const catalogFailure=new CaptureStorageError('io','Synthetic catalog retry failed.');f.setList(async()=>{throw catalogFailure;});await f.refresh();assert.equal(f.bind().message,failure.message+' · '+catalogFailure.message);
  const read=f.ownedGate();f.setList(()=>read.promise);const cleanup=f.bind().refreshCatalog();
  await until(()=>f.calls.lists===2);assert.equal(f.bind().message,failure.message+' · '+catalogFailure.message);
  read.release();await until(()=>f.state.status==='ready'&&f.owner.resourceSnapshot.pending===0);cleanup?.();
  assert.equal(f.bind().message,failure.message);
  assert.equal(f.state.exportStatus,'Export did not complete. Retained evidence is unchanged.');assert.deepEqual([...f.state.selected],['capture-b']);assert.equal(f.calls.deletes.length,0);
 }finally{await f.close();}
});
test('partial synthetic clear preserves count and original failure through successful catalog refresh',async()=>{
 const f=await fixture(),first=f.ownedGate();const failure=new CaptureStorageError('io','Synthetic clear acknowledgement failed.');
 try{
  f.state.selected=new Set(['capture-a','capture-b']);f.state.confirmation='selected';
  f.setDelete(async id=>{if(id==='capture-a'){await first.promise;return;}throw failure;});
  const clearing=f.bind().deleteConfirmed();await until(()=>f.calls.deletes.length===1);f.state.selected=new Set(['capture-a','capture-b','capture-new']);first.release();await clearing;
  const detail='Deleted 1 flows before cleanup stopped: '+failure.message;assert.equal(f.bind().message,detail);assert.deepEqual(f.calls.deletes,['capture-a','capture-b']);assert.equal(f.state.revision,1);
  await f.refresh();assert.equal(f.bind().message,detail);assert.ok(f.state.selected.has('capture-new'));assert.equal(f.state.confirmation,'selected');
 }finally{await f.close();}
});
test('catalog failure recovers on successful refresh without implying export success',async()=>{
 const f=await fixture(),failure=new CaptureStorageError('io','Synthetic catalog unavailable.');
 try{
  f.setList(async()=>{throw failure;});await f.refresh();assert.equal(f.state.status,'error');assert.equal(f.bind().message,failure.message);
  f.setList(async()=>{});await f.refresh();assert.equal(f.state.status,'ready');assert.equal(f.bind().message,null);assert.equal(f.state.exportStatus,null);assert.equal(f.calls.deletes.length,0);
 }finally{await f.close();}
});
test('obsolete preview rejection cannot replace a newer selection error or clear its loading state',async()=>{
 const f=await fixture(),old=f.ownedGate();const first=new CaptureStorageError('io','Old preview failure.'),second=new CaptureStorageError('io','New preview failure.');
 try{
  f.setRead(async id=>{if(id==='capture-a'){await old.promise;throw first;}throw second;});
  f.bind().onPreview('capture-a');await until(()=>f.calls.reads.length===1);
  f.bind().clearPreview();f.state.selected=new Set(['capture-b']);f.bind().onPreview('capture-b');
  await until(()=>f.bind().message===second.message&&!f.state.previewLoading);old.release();await until(()=>f.owner.resourceSnapshot.pending===0);
  assert.equal(f.bind().message,second.message);assert.equal(f.state.previewLoading,false);assert.deepEqual(f.calls.reads,['capture-a','capture-b']);assert.equal(f.state.preview,null);
 }finally{await f.close();}
});
