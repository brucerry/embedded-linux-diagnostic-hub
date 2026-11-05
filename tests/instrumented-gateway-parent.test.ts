import assert from 'node:assert/strict';
import { deriveInstrumentedGeneratedInventory } from '../scripts/lib/instrumented-gateway-generated.mjs';
import { encodeInstrumentedChildFailure,projectInstrumentedChildFailure } from '../scripts/lib/instrumented-gateway-failure.mjs';
import { instrumentedFailureSummary } from '../scripts/lib/instrumented-gateway-policy.mjs';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { constants, readFileSync } from 'node:fs';
import { createInstrumentedGatewayParent } from '../scripts/lib/instrumented-gateway-parent.mjs';
import { censusInstrumentedGateway } from '../scripts/lib/instrumented-gateway-census.mjs';
import { RAW_CLI_REFERENCE } from '../scripts/lib/instrumented-gateway-check.mjs';
import { INSTRUMENTED_CHILD_MARKER } from '../scripts/lib/instrumented-gateway-child.mjs';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { memoryFilesystem } from './fixtures/gateway-producer-memory';
const root='/project/validation/gateway-ownership/instrumented',parent='/project/validation/gateway-ownership';
const nodeBytes=Buffer.from('synthetic Node identity bytes; never executed');
const pulse=async()=>{for(let i=0;i<500;i++)await Promise.resolve();};
const until=async(check:()=>boolean)=>{for(let i=0;i<6000&&!check();i++)await Promise.resolve();assert.ok(check(),'Bounded fake operation did not reach expected state');};
const deferred=()=>{let resolve!:(v?:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return{promise,resolve};};
function installation(){
    const f=memoryFilesystem(),controls:any={},directories=new Set<any>(),events:string[]=[];
    const inputFile=(p:string)=>p.startsWith(parent+'/child-input-');
    f.write('/tools/node',nodeBytes);f.write(root+'/ownership.cjs',Buffer.from('// synthetic compiled source; never run\n'));
    f.write(root+'/activate.cjs',Buffer.from('// synthetic fixed activation; never run\n'));
    f.write(root+'/package.json',Buffer.from('{"name":"synthetic","version":"1.0.0"}'));
    f.write(root+'/package-lock.json',Buffer.from('{"lockfileVersion":3,"packages":{"":{"name":"synthetic","version":"1.0.0"},"node_modules/dep":{"version":"1.0.0"}}}'));
    f.write(root+'/node_modules/dep/package.json',Buffer.from('{"name":"dep","version":"1.0.0"}'));
    const baseStat=f.fs.lstat;
    const stat=async(p:string)=>({...await baseStat(p),uid:1000});
    const native:any={...f.fs,lstat:stat,async open(p:string,flags:number){
        events.push('open:'+p);assert.ok(flags&constants.O_NOFOLLOW);
        if(flags&constants.O_DIRECTORY){
            const h={stat:()=>stat(p),async sync(){if(controls.directorySyncError)throw Error('authored directory sync failure');},async close(){if(controls.directoryCloseError)throw Error('authored directory close failure');directories.delete(h);}};
            directories.add(h);return h;
        }
        const writing=Boolean(flags&constants.O_EXCL);if(writing){assert.ok(inputFile(p));if(controls.openHold)await controls.openHold.promise;}
        const h=await f.fs.open(p,writing?'wx':'r');
        return{read:(...a:[Buffer,number,number])=>h.read(...a),async stat(){return{...await h.stat(),uid:1000};},
            async write(b:Buffer,offset:number,length:number,position:number){const n=Math.min(length,controls.partial??65536),old=f.bytes(p),next=Buffer.alloc(Math.max(old.length,position+n));old.copy(next);b.copy(next,position,offset,offset+n);f.write(p,next);return{bytesWritten:n};},
            async sync(){if(writing&&controls.fileSyncError)throw Error('authored sync failure');},
            async close(){if(writing&&controls.closeHold)await controls.closeHold.promise;if(writing&&controls.fileCloseError)throw Error('authored close failure');await h.close();if(writing&&controls.replaceOnClose)f.write(p,f.bytes(p),true);}};
    },async opendir(p:string){const rows=await f.fs.readdir(p);let at=0;const h={async read(){return rows[at++]??null;},async close(){if(controls.censusDirectoryCloseError)throw Error('authored census directory close failure');directories.delete(h);}};directories.add(h);return h;}};
    return{...f,controls,native,events,directories,filesystem:{...f.fs,lstat:stat}};
}
async function prepared(f:ReturnType<typeof installation>){
    const c=await censusInstrumentedGateway(root,1000,f.filesystem),artifactPath=root+'/ownership.cjs',source={sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40)},artifactSHA256=sourceDigest(c.scripts.get(artifactPath));
    const selection={...source,artifactPath,artifactSHA256,observerSHA256:'c'.repeat(64)};
    const binding={kind:'separate-instrumented-gateway-build-byte-binding-v3',source,artifactPath,artifactSHA256,observerSHA256:selection.observerSHA256,
        generatedInventory:deriveInstrumentedGeneratedInventory(c.scripts,root),generatedInventorySHA256:sourceDigest(JSON.stringify(deriveInstrumentedGeneratedInventory(c.scripts,root))),rawCLIReference:RAW_CLI_REFERENCE,releaseAcceptance:false,buildProvenanceVerified:false,toolchain:{nodePath:'/tools/node',nodeSHA256:sourceDigest(nodeBytes)},
        activationSHA256:sourceDigest(c.scripts.get(root+'/activate.cjs')),installationPackageSHA256:c.packageSHA256,installationLockSHA256:c.lockSHA256,fileInventory:c.inventory,fileInventorySHA256:c.inventorySHA256,scriptInventory:c.scriptInventory,scriptInventorySHA256:c.scriptInventorySHA256};
    return{binding,selection,scripts:c.scripts};
}
function childReceipt(p:any,mode:string){
    const common={source:p.binding.source,bindingSHA256:sourceDigest(JSON.stringify(p.binding)+'\n'),artifactSHA256:p.selection.artifactSHA256,instrumented:true,compiledScripts:1,generatedScripts:[],elapsedMs:1,releaseAcceptance:false,wholeGroupRetirement:null,shippedCLIBehavior:null};
    if(mode==='compatibility')return{...common,schema:'instrumented-node-inspector-compatibility-v2',status:'exact-prelaunch-bytes-match-replayed-sources',builtinScripts:0,builtinIdentityVerified:false,observerRetired:true,productWorkload:null};
    const zero={stopping:true,serverListening:false,cleanupTimers:0,requestTasks:0,httpSockets:0,httpResponses:0,httpBodyReaders:0,pendingConnections:0,sessions:0,inFlight:0,ownedSessions:0,retiringSessions:0,connectionAttempts:0,cancelledAttemptCache:0,sessionOwners:0,allSessionOwners:0};
    return{...common,schema:'separate-instrumented-gateway-ownership-check-v2',rawCLIReference:RAW_CLI_REFERENCE,evidenceSeparation:'this-instrumented-build-only-no-transfer-to-raw-CLI',before:{...zero,stopping:false,serverListening:true,cleanupTimers:1},afterHealth:{...zero,stopping:false,serverListening:true,cleanupTimers:1},afterClose:zero,
        health:{role:'healthy',status:200,responseBytes:79,elapsedMs:1,requestRetired:true,responseRetired:true,socketRetired:true,wholeGroupRetirement:null,releaseAcceptance:false},observerRecordSHA256:'a'.repeat(64),productCloseAcknowledged:true,localObserverRetired:true,shippingGC:null,shippingPerformance:null};
}
function host(f:ReturnType<typeof installation>,p:any){
    const controls:any={},children:any[]=[],timers:Function[]=[],events:string[]=[];
    const runtime={platform:'linux',arch:'x64',version:'v24.22.0',execPath:'/tools/node',execArgv:[],uid:1000,nodeOptions:null,nodePathVariable:null};
    const ports:any={runtime,filesystem:f.native,now:()=>0,setTimer(fn:Function,ms:number){assert.equal(ms,60000);timers.push(fn);return{fn};},clearTimer(){if(controls.rejectedTimer)return Promise.reject(Error('authored unknown timer retirement'));},
        launch(file:string,args:string[],options:any){
            const mode=children.length?'ownership':'compatibility';events.push('launch:'+mode);
            assert.deepEqual(args,[root+'/activate.cjs',parent+'/child-input-'+mode+'.json']);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
            const input=f.bytes(args[1]),v=JSON.parse(input.toString()),receipt:any=childReceipt({binding:v.binding,selection:v.selection},mode);
            const envelope={schema:'owned-instrumented-gateway-child-result-v1',mode,nonce:v.nonce,inputSHA256:sourceDigest(input),bindingSHA256:sourceDigest(JSON.stringify(v.binding)+'\n'),receipt,receiptSHA256:sourceDigest(JSON.stringify(receipt)+'\n')};
            if(controls.badReceipt)envelope.nonce='0'.repeat(32);
            const child:any=new EventEmitter();Object.assign(child,{pid:2222+children.length,exitCode:null,signalCode:null,stdin:null,stdout:new EventEmitter(),stderr:new EventEmitter(),spawnfile:file,spawnargs:[file,...args]});
            if(controls.wrongSpawn)child.spawnargs=[file,'unapproved'];
            child.close=(code=0)=>{child.emit('exit',code,null);child.emit('close',code,null);if(!controls.holdPipes){child.stdout.emit('close');child.stderr.emit('close');}};
            const diagnostic=encodeInstrumentedChildFailure(controls.badFailureBinding?{...v,nonce:'0'.repeat(32)}:v,input,projectInstrumentedChildFailure('workload',false,true,{failed:true,retired:true,collector:{failureCode:'script-unadmitted',observerRetired:true,pendingCallbacks:0}}));
            children.push(child);
            Promise.resolve().then(()=>{child.started=true;child.emit('spawn');child.stdout.emit('data',controls.failedChild?diagnostic:controls.overflow?Buffer.alloc(32769):Buffer.from(INSTRUMENTED_CHILD_MARKER+JSON.stringify(envelope)+'\n'));
                if(controls.replaceAfterReceipt)f.write(args[1],f.bytes(args[1]),true);
                if(controls.changeNode)f.write('/tools/node',nodeBytes,true);
                if(!controls.holdChild)child.close(controls.nonzero||controls.failedChild?1:0);});
            return child;
        }};
    return{ports,controls,children,events,expire:()=>timers.at(-1)!()};
}
test('native parent construction is inert; run owns exactly the two sequential bound children',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p),before=f.events.length,owner=createInstrumentedGatewayParent(p,h.ports);
    assert.equal(f.events.length,before);assert.equal(h.children.length,0);assert.equal(owner.snapshot().admitted,false);
    f.controls.partial=7;const result=await owner.run();
    assert.deepEqual(h.events,['launch:compatibility','launch:ownership']);assert.equal(owner.snapshot().completed,true);assert.equal(f.handles.size,0);assert.equal(f.directories.size,0);
    assert.equal(result.receipt.inputsAcknowledged,2);assert.equal(result.receipt.processGroupRetirement,null);assert.equal(result.receipt.shippingCLIBehavior,null);assert.equal(result.receipt.releaseAcceptance,false);assert.ok(result.bytes.length<=16384);
    const first=JSON.parse(f.bytes(parent+'/child-input-compatibility.json').toString()),second=JSON.parse(f.bytes(parent+'/child-input-ownership.json').toString());assert.notEqual(first.nonce,second.nonce);assert.equal(first.mode,'compatibility');assert.equal(second.mode,'ownership');
    await assert.rejects(owner.run());assert.equal(h.children.length,2);
});
for(const field of ['version','uid','execPath','nodeOptions','nodePathVariable','arch'])test('unsupported actual host '+field+' fails before IO',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p),before=f.events.length;
    h.ports.runtime[field]=({version:'v24.19.0',uid:0,execPath:'/other/node',nodeOptions:'--inspect',nodePathVariable:'/other',arch:'arm64'} as any)[field];
    assert.throws(()=>createInstrumentedGatewayParent(p,h.ports));assert.equal(f.events.length,before);assert.equal(h.children.length,0);
});
for(const kind of ['closeHold','openHold'])test('pending input '+kind+' prevents launch and cannot be re-admitted',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p),hold=deferred();f.controls[kind]=hold;const owner=createInstrumentedGatewayParent(p,h.ports),task=owner.run();
    await until(()=>owner.snapshot().files.handles>0&&owner.snapshot().inputs.length===1);await pulse();assert.equal(h.children.length,0);await assert.rejects(owner.run());hold.resolve();await task;assert.equal(h.children.length,2);
});
for(const kind of ['fileCloseError','directoryCloseError','fileSyncError','directorySyncError','replaceOnClose'])test('failed or replaced exclusive input '+kind+' stops without launch',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p);f.controls[kind]=true;const owner=createInstrumentedGatewayParent(p,h.ports);await assert.rejects(owner.run());
    assert.equal(h.children.length,0);assert.equal(owner.snapshot().failed,true);assert.equal(owner.snapshot().files.uncertainPublications,kind==='replaceOnClose'?0:1);assert.ok(f.records.has(parent+'/child-input-compatibility.json'));
});
for(const kind of ['badReceipt','wrongSpawn','nonzero','replaceAfterReceipt','changeNode','rejectedTimer','overflow'])test('first-child '+kind+' cannot admit ownership',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p);h.controls[kind]=true;const owner=createInstrumentedGatewayParent(p,h.ports);await assert.rejects(owner.run());assert.equal(h.children.length,1);assert.equal(owner.snapshot().failed,true);await assert.rejects(owner.run());assert.equal(h.children.length,1);
});
test('pre-existing input is neither adopted nor overwritten',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p),file=parent+'/child-input-compatibility.json';f.write(file,Buffer.from('existing synthetic data'));
    const owner=createInstrumentedGatewayParent(p,h.ports);await assert.rejects(owner.run());assert.equal(f.bytes(file).toString(),'existing synthetic data');assert.equal(h.children.length,0);
});
test('compatibility child close and both pipe closes precede second launch',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p);h.controls.holdChild=true;h.controls.holdPipes=true;
    const owner=createInstrumentedGatewayParent(p,h.ports),task=owner.run();await until(()=>h.children.length===1);await pulse();h.children[0].close();await pulse();assert.equal(h.children.length,1);
    h.children[0].stdout.emit('close');await pulse();assert.equal(h.children.length,1);h.children[0].stderr.emit('close');await until(()=>h.children.length===2&&h.children[1].started);
    h.children[1].close();h.children[1].stdout.emit('close');h.children[1].stderr.emit('close');await task;
});
test('deadline observes failure without a stop signal, retry or second launch',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p);h.controls.holdChild=true;
    const owner=createInstrumentedGatewayParent(p,h.ports),task=owner.run(),rejected=assert.rejects(task);await until(()=>h.children.length===1);h.expire();await rejected;assert.equal(h.children.length,1);assert.equal(typeof h.children[0].kill,'undefined');
});
test('native composition has no automatic activation, build, signal or environment forwarding',()=>{
    const text=readFileSync(new URL('./fixtures/instrumented-gateway-parent-entry.mjs',import.meta.url),'utf8');
    assert.ok(text.indexOf('export function prepareNativeInstrumentedGatewayParent')<text.indexOf('process.platform'));
    assert.ok(text.includes('launch:(file,args,options) => spawn(file,args,options)'));
    assert.ok(!/process\.argv|process\.exit\(|\.kill\(|\b(?:exec|fork|rm|chmod)\s*\(|process\.env\s*[,}]/.test(text));
    assert.equal((text.match(/\bspawn\(/g)||[]).length,1);
});

test('factory snapshots prepared bytes, metadata and native function selection before caller mutation',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p),owner=createInstrumentedGatewayParent(p,h.ports);
    const original=p.binding.source.sourceCommit;p.scripts.get(p.selection.artifactPath)!.fill(0);p.binding.source.sourceCommit='f'.repeat(40);
    h.ports.runtime.version='v0.0.0';h.ports.launch=()=>{throw Error('replaced caller port must not be selected');};
    const result=await owner.run();assert.equal(result.receipt.source.sourceCommit,original);assert.equal(h.children.length,2);
});

for(const held of [false,true])test('bound failure diagnostics survive command rejection while direct custody held='+held,async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p);h.controls.failedChild=true;h.controls.holdChild=held;
    const owner=createInstrumentedGatewayParent(p,h.ports),task=owner.run(),rejected=assert.rejects(task);await until(()=>h.children.length===1&&h.children[0].started);
    if(held)h.expire();await rejected;
    const state=owner.snapshot();assert.equal(state.failedAt,'compatibility');assert.equal(state.completed,false);assert.equal(state.childFailure.envelope,'observed-bound');
    assert.equal(state.childFailure.detail.inspectorFailure,'script-unadmitted');assert.equal(state.childFailure.directRetired,!held);assert.equal(h.children.length,1);
    const summary=instrumentedFailureSummary('driver',null,{parent:state});assert.equal(summary.schema,'instrumented-gateway-failure-counters-v4');assert.equal(summary.parentPhase,'compatibility');assert.equal(summary.childFailure.directRetired,!held);assert.equal(summary.releaseAcceptance,false);
    if(held)h.children[0].close(1);await assert.rejects(owner.run());assert.equal(h.children.length,1);
});
test('an unbound failure payload stays diagnostic-missing and never starts ownership',async()=>{
    const f=installation(),p=await prepared(f),h=host(f,p);h.controls.failedChild=true;h.controls.badFailureBinding=true;
    const owner=createInstrumentedGatewayParent(p,h.ports);await assert.rejects(owner.run());assert.equal(owner.snapshot().childFailure.detail,null);assert.equal(owner.snapshot().childFailure.envelope,'absent-or-invalid');assert.equal(h.children.length,1);
});
