'use strict';
// Separate future activation, copied as activate.cjs only by a reviewed two-artifact builder.
const assert=require('node:assert/strict'),path=require('node:path');
const {registerHooks,isBuiltin}=require('node:module');
const {pathToFileURL}=require('node:url');
assert.equal(require.main,module);assert.equal(process.argv.length,3);assert.equal(process.argv[1],__filename);
assert.equal(process.argv[2],path.dirname(__dirname)+'/preimport-input-compatibility.json');
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v24.22.0');assert.deepEqual(process.execArgv,[]);
assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.NODE_PATH,undefined);assert.ok(process.getuid()>0);
const hold=setInterval(()=>{},1000); // Before guard registration and early artifact import.
let claimed=false,cleared=false,guard,uncertainHold,deadlineClaimed=false,deadlineCleared=false,expired=false,onDeadline;
const failure=()=>{process.exitCode=1;};
const deadline=setTimeout(()=>{if(deadlineCleared)return;expired=true;failure();if(onDeadline)onDeadline();},60000); // Before any guard/early-artifact file acquisition.
const holdPorts=Object.freeze({
    startHold(){assert.equal(expired,false);assert.equal(claimed,false);claimed=true;return hold;},
    startDeadline(callback,ms){assert.equal(expired,false);assert.equal(ms,60000);assert.equal(deadlineClaimed,false);assert.equal(typeof callback,'function');deadlineClaimed=true;onDeadline=callback;return deadline;},
    isDeadline(value){return value===deadline;},
    clearDeadline(value){assert.equal(value,deadline);assert.equal(deadlineClaimed,true);assert.equal(deadlineCleared,false);clearTimeout(deadline);deadlineCleared=true;},
    clearHold(value){assert.equal(claimed,true);assert.equal(cleared,false);assert.equal(value,hold);clearInterval(hold);cleared=true;},
});
try{
    const {createInstrumentedResolutionGuard}=require('./resolution-guard.cjs');
    guard=createInstrumentedResolutionGuard(__dirname,{registerHooks,isBuiltin,onViolation:failure,onUncertain(){uncertainHold??=setInterval(()=>{},1000);}});
    guard.assertActive(__dirname);
    import(pathToFileURL(__dirname+'/preimport.mjs').href).then(module=>{
        assert.equal(expired,false);guard.assertActive(__dirname);
        const owner=module.runPreimportCompatibilityFromFile(process.argv[2],guard,holdPorts);
        owner.result.catch(failure); // Coordinator owns the deadline, output and acknowledged joins.
    }).catch(()=>{failure();guard.retainFailure();});
}catch{failure();if(guard)guard.retainFailure();}
// No exit, signal, retry or release of uncertain acquisitions. Parent/job deadline remains required.
