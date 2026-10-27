import { NativeCaptureRepository } from '../../src/features/automation/capture/native-repository';
import { CaptureWriter } from '../../shared/capture-writer';
const api = { NativeCaptureRepository, CaptureWriter };
declare global {
    interface Window {
        captureElectronQA: typeof api;
    }
}
window.captureElectronQA = api;
