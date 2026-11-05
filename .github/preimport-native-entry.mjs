// Non-shipping, exact-branch workflow entry. Never imported by shipping code or local pure tests.
import assert from 'node:assert/strict';
import {registerHooks,isBuiltin,createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createOwnedWebFiles } from '../scripts/lib/owned-web-files.mjs';
import { readStableArtifactFile } from '../scripts/lib/stable-artifact-file.mjs';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { localSourceProvider } from '../scripts/lib/committed-source-provider.mjs';
import { createPreimportNativeBootstrap } from '../scripts/lib/preimport-native-bootstrap.mjs';
import {preimportNativeContext} from '../scripts/lib/preimport-native-policy.mjs';
import {releasePreimportRoot} from '../scripts/lib/preimport-root-retirement.mjs';
import { startInstrumentedChildOutput } from '../scripts/lib/instrumented-gateway-output.mjs';

export async function main() {
    let hold,preliminaryOwner,bootstrapOwner,driverOwner,outputOwner,stage='admission';
    try {
        const env=process.env,context=preimportNativeContext({repository:env.GITHUB_REPOSITORY,private:env.HUB_REPOSITORY_PRIVATE==='false'?false:true,
            ref:env.GITHUB_REF,event:env.GITHUB_EVENT_NAME,job:env.GITHUB_JOB,attempt:env.GITHUB_RUN_ATTEMPT,runner:env.RUNNER_ENVIRONMENT,system:env.RUNNER_OS,arch:env.RUNNER_ARCH,
            sha:env.GITHUB_SHA,tree:env.SELECTED_TREE,run:env.GITHUB_RUN_ID,policy:env.HUB_DIAGNOSTIC_GATEWAY_POLICY});
        assert.equal(process.version,'v24.22.0');assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.deepEqual(process.execArgv,[]);
        for(const k of ['NODE_OPTIONS','NODE_PATH','ESBUILD_BINARY_PATH'])assert.equal(env[k],undefined);
        assert.ok(process.getuid()>0);
        hold=setInterval(()=>{},1000);stage='initial-files'; // Before the first native file acquisition.
        const owned=createOwnedWebFiles(fs);preliminaryOwner=owned.owner;
        const read=async(file,max)=>(await readStableArtifactFile(path.dirname(file),path.basename(file),max,owned.filesystem)).bytes;
        const root=await owned.filesystem.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));assert.equal(await owned.filesystem.realpath(env.GITHUB_WORKSPACE),root);
        const nodePath=await owned.filesystem.realpath(process.execPath);assert.equal(nodePath,process.execPath);
        const gitPath=await owned.filesystem.realpath('/usr/bin/git');assert.equal(gitPath,'/usr/bin/git');
        const npmPath=path.dirname(path.dirname(nodePath))+'/lib/node_modules/npm/bin/npm-cli.js';assert.equal(await owned.filesystem.realpath(npmPath),npmPath);
        const selection={context,root,nodePath,gitPath,npmPath,nodeSHA256:sourceDigest(await read(nodePath,128*1024**2)),gitSHA256:sourceDigest(await read(gitPath,16*1024**2)),
            npmSHA256:sourceDigest(await read(npmPath,1024**2)),npmPackageSHA256:sourceDigest(await read(path.dirname(path.dirname(npmPath))+'/package.json',1024**2)),
            runtime:{platform:process.platform,arch:process.arch,version:process.version,execPath:process.execPath,execArgv:[...process.execArgv],uid:process.getuid(),nodeOptions:null,nodePathVariable:null}};
        owned.owner.assertSettled();
        bootstrapOwner=createPreimportNativeBootstrap(selection,{filesystem:fs,launch:(file,args,options)=>spawn(file,args,options),
            setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:timer=>{clearTimeout(timer);},now:()=>performance.now(),
            sourceFactory:(selectedRoot,cap)=>localSourceProvider(selectedRoot,{filesystem:cap.filesystem,execute:cap.executeGit,environment:cap.gitEnvironment,asynchronous:true,platform:process.platform}),
            registerHooks,isBuiltin,onLoaderFailure:()=>{process.exitCode=1;},
            assertPackageCacheEmpty(files){const cache=createRequire(import.meta.url).cache;assert.ok(cache&&typeof cache==='object');for(const file of files)assert.equal(Object.hasOwn(cache,file),false);},
            loadDriver:file=>import(pathToFileURL(file).href)});
        stage='bootstrap';const loaded=await bootstrapOwner.run();stage='driver';driverOwner=loaded.create(loaded.admission);
        const result=await driverOwner.run();driverOwner.closeGuard();stage='receipt';
        const successBytes=Buffer.from('HUB_PREIMPORT_NATIVE_RECEIPT='+result.bytes.toString('utf8'));assert.ok(successBytes.length<=16384);
        outputOwner=startInstrumentedChildOutput(successBytes,process.stdout,()=>{process.exitCode=1;});
        await releasePreimportRoot(outputOwner,hold,timer=>{clearInterval(timer);});hold=undefined;
    }catch{
        process.exitCode=1;
        if(!outputOwner){
            try{const b=bootstrapOwner?.snapshot(),d=driverOwner?.snapshot(),p=d?.parent;const count=n=>Number.isSafeInteger(n)&&n>=0&&n<=10000?n:null;
                const failure={schema:'preimport-native-failure-counters-v3',status:'failed-or-held',stage,preparation:d?.preparation??null,successfulAckCount:count(b?.successfulAckCount),commandOutcomes:b?.commandOutcomes??[],phase:d?.failedAt??b?.phase??null,loaderUncertain:b?.loaderUncertain??null,gitReads:count(b?.gitReads),pendingAbsence:count(b?.pendingAbsence),commands:count(b?.commands?.length),directRetired:count(b?.commands?.filter(v=>v.directRetired===true).length),parentLaunches:count(p?.launches),childFailure:p?.childFailure??null,files:b?.files??preliminaryOwner?.snapshot()??null,wholeGroupRetirement:null,releaseAcceptance:false};
                const bytes=Buffer.from('HUB_PREIMPORT_NATIVE_FAILURE='+JSON.stringify(failure)+'\n');assert.ok(bytes.length<=16384);
                outputOwner=startInstrumentedChildOutput(bytes,process.stdout,()=>{process.exitCode=1;});await outputOwner.result;await outputOwner.closed;
            }catch{}
        }
        if(outputOwner&&hold!==undefined){try{await releasePreimportRoot(outputOwner,hold,timer=>{clearInterval(timer);},async()=>{if(driverOwner)await driverOwner.joinFailedDirectRetirement();else{assert.ok(bootstrapOwner);await bootstrapOwner.joinKnownFailure();}preliminaryOwner.assertSettled();});hold=undefined;}catch{}}
        // Unknown/unacknowledged resources remain held for the bounded job;
        // no retry, signal, deletion or inference of whole-group retirement is made here.
    }
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
