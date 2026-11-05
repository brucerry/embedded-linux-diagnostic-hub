import assert from 'node:assert/strict';
import path from 'node:path';
import { readStableArtifactFile } from './stable-artifact-file.mjs';
import { isExactInstrumentedText } from './instrumented-gateway-files.mjs';
import { sourceDigest } from './committed-source-bridge.mjs';

export const INSTRUMENTED_CENSUS_BOUNDS = Object.freeze({ files: 512, entries: 4096, depth: 32, fileBytes: 32 * 1024 ** 2, totalBytes: 64 * 1024 ** 2 });
const failures = new WeakMap();
export function instrumentedCensusFailure(error) { return failures.get(error) ?? null; }
const legacyRootFiles = ['activate.cjs', 'resolution-guard.cjs', 'ownership.cjs', 'package.json', 'package-lock.json'];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function identity(s, kind, uid) {
    assert.ok(s && !s.isSymbolicLink() && (kind === 'directory' ? s.isDirectory() : s.isFile()));
    const row = Object.fromEntries(['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs'].map(k=>[k,s[k]]));
    for (const k of ['dev','ino','uid','mode','nlink','size']) assert.ok(Number.isSafeInteger(row[k]) && row[k] >= 0);
    assert.ok([uid,0].includes(row.uid) && !(row.mode & 0o7022));
    assert.ok(Number.isFinite(row.mtimeMs) && Number.isFinite(row.ctimeMs));
    if (kind === 'file') assert.equal(row.nlink,1);
    return row;
}
/** Complete, prelaunch two-pass byte census, not a report of files actually compiled. Every regular
 * file remains in the byte/metadata inventory, including binary package data. Only exact UTF-8
 * candidates enter the Inspector map; an observed URL outside that map still fails. Native ports only.
 */
