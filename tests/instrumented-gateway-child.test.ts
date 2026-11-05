import { containmentRecord } from './fixtures/instrumented-containment-memory';
import assert from 'node:assert/strict';
import { deriveInstrumentedGeneratedInventory } from '../scripts/lib/instrumented-gateway-generated.mjs';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { INSTRUMENTED_CHILD_FAILURE_MARKER,parseInstrumentedChildFailure,projectInstrumentedChildFailure,encodeInstrumentedChildFailure } from '../scripts/lib/instrumented-gateway-failure.mjs';
import { censusInstrumentedGateway } from '../scripts/lib/instrumented-gateway-census.mjs';
import { runOwnedInstrumentedGatewayChild, activateOwnedInstrumentedGatewayChild, parseInstrumentedChildInput, validateInstrumentedChildReceipt, INSTRUMENTED_CHILD_MARKER } from '../scripts/lib/instrumented-gateway-child.mjs';
import { startInstrumentedChildOutput } from '../scripts/lib/instrumented-gateway-output.mjs';
import { startInstrumentedInspectorCompatibility } from '../scripts/lib/instrumented-gateway-compatibility.mjs';
import { RAW_CLI_REFERENCE } from '../scripts/lib/instrumented-gateway-check.mjs';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { memoryFilesystem } from './fixtures/gateway-producer-memory';
const root='/project/validation/gateway-ownership/instrumented',inputPath='/project/validation/gateway-ownership/child-input-compatibility.json';
const pulse=async()=>{for(let i=0;i<400;i++)await Promise.resolve();};
const deferred=()=>{let resolve!:(v?:any)=>void,reject!:(e:Error)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return{promise,resolve,reject};};
function installation(){
    const m=memoryFilesystem(), controls:any={};
    m.write(root+'/ownership.cjs',Buffer.from('// synthetic CJS; never executed\n'));
    m.write(root+'/activate.cjs',Buffer.from('// synthetic activation; never executed\n'));
    m.write(root+'/resolution-guard.cjs',Buffer.from('// synthetic guard; never executed\n'));
    m.write(root+'/package.json',Buffer.from(JSON.stringify({name:'synthetic',version:'1.0.0'})));
    m.write(root+'/package-lock.json',Buffer.from(JSON.stringify({lockfileVersion:3,packages:{'':{name:'synthetic',version:'1.0.0'},'node_modules/dep':{version:'1.0.0'}}})));
    m.write(root+'/node_modules/dep/package.json',Buffer.from(JSON.stringify({name:'dep',version:'1.0.0'})));
    m.write(root+'/node_modules/dep/extensionless',Buffer.from('module.exports=1;\n'));
    const nativeStat=m.fs.lstat,nativeOpen=m.fs.open;
    const fs:any={...m.fs,async lstat(p:string){const s=await nativeStat(p);return{...s,uid:controls.foreign===p?1001:1000};},async open(p:string,f:string){const h=await nativeOpen(p,f),stat=h.stat;return{...h,async stat(){return{...await stat(),uid:1000};}};}};
    return{...m,filesystem:fs,controls};
}
async function prepared(f:ReturnType<typeof installation>){
    const c=await censusInstrumentedGateway(root,1000,f.filesystem),artifactPath=root+'/ownership.cjs';
    const source={sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40)},artifactSHA256=sourceDigest(c.scripts.get(artifactPath));
    const selection={...source,artifactPath,artifactSHA256,observerSHA256:'c'.repeat(64)};
    const binding={kind:'separate-instrumented-gateway-build-byte-binding-v4',source,artifactPath,artifactSHA256,observerSHA256:selection.observerSHA256,
        generatedInventory:deriveInstrumentedGeneratedInventory(c.scripts,root),generatedInventorySHA256:sourceDigest(JSON.stringify(deriveInstrumentedGeneratedInventory(c.scripts,root))),rawCLIReference:RAW_CLI_REFERENCE,releaseAcceptance:false,buildProvenanceVerified:false,
        toolchain:{nodePath:'/tools/node',nodeSHA256:'d'.repeat(64)},guardSHA256:sourceDigest(c.scripts.get(root+'/resolution-guard.cjs')),activationSHA256:sourceDigest(c.scripts.get(root+'/activate.cjs')),
        installationPackageSHA256:c.packageSHA256,installationLockSHA256:c.lockSHA256,fileInventory:c.inventory,fileInventorySHA256:c.inventorySHA256,scriptInventory:c.scriptInventory,scriptInventorySHA256:c.scriptInventorySHA256};
    return{binding,selection,scripts:c.scripts};
}
const node=()=>({path:'/tools/node',sha256:'d'.repeat(64),version:'v24.22.0',execArgv:[],nodeOptions:null});
function receipt(p:any,mode='compatibility'){
    const common={source:p.binding.source,bindingSHA256:sourceDigest(JSON.stringify(p.binding)+'\n'),artifactSHA256:p.selection.artifactSHA256,instrumented:true,
        compiledScripts:1,generatedScripts:[],elapsedMs:1,releaseAcceptance:false,wholeGroupRetirement:null,shippedCLIBehavior:null};
    if(mode==='compatibility')return{schema:'instrumented-node-inspector-compatibility-v2',status:'exact-prelaunch-bytes-match-replayed-sources',...common,
        builtinScripts:0,builtinIdentityVerified:false,observerRetired:true,productWorkload:null};
    const afterClose={stopping:true,serverListening:false,cleanupTimers:0,requestTasks:0,httpSockets:0,httpResponses:0,httpBodyReaders:0,pendingConnections:0,sessions:0,inFlight:0,ownedSessions:0,retiringSessions:0,connectionAttempts:0,cancelledAttemptCache:0,sessionOwners:0,allSessionOwners:0};
    const active={...afterClose,stopping:false,serverListening:true,cleanupTimers:1};
    return{schema:'separate-instrumented-gateway-ownership-check-v2',...common,rawCLIReference:RAW_CLI_REFERENCE,evidenceSeparation:'this-instrumented-build-only-no-transfer-to-raw-CLI',
        before:active,afterHealth:{...active},afterClose,health:{role:'healthy',status:200,responseBytes:79,elapsedMs:1,requestRetired:true,responseRetired:true,socketRetired:true,wholeGroupRetirement:null,releaseAcceptance:false},
        observerRecordSHA256:'a'.repeat(64),productCloseAcknowledged:true,localObserverRetired:true,shippingGC:null,shippingPerformance:null};
}
function input(p:any,mode='compatibility'){
    return Buffer.from(JSON.stringify({schema:'owned-instrumented-gateway-child-input-v1',mode,nonce:'e'.repeat(32),root,uid:1000,node:node(),binding:p.binding,selection:p.selection,token:'f'.repeat(64)})+'\n');
}
function parent(f:any,p:any,mode='compatibility'){
    const selectedInput='/project/validation/gateway-ownership/child-input-'+mode+'.json';
    const child:any=new EventEmitter();Object.assign(child,{pid:2345,exitCode:null,signalCode:null,stdin:null,stdout:new EventEmitter(),stderr:new EventEmitter()});
    let saved=Buffer.alloc(0),launches=0,timer:Function=()=>{},clock=0;
    const controls:any={},ports={filesystem:f.filesystem,observeNode:async()=>controls.nodeChanged&&launches?{...node(),sha256:'0'.repeat(64)}:node(),
        writeExclusive:async(file:string,b:Buffer)=>{assert.equal(file,selectedInput);assert.equal(saved.length,0);saved=Buffer.from(b);},
        readInput:async()=>Buffer.from(saved),assertFilesSettled(){assert.equal(f.handles.size,0);},
        launch(file:string,args:string[],options:any){launches++;assert.equal(file,'/tools/node');assert.deepEqual(args,[root+'/activate.cjs',selectedInput]);assert.equal(options.stdio[0],'ignore');child.spawnfile=file;child.spawnargs=[file,...args];return child;},
        setTimer(cb:Function,ms:number){assert.equal(ms,60000);timer=cb;return{};},clearTimer(){},now:()=>clock};
    const emit=(change:(e:any)=>void=()=>{})=>{const v=JSON.parse(saved.toString()),r=receipt(p,v.mode);
        const e={schema:'owned-instrumented-gateway-child-result-v2',containment:containmentRecord(),mode:v.mode,nonce:v.nonce,inputSHA256:sourceDigest(saved),bindingSHA256:sourceDigest(JSON.stringify(p.binding)+'\n'),receipt:r,receiptSHA256:sourceDigest(JSON.stringify(r)+'\n')};change(e);
        child.emit('spawn');child.stdout.emit('data',Buffer.from(INSTRUMENTED_CHILD_MARKER+JSON.stringify(e)+'\n'));};
    const close=(code=0,signal:any=null,pipes=true)=>{child.emit('exit',code,signal);child.emit('close',code,signal);if(pipes){child.stdout.emit('close');child.stderr.emit('close');}};
    return{ports,controls,child,emit,close,get launches(){return launches;},expire(){clock=60001;timer();}};
}
test('complete two-pass census includes extensionless files and lock/package identities',async()=>{
    const f=installation(),c=await censusInstrumentedGateway(root,1000,f.filesystem);assert.equal(c.inventory.length,7);assert.ok(c.scripts.has(root+'/node_modules/dep/extensionless'));assert.equal(f.handles.size,0);
});
for(const kind of ['symlink','hardlink','binaryActivation','foreign','extra','optional','wrongVersion','missingActivation','alias','nestedOverride'])test('prelaunch census rejects '+kind,async()=>{
    const f=installation(),file=root+'/node_modules/dep/extensionless';
    if(kind==='symlink')f.records.get(file).kind='link';
    if(kind==='hardlink')f.records.get(file).nlink=2;
    if(kind==='binaryActivation')f.write(root+'/activate.cjs',Buffer.from([0xff]));
    if(kind==='foreign')f.controls.foreign=file;
    if(kind==='extra')f.write(root+'/.env',Buffer.from('synthetic-only'));
    if(kind==='optional')f.write(root+'/node_modules/unexpected/x',Buffer.from('x'));
    if(kind==='wrongVersion')f.write(root+'/node_modules/dep/package.json',Buffer.from('{"name":"dep","version":"2.0.0"}'));
    if(kind==='missingActivation')f.records.delete(root+'/activate.cjs');
    if(kind==='alias')f.records.get(file).target=root+'/ownership.cjs';
    if(kind==='nestedOverride'){f.write(root+'/node_modules/dep/node_modules/evil/package.json',Buffer.from('{"name":"evil","version":"1.0.0"}'));f.write(root+'/node_modules/dep/node_modules/evil/index.js',Buffer.from('module.exports=1'));}
    await assert.rejects(censusInstrumentedGateway(root,1000,f.filesystem));
});
test('second census pass rejects a changed file instead of blessing its later bytes',async()=>{
    const f=installation(),file=root+'/node_modules/dep/extensionless';let reads=0;
    f.hooks.read=async(p:string)=>{if(p===file&&++reads===3)f.write(file,Buffer.from('changed'));};
    await assert.rejects(censusInstrumentedGateway(root,1000,f.filesystem));
});
test('parent waits for direct normal child and both pipes, then preserves non-qualification',async()=>{
    const f=installation(),p=await prepared(f),h=parent(f,p),task=runOwnedInstrumentedGatewayChild(p,'compatibility',1000,h.ports);let done=false;task.then(()=>{done=true;});
    await pulse();assert.equal(h.launches,1);h.emit();h.close(0,null,false);await pulse();assert.equal(done,false);
    h.child.stdout.emit('close');await pulse();assert.equal(done,false);h.child.stderr.emit('close');const result=await task;
    assert.equal(result.receipt.normalChildAndPipesClosed,true);assert.equal(result.receipt.wholeGroupRetirement,null);assert.equal(result.receipt.releaseAcceptance,false);
});
for(const kind of ['nonce','mode','globalFailure','stderr','changedFile','changedNode','missingReceipt'])test('parent rejects '+kind,async()=>{
    const f=installation(),p=await prepared(f),h=parent(f,p),task=runOwnedInstrumentedGatewayChild(p,'compatibility',1000,h.ports);const rejected=assert.rejects(task);await pulse();
    if(kind!=='missingReceipt')h.emit(e=>{if(kind==='nonce')e.nonce='0'.repeat(32);if(kind==='mode')e.mode='ownership';});else h.child.emit('spawn');
    if(kind==='stderr')h.child.stderr.emit('data',Buffer.from('authored failure'));
    if(kind==='changedFile')f.write(root+'/ownership.cjs',Buffer.from('changed'));
    if(kind==='changedNode')h.controls.nodeChanged=true;
    h.close(kind==='globalFailure'?1:0);await rejected;
});
test('deadline rejects without sending a signal or relaunching',async()=>{
    const f=installation(),p=await prepared(f),h=parent(f,p),task=runOwnedInstrumentedGatewayChild(p,'compatibility',1000,h.ports);const rejected=assert.rejects(task);await pulse();h.expire();await rejected;assert.equal(h.launches,1);assert.equal(h.child.eventNames().includes('kill'),false);
});
function activation(f:any,p:any){
    const result=deferred(),closed=deferred(),flush=deferred(),controls:any={},events:string[]=[];let written=Buffer.alloc(0),clears=0,guardPrepared=false;
    const workload={result:result.promise,closed:closed.promise};
    const ports={root,uid:1000,filesystem:f.filesystem,
        assertContainment(){if(controls.guardFailure)throw Error('authored guard violation');},
        prepareContainmentClose(allowFailure:boolean){guardPrepared=true;return containmentRecord(controls.guardFailure?{failed:true,violationCode:'outside-root',outsideRejected:1}:{});},
        assertContainmentClose(allowFailure:boolean){assert.equal(guardPrepared,true);if(!allowFailure&&controls.guardLateFailure)throw Error('authored late guard failure');},
        containmentSnapshot(){return containmentRecord({closePrepared:guardPrepared,...(controls.guardFailure?{failed:true,violationCode:'outside-root',outsideRejected:1}:{})});},readInput:async()=>input(p),observeNode:async()=>node(),
        startHold(){events.push('hold');return{};},clearHold(){clears++;events.push('clear');if(controls.clearThrows)throw Error('authored uncertain clear');if(controls.clearRejected)return Promise.reject(Error('authored rejected clear'));},
        runCompatibility(){events.push('workload');if(controls.acquireThrows)throw Error('uncertain acquisition');if(controls.acquireRejected)return Promise.reject(Error('unsupported async acquisition'));return workload;},runOwnership(){throw Error('Wrong mode');},
        writeOutput(b:Buffer){events.push('stdout');written=Buffer.from(b);return controls.badWrite?undefined:{result:flush.promise,closed:Promise.resolve()};},
        assertFilesSettled(){assert.equal(f.handles.size,0);},setExitCode(c:number){assert.equal(c,1);events.push('exit1');}};
    const complete=()=>{const r=receipt(p);result.resolve({receipt:r,bytes:Buffer.from(JSON.stringify(r)+'\n')});};
    return{ports,events,controls,result,closed,flush,complete,get clears(){return clears;},get written(){return written;}};
}
test('activation retains liveness until workload closure and stdout callback, not just result settlement',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p),task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports);
    await pulse();h.complete();await pulse();assert.equal(h.written.length,0);assert.equal(h.clears,0);
    h.closed.resolve();await pulse();assert.ok(h.written.length>0);assert.equal(h.clears,0);h.flush.resolve();await task;assert.equal(h.clears,1);
    const e=JSON.parse(h.written.toString().slice(INSTRUMENTED_CHILD_MARKER.length));assert.equal(e.inputSHA256,sourceDigest(input(p)));assert.ok(!h.written.includes(Buffer.from('f'.repeat(64))));
});
for(const kind of ['clearThrows','clearRejected','badWrite','acquireThrows','acquireRejected'])test('activation retains uncertain '+kind+' without retrying cleanup',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p);h.controls[kind]=true;const task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),rejected=assert.rejects(task,(e:any)=>{assert.equal(e.owner.unknown,true);return true;});
    await pulse();h.flush.resolve();if(!kind.startsWith('acquire')){h.complete();h.closed.resolve();h.flush.resolve();}await rejected;assert.equal(h.clears,kind.startsWith('clear')?1:0);
});
test('acknowledged failed workload sets failure and joins closure before releasing liveness',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p),task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),rejected=assert.rejects(task);await pulse();h.result.reject(Error('authored failure'));await pulse();assert.ok(h.events.includes('exit1'));assert.equal(h.clears,0);assert.ok(h.written.toString().startsWith(INSTRUMENTED_CHILD_FAILURE_MARKER));h.flush.resolve();h.closed.resolve();await rejected;assert.equal(h.clears,1);
});
test('canonical input rejects changed mode/node version and extra fields',async()=>{
    const f=installation(),p=await prepared(f),bytes=input(p);assert.equal(parseInstrumentedChildInput(bytes,root).mode,'compatibility');
    for(const change of [(v:any)=>v.mode='unknown',(v:any)=>v.node.version='v24.19.0',(v:any)=>v.extra=true]){const v=JSON.parse(bytes.toString());change(v);assert.throws(()=>parseInstrumentedChildInput(Buffer.from(JSON.stringify(v)+'\n'),root));}
});
function inspector(p:any){
    const controls:any={},events:string[]=[],source=deferred();let timer:Function=()=>{},clock=0;
    class Session extends EventEmitter{
        connect(){events.push('connect');}disconnect(){events.push('disconnect');}
        post(method:string,_params:any,cb:Function){events.push(method);if(method==='Debugger.enable'){this.emit('Debugger.scriptParsed',{params:{scriptId:'1',url:pathToFileURL(controls.discoveredPath??p.selection.artifactPath).href}});cb(null,{});}
            else if(method==='Debugger.getScriptSource'){const bytes=p.scripts.get(p.selection.artifactPath).toString();if(controls.hold)source.promise.then(()=>cb(null,{scriptSource:bytes}));else cb(null,{scriptSource:controls.wrapper?'(function(){'+bytes+'})':bytes});}
            else {assert.equal(method,'Debugger.disable');cb(null,{});}}
    }
    const ports={sessionFactory:()=>new Session(),setTimer(cb:Function,ms:number){assert.equal(ms,15000);timer=cb;return{};},clearTimer(){},now:()=>clock};
    return{controls,events,ports,source,expire(){clock=15001;timer();}};
}
test('compatibility checks exact replayed CJS bytes without a product factory or HTTP port',async()=>{
    const f=installation(),p=await prepared(f),h=inspector(p),o=startInstrumentedInspectorCompatibility(p,h.ports),r=await o.result;await o.closed;
    assert.equal(r.receipt.observerRetired,true);assert.equal(r.receipt.productWorkload,null);assert.equal(r.receipt.releaseAcceptance,false);assert.ok(h.events.includes('disconnect'));
});
test('CommonJS wrapper mismatch fails; no wrapper stripping or source allowlist expansion',async()=>{
    const f=installation(),p=await prepared(f),h=inspector(p);h.controls.wrapper=true;const o=startInstrumentedInspectorCompatibility(p,h.ports);await assert.rejects(o.result);await o.closed;assert.equal(o.snapshot().retired,true);
});
test('compatibility timeout holds pending source callbacks until explicit retirement',async()=>{
    const f=installation(),p=await prepared(f),h=inspector(p);h.controls.hold=true;const o=startInstrumentedInspectorCompatibility(p,h.ports);await pulse();h.expire();await assert.rejects(o.result);assert.equal(o.snapshot().retired,false);h.source.resolve();await o.closed;assert.equal(o.snapshot().retired,true);assert.equal(o.snapshot().failed,true);
});
test('activation source has explicit fixed entry and contains no launcher, signals, endpoint or deletion',()=>{
    const text=readFileSync(new URL('./fixtures/instrumented-gateway-activate.cjs',import.meta.url),'utf8');
    assert.ok(text.includes('assert.equal(require.main, module)')&&text.includes("path.join(__dirname, '..', 'child-input-' + mode + '.json')"));
    const guard=(s:string)=>{assert.ok(!/\b(?:spawn|fork|exec|kill|rm|chmod)\s*\(|inspector\.open|process\.exit\s*\(/.test(s));};guard(text);assert.throws(()=>guard(text+'\nprocess.exit(0);'));
});

test('ownership requires the exact live parent compatibility capability, not a serialized or absent receipt',async()=>{
    const f=installation(),p=await prepared(f),h=parent(f,p,'ownership');
    await assert.rejects(runOwnedInstrumentedGatewayChild(p,'ownership',1000,h.ports));assert.equal(h.launches,0);
    await assert.rejects(runOwnedInstrumentedGatewayChild(p,'ownership',1000,{...h.ports,compatibility:{receipt:{observerRetired:true}}}));assert.equal(h.launches,0);
    const c=parent(f,p),first=runOwnedInstrumentedGatewayChild(p,'compatibility',1000,c.ports);await pulse();c.emit();c.close();const admission=await first;
    const second=runOwnedInstrumentedGatewayChild(p,'ownership',1000,{...h.ports,compatibility:admission});await pulse();assert.equal(h.launches,1);h.emit();h.close();await second;
    const replay=parent(f,p,'ownership');await assert.rejects(runOwnedInstrumentedGatewayChild(p,'ownership',1000,{...replay.ports,compatibility:admission}));assert.equal(replay.launches,0);
});
for(const kind of ['mode','uid','inputCollision'])test('child admission refuses '+kind+' before workload',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p);
    if(kind==='mode')h.ports.readInput=async()=>input(p,'ownership');
    if(kind==='uid')h.ports.uid=1001;
    if(kind==='inputCollision')h.ports.readInput=async()=>Buffer.from('bad input');
    h.flush.resolve();await assert.rejects(activateOwnedInstrumentedGatewayChild(inputPath,h.ports));assert.equal(h.events.includes('workload'),false);assert.equal(h.clears,1);
});
function outputFixture(){
    const stream:any=new EventEmitter(),controls:any={},events:string[]=[];let callback:Function=()=>{},failures=0;
    stream.write=(bytes:Buffer,cb:Function)=>{assert.ok(stream.listenerCount('error')===1);events.push('dispatch');callback=cb;if(controls.throwWrite)throw Error('uncertain dispatch');return controls.returned??false;};
    const start=()=>startInstrumentedChildOutput(Buffer.from('synthetic receipt'),stream,()=>{failures++;});
    return{stream,controls,events,start,callback:(e?:Error)=>callback(e),get failures(){return failures;}};
}
test('stdout callback success retires only the write and keeps the child-lifetime error observer',async()=>{
    const h=outputFixture(),o=h.start();assert.equal(o.snapshot().writeRetired,false);h.callback();await o.result;await o.closed;
    assert.equal(o.snapshot().pipeRetired,false);assert.equal(h.stream.listenerCount('error'),1);h.stream.emit('error',Error('authored late error'));assert.equal(h.failures,1);
});
for(const order of ['event-first','callback-first'])test('stdout '+order+' error remains observed and requires callback acknowledgement',async()=>{
    const h=outputFixture(),o=h.start(),rejected=assert.rejects(o.result);const e=Error('authored write failure');
    if(order==='event-first'){h.stream.emit('error',e);assert.equal(o.snapshot().writeRetired,false);h.callback(e);}else{h.callback(e);h.stream.emit('error',e);}
    await rejected;await o.closed;assert.ok(h.failures>=1);assert.equal(o.snapshot().writeAcknowledged,true);
});
for(const kind of ['throwWrite','unknownReturn'])test('stdout uncertain '+kind+' retains its write without inventing closure',async()=>{
    const h=outputFixture();if(kind==='throwWrite')h.controls.throwWrite=true;else h.controls.returned=Promise.reject(Error('authored rejected return'));
    const o=h.start();await assert.rejects(o.result);await pulse();assert.equal(o.snapshot().writeRetired,false);assert.equal(o.snapshot().unknownOperation,true);
});
test('activation joins rejected stdout result until the separate write retirement acknowledgement',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p),write=deferred(),retired=deferred();
    h.ports.writeOutput=()=>({result:write.promise,closed:retired.promise});
    const task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),rejected=assert.rejects(task);await pulse();h.complete();h.closed.resolve();await pulse();write.reject(Error('authored pipe error'));await pulse();assert.equal(h.clears,0);retired.resolve();await rejected;assert.equal(h.clears,1);
});

