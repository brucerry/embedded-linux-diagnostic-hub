// Non-shipping, inert early build entry. Actual activation is a separate guarded file.
import {createNativePreimportPorts} from './instrumented-gateway-preimport-native.mjs';
import {startPreimportCompatibility} from '../../scripts/lib/instrumented-gateway-preimport-coordinator.mjs';
import {startInstrumentedChildOutput} from '../../scripts/lib/instrumented-gateway-output.mjs';

export function runPreimportCompatibilityFromFile(inputPath,guard,holdPorts){
    const native=createNativePreimportPorts(guard),failure=()=>{process.exitCode=1;};
    return startPreimportCompatibility(inputPath,{
        ...native,startHold:holdPorts.startHold,clearHold:holdPorts.clearHold,
        setTimer:(callback,ms)=>ms===60000?holdPorts.startDeadline(callback,ms):native.setTimer(callback,ms),
        clearTimer:timer=>{if(holdPorts.isDeadline(timer))holdPorts.clearDeadline(timer);else native.clearTimer(timer);},
        setFailure:failure,
        prepareContainmentClose:allowFailure=>{guard.prepareClose(native.root,allowFailure);},
        assertContainmentClosed:allowFailure=>{guard.assertClosePrepared(native.root,allowFailure);},
        writeOutput:bytes=>startInstrumentedChildOutput(bytes,process.stdout,failure),
    });
}
