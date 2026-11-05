import assert from 'node:assert/strict';
import {types} from 'node:util';
import {pathToFileURL} from 'node:url';
import {sourceDigest} from './committed-source-bridge.mjs';
import {readStableArtifactFile} from './stable-artifact-file.mjs';
import {PREIMPORT_PACKAGE_REFERENCE} from './preimport-package-reference.mjs';

const plan=structuredClone(PREIMPORT_PACKAGE_REFERENCE);
export const parentPackageReference=()=>structuredClone(plan);
function identity(stat,uid,directory=false){
    assert.ok(stat&&!stat.isSymbolicLink()&&(directory?stat.isDirectory():stat.isFile()));
    const row=Object.fromEntries(['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs'].map(k=>[k,stat[k]]));
    for(const k of ['dev','ino','uid','mode','nlink','size'])assert.ok(Number.isSafeInteger(row[k])&&row[k]>=0);
    assert.ok([uid,0].includes(row.uid)&&!(row.mode&0o7022));if(!directory)assert.equal(row.nlink,1);assert.ok(Number.isFinite(row.mtimeMs)&&Number.isFinite(row.ctimeMs));return row;
}
/** Installed-file consistency only. The reference is local matching-lock data, not a registry
 * attestation or observation of evaluated code. Stable owned reads must precede package load. */
export async function admitParentPackages(root,uid,lock,fs){
    const observed=[],allowed=[],entries={};let total=0;
    for(const pkg of plan.packages){
        const bound=lock.packages['node_modules/'+pkg.name];assert.ok(bound);assert.equal(bound.version,pkg.version);assert.equal(bound.integrity,pkg.integrity);const url=new URL(bound.resolved);assert.equal(url.origin,'https://registry.npmjs.org');assert.ok(!url.username&&!url.password&&!url.port&&!url.search&&!url.hash);
        const at=root+'/node_modules/'+pkg.name,expected=new Map(pkg.files.map(f=>[f.path,f]));let count=0;
        async function walk(relative=''){
            const dir=relative?at+'/'+relative:at;assert.equal(await fs.realpath(dir),dir);const before=identity(await fs.lstat(dir),uid,true),rows=await fs.readdir(dir,{withFileTypes:true}),names=new Set();
            assert.ok(Array.isArray(rows)&&rows.length<=256);for(const row of rows.sort((a,b)=>a.name.localeCompare(b.name))){
                assert.ok(typeof row.name==='string'&&row.name&&!/[\\/\x00-\x20\x7f]/.test(row.name)&&!['.','..'].includes(row.name)&&!names.has(row.name)&&!row.isSymbolicLink());names.add(row.name);
                const name=relative?relative+'/'+row.name:row.name,file=at+'/'+name;assert.ok(file.length<=4096);
                if(row.isDirectory()){assert.ok([...expected.keys()].some(k=>k.startsWith(name+'/')));await walk(name);}
                else{
                    const want=expected.get(name);assert.ok(want&&row.isFile());assert.ok(++count<=256);assert.equal(await fs.realpath(file),file);
                    const prior=identity(await fs.lstat(file),uid);assert.equal(prior.size,want.bytes);assert.ok(want.bytes<=16*1024**2);total+=want.bytes;assert.ok(total<=64*1024**2);
                    const bytes=(await readStableArtifactFile(at,name,16*1024**2,fs)).bytes;assert.equal(sourceDigest(bytes),want.sha256);assert.deepEqual(identity(await fs.lstat(file),uid),prior);
                    observed.push({path:file,bytes:bytes.length,sha256:want.sha256,identity:prior});if(pkg.parentImport&&(name.endsWith('.js')||name.endsWith('.json')))allowed.push(file);
                }
            }
            assert.deepEqual(identity(await fs.lstat(dir),uid,true),before);assert.deepEqual((await fs.readdir(dir,{withFileTypes:true})).map(v=>v.name).sort(),[...names].sort());
        }
        await walk();assert.equal(count,pkg.files.length);
        if(pkg.parentImport)entries[pkg.name]=at+'/'+pkg.entry;
    }
    observed.sort((a,b)=>a.path.localeCompare(b.path));return Object.freeze({files:observed,sha256:sourceDigest(JSON.stringify(observed)),allowed:allowed.sort(),entries,referenceSHA256:sourceDigest(JSON.stringify(plan)),loadedCodeIdentity:null,releaseAcceptance:false});
}

/** Process-private synchronous resolver, not a sandbox. Hooks stay registered until parent exit.
 * Bare parent packages are forced to admitted paths before ancestor resolution can occur. */
