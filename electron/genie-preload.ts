import { contextBridge, ipcRenderer } from 'electron';
import type { GenieBridge } from './genie-contract';

const generation = Number(
    process.argv.find((arg) => arg.startsWith('--genie-generation='))?.split('=')[1],
);
const bridge: GenieBridge = {
    payload: () => ipcRenderer.invoke('genie:payload', generation),
    ready: () => ipcRenderer.invoke('genie:ready', generation),
    done: () => ipcRenderer.invoke('genie:done', generation),
};
contextBridge.exposeInMainWorld('genie', bridge);
