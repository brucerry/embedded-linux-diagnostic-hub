import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {startPreimportCompatibility} from '../../scripts/lib/instrumented-gateway-preimport-coordinator.mjs';
import {startInstrumentedChildOutput} from '../../scripts/lib/instrumented-gateway-output.mjs';
import {deriveSshReadinessPlan,cachedSshInitialization,assertPreimportCacheEmpty} from '../../scripts/lib/instrumented-gateway-ssh-readiness.mjs';
import {EventEmitter} from 'node:events';
import {readFileSync,constants} from 'node:fs';
import {earlyMemory} from './gateway-early-memory';
import {memoryFilesystem,sourceFixture,observedLifecycle} from './gateway-producer-memory';
import {projectGatewayLock} from '../../scripts/lib/gateway-lock-plan.mjs';
import {sourceDigest} from '../../scripts/lib/committed-source-bridge.mjs';
import {preimportTargetGraph,PREIMPORT_TARGET_ENTRY,PREIMPORT_ACTIVATION} from '../../scripts/lib/instrumented-gateway-preimport-build.mjs';
import {projectInstrumentedChildFailure} from '../../scripts/lib/instrumented-gateway-failure.mjs';
import {preimportReceiptIdentity,PREIMPORT_RECEIPT_MARKER} from '../../scripts/lib/instrumented-gateway-preimport-receipt.mjs';

