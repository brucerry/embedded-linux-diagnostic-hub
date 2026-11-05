// Synthetic receipt data only; not a hook or native-context observation.
export function containmentRecord(overrides:Record<string,unknown>={}) {
    return {schema:'private-required-module-guard-v1',policy:'required-root-and-explicit-cpu-absence-v1',registered:true,closePrepared:true,
        failed:false,uncertain:false,rootBound:true,inFlight:0,resolutions:1,optionalCpuBlocked:0,outsideRejected:0,nativeRejected:0,missing:0,
        violationCode:null,wholeGroupRetirement:null,releaseAcceptance:false,...overrides};
}
