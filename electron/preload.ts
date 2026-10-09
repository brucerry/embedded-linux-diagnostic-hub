import { contextBridge, ipcRenderer } from 'electron';
import type { ConnectOptions, DesktopBridge, HostKeyVerification, Snapshot } from '../shared/types';
import type { TerminalEvent } from '../shared/terminal';

const bridge: DesktopBridge = {
    openTerminal: (request) => ipcRenderer.invoke('hub:terminal-open', request),
    writeTerminal: (id, data) => ipcRenderer.invoke('hub:terminal-input', id, data),
    resizeTerminal: (id, size) => ipcRenderer.invoke('hub:terminal-resize', id, size),
    closeTerminal: (id) => ipcRenderer.invoke('hub:terminal-close', id),
    acknowledgeTerminal: (id, sequence) => ipcRenderer.invoke('hub:terminal-ack', id, sequence),
    onTerminalEvent: (callback) => {
        const listener = (_event: unknown, event: TerminalEvent) => {
            void callback(event);
        };
        ipcRenderer.on('hub:terminal-event', listener);
        return () => ipcRenderer.removeListener('hub:terminal-event', listener);
    },
    checkUpdates: (includePrereleases) =>
        ipcRenderer.invoke('hub:check-updates', includePrereleases),
    startUpdate: (request) => ipcRenderer.invoke('hub:start-update', request),
    readUpdateReport: () => ipcRenderer.invoke('hub:read-update-report'),
    acknowledgeUpdateReport: (id) => ipcRenderer.invoke('hub:acknowledge-update-report', id),
    clearSessionData: () => ipcRenderer.invoke('hub:clear-session-data'),
    onUpdateProgress: (callback) => {
        const listener = (_event: unknown, progress: string) => callback(progress);
        ipcRenderer.on('hub:update-progress', listener);
        return () => ipcRenderer.removeListener('hub:update-progress', listener);
    },
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
    readDeviceClock: () => ipcRenderer.invoke('hub:device-clock'),
    copyText: (command: string) => ipcRenderer.invoke('hub:copy-text', command),
    readClipboard: () => ipcRenderer.invoke('hub:read-clipboard'),
    openRepository: () => ipcRenderer.invoke('hub:open-repository'),
    openReleases: () => ipcRenderer.invoke('hub:open-releases'),
    pickKey: () => ipcRenderer.invoke('hub:pick-key'),
    exportReport: (importedSnapshot?: Snapshot) =>
        ipcRenderer.invoke('hub:export', importedSnapshot),
    onDisconnected: (callback) => {
        const listener = (_event: unknown, reason?: 'update') => callback(reason);
        ipcRenderer.on('hub:disconnected', listener);
        return () => ipcRenderer.removeListener('hub:disconnected', listener);
    },
};
contextBridge.exposeInMainWorld('diagnosticHub', bridge);
