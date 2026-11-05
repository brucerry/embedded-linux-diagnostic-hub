import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { driverMemory } from './fixtures/instrumented-gateway-driver-memory';
import { createInstrumentedGatewayBootstrap,requireInstrumentedGatewayBootstrap } from '../scripts/lib/instrumented-gateway-bootstrap.mjs';
import { createInstrumentedGatewayDriver } from '../scripts/lib/instrumented-gateway-driver.mjs';
import { validateInstrumentedGatewayContext,instrumentedSetupCommand,instrumentedFailureSummary } from '../scripts/lib/instrumented-gateway-policy.mjs';
const pulse=async()=>{for(let i=0;i<500;i++)await Promise.resolve();};
const until=async(f:()=>boolean)=>{for(let i=0;i<20000&&!f();i++)await Promise.resolve();assert.ok(f(),'Expected bounded fake stage');};
const ordered=(s:string,a:string,b:string)=>{const first=s.indexOf(a),second=s.indexOf(b);assert.ok(first>=0&&second>first);};
test('actual source-bound pipeline prepares, installs, compiles, and admits the two children only once',async()=>{
    const f=driverMemory(),bootstrap=createInstrumentedGatewayBootstrap(f.selection,f.ports),b=await bootstrap.run();
    assert.deepEqual(f.calls.map(v=>v.role),['toolchain']);const driver=createInstrumentedGatewayDriver(b);assert.throws(()=>createInstrumentedGatewayDriver(b));
    const result=await driver.run();assert.deepEqual(f.calls.map(v=>v.role),['toolchain','dependencies','build','compatibility','ownership']);
    assert.equal(result.receipt.commands.length,3);assert.equal(result.receipt.releaseAcceptance,false);assert.equal(result.receipt.processGroupRetirement,null);assert.equal(result.receipt.rawCLIBehavior,null);assert.ok(result.bytes.length<=16384);
    assert.equal(f.handles.size,0);assert.equal(f.directories.size,0);await assert.rejects(bootstrap.run());await assert.rejects(driver.run());
});
test('changed production is rejected before any staging, installation or command',async()=>{
    const f=driverMemory({productionChange:true}),before=f.events.length,b=createInstrumentedGatewayBootstrap(f.selection,f.ports);await assert.rejects(b.run());assert.equal(f.events.length>before,true);assert.equal(f.calls.length,0);assert.equal(f.records.has('/project/validation'),false);
});
for(const existing of ['validation','node_modules'])test('existing '+existing+' is preserved before npm or new staging',async()=>{
    const f=driverMemory();f.write('/project/'+existing+'/existing',Buffer.from('synthetic user data'));const b=createInstrumentedGatewayBootstrap(f.selection,f.ports);await assert.rejects(b.run());assert.equal(f.calls.length,0);assert.equal(f.bytes('/project/'+existing+'/existing').toString(),'synthetic user data');
});
for(const role of ['toolchain','dependencies','build','compatibility','ownership'])test('failed '+role+' stops all later phases without retry',async()=>{
    const f=driverMemory();f.controls.fail=role;const b=createInstrumentedGatewayBootstrap(f.selection,f.ports);
    if(role==='toolchain')await assert.rejects(b.run());else{const driver=createInstrumentedGatewayDriver(await b.run());await assert.rejects(driver.run());await assert.rejects(driver.run());}
    assert.equal(f.calls.at(-1)!.role,role);assert.equal(f.calls.filter(v=>v.role===role).length,1);
});
for(const role of ['toolchain','dependencies','build'])test('wrong actual spawn identity during '+role+' fails closed',async()=>{
    const f=driverMemory();f.controls.wrongSpawn=role;const b=createInstrumentedGatewayBootstrap(f.selection,f.ports);
    if(role==='toolchain')await assert.rejects(b.run());else await assert.rejects(createInstrumentedGatewayDriver(await b.run()).run());assert.equal(f.calls.at(-1)!.role,role);
});
test('source mutation after acknowledged install prevents later command',async()=>{
    const f=driverMemory();f.controls.sourceChange='toolchain';await assert.rejects(createInstrumentedGatewayBootstrap(f.selection,f.ports).run());assert.deepEqual(f.calls.map(v=>v.role),['toolchain']);
});
test('Node change after install is not accepted as original admitted tool',async()=>{
    const f=driverMemory();f.controls.nodeChange='toolchain';await assert.rejects(createInstrumentedGatewayBootstrap(f.selection,f.ports).run());assert.equal(f.calls.length,1);
});
test('nested runtime package override is refused before either child',async()=>{
    const f=driverMemory();f.controls.nested=true;const b=await createInstrumentedGatewayBootstrap(f.selection,f.ports).run();await assert.rejects(createInstrumentedGatewayDriver(b).run());assert.equal(f.calls.some(v=>v.role==='compatibility'),false);
});
test('bad compatibility receipt cannot authorize ownership',async()=>{
    const f=driverMemory();f.controls.badCompatibility=true;const b=await createInstrumentedGatewayBootstrap(f.selection,f.ports).run();await assert.rejects(createInstrumentedGatewayDriver(b).run());assert.equal(f.calls.at(-1)!.role,'compatibility');
});
test('pending first child retains custody and delays ownership until actual close',async()=>{
    const f=driverMemory();f.controls.hold='compatibility';const b=await createInstrumentedGatewayBootstrap(f.selection,f.ports).run(),d=createInstrumentedGatewayDriver(b),task=d.run();await until(()=>f.children.some(v=>v.role==='compatibility'));await pulse();assert.equal(f.calls.at(-1)!.role,'compatibility');f.children.at(-1).finish();await task;assert.equal(f.calls.at(-1)!.role,'ownership');
});
test('install deadline reports failure with still-held direct child and no signals',async()=>{
    const f=driverMemory();f.controls.hold='toolchain';const b=createInstrumentedGatewayBootstrap(f.selection,f.ports),task=b.run(),rejected=assert.rejects(task);await until(()=>f.calls.length===1);f.expire();await rejected;assert.equal(b.snapshot().commands[0].directRetired,false);assert.equal(typeof f.children[0].kill,'undefined');
});
test('unsupported asynchronous native launch is observed and cannot be replayed',async()=>{
    const f=driverMemory();f.controls.unknownLaunch=true;const b=createInstrumentedGatewayBootstrap(f.selection,f.ports);await assert.rejects(b.run());await pulse();await assert.rejects(b.run());assert.equal(f.calls.length,1);
});
test('only the actual one-use acknowledged bootstrap grants the dependent driver',()=>{assert.throws(()=>requireInstrumentedGatewayBootstrap({}));assert.throws(()=>createInstrumentedGatewayDriver({}));});
test('fixed setup plans carry owned cache/config and official registry without lifecycle scripts/retries',()=>{
    const f=driverMemory();for(const role of ['toolchain','dependencies']){const args=instrumentedSetupCommand(f.selection,role);assert.ok(args.includes('--ignore-scripts')&&args.includes('--fetch-retries=0')&&args.includes('--registry=https://registry.npmjs.org'));assert.ok(args.some(s=>s.startsWith('--cache=/project/validation/gateway-ownership/')));assert.ok(!args.includes('--force'));}
});
test('unsupported service context fails before native IO',()=>{const f=driverMemory();for(const change of [(v:any)=>v.private=true,(v:any)=>v.attempt='2',(v:any)=>v.runner='self-hosted',(v:any)=>v.ref='refs/heads/main']){const v=structuredClone(f.selection.context);change(v);assert.throws(()=>validateInstrumentedGatewayContext(v));}});
test('failure summary omits arbitrary commands, inputs, paths and errors',()=>{
    const raw={phase:'bad secret',gitReads:2,pendingAbsence:0,commands:[{directRetired:true,command:'sensitive'}],files:{files:{pending:0,handles:1,uncertainPublications:0}},error:'do not emit'};
    const r=instrumentedFailureSummary('bootstrap',raw,null);assert.equal(r.status,'failed-or-held');assert.equal(r.fileHandles,1);assert.equal(r.directCommandsRetired,1);assert.ok(!JSON.stringify(r).includes('secret')&&!JSON.stringify(r).includes('sensitive')&&!JSON.stringify(r).includes('do not emit'));
});
test('containment workflow has one narrow job and no uploads/cache/secrets or broader triggers',()=>{
    const s=readFileSync(new URL('../.github/workflows/instrumented-gateway-diagnostic.yml',import.meta.url),'utf8');
    assert.ok(s.includes('branches: [ci/gateway-wasm299-96a56cd-20261105]')&&s.includes('timeout-minutes: 20')&&s.includes("node-version: '24.22.0'"));
    assert.equal((s.match(/^    instrumented_gateway:/gm)||[]).length,1);assert.ok(s.includes('contents: read')&&s.includes('cancel-in-progress: false'));
    assert.ok(!/workflow_dispatch:|workflow_run:|pull_request:|upload-artifact@|actions\/cache@|secrets\.|write-all|continue-on-error|npm ci/.test(s));
    assert.ok(s.includes('node .github/instrumented-gateway-entry.mjs'));
    assert.ok(s.includes("if: github.repository == 'brucerry/embedded-linux-diagnostic-hub'")&&s.includes('github.run_attempt == 1'));assert.ok(!s.includes('if: ${{ false &&'));
});
test('preliminary file custody is covered before first native IO and retained in sanitized failures',()=>{
    const text=readFileSync(new URL('../.github/instrumented-gateway-entry.mjs',import.meta.url),'utf8');
    ordered(text,'validateInstrumentedGatewayContext(','hold=setInterval(');ordered(text,'hold=setInterval(','const root=await owned.filesystem.realpath');
    assert.throws(()=>ordered(text.replace('validateInstrumentedGatewayContext(',''),'validateInstrumentedGatewayContext(','hold=setInterval('));
    assert.throws(()=>ordered(text.replace('hold=setInterval(',''),'hold=setInterval(','const root=await owned.filesystem.realpath'));
    const r=instrumentedFailureSummary('initial-files',null,null,{pending:1,handles:1,uncertainPublications:0});assert.equal(r.fileHandles,1);assert.equal(r.filePending,1);assert.equal(r.stage,'initial-files');
});