export async function preimportPairMemory(){
 const e=earlyMemory(),files=new Map(e.files),f=memoryFilesystem(),controls:any={},calls:any[]=[],children:any[]=[],timers:any[]=[],directories=new Set<any>();
 for(const p of [PREIMPORT_TARGET_ENTRY,PREIMPORT_ACTIVATION,'tests/fixtures/instrumented-gateway-resolution-guard.cjs'])files.set(p,readFileSync(new URL('../../'+p,import.meta.url)));
 const sourceFacts={sessions:0,imports:0,factories:0,readyJoins:0};
 const source=sourceFixture(files),root='/project',stage=root+'/validation/gateway-ownership',installed=stage+'/instrumented',node=Buffer.from('synthetic Node; never executed');
 const projection=projectGatewayLock(JSON.parse(files.get('package.json')!.toString()),JSON.parse(files.get('package-lock.json')!.toString()));
 f.write(installed+'/package.json',Buffer.from(JSON.stringify(projection.manifest)+'\n'));f.write(installed+'/package-lock.json',Buffer.from(JSON.stringify(projection.lock)+'\n'));
 f.write(installed+'/activate.cjs',files.get(PREIMPORT_ACTIVATION)!);f.write(installed+'/resolution-guard.cjs',files.get('tests/fixtures/instrumented-gateway-resolution-guard.cjs')!);f.write('/tools/node',node);
 for(const [p,v]of Object.entries(projection.lock.packages) as [string,any][])if(p&&!v.optional)f.write(installed+'/'+p+'/package.json',Buffer.from(JSON.stringify({name:p.slice('node_modules/'.length),version:v.version})));
 for(const p of ['ssh2/lib/protocol/crypto.js','ssh2/lib/protocol/crypto/poly1305.js','ssh2/lib/protocol/node-fs-compat.js'])f.write(installed+'/node_modules/'+p,readFileSync(new URL('../../node_modules/'+p,import.meta.url)));
 const graph=await preimportTargetGraph(async (p:string)=>Buffer.from(files.get(p)!),(p:string)=>files.has(p));
 // Authored CommonJS stand-in, never evaluated. Real compiler/runtime remains unproved.
 const external=[...new Set([...graph.edges.values()].flat().filter(v=>v.external).map(v=>v.path))].sort();
 const target=Buffer.from("const ssh2=require('ssh2');function createGateway(){throw Error('must not call');}module.exports={createGateway};\n"+external.filter(p=>p!=='ssh2').map(p=>"require('"+p+"');\n").join(''));
 const targetMeta:any={inputs:Object.fromEntries([...graph.files].map(([p,b])=>[p,{bytes:b.length,imports:graph.metadataEdges.get(p)}])),outputs:{'validation/gateway-ownership/instrumented/ownership.cjs':{bytes:target.length,entryPoint:PREIMPORT_TARGET_ENTRY,exports:['createGateway'],inputs:Object.fromEntries([...graph.files.keys()].map(p=>[p,{bytesInOutput:1}])),imports:external.map(p=>({path:p,kind:'require-call',external:true}))}}};
 const stat=async(p:string)=>({...await f.fs.lstat(p),uid:1000});
 const native:any={...f.fs,lstat:stat,async opendir(p:string){const rows=await f.fs.readdir(p);let index=0;const h={async read(){return rows[index++]??null;},async close(){directories.delete(h);}};directories.add(h);return h;},
  async open(p:string,flags:number){if(flags&constants.O_DIRECTORY){const h={stat:()=>stat(p),async sync(){},async close(){directories.delete(h);}};directories.add(h);return h;}
   const writing=Boolean(flags&constants.O_EXCL),h=await f.fs.open(p,writing?'wx':'r');return{read:(...args:[Buffer,number,number])=>h.read(...args),async stat(){return{...await h.stat(),uid:1000};},async sync(){},close:()=>h.close(),async write(b:Buffer,offset:number,length:number,at:number){const n=Math.min(length,4096),old=f.bytes(p),next=Buffer.alloc(Math.max(old.length,at+n));old.copy(next);b.copy(next,at,offset,offset+n);f.write(p,next);return{bytesWritten:n};}};
  }};
 const buildPorts:any={...e.ports,filesystem:native,queryAbsence:(p:string)=>native.lstat(p),sourceProvider:source.provider,async observeToolchain(){return{...await e.ports.observeToolchain(),nodePath:'/tools/node',nodeSHA256:sourceDigest(node)};},
  async execute(plan:any){calls.push(plan);const targetBuild=plan.command.includes('--format=cjs');
   if(controls.beforeBuild)controls.beforeBuild(targetBuild?'target':'early');
   const life=await observedLifecycle(controls.failBuild===(targetBuild?'target':'early')?'nonzero':'normal');
   if(targetBuild){f.write(installed+'/ownership.cjs',target);f.write(stage+'/target-meta.json',Buffer.from(JSON.stringify(targetMeta)));return{...plan,lifecycle:life};}
   const ack=await e.ports.execute(plan);ack.lifecycle=life;f.write(installed+'/preimport.mjs',await e.ports.read(installed+'/preimport.mjs',32*1024**2));f.write(stage+'/preimport-meta.json',await e.ports.read(stage+'/preimport-meta.json',4*1024**2));return ack;
  },
  async read(p:string,max:number){assert.ok(max===32*1024**2||max===4*1024**2);const bytes=f.bytes(p);assert.ok(bytes.length<=max);return Buffer.from(bytes);},assertFilesSettled(){assert.equal(f.handles.size,0);assert.equal(directories.size,0);},
 };
 function envelope(input:any,bytes:Buffer){
  const receipt={schema:'instrumented-node-inspector-preimport-compatibility-v1',status:'exact-prelaunch-bytes-match-replayed-sources',instrumented:true,source:input.child.binding.source,bindingSHA256:sourceDigest(JSON.stringify(input.child.binding)+'\n'),artifactSHA256:input.child.selection.artifactSHA256,compiledScripts:2,generatedScripts:input.child.binding.generatedInventory.map((r:any)=>({identity:r.identity,sourceSHA256:r.sourceSHA256,sourceBytes:r.sourceBytes,creatorSourceVerified:true,creationStackVerified:true})),builtinScripts:0,builtinIdentityVerified:false,observerRetired:true,elapsedMs:1,productWorkload:null,shippedCLIBehavior:null,wholeGroupRetirement:null,releaseAcceptance:false};
  const identity=preimportReceiptIdentity(bytes,installed).identity;if(controls.badIdentity)identity.nonce='0'.repeat(32);
  if(controls.failureEnvelope)return Buffer.from(PREIMPORT_RECEIPT_MARKER+JSON.stringify({schema:'owned-preimport-compatibility-envelope-v1',status:'failed-or-held',identity,receipt:null,failure:{stage:'import',stopped:false,unknown:false,localRetired:true,observer:projectInstrumentedChildFailure('workload',false,true,{collector:{failureCode:'script-unadmitted'}}),pendingCallbacks:0,pendingSources:0,targetUncertain:false},wholeGroupRetirement:null,releaseAcceptance:false})+'\n');
  return Buffer.from(PREIMPORT_RECEIPT_MARKER+JSON.stringify({schema:'owned-preimport-compatibility-envelope-v1',status:'completed-local-compatibility',identity,receipt,failure:null,wholeGroupRetirement:null,releaseAcceptance:false})+'\n');
 }
 async function activateSourceChild(child:any,args:string[]){
  let failure=false,plan:any;const cache:any={},originalReady=Promise.resolve(),earlyPath=installed+'/preimport.mjs',targetPath=installed+'/ownership.cjs';
  class Session extends EventEmitter{
   connect(){}disconnect(){}
   post(method:string,p:any,cb:Function){
    if(method==='Debugger.enable'){this.emit('Debugger.scriptParsed',{params:{scriptId:'early',url:pathToFileURL(earlyPath).href,length:f.bytes(earlyPath).toString().length,startLine:0,startColumn:0,executionContextId:1}});cb(null,{});}
    else if(method==='Debugger.getScriptSource'){
     if(p.scriptId==='wasm'){const poly=f.bytes(installed+'/node_modules/ssh2/lib/protocol/crypto/poly1305.js').toString(),m=poly.match(/W="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/)!;cb(null,{scriptSource:'',bytecode:m[1]});}
     else cb(null,{scriptSource:f.bytes(p.scriptId==='early'?earlyPath:targetPath).toString()});
    }else{assert.equal(method,'Debugger.disable');cb(null,{});}
   }
  }
  const session=new Session();child.emit('spawn');
  child.stdout.write=(bytes:Buffer,cb:Function)=>{child.stdout.emit('data',Buffer.from(bytes));cb();return true;};
  const owner=startPreimportCompatibility(args[1],{root:installed,uid:1000,filesystem:native,
   async readInput(p:string){assert.equal(p,args[1]);return Buffer.from(f.bytes(p));},async observeNode(){return{path:'/tools/node',sha256:sourceDigest(node),version:'v24.22.0',execArgv:[],nodeOptions:null};},async observeSelf(){return{path:earlyPath,sha256:sourceDigest(f.bytes(earlyPath))};},assertGuardActive(){},assertFilesSettled(){assert.equal(f.handles.size,0);assert.equal(directories.size,0);},
   prepareTarget(scripts:Map<string,Buffer>){plan=deriveSshReadinessPlan(scripts,installed);},assertTargetUnloaded(){assertPreimportCacheEmpty(cache,installed);},sessionFactory(){sourceFacts.sessions++;return session;},
   importTarget(p:string){assert.equal(p,targetPath);sourceFacts.imports++;const exported={createGateway(){sourceFacts.factories++;throw Error('Factory forbidden');}};cache[plan.path]={filename:plan.path,loaded:true,exports:{init:originalReady}};session.emit('Debugger.scriptParsed',{params:{scriptId:'target',url:pathToFileURL(targetPath).href,length:f.bytes(targetPath).toString().length,startLine:0,startColumn:0,executionContextId:1}});if(controls.sourceWasm)session.emit('Debugger.scriptParsed',{params:{scriptId:'wasm',url:'wasm://wasm/authored',scriptLanguage:'WebAssembly',executionContextId:0}});return exported;},
   waitTargetReady(){sourceFacts.readyJoins++;const p=cachedSshInitialization(cache,plan);assert.equal(p,originalReady);return p;},
   now:()=>0,setTimer(){return{};},clearTimer(){},startHold(){return{};},clearHold(){},prepareContainmentClose(){},assertContainmentClosed(){},setFailure(){failure=true;},writeOutput(bytes:Buffer){return startInstrumentedChildOutput(bytes,child.stdout,()=>{failure=true;});},
  });
  owner.result.catch(()=>{failure=true;});await owner.closed;child.stdout.emit('close');child.stderr.emit('close');child.emit('exit',failure?1:0,null);child.emit('close',failure?1:0,null);
 }
 const host:any={filesystem:native,runtime:{platform:'linux',arch:'x64',version:'v24.22.0',execPath:'/tools/node',execArgv:[],uid:1000,nodeOptions:null,nodePathVariable:null},now:()=>0,setTimer(fn:Function,ms:number){assert.equal(ms,60000);const t={fn};timers.push(t);return t;},clearTimer(t:any){assert.ok(t);},
  launch(file:string,args:string[],options:any){const child=new EventEmitter() as any;child.pid=123;child.spawnfile=file;child.spawnargs=controls.wrongSpawn?[file,'wrong']:[file,...args];child.exitCode=null;child.signalCode=null;child.stdin=null;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.finish=()=>{
    child.emit('spawn');const bytes=f.bytes(args[1]),input=JSON.parse(bytes.toString());child.stdout.emit('data',envelope(input,bytes));
    if(!controls.holdPipes){child.stdout.emit('close');child.stderr.emit('close');}
    child.emit('exit',controls.nonzero||controls.failureEnvelope?1:0,null);child.emit('close',controls.nonzero||controls.failureEnvelope?1:0,null);
    if(controls.postMutation)f.write(installed+'/package.json',Buffer.from('changed'));
   };children.push(child);if(controls.sourceChild)Promise.resolve().then(()=>activateSourceChild(child,args)).catch(error=>{child.emit('error',error);});else if(!controls.holdChild)Promise.resolve().then(()=>child.finish());return child;},
 };
 return{...f,e,sourceFacts,source,files,graph,targetMeta,buildPorts,host,controls,calls,children,directories,installed,stage,selection:{root,sourceCommit:source.context.sourceCommit,sourceTree:source.context.sourceTree,uid:1000},expire(){timers.at(-1)!.fn();}};
}
