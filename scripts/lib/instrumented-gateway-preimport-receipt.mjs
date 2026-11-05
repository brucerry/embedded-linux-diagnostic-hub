import assert from 'node:assert/strict';
import {parseInstrumentedChildInput,INSTRUMENTED_CHILD_INPUT_LIMIT} from './instrumented-gateway-input.mjs';
import {sourceDigest} from './committed-source-bridge.mjs';
import {requireObservedClosure} from './owned-child.mjs';
import {generatedReceiptRowsMatch} from './instrumented-gateway-generated.mjs';
export const PREIMPORT_RECEIPT_MARKER='HUB_PREIMPORT_COMPATIBILITY=';
const keys=(value,names)=>assert.deepEqual(Object.keys(value).sort(),names.sort());
export function preimportReceiptIdentity(bytes,root){
    assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=INSTRUMENTED_CHILD_INPUT_LIMIT+4096);
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),outer=JSON.parse(text);assert.equal(text,JSON.stringify(outer)+'\n');
    keys(outer,['child','earlyArtifactSHA256','schema']);assert.equal(outer.schema,'owned-instrumented-preimport-input-v1');assert.match(outer.earlyArtifactSHA256,/^[a-f0-9]{64}$/);
    const child=parseInstrumentedChildInput(Buffer.from(JSON.stringify(outer.child)+'\n'),root);assert.equal(child.mode,'compatibility');
    keys(child.binding.source,['sourceCommit','sourceTree']);for(const key of ['sourceCommit','sourceTree'])assert.match(child.binding.source[key],/^[a-f0-9]{40}$/);assert.match(child.selection.artifactSHA256,/^[a-f0-9]{64}$/);
    return {identity:{nonce:child.nonce,mode:child.mode,inputSHA256:sourceDigest(bytes),source:structuredClone(child.binding.source),nodeSHA256:child.node.sha256,earlyArtifactSHA256:outer.earlyArtifactSHA256,targetSHA256:child.selection.artifactSHA256,bindingSHA256:sourceDigest(JSON.stringify(child.binding)+'\n')},child};
}
/** Local parent readback only. A printed success envelope cannot override nonzero/unknown
 * command outcome or pending direct-child/pipes. No service, group or release proof is minted. */
export function readPreimportCompatibilityReceipt(stdout,stderr,challengeBytes,root,lifecycle,direct){
    keys(direct,['spawned','exited','closed','pid','inputAck','inputFinish','inputClosed','stdoutClosed','stderrClosed','listeners','unknownOperations','primaryFailure','diagnostics','directRetired','processGroupRetirement']);
    for(const key of ['spawned','exited','closed','inputAck','inputFinish','inputClosed','stdoutClosed','stderrClosed','directRetired'])assert.equal(direct[key],true);
    assert.equal(direct.pid,lifecycle.pid);assert.equal(direct.primaryFailure,false);assert.equal(direct.unknownOperations,0);assert.equal(direct.listeners,0);assert.equal(direct.diagnostics,0);assert.equal(direct.processGroupRetirement,null);requireObservedClosure(lifecycle);for(const key of ['spawnObserved','exitObserved','closeObserved'])assert.equal(lifecycle[key],true);
    assert.equal(lifecycle.code,0);assert.equal(lifecycle.closeCode,0);assert.equal(lifecycle.error,null);assert.equal(lifecycle.timedOut,false);assert.equal(lifecycle.terminationRequested,false);assert.deepEqual(lifecycle.killErrors,[]);assert.ok(Number.isFinite(lifecycle.elapsedMs)&&lifecycle.elapsedMs>=0&&lifecycle.elapsedMs<=60000);
    assert.ok(Buffer.isBuffer(stderr)&&stderr.length===0);assert.ok(Buffer.isBuffer(stdout)&&stdout.length>0&&stdout.length<=16384);
    const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(stdout);assert.ok(Buffer.from(raw).equals(stdout)&&raw.startsWith(PREIMPORT_RECEIPT_MARKER));const text=raw.slice(PREIMPORT_RECEIPT_MARKER.length),value=JSON.parse(text);assert.equal(text,JSON.stringify(value)+'\n');
    keys(value,['schema','status','identity','receipt','failure','wholeGroupRetirement','releaseAcceptance']);assert.equal(value.schema,'owned-preimport-compatibility-envelope-v1');assert.equal(value.status,'completed-local-compatibility');assert.equal(value.failure,null);assert.equal(value.wholeGroupRetirement,null);assert.equal(value.releaseAcceptance,false);
    const {identity,child}=preimportReceiptIdentity(challengeBytes,root);assert.deepEqual(value.identity,identity);const r=value.receipt;
    keys(r,['schema','status','instrumented','source','bindingSHA256','artifactSHA256','compiledScripts','generatedScripts','builtinScripts','builtinIdentityVerified','observerRetired','elapsedMs','productWorkload','shippedCLIBehavior','wholeGroupRetirement','releaseAcceptance']);
    assert.equal(r.schema,'instrumented-node-inspector-preimport-compatibility-v1');assert.equal(r.status,'exact-prelaunch-bytes-match-replayed-sources');assert.equal(r.instrumented,true);assert.deepEqual(r.source,identity.source);assert.equal(r.bindingSHA256,identity.bindingSHA256);assert.equal(r.artifactSHA256,identity.targetSHA256);
    generatedReceiptRowsMatch(r.generatedScripts,child.binding.generatedInventory);assert.ok(Number.isSafeInteger(r.compiledScripts)&&r.compiledScripts>0);assert.ok(Number.isSafeInteger(r.builtinScripts)&&r.builtinScripts>=0);assert.ok(r.compiledScripts+r.builtinScripts+r.generatedScripts.length<=2048);
    assert.equal(r.builtinIdentityVerified,false);assert.equal(r.observerRetired,true);assert.ok(Number.isFinite(r.elapsedMs)&&r.elapsedMs>=0&&r.elapsedMs<=15000);for(const key of ['productWorkload','shippedCLIBehavior','wholeGroupRetirement'])assert.equal(r[key],null);assert.equal(r.releaseAcceptance,false);
    return structuredClone(value);
}
