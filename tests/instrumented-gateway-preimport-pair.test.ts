import test from 'node:test';
import assert from 'node:assert/strict';
import {preimportPairMemory} from './fixtures/gateway-preimport-pair-memory';
import {preparePreimportCompatibilityBuild,claimPreimportCompatibilityBuild,preimportTargetGraph,inspectPreimportTarget} from '../scripts/lib/instrumented-gateway-preimport-build.mjs';
import {createPreimportCompatibilityParent} from '../scripts/lib/instrumented-gateway-preimport-parent.mjs';
import {snapshotPreparedInstrumentedGateway} from '../scripts/lib/instrumented-gateway-snapshot.mjs';
const until=async(fn:()=>boolean)=>{for(let i=0;i<30000&&!fn();i++)await Promise.resolve();assert.ok(fn(),'Bounded fake stage not reached');};
const pulse=async()=>{for(let i=0;i<1000;i++)await Promise.resolve();};

test('actual source two-artifact pipeline binds the frontend-free parser route and admits exactly one fake compatibility child',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts);assert.equal(cap.snapshot().buildCommands,2);assert.deepEqual(f.calls.map(p=>p.command.includes('--format=cjs')?'target':'early'),['target','early']);
 assert.ok(f.graph.files.has('src/features/automation/serial-completion.ts'));assert.ok(f.graph.files.has('backend/ssh/persistent-console.ts'));assert.ok(f.graph.files.has('shared/automation-time.ts'));assert.ok(f.graph.files.has('package.json'));
 const parent=createPreimportCompatibilityParent(cap,f.host);assert.throws(()=>createPreimportCompatibilityParent(cap,f.host));const r=await parent.run();assert.equal(parent.snapshot().completed,true);assert.equal(f.children.length,1);assert.equal(r.receipt.scope,'compatibility-only-no-factory-or-ownership-requested');assert.equal(r.receipt.ownershipContinuation,false);assert.equal(r.receipt.releaseAcceptance,false);assert.ok(r.bytes.length<=16384);assert.equal(f.handles.size,0);assert.equal(f.directories.size,0);await assert.rejects(parent.run());
});
test('copied or serialized build records cannot grant parent admission',async()=>{
 const f=await preimportPairMemory();assert.throws(()=>createPreimportCompatibilityParent({},f.host));const cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts);assert.throws(()=>createPreimportCompatibilityParent({...cap},f.host));assert.throws(()=>createPreimportCompatibilityParent(cap.snapshot(),f.host));assert.equal(f.children.length,0);
});
for(const kind of ['target','early'])test('failed '+kind+' compiler stops dependent build/child without retry',async()=>{
 const f=await preimportPairMemory();f.controls.failBuild=kind;await assert.rejects(preparePreimportCompatibilityBuild(f.selection,f.buildPorts));assert.equal(f.calls.length,kind==='target'?1:2);assert.equal(f.children.length,0);
});
for(const name of ['ownership.cjs','preimport.mjs'])test('existing '+name+' is preserved before compiler writes',async()=>{
 const f=await preimportPairMemory();f.write(f.installed+'/'+name,Buffer.from('synthetic existing data'));await assert.rejects(preparePreimportCompatibilityBuild(f.selection,f.buildPorts));assert.equal(f.calls.length,0);assert.equal(f.bytes(f.installed+'/'+name).toString(),'synthetic existing data');
});
test('late early-output collision after target build stops before second compiler',async()=>{
 const f=await preimportPairMemory();f.controls.beforeBuild=(kind:string)=>{if(kind==='target')f.write(f.installed+'/preimport.mjs',Buffer.from('preserved'));};await assert.rejects(preparePreimportCompatibilityBuild(f.selection,f.buildPorts));assert.equal(f.calls.length,1);assert.equal(f.bytes(f.installed+'/preimport.mjs').toString(),'preserved');
});
test('target census cannot omit the actual serial-completion dependency',async()=>{
 const f=await preimportPairMemory();delete f.targetMeta.inputs['src/features/automation/serial-completion.ts'];delete f.targetMeta.outputs['validation/gateway-ownership/instrumented/ownership.cjs'].inputs['src/features/automation/serial-completion.ts'];await assert.rejects(preparePreimportCompatibilityBuild(f.selection,f.buildPorts));assert.equal(f.calls.length,1);assert.equal(f.children.length,0);
});
test('target source graph rejects arbitrary UI expansion rather than allowing all src',async()=>{
 const f=await preimportPairMemory(),files=new Map(f.files);files.set('src/features/automation/serial-completion.ts',Buffer.from("import x from '../../App';export const y=x;"));files.set('src/App.ts',Buffer.from('export default 1;'));await assert.rejects(preimportTargetGraph(async (p:string)=>Buffer.from(files.get(p)!),(p:string)=>files.has(p)));
});
test('target JS rejects an Inspector, dynamic target require or Gateway factory call',()=>{
 for(const s of ["require('node:inspector');require('ssh2');function createGateway(){}", "require(x);function createGateway(){}", "require('ssh2');function createGateway(){}createGateway();", "require('ssh2');function createGateway(){}module.exports={};"])assert.throws(()=>inspectPreimportTarget(Buffer.from(s)));
});
test('new binding snapshots cannot detach the early artifact or omit its graph identity',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts),record=claimPreimportCompatibilityBuild(cap);assert.throws(()=>claimPreimportCompatibilityBuild(cap));
 for(const change of [(v:any)=>v.preimport.earlyArtifactSHA256='0'.repeat(64),(v:any)=>delete v.preimport.targetGraphSHA256]){const binding=structuredClone(record.prepared.binding);change(binding);assert.throws(()=>snapshotPreparedInstrumentedGateway({...record.prepared,binding}));}
});
for(const kind of ['nonzero','wrongSpawn','badIdentity','postMutation'])test('failed child '+kind+' remains failure after known direct retirement',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts);f.controls[kind]=true;const p=createPreimportCompatibilityParent(cap,f.host);await assert.rejects(p.run());await p.joinFailedDirectRetirement();assert.equal(p.snapshot().failureRetired,true);assert.equal(p.snapshot().completed,false);assert.equal(f.children.length,1);await assert.rejects(p.run());await assert.rejects(p.joinFailedDirectRetirement());assert.equal(f.handles.size,0);
});
test('parent timeout reports while child held; acknowledgement can retire later without promoting success',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts);f.controls.holdChild=true;const p=createPreimportCompatibilityParent(cap,f.host),run=p.run(),bad=assert.rejects(run);await until(()=>f.children.length===1);f.expire();await bad;let joined=false;const join=p.joinFailedDirectRetirement().then(()=>{joined=true;});await pulse();assert.equal(joined,false);f.children[0].finish();await join;assert.equal(p.snapshot().failureRetired,true);assert.equal(p.snapshot().completed,false);assert.equal(f.children.length,1);
});
test('closed child without both pipe acknowledgements cannot retire',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts);f.controls.holdPipes=true;const p=createPreimportCompatibilityParent(cap,f.host),run=p.run(),bad=assert.rejects(run);await until(()=>f.children.length===1);await pulse();f.expire();await bad;let joined=false;const join=p.joinFailedDirectRetirement().then(()=>{joined=true;});await pulse();assert.equal(joined,false);f.children[0].stdout.emit('close');f.children[0].stderr.emit('close');await join;assert.equal(p.snapshot().failureRetired,true);
});
test('pre-existing challenge is untouched and a no-child failure can retire known local IO',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts),file=f.stage+'/preimport-input-compatibility.json';f.write(file,Buffer.from('synthetic user data'));const p=createPreimportCompatibilityParent(cap,f.host);await assert.rejects(p.run());assert.equal(f.children.length,0);assert.equal(f.bytes(file).toString(),'synthetic user data');await p.joinFailedDirectRetirement();assert.equal(p.snapshot().failureRetired,true);
});
test('changed Node identity is rejected before launch and cannot be retried',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts);f.write('/tools/node',Buffer.from('changed'));const p=createPreimportCompatibilityParent(cap,f.host);await assert.rejects(p.run());assert.equal(f.children.length,0);await p.joinFailedDirectRetirement();await assert.rejects(p.run());
});

