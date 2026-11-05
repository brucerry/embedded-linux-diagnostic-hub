import test from 'node:test';
import assert from 'node:assert/strict';
import {isBuiltin} from 'node:module';
import {createPreimportNativeBootstrap,requirePreimportNativeAdmission} from '../scripts/lib/preimport-native-bootstrap.mjs';
import {createParentPackageGuard,admitParentPackages,parentPackageReference} from '../scripts/lib/preimport-package-admission.mjs';
import {createPreimportExecution} from '../scripts/lib/preimport-execution.mjs';
import {nativePreimportMemory} from './fixtures/preimport-native-memory';

test('native admission composes exact four commands and one compatibility child in memory',async()=>{
    const f=await nativePreimportMemory(),bootstrap=createPreimportNativeBootstrap(f.selection,f.ports),loaded=await bootstrap.run(),driver=loaded.create(loaded.admission);
    assert.throws(()=>createPreimportExecution(loaded.admission));const result=await driver.run();assert.equal(result.receipt.releaseAcceptance,false);assert.equal(result.receipt.ownershipContinuation,false);assert.equal(result.receipt.parentLoadedCodeIdentity,null);assert.equal(result.receipt.compatibility.normalChildAndPipesClosed,true);assert.equal(result.receipt.childDeadlineMs,55000);assert.equal(result.receipt.parentDeadlineMs,60000);
    assert.deepEqual(f.calls.map(v=>v.role),['toolchain','dependencies','build','build','compatibility']);assert.equal(f.facts.cacheChecks,1);assert.equal(f.facts.loads,1);assert.equal(f.children.length,1);assert.equal(f.handles.size,0);assert.equal(f.directories.size,0);assert.equal(bootstrap.snapshot().commandIndex,4);assert.ok(result.bytes.length<=16384);driver.closeGuard();await assert.rejects(driver.run());
});
test('source mismatch is rejected before staging or installs',async()=>{const f=await nativePreimportMemory();f.controls.badSource=true;const b=createPreimportNativeBootstrap(f.selection,f.ports);await assert.rejects(b.run());assert.equal(f.calls.length,0);assert.equal(f.records.has('/project/validation'),false);});
test('preexisting staging is preserved rather than adopted or removed',async()=>{const f=await nativePreimportMemory();f.write('/project/validation/user.txt',Buffer.from('keep'));await assert.rejects(createPreimportNativeBootstrap(f.selection,f.ports).run());assert.equal(f.bytes('/project/validation/user.txt').toString(),'keep');assert.equal(f.calls.length,0);});
for(const [label,field,value]of [['changed','packageChange','semver/index.js'],['missing','omit','typescript/lib/typescript.js'],['preloaded','cache',true]] as const)test('parent package '+label+' fails before driver import',async()=>{const f=await nativePreimportMemory();f.controls[field]=value;const b=createPreimportNativeBootstrap(f.selection,f.ports);await assert.rejects(b.run());assert.equal(f.facts.loads,0);assert.deepEqual(f.calls.map(v=>v.role),['toolchain']);if(field==='cache')await assert.rejects(b.joinKnownFailure());});
test('rejected dynamic import remains uncertain and cannot acknowledge retirement',async()=>{const f=await nativePreimportMemory();f.controls.loadFailure=true;const b=createPreimportNativeBootstrap(f.selection,f.ports);await assert.rejects(b.run());assert.equal(b.snapshot().loaderUncertain,true);await assert.rejects(b.joinKnownFailure());assert.equal(f.facts.loads,1);});
test('acknowledged failed installer can join direct custody without a compatibility launch',async()=>{const f=await nativePreimportMemory();f.controls.fail='dependencies';const b=createPreimportNativeBootstrap(f.selection,f.ports),loaded=await b.run(),driver=loaded.create(loaded.admission);await assert.rejects(driver.run());await driver.joinFailedDirectRetirement();assert.equal(f.children.length,0);assert.equal(b.snapshot().commands.every(v=>v.directRetired),true);});
test('post-install parent package mutation blocks builds',async()=>{const f=await nativePreimportMemory();f.controls.mutate='dependencies';const b=createPreimportNativeBootstrap(f.selection,f.ports),loaded=await b.run(),driver=loaded.create(loaded.admission);await assert.rejects(driver.run());assert.deepEqual(f.calls.map(v=>v.role),['toolchain','dependencies']);});
test('installed package aliases and extra files fail closed',async()=>{for(const mode of ['alias','extra']){const f=await nativePreimportMemory();f.installPackages();if(mode==='alias')f.records.get('/project/node_modules/semver/index.js').nlink=2;else f.write('/project/node_modules/semver/extra.js',Buffer.from('wrong'));await assert.rejects(admitParentPackages('/project',1000,JSON.parse(f.files.get('package-lock.json')!.toString()),f.host.filesystem));}});
test('parent resolver never falls back to ancestors and rejects uncertain acknowledgements',()=>{
    const rows=[{path:'scripts/lib/preimport-execution.mjs'}],packages={entries:{typescript:'/project/node_modules/typescript/lib/typescript.js'},allowed:['/project/node_modules/typescript/lib/typescript.js']};let hook:any;
    const guard=createParentPackageGuard('/project',rows,packages,{registerHooks(h:any){hook=h;return{deregister(){}};},isBuiltin,onFailure(){}}),context={parentURL:'file:///project/scripts/lib/preimport-execution.mjs'};
    assert.equal(hook.resolve('typescript',context,()=>{throw Error('ancestor');}).url,'file:///project/node_modules/typescript/lib/typescript.js');assert.throws(()=>hook.resolve('missing-optional',context,()=>{throw Error('ancestor');}));assert.equal(guard.snapshot().failed,true);
    let other:any;const held=createParentPackageGuard('/project',rows,packages,{registerHooks(h:any){other=h;return{deregister(){}};},isBuiltin,onFailure(){}});assert.throws(()=>other.resolve('./other.mjs',context,()=>({then(){}})));assert.equal(held.snapshot().uncertain,true);assert.equal(held.snapshot().inFlight,1);assert.throws(()=>held.prepareClose(true));
});
test('resolver registration reentrancy cannot return a usable guard',()=>{assert.throws(()=>createParentPackageGuard('/project',[],{entries:{},allowed:[]},{registerHooks(h:any){try{h.resolve('node:assert',{parentURL:'file:///wrong'},()=>({url:'node:assert'}));}catch{}return{deregister(){}};},isBuiltin,onFailure(){}}));});
test('reference is explicitly file consistency, not independent registry provenance',()=>{const ref=parentPackageReference();assert.equal(ref.origin,'existing-installed-reference-matching-source-lock-not-independent-registry-attestation');assert.equal(ref.packages.length,4);assert.equal(ref.packages.reduce((n,p)=>n+p.files.length,0),195);});

