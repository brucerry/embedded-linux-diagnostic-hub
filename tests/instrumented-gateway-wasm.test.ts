import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {deriveWasmDiagnosticPlan,beginWasmDiagnostic,observeRejectedWasm,classifyRejectedWasm,validateWasmDiagnostic,POLY1305_SOURCE_SHA256,POLY1305_WASM_SHA256} from '../scripts/lib/instrumented-gateway-wasm-diagnostic.mjs';
import {createCompiledSourceObserver} from '../scripts/lib/instrumented-gateway-observer.mjs';
import {sourceDigest} from '../scripts/lib/committed-source-bridge.mjs';
import {releaseKnownInstrumentedFailure} from '../scripts/lib/instrumented-gateway-failure-retirement.mjs';
const root='/instrumented',artifactPath=root+'/gateway.cjs',creator=root+'/node_modules/ssh2/lib/protocol/crypto/poly1305.js';
// Data-only locked source. Never require or instantiate the Wasm module.
const poly=readFileSync(new URL('../node_modules/ssh2/lib/protocol/crypto/poly1305.js',import.meta.url));
const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8')).packages['node_modules/ssh2'];
const binary=Buffer.from(/W="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/.exec(poly.toString())![1],'base64');
const scripts=()=>new Map([[artifactPath,Buffer.from('// authored entry\n')],[creator,Buffer.from(poly)],[root+'/node_modules/ssh2/package.json',Buffer.from('{"name":"ssh2","version":"1.17.0"}')],[root+'/package-lock.json',Buffer.from(JSON.stringify({packages:{'node_modules/ssh2':lock}}))]]);
const notification=()=>({scriptLanguage:'WebAssembly',url:'wasm://wasm/authored-synthetic-name',scriptId:'wasm',isModule:false,executionContextId:1,stackTrace:{callFrames:[{scriptId:'creator',url:pathToFileURL(creator).href}]}});
const pulse=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const deferred=()=>{let resolve!:(v?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
test('locked Wasm diagnostic derives exact independent embedded bytes without executing them',()=>{
 assert.equal(poly.length,22812);assert.equal(sourceDigest(poly),POLY1305_SOURCE_SHA256);assert.equal(binary.length,10006);assert.equal(sourceDigest(binary),POLY1305_WASM_SHA256);
 const m=scripts(),p=deriveWasmDiagnosticPlan(m,artifactPath)!;const l=beginWasmDiagnostic(notification(),p);observeRejectedWasm(l,{scriptSource:'',bytecode:binary.toString('base64')});
 classifyRejectedWasm(l,new Map([['creator',{path:creator,sha256:p.creatorSHA256,zeroOffset:true,context:1}]]));const v=validateWasmDiagnostic(l.record);assert.equal(v.matchesPinnedEmbeddedModule,true);assert.equal(v.creatorSourceVerified,true);assert.equal(v.contextMatched,true);
 assert.equal('accepted' in v,false);assert.equal('url' in v,false);assert.equal('scriptId' in v,false);classifyRejectedWasm(l,new Map());assert.equal(v.creatorSourceVerified,l.record.creatorSourceVerified);
 m.set(creator,Buffer.from(poly.toString().replace('createPoly1305','createPoly1306')));assert.throws(()=>deriveWasmDiagnosticPlan(m,artifactPath));
});
for(const [name,result] of Object.entries({text:{scriptSource:'not empty',bytecode:binary.toString('base64')},missing:{scriptSource:''},oversize:{scriptSource:'',bytecode:'A'.repeat(13348)},noncanonical:{scriptSource:'',bytecode:binary.toString('base64').slice(0,-2)+'--'},short:{scriptSource:'',bytecode:'AAAA'}}))test('Wasm diagnostic rejects '+name,()=>{
 const l=beginWasmDiagnostic(notification(),deriveWasmDiagnosticPlan(scripts(),artifactPath));observeRejectedWasm(l,result);assert.equal(l.record.status,'invalid-response');assert.equal(l.record.bytecodeSHA256,null);validateWasmDiagnostic(l.record);
});
test('wrong same-size Wasm bytes are fingerprinted as nonmatching and cannot masquerade as known module',()=>{
 const l=beginWasmDiagnostic(notification(),deriveWasmDiagnosticPlan(scripts(),artifactPath)),b=Buffer.from(binary);b[100]^=1;observeRejectedWasm(l,{scriptSource:'',bytecode:b.toString('base64')});assert.equal(l.record.matchesPinnedEmbeddedModule,false);validateWasmDiagnostic(l.record);
 (l.record as any).matchesPinnedEmbeddedModule=true;assert.throws(()=>validateWasmDiagnostic(l.record));
});
test('language and creator metadata cannot grant source identity',()=>{
 const n=notification();n.scriptLanguage='JavaScript';const l=beginWasmDiagnostic(n,deriveWasmDiagnosticPlan(scripts(),artifactPath));assert.equal(l.record.status,'metadata-only');
 classifyRejectedWasm(l,new Map([['creator',{path:creator,sha256:'0'.repeat(64),zeroOffset:true,context:2}]]));assert.equal(l.record.creatorSourceVerified,false);assert.equal(l.record.contextMatched,false);
});
for(const prior of [false,true])test('actual observer Wasm rejection diagnostic first-primary='+!prior,async()=>{
 const m=scripts(),entry=m.get(artifactPath)!,events:string[]=[];
 class Session extends EventEmitter{connect(){}disconnect(){events.push('disconnect');}post(method:string,p:any,cb:Function){events.push(method);
  if(method==='Debugger.enable'){for(const [id,url,bytes]of [['entry',artifactPath,entry],['creator',creator,poly]] as const)this.emit('Debugger.scriptParsed',{params:{scriptId:id,url:pathToFileURL(url).href,length:bytes.toString().length,startLine:0,startColumn:0,executionContextId:1}});if(prior)this.emit('Debugger.scriptParsed',{params:{scriptId:'bad-prior',url:42}});this.emit('Debugger.scriptParsed',{params:notification()});cb(null,{});}
  else if(method==='Debugger.getScriptSource')cb(null,p.scriptId==='wasm'?{scriptSource:'',bytecode:binary.toString('base64')}:{scriptSource:p.scriptId==='entry'?entry.toString():poly.toString()});
  else {assert.equal(method,'Debugger.disable');cb(null,{});}
 }}
 const o=createCompiledSourceObserver({artifactPath,artifactSHA256:sourceDigest(entry),observerSHA256:'c'.repeat(64),sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40)},m,()=>new Session());
 await assert.rejects(o.start());assert.equal(o.snapshot().failureCode,prior?'script-metadata':'script-unadmitted');assert.equal(o.snapshot().wasmDiagnostic?.matchesPinnedEmbeddedModule,prior?undefined:true);await assert.rejects(o.finish());await o.retirement;
 assert.equal(o.snapshot().observerRetired,true);assert.equal(o.snapshot().wasmDiagnostic?.creatorSourceVerified,prior?undefined:true);assert.ok(events.includes('disconnect'));
});
test('root failure interval waits for actual output and local owner acknowledgements, clears once, never retries',async()=>{
 const write=deferred(),local=deferred();let cleared=0,joined=0,done=false;const hold={};const d={async joinFailedDirectRetirement(){joined++;await local.promise;}};
 const output={result:write.promise,closed:write.promise,snapshot:()=>({writeRetired:true,unknownOperation:false,failed:false})};const p=releaseKnownInstrumentedFailure(d,output,hold,(h:any)=>{assert.equal(h,hold);cleared++;}).then(()=>{done=true;});
 await pulse();assert.equal(joined,0);write.resolve();await pulse();assert.equal(joined,1);assert.equal(cleared,0);assert.equal(done,false);local.resolve();await p;assert.equal(cleared,1);await assert.rejects(releaseKnownInstrumentedFailure(d,output,hold,()=>{cleared++;}));assert.equal(cleared,1);
});
for(const kind of ['output-unknown','owner-rejected','clear-unknown','clear-rejected'])test('root fence refuses '+kind,async()=>{
 let cleared=0;const d={async joinFailedDirectRetirement(){if(kind==='owner-rejected')throw Error('held custody');}};
 const output={result:Promise.resolve(),closed:Promise.resolve(),snapshot:()=>({writeRetired:true,unknownOperation:kind==='output-unknown',failed:false})};
 await assert.rejects(releaseKnownInstrumentedFailure(d,output,{},()=>{cleared++;return kind==='clear-unknown'?true:kind==='clear-rejected'?Promise.reject(Error('authored uncertain clear')):undefined;}));assert.equal(cleared,kind.startsWith('clear-')?1:0);
});

for(const key of ['failed','unknownOperation'])test('late output '+key+' while local join held cannot release root fence',async()=>{
 const local=deferred();let cleared=0;const state={writeRetired:true,failed:false,unknownOperation:false};const d={async joinFailedDirectRetirement(){await local.promise;}};const output={result:Promise.resolve(),closed:Promise.resolve(),snapshot:()=>({...state})};const task=releaseKnownInstrumentedFailure(d,output,{},()=>{cleared++;});const rejected=assert.rejects(task);await pulse();state[key as 'failed'|'unknownOperation']=true;local.resolve();await rejected;assert.equal(cleared,0);
});

for(const id of [0,-1,undefined])test('unestablished Wasm context '+id+' never becomes same-context proof',()=>{
 const n:any=notification();n.executionContextId=id;const plan=deriveWasmDiagnosticPlan(scripts(),artifactPath)!;const l=beginWasmDiagnostic(n,plan);classifyRejectedWasm(l,new Map([['creator',{path:creator,sha256:plan.creatorSHA256,zeroOffset:true,context:id}]]));assert.equal(l.record.contextMatched,false);
});
