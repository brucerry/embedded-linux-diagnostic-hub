import { NativeCaptureRepository } from '../../src/features/automation/capture/native-repository';
import { SshStreamClient } from '../../src/features/automation/capture/ssh-stream-client';
import { captureToRepository } from '../../shared/automation-capture';
const api = { NativeCaptureRepository, SshStreamClient, captureToRepository };
declare global {
    interface Window {
        sshNativeQA: typeof api;
    }
}
window.sshNativeQA = api;
