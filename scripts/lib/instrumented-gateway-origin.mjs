import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Independently known upstream package data. This string is never evaluated or imported.
export const CPU_FEATURES_SOURCE="'use strict';\n\nconst binding = require('../build/Release/cpufeatures.node');\n\nmodule.exports = binding.getCPUInfo;\n";
export const CPU_FEATURES_SHA256='fbdd49dfead22e1fbd0cfee47457dc343d3a5950092cf7922a671b2d40595771';
export const SSH2_CONSTANTS_SHA256='a3894fdd8e294109b55f06fbda69e467741f15a250801b744b6b0487bbf32529';
const digest=b=>createHash('sha256').update(b).digest('hex');
assert.equal(Buffer.byteLength(CPU_FEATURES_SOURCE),115);assert.equal(digest(CPU_FEATURES_SOURCE),CPU_FEATURES_SHA256);
const leases=new WeakMap();
/** Independent finite comparison plan only; no reported URL is opened or adopted. */
export function deriveCpuOriginPlan(scripts,artifactPath){
    if(typeof artifactPath!=='string'||!artifactPath.startsWith('/')||Buffer.byteLength(artifactPath)>4096||path.posix.normalize(artifactPath)!==artifactPath)return null;
    const root=path.posix.dirname(artifactPath),suffix='/validation/gateway-ownership/instrumented';
    if(!root.endsWith(suffix)||path.posix.basename(artifactPath)!=='ownership.cjs')return null;
    const checkout=root.slice(0,-suffix.length),creator=root+'/node_modules/ssh2/lib/protocol/constants.js';
    if(!checkout||scripts.has(root+'/node_modules/cpu-features/lib/index.js'))return null;
    const bytes=scripts.get(creator),lockBytes=scripts.get(root+'/package-lock.json');
    if(!Buffer.isBuffer(bytes)||bytes.length!==11808||digest(bytes)!==SSH2_CONSTANTS_SHA256||!Buffer.isBuffer(lockBytes)||lockBytes.length>1024**2)return null;
    let lock;try{lock=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(lockBytes));}catch{return null;}
    const cpu=lock?.packages?.['node_modules/cpu-features'],ssh=lock?.packages?.['node_modules/ssh2'];
    if(cpu?.version!=='0.0.10'||cpu.optional!==true||cpu.resolved!=='https://registry.npmjs.org/cpu-features/-/cpu-features-0.0.10.tgz'||cpu.integrity!=='sha512-9IkYqtX3YHPCzoVg1Py+o9057a3i0fp7S530UWokCSaFVTc7CwXPRiOjRjBQQ18ZCNafx78YfnG+HALxtVmOGA=='||ssh?.version!=='1.17.0'||ssh.optionalDependencies?.['cpu-features']!=='~0.0.10')return null;
    return Object.freeze({creator,creatorURL:pathToFileURL(creator).href,creatorSHA256:SSH2_CONSTANTS_SHA256,line:6,column:12,
        checkoutCpuURL:pathToFileURL(checkout+'/node_modules/cpu-features/lib/index.js').href});
}
export function captureRejectionOrigin(p,plan,expected,liveAtNotification=false){
    const raw=p.stackTrace?.callFrames,bounded=Array.isArray(raw)&&raw.length>0&&raw.length<=32,frames=bounded?raw:[];
    const top=frames[0],url=top?.url,topFrameKind=!top?'absent':url==='node:internal/modules/cjs/loader'?'node-cjs-loader':url==='node:internal/vm'?'node-vm':typeof url==='string'&&url.startsWith('node:')?'other-node':expected.has(url)?'census-url':'unverified';
    const candidates=plan?frames.filter(f=>f&&f.url===plan.creatorURL):[];
    const state={schema:'rejected-cpu-origin-association-v1',planned:!!plan,checkoutCpuURLMatches:plan?p.url===plan.checkoutCpuURL:null,cpuSourceMatches:null,
        stackWithinBound:bounded,topFrameKind,constantsURLInStack:plan?candidates.length>0:null,
        constantsSiteInStack:plan?candidates.some(f=>f.lineNumber===plan.line&&f.columnNumber===plan.column):null,constantsScriptVerified:null,constantsCreationVerified:null};
    leases.set(state,{plan,liveAtNotification:liveAtNotification===true,classified:false,context:Number.isSafeInteger(p.executionContextId)&&p.executionContextId>0?p.executionContextId:null,
        frames:candidates.filter(f=>typeof f.scriptId==='string'&&f.scriptId.length>0&&f.scriptId.length<=64).map(f=>({id:f.scriptId,line:Number.isSafeInteger(f.lineNumber)&&f.lineNumber>=0&&f.lineNumber<=2147483647?f.lineNumber:null,column:Number.isSafeInteger(f.columnNumber)&&f.columnNumber>=0&&f.columnNumber<=2147483647?f.columnNumber:null}))});
    return state;
}
export function observeOriginSource(state,source){
    const lease=leases.get(state);assert.ok(lease&&!lease.classified);
    if(lease.plan)state.cpuSourceMatches=source===CPU_FEATURES_SOURCE;
}
export function classifyRejectionOrigin(state,verified){
    if(!state)return;const lease=leases.get(state);assert.ok(lease);if(lease.classified)return;lease.classified=true;
    if(lease.plan){
        const valid=f=>{const v=verified.get(f.id);return v&&v.path===lease.plan.creator&&v.sha256===lease.plan.creatorSHA256&&v.zeroOffset===true?v:null;};
        state.constantsScriptVerified=lease.frames.some(f=>!!valid(f));
        state.constantsCreationVerified=lease.liveAtNotification&&lease.frames.some(f=>{const v=valid(f);return v&&f.line===lease.plan.line&&f.column===lease.plan.column&&lease.context!==null&&v.context!==null&&lease.context===v.context;});
    }
    lease.frames=[];lease.context=null;
}
export function validateRejectionOrigin(v){
    const nullable=['checkoutCpuURLMatches','cpuSourceMatches','constantsURLInStack','constantsSiteInStack','constantsScriptVerified','constantsCreationVerified'];
    assert.deepEqual(Object.keys(v).sort(),['schema','planned','stackWithinBound','topFrameKind',...nullable].sort());assert.equal(v.schema,'rejected-cpu-origin-association-v1');
    for(const k of ['planned','stackWithinBound'])assert.equal(typeof v[k],'boolean');
    assert.ok(['absent','node-cjs-loader','node-vm','other-node','census-url','unverified'].includes(v.topFrameKind));
    for(const k of nullable)assert.ok(v[k]===null||typeof v[k]==='boolean');
    if(!v.planned)for(const k of nullable)assert.equal(v[k],null);
    assert.ok(v.stackWithinBound||v.topFrameKind==='absent');
    assert.ok(!v.constantsURLInStack||v.stackWithinBound);assert.ok(!v.constantsSiteInStack||v.constantsURLInStack);assert.ok(!v.constantsScriptVerified||v.constantsURLInStack);
    assert.ok(!v.constantsCreationVerified||(v.stackWithinBound&&v.constantsSiteInStack&&v.constantsScriptVerified));
    return structuredClone(v);
}
