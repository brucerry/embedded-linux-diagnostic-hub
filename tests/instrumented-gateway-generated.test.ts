import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deriveInstrumentedGeneratedInventory,SSH2_BIGINT_GENERATED_SOURCE,SSH2_BIGINT_ORIGIN_SHA256,generatedReceiptRowsMatch } from '../scripts/lib/instrumented-gateway-generated.mjs';
import { createCompiledSourceObserver } from '../scripts/lib/instrumented-gateway-observer.mjs';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { snapshotPreparedInstrumentedGateway,RAW_CLI_REFERENCE } from '../scripts/lib/instrumented-gateway-check.mjs';
import { validateInstrumentedChildReceipt } from '../scripts/lib/instrumented-gateway-child.mjs';
import { projectInstrumentedChildFailure } from '../scripts/lib/instrumented-gateway-failure.mjs';

const root='/instrumented',artifactPath=root+'/gateway.cjs',creator=root+'/node_modules/ssh2/lib/protocol/node-fs-compat.js';
// Audited read-only dependency bytes, never imported or executed by these memory controls.
const origin=readFileSync(new URL('../node_modules/ssh2/lib/protocol/node-fs-compat.js',import.meta.url));
const locked=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8')).packages['node_modules/ssh2'];
assert.equal(origin.length,3647);assert.equal(sourceDigest(origin),SSH2_BIGINT_ORIGIN_SHA256);
const pulse=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function fixture(){
    const entry=Buffer.from('// synthetic entry; never executed\n'),scripts=new Map([[artifactPath,entry],[creator,origin],
        [root+'/node_modules/ssh2/package.json',Buffer.from('{"name":"ssh2","version":"1.17.0"}')],
        [root+'/package-lock.json',Buffer.from(JSON.stringify({lockfileVersion:3,packages:{'node_modules/ssh2':locked}}))]]);
    const selected={artifactPath,artifactSHA256:sourceDigest(entry),observerSHA256:'c'.repeat(64),sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40)};
    const controls:any={},events:string[]=[],callbacks:Function[]=[];
    const parsed=(id:string,url:string,length:number)=>({scriptId:id,url,length,startLine:0,startColumn:0,executionContextId:1});
    class Session extends EventEmitter{
        connect(){events.push('connect');}disconnect(){events.push('disconnect');}
        post(method:string,params:any,callback:Function){
            events.push(method+(params.scriptId?':'+params.scriptId:''));
            if(method==='Debugger.enable'){
                if(!controls.missingCreator)this.emit('Debugger.scriptParsed',{params:{...parsed('creator',pathToFileURL(creator).href,origin.toString().length),...(controls.creatorOffset?{startLine:1}:{}),...(controls.creatorContext?{executionContextId:2}:{})}});
                this.emit('Debugger.scriptParsed',{params:parsed('entry',pathToFileURL(artifactPath).href,entry.length)});
                if(!controls.late)emitGenerated();callback(null,{});
            }else if(method==='Debugger.getScriptSource'){
                if(params.scriptId==='creator'){
                    const done=()=>callback(null,{scriptSource:controls.wrongCreator?'wrong':origin.toString()});
                    if(controls.holdCreator)callbacks.push(done);else done();
                }else callback(null,{scriptSource:params.scriptId==='entry'?entry.toString():controls.wrongSource?SSH2_BIGINT_GENERATED_SOURCE.replace('32n','33n'):SSH2_BIGINT_GENERATED_SOURCE});
            }else{assert.equal(method,'Debugger.disable');callback(null,{});}
        }
    }
    const session=new Session();let ordinal=0;
    function emitGenerated(){
        const frame={scriptId:controls.wrongId?'entry':'creator',url:controls.wrongURL?'file:///unrelated':pathToFileURL(creator).href,lineNumber:controls.wrongLine?51:50,columnNumber:controls.wrongColumn?12:11};
        session.emit('Debugger.scriptParsed',{params:{...parsed('generated'+(++ordinal),controls.nonempty?'file:///unadmitted':'',controls.wrongLength?45:44),
            ...(controls.missingContext?{executionContextId:undefined}:{}),...(controls.contextMismatch?{executionContextId:2}:{}),
            isModule:false,...(controls.module?{isModule:true}:{}),...(controls.missingModule?{isModule:undefined}:{}),...(controls.malformedModule?{isModule:'false'}:{}),...(controls.sourceURL?{hasSourceURL:true}:{}),
            ...(controls.missingStack?{}:{stackTrace:{callFrames:[frame]}})}});
        if(controls.duplicate&&ordinal===1)emitGenerated();
    }
    return{scripts,selected,controls,events,session,emitGenerated,releaseCreator:()=>callbacks.splice(0).forEach(f=>f()),start:()=>createCompiledSourceObserver(selected,scripts,()=>session)};
}
test('prelaunch generated plan is exact-file/lock/version bound and declares separate source identity',()=>{
    const f=fixture(),plan=deriveInstrumentedGeneratedInventory(f.scripts,root);assert.equal(plan.length,1);assert.equal(plan[0].sourceBytes,44);assert.equal(plan[0].sourceSHA256,'d704072b69d2bcf63f6a6246a7469a6eb59de3bd8fa536ecd10981cc9ee31a04');assert.equal(plan[0].originLine,50);assert.equal(plan[0].originColumn,11);
    const changed=new Map(f.scripts);changed.set(creator,Buffer.from(origin.toString().replace('32n','33n')));assert.throws(()=>deriveInstrumentedGeneratedInventory(changed,root));
    const badLock=new Map(f.scripts);badLock.set(root+'/package-lock.json',Buffer.from(JSON.stringify({packages:{'node_modules/ssh2':{...locked,integrity:'wrong'}}})));assert.throws(()=>deriveInstrumentedGeneratedInventory(badLock,root));
    assert.deepEqual(deriveInstrumentedGeneratedInventory(new Map([[artifactPath,Buffer.from('entry')]]),root),[]);
});
test('exact generated bytes require verified creator source, top creation site and same execution context',async()=>{
    const f=fixture(),o=f.start();await o.start();const result=await o.finish();await o.retirement;
    assert.equal(result.compiledScripts.length,2);assert.equal(result.generatedScripts.length,1);assert.equal(result.generatedScripts[0].identity,'ssh2-max-32bit-bigint-function-v1');assert.equal(result.generatedScripts[0].creationStackVerified,true);
    generatedReceiptRowsMatch(result.generatedScripts,deriveInstrumentedGeneratedInventory(f.scripts,root));
    assert.ok(!result.compiledScripts.some((r:any)=>r.path.includes('generated')));
});
for(const kind of ['wrongId','wrongURL','wrongLine','wrongColumn','missingStack','missingContext','contextMismatch','creatorOffset','creatorContext','missingCreator','wrongCreator','wrongSource','wrongLength','nonempty','module','missingModule','malformedModule','sourceURL','duplicate'])test('generated admission rejects '+kind,async()=>{
    const f=fixture();f.controls[kind]=true;const o=f.start();await assert.rejects(o.start());await assert.rejects(o.finish());await o.retirement;assert.equal(o.snapshot().primaryFailure,true);
});
test('creator RPC result and its async source classification must complete before generated admission',async()=>{
    const f=fixture();f.controls.holdCreator=true;const o=f.start();let done=false;const task=o.start().then(()=>{done=true;});await pulse();assert.equal(done,false);assert.ok(o.snapshot().pendingSourceClassifications>0);f.releaseCreator();await task;const r=await o.finish();assert.equal(r.generatedScripts.length,1);
});
for(const reject of [false,true])test('generated event after start is classified at finish, wrong creator rejected='+reject,async()=>{
    const f=fixture();f.controls.late=true;f.controls.wrongId=reject;const o=f.start();await o.start();f.emitGenerated();
    if(reject){await assert.rejects(o.finish());}else{assert.equal((await o.finish()).generatedScripts.length,1);}await o.retirement;
});
test('generated diagnostics disclose only fixed match facts and hash, preserving unknown origin as failure',async()=>{
    const f=fixture();f.controls.missingStack=true;const o=f.start();await assert.rejects(o.start());await assert.rejects(o.finish());
    const d=projectInstrumentedChildFailure('workload',false,true,{failed:true,retired:true,collector:o.snapshot()});
    const diagnostic=d.generatedDiagnostic;assert.ok(diagnostic);
    assert.equal(diagnostic.sourceMatched,true);assert.equal(diagnostic.siteMatched,false);assert.equal(diagnostic.creatorSourceVerified,false);assert.equal(diagnostic.sourceSHA256,'d704072b69d2bcf63f6a6246a7469a6eb59de3bd8fa536ecd10981cc9ee31a04');
    const text=JSON.stringify(d);assert.ok(!text.includes(creator)&&!text.includes('generated1')&&!text.includes('return 2n'));assert.equal(d.releaseAcceptance,false);
});
test('sealed generated inventory and separately reported rows cannot be extended or mutated',()=>{
    const f=fixture(),inventory=[...f.scripts].map(([path,b])=>({path,bytes:b.length,sha256:sourceDigest(b)})).sort((a,b)=>a.path<b.path?-1:1),generated=deriveInstrumentedGeneratedInventory(f.scripts,root);
    const binding:any={kind:'separate-instrumented-gateway-build-byte-binding-v3',source:{sourceCommit:f.selected.sourceCommit,sourceTree:f.selected.sourceTree},artifactPath,artifactSHA256:f.selected.artifactSHA256,observerSHA256:f.selected.observerSHA256,rawCLIReference:RAW_CLI_REFERENCE,releaseAcceptance:false,buildProvenanceVerified:false,fileInventory:inventory,fileInventorySHA256:sourceDigest(JSON.stringify(inventory)),scriptInventory:inventory,scriptInventorySHA256:sourceDigest(JSON.stringify(inventory)),generatedInventory:generated,generatedInventorySHA256:sourceDigest(JSON.stringify(generated))};
    const prepared={binding,selection:f.selected,scripts:f.scripts};assert.equal(snapshotPreparedInstrumentedGateway(prepared).binding.generatedInventory.length,1);
    for(const mutate of [(v:any)=>v.generatedInventory=[],(v:any)=>v.generatedInventory[0].originColumn++,(v:any)=>v.generatedInventory.push({...v.generatedInventory[0]})]){
        const v=structuredClone(binding);mutate(v);v.generatedInventorySHA256=sourceDigest(JSON.stringify(v.generatedInventory));assert.throws(()=>snapshotPreparedInstrumentedGateway({...prepared,binding:v}));
    }
    const row={identity:generated[0].identity,sourceSHA256:generated[0].sourceSHA256,sourceBytes:44,creatorSourceVerified:true,creationStackVerified:true};
    for(const bad of [[{...row,sourceSHA256:'0'.repeat(64)}],[{...row,creationStackVerified:false}],[row,row]])assert.throws(()=>generatedReceiptRowsMatch(bad,generated));
});

