import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {sourceFixture,observedLifecycle} from './gateway-producer-memory';
import {sourceDigest} from '../../scripts/lib/committed-source-bridge.mjs';
import {EARLY_ENTRY} from '../../scripts/lib/instrumented-gateway-early-emission.mjs';

// Authored compiler-output stand-in. Parsed as data only, NEVER evaluated or claimed emitted.
export const syntheticEarly=Buffer.from(`import assert from 'node:assert/strict';
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
export function earlyMemory(){
 const reference=JSON.parse(readFileSync(new URL('./gateway-ownership-production.json',import.meta.url),'utf8'));
 const files=new Map<string,Buffer>(reference.inventory.map((row:any)=>[row.path,readFileSync(new URL('../../'+row.path,import.meta.url))])),graph=new Map<string,any>();
 function load(file:string){
  if(graph.has(file))return;const bytes=readFileSync(new URL('../../'+file,import.meta.url));files.set(file,bytes);const imports:any[]=[];graph.set(file,{bytes:bytes.length,imports});
  const tree=ts.createSourceFile(file,bytes.toString(),ts.ScriptTarget.Latest,true);
  for(const row of tree.statements)if((ts.isImportDeclaration(row)||ts.isExportDeclaration(row))&&row.moduleSpecifier){const spec=(row.moduleSpecifier as any).text;
   if(spec.startsWith('node:'))imports.push({path:spec,kind:'import-statement',external:true});
   else {assert.ok(spec.startsWith('.'));const next=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec));imports.push({path:next,kind:'import-statement'});load(next);}
  }
 }
 load(EARLY_ENTRY);const source=sourceFixture(files),controls:any={},calls:any[]=[],root='/project';
 const compiler=Buffer.from('#!/usr/bin/env node\n// synthetic compiler, never executed\n');
 const selection={root,sourceCommit:source.context.sourceCommit,sourceTree:source.context.sourceTree},tools={nodePath:'/tools/node',nodeSHA256:'a'.repeat(64),esbuildPath:'/project/node_modules/esbuild/bin/esbuild',esbuildSHA256:sourceDigest(compiler),esbuildEntryFormat:'node-script',esbuildEntryBytes:compiler};
 const external=[...new Set([...graph.values()].flatMap(v=>v.imports.filter((r:any)=>r.external).map((r:any)=>r.path)))].sort();
 let output=Buffer.from(syntheticEarly.toString()+external.filter(p=>!['node:assert/strict','node:module','node:inspector'].includes(p)).map(p=>"import '"+p+"';\n").join(''));
 const meta:any={inputs:Object.fromEntries(graph),outputs:{'validation/gateway-ownership/instrumented/preimport.mjs':{bytes:output.length,entryPoint:EARLY_ENTRY,imports:external.map(p=>({path:p,kind:'import-statement',external:true})),exports:['runPreimportCompatibilityFromFile'],inputs:Object.fromEntries([...graph.keys()].map(p=>[p,{bytesInOutput:1}]))}}};
 const ports:any={sourceProvider:source.provider,async observeToolchain(){return {...tools,...(controls.badCompiler?{esbuildEntryBytes:Buffer.from(controls.badCompiler),...(controls.matchBadHash?{esbuildSHA256:sourceDigest(Buffer.from(controls.badCompiler))}:{})}:{}),...(controls.badFormat?{esbuildEntryFormat:'native'}:{}),...(controls.changedTool?{nodeSHA256:'0'.repeat(64)}:{})};},
  async execute(plan:any){calls.push(plan);if(controls.onExecute)controls.onExecute(plan);const life=await observedLifecycle(controls.nonzero?'nonzero':'normal');if(controls.missingClose)life.closeObserved=false;if(controls.lifecycleField)life[controls.lifecycleField]=controls.lifecycleValue;return{...plan,lifecycle:life};},
  async read(file:string,max:number){assert.ok(max===32*1024**2||max===4*1024**2);if(file.endsWith('preimport-meta.json'))return controls.duplicateMeta?Buffer.from('{"inputs":{},"inputs":{},"outputs":{}}'):Buffer.from(JSON.stringify(meta));assert.ok(file.endsWith('/preimport.mjs'));return output;},assertFilesSettled(){if(controls.unsettled)throw Error('authored unretired file');},
 };
 return {selection,ports,controls,meta,calls,files,graph,source,replaceOutput(fn:(s:string)=>string){output=Buffer.from(fn(output.toString()));meta.outputs['validation/gateway-ownership/instrumented/preimport.mjs'].bytes=output.length;}};
}
