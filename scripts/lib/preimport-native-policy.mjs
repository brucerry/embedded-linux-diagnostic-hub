import assert from 'node:assert/strict';
export const PREIMPORT_NATIVE_BRANCH='ci/gateway-preimport307-96a56cd-20261105';
export function preimportNativeContext(value){
    assert.deepEqual(Object.keys(value).sort(),['arch','attempt','event','job','policy','private','ref','repository','run','runner','sha','system','tree']);
    assert.equal(value.repository,'brucerry/embedded-linux-diagnostic-hub');assert.equal(value.private,false);assert.equal(value.ref,'refs/heads/'+PREIMPORT_NATIVE_BRANCH);
    assert.equal(value.event,'push');assert.equal(value.job,'preimport_compatibility');assert.equal(value.attempt,'1');assert.equal(value.runner,'github-hosted');assert.equal(value.system,'Linux');assert.equal(value.arch,'X64');
    assert.equal(value.policy,'github-hosted-diagnostic-teardown-unproved-group-v1');for(const k of ['sha','tree'])assert.match(value[k],/^[a-f0-9]{40}$/);assert.match(value.run,/^[1-9][0-9]*$/);return structuredClone(value);
}
