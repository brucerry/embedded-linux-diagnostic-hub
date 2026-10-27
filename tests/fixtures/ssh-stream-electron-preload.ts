import '../../electron/preload';
import { contextBridge } from 'electron';
const runtime = {
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true,
};
contextBridge.exposeInMainWorld('sshNativeRuntime', runtime);
declare global {
    interface Window {
        sshNativeRuntime: typeof runtime;
    }
}
