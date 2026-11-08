import { pathToFileURL } from 'node:url';
import {
    OfflineObservationError,
    refuseNativeOfflineLaunch,
} from './fixtures/windows-installer-offline';

// Fixed caller used by the synthetic contract and future reviewed native adapter.
// No installer invocation, arbitrary command, inspector or security-flag interface.
export { runOfflineLaunchCase } from './fixtures/windows-installer-offline';

export function offlineLaunchCLI(argv: readonly string[]): never {
    // Admission files are deliberately not read. Reviewed identity/consent inputs alone
    // cannot substitute for a native implementation, custody and failure disposition.
    return refuseNativeOfflineLaunch(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        offlineLaunchCLI(process.argv.slice(2));
    } catch (error) {
        console.error(
            error instanceof OfflineObservationError ? error.code : 'OFFLINE_LAUNCH_REFUSED',
        );
        process.exitCode = 1;
    }
}
