import assert from 'node:assert/strict';
import path from 'node:path';
export const INSTRUMENTED_CHILD_INPUT_LIMIT=4*1024**2;
const modes=['compatibility','ownership'];
function rootPath(root){assert.ok(typeof root==='string'&&root.startsWith('/')&&path.posix.normalize(root)===root&&Buffer.byteLength(root)<=4096&&!/[\\\x00-\x20\x7f]/.test(root)&&root.endsWith('/validation/gateway-ownership/instrumented'));}
function nodeIdentity(v){
    assert.deepEqual(Object.keys(v).sort(),['execArgv','nodeOptions','path','sha256','version']);
    assert.ok(typeof v.path==='string'&&v.path.startsWith('/')&&path.posix.normalize(v.path)===v.path&&Buffer.byteLength(v.path)<=4096&&!/[\\\x00-\x20\x7f]/.test(v.path));assert.match(v.sha256,/^[a-f0-9]{64}$/);
    assert.equal(v.version,'v24.22.0');assert.deepEqual(v.execArgv,[]);assert.equal(v.nodeOptions,null);return structuredClone(v);
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
