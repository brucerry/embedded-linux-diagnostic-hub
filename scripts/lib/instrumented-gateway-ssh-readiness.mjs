import assert from 'node:assert/strict';
import {types} from 'node:util';
import {sourceDigest} from './committed-source-bridge.mjs';
const hash='a729d2064e787e2a4589c25a284444fe54a58b7434a4e6e5e8e9c73c6d91e28e';
/** Fixed preselected dependency bytes; never a notification-supplied path. */
export function deriveSshReadinessPlan(scripts,root){
    const file=root+'/node_modules/ssh2/lib/protocol/crypto.js',bytes=scripts.get(file);
    assert.ok(Buffer.isBuffer(bytes)&&bytes.length===47530&&sourceDigest(bytes)===hash);
    const pkg=JSON.parse(scripts.get(root+'/node_modules/ssh2/package.json').toString('utf8')),lock=JSON.parse(scripts.get(root+'/package-lock.json').toString('utf8')).packages['node_modules/ssh2'];
    assert.equal(pkg.name,'ssh2');assert.equal(pkg.version,'1.17.0');assert.equal(lock.version,'1.17.0');assert.equal(lock.integrity,'sha512-wPldCk3asibAjQ/kziWQQt1Wh3PgDFpC0XpwclzKcdT1vql6KeYxf5LIt4nlFkUeR8WuphYMKqUA56X4rjbfgQ==');
    return Object.freeze({path:file,sha256:hash});
}
/** Joins the EXISTING cached init Promise; never requires a missing module or calls its factory.
 * Completion is module initialization, not a creator/context or whole-resource retirement proof. */
export function cachedSshInitialization(cache,plan){
    assert.ok(cache&&typeof cache==='object'&&!types.isProxy(cache));const slot=Object.getOwnPropertyDescriptor(cache,plan.path);assert.ok(slot&&Object.hasOwn(slot,'value'));
    const module=slot.value;assert.ok(module&&typeof module==='object'&&!types.isProxy(module));const d=Object.getOwnPropertyDescriptors(module);
    for(const key of ['filename','loaded','exports'])assert.ok(d[key]&&Object.hasOwn(d[key],'value'));
    assert.equal(d.filename.value,plan.path);assert.equal(d.loaded.value,true);const exports=d.exports.value;assert.ok(exports&&typeof exports==='object'&&!types.isProxy(exports));
    const init=Object.getOwnPropertyDescriptor(exports,'init');assert.ok(init&&Object.hasOwn(init,'value')&&types.isPromise(init.value));return init.value;
}

/** Fixed cache absence only; never invokes a getter or imports dependency code. */
export function assertPreimportCacheEmpty(cache,root){
    assert.ok(cache&&typeof cache==='object'&&!types.isProxy(cache));
    for(const file of [root+'/ownership.cjs',root+'/node_modules/ssh2/lib/protocol/crypto.js',root+'/node_modules/ssh2/lib/protocol/crypto/poly1305.js'])
        assert.equal(Object.getOwnPropertyDescriptor(cache,file),undefined,'Preimport target/dependency was already loaded.');
}
