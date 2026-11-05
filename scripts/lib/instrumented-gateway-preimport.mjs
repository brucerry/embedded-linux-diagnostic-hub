import assert from 'node:assert/strict';
import path from 'node:path';
import {types} from 'node:util';
import {sourceDigest} from './committed-source-bridge.mjs';
import {parseInstrumentedChildInput,INSTRUMENTED_CHILD_INPUT_LIMIT} from './instrumented-gateway-input.mjs';
import {snapshotPreparedInstrumentedGateway} from './instrumented-gateway-snapshot.mjs';
import {censusInstrumentedGateway} from './instrumented-gateway-census.mjs';
import {startPreimportInspectorCompatibility} from './instrumented-gateway-compatibility.mjs';
import {createInstrumentedGatewayBootstrapFromObserver,createCompiledSourceObserver} from './instrumented-gateway-observer.mjs';

const admissions=new WeakMap(),retained=new Set();
export const PREIMPORT_INPUT_LIMIT=INSTRUMENTED_CHILD_INPUT_LIMIT+4096;
const sync=value=>{if(types.isPromise(value))Promise.prototype.then.call(value,undefined,()=>{});assert.equal(value,undefined);};
const node=v=>{assert.deepEqual(Object.keys(v).sort(),['execArgv','nodeOptions','path','sha256','version']);assert.equal(v.version,'v24.22.0');assert.deepEqual(v.execArgv,[]);assert.equal(v.nodeOptions,null);assert.match(v.sha256,/^[a-f0-9]{64}$/);return structuredClone(v);};
function sameCensus(prepared,c){
    assert.deepEqual(c.inventory,prepared.binding.fileInventory);assert.deepEqual(c.scriptInventory,prepared.binding.scriptInventory);
    assert.equal(c.inventorySHA256,prepared.binding.fileInventorySHA256);assert.equal(c.scriptInventorySHA256,prepared.binding.scriptInventorySHA256);
    assert.equal(c.lockSHA256,prepared.binding.installationLockSHA256);assert.equal(c.packageSHA256,prepared.binding.installationPackageSHA256);
    const root=path.dirname(prepared.selection.artifactPath);
    assert.equal(sourceDigest(c.scripts.get(root+'/activate.cjs')),prepared.binding.activationSHA256);
    assert.equal(sourceDigest(c.scripts.get(root+'/resolution-guard.cjs')),prepared.binding.guardSHA256);
}
/** Actual input/Node/self/full-census/guard IO admission before any Inspector acquisition.
 * No serialized binding, counter or caller-created object is itself an admission capability.
 * New native/build wiring must supply the separately frozen preimport.mjs artifact. */
