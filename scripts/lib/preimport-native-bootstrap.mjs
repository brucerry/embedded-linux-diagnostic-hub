import assert from 'node:assert/strict';
import path from 'node:path';
import {constants} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createOwnedWebCapabilities, webChildEnvironments } from './owned-web-capabilities.mjs';
import { ownedGitRequestKind } from './owned-git-read.mjs';
import { observeSourceBridge, sourceDigest } from './committed-source-bridge.mjs';
import { readStableArtifactFile } from './stable-artifact-file.mjs';
import { assertInstrumentedProductionBridge, INSTRUMENTED_ENTRY } from './instrumented-gateway-source.mjs';
import { instrumentedSetupCommand, absolute } from './instrumented-gateway-policy.mjs';
import { startDiagnosticGatewayCommand } from './diagnostic-gateway-command.mjs';

import {types} from 'node:util';
import {preimportNativeContext} from './preimport-native-policy.mjs';
import {admitParentPackages,createParentPackageGuard} from './preimport-package-admission.mjs';
const admissions=new WeakMap(),retained=new Set();
export function requirePreimportNativeAdmission(value){const record=admissions.get(value);assert.ok(record&&!record.used,'Actual one-use native preimport admission required.');record.used=true;return record.value;}

/** Builtins-only bootstrap: freeze actual source before any staging/npm writes. No driver/package
 * imports occur until this one-use admission exists. No signals, retries, deletion or native defaults.
 */
