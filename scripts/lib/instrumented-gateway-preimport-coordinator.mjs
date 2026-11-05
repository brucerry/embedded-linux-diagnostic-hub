import assert from 'node:assert/strict';
import {types} from 'node:util';
import {sourceDigest} from './committed-source-bridge.mjs';
import {admitPreimportObserver,createPreimportObserverBoundary,PREIMPORT_INPUT_LIMIT} from './instrumented-gateway-preimport.mjs';
import {preimportReceiptIdentity,PREIMPORT_RECEIPT_MARKER} from './instrumented-gateway-preimport-receipt.mjs';
export {PREIMPORT_RECEIPT_MARKER} from './instrumented-gateway-preimport-receipt.mjs';
import {INSPECTOR_FAILURE_CODES} from './instrumented-gateway-failure.mjs';

export const PREIMPORT_DEADLINE_MS=60000;
const retained=new Set();
const watch=value=>{if(types.isPromise(value))Promise.prototype.then.call(value,undefined,()=>{});};
const sync=value=>{watch(value);assert.equal(value,undefined);};
const handle=value=>{watch(value);assert.ok(value&&typeof value==='object'&&!types.isPromise(value));let p=value,depth=0;while(p){assert.ok(!types.isProxy(p)&&++depth<=8);assert.equal(Object.getOwnPropertyDescriptor(p,'then'),undefined);p=Object.getPrototypeOf(p);}return value;};

/** Compatibility-only outer owner. Real IO/Session admission is performed by the actual core;
 * no caller-supplied observer/result is accepted. Timeout reports failure without inventing
 * resource retirement. No signal, process exit, retries, launch or automatic activation. */