test('pre-install native/bootstrap static import graph requires builtins only; dependent driver load follows actual bootstrap',()=>{
    const seen=new Set<string>();
    function walk(url:URL,mutate=false){const key=url.href;if(seen.has(key))return;seen.add(key);let source=readFileSync(url,'utf8');
        if(mutate&&key.endsWith('/instrumented-gateway-bootstrap.mjs'))source+="\nimport bad from 'semver';";
        const tree=ts.createSourceFile(key,source,ts.ScriptTarget.Latest,true);
        for(const statement of tree.statements){if((ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement))&&statement.moduleSpecifier){assert.ok(ts.isStringLiteral(statement.moduleSpecifier));const spec=(statement.moduleSpecifier as any).text;
            if(spec.startsWith('node:'))continue;assert.ok(spec.startsWith('.'),'Pre-install external import '+spec);walk(new URL(spec,url),mutate);}}
    }
    const entry=new URL('../.github/instrumented-gateway-entry.mjs',import.meta.url);walk(entry);assert.ok(seen.size>=10);seen.clear();assert.throws(()=>walk(entry,true));
    const source=readFileSync(entry,'utf8');ordered(source,'await bootstrapOwner.run()',"await import('../scripts/lib/instrumented-gateway-driver.mjs')");
    assert.throws(()=>ordered(source.replace('await bootstrapOwner.run()',''),'await bootstrapOwner.run()',"await import('../scripts/lib/instrumented-gateway-driver.mjs')"));
});