export async function admitPreimportObserver(inputPath,ports){
    ports=Object.freeze({...ports,filesystem:Object.freeze({...ports.filesystem})});
    for(const k of ['readInput','observeNode','observeSelf','assertGuardActive','assertFilesSettled','sessionFactory','importTarget','waitTargetReady','prepareTarget','assertTargetUnloaded','setTimer','clearTimer','now'])assert.equal(typeof ports[k],'function');
    const root=ports.root;assert.ok(typeof root==='string'&&root.startsWith('/')&&path.posix.normalize(root)===root&&root.endsWith('/validation/gateway-ownership/instrumented'));
    assert.ok(Number.isSafeInteger(ports.uid)&&ports.uid>0);
    assert.ok(['compatibility','ownership'].some(mode=>inputPath===path.dirname(root)+'/preimport-input-'+mode+'.json'));
    sync(ports.assertGuardActive());
    const bytes=await ports.readInput(inputPath,PREIMPORT_INPUT_LIMIT);assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=PREIMPORT_INPUT_LIMIT);
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),outer=JSON.parse(text);assert.equal(text,JSON.stringify(outer)+'\n');
    assert.deepEqual(Object.keys(outer).sort(),['child','earlyArtifactSHA256','schema']);assert.equal(outer.schema,'owned-instrumented-preimport-input-v1');assert.match(outer.earlyArtifactSHA256,/^[a-f0-9]{64}$/);
    const input=parseInstrumentedChildInput(Buffer.from(JSON.stringify(outer.child)+'\n'),root);assert.equal(input.selection.artifactPath,root+'/ownership.cjs');assert.equal(input.uid,ports.uid);assert.equal(inputPath,path.dirname(root)+'/preimport-input-'+input.mode+'.json');
    const actualNode=node(await ports.observeNode());assert.deepEqual(actualNode,input.node);
    const census=await censusInstrumentedGateway(root,ports.uid,ports.filesystem,'preimport-v1');
    const prepared=snapshotPreparedInstrumentedGateway({binding:input.binding,selection:input.selection,scripts:census.scripts});sameCensus(prepared,census);
    if(prepared.binding.kind==='separate-preimport-gateway-build-byte-binding-v5')assert.equal(outer.earlyArtifactSHA256,prepared.binding.preimport.earlyArtifactSHA256);
    const self=await ports.observeSelf();assert.deepEqual(Object.keys(self).sort(),['path','sha256']);assert.equal(self.path,root+'/preimport.mjs');assert.equal(self.sha256,outer.earlyArtifactSHA256);assert.equal(sourceDigest(census.scripts.get(self.path)),self.sha256);
    sync(ports.assertTargetUnloaded());sync(ports.prepareTarget(new Map([...prepared.scripts].map(([file,bytes])=>[file,Buffer.from(bytes)])),root));sync(ports.assertGuardActive());sync(ports.assertFilesSettled());
    const identity=Object.freeze({mode:input.mode,nonce:input.nonce,inputSHA256:sourceDigest(bytes),source:structuredClone(input.binding.source),bindingSHA256:sourceDigest(JSON.stringify(input.binding)+'\n'),node:actualNode,censusSHA256:census.censusSHA256,guardSHA256:input.binding.guardSHA256,earlyArtifactPath:self.path,earlyArtifactSHA256:self.sha256,targetPath:input.selection.artifactPath,targetSHA256:input.selection.artifactSHA256});
    const capability=Object.freeze({});admissions.set(capability,{inputPath,inputBytes:Buffer.from(bytes),prepared,identity,census,ports,used:false});return capability;
}
/** Same collector/Session and pending source tasks survive this closure's one-use handoff.
 * The consumer is source-owned, never a serialized proof or replacement Session.
 * Caller-visible tickets/diagnostics cannot substitute private ownership. */
