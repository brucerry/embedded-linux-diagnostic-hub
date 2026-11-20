'use strict';

// Observe only this job's staged provider projection and prospective producer paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { observeTempSource, planCapacity } = require('./linux-provider-capacity.cjs');

function verified(file, hash, limit = 1 << 20) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd, { bigint: true });
        assert(fs.realpathSync(file) === file && before.isFile() && before.nlink === 1n &&
            (before.uid === 0n || before.uid === BigInt(process.getuid())) && (before.mode & 0o7022n) === 0n &&
            before.size > 0n && before.size <= BigInt(limit));
        const bytes = fs.readFileSync(fd);
        const after = fs.statSync(file, { bigint: true });
        for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
        assert(bytes.length === Number(before.size) && createHash('sha256').update(bytes).digest('hex') === hash);
        return bytes.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function measure(dir) {
    assert.equal(fs.realpathSync(dir), dir);
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
        const target = '/proc/' + process.pid + '/fd/' + fd;
        assert.equal(fs.realpathSync(target),dir);
        const stat = fs.fstatSync(fd,{bigint:true});
        const counters = execFileSync('/usr/bin/stat',['-f','-c','%S %a','--',target],{
            encoding:'utf8',timeout:4000,maxBuffer:256,env:{PATH:'/usr/bin:/bin',LANG:'C'}
        }).trim();
        assert.match(counters,/^[1-9][0-9]{0,14} [0-9]{1,16}$/);
        const [block,freeBlocks] = counters.split(' ').map(BigInt);
        const end = fs.statSync(dir,{bigint:true});
        assert(stat.isDirectory() && end.dev === stat.dev && end.ino === stat.ino);
        return {dev:stat.dev,block,free:block*freeBlocks};
    } finally {
        fs.closeSync(fd);
    }
}

async function inspect(root, inherited = process.env) {
    const uid = process.getuid();
    assert(process.version === 'v24.22.2' && uid > 0 && uid === process.geteuid()
        && process.arch === 'x64' && fs.realpathSync(root) === root);
    assert.equal(process.execPath,path.join(root,'tool/node'));
    const config = JSON.parse(verified(path.join(__dirname,'linux-all-eight-inputs.json'),
        '2df7ede2f96b922bf2b4f239223c7ad8f00f9dcfafdf810a8a5c730aba147c7d'));
    const projection = path.join(root,'projection/node_modules');
    const packPath = path.join(projection,'app-builder-lib/out/packager.js');
    const pack = verified(packPath,'ab050d70831c07fccb83261f3fa1815f57876b5daeff5e9d9b54471c8166464c');
    const archive = verified(path.join(projection,'app-builder-lib/out/targets/archive.js'),
        'ba5047276b5847b3b19b8e4850fed564c659289af518c15866dc9fbbb5327590');
    assert.match(pack,/this\.tempDirManager = new builder_util_1\.TmpDir\("packager"\)/);
    assert.match(archive,/tempDirManager\.getTempFile\(\{ suffix: "\.tar" \}\)/);
    const utilPath = createRequire(packPath).resolve('builder-util');
    assert.equal(utilPath,path.join(projection,'builder-util/out/util.js'));
    const util = verified(utilPath,'83ef1efb33f18337c52d70f5413182da064e7b2e5a3fe3f3a5dbb9b0e4018e76');
    assert.match(util,/require\("temp-file"\)/);
    const tempPath = createRequire(utilPath).resolve('temp-file');
    assert.equal(tempPath,path.join(projection,'temp-file/out/main.js'));
    const temp = verified(tempPath,'c4bce3ea8cff4c0f4db72ddfddd070932032994497468c49cf0644d7264dc6c2');
    // The no-overrides job supplies a private TMPDIR, not APP_BUILDER_TMP_DIR.
    // observeTempSource also models the helper's documented override branch.
    const effectiveTemp = await observeTempSource(temp,inherited,os.tmpdir());
    assert.equal(effectiveTemp,path.join(root,'builder-tmp'));
    const archiveOut = path.join(root,'release');
    const headers = path.resolve(path.dirname(process.execPath),'../include/node');
    for (const [name,pin] of Object.entries(config.headers)) {
        assert.equal(Buffer.byteLength(verified(path.join(root,name),pin.sha256)),pin.bytes);
    }
    const nativeOut = path.join(root,'dist-linux-native');
    assert(!fs.existsSync(nativeOut));
    const ruleSets = [];
    for (const [name,pin] of Object.entries(config.rules)) {
        const file = path.join(root,name);
        verified(file,pin.sha256);
        ruleSets.push(await import(pathToFileURL(file)));
    }
    const [{ LINUX_ARCHIVE_LIMITS: a },{ linuxNativeBuildAncestorCategory: ancestry }] = ruleSets;
    const tarBytes = BigInt(a.payload+a.entries*512+a.files*511+a.endPadding);
    const archiveBytes = BigInt(a.compressed);
    const plan = planCapacity(measure(path.dirname(nativeOut)),measure(effectiveTemp),measure(archiveOut),tarBytes,archiveBytes);
    const nativeOutputAncestor = ancestry(path.dirname(nativeOut),uid);
    const nativeHeaderAncestor = ancestry(headers,uid);
    return {...plan, nativeOutputAncestor,nativeHeaderAncestor,
        nativeAncestorPass:nativeOutputAncestor === 'accepted' && nativeHeaderAncestor === 'accepted',
        tarBytes,archiveBytes, tempSelection:inherited.APP_BUILDER_TMP_DIR ? 'APP_BUILDER_TMP_DIR' : 'os.tmpdir',
        projectedLockSHA256:config.linuxLockSHA256,fullLockInstalled:false,
        producerFileLimitsEnforced:false, bytesAreConsumerCaps:true};
}

module.exports = { inspect, measure };
if (require.main === module) {
    assert.equal(process.argv.length,3);
    inspect(process.argv[2]).then(value => {
        console.log(JSON.stringify(value,(_key,x) => typeof x === 'bigint' ? x.toString() : x));
    },() => {
        console.error('capacity-observation-refused');
        process.exitCode = 1;
    });
}
