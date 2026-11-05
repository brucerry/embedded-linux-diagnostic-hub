import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { prepareInstrumentedGatewayCheck, startInstrumentedGatewayCheck, RAW_CLI_REFERENCE, INSTRUMENTED_ENTRY, INSTRUMENTED_ACTIVATION } from '../scripts/lib/instrumented-gateway-check.mjs';
import { createInstrumentedGatewayBootstrap } from '../scripts/lib/instrumented-gateway-observer.mjs';
import { sourceFixture, observedLifecycle } from './fixtures/gateway-producer-memory';
import { projectGatewayLock } from '../scripts/lib/gateway-lock-plan.mjs';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';

const reference = JSON.parse(readFileSync(new URL('./fixtures/gateway-ownership-production.json', import.meta.url),'utf8'));
const sourceFiles = new Map<string,Buffer>(reference.inventory.map((r:any) => [r.path,readFileSync(new URL('../'+r.path,import.meta.url))]));
for (const p of [INSTRUMENTED_ENTRY,INSTRUMENTED_ACTIVATION,'tests/fixtures/instrumented-gateway-entry.ts','scripts/lib/instrumented-gateway-observer.mjs','scripts/lib/instrumented-gateway-check.mjs'])
    sourceFiles.set(p,readFileSync(new URL('../'+p,import.meta.url)));
