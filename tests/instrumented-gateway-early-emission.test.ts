import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {sourceFixture,observedLifecycle} from './fixtures/gateway-producer-memory';
import {sourceDigest} from '../scripts/lib/committed-source-bridge.mjs';
import {EARLY_ENTRY,inspectEarlyArtifact,prepareEarlyArtifact} from '../scripts/lib/instrumented-gateway-early-emission.mjs';

// Authored compiler-output stand-in. Parsed as data only, NEVER evaluated or claimed emitted.
const synthetic=Buffer.from(`import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Session} from 'node:inspector';
const sourceObservers=new WeakMap();
function createNativePreimportPorts(guard){
 const root='/synthetic',require=createRequire(import.meta.url);
 return {sessionFactory(){return new Session();},importTarget(file){
 assert.equal(file,root+'/ownership.cjs');guard.assertActive(root);assertPreimportCacheEmpty(require.cache,root);
 const target=require(file);assert.equal(typeof target.createGateway,'function');return Object.freeze({createGateway:target.createGateway});
 }};
}
export function runPreimportCompatibilityFromFile(){return createNativePreimportPorts;}
`);
function fixture(){
 const reference=JSON.parse(readFileSync(new URL('./fixtures/gateway-ownership-production.json',import.meta.url),'utf8'));
 const files=new Map<string,Buffer>(reference.inventory.map((row:any)=>[row.path,readFileSync(new URL('../'+row.path,import.meta.url))])),graph=new Map<string,any>();
 function load(file:string){
  if(graph.has(file))return;const bytes=readFileSync(new URL('../'+file,import.meta.url));files.set(file,bytes);const imports:any[]=[];graph.set(file,{bytes:bytes.length,imports});
  const tree=ts.createSourceFile(file,bytes.toString(),ts.ScriptTarget.Latest,true);
  for(const row of tree.statements)if((ts.isImportDeclaration(row)||ts.isExportDeclaration(row))&&row.moduleSpecifier){const spec=(row.moduleSpecifier as any).text;
   if(spec.startsWith('node:'))imports.push({path:spec,kind:'import-statement',external:true});
   else {assert.ok(spec.startsWith('.'));const next=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec));imports.push({path:next,kind:'import-statement'});load(next);}
  }
 }
 load(EARLY_ENTRY);const source=sourceFixture(files),controls:any={},calls:any[]=[],root='/project';
 const compiler=Buffer.from('#!/usr/bin/env node\n// synthetic compiler, never executed\n');
 const selection={root,sourceCommit:source.context.sourceCommit,sourceTree:source.context.sourceTree},tools={nodePath:'/tools/node',nodeSHA256:'a'.repeat(64),esbuildPath:'/project/node_modules/esbuild/bin/esbuild',esbuildSHA256:sourceDigest(compiler),esbuildEntryFormat:'node-script',esbuildEntryBytes:compiler};
 let output=Buffer.from(synthetic);
 const meta:any={inputs:Object.fromEntries(graph),outputs:{'validation/gateway-ownership/instrumented/preimport.mjs':{bytes:output.length,entryPoint:EARLY_ENTRY,imports:['node:assert/strict','node:module','node:inspector'].map(p=>({path:p,kind:'import-statement',external:true})),exports:['runPreimportCompatibilityFromFile'],inputs:Object.fromEntries([...graph.keys()].map(p=>[p,{bytesInOutput:1}]))}}};
 const ports:any={sourceProvider:source.provider,async observeToolchain(){return {...tools,...(controls.badCompiler?{esbuildEntryBytes:Buffer.from(controls.badCompiler),...(controls.matchBadHash?{esbuildSHA256:sourceDigest(Buffer.from(controls.badCompiler))}:{})}:{}),...(controls.badFormat?{esbuildEntryFormat:'native'}:{}),...(controls.changedTool?{nodeSHA256:'0'.repeat(64)}:{})};},
  async execute(plan:any){calls.push(plan);if(controls.onExecute)controls.onExecute(plan);const life=await observedLifecycle(controls.nonzero?'nonzero':'normal');if(controls.missingClose)life.closeObserved=false;if(controls.lifecycleField)life[controls.lifecycleField]=controls.lifecycleValue;return{...plan,lifecycle:life};},
  async read(file:string,max:number){assert.ok(max===32*1024**2||max===4*1024**2);if(file.endsWith('preimport-meta.json'))return controls.duplicateMeta?Buffer.from('{"inputs":{},"inputs":{},"outputs":{}}'):Buffer.from(JSON.stringify(meta));assert.ok(file.endsWith('/preimport.mjs'));return output;},assertFilesSettled(){if(controls.unsettled)throw Error('authored unretired file');},
 };
 return {selection,ports,controls,meta,calls,files,graph,source,replaceOutput(fn:(s:string)=>string){output=Buffer.from(fn(output.toString()));meta.outputs['validation/gateway-ownership/instrumented/preimport.mjs'].bytes=output.length;}};
}
test('actual frozen source graph is builtins-only, one observer registry and one guarded target import; fake acknowledgement is not runtime proof',async()=>{
 const f=fixture(),r=await prepareEarlyArtifact(f.selection,f.ports);assert.ok(f.graph.size>10);assert.equal([...f.graph.keys()].some(p=>p.startsWith('gateway/')||p.startsWith('backend/')),false);assert.equal(r.singlePrivateSessionFactory,true);assert.equal(r.singleObserverRegistry,true);assert.equal(r.fixedGuardedTargetImport,true);assert.equal(r.releaseAcceptance,false);assert.equal(r.actualRuntime,null);assert.equal(f.calls.length,1);assert.ok(f.calls[0].command.includes('--format=esm'));assert.ok(f.calls[0].command.includes('--tree-shaking=false'));
});
for(const mutate of [
 (s:string)=>s.replace("from 'node:module'","from 'ssh2'"),
 (s:string)=>s+"\nimport x from 'file:///outside';",
 (s:string)=>s+"\nimport('ssh2');",
 (s:string)=>s.replace('guard.assertActive(root);',''),
 (s:string)=>s.replace('assertPreimportCacheEmpty(require.cache,root);',''),
 (s:string)=>s.replace("root+'/ownership.cjs'","root+'/another.cjs'"),
 (s:string)=>s.replace('const target=require(file);','const target=require(file);require(file);'),
 (s:string)=>s.replace('const sourceObservers=new WeakMap();',''),
 (s:string)=>s.replace('return new Session();','return new Session();new Session();'),
 (s:string)=>s+"\nrequire('/outside');",
 (s:string)=>s.replace('export function runPreimportCompatibilityFromFile','function runPreimportCompatibilityFromFile'),
 (s:string)=>s.replace('runPreimportCompatibilityFromFile','wrongExport'),
 (s:string)=>s.replace('export function runPreimportCompatibilityFromFile','export default function runPreimportCompatibilityFromFile'),
])test('emitted JS structural mutation fails closed',()=>{assert.throws(()=>inspectEarlyArtifact(Buffer.from(mutate(synthetic.toString()))));});
for(const kind of ['nonzero','missingClose','duplicateMeta','unsettled'])test('emission refuses '+kind+' and never returns a build record',async()=>{
 const f=fixture();f.controls[kind]=true;await assert.rejects(prepareEarlyArtifact(f.selection,f.ports));assert.equal(f.calls.length,1);
});
for(const mutate of [
 (f:any)=>{f.meta.inputs['gateway/server.ts']={bytes:1,imports:[]};},
 (f:any)=>{delete f.meta.inputs[EARLY_ENTRY];},
 (f:any)=>{f.meta.outputs.extra={};},
 (f:any)=>{f.meta.outputs['validation/gateway-ownership/instrumented/preimport.mjs'].exports=[];},
 (f:any)=>{f.meta.outputs['validation/gateway-ownership/instrumented/preimport.mjs'].imports.push({path:'ssh2',kind:'require-call',external:true});},
 (f:any)=>{f.meta.inputs[EARLY_ENTRY].bytes++;},
 (f:any)=>{f.meta.inputs[EARLY_ENTRY].imports[0].path='wrong';},
])test('compiler census cannot add, omit or alter source/output edges',async()=>{const f=fixture();mutate(f);await assert.rejects(prepareEarlyArtifact(f.selection,f.ports));});
test('source and tool mutation after acknowledgement prevent returned evidence',async()=>{
 for(const kind of ['source','tool']){const f=fixture();f.controls.onExecute=()=>{if(kind==='tool')f.controls.changedTool=true;else{const prior=f.source.provider.file;f.source.provider.file=async(p:string)=>p===EARLY_ENTRY?{mode:'100644',bytes:Buffer.from('changed')}:prior(p);}};await assert.rejects(prepareEarlyArtifact(f.selection,f.ports));}
});
test('early snapshot/input split does not import the semver producer or product',()=>{
 const f=fixture();assert.ok(f.graph.has('scripts/lib/instrumented-gateway-snapshot.mjs'));assert.ok(f.graph.has('scripts/lib/instrumented-gateway-input.mjs'));for(const p of ['scripts/lib/instrumented-gateway-check.mjs','scripts/lib/instrumented-gateway-child.mjs','scripts/lib/gateway-lock-plan.mjs'])assert.equal(f.graph.has(p),false);
});

for(const kind of ['native','unknown','mismatched'])test('unsupported compiler entry '+kind+' refuses before dispatch',async()=>{
 const f=fixture();if(kind==='native')f.controls.badFormat=true;else if(kind==='unknown'){f.controls.badCompiler='#!/usr/bin/unknown\n';f.controls.matchBadHash=true;}else f.controls.badCompiler='#!/usr/bin/env node\nwrong';await assert.rejects(prepareEarlyArtifact(f.selection,f.ports));assert.equal(f.calls.length,0);
});

for(const key of ['spawnObserved','exitObserved','closeObserved'])for(const value of ['false',1,undefined])test('compiler lifecycle flag '+key+' must be exact boolean true: '+String(value),async()=>{
 const f=fixture();f.controls.lifecycleField=key;f.controls.lifecycleValue=value;await assert.rejects(prepareEarlyArtifact(f.selection,f.ports));
});

test('compiler elapsed observation rejects a numeric string',async()=>{
 const f=fixture();f.controls.lifecycleField='elapsedMs';f.controls.lifecycleValue='0';await assert.rejects(prepareEarlyArtifact(f.selection,f.ports));
});
