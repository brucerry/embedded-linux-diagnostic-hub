import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createOwnedWebCapabilities, webChildEnvironments } from './owned-web-capabilities.mjs';
import { ownedGitRequestKind } from './owned-git-read.mjs';
import { observeSourceBridge, sourceDigest } from './committed-source-bridge.mjs';
import { readStableArtifactFile } from './stable-artifact-file.mjs';
import { assertInstrumentedProductionBridge, INSTRUMENTED_ENTRY } from './instrumented-gateway-source.mjs';
import { validateInstrumentedGatewayContext, instrumentedSetupCommand, absolute } from './instrumented-gateway-policy.mjs';
import { startDiagnosticGatewayCommand } from './diagnostic-gateway-command.mjs';

const admissions=new WeakSet(),retained=new Set();
export function requireInstrumentedGatewayBootstrap(value){assert.ok(value&&admissions.has(value),'Actual acknowledged bootstrap required.');admissions.delete(value);return value;}
/** Builtins-only bootstrap: freeze actual source before any staging/npm writes. No driver/package
 * imports occur until this one-use admission exists. No signals, retries, deletion or native defaults.
 */
export function createInstrumentedGatewayBootstrap(selection,ports){
    const s=structuredClone(selection),context=validateInstrumentedGatewayContext(s.context);
    assert.deepEqual(Object.keys(s).sort(),['context','gitPath','gitSHA256','nodePath','nodeSHA256','npmPackageSHA256','npmPath','npmSHA256','root','runtime']);
    for(const k of ['root','gitPath','nodePath','npmPath'])absolute(s[k]);assert.equal(s.gitPath,'/usr/bin/git');assert.equal(s.npmPath,path.dirname(path.dirname(s.nodePath))+'/lib/node_modules/npm/bin/npm-cli.js');
    for(const k of ['gitSHA256','nodeSHA256','npmSHA256','npmPackageSHA256'])assert.match(s[k],/^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(s.runtime).sort(),['arch','execArgv','execPath','nodeOptions','nodePathVariable','platform','uid','version']);
    assert.equal(s.runtime.platform,'linux');assert.equal(s.runtime.arch,'x64');assert.equal(s.runtime.version,'v24.22.0');assert.equal(s.runtime.execPath,s.nodePath);
    assert.deepEqual(s.runtime.execArgv,[]);assert.equal(s.runtime.nodeOptions,null);assert.equal(s.runtime.nodePathVariable,null);assert.ok(Number.isSafeInteger(s.runtime.uid)&&s.runtime.uid>0);
    ports=Object.freeze({...ports});for(const k of ['sourceFactory','launch','setTimer','clearTimer','now'])assert.equal(typeof ports[k],'function');
    const stage=s.root+'/validation/gateway-ownership',root=stage+'/instrumented',esbuildPath=s.root+'/node_modules/esbuild/bin/esbuild';
    for(const p of [root+'/ownership.cjs',esbuildPath,stage+'/config/global.npmrc',stage+'/toolchain-cache',s.root+'/'+INSTRUMENTED_ENTRY])absolute(p);
    const environment={PATH:path.dirname(s.nodePath)+':/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC'},profile=webChildEnvironments(environment);
    let phase='prepared',started=false,failed=false,gitReads=0,pendingAbsence=0,commandIndex=0;const commands=[],acks=[];
    const cap=createOwnedWebCapabilities({gitPath:s.gitPath,gitSHA256:s.gitSHA256,environment},{...ports,launch(file,args,options){
        assert.equal(file,s.gitPath);assert.equal(options.cwd,s.root);assert.equal(options.shell,false);assert.deepEqual(options.env,profile.git);assert.deepEqual(options.stdio,[ownedGitRequestKind(args)==='batch'?'pipe':'ignore','pipe','pipe']);assert.ok(++gitReads<=1024);return ports.launch(file,args,options);
    }}),filesystem=cap.filesystem;
    const read=async(file,maximum)=>(await readStableArtifactFile(path.dirname(file),path.basename(file),maximum,filesystem)).bytes;
    async function verifyTools(){
        const node=await read(s.nodePath,128*1024**2),npm=await read(s.npmPath,1024**2),pkg=await read(path.dirname(path.dirname(s.npmPath))+'/package.json',1024**2);
        assert.equal(sourceDigest(node),s.nodeSHA256);assert.equal(sourceDigest(npm),s.npmSHA256);assert.equal(sourceDigest(pkg),s.npmPackageSHA256);
        const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pkg));assert.equal(value.name,'npm');assert.equal(value.bin.npm,'bin/npm-cli.js');assert.match(value.version,/^[0-9]+\.[0-9]+\.[0-9]+$/);cap.assertSettled();return value.version;
    }
    async function absent(file){
        pendingAbsence++;
        try{const query=ports.filesystem.lstat(file);if(typeof query?.then==='function')Promise.resolve(query).catch(()=>{});assert.ok(query&&typeof query.then==='function');
            try{await query;}catch(error){assert.equal(error?.code,'ENOENT');return;}throw Error('Pre-existing namespace cannot be adopted or removed.');
        }finally{pendingAbsence--;}
    }
    async function command(plan,env,expected){
        assert.equal(failed,false);assert.ok(commandIndex<3);assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.command));
        assert.deepEqual(Object.keys(plan).sort(),['command','cwd','id','owner','role']);assert.match(plan.owner,/^[a-f0-9]{32}$/);
        const index=commandIndex,allowed=index===0?instrumentedSetupCommand(s,'toolchain'):index===1?instrumentedSetupCommand(s,'dependencies'):
            [s.nodePath,esbuildPath,s.root+'/'+INSTRUMENTED_ENTRY,'--bundle','--platform=node','--format=cjs','--outfile='+root+'/ownership.cjs','--external:ssh2'];
        assert.equal(plan.role,index===2?'build':'install');assert.equal(plan.id,index===1?2:1);
        assert.equal(plan.cwd,index===1?root:s.root);assert.deepEqual(plan.command,allowed);assert.deepEqual(expected,allowed);
        assert.deepEqual(env,{...environment,NODE_ENV:index===0?'development':'production'});
        if(index)assert.equal(commands[index-1].owner.snapshot().directRetired,true);
        commandIndex++; // Before awaited verification/acquisition; no arbitrary expected-command grant.
        const lease={owner:null};commands.push(lease);await verifyTools();
        const actual=startDiagnosticGatewayCommand(plan,env,{...ports,requireSpawnIdentity:true,launch(file,args,options){assert.equal(file,expected[0]);assert.deepEqual(args,expected.slice(1));assert.deepEqual(options,{cwd:plan.cwd,env,shell:false,stdio:['ignore','pipe','pipe']});return ports.launch(file,args,options);}});lease.owner=actual;
        try{const ack=await actual.result;await actual.closed;assert.equal(actual.snapshot().directRetired,true);await verifyTools();acks.push({role:plan.role,id:plan.id,sha256:sourceDigest(JSON.stringify(ack))});return ack;}catch(error){failed=true;throw error;}
    }
    function assertPostBuildDirectSettled(){assert.equal(phase,'ready');assert.equal(pendingAbsence,0);assert.equal(commandIndex,3);assert.equal(acks.length,3);for(const c of commands)assert.equal(c.owner?.snapshot().directRetired,true);cap.assertSettled();}
    const snapshot=()=>({phase,started,failed,gitReads,pendingAbsence,commandIndex,commands:commands.map(v=>v.owner?v.owner.snapshot():{acquisitionPending:true}),files:cap.snapshot(),processGroupRetirement:null,releaseAcceptance:false});
    const owner=Object.freeze({snapshot,async run(){
        assert.equal(started,false);started=true;phase='source';retained.add(owner);
        try{
            const npmVersion=await verifyTools(),provider=await ports.sourceFactory(s.root,{filesystem,executeGit:cap.executeGit,gitEnvironment:cap.gitEnvironment});
            const selected={sourceCommit:context.sha,sourceTree:context.tree},bridge=await observeSourceBridge(selected,provider);assertInstrumentedProductionBridge(bridge);cap.assertSettled();
            const sourceFile=async p=>{const value=await provider.file(p),row=bridge.inventory.find(v=>v.path===p);assert.ok(row);assert.equal(value.mode,row.mode);assert.equal(value.bytes.length,row.bytes);assert.equal(sourceDigest(value.bytes),row.sha256);return Buffer.from(value.bytes);};
            const lock=JSON.parse((await sourceFile('package-lock.json')).toString('utf8'));
            for(const value of Object.values(lock.packages)){if(value.resolved){const url=new URL(value.resolved);assert.equal(url.protocol,'https:');assert.equal(url.hostname,'registry.npmjs.org');assert.ok(!url.username&&!url.password&&!url.port&&!url.search&&!url.hash);assert.match(value.integrity,/^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/);}}
            const stableSource=async()=>{assert.deepEqual(await observeSourceBridge(selected,provider),bridge);cap.assertSettled();};
            await absent(s.root+'/validation');await absent(s.root+'/node_modules');phase='staging';
            for(const p of [s.root+'/validation',stage,stage+'/config',stage+'/toolchain-cache',stage+'/runtime-cache'])await filesystem.mkdir(p);
            for(const name of ['user','global'])await filesystem.writeFile(stage+'/config/'+name+'.npmrc',Buffer.alloc(0),{flag:'wx'});cap.assertSettled();
            phase='toolchain';await absent(s.root+'/node_modules');await stableSource();
            const args=instrumentedSetupCommand(s,'toolchain');await command(Object.freeze({owner:randomBytes(16).toString('hex'),id:1,role:'install',cwd:s.root,command:Object.freeze(args)}),{...environment,NODE_ENV:'development'},args);
            await stableSource();const value=Object.freeze({s,context,stage,root,esbuildPath,environment,ports,cap,filesystem,read,verifyTools,command,acks,sourceFile,stableSource,bridge,provider,selected,npmVersion,snapshot,assertPostBuildDirectSettled});
            admissions.add(value);phase='ready';retained.delete(owner);return value;
        }catch(error){failed=true;phase='failed';throw Object.assign(Error('Instrumented bootstrap failed or remains held.',{cause:error}),{owner});}
    }});return owner;
}
