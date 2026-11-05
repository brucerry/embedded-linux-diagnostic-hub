import test from 'node:test';
import assert from 'node:assert/strict';
import {earlyMemory as fixture,syntheticEarly as synthetic} from './fixtures/gateway-early-memory';
import {inspectEarlyArtifact,prepareEarlyArtifact} from '../scripts/lib/instrumented-gateway-early-emission.mjs';
const EARLY_ENTRY='tests/fixtures/instrumented-gateway-preimport-entry.mjs';
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