export function createPreimportObserverBoundary(admission){
    const record=admissions.get(admission);assert.ok(record&&!record.used,'Actual one-use IO admission required.');record.used=true;
    const {ports,prepared,identity}=record,collector=createCompiledSourceObserver(prepared.selection,prepared.scripts,ports.sessionFactory);
    let resolveRetired;const retirement=new Promise(resolve=>{resolveRetired=resolve;});
    const tickets=new WeakSet();let phase='prepared',enableIssued=false,importIssued=false,offered=false,claimIssued=false,consumed=false,target,targetUncertain=false,readyAcknowledged=false,primary,closing,enablingTask,importingTask,closingRequested=false;
    async function revalidate(){
        assert.ok((await ports.readInput(record.inputPath,PREIMPORT_INPUT_LIMIT)).equals(record.inputBytes));
        assert.deepEqual(node(await ports.observeNode()),identity.node);
        const c=await censusInstrumentedGateway(ports.root,ports.uid,ports.filesystem,'preimport-v1');sameCensus(prepared,c);assert.equal(c.censusSHA256,identity.censusSHA256);
        assert.deepEqual(await ports.observeSelf(),{path:identity.earlyArtifactPath,sha256:identity.earlyArtifactSHA256});sync(ports.assertGuardActive());sync(ports.assertFilesSettled());
    }
    const owner={
        retirement,
        stop(reason){assert.ok(['deadline','cancelled'].includes(reason));primary??=Error('Preimport admission stopped: '+reason);closingRequested=true;collector.rejectAdmission();phase='failed';},
        binding:()=>structuredClone(identity),
        snapshot:()=>Object.freeze({phase,enableIssued,importIssued,offered,claimIssued,consumed,readyAcknowledged,targetUncertain,failed:Boolean(primary),collector:collector.snapshot(),wholeGroupRetirement:null,releaseAcceptance:false}),
        enable(){
            assert.ok(!enableIssued&&!importIssued&&!closingRequested);enableIssued=true;phase='enabling';
            enablingTask=(async()=>{await revalidate();assert.equal(closingRequested,false);sync(ports.assertTargetUnloaded());await collector.enableBeforeImport();sync(ports.assertGuardActive());sync(ports.assertFilesSettled());assert.equal(closingRequested,false);phase='enabled';})().catch(error=>{primary??=error;if(!closingRequested)phase='failed';throw error;});enablingTask.catch(()=>{});return enablingTask;
        },
        import(){
            assert.ok(phase==='enabled'&&!importIssued&&!closingRequested&&!collector.failure());importIssued=true;phase='importing';
            importingTask=(async()=>{
                await revalidate();assert.equal(closingRequested,false);assert.equal(collector.failure(),undefined);sync(ports.assertTargetUnloaded());targetUncertain=true;
                target=ports.importTarget(identity.targetPath);if(types.isPromise(target))Promise.prototype.then.call(target,undefined,()=>{});
                assert.ok(target&&!types.isProxy(target)&&!types.isPromise(target)&&typeof target==='object');
                const d=Object.getOwnPropertyDescriptors(target);assert.deepEqual(Reflect.ownKeys(d),['createGateway']);assert.ok(Object.hasOwn(d.createGateway,'value')&&typeof d.createGateway.value==='function');target=Object.freeze({createGateway:d.createGateway.value});
                const ready=ports.waitTargetReady();assert.ok(types.isPromise(ready),'Actual fixed initialization Promise required.');await ready;readyAcknowledged=true;
                await revalidate();targetUncertain=false;assert.equal(closingRequested,false);if(collector.failure())throw collector.failure();phase='imported';
            })().catch(error=>{primary??=error;if(!closingRequested)phase='failed';throw error;});importingTask.catch(()=>{});return importingTask;
        },
        offer(){assert.ok(phase==='imported'&&!offered&&!closingRequested&&!collector.failure());offered=true;const ticket=Object.freeze({});tickets.add(ticket);phase='offered';return ticket;},
        consume(ticket,expected){
            assert.ok(phase==='offered'&&tickets.has(ticket)&&!claimIssued&&!closingRequested);tickets.delete(ticket);claimIssued=true;phase='consuming';
            try{
                assert.deepEqual(expected,identity);sync(ports.assertGuardActive());sync(ports.assertFilesSettled());assert.equal(collector.failure(),undefined);
                const result=identity.mode==='compatibility'?startPreimportInspectorCompatibility(prepared,collector,ports):createInstrumentedGatewayBootstrapFromObserver(prepared.selection,prepared.scripts,collector,target.createGateway);
                consumed=true;phase='consumed';const closed=identity.mode==='compatibility'?result.closed:result.retirement;
                void closed.then(async()=>{await collector.retirement;assert.equal(targetUncertain,false);sync(ports.assertFilesSettled());phase='retired';retained.delete(owner);resolveRetired({scope:'same-inspector-session-and-fixed-import-initialization',wholeGroupRetirement:null,releaseAcceptance:false});}).catch(error=>{primary??=error;phase='failed';});return result;
            }catch(error){primary??=error;phase='failed';throw error;}
        },
        finish(){
            assert.ok(!consumed,'Session custody was transferred; only the consumer may finish.');
            if(closing)return closing;closingRequested=true;phase='closing';
            closing=(async()=>{
                if(enablingTask)await enablingTask.catch(()=>{});if(importingTask)await importingTask.catch(()=>{});
                let error;try{await collector.finish();}catch(e){error=e;primary??=e;}await collector.retirement;
                assert.equal(targetUncertain,false);sync(ports.assertFilesSettled());phase='retired';retained.delete(owner);resolveRetired({scope:'same-inspector-session-and-fixed-import-initialization',wholeGroupRetirement:null,releaseAcceptance:false});if(error||primary)throw error??primary;
            })();closing.catch(()=>{});return closing;
        },
    };
    retained.add(owner);return Object.freeze(owner);
}