export function createParentPackageGuard(root,sourceRows,packages,ports){
    for(const k of ['registerHooks','isBuiltin','onFailure'])assert.equal(typeof ports[k],'function');ports=Object.freeze({...ports});
    const urls=new Map(),fixed=new Map(Object.entries(packages.entries).map(([name,file])=>[name,pathToFileURL(file).href]));
    for(const row of sourceRows)if((row.path.startsWith('scripts/lib/')||row.path==='.github/preimport-native-entry.mjs')&&row.path.endsWith('.mjs'))urls.set(pathToFileURL(root+'/'+row.path).href,'module');
    for(const file of packages.allowed)urls.set(pathToFileURL(file).href,file.endsWith('.json')?'json':'commonjs');
    let registered=false,failed=false,uncertain=false,prepared=false,resolutions=0,inFlight=0,code=null;
    const watch=value=>{if(types.isPromise(value))Promise.prototype.then.call(value,undefined,()=>{});};
    function fail(reason,unknown=false){failed=true;code??=reason;uncertain||=unknown;try{const value=ports.onFailure();watch(value);assert.equal(value,undefined);}catch{uncertain=true;}}
    const owner=Object.freeze({snapshot:()=>({registered,failed,uncertain,prepared,resolutions,inFlight,code,loadedCodeIdentity:null,wholeGroupRetirement:null,releaseAcceptance:false}),
        assertActive(){assert.ok(registered&&!failed&&!uncertain&&!prepared&&inFlight===0);},
        prepareClose(allowFailure){assert.equal(prepared,false);assert.equal(uncertain,false);assert.equal(inFlight,0);assert.ok(registered&&(allowFailure||!failed));prepared=true;},
        assertClose(){assert.ok(registered&&prepared&&!uncertain&&inFlight===0);},
    });
    function resolve(spec,context,next){
        let acknowledged=true,entered=false;
        try{
            assert.ok(registered&&!uncertain);assert.ok(++resolutions<=4096&&inFlight<16);inFlight++;entered=true;
            assert.ok(typeof spec==='string'&&spec.length<=8192&&typeof next==='function'&&context&&typeof context==='object'&&!types.isProxy(context));
            const parent=Object.getOwnPropertyDescriptor(context,'parentURL');assert.ok(parent&&Object.hasOwn(parent,'value')&&urls.has(parent.value));
            const builtin=ports.isBuiltin(spec);if(typeof builtin!=='boolean'){watch(builtin);acknowledged=false;fail('builtin-unknown',true);assert.fail('Unknown builtin classification.');}assert.ok(!prepared||builtin);
            if(fixed.has(spec)){assert.equal(prepared,false);return{url:fixed.get(spec),format:'commonjs',shortCircuit:true};}
            assert.ok(builtin||spec.startsWith('.')||spec.startsWith('file:'),'Unadmitted bare parent dependency.');
            const result=next(spec,context);watch(result);if(types.isPromise(result)||types.isProxy(result)){acknowledged=false;fail('resolve-unknown',true);throw Error('Unknown parent resolver result.');}
            if(!result||typeof result!=='object'||![null,Object.prototype].includes(Object.getPrototypeOf(result))||('then' in result)){acknowledged=false;fail('resolve-unknown',true);throw Error('Unsupported resolver acknowledgement.');}const descriptors=Object.getOwnPropertyDescriptors(result);for(const [name,d]of Object.entries(descriptors))assert.ok(['url','format','shortCircuit','importAttributes'].includes(name)&&Object.hasOwn(d,'value'));assert.ok(Reflect.ownKeys(descriptors).every(k=>typeof k==='string'));assert.ok(result.shortCircuit===undefined||typeof result.shortCircuit==='boolean');if(result.importAttributes!==undefined){const attrs=result.importAttributes;assert.ok(attrs&&typeof attrs==='object'&&!types.isProxy(attrs)&&[null,Object.prototype].includes(Object.getPrototypeOf(attrs)));const keys=Object.getOwnPropertyDescriptors(attrs);assert.ok(Object.keys(keys).length<=16);for(const [key,d]of Object.entries(keys))assert.ok(key.length<=256&&Object.hasOwn(d,'value')&&typeof d.value==='string'&&d.value.length<=256);}
            assert.equal(typeof result.url,'string');assert.ok(result.url.length<=8192);
            if(builtin){assert.equal(result.url,spec.startsWith('node:')?spec:'node:'+spec);assert.ok(result.format===undefined||result.format==='builtin');}
            else{assert.ok(urls.has(result.url));assert.ok(result.format===undefined||result.format===urls.get(result.url));}
            return result;
        }catch(error){fail('resolution-rejected');throw error;}finally{if(entered&&acknowledged)inFlight--;}
    }
    try{
        const h=ports.registerHooks({resolve});watch(h);assert.ok(h&&typeof h==='object'&&!types.isPromise(h)&&!types.isProxy(h));const proto=Object.getPrototypeOf(h);assert.ok(!types.isProxy(proto));const d=Object.getOwnPropertyDescriptor(h,'deregister')??Object.getOwnPropertyDescriptor(proto??{},'deregister');assert.ok(d&&Object.hasOwn(d,'value')&&typeof d.value==='function'&&!('then' in h));assert.ok(!failed&&!uncertain);registered=true;
    }catch(cause){fail('registration-unknown',true);throw Object.assign(Error('Parent loader admission failed.',{cause}),{owner});}
    return owner;
}
