import assert from 'node:assert/strict';
import path from 'node:path';
import { constants } from 'node:fs';
import { createOwnedWebFiles } from './owned-web-files.mjs';
import { readStableArtifactFile } from './web-archive-producer.mjs';
import { sourceDigest } from './committed-source-bridge.mjs';
import { snapshotPreparedInstrumentedGateway } from './instrumented-gateway-check.mjs';
import { INSTRUMENTED_CHILD_INPUT_LIMIT, runOwnedInstrumentedGatewayChild } from './instrumented-gateway-child.mjs';

const retained = new Set();
const modes = ['compatibility', 'ownership'];
function fileIdentity(stat, uid, directory = false) {
    assert.ok(stat && !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()));
    const v = Object.fromEntries(['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs'].map(k => [k,stat[k]]));
    for (const k of ['dev','ino','uid','mode','nlink','size']) assert.ok(Number.isSafeInteger(v[k]) && v[k] >= 0);
    assert.ok([uid,0].includes(v.uid) && !(v.mode & 0o7022));
    assert.ok(Number.isFinite(v.mtimeMs) && Number.isFinite(v.ctimeMs));
    if (!directory) assert.equal(v.nlink,1);
    return v;
}
/** Native-port wiring, not a serialized grant or implicit launcher. Factory construction performs
 * no IO. run() admits exactly one sequential pair on the copied prepared bytes. Native primitives
 * are supplied only by the inert non-shipping entry; tests substitute fake filesystem/child ports.
 */
