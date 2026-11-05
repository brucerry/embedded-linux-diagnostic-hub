import assert from 'node:assert/strict';
import {validateInstrumentedChildFailure} from './instrumented-gateway-failure.mjs';
import {claimPreimportCompatibilityBuild} from './instrumented-gateway-preimport-build.mjs';
import {preimportReceiptIdentity,readPreimportCompatibilityReceipt,PREIMPORT_RECEIPT_MARKER} from './instrumented-gateway-preimport-receipt.mjs';
import {PREIMPORT_INPUT_LIMIT} from './instrumented-gateway-preimport.mjs';
import {startDiagnosticGatewayCommand} from './diagnostic-gateway-command.mjs';
import {types} from 'node:util';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import { constants } from 'node:fs';
import { createOwnedWebFiles } from './owned-web-files.mjs';
import { readStableArtifactFile } from './stable-artifact-file.mjs';
import { sourceDigest } from './committed-source-bridge.mjs';
import { snapshotPreparedInstrumentedGateway } from './instrumented-gateway-snapshot.mjs';
import {censusInstrumentedGateway} from './instrumented-gateway-census.mjs';


const retained = new Set();
const modes=['compatibility'];
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
 * no IO. run() admits exactly one compatibility child on the copied two-artifact bytes. Native primitives
 * are supplied only by the inert non-shipping entry; tests substitute fake filesystem/child ports.
 */
