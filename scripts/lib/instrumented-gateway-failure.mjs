import assert from 'node:assert/strict';
import { validateRejectionFingerprint } from './instrumented-gateway-rejection.mjs';
import { createHash } from 'node:crypto';

export const INSTRUMENTED_CHILD_FAILURE_MARKER='HUB_INSTRUMENTED_GATEWAY_CHILD_FAILURE=';
export const CHILD_FAILURE_PHASES=Object.freeze(['input','node','census','snapshot','workload-acquiring','workload','receipt','stdout','retired']);
export const INSPECTOR_FAILURE_CODES=Object.freeze(['inspector-operation','inspector-callback','inspector-dispatch','inspector-pending-bound','script-metadata','script-live-edit','script-source-url','script-id','script-unadmitted','script-length','source-response','source-content','entry-missing','observer-admission','observer-retirement','generated-source-mismatch','generated-origin-unproved','generated-cardinality']);
const projectRejection=v=>{if(!v)return null;try{return validateRejectionFingerprint(v);}catch{return null;}};
const count=n=>Number.isSafeInteger(n)&&n>=0&&n<=10000?n:null;
const boolean=n=>typeof n==='boolean'?n:null;
const hash=b=>createHash('sha256').update(b).digest('hex');
const keys=(v,names)=>assert.deepEqual(Object.keys(v).sort(),[...names].sort());
const numeric=['pendingCallbacks','pendingSourceClassifications','compiledScripts','cleanupDiagnostics','unknownOperations'];
const flags=['acquisitionHeld','connected','listenerHeld','primaryFailure','observerRetired'];
const generatedFlags=['creatorPinned','shapeMatched','stackPresent','siteMatched','nonModuleVerified','sourceMatched','creatorSourceVerified','contextMatched'];
function projectGenerated(v){
    if(!v)return null;
    return {urlKind:['empty','file-url','absolute-path','other'].includes(v.urlKind)?v.urlKind:'unknown',declaredUnits:count(v.declaredUnits),
        creatorPinned:boolean(v.creatorPinned),shapeMatched:boolean(v.shapeMatched),stackPresent:boolean(v.stackPresent),siteMatched:boolean(v.siteMatched),nonModuleVerified:boolean(v.nonModuleVerified),sourceMatched:boolean(v.sourceMatched),creatorSourceVerified:boolean(v.creatorSourceVerified),contextMatched:boolean(v.contextMatched),sourceSHA256:typeof v.sourceSHA256==='string'&&/^[a-f0-9]{64}$/.test(v.sourceSHA256)?v.sourceSHA256:null,sourceBytes:count(v.sourceBytes)};
}
function validateGenerated(v){
    if(v===null)return;
    keys(v,['urlKind','declaredUnits',...generatedFlags,'sourceSHA256','sourceBytes']);assert.ok(['empty','file-url','absolute-path','other','unknown'].includes(v.urlKind));
    for(const k of generatedFlags)assert.ok(v[k]===null||typeof v[k]==='boolean');
    for(const k of ['declaredUnits','sourceBytes'])assert.ok(v[k]===null||count(v[k])===v[k]);
    assert.ok(v.sourceSHA256===null||(typeof v.sourceSHA256==='string'&&/^[a-f0-9]{64}$/.test(v.sourceSHA256)));
}
/** Fixed diagnostic fields only. This is not a passing result or resource-retirement grant. */
export function projectInstrumentedChildFailure(phase,unknown,knownWorkload,snapshot){
    const c=snapshot?.collector;
    const detail={schema:'instrumented-child-failure-detail-v3',phase:CHILD_FAILURE_PHASES.includes(phase)?phase:'unknown',
        unknown:unknown===true,knownWorkload:knownWorkload===true,workloadFailed:boolean(snapshot?.failed),workloadRetired:boolean(snapshot?.retired),
        inspectorFailure:INSPECTOR_FAILURE_CODES.includes(c?.failureCode)?c.failureCode:null,generatedDiagnostic:projectGenerated(c?.generatedDiagnostic),rejectionFingerprint:projectRejection(c?.rejectionFingerprint),
        ...Object.fromEntries(numeric.map(k=>[k,count(c?.[k])])),...Object.fromEntries(flags.map(k=>[k,boolean(c?.[k])])),
        wholeGroupRetirement:null,releaseAcceptance:false};
    return detail;
}
export function validateInstrumentedChildFailure(detail){
    keys(detail,['schema','phase','unknown','knownWorkload','workloadFailed','workloadRetired','inspectorFailure','generatedDiagnostic','rejectionFingerprint',...numeric,...flags,'wholeGroupRetirement','releaseAcceptance']);
    assert.equal(detail.schema,'instrumented-child-failure-detail-v3');assert.ok([...CHILD_FAILURE_PHASES,'unknown'].includes(detail.phase));validateGenerated(detail.generatedDiagnostic);if(detail.rejectionFingerprint!==null)validateRejectionFingerprint(detail.rejectionFingerprint);
    for(const k of ['unknown','knownWorkload'])assert.equal(typeof detail[k],'boolean');
    for(const k of ['workloadFailed','workloadRetired',...flags])assert.ok(detail[k]===null||typeof detail[k]==='boolean');
    for(const k of numeric)assert.ok(detail[k]===null||count(detail[k])===detail[k]);
    assert.ok(detail.inspectorFailure===null||INSPECTOR_FAILURE_CODES.includes(detail.inspectorFailure));
    assert.equal(detail.wholeGroupRetirement,null);assert.equal(detail.releaseAcceptance,false);return structuredClone(detail);
}
export function encodeInstrumentedChildFailure(input,inputBytes,detail){
    validateInstrumentedChildFailure(detail);assert.ok(['compatibility','ownership'].includes(input.mode));assert.match(input.nonce,/^[a-f0-9]{32}$/);
    const envelope={schema:'owned-instrumented-gateway-child-failure-v1',mode:input.mode,nonce:input.nonce,inputSHA256:hash(inputBytes),bindingSHA256:hash(JSON.stringify(input.binding)+'\n'),detail};
    const bytes=Buffer.from(INSTRUMENTED_CHILD_FAILURE_MARKER+JSON.stringify(envelope)+'\n');assert.ok(bytes.length<=4096);return bytes;
}
export function parseInstrumentedChildFailure(bytes,input,inputBytes){
    assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=4096);
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);assert.ok(text.startsWith(INSTRUMENTED_CHILD_FAILURE_MARKER));
    const raw=text.slice(INSTRUMENTED_CHILD_FAILURE_MARKER.length),v=JSON.parse(raw);assert.equal(raw,JSON.stringify(v)+'\n');
    keys(v,['schema','mode','nonce','inputSHA256','bindingSHA256','detail']);assert.equal(v.schema,'owned-instrumented-gateway-child-failure-v1');
    assert.equal(v.mode,input.mode);assert.equal(v.nonce,input.nonce);assert.equal(v.inputSHA256,hash(inputBytes));assert.equal(v.bindingSHA256,hash(JSON.stringify(input.binding)+'\n'));
    return validateInstrumentedChildFailure(v.detail);
}
export function projectOwnedInstrumentedFailure(lease){
    if(!lease)return null;
    let state,output;try{state=lease.child?.snapshot?.();output=lease.child?.output?.();}catch{}
    let detail=null;try{detail=validateInstrumentedChildFailure(lease.failureDetail);}catch{}
    return {phase:['prelaunch','child','receipt','postlaunch'].includes(lease.phase)?lease.phase:null,
        envelope:lease.failureEnvelope==='observed-bound'?'observed-bound':'absent-or-invalid',detail,
        directRetired:boolean(state?.directRetired),spawned:boolean(state?.spawned),exited:boolean(state?.exited),closed:boolean(state?.closed),
        stdoutClosed:boolean(state?.stdoutClosed),stderrClosed:boolean(state?.stderrClosed),
        stdoutBytes:Buffer.isBuffer(output?.stdout)?output.stdout.length:null,stderrBytes:Buffer.isBuffer(output?.stderr)?output.stderr.length:null};
}
export function validateOwnedInstrumentedFailure(v){
    keys(v,['phase','envelope','detail','directRetired','spawned','exited','closed','stdoutClosed','stderrClosed','stdoutBytes','stderrBytes']);
    assert.ok(v.phase===null||['prelaunch','child','receipt','postlaunch'].includes(v.phase));
    assert.ok(['observed-bound','absent-or-invalid'].includes(v.envelope));
    if(v.detail!==null)validateInstrumentedChildFailure(v.detail);
    assert.ok(v.envelope!=='observed-bound'||v.detail!==null);
    for(const k of ['directRetired','spawned','exited','closed','stdoutClosed','stderrClosed'])assert.ok(v[k]===null||typeof v[k]==='boolean');
    for(const [k,max]of [['stdoutBytes',32768],['stderrBytes',65536]])assert.ok(v[k]===null||(Number.isSafeInteger(v[k])&&v[k]>=0&&v[k]<=max));
    return structuredClone(v);
}