test('a later unknown event is diagnosed independently of an earlier valid generated candidate',async()=>{
    const f=fixture(),o=f.start();await o.start();f.controls.nonempty=true;f.emitGenerated();await assert.rejects(o.finish());await o.retirement;
    assert.equal(o.snapshot().failureCode,'script-unadmitted');assert.equal(o.snapshot().generatedDiagnostic.urlKind,'file-url');assert.equal(o.snapshot().generatedDiagnostic.sourceMatched,null);
});

test('shared compatibility event ceiling includes the separately reported generated script',()=>{
    const f=fixture(),inventory=deriveInstrumentedGeneratedInventory(f.scripts,root),row={identity:inventory[0].identity,sourceSHA256:inventory[0].sourceSHA256,sourceBytes:44,creatorSourceVerified:true,creationStackVerified:true};
    const source={sourceCommit:f.selected.sourceCommit,sourceTree:f.selected.sourceTree},binding={source,generatedInventory:inventory},prepared:any={binding,selection:f.selected};
    const receipt={schema:'instrumented-node-inspector-compatibility-v2',status:'exact-prelaunch-bytes-match-replayed-sources',instrumented:true,source,bindingSHA256:sourceDigest(JSON.stringify(binding)+'\n'),artifactSHA256:f.selected.artifactSHA256,compiledScripts:2047,generatedScripts:[row],builtinScripts:0,builtinIdentityVerified:false,observerRetired:true,elapsedMs:1,productWorkload:null,shippedCLIBehavior:null,wholeGroupRetirement:null,releaseAcceptance:false};
    validateInstrumentedChildReceipt(prepared,'compatibility',receipt);
    assert.throws(()=>validateInstrumentedChildReceipt(prepared,'compatibility',{...receipt,compiledScripts:2048}));
    assert.throws(()=>validateInstrumentedChildReceipt(prepared,'compatibility',{...receipt,builtinScripts:1}));
});