const pulse=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const deferred=()=>{let resolve!:(v?:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return{promise,resolve};};
function producer() {
    const f=sourceFixture(new Map(sourceFiles)),controls:any={},calls:any[]=[];
    const artifact=Buffer.from('// authored fake compiled instrumented entry; never executed\n');
    const artifactPath='/project/validation/gateway-ownership/instrumented/ownership.cjs';
    let tools=0;
    const ports={sourceProvider:f.provider,
        async observeToolchain(){tools++;const bytes=controls.nativeEsbuild?Buffer.from([0x7f,0x45,0x4c,0x46]):Buffer.from('#!/usr/bin/env node\n// authored fake compiler, never run\n');
            return{nodePath:'/tools/bin/node',nodeSHA256:'a'.repeat(64),esbuildPath:'/project/node_modules/esbuild/bin/esbuild',esbuildSHA256:(controls.toolChange&&tools>1)||controls.toolHashWrong?'e'.repeat(64):sourceDigest(bytes),esbuildEntryBytes:bytes,esbuildEntryFormat:controls.badFormat?'native':'node-script'};},
        async execute(plan:any){calls.push(plan);if(controls.throwBuild)throw Error('authored uncertain build');
            if(controls.sourceChange){const original=f.provider.file;f.provider.file=async(p:string)=>p==='gateway/server.ts'?{mode:'100644',bytes:Buffer.from('changed')}:original(p);}
            const lifecycle=await observedLifecycle();if(controls.noClose)lifecycle.closeObserved=false;
            if(controls.stringFlags)(lifecycle as any).spawnObserved=(lifecycle as any).exitObserved=(lifecycle as any).closeObserved='false';
            if(controls.numberFlags)(lifecycle as any).spawnObserved=1;
            return{...plan,command:[...plan.command],owner:controls.foreign?'f'.repeat(32):plan.owner,lifecycle};},
        async readArtifact(file:string,maximum:number){assert.equal(file,artifactPath);assert.equal(maximum,32*1024**2);return controls.stringArtifact?artifact.toString():Buffer.from(artifact);},
        async scriptSnapshot(){const projected=projectGatewayLock(JSON.parse(sourceFiles.get('package.json')!.toString()),JSON.parse(sourceFiles.get('package-lock.json')!.toString()));
            const directory=artifactPath.slice(0,artifactPath.lastIndexOf('/'));return new Map([[artifactPath,controls.scriptChange?Buffer.from('different'):Buffer.from(artifact)],
            [directory+'/activate.cjs',sourceFiles.get(INSTRUMENTED_ACTIVATION)!],[directory+'/package.json',Buffer.from(JSON.stringify(projected.manifest))],[directory+'/package-lock.json',Buffer.from(JSON.stringify(projected.lock))]]);},
    };
    const input={root:'/project',sourceCommit:f.context.sourceCommit,sourceTree:f.context.sourceTree};
    return{f,ports,input,controls,calls,artifactPath,artifact};
}
function runtime() {
    const controls:any={},events:string[]=[],sourceCallbacks:Function[]=[];let disable:Function=()=>{},timer:Function=()=>{},now=0,products=0,closes=0;
    const heldClose=deferred(),heldServerHttp=deferred(),http:any[]=[];
    const product:any={stopping:false,serverListening:false,cleanupTimers:1,requestTasks:0,httpSockets:0,httpResponses:0,httpBodyReaders:0,
        pendingConnections:0,sessions:0,inFlight:0,ownedSessions:0,retiringSessions:0,connectionAttempts:0,cancelledAttemptCache:0,sessionOwners:[],allSessionOwners:[]};
    const server:any=new EventEmitter();server.listen=(port:number,host:string)=>{assert.equal(port,0);assert.equal(host,'127.0.0.1');product.serverListening=true;server.emit('listening');return server;};
    server.address=()=>({address:'127.0.0.1',port:12345});
    const factory=()=>{products++;return{server,get ownershipSnapshot(){return product;},async close(){closes++;events.push('product.close');if(controls.holdClose)await heldClose.promise;if(controls.rejectClose)throw Error('authored close rejection');
        if(controls.delayedServerCounter){await heldServerHttp.promise;product.httpSockets=0;}
        for(const h of http)if(!h.closed){h.response.emit('aborted');h.response.emit('close');h.request.emit('close');h.socket.emit('close');h.closed=true;}
        product.stopping=true;product.serverListening=false;product.cleanupTimers=0;if(controls.nonzero)product.httpSockets=1;}};};
    let bootstrap:any;
    const ports:any={
        prepare(selection:any,scripts:Map<string,Buffer>){
            const bytes=scripts.get(selection.artifactPath)!;
            class Session extends EventEmitter {
                connect(){events.push('connect');}
                disconnect(){events.push('disconnect');}
                post(method:string,params:any,cb:Function){events.push(method);
                    if(method==='Debugger.enable'){this.emit('Debugger.scriptParsed',{params:{scriptId:'1',url:pathToFileURL(selection.artifactPath).href,length:bytes.toString().length}});cb(null,{});}
                    else if(method==='Debugger.getScriptSource'){sourceCallbacks.push(cb);if(!controls.holdSource)cb(null,{scriptSource:controls.wrongSource?'wrong':bytes.toString()});}
                    else {assert.equal(method,'Debugger.disable');disable=()=>cb(null,{});if(!controls.holdDisable)disable();}}
            }
            bootstrap=createInstrumentedGatewayBootstrap(selection,scripts,()=>new Session(),factory);
            if(controls.throwClose)bootstrap={...bootstrap,close(){closes++;throw Error('uncertain close dispatch');}};
            if(controls.tamperRecord){const original=bootstrap.close;bootstrap={...bootstrap,close(){return original().then((r:any)=>({...r,bytes:Buffer.from('tampered')}));}};}
            return bootstrap;
        },
        setTimer(cb:Function,ms:number){assert.ok([45000,2000].includes(ms));if(ms===45000)timer=cb;return {ms};},clearTimer(){},now:()=>now,
        request(options:any,cb:Function){const request:any=new EventEmitter(),response:any=new EventEmitter(),socket:any=new EventEmitter(),h={request,response,socket,closed:false};http.push(h);
            Object.assign(response,{statusCode:200,complete:true,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','access-control-allow-origin':'http://127.0.0.1'}});
            Object.assign(socket,{connecting:true,remoteAddress:'127.0.0.1',localAddress:'127.0.0.1',remotePort:12345});
            request.end=()=>{Promise.resolve().then(()=>{request.emit('socket',socket);socket.emit('connect');request.emit('finish');cb(response);if(controls.holdHttp)return;
                response.emit('data',Buffer.from('{"version":"0.6.0","activeSessions":0,"connectionCancellation":true}'));response.emit('end');response.emit('close');request.emit('close');if(controls.delayedServerCounter)product.httpSockets=1;socket.emit('close');h.closed=true;});return request;};
            assert.equal(options.hostname,'127.0.0.1');assert.equal(options.path,'/api/health');return request;},
    };
    return{ports,controls,events,product,heldClose,heldServerHttp,releaseDisable:()=>disable(),releaseSource:(bytes:string)=>sourceCallbacks[0](null,{scriptSource:bytes}),expire:()=>{now=45001;timer();},
        get bootstrap(){return bootstrap;},get products(){return products;},get closes(){return closes;}};
}
test('source/byte binding matches the frozen 213-file raw source while keeping a distinct instrumented artifact',async()=>{
    const f=producer(),p=await prepareInstrumentedGatewayCheck(f.input,f.ports);
    assert.equal(p.binding.rawCLIReference.sourceCommit,RAW_CLI_REFERENCE.sourceCommit);assert.equal(reference.inventorySHA256,RAW_CLI_REFERENCE.productionInventorySHA256);
    assert.equal(p.binding.buildProvenanceVerified,false);assert.equal(p.binding.releaseAcceptance,false);assert.equal(p.binding.wholeGroupRetirement,null);
    assert.equal(p.binding.artifactSHA256,p.selection.artifactSHA256);assert.equal(f.calls.length,1);assert.ok(f.calls[0].command.includes('/project/'+INSTRUMENTED_ENTRY));
});
for(const kind of ['foreign','noClose','throwBuild','sourceChange','toolChange','scriptChange','stringArtifact','stringFlags','numberFlags'])test('instrumented preparation fails closed for '+kind,async()=>{
    const f=producer();f.controls[kind]=true;await assert.rejects(prepareInstrumentedGatewayCheck(f.input,f.ports));assert.equal(f.calls.length,1);
});
test('production changes are refused before any instrumented build dispatch',async()=>{
    const files=new Map(sourceFiles);files.set('gateway/server.ts',Buffer.from('changed production source'));
    const source=sourceFixture(files),f=producer();f.ports.sourceProvider=source.provider;
    await assert.rejects(prepareInstrumentedGatewayCheck({...f.input,sourceCommit:source.context.sourceCommit,sourceTree:source.context.sourceTree},f.ports));assert.equal(f.calls.length,0);
});
test('actual bootstrap, inspector callback and health owners reach zero only after acknowledged close',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime(),o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);
    prepared.scripts.get(prepared.selection.artifactPath)!.fill(0);const completed=await o.result;await o.closed;
    assert.equal(completed.receipt.before.cleanupTimers,1);assert.equal(completed.receipt.before.serverListening,true);
    assert.equal(completed.receipt.health.status,200);assert.equal(completed.receipt.afterClose.cleanupTimers,0);
    assert.equal(completed.receipt.localObserverRetired,true);assert.equal(completed.receipt.shippedCLIBehavior,null);assert.equal(completed.receipt.releaseAcceptance,false);
    assert.equal(r.products,1);assert.equal(r.closes,1);assert.equal(o.snapshot().retired,true);assert.ok(completed.bytes.length<=16384);
    assert.ok(r.events.indexOf('product.close')<r.events.indexOf('Debugger.disable')&&r.events.includes('disconnect'));
});
test('held inspector disable cannot emit success or acknowledge local retirement early',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();r.controls.holdDisable=true;
    const o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);await pulse();assert.equal(o.snapshot().retired,false);assert.equal(r.events.includes('disconnect'),false);
    r.releaseDisable();await o.result;await o.closed;assert.equal(o.snapshot().retired,true);
});
test('rejected product close retains actual ownership without invented zero counters',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();r.controls.rejectClose=true;
    const o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);await assert.rejects(o.result);assert.equal(o.snapshot().retired,false);
    assert.equal(r.bootstrap.snapshot().productHeld,true);assert.equal(r.events.includes('disconnect'),false);
});
test('nonzero product ownership cannot be converted into an all-zero passing receipt',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();r.controls.nonzero=true;
    const o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);await assert.rejects(o.result);assert.equal(o.snapshot().retired,false);assert.equal(r.product.httpSockets,1);
});
test('deadline during pending source callback waits for actual retirement and never creates product',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();r.controls.holdSource=true;
    const o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);await pulse();r.expire();await assert.rejects(o.result);
    assert.equal(o.snapshot().retired,false);assert.equal(r.events.includes('disconnect'),false);assert.equal(r.products,0);
    r.releaseSource(prepared.scripts.get(prepared.selection.artifactPath)!.toString());await o.closed;assert.equal(o.snapshot().failed,true);assert.equal(r.products,0);
});
test('acknowledged failed source observation can retire locally while staying failed',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();r.controls.wrongSource=true;
    const o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);await assert.rejects(o.result);await o.closed;
    assert.equal(o.snapshot().retired,true);assert.equal(o.snapshot().failed,true);assert.equal(r.products,0);
});
test('uncertain close dispatch is never retried by a deadline callback',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();r.controls.throwClose=true;
    const o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);await assert.rejects(o.result);r.expire();await pulse();assert.equal(r.closes,1);assert.equal(o.snapshot().retired,false);
});
test('changed prepared script bytes are rejected before session or product acquisition',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();prepared.scripts.get(prepared.selection.artifactPath)!.fill(0);
    assert.throws(()=>startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports));assert.equal(r.products,0);assert.deepEqual(r.events,[]);
});
test('native entry stays inert and adds no CLI, inspector TCP endpoint, process launcher or forced cleanup',()=>{
    const text=readFileSync(new URL('./fixtures/instrumented-gateway-check-entry.ts',import.meta.url),'utf8');
    assert.ok(text.includes('export function runPreparedInstrumentedGatewayCheck'));
    assert.ok(!/inspector\.open|process\.(?:exit|kill)\s*\(|\b(?:spawn|fork|exec|chmod|rm)\s*\(/.test(text));
    assert.ok(text.indexOf('export function activateInstrumentedGatewayChildFromFile')<text.indexOf('process.platform'));
    assert.ok(!text.includes('activateInstrumentedGatewayChildFromFile(process.argv'));
    assert.ok(text.includes('prepare: prepareInstrumentedGateway')&&text.includes('request(options, callback)'));
});
test('artifact byte bound is checked before copying, with guard-deletion negative',()=>{
    const source=readFileSync(new URL('../scripts/lib/instrumented-gateway-check.mjs',import.meta.url),'utf8');
    const guard='assert.ok(observedArtifact.length > 0 && observedArtifact.length <= 32 * 1024 ** 2);',copy='const artifact = Buffer.from(observedArtifact);';
    const check=(s:string)=>{const a=s.indexOf(guard),b=s.indexOf(copy);assert.ok(a>=0&&b>a);};
    check(source);assert.throws(()=>check(source.replace(guard,'')));
});
test('rejected asynchronous timer cleanup is observed and retained without a pass or retry',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();let clears=0;
    r.ports.clearTimer=(handle:any)=>{if(handle.ms!==45000)return;clears++;return Promise.reject(Error('authored rejected cleanup'));};
    const o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);await assert.rejects(o.result);await pulse();
    assert.equal(o.snapshot().retired,false);assert.equal(o.snapshot().unknownOperation,true);assert.equal(o.snapshot().timerHeld,true);assert.equal(clears,1);
});
for(const kind of ['nativeEsbuild','badFormat','toolHashWrong'])test('unsupported compiler observation '+kind+' fails before build dispatch',async()=>{
    const f=producer();f.controls[kind]=true;await assert.rejects(prepareInstrumentedGatewayCheck(f.input,f.ports));assert.equal(f.calls.length,0);
});
test('changed observer receipt bytes fail verification while acknowledged local retirement stays truthful',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();r.controls.tamperRecord=true;
    const o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);await assert.rejects(o.result);await o.closed;
    assert.equal(o.snapshot().retired,true);assert.equal(o.snapshot().failed,true);
});
test('client closure cannot prematurely declare server-side custody retired; actual product close joins it',async()=>{
    const f=producer(),prepared=await prepareInstrumentedGatewayCheck(f.input,f.ports),r=runtime();r.controls.delayedServerCounter=true;
    const o=startInstrumentedGatewayCheck(prepared,'a'.repeat(64),r.ports);await pulse();
    assert.equal(r.closes,1);assert.equal(r.product.httpSockets,1);assert.equal(o.snapshot().retired,false);
    r.heldServerHttp.resolve();const completed=await o.result;await o.closed;
    assert.equal(completed.receipt.afterHealth.httpSockets,1);assert.equal(completed.receipt.afterClose.httpSockets,0);
});
test('existing path bound rejects oversized derived command paths before dispatch without truncation',async()=>{
    const f=producer(),root='/'+ 'a'.repeat(4049);
    const original=f.ports.observeToolchain;f.ports.observeToolchain=async()=>({...await original(),esbuildPath:root+'/node_modules/esbuild/bin/esbuild'});
    await assert.rejects(prepareInstrumentedGatewayCheck({...f.input,root},f.ports));assert.equal(f.calls.length,0);
});
test('script snapshot paths obey the existing inspector/filesystem bound',async()=>{
    const f=producer();f.ports.scriptSnapshot=async()=>new Map([[f.artifactPath,Buffer.from(f.artifact)],[f.artifactPath+'a'.repeat(4097),Buffer.from('small')]]);
    await assert.rejects(prepareInstrumentedGatewayCheck(f.input,f.ports));assert.equal(f.calls.length,1);
});