export function createInstrumentedGatewayParent(prepared, host) {
    const selected = snapshotPreparedInstrumentedGateway(prepared), root = path.posix.dirname(selected.selection.artifactPath), parent = path.posix.dirname(root);
    assert.ok(root.endsWith('/validation/gateway-ownership/instrumented'));
    const runtime = structuredClone(host.runtime);
    assert.deepEqual(Object.keys(runtime).sort(), ['arch','execArgv','execPath','nodeOptions','nodePathVariable','platform','uid','version']);
    assert.equal(runtime.platform,'linux'); assert.equal(runtime.arch,'x64'); assert.equal(runtime.version,'v24.22.0');
    assert.deepEqual(runtime.execArgv,[]); assert.equal(runtime.nodeOptions,null); assert.equal(runtime.nodePathVariable,null);
    assert.ok(Number.isSafeInteger(runtime.uid) && runtime.uid > 0); assert.equal(runtime.execPath,selected.binding.toolchain.nodePath);
    for (const key of ['launch','setTimer','clearTimer','now']) assert.equal(typeof host[key],'function');
    const native = Object.freeze({ ...host, filesystem: Object.freeze({ ...host.filesystem }) });
    const inputs = new Map(), inputPaths = new Map(modes.map(mode => [parent+'/child-input-'+mode+'.json',mode]));
    let phase = 'prepared', admitted = false, completed = false, primary, nodeIdentity, nodeFileIdentity, launches = 0;
    const inside = p => typeof p === 'string' && (p === root || p.startsWith(root+'/')) && path.posix.normalize(p) === p;
    const readPath = p => assert.ok(inside(p) || p === runtime.execPath || inputPaths.has(p));
    const metadataPath = p => assert.ok(inside(p) || p === parent || p === runtime.execPath || p === path.dirname(runtime.execPath) || inputPaths.has(p));
    const fixedNative = {
        realpath: p => { metadataPath(p); return native.filesystem.realpath(p); },
        lstat: p => { metadataPath(p); return native.filesystem.lstat(p); },
        mkdir: () => { throw Error('Parent wiring cannot create or adopt a staging namespace.'); },
        opendir: p => { assert.ok(inside(p)); return native.filesystem.opendir(p); },
        async open(p, flags) {
            const writing = flags === (constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
            if (!writing) {
                if (flags & constants.O_DIRECTORY) assert.equal(p,parent);
                else { readPath(p); assert.equal(flags,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
                return native.filesystem.open(p,flags);
            }
            const record = inputs.get(p); assert.ok(record && record.phase === 'writing' && inputPaths.get(p) === phase);
            const handle = await native.filesystem.open(p,flags);
            // Capture identity from the actual exclusive write descriptor before its close. Bind
            // methods explicitly; native FileHandle methods are prototype methods, not spread data.
            return {
                read: (...args) => handle.read(...args), write: (...args) => handle.write(...args),
                sync: () => handle.sync(), close: () => handle.close(),
                async stat() {
                    const stat = await handle.stat(), identity = fileIdentity(stat,runtime.uid);
                    assert.equal(identity.size,record.bytes); assert.equal(record.descriptorIdentity,null);
                    record.descriptorIdentity = identity; return stat;
                },
            };
        },
    };
    const owned = createOwnedWebFiles(fixedNative), filesystem = owned.filesystem;
    const ports = {
        filesystem,
        async observeNode() {
            assert.equal(await filesystem.realpath(runtime.execPath),runtime.execPath);
            const before = fileIdentity(await filesystem.lstat(runtime.execPath),runtime.uid);
            const bytes = (await readStableArtifactFile(path.dirname(runtime.execPath),path.basename(runtime.execPath),128*1024**2,filesystem)).bytes;
            assert.deepEqual(fileIdentity(await filesystem.lstat(runtime.execPath),runtime.uid),before);
            const actual = { path:runtime.execPath,sha256:sourceDigest(bytes),version:runtime.version,execArgv:[...runtime.execArgv],nodeOptions:null };
            assert.equal(actual.sha256,selected.binding.toolchain.nodeSHA256);
            if (nodeIdentity) { assert.deepEqual(actual,nodeIdentity); assert.deepEqual(before,nodeFileIdentity); }
            else { nodeIdentity = actual; nodeFileIdentity = before; }
            owned.owner.assertSettled(); return structuredClone(actual);
        },
        async writeExclusive(file, bytes) {
            assert.equal(inputPaths.get(file),phase); assert.equal(inputs.has(file),false);
            assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= INSTRUMENTED_CHILD_INPUT_LIMIT);
            const record = { phase:'writing',bytes:bytes.length,sha256:sourceDigest(bytes),descriptorIdentity:null };
            inputs.set(file,record); // Before the first awaited acquisition; no retry or adoption.
            assert.equal(await filesystem.realpath(parent),parent);
            fileIdentity(await filesystem.lstat(parent),runtime.uid,true);
            await filesystem.writeFile(file,bytes,{flag:'wx'});
            assert.ok(record.descriptorIdentity);
            assert.deepEqual(fileIdentity(await filesystem.lstat(file),runtime.uid),record.descriptorIdentity);
            owned.owner.assertSettled(); record.phase = 'acknowledged';
        },
        async readInput(file, maximum) {
            assert.equal(inputPaths.get(file),phase); assert.equal(maximum,INSTRUMENTED_CHILD_INPUT_LIMIT);
            const record = inputs.get(file); assert.ok(record && record.phase === 'acknowledged');
            assert.deepEqual(fileIdentity(await filesystem.lstat(file),runtime.uid),record.descriptorIdentity);
            const bytes = (await readStableArtifactFile(parent,path.basename(file),maximum,filesystem)).bytes;
            assert.deepEqual(fileIdentity(await filesystem.lstat(file),runtime.uid),record.descriptorIdentity);
            assert.equal(bytes.length,record.bytes); assert.equal(sourceDigest(bytes),record.sha256);
            owned.owner.assertSettled(); return bytes;
        },
        launch(file,args,options) {
            assert.ok(modes.includes(phase) && launches === modes.indexOf(phase));
            assert.equal(file,runtime.execPath); assert.deepEqual(args,[root+'/activate.cjs',parent+'/child-input-'+phase+'.json']);
            assert.deepEqual(options,{cwd:root,env:{PATH:path.dirname(runtime.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',NODE_ENV:'production'},shell:false,stdio:['ignore','pipe','pipe']});
            owned.owner.assertSettled(); launches++; // Before uncertain native launch; never retry.
            return native.launch(file,[...args],structuredClone(options));
        },
        setTimer(callback,ms) { assert.equal(ms,60000); return native.setTimer(callback,ms); },
        clearTimer: timer => native.clearTimer(timer), now: () => native.now(),
        assertFilesSettled: () => { owned.owner.assertSettled(); },
    };
    const snapshot = () => ({ phase,admitted,completed,failed:Boolean(primary),launches,
        inputs:[...inputs.values()].map(v => ({phase:v.phase,descriptorIdentityObserved:Boolean(v.descriptorIdentity)})),
        files:owned.owner.snapshot(),wholeGroupRetirement:null,releaseAcceptance:false });
    const owner = Object.freeze({ snapshot, async run() {
        assert.equal(admitted,false); admitted = true; phase = 'compatibility'; retained.add(owner);
        try {
            const compatibility = await runOwnedInstrumentedGatewayChild(selected,'compatibility',runtime.uid,ports);
            owned.owner.assertSettled(); phase = 'ownership';
            const ownership = await runOwnedInstrumentedGatewayChild(selected,'ownership',runtime.uid,{...ports,compatibility});
            owned.owner.assertSettled(); assert.equal(launches,2);
            const receipt = { schema:'native-parent-instrumented-gateway-pair-v1',status:'separate-instrumented-pair-directly-closed',
                source:selected.binding.source,bindingSHA256:sourceDigest(JSON.stringify(selected.binding)+'\n'),
                compatibility:compatibility.receipt,ownership:ownership.receipt,inputsAcknowledged:2,
                processGroupRetirement:null,shippingCLIBehavior:null,releaseAcceptance:false };
            const bytes = Buffer.from(JSON.stringify(receipt)+'\n'); assert.ok(bytes.length<=16384);
            selected.scripts.clear(); completed = true; phase = 'completed'; retained.delete(owner);
            return Object.freeze({receipt,bytes});
        } catch(error) {
            primary = error; phase = 'failed';
            throw Object.assign(Error('Native instrumented Gateway parent failed; no retry or forced cleanup.',{cause:error}),{owner});
        }
    } });
    return owner;
}
