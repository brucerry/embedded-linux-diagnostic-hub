// Inert composition for a FUTURE separately built/frozen preimport.mjs artifact.
// No CLI/default activation, liveness/receipt coordinator, builder or launch is provided here.
// Calling this source path directly cannot satisfy the required loaded-artifact location.
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Session,url as inspectorURL} from 'node:inspector';
import * as filesystem from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {createOwnedWebFiles} from '../../scripts/lib/owned-web-files.mjs';
import {readStableArtifactFile} from '../../scripts/lib/stable-artifact-file.mjs';
import {sourceDigest} from '../../scripts/lib/committed-source-bridge.mjs';
import {deriveSshReadinessPlan,cachedSshInitialization,assertPreimportCacheEmpty} from '../../scripts/lib/instrumented-gateway-ssh-readiness.mjs';

/** The outer future harness must own liveness before admission and bind BOTH emitted artifacts,
 * build acknowledgements and this source preimage. These ports do not constitute such authority.
 * Product code is required only by importTarget after the core's actual enable acknowledgement. */
export function createNativePreimportPorts(guard){
    const selfPath=fileURLToPath(import.meta.url),root=path.dirname(selfPath);
    assert.ok(root.endsWith('/validation/gateway-ownership/instrumented'));assert.equal(path.basename(selfPath),'preimport.mjs');
    assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v24.22.0');assert.deepEqual(process.execArgv,[]);
    assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.NODE_PATH,undefined);assert.ok(process.getuid()>0);assert.equal(inspectorURL(),undefined);
    assert.equal(typeof guard?.assertActive,'function');
    const owned=createOwnedWebFiles(filesystem),require=createRequire(import.meta.url);let readyPlan;
    const read=async(file,max)=>(await readStableArtifactFile(path.dirname(file),path.basename(file),max,owned.filesystem)).bytes;
    const ports={root,uid:process.getuid(),filesystem:owned.filesystem,
        readInput:async(file,max)=>{assert.ok(['compatibility','ownership'].some(mode=>file===path.dirname(root)+'/preimport-input-'+mode+'.json'));return read(file,max);},
        async observeNode(){assert.equal(await owned.filesystem.realpath(process.execPath),process.execPath);return{path:process.execPath,sha256:sourceDigest(await read(process.execPath,128*1024**2)),version:process.version,execArgv:[...process.execArgv],nodeOptions:null};},
        async observeSelf(){assert.equal(await owned.filesystem.realpath(selfPath),selfPath);return{path:selfPath,sha256:sourceDigest(await read(selfPath,32*1024**2))};},
        assertGuardActive(){guard.assertActive(root);},assertFilesSettled(){owned.owner.assertSettled();},
        assertTargetUnloaded(){assertPreimportCacheEmpty(require.cache,root);},
        prepareTarget(scripts,selectedRoot){assert.equal(selectedRoot,root);assert.equal(readyPlan,undefined);readyPlan=deriveSshReadinessPlan(scripts,root);},
        sessionFactory(){assert.equal(inspectorURL(),undefined);return new Session();},
        importTarget(file){assert.equal(file,root+'/ownership.cjs');guard.assertActive(root);assertPreimportCacheEmpty(require.cache,root);const target=require(file);assert.equal(typeof target.createGateway,'function');return Object.freeze({createGateway:target.createGateway});},
        waitTargetReady(){assert.ok(readyPlan);return cachedSshInitialization(require.cache,readyPlan);},
        setTimer:(callback,ms)=>setTimeout(callback,ms),clearTimer:timer=>{clearTimeout(timer);},now:()=>performance.now(),
    };
    return Object.freeze(ports);
}