export function startPreimportCompatibility(inputPath,ports){
    ports=Object.freeze({...ports});
    for(const key of ['startHold','clearHold','setTimer','clearTimer','writeOutput','setFailure','prepareContainmentClose','assertContainmentClosed','assertFilesSettled'])assert.equal(typeof ports[key],'function');
    let resolve,reject,resolveClosed,resolveReported;
    const result=new Promise((a,b)=>{resolve=a;reject=b;});result.catch(()=>{});
    const closed=new Promise(a=>{resolveClosed=a;}),reported=new Promise(a=>{resolveReported=a;});
    let hold,timer,boundary,consumer,work,output,primary,unknown=false,stage='prepared',stopped=false,writeIssued=false,clearTimerIssued=false,clearHoldIssued=false,localRetired=false,outputRetired=false,identity=null,containmentPrepared=false,finished=false;
    const owner=Object.freeze({result,closed,reported,snapshot:()=>Object.freeze({stage,failed:Boolean(primary),stopped,writeIssued,localRetired,outputRetired,unknown,finished,wholeGroupRetirement:null,releaseAcceptance:false}),cancel(){stop('cancelled');}});
    retained.add(owner);
    function fail(error){
        primary??=error;
        try{sync(ports.setFailure());}catch{unknown=true;}
        reject(Object.assign(Error('Preimport compatibility failed or remains held.',{cause:primary}),{owner}));
    }
    function stop(reason){
        if(finished||stopped)return;stopped=true;
        fail(Error('Preimport '+reason));
        if(boundary)try{boundary.stop(reason);}catch{unknown=true;}
        publish(false).catch(()=>{});
    }
    function failureFacts(){
        let state;try{state=boundary?.snapshot();}catch{}
        const collector=state?.collector,count=n=>Number.isSafeInteger(n)&&n>=0&&n<=4096?n:null;
        return {stage,stopped,unknown,localRetired,code:INSPECTOR_FAILURE_CODES.includes(collector?.failureCode)?collector.failureCode:null,
            pendingCallbacks:count(collector?.pendingCallbacks),pendingSources:count(collector?.pendingSourceClassifications),targetUncertain:state?.targetUncertain===true};
    }
    function publish(success,completed){
        if(writeIssued)return output?.task??Promise.resolve();writeIssued=true;
        const record={schema:'owned-preimport-compatibility-envelope-v1',status:success?'completed-local-compatibility':'failed-or-held',identity:identity?structuredClone(identity):null,
            receipt:success?completed.receipt:null,failure:success?null:failureFacts(),wholeGroupRetirement:null,releaseAcceptance:false};
        const bytes=Buffer.from(PREIMPORT_RECEIPT_MARKER+JSON.stringify(record)+'\n');assert.ok(bytes.length<=16384);
        output={task:null,owner:null};
        output.task=(async()=>{
            try{
                const write=ports.writeOutput(bytes);watch(write);assert.ok(write&&!types.isProxy(write)&&!types.isPromise(write));
                assert.ok(types.isPromise(write.result)&&types.isPromise(write.closed)&&typeof write.snapshot==='function');output.owner=write;
                assert.equal(await write.result,undefined);await write.closed;
                const state=write.snapshot();assert.equal(state.writeRetired,true);assert.equal(state.unknownOperation,false);assert.equal(state.failed,false);
                outputRetired=true;resolveReported({status:record.status,bytes:bytes.length,sha256:sourceDigest(bytes)});
            }catch(error){unknown=true;fail(error);throw error;}
        })();output.task.catch(()=>{});return output.task;
    }
    function active(){assert.equal(stopped,false);assert.equal(primary,undefined);}
    async function join(){
        if(work)await work.catch(()=>{});
        if(boundary){
            if(consumer){await consumer.closed;await boundary.retirement;}
            else{try{await boundary.finish();}catch(error){fail(error);}await boundary.retirement;}
        }
        sync(ports.assertFilesSettled());localRetired=true;
    }
    void (async()=>{
        let completed;
        try{
            stage='hold';try{hold=handle(ports.startHold());}catch(error){unknown=true;throw error;}
            stage='deadline';try{timer=handle(ports.setTimer(()=>stop('deadline'),PREIMPORT_DEADLINE_MS));}catch(error){unknown=true;throw error;}active();
            stage='admission';
            const corePorts={...ports,async readInput(file,limit){
                assert.equal(limit,PREIMPORT_INPUT_LIMIT);const bytes=await ports.readInput(file,limit);
                if(!identity){
                    identity=Object.freeze(preimportReceiptIdentity(bytes,ports.root).identity);
                }
                return bytes;
            }};
            work=(async()=>{
                const admitted=await admitPreimportObserver(inputPath,corePorts);active();boundary=createPreimportObserverBoundary(admitted);
                stage='enable';await boundary.enable();active();
                stage='import';await boundary.import();active();
                stage='compatibility';consumer=boundary.consume(boundary.offer(),boundary.binding());assert.ok('result' in consumer);
                const value=await consumer.result;await consumer.closed;await boundary.retirement;active();return value;
            })();work.catch(()=>{});completed=await work;active();
            stage='local-retirement';await join();active();
            sync(ports.prepareContainmentClose(false));containmentPrepared=true;sync(ports.assertContainmentClosed(false));
            stage='output';await publish(true,completed);active();
        }catch(error){
            fail(error);
            if(boundary&&!consumer)try{boundary.stop('cancelled');}catch{unknown=true;}
            try{await publish(false);}catch{}
        }finally{
            try{
                await join();assert.equal(unknown,false);assert.ok(output&&outputRetired);await output.task;
                if(!containmentPrepared){sync(ports.prepareContainmentClose(true));containmentPrepared=true;}
                sync(ports.assertContainmentClosed(Boolean(primary)));
                assert.equal(clearTimerIssued,false);clearTimerIssued=true;sync(ports.clearTimer(timer));
                assert.equal(clearHoldIssued,false);clearHoldIssued=true;sync(ports.clearHold(hold));
                finished=true;stage='retired';retained.delete(owner);resolveClosed(owner.snapshot());if(!primary)resolve(completed);
            }catch(error){unknown=true;fail(error);stage='held';}
        }
    })();return owner;
}
