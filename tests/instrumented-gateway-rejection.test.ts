import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createCompiledSourceObserver } from '../scripts/lib/instrumented-gateway-observer.mjs';
import { createRejectionFingerprint, fingerprintRejectedSource, validateRejectionFingerprint } from '../scripts/lib/instrumented-gateway-rejection.mjs';
import { projectInstrumentedChildFailure, validateInstrumentedChildFailure } from '../scripts/lib/instrumented-gateway-failure.mjs';
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const pulse=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function fixture(){
    const root='/instrumented',entry=root+'/ownership.cjs',known=root+'/known.js',entryText='e'.repeat(115),knownText='k'.repeat(115);
    const selected={artifactPath:entry,artifactSHA256:hash(entryText),observerSHA256:'c'.repeat(64),sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40)};
    const scripts=new Map([[entry,Buffer.from(entryText)],[known,Buffer.from(knownText)]]),controls:any={},calls:string[]=[],held:Function[]=[];
    const event=(id:string,url:string,length:number)=>({params:{scriptId:id,url,length,isModule:false,startLine:0,startColumn:0,executionContextId:1}});
    class Session extends EventEmitter{
        connect(){}disconnect(){calls.push('disconnect');}
        post(method:string,p:any,done:Function){
            calls.push(method+(p.scriptId?':'+p.scriptId:''));
            if(method==='Debugger.enable'){
                this.emit('Debugger.scriptParsed',event('entry',pathToFileURL(entry).href,115));
                this.emit('Debugger.scriptParsed',event('known',pathToFileURL(known).href,115));
                if(!controls.skipUnknown)emit();if(controls.second)emit('second');done(null,{});
            }else if(method==='Debugger.getScriptSource'){
                if(p.scriptId==='entry'||p.scriptId==='known'){done(null,{scriptSource:p.scriptId==='entry'?entryText:knownText});return;}
                const answer=()=>done(controls.callbackError?Error('private error text'):null,{scriptSource:controls.source===undefined?knownText:controls.source});
                if(controls.hold||controls.throwDispatch)held.push(answer);else answer();
                if(controls.throwDispatch)throw Error('private dispatch text');
            }else{assert.equal(method,'Debugger.disable');done(null,{});}
        }
    }
    const session=new Session();
    function emit(id='unknown'){
        const e=event(id,controls.url??'file:///instrumented/alias.js',controls.length??115);Object.assign(e.params,controls.params);session.emit('Debugger.scriptParsed',e);
    }
    return{controls,calls,entryText,knownText,scripts,selected,emit,release:()=>held.splice(0).forEach(f=>f()),start:()=>createCompiledSourceObserver(selected,scripts,()=>session)};
}
async function rejected(f:ReturnType<typeof fixture>){const o=f.start();await assert.rejects(o.start());await assert.rejects(o.finish());await o.retirement;return o;}
test('file-URL fingerprint recognizes exact census bytes while admission remains rejected',async()=>{
    const f=fixture(),o=await rejected(f),d=o.snapshot().rejectionFingerprint;assert.ok(d);validateRejectionFingerprint(d);
    assert.equal(o.snapshot().failureCode,'script-unadmitted');assert.equal(d.status,'fingerprinted');assert.equal(d.sourceSHA256,hash(f.knownText));assert.equal(d.sourceUnits,115);assert.equal(d.sourceBytes,115);
    assert.equal(d.canonicalFileURL,true);assert.equal(d.withinAdmittedRoot,true);assert.equal(d.exactURLInCensus,false);assert.equal(d.sourceMatchesCensus,true);assert.equal(d.sourceMatchesEntry,false);
    assert.equal(f.calls.filter(c=>c==='Debugger.getScriptSource:unknown').length,1);
    const detail=projectInstrumentedChildFailure('workload',false,true,{failed:true,retired:true,collector:o.snapshot()});validateInstrumentedChildFailure(detail);
    const text=JSON.stringify(detail);for(const secret of ['/instrumented','alias.js','unknown','kkkkkkkk','private error text'])if(secret!=='unknown')assert.ok(!text.includes(secret));assert.equal(detail.releaseAcceptance,false);
});
for(const kind of ['entry','foreign','unicode'])test('source comparison is exact and isolated: '+kind,async()=>{
    const f=fixture();f.controls.source=kind==='entry'?f.entryText:kind==='unicode'?'π'.repeat(115):'x'.repeat(115);
    const o=await rejected(f),d=o.snapshot().rejectionFingerprint;assert.ok(d);assert.equal(d.status,'fingerprinted');assert.equal(d.sourceSHA256,hash(f.controls.source));assert.equal(d.sourceBytes,kind==='unicode'?230:115);assert.equal(d.sourceMatchesEntry,kind==='entry');assert.equal(d.sourceMatchesCensus,kind==='entry');
});
for(const [url,canonical,inside] of [['file:///outside/alias.js',true,false],['file:///instrumented/../outside/a.js',false,false],['file:///instrumented/alias.js?x',false,false],['file://localhost/instrumented/alias.js',false,false],['file:///instrumented/%61lias.js',false,false],['file:///instrumented/%00bad',false,false]] as const)test('URL facts are pure, bounded and canonical: '+url,async()=>{
    const f=fixture();f.controls.url=url;const o=await rejected(f),d=o.snapshot().rejectionFingerprint;assert.ok(d);assert.equal(d.canonicalFileURL,canonical);assert.equal(d.withinAdmittedRoot,inside);assert.ok(!JSON.stringify(d).includes(url));
});
for(const source of [null,{},'x'.repeat(114),'x'.repeat(4097),'x'.repeat(114)+'\ud800'])test('invalid response is rejected before a fingerprint is emitted: '+typeof source+':'+(typeof source==='string'?source.length:0),async()=>{
    const f=fixture();f.controls.source=source;const o=await rejected(f),d=o.snapshot().rejectionFingerprint;assert.ok(d);assert.equal(d.status,'invalid-response');assert.equal(d.sourceSHA256,null);assert.equal(d.sourceBytes,null);validateRejectionFingerprint(d);
});
for(const params of [{length:114},{url:''},{url:'https://example.invalid'},{params:{isModule:true}},{params:{isModule:undefined}}])test('unreviewed shapes cannot start a diagnostic query: '+JSON.stringify(params),async()=>{
    const f=fixture();Object.assign(f.controls,params);const o=await rejected(f);assert.equal(o.snapshot().rejectionFingerprint,null);assert.ok(!f.calls.includes('Debugger.getScriptSource:unknown'));
});
test('only first rejection is fingerprinted; later events cannot replace its result',async()=>{
    const f=fixture();f.controls.second=true;const o=await rejected(f);assert.equal(f.calls.filter(c=>c.startsWith('Debugger.getScriptSource:unknown')||c.endsWith(':second')).length,1);assert.equal(o.snapshot().rejectionFingerprint?.sourceSHA256,hash(f.knownText));
});
test('held source callback owns both RPC and classification until acknowledged',async()=>{
    const f=fixture();f.controls.hold=true;const o=f.start();let settled=false;const start=o.start().catch(()=>{settled=true;});await pulse();assert.equal(settled,false);assert.equal(o.snapshot().rejectionFingerprint?.status,'pending');assert.ok(o.snapshot().pendingCallbacks>0);assert.ok(o.snapshot().pendingSourceClassifications>0);
    const finish=o.finish();await pulse();assert.ok(!f.calls.includes('Debugger.disable'));f.release();await start;await assert.rejects(finish);await o.retirement;assert.equal(o.snapshot().observerRetired,true);assert.equal(o.snapshot().failureCode,'script-unadmitted');
});
for(const kind of ['callbackError','throwDispatch'])test('RPC failure preserves first rejection and dispatch uncertainty: '+kind,async()=>{
    const f=fixture();f.controls[kind]=true;const o=f.start();const start=o.start();start.catch(()=>{});await pulse();if(kind==='throwDispatch'){assert.equal(o.snapshot().pendingCallbacks,1);assert.equal(o.snapshot().rejectionFingerprint?.status,'rpc-rejected');f.release();}
    await assert.rejects(start);await assert.rejects(o.finish());await o.retirement;assert.equal(o.snapshot().failureCode,'script-unadmitted');assert.equal(o.snapshot().rejectionFingerprint?.status,'rpc-rejected');
});
test('fingerprint schema excludes arbitrary fields, false proof types and incomplete results',()=>{
    const f=fixture(),census=new Map([[pathToFileURL(f.selected.artifactPath).href,{sha256:hash(f.entryText),text:f.entryText}]]);
    const d=createRejectionFingerprint({url:'file:///instrumented/unadmitted.js',length:115,isModule:false},census,f.selected.artifactPath);assert.ok(d);fingerprintRejectedSource(d,f.entryText,census,pathToFileURL(f.selected.artifactPath).href);validateRejectionFingerprint(d);
    for(const mutate of [(v:any)=>v.path='/private',(v:any)=>v.canonicalFileURL=1,(v:any)=>v.sourceUnits=114,(v:any)=>v.sourceSHA256=null,(v:any)=>v.sourceMatchesCensus=false]){const v=structuredClone(d);mutate(v);assert.throws(()=>validateRejectionFingerprint(v));}
});

 test('late first rejection joins its source task and stale events cannot mutate retired fingerprint',async()=>{
    const f=fixture();f.controls.skipUnknown=true;const o=f.start();await o.start();f.controls.hold=true;f.emit();const finish=o.finish();finish.catch(()=>{});await pulse();assert.equal(o.snapshot().rejectionFingerprint?.status,'pending');assert.ok(!f.calls.includes('Debugger.disable'));f.release();await assert.rejects(finish);await o.retirement;const prior=o.snapshot().rejectionFingerprint;f.emit('stale');assert.deepEqual(o.snapshot().rejectionFingerprint,prior);assert.ok(!f.calls.includes('Debugger.getScriptSource:stale'));
});
