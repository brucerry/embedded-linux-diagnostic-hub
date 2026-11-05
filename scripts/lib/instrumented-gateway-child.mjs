import assert from 'node:assert/strict';
import { validateContainment } from './instrumented-gateway-containment.mjs';
import { generatedReceiptRowsMatch } from './instrumented-gateway-generated.mjs';
import { encodeInstrumentedChildFailure, parseInstrumentedChildFailure, projectInstrumentedChildFailure } from './instrumented-gateway-failure.mjs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sourceDigest } from './committed-source-bridge.mjs';
import { RAW_CLI_REFERENCE, snapshotPreparedInstrumentedGateway } from './instrumented-gateway-check.mjs';
import { censusInstrumentedGateway } from './instrumented-gateway-census.mjs';
import { startDiagnosticGatewayCommand } from './diagnostic-gateway-command.mjs';

const retained=new Set(), compatibilityAdmissions=new WeakMap();
export const INSTRUMENTED_CHILD_INPUT_LIMIT=4*1024**2;
export const INSTRUMENTED_CHILD_MARKER='HUB_INSTRUMENTED_GATEWAY_CHILD=';
const modes=['compatibility','ownership'];
function synchronousUndefined(value){if(typeof value?.then==='function')Promise.resolve(value).catch(()=>{});assert.equal(value,undefined);}
function rootPath(root){assert.ok(typeof root==='string'&&root.startsWith('/')&&path.posix.normalize(root)===root&&Buffer.byteLength(root)<=4096&&!/[\\\x00-\x20\x7f]/.test(root)&&root.endsWith('/validation/gateway-ownership/instrumented'));}
function nodeIdentity(v){
    assert.deepEqual(Object.keys(v).sort(),['execArgv','nodeOptions','path','sha256','version']);
    assert.ok(typeof v.path==='string'&&v.path.startsWith('/')&&path.posix.normalize(v.path)===v.path&&Buffer.byteLength(v.path)<=4096&&!/[\\\x00-\x20\x7f]/.test(v.path));assert.match(v.sha256,/^[a-f0-9]{64}$/);
    assert.equal(v.version,'v24.22.0');assert.deepEqual(v.execArgv,[]);assert.equal(v.nodeOptions,null);return structuredClone(v);
}
function assertSnapshot(prepared,census){
    assert.deepEqual(census.inventory,prepared.binding.fileInventory);
    assert.equal(census.inventorySHA256,prepared.binding.fileInventorySHA256);
    assert.deepEqual(census.scriptInventory,prepared.binding.scriptInventory);
    assert.equal(census.scriptInventorySHA256,prepared.binding.scriptInventorySHA256);
    assert.equal(census.lockSHA256,prepared.binding.installationLockSHA256);assert.equal(census.packageSHA256,prepared.binding.installationPackageSHA256);
    const root=path.dirname(prepared.selection.artifactPath);
    assert.equal(sourceDigest(census.scripts.get(root+'/activate.cjs')),prepared.binding.activationSHA256);
    assert.equal(sourceDigest(census.scripts.get(root+'/resolution-guard.cjs')),prepared.binding.guardSHA256);
}
export function parseInstrumentedChildInput(bytes,root){
    rootPath(root);assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=INSTRUMENTED_CHILD_INPUT_LIMIT);
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),v=JSON.parse(text);
    assert.equal(text,JSON.stringify(v)+'\n');
    assert.deepEqual(Object.keys(v).sort(),['binding','mode','node','nonce','root','schema','selection','token','uid']);
    assert.equal(v.schema,'owned-instrumented-gateway-child-input-v1');assert.equal(v.root,root);assert.ok(modes.includes(v.mode));
    assert.match(v.nonce,/^[a-f0-9]{32}$/);assert.match(v.token,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(v.uid)&&v.uid>=0);
    nodeIdentity(v.node);assert.equal(v.node.path,v.binding.toolchain.nodePath);assert.equal(v.node.sha256,v.binding.toolchain.nodeSHA256);
    assert.equal(path.dirname(v.selection.artifactPath),root);return v;
}

