import assert from 'node:assert/strict';

const retained = new Set();
/** One write, with error observation installed before dispatch. The callback retires the write,
 * not inherited stdout or its error listener. That listener stays until child termination; a late
 * error sets the child's failure status even after result settlement. The parent alone joins pipe
 * closure. No end, destroy, listener removal, retry or forced exit is exposed.
 */
export function startInstrumentedChildOutput(bytes, stream, setFailure) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32768);
    assert.equal(typeof stream?.on, 'function'); assert.equal(typeof stream?.write, 'function');
    assert.equal(typeof setFailure, 'function');
    let resolve, reject, close, acknowledged = false, dispatched = false, unknown = false, primary, retired = false;
    const result = new Promise((a,b) => { resolve=a; reject=b; }); result.catch(() => {});
    const closed = new Promise(a => { close=a; });
    const owner = Object.freeze({ result, closed, snapshot: () => ({ writeAcknowledged: acknowledged, writeRetired: retired,
        listenerHeldUntilChildExit: true, pipeRetired: false, unknownOperation: unknown, failed: Boolean(primary) }) });
    retained.add(owner);
    function observe(value) { if (typeof value?.then === 'function') Promise.resolve(value).catch(() => {}); }
    function fail(error) {
        primary ??= error;
        try { const value=setFailure(); if(value!==undefined){unknown=true;observe(value);} } catch { unknown=true; }
        reject(Object.assign(Error('Owned child stdout failed or remains held.'), { owner }));
    }
    function finish() {
        if(!acknowledged || !dispatched || unknown || retired) return;
        retired=true;close(owner.snapshot());
        if(!primary) resolve(undefined);
        // The observer remains referenced by the inherited pipe until actual child termination.
        retained.delete(owner);
    }
    try {
        const installed=stream.on('error',fail);
        if(installed!==stream){unknown=true;observe(installed);throw Error('Unknown stdout observer acquisition.');}
        const returned=stream.write(Buffer.from(bytes),(error)=>{
            if(acknowledged){fail(Error('Duplicate stdout write acknowledgement.'));return;}
            acknowledged=true;if(error)fail(error);finish();
        });
        if(typeof returned!=='boolean'){unknown=true;observe(returned);throw Error('Unknown stdout write dispatch.');}
        dispatched=true;finish();
    } catch(error) { unknown=true;fail(error); }
    return owner;
}
