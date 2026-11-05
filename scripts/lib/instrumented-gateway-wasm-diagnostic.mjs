import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hash=b=>createHash('sha256').update(b).digest('hex');
export const POLY1305_SOURCE_SHA256='55a579ed6a30022054fd1dd822b1b49e2fc51bfbdfa933bfe441de8b7e4dce40';
export const POLY1305_WASM_SHA256='e43ac7cd96599ab0d877b65158ebba07f289dcbf3e4eb4592240c4bf27527bd9';
/** Preselected locked dependency only. Never derive/open paths from notifications. */
export function deriveWasmDiagnosticPlan(scripts,artifactPath){
    const root=path.posix.dirname(artifactPath),creator=root+'/node_modules/ssh2/lib/protocol/crypto/poly1305.js',bytes=scripts.get(creator);
    if(bytes===undefined)return null;
    assert.ok(Buffer.isBuffer(bytes)&&bytes.length===22812&&hash(bytes)===POLY1305_SOURCE_SHA256);
    const pkg=JSON.parse(scripts.get(root+'/node_modules/ssh2/package.json').toString('utf8'));
    const lock=JSON.parse(scripts.get(root+'/package-lock.json').toString('utf8')).packages['node_modules/ssh2'];
    assert.equal(pkg.name,'ssh2');assert.equal(pkg.version,'1.17.0');assert.equal(lock.version,'1.17.0');
    assert.equal(lock.integrity,'sha512-wPldCk3asibAjQ/kziWQQt1Wh3PgDFpC0XpwclzKcdT1vql6KeYxf5LIt4nlFkUeR8WuphYMKqUA56X4rjbfgQ==');assert.ok(lock.optional===undefined||lock.optional===false);
    const matches=[...bytes.toString('utf8').matchAll(/W="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/g)];assert.equal(matches.length,1);
    const binary=Buffer.from(matches[0][1],'base64');assert.equal(binary.toString('base64'),matches[0][1]);assert.equal(binary.length,10006);assert.equal(hash(binary),POLY1305_WASM_SHA256);
    return Object.freeze({creator,creatorURL:pathToFileURL(creator).href,creatorSHA256:POLY1305_SOURCE_SHA256,bytecodeSHA256:POLY1305_WASM_SHA256,bytecodeBytes:10006});
}
export function beginWasmDiagnostic(p,plan){
    const frames=p.stackTrace?.callFrames,within=Array.isArray(frames)&&frames.length<=32;
    const frame=within&&plan?frames.find(f=>f?.url===plan.creatorURL&&typeof f.scriptId==='string'&&f.scriptId.length>0&&f.scriptId.length<=64):null;
    const record={schema:'rejected-wasm-diagnostic-v1',status:'metadata-only',language:['JavaScript','WebAssembly'].includes(p.scriptLanguage)?p.scriptLanguage:'unknown',wasmURL:p.url.startsWith('wasm://'),planPinned:!!plan,
        bytecodeBytes:null,bytecodeSHA256:null,matchesPinnedEmbeddedModule:null,stackWithinBound:within,creatorInStack:!!frame,creatorSourceVerified:null,contextMatched:null};
    const lease={record,plan,frameId:frame?.scriptId??null,context:Number.isSafeInteger(p.executionContextId)?p.executionContextId:null};
    if(plan&&record.language==='WebAssembly'&&record.wasmURL)record.status='pending';
    return lease;
}
/** Source RPC is observation only. A match never admits this script. Response bound precedes decoding. */
export function observeRejectedWasm(lease,result){
    const r=lease.record;r.status='invalid-response';
    if(result?.scriptSource!==''||typeof result?.bytecode!=='string'||result.bytecode.length!==13344||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.bytecode))return;
    const b=Buffer.from(result.bytecode,'base64');if(b.length!==10006||b.toString('base64')!==result.bytecode)return;
    r.bytecodeBytes=b.length;r.bytecodeSHA256=hash(b);r.matchesPinnedEmbeddedModule=!!lease.plan&&r.bytecodeSHA256===lease.plan.bytecodeSHA256;r.status='fingerprinted';
}
export function classifyRejectedWasm(lease,verified){
    if(!lease||lease.classified)return;lease.classified=true;const creator=lease.frameId?verified.get(lease.frameId):null,r=lease.record;
    r.creatorSourceVerified=!!(lease.plan&&creator&&creator.path===lease.plan.creator&&creator.sha256===lease.plan.creatorSHA256&&creator.zeroOffset);
    r.contextMatched=!!(creator&&lease.context!==null&&creator.context!==null&&creator.context===lease.context);lease.frameId=null;lease.context=null;
}
export function validateWasmDiagnostic(v){
    assert.deepEqual(Object.keys(v).sort(),['schema','status','language','wasmURL','planPinned','bytecodeBytes','bytecodeSHA256','matchesPinnedEmbeddedModule','stackWithinBound','creatorInStack','creatorSourceVerified','contextMatched'].sort());
    assert.equal(v.schema,'rejected-wasm-diagnostic-v1');assert.ok(['metadata-only','pending','fingerprinted','invalid-response','rpc-rejected'].includes(v.status));assert.ok(['JavaScript','WebAssembly','unknown'].includes(v.language));
    for(const k of ['wasmURL','planPinned','stackWithinBound','creatorInStack'])assert.equal(typeof v[k],'boolean');
    for(const k of ['matchesPinnedEmbeddedModule','creatorSourceVerified','contextMatched'])assert.ok(v[k]===null||typeof v[k]==='boolean');
    assert.ok(!v.creatorInStack||(v.planPinned&&v.stackWithinBound));assert.ok(!v.creatorSourceVerified||v.creatorInStack);assert.ok(!v.contextMatched||v.creatorInStack);
    if(v.status!=='metadata-only')assert.ok(v.planPinned&&v.wasmURL&&v.language==='WebAssembly');
    if(v.status==='fingerprinted'){assert.equal(v.bytecodeBytes,10006);assert.match(v.bytecodeSHA256,/^[a-f0-9]{64}$/);assert.equal(typeof v.matchesPinnedEmbeddedModule,'boolean');assert.ok(v.planPinned&&v.wasmURL&&v.language==='WebAssembly');assert.equal(v.matchesPinnedEmbeddedModule,v.bytecodeSHA256===POLY1305_WASM_SHA256);}
    else for(const k of ['bytecodeBytes','bytecodeSHA256','matchesPinnedEmbeddedModule'])assert.equal(v[k],null);
    return structuredClone(v);
}
