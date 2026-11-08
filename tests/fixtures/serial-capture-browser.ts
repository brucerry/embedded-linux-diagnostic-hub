import { serialCaptureFixture, deferred } from './serial-capture';
import { IndexedDbCaptureStore } from '../../src/features/automation/capture/indexeddb-store';
import { serialCaptureBackend } from '../../src/features/automation/capture/serial-backend';
import { SerialSession } from '../../src/features/serial/session';
import { FlowRunner } from '../../src/features/automation/runner';
import { DEFAULT_SERIAL_SETTINGS } from '../../shared/serial';
import { CaptureStorageError } from '../../shared/capture-store';
import { streamCaptureReport } from '../../shared/capture-report';
const api = {
    serialCaptureFixture,
    deferred,
    IndexedDbCaptureStore,
    serialCaptureBackend,
    SerialSession,
    FlowRunner,
    DEFAULT_SERIAL_SETTINGS,
    CaptureStorageError,
    streamCaptureReport,
};
declare global {
    interface Window {
        serialCaptureQA: typeof api;
    }
}
window.serialCaptureQA = api;
