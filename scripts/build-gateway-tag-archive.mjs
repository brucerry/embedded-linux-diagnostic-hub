// Native tag/branch-qualification build entry. Import starts no effect.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGatewayArchiveFromSelectedJob } from './lib/gateway-job-bootstrap.mjs';
import { startInstrumentedChildOutput } from './lib/instrumented-gateway-output.mjs';
import { captureGatewayPackageHandoff } from './lib/gateway-package-handoff.mjs';
export { buildGatewayArchiveFromSelectedJob } from './lib/gateway-job-bootstrap.mjs';
let outputAttempted = false;
function emit(which, bytes) {
    if (outputAttempted) throw Error('Output already attempted.');
    outputAttempted = true;
    let inherited;
    const stream = {
        on(event, listener) {
            inherited ??= process[which];
            const result = inherited.on(event, listener);
            return result === inherited ? stream : result;
        },
        write(value, callback) {
            return inherited.write(value, callback);
        },
    };
    return startInstrumentedChildOutput(bytes, stream, () => {
        process.exitCode = 1;
    }).result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const produced = await buildGatewayArchiveFromSelectedJob();
        await emit('stdout', captureGatewayPackageHandoff(produced.result));
    } catch {
        process.exitCode = 1;
        if (!outputAttempted)
            try {
                await emit(
                    'stderr',
                    Buffer.from(
                        'Gateway selected-source build failed or custody remains uncertain; outputs retained.\n',
                    ),
                );
            } catch {
                /* Existing output owner retains uncertainty; never retry. */
            }
    }
}
