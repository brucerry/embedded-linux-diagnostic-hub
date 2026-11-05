import assert from 'node:assert/strict';
import {types} from 'node:util';
const used=new WeakSet(),unsupported=new Set();
/** Failure stays failure. Join actual source-owned local custody, then clear only our root fence.
 * No signal, retry, process exit, output closure or whole-group proof is provided here. */
export async function releaseKnownInstrumentedFailure(driver,output,hold,clearHold){
    assert.ok(driver&&typeof driver.joinFailedDirectRetirement==='function'&&!used.has(driver));used.add(driver);
    await output.result;await output.closed;
    const check=()=>{const written=output.snapshot();assert.equal(written.writeRetired,true);assert.equal(written.unknownOperation,false);assert.equal(written.failed,false);};check();
    await driver.joinFailedDirectRetirement();check();
    const value=clearHold(hold);if(value!==undefined){unsupported.add(value);if(types.isPromise(value))Promise.prototype.then.call(value,undefined,()=>{});assert.fail('Unsupported root hold-clear acknowledgement.');}
}