test('actual asynchronous source provider with fake Git covers all eleven full source observations within frozen-source budget',async(t)=>{
    const f=driverMemory({actualGit:true}),admission=await createInstrumentedGatewayBootstrap(f.selection,f.ports).run();
    const result=await createInstrumentedGatewayDriver(admission).run();
    assert.ok(f.gitCalls.length>256&&f.gitCalls.length<=1024);assert.equal(result.receipt.gitReads,f.gitCalls.length);t.diagnostic('Synthetic actual-provider Git dispatch count: '+f.gitCalls.length+'; all eleven full observations retained.');
    assert.equal(f.gitCalls.filter(v=>v.tail.join(' ')==='rev-parse --verify HEAD').length,33);
    assert.deepEqual(f.calls.map(v=>v.role),['toolchain','dependencies','build','compatibility','ownership']);assert.equal(f.handles.size,0);assert.equal(f.directories.size,0);
});

test('binary-inclusive driver pipeline reaches both fake children without broadening Inspector admission',async()=>{
    const f=driverMemory();f.controls.binary=true;const b=await createInstrumentedGatewayBootstrap(f.selection,f.ports).run();const d=createInstrumentedGatewayDriver(b);
    const result=await d.run();assert.deepEqual(f.calls.map(v=>v.role),['toolchain','dependencies','build','compatibility','ownership']);assert.equal(result.receipt.releaseAcceptance,false);
});
for(const kind of ['census','build','dependencies'])test('bounded failure codes distinguish '+kind+' without losing original cause or custody',async()=>{
    const f=driverMemory();if(kind==='census')f.controls.badCensus=true;else f.controls.fail=kind;
    const b=createInstrumentedGatewayBootstrap(f.selection,f.ports),d=createInstrumentedGatewayDriver(await b.run());
    await assert.rejects(d.run(),(e:any)=>{assert.ok(e.cause);return true;});
    const r=instrumentedFailureSummary('driver',b.snapshot(),d.snapshot());
    assert.equal(r.schema,'instrumented-gateway-failure-counters-v8');assert.equal(r.driverPhase,kind);assert.equal(r.releaseAcceptance,false);assert.equal(r.processGroupRetirement,null);
    assert.equal(r.censusPhase,kind==='census'?'file-identity':null);assert.equal(r.preparationPhase,kind==='census'?'snapshot':kind==='build'?'building':null);
    assert.equal(r.parentLaunches,null);assert.ok(Buffer.byteLength(JSON.stringify(r))<1024);assert.equal(f.calls.some(v=>v.role==='compatibility'),false);
});
test('failure phase codes are closed enums, never arbitrary paths or error strings',()=>{
    const r=instrumentedFailureSummary('driver',null,{failedAt:'/private/path',preparationPhase:'sensitive error',censusPhase:'command output'});
    assert.equal(r.driverPhase,null);assert.equal(r.preparationPhase,null);assert.equal(r.censusPhase,null);
    assert.ok(!JSON.stringify(r).includes('private')&&!JSON.stringify(r).includes('sensitive')&&!JSON.stringify(r).includes('command output'));
});

for(const held of [false,true])test('failed diagnostic direct retirement joins actual child pipes '+held,async()=>{
 const f=driverMemory();f.controls.hold='compatibility';const b=await createInstrumentedGatewayBootstrap(f.selection,f.ports).run(),d=createInstrumentedGatewayDriver(b),run=d.run(),rejected=assert.rejects(run);await until(()=>f.children.some(v=>v.role==='compatibility'));const child=f.children.at(-1);
 child.emit('error',Error('authored failed-child diagnostic'));child.emit('exit',1,null);child.emit('close',1,null);if(!held){child.stdout.emit('close');child.stderr.emit('close');}await rejected;let done=false;const joining=d.joinFailedDirectRetirement().then(()=>{done=true;});await pulse();assert.equal(done,!held);if(held){child.stdout.emit('close');child.stderr.emit('close');}await joining;assert.equal(done,true);assert.equal(f.calls.filter(v=>v.role==='compatibility').length,1);assert.equal(f.calls.filter(v=>v.role==='ownership').length,0);await assert.rejects(d.joinFailedDirectRetirement());
});
