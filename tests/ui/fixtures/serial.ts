import type { Page } from '@playwright/test';
export interface SerialTestState {
    opens: number;
    closes: number;
    readers: number;
    recoverBreak(): void;
    writes: number[][];
    holdOpen: boolean;
    push(bytes: number[]): void;
    unplug(): void;
    releaseOpen?: () => void;
}
declare global {
    interface Window {
        serialTest: SerialTestState;
    }
}
export async function installSerial(page: Page) {
    await page.addInitScript(() => {
        let input: ReadableStreamDefaultController<Uint8Array>,
            available = true;
        const state: SerialTestState = {
            opens: 0,
            closes: 0,
            readers: 0,
            recoverBreak() {
                const previous = input;
                port.readable = createInput();
                previous.error(new DOMException('break received', 'BreakError'));
            },
            writes: [],
            holdOpen: false,
            push(bytes) {
                input.enqueue(new Uint8Array(bytes));
            },
            unplug() {
                available = false;
                input.error(Error('Adapter unplugged'));
                const event = new Event('disconnect');
                Object.defineProperty(event, 'port', { value: port });
                api.dispatchEvent(event);
            },
        };
        const createInput = () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    input = controller;
                },
            });
            const getReader = stream.getReader.bind(stream);
            Object.defineProperty(stream, 'getReader', {
                value: () => {
                    state.readers++;
                    return getReader();
                },
            });
            return stream;
        };
        const port = {
            readable: null as ReadableStream<Uint8Array> | null,
            writable: null as WritableStream<Uint8Array> | null,
            async open() {
                state.opens++;
                if (state.holdOpen)
                    await new Promise<void>((resolve) => {
                        state.releaseOpen = resolve;
                    });
                this.readable = createInput();
                this.writable = new WritableStream({
                    write(bytes: Uint8Array) {
                        state.writes.push([...bytes]);
                    },
                });
            },
            async close() {
                state.closes++;
                this.readable = null;
                this.writable = null;
            },
            getInfo() {
                return { usbVendorId: 0xabcd, usbProductId: 0x1234 };
            },
            async forget() {
                available = false;
            },
        };
        const api = Object.assign(new EventTarget(), {
            async getPorts() {
                return available ? [port] : [];
            },
            async requestPort() {
                return port;
            },
        });
        Object.defineProperty(navigator, 'serial', { value: api, configurable: true });
        window.serialTest = state;
    });
}
