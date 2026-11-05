// Non-shipping native port composition. Import does not read environment, open files or launch.
import * as filesystem from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createInstrumentedGatewayParent } from '../../scripts/lib/instrumented-gateway-parent.mjs';

/** Requires an in-memory result of the separately reviewed prepareInstrumentedGatewayCheck.
 * No CLI/default activation, build/install, deletion, signal or automatic retry is provided.
 */
export function prepareNativeInstrumentedGatewayParent(prepared) {
    return createInstrumentedGatewayParent(prepared, {
        runtime: { platform:process.platform,arch:process.arch,version:process.version,execPath:process.execPath,
            execArgv:[...process.execArgv],uid:process.getuid?.(),
            nodeOptions:process.env.NODE_OPTIONS ?? null,nodePathVariable:process.env.NODE_PATH ?? null },
        filesystem, launch:(file,args,options) => spawn(file,args,options),
        setTimer:(callback,ms) => setTimeout(callback,ms),clearTimer:timer => { clearTimeout(timer); },now:() => performance.now(),
    });
}
