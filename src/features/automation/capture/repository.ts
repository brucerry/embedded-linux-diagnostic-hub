import type { CaptureRepository } from '../../../../shared/capture-store';
import { CaptureStorageError } from '../../../../shared/capture-store';
import { IndexedDbCaptureStore } from './indexeddb-store';
import { NativeCaptureRepository } from './native-repository';
let pending: Promise<CaptureRepository> | undefined;
export function openCaptureRepository() {
    return (pending ??= (async () => {
        if (window.diagnosticHub) {
            if (!window.diagnosticHub.captureStorage)
                throw new CaptureStorageError(
                    'unsupported',
                    'Update the desktop app to use stored command captures.',
                );
            return NativeCaptureRepository.open(window.diagnosticHub.captureStorage);
        }
        return IndexedDbCaptureStore.open();
    })().catch((error) => {
        pending = undefined;
        throw error;
    }));
}
