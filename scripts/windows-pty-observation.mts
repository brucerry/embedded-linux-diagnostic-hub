import { ptyObservationMode } from './lib/hosted-pilot-contract.mjs';
import { nativePilotMain } from './windows-native-pilot.mts';
// The shared owner validates this distinct mode before any host/workload side effects.
nativePilotMain(process.argv.slice(2), process.env, ptyObservationMode)
    .then((result) => {
        console.log(JSON.stringify(result));
        if (!result.passed) process.exitCode = 1;
    })
    .catch((error) => {
        console.error(
            JSON.stringify({
                kind: 'pty-observation-entry-failure',
                error: String(error).slice(0, 1024),
            }),
        );
        process.exitCode = 1;
    });