export function createPreimportCompatibilityParent(admission, host) {
    const admittedBuild=claimPreimportCompatibilityBuild(admission);
    const selected = snapshotPreparedInstrumentedGateway(admittedBuild.prepared), root = path.posix.dirname(selected.selection.artifactPath), parent = path.posix.dirname(root);
    assert.ok(root.endsWith('/validation/gateway-ownership/instrumented'));assert.equal(selected.binding.kind,'separate-preimport-gateway-build-byte-binding-v5');
    const runtime = structuredClone(host.runtime);
    assert.deepEqual(Object.keys(runtime).sort(), ['arch','execArgv','execPath','nodeOptions','nodePathVariable','platform','uid','version']);
    assert.equal(runtime.platform,'linux'); assert.equal(runtime.arch,'x64'); assert.equal(runtime.version,'v24.22.0');
    assert.deepEqual(runtime.execArgv,[]); assert.equal(runtime.nodeOptions,null); assert.equal(runtime.nodePathVariable,null);
    assert.ok(Number.isSafeInteger(runtime.uid) && runtime.uid > 0);assert.equal(runtime.uid,admittedBuild.uid); assert.equal(runtime.execPath,selected.binding.toolchain.nodePath);
    for (const key of ['launch','setTimer','clearTimer','now']) assert.equal(typeof host[key],'function');
    const native = Object.freeze({ ...host, filesystem: Object.freeze({ ...host.filesystem }) });
    const inputs = new Map(), inputPaths = new Map(modes.map(mode => [parent+'/preimport-input-'+mode+'.json',mode]));
    let phase = 'prepared', admitted = false, completed = false, primary, failedAt=null, childFailure=null, rawChild, pendingAbsence=0, failureRetired=false, joinIssued=false, nodeIdentity, nodeFileIdentity, launches = 0;
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
            assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= PREIMPORT_INPUT_LIMIT);
            pendingAbsence++;let observed=false;
            try{const query=native.filesystem.lstat(file);assert.ok(types.isPromise(query));try{await query;observed=true;assert.fail('Existing challenge cannot be adopted.');}catch(error){observed=true;assert.equal(error?.code,'ENOENT');}}finally{if(observed)pendingAbsence--;}
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
            assert.equal(inputPaths.get(file),phase); assert.equal(maximum,PREIMPORT_INPUT_LIMIT);
            const record = inputs.get(file); assert.ok(record && record.phase === 'acknowledged');
            assert.deepEqual(fileIdentity(await filesystem.lstat(file),runtime.uid),record.descriptorIdentity);
            const bytes = (await readStableArtifactFile(parent,path.basename(file),maximum,filesystem)).bytes;
            assert.deepEqual(fileIdentity(await filesystem.lstat(file),runtime.uid),record.descriptorIdentity);
            assert.equal(bytes.length,record.bytes); assert.equal(sourceDigest(bytes),record.sha256);
            owned.owner.assertSettled(); return bytes;
        },
        launch(file,args,options) {
            assert.ok(modes.includes(phase) && launches === modes.indexOf(phase));
            assert.equal(file,runtime.execPath); assert.deepEqual(args,[root+'/activate.cjs',parent+'/preimport-input-'+phase+'.json']);
            assert.deepEqual(options,{cwd:root,env:{PATH:path.dirname(runtime.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',NODE_ENV:'production'},shell:false,stdio:['ignore','pipe','pipe']});
            owned.owner.assertSettled(); launches++; // Before uncertain native launch; never retry.
            return native.launch(file,[...args],structuredClone(options));
        },
        setTimer(callback,ms) { assert.equal(ms,60000); return native.setTimer(callback,ms); },
        clearTimer: timer => native.clearTimer(timer), now: () => native.now(),
        assertFilesSettled: () => { owned.owner.assertSettled(); },
    };
    const snapshot = () => ({ phase,failedAt,childFailure,admitted,completed,failed:Boolean(primary),launches,
        inputs:[...inputs.values()].map(v => ({phase:v.phase,descriptorIdentityObserved:Boolean(v.descriptorIdentity)})),
        files:owned.owner.snapshot(),pendingAbsence,failureRetired,child:rawChild?.snapshot()??null,wholeGroupRetirement:null,releaseAcceptance:false });
    const owner=Object.freeze({snapshot,async joinFailedDirectRetirement(){
        assert.ok(primary&&!joinIssued);joinIssued=true;assert.equal(pendingAbsence,0);if(rawChild){await rawChild.closed;const s=rawChild.snapshot();for(const key of ['directRetired','spawned','exited','closed','inputAck','inputFinish','inputClosed','stdoutClosed','stderrClosed'])assert.equal(s[key],true);assert.equal(s.unknownOperations,0);assert.equal(s.listeners,0);}else assert.equal(launches,0);owned.owner.assertSettled();for(const record of inputs.values())assert.equal(record.phase,'acknowledged');failureRetired=true;selected.scripts.clear();retained.delete(owner);
    },async run(){
        assert.equal(admitted,false);admitted=true;phase='compatibility';retained.add(owner);let challengeBytes;
        try{
            const node=await ports.observeNode(),before=await censusInstrumentedGateway(root,runtime.uid,ports.filesystem,'preimport-v1');
            assert.deepEqual(before.census,admittedBuild.census);assert.deepEqual(before.inventory,selected.binding.fileInventory);assert.deepEqual(before.scriptInventory,selected.binding.scriptInventory);
            const child={schema:'owned-instrumented-gateway-child-input-v1',root,uid:runtime.uid,mode:'compatibility',nonce:randomBytes(16).toString('hex'),token:randomBytes(32).toString('hex'),node,binding:selected.binding,selection:selected.selection};
            const challenge={schema:'owned-instrumented-preimport-input-v1',earlyArtifactSHA256:selected.binding.preimport.earlyArtifactSHA256,child};challengeBytes=Buffer.from(JSON.stringify(challenge)+'\n');assert.ok(challengeBytes.length<=PREIMPORT_INPUT_LIMIT);preimportReceiptIdentity(challengeBytes,root);
            const inputPath=parent+'/preimport-input-compatibility.json';await ports.writeExclusive(inputPath,challengeBytes);assert.ok((await ports.readInput(inputPath,PREIMPORT_INPUT_LIMIT)).equals(challengeBytes));ports.assertFilesSettled();
            const command=Object.freeze([runtime.execPath,root+'/activate.cjs',inputPath]),plan=Object.freeze({owner:randomBytes(16).toString('hex'),id:1,role:'ownership',cwd:root,command});
            rawChild=startDiagnosticGatewayCommand(plan,{PATH:path.dirname(runtime.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',NODE_ENV:'production'},{...ports,requireSpawnIdentity:true});
            const ack=await rawChild.result;await rawChild.closed;const output=rawChild.output();
            const childReceipt=readPreimportCompatibilityReceipt(output.stdout,output.stderr,challengeBytes,root,ack.lifecycle,rawChild.snapshot());
            const after=await censusInstrumentedGateway(root,runtime.uid,ports.filesystem,'preimport-v1');assert.deepEqual(after.census,before.census);assert.deepEqual(await ports.observeNode(),node);assert.ok((await ports.readInput(inputPath,PREIMPORT_INPUT_LIMIT)).equals(challengeBytes));ports.assertFilesSettled();assert.equal(launches,1);
            const receipt={schema:'parent-observed-preimport-compatibility-v1',source:selected.binding.source,bindingSHA256:sourceDigest(JSON.stringify(selected.binding)+'\n'),earlyArtifactSHA256:selected.binding.preimport.earlyArtifactSHA256,targetArtifactSHA256:selected.selection.artifactSHA256,
                earlyGraphSHA256:selected.binding.preimport.earlyGraphSHA256,targetGraphSHA256:selected.binding.preimport.targetGraphSHA256,earlyAcknowledgementSHA256:selected.binding.preimport.earlyAcknowledgementSHA256,targetAcknowledgementSHA256:selected.binding.preimport.targetAcknowledgementSHA256,
                inputSHA256:sourceDigest(challengeBytes),childReceiptSHA256:sourceDigest(output.stdout),normalChildAndPipesClosed:true,postCensusUnchanged:true,childReceipt:childReceipt.receipt,
                scope:'compatibility-only-no-factory-or-ownership-requested',ownershipContinuation:false,wholeGroupRetirement:null,releaseAcceptance:false};
            const bytes=Buffer.from(JSON.stringify(receipt)+'\n');assert.ok(bytes.length<=16384);selected.scripts.clear();completed=true;phase='completed';retained.delete(owner);return Object.freeze({receipt,bytes});
        }catch(error){
            failedAt=phase;primary=error;phase='failed';
            try{
                const output=rawChild.output().stdout;assert.ok(output.length<=16384);const raw=new TextDecoder('utf-8',{fatal:true}).decode(output);assert.ok(raw.startsWith(PREIMPORT_RECEIPT_MARKER));const text=raw.slice(PREIMPORT_RECEIPT_MARKER.length),value=JSON.parse(text);assert.equal(text,JSON.stringify(value)+'\n');assert.equal(value.schema,'owned-preimport-compatibility-envelope-v1');assert.equal(value.status,'failed-or-held');
                if(value.identity!==null)assert.deepEqual(value.identity,preimportReceiptIdentity(challengeBytes,root).identity);
                const f=value.failure,count=n=>Number.isSafeInteger(n)&&n>=0&&n<=4096?n:null;
                const observer=validateInstrumentedChildFailure(f.observer);childFailure={observer,status:'failed-or-held',identityBound:value.identity!==null,stopped:f.stopped===true,unknown:f.unknown===true,localRetired:f.localRetired===true,pendingCallbacks:count(f.pendingCallbacks),pendingSources:count(f.pendingSources),targetUncertain:f.targetUncertain===true,wholeGroupRetirement:null,releaseAcceptance:false};
            }catch{}
            throw Object.assign(Error('Preimport compatibility parent failed or remains held; no retry or ownership continuation.',{cause:error}),{owner});
        }
    }});return owner;
}
