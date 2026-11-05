// Non-shipping, exact-branch workflow entry. Never imported by shipping code or local pure tests.
import assert from 'node:assert/strict';
import {releaseKnownInstrumentedFailure} from '../scripts/lib/instrumented-gateway-failure-retirement.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createOwnedWebFiles } from '../scripts/lib/owned-web-files.mjs';
import { readStableArtifactFile } from '../scripts/lib/stable-artifact-file.mjs';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { localSourceProvider } from '../scripts/lib/committed-source-provider.mjs';
import { createInstrumentedGatewayBootstrap } from '../scripts/lib/instrumented-gateway-bootstrap.mjs';
import { validateInstrumentedGatewayContext, instrumentedFailureSummary } from '../scripts/lib/instrumented-gateway-policy.mjs';
import { startInstrumentedChildOutput } from '../scripts/lib/instrumented-gateway-output.mjs';

export async function main() {
    let hold,preliminaryOwner,bootstrapOwner,driverOwner,outputOwner,stage='admission';
    try {
        const env=process.env,context=validateInstrumentedGatewayContext({repository:env.GITHUB_REPOSITORY,private:env.HUB_REPOSITORY_PRIVATE==='false'?false:true,
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
        bootstrapOwner=createInstrumentedGatewayBootstrap(selection,{filesystem:fs,launch:(file,args,options)=>spawn(file,args,options),
            setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:timer=>{clearTimeout(timer);},now:()=>performance.now(),
            sourceFactory:(selectedRoot,cap)=>localSourceProvider(selectedRoot,{filesystem:cap.filesystem,execute:cap.executeGit,environment:cap.gitEnvironment,asynchronous:true,platform:process.platform})});
        stage='bootstrap';const admission=await bootstrapOwner.run();stage='driver-import';
        const { createInstrumentedGatewayDriver }=await import('../scripts/lib/instrumented-gateway-driver.mjs');
        driverOwner=createInstrumentedGatewayDriver(admission);stage='driver';
        const result=await driverOwner.run();stage='receipt';
        outputOwner=startInstrumentedChildOutput(Buffer.from('HUB_INSTRUMENTED_GATEWAY_DIAGNOSTIC_RECEIPT='+result.bytes.toString('utf8')),process.stdout,()=>{process.exitCode=1;});
        await outputOwner.result;await outputOwner.closed;clearInterval(hold);hold=undefined;
    }catch{
        process.exitCode=1;
        if(!outputOwner){
            try{const failure=instrumentedFailureSummary(stage,bootstrapOwner?.snapshot(),driverOwner?.snapshot(),preliminaryOwner?.snapshot());
                const bytes=Buffer.from('HUB_INSTRUMENTED_GATEWAY_DIAGNOSTIC_FAILURE='+JSON.stringify(failure)+'\n');assert.ok(bytes.length<=16384);
                outputOwner=startInstrumentedChildOutput(bytes,process.stdout,()=>{process.exitCode=1;});await outputOwner.result;await outputOwner.closed;
            }catch{}
        }
        if(driverOwner&&outputOwner&&hold!==undefined){try{await releaseKnownInstrumentedFailure(driverOwner,outputOwner,hold,timer=>{clearInterval(timer);});hold=undefined;}catch{}}
        // Unknown/unacknowledged resources remain held for the bounded job;
        // no retry, signal, deletion or inference of whole-group retirement is made here.
    }
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