const failedChildren=new WeakMap();
export async function joinInstrumentedChildFailure(error){
 const record=failedChildren.get(error);assert.ok(record&&record.child,'Actual admitted failed child required.');
 await record.child.closed;const state=record.child.snapshot();assert.equal(state.directRetired,true);assert.equal(state.unknownOperations,0);
 synchronousUndefined(record.assertFilesSettled());
}
const counterKeys=['stopping','serverListening','cleanupTimers','requestTasks','httpSockets','httpResponses','httpBodyReaders','pendingConnections','sessions','inFlight','ownedSessions','retiringSessions','connectionAttempts','cancelledAttemptCache','sessionOwners','allSessionOwners'];
const keys=(v,k)=>assert.deepEqual(Object.keys(v).sort(),[...k].sort());
const elapsed=(n,max)=>assert.ok(Number.isFinite(n)&&n>=0&&n<=max);
function counters(v,closed){
    keys(v,counterKeys);assert.equal(v.stopping,closed);assert.equal(v.serverListening,!closed);
    for(const k of counterKeys)if(!['stopping','serverListening'].includes(k)){assert.ok(Number.isSafeInteger(v[k])&&v[k]>=0);if(closed)assert.equal(v[k],0);}
    if(!closed)assert.equal(v.cleanupTimers,1);
}
export function validateInstrumentedChildReceipt(prepared,mode,r){
    assert.ok(modes.includes(mode));assert.deepEqual(r.source,prepared.binding.source);
    assert.equal(r.bindingSHA256,sourceDigest(JSON.stringify(prepared.binding)+'\n'));assert.equal(r.artifactSHA256,prepared.selection.artifactSHA256);
    assert.equal(r.instrumented,true);assert.equal(r.releaseAcceptance,false);assert.equal(r.wholeGroupRetirement,null);assert.equal(r.shippedCLIBehavior,null);
    generatedReceiptRowsMatch(r.generatedScripts,prepared.binding.generatedInventory);
    assert.ok(Number.isSafeInteger(r.compiledScripts)&&r.compiledScripts>0&&r.compiledScripts+r.generatedScripts.length<=2048);
    if(mode==='compatibility'){
        keys(r,['schema','status','instrumented','source','bindingSHA256','artifactSHA256','compiledScripts','generatedScripts','builtinScripts','builtinIdentityVerified','observerRetired','elapsedMs','productWorkload','shippedCLIBehavior','wholeGroupRetirement','releaseAcceptance']);
        assert.equal(r.schema,'instrumented-node-inspector-compatibility-v2');assert.equal(r.status,'exact-prelaunch-bytes-match-replayed-sources');
        assert.equal(r.observerRetired,true);assert.equal(r.productWorkload,null);assert.equal(r.builtinIdentityVerified,false);elapsed(r.elapsedMs,15000);
        assert.ok(Number.isSafeInteger(r.builtinScripts)&&r.builtinScripts>=0&&r.builtinScripts+r.compiledScripts+r.generatedScripts.length<=2048);
    }else{
        keys(r,['schema','instrumented','source','rawCLIReference','evidenceSeparation','bindingSHA256','artifactSHA256','before','afterHealth','afterClose','health','observerRecordSHA256','compiledScripts','generatedScripts','productCloseAcknowledged','localObserverRetired','elapsedMs','wholeGroupRetirement','shippedCLIBehavior','shippingPerformance','shippingGC','releaseAcceptance']);
        assert.equal(r.schema,'separate-instrumented-gateway-ownership-check-v2');assert.deepEqual(r.rawCLIReference,RAW_CLI_REFERENCE);
        assert.equal(r.evidenceSeparation,'this-instrumented-build-only-no-transfer-to-raw-CLI');assert.equal(r.productCloseAcknowledged,true);assert.equal(r.localObserverRetired,true);
        assert.equal(r.shippingGC,null);assert.equal(r.shippingPerformance,null);assert.match(r.observerRecordSHA256,/^[a-f0-9]{64}$/);elapsed(r.elapsedMs,45000);
        counters(r.before,false);counters(r.afterHealth,false);counters(r.afterClose,true);
        const h=r.health;keys(h,['role','status','responseBytes','elapsedMs','requestRetired','responseRetired','socketRetired','wholeGroupRetirement','releaseAcceptance']);
        assert.equal(h.role,'healthy');assert.equal(h.status,200);assert.ok(Number.isSafeInteger(h.responseBytes)&&h.responseBytes>0&&h.responseBytes<=4096);elapsed(h.elapsedMs,2000);
        for(const k of ['requestRetired','responseRetired','socketRetired'])assert.equal(h[k],true);assert.equal(h.wholeGroupRetirement,null);assert.equal(h.releaseAcceptance,false);
    }
}

/** Parent controller: complete pre/post census, exclusive input, one fixed ignored-stdin child,
 * and receipt acceptance only after actual normal child+pipe closure. No native defaults/signals.
 */
