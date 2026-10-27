import { IndexedDbCaptureStore } from '../../src/features/automation/capture/indexeddb-store';
import { CaptureWriter } from '../../shared/capture-writer';
import { streamCaptureJson } from '../../shared/capture-export';
import { streamCaptureReport } from '../../shared/capture-report';
import { CAPTURE_STORAGE, CaptureStorageError } from '../../shared/capture-store';
import { startBrowserCaptureExport } from '../../src/features/automation/capture/browser-export';
const api = {
    IndexedDbCaptureStore,
    CaptureWriter,
    streamCaptureJson,
    streamCaptureReport,
    CAPTURE_STORAGE,
    CaptureStorageError,
    startBrowserCaptureExport,
};
declare global {
    interface Window {
        captureQA: typeof api;
        captureStore?: IndexedDbCaptureStore;
        captureWriter?: CaptureWriter;
        captureRelease?: () => void;
        capturePin?: Awaited<ReturnType<IndexedDbCaptureStore['pin']>>;
        captureIterator?: AsyncIterator<unknown>;
        captureID?: string;
        captureExportJob?: Awaited<ReturnType<typeof startBrowserCaptureExport>>;
        captureExportOutcome?: { state?: string; bytes?: number; error?: string };
    }
}
window.captureQA = api;
for (const format of ['json', 'csv', 'markdown', 'text'] as const)
    document.getElementById('export-' + format)?.addEventListener('click', () => {
        window.captureExportOutcome = { state: 'preparing' };
        void startBrowserCaptureExport(format)
            .then((job) => {
                window.captureExportJob = job;
                return job.completed;
            })
            .then((result) => {
                window.captureExportOutcome = result;
            })
            .catch((error) => {
                window.captureExportOutcome = {
                    state: 'failed',
                    error: String(error.message ?? error),
                };
            });
    });
