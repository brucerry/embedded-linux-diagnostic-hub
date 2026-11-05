import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {memoryFilesystem} from './gateway-producer-memory';
import {sourceDigest} from '../../scripts/lib/committed-source-bridge.mjs';
import {censusInstrumentedGateway} from '../../scripts/lib/instrumented-gateway-census.mjs';
import {RAW_CLI_REFERENCE} from '../../scripts/lib/instrumented-gateway-check.mjs';
import {deriveInstrumentedGeneratedInventory} from '../../scripts/lib/instrumented-gateway-generated.mjs';
import {admitPreimportObserver} from '../../scripts/lib/instrumented-gateway-preimport.mjs';

const root='/project/validation/gateway-ownership/instrumented',entry=root+'/ownership.cjs',early=root+'/preimport.mjs';
const pulse=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
const until=async(predicate:()=>boolean)=>{for(let i=0;i<20000&&!predicate();i++)await Promise.resolve();assert.ok(predicate(),'Expected deterministic fake callback was not admitted');};
const deferred=()=>{let resolve!:(v?:any)=>void,reject!:(v:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return {promise,resolve,reject};};
export async function preimportMemory(mode='compatibility'){
 const f=memoryFilesystem(),controls:any={},events:string[]=[],source=deferred(),ready=deferred(),enable=deferred(),reads=deferred();let factories=0,imports=0,products=0,preparedCalls=0;
 for(const [name,text]of [['ownership.cjs','// synthetic target; not compiled\n'],['preimport.mjs','// synthetic early artifact; not compiled\n'],['activate.cjs','// inactive legacy entry\n'],['resolution-guard.cjs','// synthetic guard\n']])f.write(root+'/'+name,Buffer.from(text));
 f.write(root+'/package.json',Buffer.from('{"name":"synthetic","version":"1.0.0"}'));
 f.write(root+'/package-lock.json',Buffer.from(JSON.stringify({lockfileVersion:3,packages:{'':{name:'synthetic',version:'1.0.0'},'node_modules/dep':{version:'1.0.0'}}})));
 f.write(root+'/node_modules/dep/package.json',Buffer.from('{"name":"dep","version":"1.0.0"}'));f.write(root+'/node_modules/dep/index.js',Buffer.from('module.exports={};\n'));
 const nativeStat=f.fs.lstat,nativeOpen=f.fs.open,filesystem:any={...f.fs,async lstat(file:string){return {...await nativeStat(file),uid:1000};},async open(file:string,flags:any){const h=await nativeOpen(file,flags);return{...h,async stat(){return{...await h.stat(),uid:1000};}};}};
 const c=await censusInstrumentedGateway(root,1000,filesystem,'preimport-v1');const generated=deriveInstrumentedGeneratedInventory(c.scripts,root);
 const node={path:'/tools/node',sha256:'d'.repeat(64),version:'v24.22.0',execArgv:[],nodeOptions:null};
 const selected={sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),artifactPath:entry,artifactSHA256:sourceDigest(c.scripts.get(entry)),observerSHA256:'c'.repeat(64)};
 const binding={kind:'separate-instrumented-gateway-build-byte-binding-v4',source:{sourceCommit:selected.sourceCommit,sourceTree:selected.sourceTree},artifactPath:entry,artifactSHA256:selected.artifactSHA256,observerSHA256:selected.observerSHA256,rawCLIReference:RAW_CLI_REFERENCE,releaseAcceptance:false,buildProvenanceVerified:false,
  toolchain:{nodePath:node.path,nodeSHA256:node.sha256},activationSHA256:sourceDigest(c.scripts.get(root+'/activate.cjs')),guardSHA256:sourceDigest(c.scripts.get(root+'/resolution-guard.cjs')),installationPackageSHA256:c.packageSHA256,installationLockSHA256:c.lockSHA256,
  fileInventory:c.inventory,fileInventorySHA256:c.inventorySHA256,scriptInventory:c.scriptInventory,scriptInventorySHA256:c.scriptInventorySHA256,generatedInventory:generated,generatedInventorySHA256:sourceDigest(JSON.stringify(generated))};
 const outer={schema:'owned-instrumented-preimport-input-v1',earlyArtifactSHA256:sourceDigest(c.scripts.get(early)),child:{schema:'owned-instrumented-gateway-child-input-v1',root,uid:1000,mode,nonce:'e'.repeat(32),token:'f'.repeat(64),node,binding,selection:selected}};
 let inputBytes=Buffer.from(JSON.stringify(outer)+'\n');const inputPath='/project/validation/gateway-ownership/preimport-input-'+mode+'.json';
 class Session extends EventEmitter{
  connect(){events.push('connect');}disconnect(){events.push('disconnect');if(controls.disconnectUnknown)return Promise.reject(Error('authored unknown disconnect'));}
  post(method:string,p:any,cb:Function){events.push(method+(p.scriptId?':'+p.scriptId:''));
   if(method==='Debugger.enable'){if(controls.replayedTarget)this.emit('Debugger.scriptParsed',{params:{scriptId:'target',url:pathToFileURL(entry).href,length:c.scripts.get(entry)!.toString().length,startLine:0,startColumn:0,executionContextId:1}});this.emit('Debugger.scriptParsed',{params:{scriptId:'early',url:pathToFileURL(early).href,length:c.scripts.get(early)!.toString().length,startLine:0,startColumn:0,executionContextId:1}});if(controls.holdEnable)enable.promise.then(()=>cb(null,{}));else cb(null,{});}
   else if(method==='Debugger.getScriptSource'){const send=()=>cb(null,{scriptSource:controls.wrongTarget&&p.scriptId==='target'?'wrong':c.scripts.get(p.scriptId==='early'?early:entry)!.toString()});if(controls.holdSource&&p.scriptId==='target')source.promise.then(send);else send();}
   else {assert.equal(method,'Debugger.disable');if(controls.holdDisable)reads.promise.then(()=>cb(null,{}));else cb(null,{});}
  }
 }
 const session=new Session();
 const state:any={stopping:false,serverListening:false,cleanupTimers:1,requestTasks:0,httpSockets:0,httpResponses:0,httpBodyReaders:0,pendingConnections:0,sessions:0,inFlight:0,ownedSessions:0,retiringSessions:0,connectionAttempts:0,cancelledAttemptCache:0,sessionOwners:[],allSessionOwners:[]};
 const ports:any={root,uid:1000,filesystem,
  async readInput(file:string){assert.equal(file,inputPath);if(controls.readHeld)await reads.promise;return Buffer.from(inputBytes);},async observeNode(){return{...node,sha256:controls.changedNode?'0'.repeat(64):node.sha256};},async observeSelf(){return{path:controls.wrongSelf?root+'/other.mjs':early,sha256:sourceDigest(c.scripts.get(early))};},
  assertGuardActive(){if(controls.guardFailed)throw Error('authored guard failure');},assertFilesSettled(){assert.equal(f.handles.size,0);if(controls.fileUncertain)throw Error('authored unsettled file');},assertTargetUnloaded(){assert.equal(controls.preloaded,undefined);},prepareTarget(){preparedCalls++;},
  sessionFactory(){factories++;return session;},importTarget(file:string){assert.equal(file,entry);events.push('import');imports++;if(controls.importThrows)throw Error('authored uncertain target initialization');if(!controls.missingEntry)session.emit('Debugger.scriptParsed',{params:{scriptId:'target',url:pathToFileURL(entry).href,length:c.scripts.get(entry)!.toString().length,startLine:0,startColumn:0,executionContextId:1}});
   return{createGateway:()=>{products++;return{server:new EventEmitter(),get ownershipSnapshot(){return structuredClone(state);},async close(){state.stopping=true;state.serverListening=false;state.cleanupTimers=0;}};}};
  },waitTargetReady(){events.push('ready-join');if(controls.readyRejected)return Promise.reject(Error('authored init rejection'));return controls.holdReady?ready.promise:Promise.resolve();},
  now:()=>0,setTimer:()=>({}),clearTimer(){},
 };
 return {...f,controls,ports,session,events,source,ready,enable,reads,outer,inputPath,node,c,changedInput(){inputBytes=Buffer.from(JSON.stringify({...outer,earlyArtifactSHA256:'0'.repeat(64)})+'\n');},async admitted(){return admitPreimportObserver(inputPath,ports);},get factories(){return factories;},get imports(){return imports;},get products(){return products;},get preparedCalls(){return preparedCalls;}};
}