for(const mode of ['compatibility','ownership'])test('strict '+mode+' receipt rejects omitted and wrong substantive observations',async()=>{
    const f=installation(),p=await prepared(f),r:any=receipt(p,mode);validateInstrumentedChildReceipt(p,mode,r);
    const changes=mode==='compatibility'?[(v:any)=>delete v.status,(v:any)=>v.compiledScripts=0,(v:any)=>v.builtinScripts=2048,(v:any)=>v.elapsedMs=15001]:
        [(v:any)=>delete v.health,(v:any)=>v.health.status=500,(v:any)=>v.health.socketRetired=false,(v:any)=>v.elapsedMs=45001,(v:any)=>delete v.afterClose.sessions,(v:any)=>v.before.cleanupTimers=0];
    for(const change of changes){const v=structuredClone(r);change(v);assert.throws(()=>validateInstrumentedChildReceipt(p,mode,v));}
});

test('exclusive input and unsettled file ports cannot turn unknown acknowledgements into admission',async()=>{
    for(const kind of ['write','settled']){
        const f=installation(),p=await prepared(f),h=parent(f,p);const ports:any={...h.ports};
        if(kind==='write')ports.writeExclusive=()=>undefined;
        else ports.assertFilesSettled=()=>Promise.reject(Error('unsupported async custody'));
        await assert.rejects(runOwnedInstrumentedGatewayChild(p,'compatibility',1000,ports));await pulse();assert.equal(h.launches,0);
    }
});
test('fixed CJS activation calls only the copied owner export and rejects unsupported argv before activation',async()=>{
    const source=readFileSync(new URL('./fixtures/instrumented-gateway-activate.cjs',import.meta.url),'utf8');
    assert.ok(Buffer.byteLength(source)<2048);
    for(const mode of ['compatibility','ownership','invalid']){
        let calls=0,guards=0;const guard={retainFailure(){throw Error('unexpected guard uncertainty');}},module={},pending=deferred(),process:any={platform:'linux',arch:'x64',version:'v24.22.0',execArgv:[],env:{},argv:['/tools/node',root+'/activate.cjs','/project/validation/gateway-ownership/child-input-'+mode+'.json']};
        const require:any=(name:string)=>{if(name==='node:assert/strict')return assert;if(name==='node:path')return{join:(...v:string[])=>v.join('/').replace('/instrumented/..','')};
            if(name==='node:module')return{registerHooks(){throw Error('native registration forbidden in activation projection');},isBuiltin:()=>false};
            if(name==='./resolution-guard.cjs')return{createInstrumentedResolutionGuard:(selected:string,ports:any)=>{assert.equal(selected,root);assert.equal(typeof ports.onUncertain,'function');guards++;return guard;}};
            assert.equal(name,'./ownership.cjs');assert.equal(guards,1);return{activateInstrumentedGatewayChildFromFile:(p:string,selectedGuard:any)=>{assert.equal(selectedGuard,guard);calls++;assert.equal(p,process.argv[2]);return pending.promise;}};};require.main=module;
        const run=()=>runInNewContext('process.execArgv = [];\n'+source,{require,module,process,__dirname:root,__filename:root+'/activate.cjs'},{timeout:1000});
        if(mode==='invalid'){assert.throws(run);assert.equal(calls,0);}else{run();assert.equal(calls,1);pending.reject(Error('authored owner failure'));await pulse();assert.equal(process.exitCode,1);}
    }
});

