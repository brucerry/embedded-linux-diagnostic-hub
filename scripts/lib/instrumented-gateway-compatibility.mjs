import assert from 'node:assert/strict';
import { createCompiledSourceObserver } from './instrumented-gateway-observer.mjs';
import { snapshotPreparedInstrumentedGateway } from './instrumented-gateway-check.mjs';
import { sourceDigest } from './committed-source-bridge.mjs';

const retained=new Set();
/** Exact compiled-source replay only. No Gateway factory, server or request port exists here. */
export function startInstrumentedInspectorCompatibility(prepared, ports) {
    const {binding,selection,scripts}=snapshotPreparedInstrumentedGateway(prepared);
    for(const k of ['sessionFactory','setTimer','clearTimer','now'])assert.equal(typeof ports[k],'function');
    ports=Object.freeze({...ports});const collector=createCompiledSourceObserver(selection,scripts,ports.sessionFactory);
    let resolve,reject,resolveClosed,timer,primary,retired=false,unknown;
    const result=new Promise((a,b)=>{resolve=a;reject=b;});result.catch(()=>{});
    const closed=new Promise(a=>{resolveClosed=a;});const started=ports.now();assert.ok(Number.isFinite(started));
    const snapshot=()=>({failed:Boolean(primary),retired,unknownOperation:Boolean(unknown),collector:collector.snapshot(),wholeGroupRetirement:null});
    const owner=Object.freeze({result,closed,snapshot});retained.add(owner);
    const fail=()=>{if(retired)return;primary??=Error('Node Inspector compatibility failed or remains held.');reject(Object.assign(Error(primary.message),{owner}));};
    void(async()=>{
        let observation, localClosed=false;
        try {
            timer=ports.setTimer(()=>{fail();void collector.finish().catch(fail);},15000);
            if(timer===undefined||typeof timer?.then==='function'){unknown=timer??true;if(typeof timer?.then==='function')Promise.resolve(timer).catch(()=>{});throw Error('Unsupported timer.');}
            await collector.start();if(primary)throw primary;
            observation=await collector.finish();
        }catch{fail();}
        finally {
            try {
                try{observation=await collector.finish();}catch{fail();}
                assert.equal(collector.snapshot().observerRetired,true);assert.equal(unknown,undefined);await collector.retirement;
                const cleared=ports.clearTimer(timer);if(cleared!==undefined){unknown={cleared};if(typeof cleared?.then==='function')Promise.resolve(cleared).catch(()=>{});throw Error('Unacknowledged timer cleanup.');}
                scripts.clear();localClosed=true;
                if(!primary){
                    assert.deepEqual(observation.selected,selection);assert.ok(observation.compiledScripts.some(r=>r.path===selection.artifactPath&&r.sha256===selection.artifactSHA256));
                    const elapsedMs=ports.now()-started;assert.ok(Number.isFinite(elapsedMs)&&elapsedMs>=0&&elapsedMs<=15000);
                    const receipt={schema:'instrumented-node-inspector-compatibility-v1',status:'exact-prelaunch-bytes-match-replayed-sources',instrumented:true,
                        source:binding.source,bindingSHA256:sourceDigest(JSON.stringify(binding)+'\n'),artifactSHA256:selection.artifactSHA256,
                        compiledScripts:observation.compiledScripts.length,builtinScripts:observation.builtinScripts,builtinIdentityVerified:false,
                        observerRetired:true,elapsedMs,productWorkload:null,shippedCLIBehavior:null,wholeGroupRetirement:null,releaseAcceptance:false};
                    const bytes=Buffer.from(JSON.stringify(receipt)+'\n');assert.ok(bytes.length<=16384);
                    retired=true;retained.delete(owner);resolveClosed(snapshot());resolve({receipt,bytes});
                }else{retired=true;retained.delete(owner);resolveClosed(snapshot());}
            }catch{fail();if(localClosed){retired=true;retained.delete(owner);resolveClosed(snapshot());}}
        }
    })();return owner;
}