import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {startInstrumentedChildOutput} from '../scripts/lib/instrumented-gateway-output.mjs';
import {releasePreimportRoot} from '../scripts/lib/preimport-root-retirement.mjs';
import {preimportNativeContext} from '../scripts/lib/preimport-native-policy.mjs';
for(const mode of ['success','late-error','late-unknown','join-late-error'])test('root fence output acknowledgement '+mode,async()=>{
    const stream:any=new EventEmitter(),hold={},cleared:any[]=[];stream.write=(_b:Buffer,cb:Function)=>{cb();return true;};
    const output=startInstrumentedChildOutput(Buffer.from('fixed sanitized receipt'),stream,()=>mode==='late-unknown'?Promise.resolve():undefined);
    if(mode.startsWith('late-'))Promise.resolve().then(()=>stream.emit('error',Error('late')));
    const joining=mode==='join-late-error'?async()=>{stream.emit('error',Error('during join'));}:null;
    const result=releasePreimportRoot(output,hold,(v:any)=>{cleared.push(v);},joining);
    if(mode==='success'){await result;assert.deepEqual(cleared,[hold]);}else{await assert.rejects(result);assert.equal(cleared.length,0);}
});
test('real parent driver static closure requires only admitted TS and semver packages',()=>{
    const root=new URL('../',import.meta.url),seen=new Set<string>(),bare=new Set<string>();
    function walk(file:string){if(seen.has(file))return;seen.add(file);assert.ok(seen.size<80);const text=readFileSync(new URL(file,root),'utf8'),tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
        for(const row of tree.statements)if((ts.isImportDeclaration(row)||ts.isExportDeclaration(row))&&row.moduleSpecifier){const spec=(row.moduleSpecifier as any).text;if(spec.startsWith('node:'))continue;if(!spec.startsWith('.')){bare.add(spec);continue;}const next=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec));assert.ok(next.startsWith('scripts/lib/'));walk(next);}
    }
    walk('scripts/lib/preimport-execution.mjs');assert.deepEqual([...bare].sort(),['semver','typescript']);assert.equal(seen.has('scripts/lib/web-archive-producer.mjs'),false);
});
test('native entry and isolated workflow preserve exact branch, one child and no upload',async()=>{
    const f=await nativePreimportMemory(),context=f.selection.context;assert.deepEqual(preimportNativeContext(context),context);for(const change of [{attempt:'2'},{job:'instrumented_gateway'},{private:true},{ref:'refs/heads/main'},{runner:'self-hosted'}])assert.throws(()=>preimportNativeContext({...context,...change}));
    const native=readFileSync(new URL('../.github/preimport-native-entry.mjs',import.meta.url),'utf8'),workflow=readFileSync(new URL('../.github/workflows/preimport-compatibility.yml',import.meta.url),'utf8');
    assert.ok(native.includes('releasePreimportRoot(outputOwner,hold'));assert.ok(native.includes('loadDriver:file=>import(pathToFileURL(file).href)'));assert.ok(!native.includes('process.exit(')&&!native.includes('.kill(')&&!native.includes('rm('));
    for(const expected of ['branches: [ci/gateway-preimport304-96a56cd-20261105]','timeout-minutes: 20','contents: read','cancel-in-progress: false',"node-version: '24.22.0'",'131eee431eb7bd6a5a999501f7a60d53c272b2ce','node .github/preimport-native-entry.mjs','cache: false'])assert.ok(workflow.includes(expected),expected);
    assert.equal((workflow.match(/runs-on:/g)||[]).length,1);assert.ok(!workflow.includes('upload-artifact@')&&!workflow.includes('actions/cache@')&&!workflow.includes('secrets.')&&!workflow.includes('workflow_dispatch:'));
});
test('post-parent validation failure can join acknowledged completed child custody',async()=>{const f=await nativePreimportMemory();f.controls.postParentMutation=true;const b=createPreimportNativeBootstrap(f.selection,f.ports),loaded=await b.run(),driver=loaded.create(loaded.admission);await assert.rejects(driver.run());assert.equal(driver.snapshot().parent?.completed,true);await driver.joinFailedDirectRetirement();assert.equal(b.snapshot().commands.every(v=>v.directRetired),true);});

test('failed verification before command dispatch can join without inventing a child',async()=>{const f=await nativePreimportMemory(),bootstrap=createPreimportNativeBootstrap(f.selection,f.ports),loaded=await bootstrap.run(),b=requirePreimportNativeAdmission(loaded.admission);f.write(f.selection.nodePath,Buffer.from('changed Node'));const {instrumentedSetupCommand}=await import('../scripts/lib/instrumented-gateway-policy.mjs');await assert.rejects(b.execute(Object.freeze({owner:'a'.repeat(32),id:2,role:'install',cwd:f.installed,command:Object.freeze(instrumentedSetupCommand(f.selection,'dependencies'))})));assert.equal(bootstrap.snapshot().commands[1].acquisitionPending,false);assert.equal(bootstrap.snapshot().commands[1].verificationSettled,true);await b.joinKnownFailure();assert.deepEqual(f.calls.map(v=>v.role),['toolchain']);});