const binaryPath=root+'/node_modules/dep/pagent.exe';
const binaryBytes=()=>Buffer.concat([Buffer.from([0x4d,0x5a,0x90,0x00]),Buffer.alloc(50684)]);
test('binary package bytes stay fully inventoried while exact UTF-8 extensionless and BOM candidates remain unchanged',async()=>{
    const f=installation(),binary=binaryBytes(),bom=Buffer.from('\uFEFFmodule.exports=1;\r\n');
    assert.throws(()=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(binary));
    f.write(binaryPath,binary);f.write(root+'/node_modules/dep/bom.cjs',bom);
    const c=await censusInstrumentedGateway(root,1000,f.filesystem);
    assert.ok(c.files.get(binaryPath)!.equals(binary));assert.equal(c.scripts.has(binaryPath),false);
    assert.deepEqual(c.inventory.find(v=>v.path===binaryPath),{path:binaryPath,bytes:50688,sha256:sourceDigest(binary)});
    assert.ok(c.scripts.get(root+'/node_modules/dep/bom.cjs')!.equals(bom));
    assert.equal(c.inventory.length,c.scriptInventory.length+1);assert.equal(f.handles.size,0);
});
test('binary mutation between census passes is rejected even when script candidates are unchanged',async()=>{
    const f=installation();f.write(binaryPath,binaryBytes());let reads=0;
    f.hooks.read=async(p:string)=>{if(p===binaryPath&&++reads===3){const b=binaryBytes();b[b.length-1]=1;f.write(p,b);}};
    await assert.rejects(censusInstrumentedGateway(root,1000,f.filesystem));
});
for(const timing of ['beforeLaunch','afterLaunch'])test('binary identity mutation '+timing+' rejects parent admission or closure',async()=>{
    const f=installation();f.write(binaryPath,binaryBytes());const p=await prepared(f),h=parent(f,p);
    if(timing==='beforeLaunch')f.write(binaryPath,Buffer.from([0xff]));
    const task=runOwnedInstrumentedGatewayChild(p,'compatibility',1000,h.ports),rejected=assert.rejects(task);
    await pulse();
    if(timing==='afterLaunch'){assert.equal(h.launches,1);h.emit();f.write(binaryPath,Buffer.from([0xff]));h.close();}
    await rejected;assert.equal(h.launches,timing==='beforeLaunch'?0:1);
});
test('complete binary-inclusive binding permits the normal fake child lifecycle without claiming release qualification',async()=>{
    const f=installation();f.write(binaryPath,binaryBytes());const p=await prepared(f),h=parent(f,p);
    const task=runOwnedInstrumentedGatewayChild(p,'compatibility',1000,h.ports);await pulse();assert.equal(h.launches,1);h.emit();h.close();
    const r=await task;assert.equal(r.receipt.postCensusUnchanged,true);assert.equal(r.receipt.releaseAcceptance,false);
});
test('an Inspector event naming an excluded binary is rejected rather than silently ignored',async()=>{
    const f=installation();f.write(binaryPath,binaryBytes());const p=await prepared(f),h=inspector(p);h.controls.discoveredPath=binaryPath;
    const o=startInstrumentedInspectorCompatibility(p,h.ports);await assert.rejects(o.result);await o.closed;
    assert.equal(o.snapshot().failed,true);
});
test('dropping a binary from the bound inventory cannot authorize parent launch',async()=>{
    const f=installation();f.write(binaryPath,binaryBytes());const p=await prepared(f);
    p.binding.fileInventory=p.binding.fileInventory.filter(v=>v.path!==binaryPath);p.binding.fileInventorySHA256=sourceDigest(JSON.stringify(p.binding.fileInventory));
    const h=parent(f,p);await assert.rejects(runOwnedInstrumentedGatewayChild(p,'compatibility',1000,h.ports));assert.equal(h.launches,0);
});