export function createPreimportNativeBootstrap(selection,ports){
    const s=structuredClone(selection),context=preimportNativeContext(s.context);
    assert.deepEqual(Object.keys(s).sort(),['context','gitPath','gitSHA256','nodePath','nodeSHA256','npmPackageSHA256','npmPath','npmSHA256','root','runtime']);
    for(const k of ['root','gitPath','nodePath','npmPath'])absolute(s[k]);assert.equal(s.gitPath,'/usr/bin/git');assert.equal(s.npmPath,path.dirname(path.dirname(s.nodePath))+'/lib/node_modules/npm/bin/npm-cli.js');
    for(const k of ['gitSHA256','nodeSHA256','npmSHA256','npmPackageSHA256'])assert.match(s[k],/^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(s.runtime).sort(),['arch','execArgv','execPath','nodeOptions','nodePathVariable','platform','uid','version']);
    assert.equal(s.runtime.platform,'linux');assert.equal(s.runtime.arch,'x64');assert.equal(s.runtime.version,'v24.22.0');assert.equal(s.runtime.execPath,s.nodePath);
    assert.deepEqual(s.runtime.execArgv,[]);assert.equal(s.runtime.nodeOptions,null);assert.equal(s.runtime.nodePathVariable,null);assert.ok(Number.isSafeInteger(s.runtime.uid)&&s.runtime.uid>0);
    ports=Object.freeze({...ports});for(const k of ['sourceFactory','launch','setTimer','clearTimer','now','assertPackageCacheEmpty','registerHooks','isBuiltin','onLoaderFailure','loadDriver'])assert.equal(typeof ports[k],'function');
    const stage=s.root+'/validation/gateway-ownership',root=stage+'/instrumented',esbuildPath=s.root+'/node_modules/esbuild/bin/esbuild';
    for(const p of [root+'/ownership.cjs',esbuildPath,stage+'/config/global.npmrc',stage+'/toolchain-cache',s.root+'/'+INSTRUMENTED_ENTRY])absolute(p);
    const environment={PATH:path.dirname(s.nodePath)+':/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC'},profile=webChildEnvironments(environment);
    let phase='prepared',started=false,failed=false,gitReads=0,pendingAbsence=0,commandIndex=0,guard,packages,loaderUncertain=false;let provider,bridge,sourceFile,stableSource;const selected={sourceCommit:context.sha,sourceTree:context.tree};const commands=[],acks=[];
    const metadataAllowed=p=>typeof p==='string'&&(p===s.root||p.startsWith(s.root+'/')||[s.nodePath,s.gitPath,s.npmPath,path.dirname(s.nodePath),path.dirname(s.gitPath),path.dirname(s.npmPath),path.dirname(path.dirname(s.npmPath)),path.dirname(path.dirname(s.npmPath))+'/package.json'].includes(p));
    const writePaths=new Set([stage+'/config/user.npmrc',stage+'/config/global.npmrc',...['package.json','package-lock.json','activate.cjs','resolution-guard.cjs'].map(p=>root+'/'+p)]),directories=new Set([s.root+'/validation',stage,stage+'/config',stage+'/toolchain-cache',stage+'/runtime-cache',root]);
    const scoped={...ports.filesystem,realpath:p=>{assert.ok(metadataAllowed(p));return ports.filesystem.realpath(p);},lstat:p=>{assert.ok(metadataAllowed(p));return ports.filesystem.lstat(p);},opendir:p=>{assert.ok(p===s.root||p.startsWith(s.root+'/'));return ports.filesystem.opendir(p);},mkdir:p=>{assert.ok(directories.has(p));return ports.filesystem.mkdir(p);},open(p,flags){assert.ok(metadataAllowed(p));if(flags&constants.O_CREAT)assert.ok(writePaths.has(p));return ports.filesystem.open(p,flags);}};
    const cap=createOwnedWebCapabilities({gitPath:s.gitPath,gitSHA256:s.gitSHA256,environment},{...ports,filesystem:scoped,launch(file,args,options){
        assert.equal(file,s.gitPath);assert.equal(options.cwd,s.root);assert.equal(options.shell,false);assert.deepEqual(options.env,profile.git);assert.deepEqual(options.stdio,[ownedGitRequestKind(args)==='batch'?'pipe':'ignore','pipe','pipe']);assert.ok(++gitReads<=1024);return ports.launch(file,args,options);
    }}),filesystem=cap.filesystem;
    const read=async(file,maximum)=>(await readStableArtifactFile(path.dirname(file),path.basename(file),maximum,filesystem)).bytes;
    async function verifyTools(){
        const node=await read(s.nodePath,128*1024**2),npm=await read(s.npmPath,1024**2),pkg=await read(path.dirname(path.dirname(s.npmPath))+'/package.json',1024**2);
        assert.equal(sourceDigest(node),s.nodeSHA256);assert.equal(sourceDigest(npm),s.npmSHA256);assert.equal(sourceDigest(pkg),s.npmPackageSHA256);
        const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pkg));assert.equal(value.name,'npm');assert.equal(value.bin.npm,'bin/npm-cli.js');assert.match(value.version,/^[0-9]+\.[0-9]+\.[0-9]+$/);cap.assertSettled();return value.version;
    }
    function queryAbsence(file){
        assert.ok([s.root+'/validation',s.root+'/node_modules',root+'/ownership.cjs',root+'/preimport.mjs',stage+'/target-meta.json',stage+'/preimport-meta.json'].includes(file));pendingAbsence++;
        let query;try{query=ports.filesystem.lstat(file);assert.ok(types.isPromise(query));}catch(error){throw error;}
        const observed=Promise.prototype.then.call(query,value=>{pendingAbsence--;return value;},error=>{pendingAbsence--;throw error;});observed.catch(()=>{});return observed;
    }
    async function absent(file){try{await queryAbsence(file);}catch(error){assert.equal(error?.code,'ENOENT');return;}assert.fail('Pre-existing namespace cannot be adopted or removed.');}
    async function stablePackages(){if(packages){const actual=await admitParentPackages(s.root,s.runtime.uid,JSON.parse((await sourceFile('package-lock.json')).toString()),filesystem);assert.deepEqual(actual.files,packages.files);assert.equal(actual.sha256,packages.sha256);guard?.assertActive();}}
    async function command(plan){
        assert.equal(failed,false);assert.ok(commandIndex<4);assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.command));
        assert.deepEqual(Object.keys(plan).sort(),['command','cwd','id','owner','role']);assert.match(plan.owner,/^[a-f0-9]{32}$/);
        const index=commandIndex,allowed=index===0?instrumentedSetupCommand(s,'toolchain'):index===1?instrumentedSetupCommand(s,'dependencies'):
            index===2?[s.nodePath,esbuildPath,s.root+'/tests/fixtures/instrumented-gateway-preimport-target.ts','--bundle','--platform=node','--format=cjs','--tree-shaking=false','--outfile='+root+'/ownership.cjs','--metafile='+stage+'/target-meta.json','--external:ssh2']:[s.nodePath,esbuildPath,s.root+'/tests/fixtures/instrumented-gateway-preimport-entry.mjs','--bundle','--platform=node','--format=esm','--tree-shaking=false','--outfile='+root+'/preimport.mjs','--metafile='+stage+'/preimport-meta.json'];
        assert.equal(plan.role,index>=2?'build':'install');assert.equal(plan.id,index===1?2:1);
        assert.equal(plan.cwd,index===1?root:s.root);assert.deepEqual(plan.command,allowed);const expected=allowed,env={...environment,NODE_ENV:index===0?'development':'production'};
        if(index)assert.equal(commands[index-1].owner.snapshot().directRetired,true);
        commandIndex++; // Before awaited verification/acquisition; no arbitrary expected-command grant.
        const lease={owner:null,dispatchAttempted:false,verificationSettled:false};commands.push(lease);try{await verifyTools();await stablePackages();lease.verificationSettled=true;lease.dispatchAttempted=true;
        const actual=startDiagnosticGatewayCommand(plan,env,{...ports,requireSpawnIdentity:true,launch(file,args,options){assert.equal(file,expected[0]);assert.deepEqual(args,expected.slice(1));assert.deepEqual(options,{cwd:plan.cwd,env,shell:false,stdio:['ignore','pipe','pipe']});return ports.launch(file,args,options);}});lease.owner=actual;
        const ack=await actual.result;await actual.closed;assert.equal(actual.snapshot().directRetired,true);await verifyTools();await stablePackages();acks.push({role:plan.role,id:plan.id,sha256:sourceDigest(JSON.stringify(ack))});return ack;}catch(error){lease.verificationSettled=true;failed=true;throw error;}
    }
    function assertPostBuildDirectSettled(){assert.equal(loaderUncertain,false);guard.assertActive();assert.equal(phase,'ready');assert.equal(pendingAbsence,0);assert.equal(commandIndex,4);assert.equal(acks.length,4);for(const c of commands)assert.equal(c.owner?.snapshot().directRetired,true);cap.assertSettled();}
    const snapshot=()=>({phase,started,failed,gitReads,pendingAbsence,commandIndex,loaderUncertain,guard:guard?.snapshot()??null,parentPackageReferenceSHA256:packages?.referenceSHA256??null,parentPackageObservationSHA256:packages?.sha256??null,commands:commands.map(v=>v.owner?v.owner.snapshot():{acquisitionPending:v.dispatchAttempted,verificationSettled:v.verificationSettled}),files:cap.snapshot(),processGroupRetirement:null,releaseAcceptance:false});
    const owner=Object.freeze({snapshot,async joinKnownFailure(){assert.ok(failed&&!loaderUncertain&&pendingAbsence===0);for(const row of commands){if(!row.dispatchAttempted){assert.equal(row.verificationSettled,true);assert.equal(row.owner,null);continue;}assert.ok(row.owner);await row.owner.closed;assert.equal(row.owner.snapshot().directRetired,true);assert.equal(row.owner.snapshot().unknownOperations,0);}cap.assertSettled();if(guard){guard.prepareClose(true);guard.assertClose();}retained.delete(owner);},async run(){
        assert.equal(started,false);started=true;phase='source';retained.add(owner);
        try{
            const npmVersion=await verifyTools();provider=await ports.sourceFactory(s.root,{filesystem,executeGit:cap.executeGit,gitEnvironment:cap.gitEnvironment});
            bridge=await observeSourceBridge(selected,provider);assertInstrumentedProductionBridge(bridge);cap.assertSettled();
            sourceFile=async p=>{const value=await provider.file(p),row=bridge.inventory.find(v=>v.path===p);assert.ok(row);assert.equal(value.mode,row.mode);assert.equal(value.bytes.length,row.bytes);assert.equal(sourceDigest(value.bytes),row.sha256);return Buffer.from(value.bytes);};
            const lock=JSON.parse((await sourceFile('package-lock.json')).toString('utf8'));
            for(const value of Object.values(lock.packages)){if(value.resolved){const url=new URL(value.resolved);assert.equal(url.protocol,'https:');assert.equal(url.hostname,'registry.npmjs.org');assert.ok(!url.username&&!url.password&&!url.port&&!url.search&&!url.hash);assert.match(value.integrity,/^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/);}}
            stableSource=async()=>{assert.deepEqual(await observeSourceBridge(selected,provider),bridge);cap.assertSettled();await stablePackages();};
            await absent(s.root+'/validation');await absent(s.root+'/node_modules');phase='staging';
            for(const p of [s.root+'/validation',stage,stage+'/config',stage+'/toolchain-cache',stage+'/runtime-cache'])await filesystem.mkdir(p);
            for(const name of ['user','global'])await filesystem.writeFile(stage+'/config/'+name+'.npmrc',Buffer.alloc(0),{flag:'wx'});cap.assertSettled();
            phase='toolchain';await absent(s.root+'/node_modules');await stableSource();
            const args=instrumentedSetupCommand(s,'toolchain');await command(Object.freeze({owner:randomBytes(16).toString('hex'),id:1,role:'install',cwd:s.root,command:Object.freeze(args)}));
            await stableSource();phase='parent-packages';packages=await admitParentPackages(s.root,s.runtime.uid,lock,filesystem);
            loaderUncertain=true;const cache=ports.assertPackageCacheEmpty([...packages.allowed]);assert.equal(cache,undefined);
            guard=createParentPackageGuard(s.root,bridge.inventory,packages,{registerHooks:ports.registerHooks,isBuiltin:ports.isBuiltin,onFailure:ports.onLoaderFailure});guard.assertActive();
            phase='driver-load';const loading=ports.loadDriver(s.root+'/scripts/lib/preimport-execution.mjs');assert.ok(types.isPromise(loading));const loaded=await loading;
            assert.deepEqual(Object.keys(loaded),['createPreimportExecution']);const descriptor=Object.getOwnPropertyDescriptor(loaded,'createPreimportExecution');assert.ok(descriptor&&Object.hasOwn(descriptor,'value')&&typeof descriptor.value==='function');
            await stableSource();guard.assertActive();assert.ok(guard.snapshot().resolutions>0);loaderUncertain=false;
            const closeGuard=allowFailure=>{assert.equal(loaderUncertain,false);guard.prepareClose(allowFailure);guard.assertClose();};
            const value=Object.freeze({s,context,stage,root,esbuildPath,environment,ports,cap,filesystem,read,verifyTools,execute:command,queryAbsence,acks,sourceFile,stableSource,bridge,provider,selected,npmVersion,snapshot,assertPostBuildDirectSettled,closeGuard,packages,markFailure(){failed=true;},async joinKnownFailure(){await owner.joinKnownFailure();}});
            const admission=Object.freeze({});admissions.set(admission,{value,used:false});phase='ready';retained.delete(owner);return Object.freeze({admission,create:descriptor.value});

        }catch(error){failed=true;phase='failed';throw Object.assign(Error('Instrumented bootstrap failed or remains held.',{cause:error}),{owner});}
    }});return owner;
}
