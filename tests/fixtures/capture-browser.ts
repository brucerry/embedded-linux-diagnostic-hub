import { IndexedDbCaptureStore } from '../../src/features/automation/capture/indexeddb-store';
import { CaptureWriter } from '../../shared/capture-writer';
import { streamCaptureJson } from '../../shared/capture-export';
import { streamCaptureReport } from '../../shared/capture-report';
import { CAPTURE_STORAGE, CaptureStorageError } from '../../shared/capture-store';
import {
    startBrowserCaptureExport,
    type BrowserExportDiagnostic,
} from '../../src/features/automation/capture/browser-export';
interface CaptureExportAttempt {
    sequence: number;
    startup: 'pending' | 'admitted' | 'rejected';
    completion: 'pending' | 'resolved' | 'rejected';
    diagnostic?: BrowserExportDiagnostic;
}
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
        captureExportAttempt?: CaptureExportAttempt;
    }
}
window.captureQA = api;
for (const format of ['json', 'csv', 'markdown', 'text'] as const)
    document.getElementById('export-' + format)?.addEventListener('click', () => {
        const attempt: CaptureExportAttempt = {
            sequence: (window.captureExportAttempt?.sequence ?? 0) + 1,
            startup: 'pending',
            completion: 'pending',
        };
        window.captureExportAttempt = attempt;
        window.captureExportJob = undefined;
        window.captureExportOutcome = { state: 'preparing' };
        void startBrowserCaptureExport(format, {}, 'capture', (diagnostic) => {
            // A diagnostic never settles completed or proves resource retirement.
            attempt.diagnostic = { ...diagnostic };
        })
            .then((job) => {
                attempt.startup = 'admitted';
                if (window.captureExportAttempt === attempt) window.captureExportJob = job;
                return job.completed.then(
                    (result) => {
                        attempt.completion = 'resolved';
                        return result;
                    },
                    (error) => {
                        attempt.completion = 'rejected';
                        throw error;
                    },
                );
            })
            .then((result) => {
                if (window.captureExportAttempt === attempt) window.captureExportOutcome = result;
            })
            .catch((error) => {
                if (attempt.startup === 'pending') attempt.startup = 'rejected';
                if (window.captureExportAttempt !== attempt) return;
                window.captureExportOutcome = {
                    state: 'failed',
                    error: String(error.message ?? error),
                };
            });
    });