test('failed activation preserves the original private cause and emits bound diagnostics before a held workload joins',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p),cause=Error('private-authored-error');
    const task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),rejected=assert.rejects(task,(e:any)=>{assert.equal(e.cause,cause);return true;});await pulse();h.result.reject(cause);await pulse();
    assert.ok(h.written.toString().startsWith(INSTRUMENTED_CHILD_FAILURE_MARKER));const parsed=JSON.parse(input(p).toString()),detail=parseInstrumentedChildFailure(h.written,parsed,input(p));
    assert.equal(detail.phase,'workload');assert.equal(detail.knownWorkload,true);assert.equal(detail.releaseAcceptance,false);assert.equal(h.clears,0);assert.equal(h.written.includes(Buffer.from(cause.message)),false);
    h.flush.resolve();await pulse();assert.equal(h.clears,0);h.closed.resolve();await rejected;assert.equal(h.clears,1);
});
test('failure diagnostics cannot disclose strings, forge identity, or authorize successful child acceptance',async()=>{
    const f=installation(),p=await prepared(f),data=input(p),parsed=JSON.parse(data.toString());
    const detail=projectInstrumentedChildFailure('workload',true,true,{failed:true,retired:false,collector:{failureCode:'/secret/url',pendingCallbacks:1,compiledScripts:2,token:'private',acquisitionHeld:true}});
    const bytes=encodeInstrumentedChildFailure(parsed,data,detail);assert.ok(!bytes.includes(Buffer.from('private'))&&!bytes.includes(Buffer.from('/secret')));assert.ok(bytes.length<=4096);
    assert.equal(parseInstrumentedChildFailure(bytes,parsed,data).inspectorFailure,null);
    for(const change of [(v:any)=>v.nonce='0'.repeat(32),(v:any)=>v.mode='ownership',(v:any)=>v.bindingSHA256='0'.repeat(64),(v:any)=>v.detail.releaseAcceptance=true,(v:any)=>v.detail.extra='secret']){
        const v=JSON.parse(bytes.toString().slice(INSTRUMENTED_CHILD_FAILURE_MARKER.length));change(v);await assert.rejects(async()=>parseInstrumentedChildFailure(Buffer.from(INSTRUMENTED_CHILD_FAILURE_MARKER+JSON.stringify(v)+'\n'),parsed,data));
    }
});

