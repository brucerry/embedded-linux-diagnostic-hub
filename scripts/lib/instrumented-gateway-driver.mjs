import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sourceDigest } from './committed-source-bridge.mjs';
import { projectGatewayLock } from './gateway-lock-plan.mjs';
import { prepareInstrumentedGatewayCheck, INSTRUMENTED_ENTRY, INSTRUMENTED_ACTIVATION } from './instrumented-gateway-check.mjs';
import { censusInstrumentedGateway } from './instrumented-gateway-census.mjs';
import { createInstrumentedGatewayParent } from './instrumented-gateway-parent.mjs';

const retained = new Set();
import { requireInstrumentedGatewayBootstrap } from './instrumented-gateway-bootstrap.mjs';
export { validateInstrumentedGatewayContext, INSTRUMENTED_GATEWAY_BRANCH } from './instrumented-gateway-policy.mjs';
import { instrumentedSetupCommand } from './instrumented-gateway-policy.mjs';
/** One source-bound diagnostic pipeline. Explicit native/fake ports only; no implicit execution,
 * retries, removal, signal, permissions change, artifact upload or release grant.
 */
export function createInstrumentedGatewayDriver(admission) {
    const b=requireInstrumentedGatewayBootstrap(admission);
    const {s,context,root,esbuildPath,environment,ports,cap,filesystem,read,verifyTools:toolIdentity,command,acks,sourceFile,stableSource,provider,selected,npmVersion}=b;
    let phase='prepared',admitted=false,failed=false,done=false,buildUsed=false,parentOwner;
    const snapshot=()=>({phase,admitted,failed,done,bootstrap:b.snapshot(),parent:parentOwner?.snapshot()??null,processGroupRetirement:null,releaseAcceptance:false});
    const owner=Object.freeze({snapshot,async run(){
        assert.equal(admitted,false);admitted=true;phase='source';retained.add(owner);
        try {
            await stableSource();await toolIdentity();phase='staging';
            const sourcePackage=await sourceFile('package.json'),sourceLock=await sourceFile('package-lock.json'),activation=await sourceFile(INSTRUMENTED_ACTIVATION);
            const projected=projectGatewayLock(JSON.parse(sourcePackage.toString('utf8')),JSON.parse(sourceLock.toString('utf8')));
            await filesystem.mkdir(root);
            await filesystem.writeFile(root+'/package.json',Buffer.from(JSON.stringify(projected.manifest,null,2)+'\n'),{flag:'wx'});
            await filesystem.writeFile(root+'/package-lock.json',Buffer.from(JSON.stringify(projected.lock,null,2)+'\n'),{flag:'wx'});
            await filesystem.writeFile(root+'/activate.cjs',activation,{flag:'wx'});cap.assertSettled();
            phase='dependencies';await stableSource();const args=instrumentedSetupCommand(s,'dependencies');
            await command(Object.freeze({owner:randomBytes(16).toString('hex'),id:2,role:'install',cwd:root,command:Object.freeze(args)}),{...environment,NODE_ENV:'production'},args);await stableSource();
            phase='build';
            const prepared=await prepareInstrumentedGatewayCheck({root:s.root,...selected},{sourceProvider:provider,
                async observeToolchain(){await toolIdentity();assert.equal(await filesystem.realpath(esbuildPath),esbuildPath);const bytes=await read(esbuildPath,65536);return{nodePath:s.nodePath,nodeSHA256:s.nodeSHA256,esbuildPath,esbuildSHA256:sourceDigest(bytes),esbuildEntryBytes:bytes,esbuildEntryFormat:'node-script'};},
                async execute(plan){assert.equal(buildUsed,false);buildUsed=true;assert.equal(plan.role,'build');assert.equal(plan.id,1);assert.match(plan.owner,/^[a-f0-9]{32}$/);
                    return command(plan,{...environment,NODE_ENV:'production'},[s.nodePath,esbuildPath,s.root+'/'+INSTRUMENTED_ENTRY,'--bundle','--platform=node','--format=cjs','--outfile='+root+'/ownership.cjs','--external:ssh2']);},
                async readArtifact(file,maximum){assert.equal(file,root+'/ownership.cjs');assert.equal(maximum,32*1024**2);return read(file,maximum);},
                async scriptSnapshot(){return(await censusInstrumentedGateway(root,s.runtime.uid,filesystem)).scripts;},
            });
            assert.equal(buildUsed,true);await stableSource();phase='pair';
            parentOwner=createInstrumentedGatewayParent(prepared,{runtime:s.runtime,filesystem:ports.filesystem,launch:ports.launch,setTimer:ports.setTimer,clearTimer:ports.clearTimer,now:ports.now});
            const pair=await parentOwner.run();assert.equal(parentOwner.snapshot().completed,true);await stableSource();await toolIdentity();cap.assertSettled();
            const receipt={schema:'source-built-instrumented-gateway-diagnostic-v1',status:'passed-instrumented-diagnostic-not-release',context,productionInventorySHA256:prepared.binding.rawCLIReference.productionInventorySHA256,
                sourceBridgeSHA256:prepared.binding.sourceBridgeSHA256,artifactSHA256:prepared.binding.artifactSHA256,activationSHA256:prepared.binding.activationSHA256,nodeSHA256:s.nodeSHA256,npmSHA256:s.npmSHA256,npmPackageSHA256:s.npmPackageSHA256,npmVersion,
                commands:acks,gitReads:b.snapshot().gitReads,pair:pair.receipt,timeoutCancellation:'may-use-runner-teardown-no-graceful-group-proof',rawCLIBehavior:null,processGroupRetirement:null,releaseAcceptance:false};
            const bytes=Buffer.from(JSON.stringify(receipt)+'\n');assert.ok(bytes.length<=16384);phase='completed';done=true;prepared.scripts.clear();retained.delete(owner);return Object.freeze({receipt,bytes});
        }catch(error){failed=true;phase='failed';throw Object.assign(Error('Instrumented Gateway diagnostic failed or remains held; no retry or forced cleanup.',{cause:error}),{owner});}
    }});return owner;
}
