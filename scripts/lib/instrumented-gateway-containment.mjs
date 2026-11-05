import assert from 'node:assert/strict';
export const CONTAINMENT_POLICY='required-root-and-explicit-cpu-absence-v1';
const codes=['late-or-unregistered','resolution-bound','resolution-shape','cpu-caller-or-repeat','resolution-error','resolution-result','resolution-unknown','resolution-format','builtin-unknown','builtin-mismatch','unsupported-url','native-module','outside-root','activation-unproved','load-after-close-prepared','registration-unknown','registration-error'];
export function validateContainment(v,success=false){
    const flags=['registered','closePrepared','failed','uncertain','rootBound'],counts=['inFlight','resolutions','optionalCpuBlocked','outsideRejected','nativeRejected','missing'];
    assert.deepEqual(Object.keys(v).sort(),['schema','policy',...flags,...counts,'violationCode','wholeGroupRetirement','releaseAcceptance'].sort());
    assert.equal(v.schema,'private-required-module-guard-v1');assert.equal(v.policy,CONTAINMENT_POLICY);
    for(const k of flags)assert.equal(typeof v[k],'boolean');
    for(const k of counts)assert.ok(Number.isSafeInteger(v[k])&&v[k]>=0&&v[k]<=(k==='inFlight'?16:4096));
    assert.ok(v.violationCode===null||codes.includes(v.violationCode));assert.equal(v.failed,v.violationCode!==null);assert.ok(!v.uncertain||v.failed);
    assert.ok(!v.closePrepared||v.registered);assert.equal(v.wholeGroupRetirement,null);assert.equal(v.releaseAcceptance,false);
    if(success){assert.ok(v.rootBound&&v.closePrepared&&v.registered&&!v.failed&&!v.uncertain&&!v.inFlight);assert.ok(v.resolutions>0&&v.optionalCpuBlocked<=1);assert.equal(v.outsideRejected,0);assert.equal(v.nativeRejected,0);}
    return structuredClone(v);
}
export function projectContainment(v){if(!v)return null;try{return validateContainment(v);}catch{return null;}}