export async function censusInstrumentedGateway(root, uid, filesystem, layout = 'legacy') {
    assert.ok(['legacy','preimport-v1'].includes(layout));
    const rootFiles=layout==='preimport-v1'?[...legacyRootFiles,'preimport.mjs']:legacyRootFiles;
    let phase='root';
    try {
    assert.ok(typeof root === 'string' && root.startsWith('/') && path.posix.normalize(root) === root && Buffer.byteLength(root) <= 4096 && !/[\\\x00-\x20\x7f]/.test(root));
    assert.ok(Number.isSafeInteger(uid) && uid >= 0);
    const files = new Map(), scripts = new Map();
    async function pass(retain) {
        const inventory = [], directories = [], inodes = new Set(); let total = 0, entries = 0;
        async function walk(relative = '', depth = 0) {
            assert.ok(depth <= INSTRUMENTED_CENSUS_BOUNDS.depth);
            phase='directory';
            const at = relative ? root + '/' + relative : root; assert.ok(Buffer.byteLength(at) <= 4096);
            assert.equal(await filesystem.realpath(at),at);
            const before=identity(await filesystem.lstat(at),'directory',uid), rows=await filesystem.readdir(at,{withFileTypes:true});
            assert.ok(Array.isArray(rows) && rows.length <= INSTRUMENTED_CENSUS_BOUNDS.entries);
            const names=new Set();
            for(const row of rows.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)) {
                assert.ok(++entries <= INSTRUMENTED_CENSUS_BOUNDS.entries);
                assert.ok(typeof row.name==='string' && row.name && !/[\\/\x00-\x20\x7f]/.test(row.name) && !['.','..'].includes(row.name) && row.name.normalize('NFC')===row.name && !names.has(row.name));
                names.add(row.name);assert.equal(row.isSymbolicLink(),false);
                const name=relative?relative+'/'+row.name:row.name, full=root+'/'+name;
                assert.ok(Buffer.byteLength(full)<=4096);
                if(!relative) assert.ok(row.isDirectory()?row.name==='node_modules':rootFiles.includes(row.name),'Unexpected or credential-bearing root path.');
                if(row.isDirectory()) await walk(name,depth+1);
                else {
                    phase='file-identity';
                    assert.ok(row.isFile() && !name.endsWith('.node') && inventory.length<INSTRUMENTED_CENSUS_BOUNDS.files);
                    assert.equal(await filesystem.realpath(full),full);
                    const beforeFile=identity(await filesystem.lstat(full),'file',uid);
                    assert.ok(beforeFile.size<=INSTRUMENTED_CENSUS_BOUNDS.fileBytes && total+beforeFile.size<=INSTRUMENTED_CENSUS_BOUNDS.totalBytes);
                    const inode=beforeFile.dev+':'+beforeFile.ino;assert.ok(!inodes.has(inode));inodes.add(inode);
                    phase='file-read';
                    const bytes=(await readStableArtifactFile(root,name,INSTRUMENTED_CENSUS_BOUNDS.fileBytes,filesystem)).bytes;
                    assert.deepEqual(identity(await filesystem.lstat(full),'file',uid),beforeFile);
                    total+=bytes.length;
                    inventory.push({path:full,bytes:bytes.length,sha256:sourceDigest(bytes),identity:beforeFile});
                    if(retain) { const copy=Buffer.from(bytes);files.set(full,copy);if(isExactInstrumentedText(copy)) scripts.set(full,copy); }
                }
            }
            phase='directory-verification';
            assert.deepEqual(identity(await filesystem.lstat(at),'directory',uid),before);
            const after=await filesystem.readdir(at,{withFileTypes:true});assert.ok(Array.isArray(after));
            assert.deepEqual(after.map(r=>r.name).sort(),[...names].sort());
            directories.push({path:at,identity:before});
        }
        await walk();inventory.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);directories.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
        return {inventory,directories,totalBytes:total};
    }
    const first=await pass(true), second=await pass(false);phase='two-pass-verification';assert.deepEqual(second,first,'Instrumented installation changed during prelaunch census.');
    phase='layout';
    for(const name of rootFiles)assert.ok(scripts.has(root+'/'+name),'Missing instrumented layout entry.');
    const lockBytes=scripts.get(root+'/package-lock.json'), packageBytes=scripts.get(root+'/package.json');
    assert.ok(lockBytes.length<=1024**2 && packageBytes.length<=1024**2);
    const lock=JSON.parse(decoder.decode(lockBytes)), manifest=JSON.parse(decoder.decode(packageBytes));
    assert.equal(lock.lockfileVersion,3);assert.ok(lock.packages && typeof lock.packages==='object' && !Array.isArray(lock.packages));
    const required=Object.keys(lock.packages).filter(p=>p&&!lock.packages[p].optional).sort();assert.ok(required.length>0&&required.length<=128);
    for(const name of required) {
        assert.match(name,/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
        const bytes=scripts.get(root+'/'+name+'/package.json');assert.ok(bytes&&bytes.length<=1024**2);
        const pkg=JSON.parse(decoder.decode(bytes));assert.equal(pkg.name,name.slice('node_modules/'.length));assert.equal(pkg.version,lock.packages[name].version);
    }
    for(const row of first.inventory) {
        const name=row.path.slice(root.length+1);
        if(name.startsWith('node_modules/') && name!=='node_modules/.package-lock.json')
            assert.ok(required.some(p=>name.startsWith(p+'/')&&!name.slice(p.length+1).split('/').includes('node_modules')),'Optional, nested override or extraneous installed package.');
    }
    for(const {path:directory} of first.directories){const name=directory.slice(root.length+1);
        assert.ok(directory===root||name==='node_modules'||required.some(p=>name===p||(p.startsWith(name+'/')&&name.startsWith('node_modules/@'))||(name.startsWith(p+'/')&&!name.slice(p.length+1).split('/').includes('node_modules'))),'Unexpected installed directory.');}
    assert.equal(lock.packages[''].name,manifest.name);assert.equal(lock.packages[''].version,manifest.version);
    const inventory=first.inventory.map(({path,bytes,sha256})=>({path,bytes,sha256}));
    const scriptInventory=inventory.filter(row=>scripts.has(row.path));
    return Object.freeze({files,scripts,inventory,inventorySHA256:sourceDigest(JSON.stringify(inventory)),scriptInventory,scriptInventorySHA256:sourceDigest(JSON.stringify(scriptInventory)),
        census: first,censusSHA256:sourceDigest(JSON.stringify(first)),lockSHA256:sourceDigest(lockBytes),packageSHA256:sourceDigest(packageBytes)});
    } catch(cause) { const error=Error('Instrumented census failed; no path or content in diagnostic code.',{cause});failures.set(error,phase);throw error; }
}
