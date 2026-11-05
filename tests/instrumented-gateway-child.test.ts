import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
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
    const binding={kind:'separate-instrumented-gateway-build-byte-binding-v1',source,artifactPath,artifactSHA256,observerSHA256:selection.observerSHA256,
        rawCLIReference:RAW_CLI_REFERENCE,releaseAcceptance:false,buildProvenanceVerified:false,
        toolchain:{nodePath:'/tools/node',nodeSHA256:'d'.repeat(64)},activationSHA256:sourceDigest(c.scripts.get(root+'/activate.cjs')),
        installationPackageSHA256:c.packageSHA256,installationLockSHA256:c.lockSHA256,scriptInventory:c.inventory,scriptInventorySHA256:c.inventorySHA256};
    return{binding,selection,scripts:c.scripts};
}
const node=()=>({path:'/tools/node',sha256:'d'.repeat(64),version:'v24.22.0',execArgv:[],nodeOptions:null});
function receipt(p:any,mode='compatibility'){
    const common={source:p.binding.source,bindingSHA256:sourceDigest(JSON.stringify(p.binding)+'\n'),artifactSHA256:p.selection.artifactSHA256,instrumented:true,
        compiledScripts:1,elapsedMs:1,releaseAcceptance:false,wholeGroupRetirement:null,shippedCLIBehavior:null};
    if(mode==='compatibility')return{schema:'instrumented-node-inspector-compatibility-v1',status:'exact-prelaunch-bytes-match-replayed-sources',...common,
        builtinScripts:0,builtinIdentityVerified:false,observerRetired:true,productWorkload:null};
    const afterClose={stopping:true,serverListening:false,cleanupTimers:0,requestTasks:0,httpSockets:0,httpResponses:0,httpBodyReaders:0,pendingConnections:0,sessions:0,inFlight:0,ownedSessions:0,retiringSessions:0,connectionAttempts:0,cancelledAttemptCache:0,sessionOwners:0,allSessionOwners:0};
    const active={...afterClose,stopping:false,serverListening:true,cleanupTimers:1};
    return{schema:'separate-instrumented-gateway-ownership-check-v1',...common,rawCLIReference:RAW_CLI_REFERENCE,evidenceSeparation:'this-instrumented-build-only-no-transfer-to-raw-CLI',
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
        const e={schema:'owned-instrumented-gateway-child-result-v1',mode:v.mode,nonce:v.nonce,inputSHA256:sourceDigest(saved),bindingSHA256:sourceDigest(JSON.stringify(p.binding)+'\n'),receipt:r,receiptSHA256:sourceDigest(JSON.stringify(r)+'\n')};change(e);
        child.emit('spawn');child.stdout.emit('data',Buffer.from(INSTRUMENTED_CHILD_MARKER+JSON.stringify(e)+'\n'));};
    const close=(code=0,signal:any=null,pipes=true)=>{child.emit('exit',code,signal);child.emit('close',code,signal);if(pipes){child.stdout.emit('close');child.stderr.emit('close');}};
    return{ports,controls,child,emit,close,get launches(){return launches;},expire(){clock=60001;timer();}};
}
test('complete two-pass census includes extensionless files and lock/package identities',async()=>{
    const f=installation(),c=await censusInstrumentedGateway(root,1000,f.filesystem);assert.equal(c.inventory.length,6);assert.ok(c.scripts.has(root+'/node_modules/dep/extensionless'));assert.equal(f.handles.size,0);
});
for(const kind of ['symlink','hardlink','binary','foreign','extra','optional','wrongVersion','missingActivation','alias','nestedOverride'])test('prelaunch census rejects '+kind,async()=>{
    const f=installation(),file=root+'/node_modules/dep/extensionless';
    if(kind==='symlink')f.records.get(file).kind='link';
    if(kind==='hardlink')f.records.get(file).nlink=2;
    if(kind==='binary')f.write(file,Buffer.from([0xff]));
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
    const result=deferred(),closed=deferred(),flush=deferred(),controls:any={},events:string[]=[];let written=Buffer.alloc(0),clears=0;
    const workload={result:result.promise,closed:closed.promise};
    const ports={root,uid:1000,filesystem:f.filesystem,readInput:async()=>input(p),observeNode:async()=>node(),
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
    await pulse();if(!kind.startsWith('acquire')){h.complete();h.closed.resolve();h.flush.resolve();}await rejected;assert.equal(h.clears,kind.startsWith('clear')?1:0);
});
test('acknowledged failed workload sets failure and joins closure before releasing liveness',async()=>{
    const f=installation(),p=await prepared(f),h=activation(f,p),task=activateOwnedInstrumentedGatewayChild(inputPath,h.ports),rejected=assert.rejects(task);await pulse();h.result.reject(Error('authored failure'));await pulse();assert.ok(h.events.includes('exit1'));assert.equal(h.clears,0);h.closed.resolve();await rejected;assert.equal(h.clears,1);assert.equal(h.written.length,0);
});
test('canonical input rejects changed mode/node version and extra fields',async()=>{
    const f=installation(),p=await prepared(f),bytes=input(p);assert.equal(parseInstrumentedChildInput(bytes,root).mode,'compatibility');
    for(const change of [(v:any)=>v.mode='unknown',(v:any)=>v.node.version='v24.19.0',(v:any)=>v.extra=true]){const v=JSON.parse(bytes.toString());change(v);assert.throws(()=>parseInstrumentedChildInput(Buffer.from(JSON.stringify(v)+'\n'),root));}
});
function inspector(p:any){
    const controls:any={},events:string[]=[],source=deferred();let timer:Function=()=>{},clock=0;
    class Session extends EventEmitter{
        connect(){events.push('connect');}disconnect(){events.push('disconnect');}
        post(method:string,_params:any,cb:Function){events.push(method);if(method==='Debugger.enable'){this.emit('Debugger.scriptParsed',{params:{scriptId:'1',url:pathToFileURL(p.selection.artifactPath).href}});cb(null,{});}
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
    await assert.rejects(activateOwnedInstrumentedGatewayChild(inputPath,h.ports));assert.equal(h.events.includes('workload'),false);assert.equal(h.clears,1);
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
        let calls=0;const module={},pending=deferred(),process:any={argv:['/tools/node',root+'/activate.cjs','/project/validation/gateway-ownership/child-input-'+mode+'.json']};
        const require:any=(name:string)=>{if(name==='node:assert/strict')return assert;if(name==='node:path')return{join:(...v:string[])=>v.join('/').replace('/instrumented/..','')};
            assert.equal(name,'./ownership.cjs');return{activateInstrumentedGatewayChildFromFile:(p:string)=>{calls++;assert.equal(p,process.argv[2]);return pending.promise;}};};require.main=module;
        const run=()=>runInNewContext(source,{require,module,process,__dirname:root,__filename:root+'/activate.cjs'},{timeout:1000});
        if(mode==='invalid'){assert.throws(run);assert.equal(calls,0);}else{run();assert.equal(calls,1);pending.reject(Error('authored owner failure'));await pulse();assert.equal(process.exitCode,1);}
    }
});