test('compatibility preserves the private Inspector cause and exposes only its fixed code',async()=>{
    const f=installation(),p=await prepared(f),h=inspector(p),factory=h.ports.sessionFactory,cause=Error('authored-private-inspector-failure');
    h.ports.sessionFactory=()=>{const session=factory(),post=session.post.bind(session);session.post=(method:string,params:any,cb:Function)=>{if(method==='Debugger.getScriptSource')cb(cause);else post(method,params,cb);};return session;};
    const o=startInstrumentedInspectorCompatibility(p,h.ports);await assert.rejects(o.result,(e:any)=>{assert.equal(e.cause,cause);return true;});await o.closed;
    assert.equal(o.snapshot().collector.failureCode,'inspector-callback');assert.ok(!JSON.stringify(projectInstrumentedChildFailure('workload',false,true,o.snapshot())).includes(cause.message));
});

test('compatibility cleanup errors retain their own cause when the collector has no earlier failure',async()=>{
    const f=installation(),p=await prepared(f),h=inspector(p),cause=Error('authored-private-cleanup-error');
    h.ports.clearTimer=()=>{throw cause;};const o=startInstrumentedInspectorCompatibility(p,h.ports);
    await assert.rejects(o.result,(e:any)=>{assert.equal(e.cause,cause);return true;});assert.equal(o.snapshot().retired,false);
});

