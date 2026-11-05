import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {memoryFilesystem} from './fixtures/gateway-producer-memory';
import {sourceDigest} from '../scripts/lib/committed-source-bridge.mjs';
import {censusInstrumentedGateway} from '../scripts/lib/instrumented-gateway-census.mjs';
import {RAW_CLI_REFERENCE} from '../scripts/lib/instrumented-gateway-check.mjs';
import {deriveInstrumentedGeneratedInventory} from '../scripts/lib/instrumented-gateway-generated.mjs';
import {admitPreimportObserver,createPreimportObserverBoundary} from '../scripts/lib/instrumented-gateway-preimport.mjs';
import {cachedSshInitialization,deriveSshReadinessPlan,assertPreimportCacheEmpty} from '../scripts/lib/instrumented-gateway-ssh-readiness.mjs';

const root='/project/validation/gateway-ownership/instrumented',entry=root+'/ownership.cjs',early=root+'/preimport.mjs';
const pulse=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
const until=async(predicate:()=>boolean)=>{for(let i=0;i<20000&&!predicate();i++)await Promise.resolve();assert.ok(predicate(),'Expected deterministic fake callback was not admitted');};
const deferred=()=>{let resolve!:(v?:any)=>void,reject!:(v:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return {promise,resolve,reject};};
async function fixture(mode='compatibility'){
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
test('preimport requires real IO admission; JSON/copy/second factory cannot mint a Session',async()=>{
 const f=await fixture();assert.throws(()=>createPreimportObserverBoundary({}));const a=await f.admitted();assert.equal(f.factories,0);const o=createPreimportObserverBoundary(a);assert.equal(f.factories,0);assert.throws(()=>createPreimportObserverBoundary(a));assert.throws(()=>createPreimportObserverBoundary({...a}));await assert.rejects(o.finish());await o.retirement;
});
test('real enable acknowledgement precedes import; source tasks and SAME Session survive one-use handoff',async()=>{
 const f=await fixture();f.controls.holdEnable=true;const o=createPreimportObserverBoundary(await f.admitted()),opening=o.enable();await until(()=>f.factories===1);assert.equal(f.factories,1);assert.throws(()=>o.import());assert.equal(f.imports,0);f.enable.resolve();await opening;
 f.controls.holdSource=true;await o.import();assert.equal(o.snapshot().collector.pendingSourceClassifications,1);const ticket=o.offer();const consumer=o.consume(ticket,o.binding());assert.ok('result' in consumer);let done=false;consumer.result.then(()=>{done=true;});await pulse();assert.equal(done,false);assert.equal(f.factories,1);assert.equal(f.events.filter(x=>x==='connect').length,1);assert.equal(f.events.filter(x=>x==='Debugger.enable').length,1);assert.throws(()=>o.consume(ticket,o.binding()));assert.throws(()=>o.finish());
 f.source.resolve();const r=await consumer.result;await consumer.closed;await o.retirement;assert.equal(r.receipt.schema,'instrumented-node-inspector-preimport-compatibility-v1');assert.equal(r.receipt.releaseAcceptance,false);assert.equal(f.events.filter(x=>x==='disconnect').length,1);assert.equal(o.snapshot().phase,'retired');
});
test('initialization readiness must acknowledge before transfer; no re-import or factory replay',async()=>{
 const f=await fixture();f.controls.holdReady=true;const o=createPreimportObserverBoundary(await f.admitted());await o.enable();let done=false;const importing=o.import().then(()=>{done=true;});await until(()=>f.imports===1);assert.equal(f.imports,1);assert.equal(done,false);assert.throws(()=>o.offer());f.ready.resolve();await importing;assert.equal(f.imports,1);const consumer=o.consume(o.offer(),o.binding());assert.ok('result' in consumer);await consumer.result;await o.retirement;
});
test('ownership consumer uses same collector and waits source coverage before product factory',async()=>{
 const f=await fixture('ownership');const o=createPreimportObserverBoundary(await f.admitted());await o.enable();f.controls.holdSource=true;await o.import();const consumer=o.consume(o.offer(),o.binding());assert.ok('start' in consumer);const started=consumer.start({});await pulse();assert.equal(f.products,0);f.source.resolve();await started;assert.equal(f.products,1);await consumer.close();await o.retirement;assert.equal(f.factories,1);assert.equal(f.events.filter(x=>x==='disconnect').length,1);
});
for(const key of ['nonce','inputSHA256','source','bindingSHA256','node','censusSHA256','guardSHA256','earlyArtifactPath','earlyArtifactSHA256','targetPath','targetSHA256','mode'])test('one-use transfer refuses mismatched '+key,async()=>{
 const f=await fixture();const o=createPreimportObserverBoundary(await f.admitted());await o.enable();await o.import();const t=o.offer(),b:any=o.binding();b[key]=key==='source'?{sourceCommit:'0'.repeat(40),sourceTree:'0'.repeat(40)}:key==='node'?{...b.node,sha256:'0'.repeat(64)}:'wrong';assert.throws(()=>o.consume(t,b));assert.throws(()=>o.consume(t,o.binding()));await assert.rejects(o.finish());await o.retirement;assert.equal(f.factories,1);
});
test('tickets are not portable to another closure or reconstructed from JSON',async()=>{
 const f=await fixture(),g=await fixture();const a=createPreimportObserverBoundary(await f.admitted()),b=createPreimportObserverBoundary(await g.admitted());await a.enable();await b.enable();await a.import();await b.import();const ticket=a.offer(),other=b.offer();assert.throws(()=>b.consume(ticket,b.binding()));assert.throws(()=>a.consume({...ticket},a.binding()));const c=a.consume(ticket,a.binding()),d=b.consume(other,b.binding());assert.ok('result' in c&&'result' in d);await c.result;await d.result;await a.retirement;await b.retirement;
});
for(const kind of ['changedNode','wrongSelf','guardFailed','fileUncertain'])test('admission refuses '+kind+' before Session acquisition',async()=>{
 const f=await fixture();f.controls[kind]=true;await assert.rejects(f.admitted());assert.equal(f.factories,0);assert.equal(f.imports,0);
});
test('stale admission is revalidated before Session construction',async()=>{
 const f=await fixture();const o=createPreimportObserverBoundary(await f.admitted());f.changedInput();await assert.rejects(o.enable());assert.equal(f.factories,0);await assert.rejects(o.finish());await o.retirement;
});
test('close during held admission revalidation prevents late Session and import',async()=>{
 const f=await fixture();const o=createPreimportObserverBoundary(await f.admitted());f.controls.readHeld=true;const e=o.enable(),rejected=assert.rejects(e),closing=assert.rejects(o.finish());await pulse();assert.equal(f.factories,0);f.reads.resolve();await rejected;await closing;await o.retirement;assert.equal(f.factories,0);assert.equal(f.imports,0);
});
test('entry coverage remains mandatory after early enable',async()=>{
 const f=await fixture();f.controls.missingEntry=true;const o=createPreimportObserverBoundary(await f.admitted());await o.enable();await o.import();const c=o.consume(o.offer(),o.binding());assert.ok('result' in c);await assert.rejects(c.result);await c.closed;await o.retirement;assert.equal(f.products,0);assert.equal(o.snapshot().collector.failureCode,'entry-missing');
});
test('bad target source cannot reach product acquisition despite completed init',async()=>{
 const f=await fixture('ownership');f.controls.holdSource=true;f.controls.wrongTarget=true;const o=createPreimportObserverBoundary(await f.admitted());await o.enable();await o.import();const c=o.consume(o.offer(),o.binding());assert.ok('start' in c);const started=c.start({}),bad=assert.rejects(started);f.source.resolve();await bad;await assert.rejects(c.close());await o.retirement;assert.equal(f.products,0);
});
for(const kind of ['importThrows','readyRejected'])test('unknown/failed target '+kind+' never grants initialization retirement',async()=>{
 const f=await fixture();f.controls[kind]=true;const o=createPreimportObserverBoundary(await f.admitted());await o.enable();await assert.rejects(o.import());let retired=false;o.retirement.then(()=>{retired=true;});await assert.rejects(o.finish());await pulse();assert.equal(retired,false);assert.equal(o.snapshot().targetUncertain,true);assert.equal(f.imports,1);assert.throws(()=>o.offer());
});
test('held disable keeps consumed Session retirement pending',async()=>{
 const f=await fixture();f.controls.holdDisable=true;const o=createPreimportObserverBoundary(await f.admitted());await o.enable();await o.import();const c=o.consume(o.offer(),o.binding());assert.ok('result' in c);let retired=false;o.retirement.then(()=>{retired=true;});await pulse();assert.equal(retired,false);assert.equal(f.events.includes('disconnect'),false);f.reads.resolve();await c.result;await o.retirement;assert.equal(retired,true);
});
test('cached initialization joins original Promise; absence/alias/getters cannot invoke a new factory',async()=>{
 const pending=deferred(),file=root+'/node_modules/ssh2/lib/protocol/crypto.js',plan={path:file,sha256:'a'.repeat(64)},cache:any={[file]:{filename:file,loaded:true,exports:{init:pending.promise}}};assert.equal(cachedSshInitialization(cache,plan),pending.promise);
 let calls=0;assert.throws(()=>cachedSshInitialization({},plan));assert.throws(()=>cachedSshInitialization({[file]:{filename:'/other',loaded:true,exports:{init:pending.promise}}},plan));assert.throws(()=>cachedSshInitialization({[file]:{filename:file,loaded:false,exports:{init:pending.promise}}},plan));assert.throws(()=>cachedSshInitialization({[file]:{filename:file,loaded:true,exports:{get init(){calls++;return pending.promise;}}}},plan));assert.equal(calls,0);pending.resolve();await pending.promise;
});
test('fixed readiness plan binds locked crypto source; raw native composition has no product import or default activation',()=>{
 const bytes=readFileSync(new URL('../node_modules/ssh2/lib/protocol/crypto.js',import.meta.url)),lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8')).packages['node_modules/ssh2'];
 const m=new Map([[root+'/node_modules/ssh2/lib/protocol/crypto.js',bytes],[root+'/node_modules/ssh2/package.json',Buffer.from('{"name":"ssh2","version":"1.17.0"}')],[root+'/package-lock.json',Buffer.from(JSON.stringify({packages:{'node_modules/ssh2':lock}}))]]);assert.equal(deriveSshReadinessPlan(m,root).path,root+'/node_modules/ssh2/lib/protocol/crypto.js');m.set(root+'/node_modules/ssh2/lib/protocol/crypto.js',Buffer.from('wrong'));assert.throws(()=>deriveSshReadinessPlan(m,root));
 const source=readFileSync(new URL('./fixtures/instrumented-gateway-preimport-native.mjs',import.meta.url),'utf8');assert.ok(!source.includes("from '../../gateway/server'"));assert.ok(!source.includes('process.argv[1]'));assert.ok(!source.includes('new Session();\nconst'));assert.ok(source.includes('sessionFactory()'));assert.ok(source.includes('require(file)'));assert.ok(source.includes('cachedSshInitialization(require.cache,readyPlan)'));
});

test('replayed target refuses preimport handoff even with exact bytes',async()=>{
 const f=await fixture();f.controls.replayedTarget=true;const o=createPreimportObserverBoundary(await f.admitted());await assert.rejects(o.enable());assert.equal(f.imports,0);assert.throws(()=>o.import());assert.throws(()=>o.offer());await assert.rejects(o.finish());await o.retirement;assert.equal(f.events.filter(x=>x==='disconnect').length,1);
});
for(const stage of ['admission','enable','import'])test('cached target refuses '+stage+' before importing',async()=>{
 const f=await fixture();if(stage==='admission'){f.controls.preloaded=true;await assert.rejects(f.admitted());assert.equal(f.factories,0);return;}
 const o=createPreimportObserverBoundary(await f.admitted());if(stage==='import')await o.enable();f.controls.preloaded=true;await assert.rejects(stage==='enable'?o.enable():o.import());assert.equal(f.imports,0);assert.equal(o.snapshot().targetUncertain,false);await assert.rejects(o.finish());await o.retirement;
});
test('fixed preimport cache guard rejects target and async dependency slots without getter execution',()=>{
 assertPreimportCacheEmpty({},root);let calls=0;
 for(const file of [entry,root+'/node_modules/ssh2/lib/protocol/crypto.js',root+'/node_modules/ssh2/lib/protocol/crypto/poly1305.js']){const cache={};Object.defineProperty(cache,file,{get(){calls++;throw Error('unreachable');}});assert.throws(()=>assertPreimportCacheEmpty(cache,root));}
 assert.equal(calls,0);
});
