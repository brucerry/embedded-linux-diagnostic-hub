import { contextBridge, ipcRenderer } from 'electron';
import type { ConnectOptions, DesktopBridge, HostKeyVerification, Snapshot } from '../shared/types';

const bridge: DesktopBridge = {
    confirmHostKey: (id, accepted) => ipcRenderer.invoke('hub:confirm-host-key', id, accepted),
    onHostKeyVerification: (callback) => {
        const listener = (_event: unknown, request: HostKeyVerification | null) =>
            callback(request);
        ipcRenderer.on('hub:verify-host-key', listener);
        return () => ipcRenderer.removeListener('hub:verify-host-key', listener);
    },
    connect: (options: ConnectOptions) => ipcRenderer.invoke('hub:connect', options),
    disconnect: () => ipcRenderer.invoke('hub:disconnect'),
    collect: () => ipcRenderer.invoke('hub:collect'),
    copyText: (command: string) => ipcRenderer.invoke('hub:copy-text', command),
    openRepository: () => ipcRenderer.invoke('hub:open-repository'),
    pickKey: () => ipcRenderer.invoke('hub:pick-key'),
    exportReport: (importedSnapshot?: Snapshot) =>
        ipcRenderer.invoke('hub:export', importedSnapshot),
    onDisconnected: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on('hub:disconnected', listener);
        return () => ipcRenderer.removeListener('hub:disconnected', listener);
    },
};
contextBridge.exposeInMainWorld('diagnosticHub', bridge);