test('standard inert esbuild CJS export annotation is supported only for the exact callable mapping',()=>{
 const base="var __export=(x,y)=>{};var __toCommonJS=x=>x;var e={};__export(e,{createGateway:()=>createGateway});module.exports=__toCommonJS(e);require('ssh2');function createGateway(){}\n";
 assert.deepEqual(inspectPreimportTarget(Buffer.from(base+'0 && (module.exports = {createGateway});')),['ssh2']);
 for(const tail of ['1 && (module.exports = {createGateway});','0 && (module.exports = {wrong});','0 && (module.exports = {createGateway:other});','module.exports = {createGateway};'])assert.throws(()=>inspectPreimportTarget(Buffer.from(base+tail)));
 assert.throws(()=>inspectPreimportTarget(Buffer.from("require('ssh2');function createGateway(){}0 && (module.exports = {createGateway});")));
});

test('bound sanitized observer failure survives parent readback without granting success',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts);f.controls.failureEnvelope=true;const p=createPreimportCompatibilityParent(cap,f.host);await assert.rejects(p.run());assert.equal(p.snapshot().childFailure?.observer.inspectorFailure,'script-unadmitted');await p.joinFailedDirectRetirement();assert.equal(p.snapshot().completed,false);assert.equal(p.snapshot().failureRetired,true);
});

test('v5 parent/child source composition preserves the one fake Session without a fabricated child success receipt',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts);f.controls.sourceChild=true;const parent=createPreimportCompatibilityParent(cap,f.host),r=await parent.run();assert.equal(r.receipt.scope,'compatibility-only-no-factory-or-ownership-requested');assert.deepEqual(f.sourceFacts,{sessions:1,imports:1,factories:0,readyJoins:1});assert.equal(f.children.length,1);assert.equal(f.handles.size,0);
});

test('v5 end-to-end fake child fingerprints pinned async Wasm but rejects absent creator/context proof',async()=>{
 const f=await preimportPairMemory(),cap=await preparePreimportCompatibilityBuild(f.selection,f.buildPorts);f.controls.sourceChild=true;f.controls.sourceWasm=true;const parent=createPreimportCompatibilityParent(cap,f.host);await assert.rejects(parent.run());await parent.joinFailedDirectRetirement();const d=parent.snapshot().childFailure?.observer.wasmDiagnostic;assert.ok(d);assert.equal(d.matchesPinnedEmbeddedModule,true);assert.equal(d.creatorInStack,false);assert.notEqual(d.contextMatched,true);assert.equal(parent.snapshot().completed,false);assert.deepEqual(f.sourceFacts,{sessions:1,imports:1,factories:0,readyJoins:1});
});