test('an unreadable diagnostic snapshot cannot replace the original error or skip actual workload retirement',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p),cause=Error('authored-original-failure');
    const original=h.ports.runCompatibility;h.ports.runCompatibility=()=>({...original(),snapshot:()=>({get collector(){throw Error('diagnostic getter failed');}})});
    const task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),rejected=assert.rejects(task,(e:any)=>{assert.equal(e.cause,cause);return true;});await pulse();h.result.reject(cause);await pulse();assert.equal(h.clears,0);h.closed.resolve();await rejected;assert.equal(h.clears,1);
});

test('diagnostic-write rejection preserves workload cause and waits for separate write and workload closure',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p),cause=Error('authored-primary-workload'),write=deferred(),closed=deferred();let writes=0;
    h.ports.writeOutput=()=>{writes++;return{result:write.promise,closed:closed.promise};};
    const task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),rejected=assert.rejects(task,(e:any)=>{assert.equal(e.cause,cause);return true;});await pulse();h.result.reject(cause);await pulse();assert.equal(writes,1);
    write.reject(Error('authored-secondary-writer'));await pulse();assert.equal(h.clears,0);h.closed.resolve();await pulse();assert.equal(h.clears,0);closed.resolve();await rejected;assert.equal(h.clears,1);
});
for(const kind of ['throw','thenable'])test('unknown diagnostic writer '+kind+' retains custody without replacing the primary cause',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p),cause=Error('authored-primary-workload');let writes=0;
    (h.ports as any).writeOutput=()=>{writes++;if(kind==='throw')throw Error('authored-secondary-writer');return Promise.reject(Error('authored-unsupported-writer'));};
    const task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),rejected=assert.rejects(task,(e:any)=>{assert.equal(e.cause,cause);assert.equal(e.owner.unknown,true);return true;});await pulse();h.result.reject(cause);await pulse();h.closed.resolve();await rejected;assert.equal(writes,1);assert.equal(h.clears,0);
});

