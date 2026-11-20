'use strict';

// Read-only checks for a later producer after its complete build inputs are
// installed and staged. This script never creates a tar or starts a packer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const FOUR_GIB = 4n * 1024n ** 3n;
const digest = b => createHash('sha256').update(b).digest('hex');
function checked(file, sha) {
    assert.equal(fs.realpathSync(file),file);
    const st=fs.lstatSync(file);
    assert.ok(st.isFile() && st.nlink===1 && (st.uid===0 || st.uid===process.getuid()) && !(st.mode&0o7022));
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try {
        const own=fs.fstatSync(fd);
        assert.deepEqual([own.dev,own.ino,own.size,own.mode],[st.dev,st.ino,st.size,st.mode]);
        const bytes=fs.readFileSync(fd);
        const after=fs.fstatSync(fd);
        assert.deepEqual([after.size,after.mtimeMs,after.ctimeMs],[own.size,own.mtimeMs,own.ctimeMs]);
        assert.equal(digest(bytes),sha);
        return bytes.toString('utf8');
    } finally { fs.closeSync(fd); }
}

function measure(directory) {
    const canonical=fs.realpathSync(directory);
    fs.accessSync(canonical,fs.constants.W_OK|fs.constants.X_OK);
    const fd=fs.openSync(canonical,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try {
        const stat=fs.fstatSync(fd,{bigint:true});
        const witness='/proc/self/fd/'+fd;
        assert.equal(fs.realpathSync(witness),canonical);
        // GNU stat %S is the fundamental block size and %a excludes reserved
        // blocks. The child reads the still-open parent descriptor's target.
        const counters=execFileSync('/usr/bin/stat',['-f','-c','%S %a','--',
            '/proc/'+process.pid+'/fd/'+fd],{encoding:'utf8',timeout:4000,maxBuffer:256,
            env:{PATH:'/usr/bin:/bin',LANG:'C'}}).trim();
        assert.match(counters,/^[1-9][0-9]{0,14} [0-9]{1,16}$/);
        const [block,freeBlocks]=counters.split(' ').map(BigInt);
        const after=fs.statSync(canonical,{bigint:true});
        assert.ok(stat.isDirectory() && after.dev===stat.dev && after.ino===stat.ino);
        return {dev:stat.dev,block,free:block*freeBlocks};
    } finally { fs.closeSync(fd); }
}

// Evaluate the exact verified helper with only three inert dependency stubs.
// The real helper chooses the mkdtemp prefix and .tar pathname. The stub does
// not create a directory or register a callback on the actual process.
async function observeTempSource(source, env, defaultTmp) {
    const exports={};
    const calls=[];
    vm.runInNewContext(source,{
        exports,process:{env,pid:1},
        require(id) {
            if(id==='path') return path;
            if(id==='os') return {tmpdir:()=>defaultTmp};
            if(id==='async-exit-hook') return () => {};
            assert.equal(id,'fs-extra');
            return {
                mkdtemp:async prefix=>{calls.push(prefix);return prefix+'sample';},
                realpath:async p=>p,
            };
        }
    },{timeout:1000,codeGeneration:{strings:false,wasm:false}});
    const temporary=await new exports.TmpDir('packager').getTempFile({suffix:'.tar'});
    assert.equal(calls.length,1);
    assert.equal(path.basename(calls[0]),'t-');
    assert.equal(path.dirname(temporary),calls[0]+'sample');
    assert.equal(path.extname(temporary),'.tar');
    return path.dirname(calls[0]);
}

function planCapacity(workspace, temporary, output, tarBytes, finalBytes) {
    assert.ok(tarBytes>0n && finalBytes>0n);
    const groups=new Map();
    for(const [role, info, bytes] of [
        ['workspace',workspace,0n],['intermediate',temporary,tarBytes],['final',output,finalBytes],
    ]) {
        assert.ok(info.block>0n && info.free>=0n);
        const charge=((bytes+info.block-1n)/info.block)*info.block;
        const prior=groups.get(info.dev)??{roles:[],available:info.free,required:0n};
        prior.roles.push(role);
        prior.required+=charge;
        if(info.free<prior.available) prior.available=info.free;
        groups.set(info.dev,prior);
    }
    return {
        nativeReservePass: workspace.free>=FOUR_GIB,
        packagingBytesFit: [...groups.values()].every(x=>x.available>=x.required),
        storage:[...groups.values()],
    };
}

async function inspect(project,out) {
    assert.ok(path.isAbsolute(project) && path.isAbsolute(out));
    assert.equal(fs.realpathSync(project),project);
    assert.equal(process.version,'v24.22.2');
    const lock=JSON.parse(checked(path.join(project,'package-lock.json'),
        '65661b582a0c5d1c1291915da1c722210d4a949dfac9ba4d643cdfb3c6d5bc80'));
    assert.equal(lock.packages['node_modules/temp-file'].version,'3.4.0');
    const lib=path.join(project,'node_modules/app-builder-lib');
    const packager=path.join(lib,'out/packager.js');
    const pack=checked(packager,'ab050d70831c07fccb83261f3fa1815f57876b5daeff5e9d9b54471c8166464c');
    const archive=checked(path.join(lib,'out/targets/archive.js'),
        'ba5047276b5847b3b19b8e4850fed564c659289af518c15866dc9fbbb5327590');
    assert.match(pack,/this\.tempDirManager = new builder_util_1\.TmpDir\("packager"\)/);
    assert.match(archive,/tempDirManager\.getTempFile\(\{ suffix: "\.tar" \}\)/);
    const util=requireResolved(packager,'builder-util');
    const utilSource=checked(util,'83ef1efb33f18337c52d70f5413182da064e7b2e5a3fe3f3a5dbb9b0e4018e76');
    assert.match(utilSource,/require\("temp-file"\)/);
    const resolved=requireResolved(util,'temp-file');
    assert.equal(resolved,path.join(project,'node_modules/temp-file/out/main.js'));
    const source=checked(resolved,'c4bce3ea8cff4c0f4db72ddfddd070932032994497468c49cf0644d7264dc6c2');
    const effective=path.resolve(project,await observeTempSource(source,process.env,os.tmpdir()));
    const rules=path.join(project,'scripts/lib/linux-archive-members.mjs');
    const guard=path.join(project,'scripts/lib/linux-native-build-ancestors.mjs');
    checked(rules,'2fe87a75f393db9e35642f34831aac6180009448c0f0487465b7342d12bbcc1d');
    checked(guard,'ff626c5a37c052c42c54ede7d1ecb86df9ee65a8745f0fca02c75a3b400531a5');
    const { LINUX_ARCHIVE_LIMITS: a }=await import(pathToFileURL(rules));
    const { linuxNativeBuildAncestorCategory: ancestry }=await import(pathToFileURL(guard));
    const tarBytes=BigInt(a.payload+a.entries*512+a.files*511+a.endPadding);
    const finalBytes=BigInt(a.compressed);
    const uid=process.getuid();
    assert.ok(uid>0 && uid===process.geteuid());
    const plan=planCapacity(measure(project),measure(effective),measure(out),tarBytes,finalBytes);
    const nodeHeaders=path.resolve(path.dirname(process.execPath),'../include/node');
    const nativeOutputAncestor=ancestry(project,uid);
    const nativeHeaderAncestor=ancestry(nodeHeaders,uid);
    return {...plan, nativeOutputAncestor,nativeHeaderAncestor, tarBytes,finalBytes,
        tempSelection:process.env.APP_BUILDER_TMP_DIR?'APP_BUILDER_TMP_DIR':'os.tmpdir',
        bytesAreConsumerCaps:true, producerFileLimitsEnforced:false};
}

function requireResolved(from,name) {
    return createRequire(from).resolve(name);
}

module.exports={observeTempSource,planCapacity,inspect};
if(require.main===module) {
    assert.equal(process.argv.length,4);
    inspect(process.argv[2],process.argv[3]).then(report=>{
        console.log(JSON.stringify(report,(_key,value)=>typeof value==='bigint'?value.toString():value,2));
        if(!report.nativeReservePass || !report.packagingBytesFit ||
            report.nativeOutputAncestor!=='accepted' || report.nativeHeaderAncestor!=='accepted') process.exitCode=2;
    }).catch(error=>{console.error(error);process.exitCode=1;});
}
