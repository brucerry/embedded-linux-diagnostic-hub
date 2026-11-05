import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {sourceDigest} from './committed-source-bridge.mjs';
import {requirePreimportNativeAdmission} from './preimport-native-bootstrap.mjs';
import {projectGatewayLock} from './gateway-lock-plan.mjs';
import {instrumentedSetupCommand} from './instrumented-gateway-policy.mjs';
import {PREIMPORT_ACTIVATION,preparePreimportCompatibilityBuild,preimportBuildFailure} from './instrumented-gateway-preimport-build.mjs';
import {createPreimportCompatibilityParent} from './instrumented-gateway-preimport-parent.mjs';

const retained=new Set();
/** Loaded only after actual bootstrap admission. No native defaults, retries, signals or deletion.
 * Parent compiler helpers are byte-checked before import; that is not evaluated-code attestation. */
export function createPreimportExecution(admission){
    const b=requirePreimportNativeAdmission(admission),{s,root,filesystem,sourceFile,stableSource}=b;
    let started=false,failed=false,completed=false,phase='prepared',failedAt=null,preparation=null,parent,joinIssued=false;
    const owner=Object.freeze({snapshot:()=>({phase,failedAt,preparation:structuredClone(preparation),started,failed,completed,bootstrap:b.snapshot(),parent:parent?.snapshot()??null,wholeGroupRetirement:null,releaseAcceptance:false}),
        async joinFailedDirectRetirement(){
            assert.ok(failed&&!joinIssued);joinIssued=true;
            if(parent){const p=parent.snapshot();if(p.completed){assert.equal(p.phase,'completed');assert.equal(p.failed,false);assert.equal(p.launches,1);assert.equal(p.pendingAbsence,0);for(const key of ['directRetired','spawned','exited','closed','inputAck','inputFinish','inputClosed','stdoutClosed','stderrClosed'])assert.equal(p.child[key],true);assert.equal(p.child.unknownOperations,0);assert.equal(p.child.listeners,0);assert.equal(p.files.pending,0);assert.equal(p.files.handles,0);assert.equal(p.files.uncertainPublications,0);assert.equal(p.files.primaryFailure,false);}else await parent.joinFailedDirectRetirement();}
            await b.joinKnownFailure();retained.delete(owner);
        },
        closeGuard(){assert.ok(completed);b.closeGuard(false);},
        async run(){
            assert.equal(started,false);started=true;retained.add(owner);
            try{
                phase='source';await stableSource();await b.verifyTools();
                const projected=projectGatewayLock(JSON.parse((await sourceFile('package.json')).toString()),JSON.parse((await sourceFile('package-lock.json')).toString()));
                phase='staging';await filesystem.mkdir(root);
                for(const [name,bytes]of [['package.json',Buffer.from(JSON.stringify(projected.manifest,null,2)+'\n')],['package-lock.json',Buffer.from(JSON.stringify(projected.lock,null,2)+'\n')],['activate.cjs',await sourceFile(PREIMPORT_ACTIVATION)],['resolution-guard.cjs',await sourceFile('tests/fixtures/instrumented-gateway-resolution-guard.cjs')]])await filesystem.writeFile(root+'/'+name,bytes,{flag:'wx'});
                b.cap.assertSettled();phase='dependencies';await stableSource();
                const command=Object.freeze(instrumentedSetupCommand(s,'dependencies'));
                await b.execute(Object.freeze({owner:randomBytes(16).toString('hex'),id:2,role:'install',cwd:root,command}));await stableSource();
                phase='build';const build=await preparePreimportCompatibilityBuild({root:s.root,...b.selected,uid:s.runtime.uid},{sourceProvider:b.provider,filesystem,
                    async observeToolchain(){await b.verifyTools();assert.equal(await filesystem.realpath(b.esbuildPath),b.esbuildPath);const bytes=await b.read(b.esbuildPath,65536);return{nodePath:s.nodePath,nodeSHA256:s.nodeSHA256,esbuildPath:b.esbuildPath,esbuildSHA256:sourceDigest(bytes),esbuildEntryBytes:bytes,esbuildEntryFormat:'node-script'};},
                    execute:b.execute,read:b.read,queryAbsence:b.queryAbsence,assertFilesSettled:()=>{b.cap.assertSettled();}});
                await stableSource();b.assertPostBuildDirectSettled();phase='compatibility';
                parent=createPreimportCompatibilityParent(build,{runtime:s.runtime,filesystem:b.ports.filesystem,launch:b.ports.launch,setTimer:b.ports.setTimer,clearTimer:b.ports.clearTimer,now:b.ports.now});
                const result=await parent.run();assert.equal(parent.snapshot().completed,true);await stableSource();await b.verifyTools();b.assertPostBuildDirectSettled();
                const receipt={schema:'source-built-preimport-compatibility-diagnostic-v1',status:'passed-compatibility-diagnostic-not-release',context:b.context,productionInventorySHA256:'14c3f8cb832fc751c0676ccdb16cecc747e2c3eac0d0ef31d0182b462f9d9325',sourceBridgeSHA256:sourceDigest(JSON.stringify(b.bridge)+'\n'),nodeSHA256:s.nodeSHA256,npmSHA256:s.npmSHA256,npmPackageSHA256:s.npmPackageSHA256,npmVersion:b.npmVersion,
                    parentPackageReferenceSHA256:b.packages.referenceSHA256,parentPackageObservationSHA256:b.packages.sha256,parentLoadedCodeIdentity:null,commands:b.acks,compatibility:result.receipt,
                    childDeadlineMs:55000,parentDeadlineMs:60000,ownershipContinuation:false,rawCLIBehavior:null,wholeGroupRetirement:null,releaseAcceptance:false,timeoutCancellation:'may-use-runner-teardown-no-graceful-group-proof'};
                const bytes=Buffer.from(JSON.stringify(receipt)+'\n');assert.ok(bytes.length<=16384);phase='completed';completed=true;retained.delete(owner);return Object.freeze({receipt,bytes});
            }catch(cause){failedAt=phase;preparation=preimportBuildFailure(cause);phase='failed';failed=true;b.markFailure();throw Object.assign(Error('Preimport execution failed or remains held.',{cause}),{owner});}
        }});return owner;
}