for(const field of ['registered','uncertain','closePrepared'])test('parent refuses unsupported containment readiness '+field,async()=>{
    const f=installation(),p=await prepared(f),h=parent(f,p),task=runOwnedInstrumentedGatewayChild(p,'compatibility',1000,h.ports),failure=assert.rejects(task);await pulse();h.emit(e=>{e.containment[field]=field==='uncertain'?true:false;});h.close();await failure;
});
test('late guard failure after stdout acceptance cannot complete a child successfully',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p);h.controls.guardLateFailure=true;const task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),failure=assert.rejects(task);await pulse();h.complete();h.closed.resolve();await pulse();h.flush.resolve();await failure;assert.ok(h.events.includes('exit1'));assert.equal(h.clears,1);
});
test('unknown containment preparation preserves liveness and never retries',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p);let calls=0;h.ports.prepareContainmentClose=()=>{calls++;throw Error('authored unknown preparation');};const task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),failure=assert.rejects(task);await pulse();h.complete();h.closed.resolve();h.flush.resolve();await failure;assert.equal(calls,1);assert.equal(h.clears,0);
});

test('parent rejects a guard-byte replacement after a purported successful child result',async()=>{
    const f=installation(),p=await prepared(f),h=parent(f,p),task=runOwnedInstrumentedGatewayChild(p,'compatibility',1000,h.ports),failure=assert.rejects(task);await pulse();h.emit();f.write(root+'/resolution-guard.cjs',Buffer.from('// replaced guard\n'));h.close();await failure;
});