export async function runOwnedInstrumentedGatewayChild(prepared,mode,uid,ports){
    assert.ok(modes.includes(mode));for(const k of ['observeNode','writeExclusive','readInput','launch','setTimer','clearTimer','now','assertFilesSettled'])assert.equal(typeof ports[k],'function');
    ports=Object.freeze({...ports});
    const snapshot=snapshotPreparedInstrumentedGateway(prepared),root=path.dirname(snapshot.selection.artifactPath);rootPath(root);
    const lease={phase:'prelaunch',child:null,failed:false,failureDetail:null,failureEnvelope:'absent'};retained.add(lease);
    let challenge,challengeBytes;
    try{
        const node=nodeIdentity(await ports.observeNode());assert.equal(node.path,snapshot.binding.toolchain.nodePath);assert.equal(node.sha256,snapshot.binding.toolchain.nodeSHA256);
        const before=await censusInstrumentedGateway(root,uid,ports.filesystem);assertSnapshot(snapshot,before);
        const input={schema:'owned-instrumented-gateway-child-input-v1',mode,nonce:randomBytes(16).toString('hex'),root,uid,node,
            binding:snapshot.binding,selection:snapshot.selection,token:randomBytes(32).toString('hex')};
        const inputBytes=Buffer.from(JSON.stringify(input)+'\n');assert.ok(inputBytes.length<=INSTRUMENTED_CHILD_INPUT_LIMIT);challenge=input;challengeBytes=inputBytes;
        const prior=mode==='ownership'?compatibilityAdmissions.get(ports.compatibility):null;
        if(mode==='ownership'){assert.ok(prior&&!prior.used,'An actual parent-acknowledged compatibility result is required.');assert.equal(prior.bindingSHA256,sourceDigest(JSON.stringify(snapshot.binding)+'\n'));assert.equal(prior.censusSHA256,before.censusSHA256);assert.deepEqual(prior.node,node);prior.used=true;}
        const inputPath=path.dirname(root)+'/child-input-'+mode+'.json';const written=ports.writeExclusive(inputPath,inputBytes);
        if(typeof written?.then==='function')Promise.resolve(written).catch(()=>{});assert.ok(written&&typeof written.then==='function');assert.equal(await written,undefined);
        assert.ok((await ports.readInput(inputPath,INSTRUMENTED_CHILD_INPUT_LIMIT)).equals(inputBytes));
        synchronousUndefined(ports.assertFilesSettled());
        const command=[node.path,root+'/activate.cjs',inputPath];
        const plan=Object.freeze({owner:randomBytes(16).toString('hex'),id:1,role:'ownership',cwd:root,command:Object.freeze(command)});
        const env={PATH:path.dirname(node.path)+':/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',NODE_ENV:'production'};
        lease.phase='child';
        const child=startDiagnosticGatewayCommand(plan,env,{launch:(file,args,options)=>{
            assert.equal(file,node.path);assert.deepEqual(args,command.slice(1));assert.equal(options.cwd,root);assert.equal(options.shell,false);
            assert.deepEqual(options.env,env);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);return ports.launch(file,args,options);
        },setTimer:ports.setTimer,clearTimer:ports.clearTimer,now:ports.now});lease.child=child;
        await child.result;await child.closed;assert.equal(child.snapshot().directRetired,true);
        lease.phase='receipt';
        const output=child.output();assert.equal(output.stderr.length,0);
        const text=new TextDecoder('utf-8',{fatal:true}).decode(output.stdout);assert.ok(text.startsWith(INSTRUMENTED_CHILD_MARKER));
        const json=text.slice(INSTRUMENTED_CHILD_MARKER.length),envelope=JSON.parse(json);assert.equal(json,JSON.stringify(envelope)+'\n');
        assert.deepEqual(Object.keys(envelope).sort(),['bindingSHA256','containment','inputSHA256','mode','nonce','receipt','receiptSHA256','schema']);
        assert.equal(envelope.schema,'owned-instrumented-gateway-child-result-v2');validateContainment(envelope.containment,true);assert.equal(envelope.mode,mode);assert.equal(envelope.nonce,input.nonce);
        assert.equal(envelope.inputSHA256,sourceDigest(inputBytes));assert.equal(envelope.bindingSHA256,sourceDigest(JSON.stringify(snapshot.binding)+'\n'));
        const receiptBytes=Buffer.from(JSON.stringify(envelope.receipt)+'\n');assert.ok(receiptBytes.length<=16384);assert.equal(sourceDigest(receiptBytes),envelope.receiptSHA256);
        validateInstrumentedChildReceipt(snapshot,mode,envelope.receipt);
        lease.phase='postlaunch';const after=await censusInstrumentedGateway(root,uid,ports.filesystem);assertSnapshot(snapshot,after);assert.deepEqual(after.census,before.census);
        assert.deepEqual(nodeIdentity(await ports.observeNode()),node);assert.ok((await ports.readInput(inputPath,INSTRUMENTED_CHILD_INPUT_LIMIT)).equals(inputBytes));
        synchronousUndefined(ports.assertFilesSettled());snapshot.scripts.clear();retained.delete(lease);
        const completed=Object.freeze({receipt:{schema:'parent-observed-instrumented-gateway-child-v2',mode,source:snapshot.binding.source,
            bindingSHA256:envelope.bindingSHA256,artifactSHA256:snapshot.selection.artifactSHA256,activationSHA256:snapshot.binding.activationSHA256,
            nodeSHA256:node.sha256,guardSHA256:snapshot.binding.guardSHA256,containment:envelope.containment,containmentContextClosed:true,censusSHA256:before.censusSHA256,childReceiptSHA256:envelope.receiptSHA256,
            normalChildAndPipesClosed:true,postCensusUnchanged:true,childReceipt:envelope.receipt,wholeGroupRetirement:null,releaseAcceptance:false}});
        if(mode==='compatibility')compatibilityAdmissions.set(completed,{bindingSHA256:envelope.bindingSHA256,censusSHA256:before.censusSHA256,node,used:false});
        return completed;
    }catch(error){
        lease.failed=true;
        if(challenge&&lease.child){
            try{const output=lease.child.output();lease.failureDetail=parseInstrumentedChildFailure(output.stdout,challenge,challengeBytes);lease.failureEnvelope='observed-bound';}
            catch{lease.failureEnvelope='absent-or-invalid';}
        }
        const failure=Object.assign(Error('Owned instrumented child failed; uncertain custody retained.',{cause:error}),{owner:lease});failedChildren.set(failure,Object.freeze({child:lease.child,assertFilesSettled:ports.assertFilesSettled}));throw failure;
    }
}

