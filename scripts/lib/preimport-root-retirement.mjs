import assert from 'node:assert/strict';
import {types} from 'node:util';
const used=new WeakSet(),unknown=new Set();
/** Acknowledge local write and optional known-failure custody immediately before clearing our
 * own parent fence. This never closes inherited stdout or proves normal whole-group retirement. */
/** @param {null | (() => Promise<void>)} [join] */
export async function releasePreimportRoot(output,hold,clearHold,join=null){
    assert.ok(output&&!used.has(output));used.add(output);assert.equal(typeof clearHold,'function');
    const check=()=>{const s=output.snapshot();assert.equal(s.writeRetired,true);assert.equal(s.failed,false);assert.equal(s.unknownOperation,false);};
    await output.result;await output.closed;check();
    if(join!==null){assert.equal(typeof join,'function');const result=join();assert.ok(types.isPromise(result));await result;check();}
    const value=clearHold(hold);if(value!==undefined){unknown.add(value);if(types.isPromise(value))Promise.prototype.then.call(value,undefined,()=>{});assert.fail('Unknown hold-clear acknowledgement.');}
}
