import { TERMINAL_CHUNK_BYTES, TERMINAL_QUEUE_BYTES } from './terminal';

export const SERIAL_CHUNK_BYTES = TERMINAL_CHUNK_BYTES;
export const SERIAL_QUEUE_BYTES = TERMINAL_QUEUE_BYTES;
export const SERIAL_CLOSE_MS = 5000;
export interface SerialSettings {
    baudRate: number;
    dataBits: 7 | 8;
    stopBits: 1 | 2;
    parity: 'none' | 'even' | 'odd';
    flowControl: 'none' | 'hardware';
}
export const DEFAULT_SERIAL_SETTINGS: SerialSettings = {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
};
export function serialSettings(value: SerialSettings): SerialSettings {
    if (
        !Number.isSafeInteger(value.baudRate) ||
        value.baudRate < 1 ||
        value.baudRate > 4294967295 ||
        ![7, 8].includes(value.dataBits) ||
        ![1, 2].includes(value.stopBits) ||
        !['none', 'even', 'odd'].includes(value.parity) ||
        !['none', 'hardware'].includes(value.flowControl)
    )
        throw Error('Choose a baud rate from 1 to 4000000 and supported serial framing.');
    return {
        baudRate: value.baudRate,
        dataBits: value.dataBits,
        stopBits: value.stopBits,
        parity: value.parity,
        flowControl: value.flowControl,
    };
}
export interface LocalSerialPort {
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
    open(options: SerialSettings & { bufferSize: number }): Promise<void>;
    close(): Promise<void>;
    getInfo(): { usbVendorId?: number; usbProductId?: number };
    forget?(): Promise<void>;
}
export interface LocalSerial extends EventTarget {
    requestPort(options?: {
        filters?: { usbVendorId: number; usbProductId?: number }[];
    }): Promise<LocalSerialPort>;
    getPorts(): Promise<LocalSerialPort[]>;
}
export function localSerial(): LocalSerial | undefined {
    return (navigator as Navigator & { serial?: LocalSerial }).serial;
}
export interface SerialChoice {
    id: string;
    name: string;
    displayName?: string;
}
export interface SerialChooser {
    id: string;
    ports: SerialChoice[];
}
export interface SerialDesktopBridge {
    onSerialChooser(callback: (chooser: SerialChooser | null) => void): () => void;
    selectSerialPort(id: string, portId: string): Promise<void>;
    onSerialQuiesce(callback: (id: string) => void): () => void;
    acknowledgeSerialQuiesce(id: string): Promise<void>;
}
