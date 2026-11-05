import assert from 'node:assert/strict';
import { validateOwnedInstrumentedFailure } from './instrumented-gateway-failure.mjs';
import path from 'node:path';
const DIAGNOSTIC_GATEWAY_POLICY = 'github-hosted-diagnostic-teardown-unproved-group-v1';
export const INSTRUMENTED_GATEWAY_BRANCH = 'ci/gateway-containment298-96a56cd-20261105';
export function validateInstrumentedGatewayContext(v) {
    assert.deepEqual(Object.keys(v).sort(),['arch','attempt','event','job','policy','private','ref','repository','run','runner','sha','system','tree']);
    assert.equal(v.repository,'brucerry/embedded-linux-diagnostic-hub');assert.equal(v.private,false);
    assert.equal(v.ref,'refs/heads/'+INSTRUMENTED_GATEWAY_BRANCH);assert.equal(v.event,'push');assert.equal(v.attempt,'1');assert.equal(v.job,'instrumented_gateway');
    assert.equal(v.runner,'github-hosted');assert.equal(v.system,'Linux');assert.equal(v.arch,'X64');assert.equal(v.policy,DIAGNOSTIC_GATEWAY_POLICY);
    for(const k of ['sha','tree'])assert.match(v[k],/^[a-f0-9]{40}$/);assert.match(v.run,/^[1-9][0-9]*$/);return structuredClone(v);
}
export const absolute=p=>assert.ok(typeof p==='string'&&p.startsWith('/')&&path.posix.normalize(p)===p&&Buffer.byteLength(p)<=4096&&!/[\\\x00-\x20\x7f]/.test(p));
export function instrumentedSetupCommand(selected,role) {
    const stage=selected.root+'/validation/gateway-ownership',base=[selected.nodePath,selected.npmPath,'ci'];
    if(role==='toolchain')return [...base,'--include=dev','--ignore-scripts','--no-audit','--no-fund','--fetch-retries=0','--global=false','--workspaces=false','--registry=https://registry.npmjs.org','--prefix='+selected.root,'--cache='+stage+'/toolchain-cache','--userconfig='+stage+'/config/user.npmrc','--globalconfig='+stage+'/config/global.npmrc'];
    assert.equal(role,'dependencies');return [...base,'--omit=optional','--ignore-scripts','--no-audit','--no-fund','--fetch-retries=0','--global=false','--workspaces=false','--registry=https://registry.npmjs.org','--prefix='+stage+'/instrumented','--cache='+stage+'/runtime-cache','--userconfig='+stage+'/config/user.npmrc','--globalconfig='+stage+'/config/global.npmrc'];
}

/** Fixed counters only. Never stringify error objects, commands, inputs or transcripts.
 * @param {any} [preliminary]
 */
export function instrumentedFailureSummary(stage,bootstrap,driver,preliminary=null){
    const count=n=>Number.isSafeInteger(n)&&n>=0&&n<=10000?n:null;
    const b=driver?.bootstrap??bootstrap,files=b?.files?.files??preliminary,p=driver?.parent;
    const code=(value,allowed)=>allowed.includes(value)?value:null;
    let childFailure=null;try{childFailure=validateOwnedInstrumentedFailure(p?.childFailure);}catch{}
    return{schema:'instrumented-gateway-failure-counters-v7',status:'failed-or-held',stage:['admission','initial-files','bootstrap','driver-import','driver','receipt'].includes(stage)?stage:'unknown',
        driverPhase:code(driver?.failedAt,['source','staging','dependencies','build','census','pair','completed']),
        preparationPhase:code(driver?.preparationPhase,['source','building','readback','snapshot','binding']),
        censusPhase:code(driver?.censusPhase,['root','directory','file-identity','file-read','directory-verification','two-pass-verification','layout']),
        parentPhase:code(p?.failedAt,['prepared','compatibility','ownership','completed']),childFailure,
        gitReads:count(b?.gitReads),pendingAbsence:count(b?.pendingAbsence),commands:count(b?.commands?.length),
        directCommandsRetired:Array.isArray(b?.commands)?count(b.commands.filter(v=>v.directRetired===true).length):null,
        filePending:count(files?.pending),fileHandles:count(files?.handles),uncertainPublications:count(files?.uncertainPublications),
        parentLaunches:count(p?.launches),parentCompleted:p?.completed===true,processGroupRetirement:null,releaseAcceptance:false};
}
