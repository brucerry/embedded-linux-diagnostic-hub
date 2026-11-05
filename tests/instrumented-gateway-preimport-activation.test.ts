import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const until=async(fn:()=>boolean)=>{for(let i=0;i<1000&&!fn();i++)await Promise.resolve();assert.ok(fn());};
function fakeActivation(){
 const file=new URL('./fixtures/instrumented-gateway-preimport-activate.cjs',import.meta.url),source=readFileSync(file,'utf8');
 let cuts=0;
 const transformed=ts.transpileModule(source,{fileName:'activation.cjs',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},transformers:{before:[context=>tree=>{
  const visit=(node:ts.Node):ts.VisitResult<ts.Node>=>{
   if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){cuts++;return ts.factory.updateCallExpression(node,ts.factory.createIdentifier('ownedImport'),node.typeArguments,node.arguments);}
   return ts.visitEachChild(node,visit,context);
  };return ts.visitNode(tree,visit) as ts.SourceFile;
 }]}}).outputText;
 assert.equal(cuts,1);const root='/project/validation/gateway-ownership/instrumented',events:string[]=[],timers:any[]=[],holds:any[]=[];let resolve!:(value:any)=>void,imports=0,retained=0,called=0,holdPorts:any;
 const pending=new Promise(a=>{resolve=a;}),module={},fakeProcess:any={argv:['/tools/node',root+'/activate.cjs','/project/validation/gateway-ownership/preimport-input-compatibility.json'],execArgv:[],env:{},version:'v24.22.0',platform:'linux',arch:'x64',getuid:()=>1000};
 const guard={assertActive(){events.push('guard-active');},retainFailure(){retained++;}},require:any=(name:string)=>{
  if(name==='node:assert/strict')return{...assert,deepEqual(a:unknown,b:unknown){assert.deepEqual(structuredClone(a),structuredClone(b));}};if(name==='node:path')return path;if(name==='node:url')return{pathToFileURL};if(name==='node:module')return{registerHooks(){throw Error('Never invoke real hooks');},isBuiltin(){return true;}};
  assert.equal(name,'./resolution-guard.cjs');events.push('guard-file');return{createInstrumentedResolutionGuard(){events.push('guard-register');return guard;}};
 };require.main=module;
 vm.runInNewContext(transformed,{require,module,process:fakeProcess,__filename:root+'/activate.cjs',__dirname:root,
  setInterval(_fn:Function,ms:number){assert.equal(ms,1000);const h={cleared:false};holds.push(h);events.push('hold');return h;},clearInterval(h:any){h.cleared=true;events.push('clear-hold');},
  setTimeout(fn:Function,ms:number){assert.equal(ms,60000);const t={fn,cleared:false};timers.push(t);events.push('deadline');return t;},clearTimeout(t:any){t.cleared=true;events.push('clear-deadline');},
  ownedImport(url:string){imports++;assert.equal(url,pathToFileURL(root+'/preimport.mjs').href);events.push('early-import');return pending;},
 });
 const activate=()=>resolve({runPreimportCompatibilityFromFile(_input:string,_guard:any,ports:any){called++;holdPorts=ports;return{result:Promise.resolve()};}});
 return{events,timers,holds,activate,fakeProcess,get called(){return called;},get ports(){return holdPorts;},get imports(){return imports;},get retained(){return retained;}};
}
test('actual CJS activation creates root hold and shared deadline before guard/early file acquisition',async()=>{
 const f=fakeActivation();assert.deepEqual(f.events.slice(0,4),['hold','deadline','guard-file','guard-register']);assert.equal(f.imports,1);f.activate();await until(()=>f.called===1);const h=f.ports.startHold(),d=f.ports.startDeadline(()=>{},60000);assert.equal(h,f.holds[0]);assert.equal(d,f.timers[0]);assert.equal(f.timers.length,1);assert.throws(()=>f.ports.startHold());assert.throws(()=>f.ports.startDeadline(()=>{},60000));assert.throws(()=>f.ports.clearHold({}));f.ports.clearDeadline(d);f.ports.clearHold(h);assert.equal(h.cleared,true);assert.equal(d.cleared,true);assert.throws(()=>f.ports.clearHold(h));assert.throws(()=>f.ports.clearDeadline(d));d.fn();assert.equal(f.fakeProcess.exitCode,undefined);
});
test('deadline before early-module resolution fences later coordinator and leaves root held',async()=>{
 const f=fakeActivation();f.timers[0].fn();assert.equal(f.fakeProcess.exitCode,1);f.activate();await until(()=>f.retained===1);assert.equal(f.called,0);assert.equal(f.holds[0].cleared,false);assert.equal(f.timers[0].cleared,false);
});
test('transferred deadline calls only its admitted callback without renewal',async()=>{
 const f=fakeActivation();f.activate();await until(()=>f.called===1);let expired=0;f.ports.startHold();f.ports.startDeadline(()=>{expired++;},60000);f.timers[0].fn();assert.equal(expired,1);assert.equal(f.fakeProcess.exitCode,1);assert.equal(f.timers.length,1);assert.equal(f.holds[0].cleared,false);
});
