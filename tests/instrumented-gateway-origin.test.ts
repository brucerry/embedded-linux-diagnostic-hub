import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CPU_FEATURES_SOURCE, CPU_FEATURES_SHA256, SSH2_CONSTANTS_SHA256, deriveCpuOriginPlan, validateRejectionOrigin } from '../scripts/lib/instrumented-gateway-origin.mjs';
import { createCompiledSourceObserver } from '../scripts/lib/instrumented-gateway-observer.mjs';
import { projectInstrumentedChildFailure, validateInstrumentedChildFailure } from '../scripts/lib/instrumented-gateway-failure.mjs';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
// Read independently selected, public installed package bytes as inert data only.
const creatorBytes=readFileSync(new URL('../node_modules/ssh2/lib/protocol/constants.js',import.meta.url));
const cpuBytes=readFileSync(new URL('../node_modules/cpu-features/lib/index.js',import.meta.url));
const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
assert.equal(creatorBytes.length,11808);assert.equal(hash(creatorBytes),SSH2_CONSTANTS_SHA256);assert.equal(cpuBytes.toString(),CPU_FEATURES_SOURCE);assert.equal(hash(cpuBytes),CPU_FEATURES_SHA256);
const root='/checkout/validation/gateway-ownership/instrumented',entry=root+'/ownership.cjs',creator=root+'/node_modules/ssh2/lib/protocol/constants.js';
function fixture(){
    const entryText='// inert fixture entry\n',scripts=new Map([[entry,Buffer.from(entryText)],[creator,creatorBytes],[root+'/package-lock.json',Buffer.from(JSON.stringify(lock))]]);
    const selected={artifactPath:entry,artifactSHA256:hash(entryText),observerSHA256:'c'.repeat(64),sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40)};
    const controls:any={},held:Function[]=[];
    const event=(id:string,url:string,length:number)=>({scriptId:id,url,length,startLine:0,startColumn:0,executionContextId:controls.zeroContext?0:controls.negativeContext?-1:1,isModule:false});
    class Session extends EventEmitter{
        connect(){}disconnect(){}
        post(method:string,p:any,done:Function){
            if(method==='Debugger.enable'){
                if(!controls.missingCreator)this.emit('Debugger.scriptParsed',{params:{...event('creator',pathToFileURL(creator).href,creatorBytes.toString().length),...(controls.creatorContext?{executionContextId:2}:{})}});
                this.emit('Debugger.scriptParsed',{params:event('entry',pathToFileURL(entry).href,entryText.length)});
                const frame={scriptId:controls.wrongId?'entry':'creator',url:pathToFileURL(creator).href,lineNumber:controls.malformedSite?{private:'must not retain'}:controls.wrongLine?7:6,columnNumber:controls.wrongColumn?13:12};
                const frames=controls.splitProof?[{...frame,scriptId:'unverified'},{...frame,lineNumber:99}]:[{scriptId:'builtin',url:'node:internal/modules/cjs/loader',lineNumber:1,columnNumber:1},frame];
                const emitUnknown=()=>this.emit('Debugger.scriptParsed',{params:{...event('unknown',controls.otherURL?'file:///different/cpu-features/lib/index.js':'file:///checkout/node_modules/cpu-features/lib/index.js',115),...(controls.missingContext?{executionContextId:undefined}:{}),...(controls.missingStack?{}:{stackTrace:{callFrames:controls.overflow?Array(33).fill(frame):frames}})}});if(controls.replayed)emitUnknown();done(null,{});if(!controls.replayed)emitUnknown();
            }else if(method==='Debugger.getScriptSource'){
                if(p.scriptId==='creator'){
                    const answer=()=>done(null,{scriptSource:controls.wrongCreator?'wrong':creatorBytes.toString()});if(controls.holdCreator)held.push(answer);else answer();
                }else done(null,{scriptSource:p.scriptId==='entry'?entryText:controls.wrongSource?'x'.repeat(115):CPU_FEATURES_SOURCE});
            }else{assert.equal(method,'Debugger.disable');done(null,{});}
        }
    }
    return{scripts,selected,controls,release:()=>held.splice(0).forEach(f=>f()),start:()=>createCompiledSourceObserver(selected,scripts,()=>new Session())};
}
async function reject(f:ReturnType<typeof fixture>){const o=f.start();await assert.rejects(o.start());await assert.rejects(o.finish());await o.retirement;return o;}
test('prelaunch origin plan is fixed-layout, exact creator and optional-lock bound',()=>{
    const f=fixture(),plan=deriveCpuOriginPlan(f.scripts,entry);assert.ok(plan);assert.equal(plan.checkoutCpuURL,'file:///checkout/node_modules/cpu-features/lib/index.js');assert.equal(plan.line,6);assert.equal(plan.column,12);
    for(const change of [(m:Map<string,Buffer>)=>m.set(creator,Buffer.from('wrong')),(m:Map<string,Buffer>)=>m.set(root+'/node_modules/cpu-features/lib/index.js',cpuBytes),(m:Map<string,Buffer>)=>m.set(root+'/package-lock.json',Buffer.from('{}'))]){const m=new Map(f.scripts);change(m);assert.equal(deriveCpuOriginPlan(m,entry),null);}
    for(const field of ['integrity','version','optional']){const m=new Map(f.scripts),v=structuredClone(lock);v.packages['node_modules/cpu-features'][field]=field==='optional'?false:'wrong';m.set(root+'/package-lock.json',Buffer.from(JSON.stringify(v)));assert.equal(deriveCpuOriginPlan(m,entry),null);}
    assert.equal(deriveCpuOriginPlan(f.scripts,'/unrecognized/ownership.cjs'),null);
});
test('finite known CPU URL/source/creator associations do not admit outside code',async()=>{
    const o=await reject(fixture()),d=o.snapshot().rejectionOrigin;assert.ok(d);validateRejectionOrigin(d);
    assert.equal(o.snapshot().failureCode,'script-unadmitted');assert.equal(d.planned,true);assert.equal(d.checkoutCpuURLMatches,true);assert.equal(d.cpuSourceMatches,true);assert.equal(d.topFrameKind,'node-cjs-loader');assert.equal(d.constantsURLInStack,true);assert.equal(d.constantsSiteInStack,true);assert.equal(d.constantsScriptVerified,true);assert.equal(d.constantsCreationVerified,true);
    const detail=projectInstrumentedChildFailure('workload',false,true,{failed:true,retired:true,collector:o.snapshot()});validateInstrumentedChildFailure(detail);assert.equal(detail.releaseAcceptance,false);
    for(const secret of ['/checkout','cpufeatures.node','"creator"','"builtin"'])assert.ok(!JSON.stringify(detail).includes(secret));
});
for(const kind of ['replayed','zeroContext','negativeContext','otherURL','wrongSource','wrongId','malformedSite','wrongLine','wrongColumn','missingContext','creatorContext','missingCreator','wrongCreator','missingStack','overflow','splitProof'])test('origin cannot combine contradictory or unsupported facts: '+kind,async()=>{
    const f=fixture();f.controls[kind]=true;const o=await reject(f),d=o.snapshot().rejectionOrigin;assert.ok(d);validateRejectionOrigin(d);
    if(kind==='otherURL')assert.equal(d.checkoutCpuURLMatches,false);
    else if(kind==='wrongSource')assert.equal(d.cpuSourceMatches,false);
    else assert.equal(d.constantsCreationVerified,false);
    if(kind==='splitProof'){assert.equal(d.constantsSiteInStack,true);assert.equal(d.constantsScriptVerified,true);}
    if(kind==='overflow'){assert.equal(d.stackWithinBound,false);assert.equal(d.constantsURLInStack,false);assert.equal(d.topFrameKind,'absent');}
});
test('creator verification waits for its source classification before origin proof',async()=>{
    const f=fixture();f.controls.holdCreator=true;const o=f.start();let done=false;const task=o.start().catch(()=>{done=true;});for(let i=0;i<100;i++)await Promise.resolve();assert.equal(done,false);assert.equal(o.snapshot().rejectionOrigin?.constantsScriptVerified,null);f.release();await task;await assert.rejects(o.finish());await o.retirement;assert.equal(o.snapshot().rejectionOrigin?.constantsCreationVerified,true);
});
test('origin schema rejects arbitrary fields, numeric proofs and contradictory combinations',async()=>{
    const d=(await reject(fixture())).snapshot().rejectionOrigin;assert.ok(d);
    for(const mutate of [(v:any)=>v.rawPath='/private',(v:any)=>v.checkoutCpuURLMatches=1,(v:any)=>v.planned=false,(v:any)=>v.constantsScriptVerified=false,(v:any)=>v.stackWithinBound=false,(v:any)=>v.topFrameKind='private builtin']){const v=structuredClone(d);mutate(v);assert.throws(()=>validateRejectionOrigin(v));}
});

test('replayed CPU stack cannot gain creation proof after a held creator RPC',async()=>{
    const f=fixture();f.controls.replayed=true;f.controls.holdCreator=true;const o=f.start(),task=o.start();const rejected=assert.rejects(task);for(let i=0;i<100;i++)await Promise.resolve();assert.equal(o.snapshot().enableAcknowledged,true);f.release();await rejected;await assert.rejects(o.finish());await o.retirement;assert.equal(o.snapshot().rejectionOrigin?.constantsScriptVerified,true);assert.equal(o.snapshot().rejectionOrigin?.constantsCreationVerified,false);
});