/** Child activation body. An owned liveness interval remains while known/unknown local resources
 * or stdout callbacks are unacknowledged. No forced close, process exit, signal or cleanup retry.
 */
export async function activateOwnedInstrumentedGatewayChild(inputPath,ports){
    rootPath(ports.root);assert.ok(modes.some(mode=>inputPath===path.dirname(ports.root)+'/child-input-'+mode+'.json'));
    for(const k of ['startHold','clearHold','readInput','observeNode','runOwnership','runCompatibility','writeOutput','assertFilesSettled','setExitCode','assertContainment','prepareContainmentClose','assertContainmentClose','containmentSnapshot'])assert.equal(typeof ports[k],'function');
    const lease={phase:'input',hold:null,workload:null,unknown:false,containmentPrepared:false};retained.add(lease);
    let knownWorkload=false, knownOutput=false, output, clearIssued=false, input, inputBytes, containmentIssued=false;
    function prepareContainment(allowFailure){
        assert.equal(containmentIssued,false);containmentIssued=true;lease.unknown=true;
        const value=ports.prepareContainmentClose(allowFailure);if(typeof value?.then==='function')Promise.resolve(value).catch(()=>{});
        const record=validateContainment(value,!allowFailure);assert.ok(record.registered&&record.closePrepared&&!record.uncertain&&!record.inFlight);
        lease.containmentPrepared=true;lease.unknown=false;return record;
    }
    function clearHoldOnce(){
        assert.equal(clearIssued,false);clearIssued=true;lease.unknown=true;
        const cleared=ports.clearHold(lease.hold);
        if(cleared!==undefined){lease.unknown=true;if(typeof cleared?.then==='function')Promise.resolve(cleared).catch(()=>{});throw Error('Unacknowledged liveness cleanup.');}lease.unknown=false;
    }
    try{
        lease.unknown=true;lease.hold=ports.startHold();if(lease.hold===undefined||lease.hold===null||typeof lease.hold?.then==='function'){lease.unknown=true;if(typeof lease.hold?.then==='function')Promise.resolve(lease.hold).catch(()=>{});throw Error('Unknown liveness lease.');}lease.unknown=false;
        const bytes=await ports.readInput(inputPath,INSTRUMENTED_CHILD_INPUT_LIMIT);input=parseInstrumentedChildInput(bytes,ports.root);inputBytes=bytes;
        assert.equal(inputPath,path.dirname(ports.root)+'/child-input-'+input.mode+'.json');
        lease.phase='containment';synchronousUndefined(ports.assertContainment());
        lease.phase='node';
        assert.deepEqual(nodeIdentity(await ports.observeNode()),input.node);
        assert.equal(input.uid,ports.uid);
        lease.phase='census';
        const census=await censusInstrumentedGateway(input.root,input.uid,ports.filesystem);
        lease.phase='snapshot';
        const prepared={binding:input.binding,selection:input.selection,scripts:census.scripts};const copied=snapshotPreparedInstrumentedGateway(prepared);assertSnapshot(copied,census);
        synchronousUndefined(ports.assertContainment());lease.phase='workload-acquiring';lease.unknown=true;lease.workload=input.mode==='compatibility'?ports.runCompatibility(copied):ports.runOwnership(copied,input.token);
        if(typeof lease.workload?.then==='function')Promise.resolve(lease.workload).catch(()=>{});
        assert.ok(lease.workload&&typeof lease.workload.result?.then==='function'&&typeof lease.workload.closed?.then==='function');knownWorkload=true;lease.unknown=false;lease.phase='workload';
        const completed=await lease.workload.result;await lease.workload.closed;
        lease.phase='receipt';
        assert.ok(Buffer.isBuffer(completed.bytes)&&completed.bytes.length<=16384&&completed.bytes.equals(Buffer.from(JSON.stringify(completed.receipt)+'\n')));
        validateInstrumentedChildReceipt(copied,input.mode,completed.receipt);
        synchronousUndefined(ports.assertFilesSettled());
        lease.phase='containment';synchronousUndefined(ports.assertContainment());const containment=prepareContainment(false);
        const envelope={schema:'owned-instrumented-gateway-child-result-v2',containment,mode:input.mode,nonce:input.nonce,inputSHA256:sourceDigest(bytes),
            bindingSHA256:sourceDigest(JSON.stringify(input.binding)+'\n'),receiptSHA256:sourceDigest(completed.bytes),receipt:completed.receipt};
        const outputBytes=Buffer.from(INSTRUMENTED_CHILD_MARKER+JSON.stringify(envelope)+'\n');assert.ok(outputBytes.length<=32768);
        lease.phase='stdout';lease.unknown=true;const writeOwner=ports.writeOutput(outputBytes);
        if(typeof writeOwner?.then==='function')Promise.resolve(writeOwner).catch(()=>{});
        assert.ok(writeOwner&&typeof writeOwner.result?.then==='function'&&typeof writeOwner.closed?.then==='function');
        output=writeOwner;knownOutput=true;lease.unknown=false;assert.equal(await writeOwner.result,undefined);await writeOwner.closed;
        synchronousUndefined(ports.assertContainmentClose(false));clearHoldOnce();
        copied.scripts.clear();census.scripts.clear();lease.phase='retired';retained.delete(lease);return;
    }catch(error){
        if(lease.phase==='workload-acquiring'&&!knownWorkload)lease.unknown=true;
        try{synchronousUndefined(ports.setExitCode(1));}catch{lease.unknown=true;}
        // Publish a bounded identity-bound diagnostic before joins that may remain held.
        // This output never grants success or retirement; original cleanup policy continues below.
        if(input&&!knownOutput){
            let observed;try{observed=lease.workload?.snapshot?.();}catch{}
            const priorUnknown=lease.unknown;
            try{
                let containment;try{containment=ports.containmentSnapshot();validateContainment(containment);}catch{lease.unknown=true;}
                const detail=projectInstrumentedChildFailure(lease.phase,lease.unknown,knownWorkload,{...observed,containment});
                const bytes=encodeInstrumentedChildFailure(input,inputBytes,detail);lease.unknown=true;
                const attempt=ports.writeOutput(bytes);if(typeof attempt?.then==='function')Promise.resolve(attempt).catch(()=>{});
                assert.ok(attempt&&typeof attempt.result?.then==='function'&&typeof attempt.closed?.then==='function');
                output=attempt;knownOutput=true;lease.unknown=priorUnknown;await output.result;await output.closed;
            }catch{}
        }
        if(knownWorkload)try{await lease.workload.closed;}catch{lease.unknown=true;}
        if(knownOutput)try{await output.closed;}catch{lease.unknown=true;}
        try{
            synchronousUndefined(ports.assertFilesSettled());assert.equal(lease.unknown,false);assert.equal(clearIssued,false);
            if(!lease.containmentPrepared){assert.equal(containmentIssued,false);prepareContainment(true);}
            synchronousUndefined(ports.assertContainmentClose(true));clearHoldOnce();
            retained.delete(lease);
        }catch{lease.unknown=true;}
        throw Object.assign(Error('Instrumented child activation failed or remains held.',{cause:error}),{owner:lease});
    }
}
