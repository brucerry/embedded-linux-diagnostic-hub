import type { Page } from '@playwright/test';

export interface SerialCustodyState {
    opens: number;
    readers: number;
    writes: number[][];
    writeAcks: number;
    aborts: number;
    readerCancels: number;
    closes: number;
    closeAcks: number;
    acknowledgeWrite(): void;
    acknowledgeClose(): void;
    recoverBreak(): void;
    push(text: string): void;
    leases: string[];
    releases: string[];
    appendAcks: number;
    observeBridge(): void;
}
declare global {
    interface Window {
        serialCustodyTest: SerialCustodyState;
    }
}

// Only browser-memory streams and one synthetic port. No real Serial permission or IO.
export async function installSerialCustody(page: Page) {
    await page.addInitScript(() => {
        let receive: ReadableStreamDefaultController<Uint8Array>;
        let writeAck: (() => void) | undefined, closeAck: (() => void) | undefined;
        let observing = false;
        const state: SerialCustodyState = {
            opens: 0, readers: 0, writes: [], writeAcks: 0,
            aborts: 0, readerCancels: 0, closes: 0, closeAcks: 0,
            leases: [], releases: [], appendAcks: 0,
            observeBridge() {
                if (observing) throw Error('Synthetic bridge observation already installed.');
                observing = true;
                const bridge = window.diagnosticHub!;
                const captureStorage = bridge.captureStorage!;
                bridge.captureStorage = async (request) => {
                    const reply = await captureStorage(request);
                    if (request.op === 'append' && reply.ok) state.appendAcks++;
                    return reply;
                };
                bridge.acquireAutomationActivity = async () => {
                    const id = 'serial-custody-' + (state.leases.length + 1);
                    state.leases.push(id);
                    return id;
                };
                bridge.releaseAutomationActivity = async (id) => {
                    state.releases.push(id);
                };
            },
            acknowledgeWrite() {
                if (!writeAck) throw Error('No owned pending synthetic write.');
                const ack = writeAck;
                writeAck = undefined;
                ack();
            },
            acknowledgeClose() {
                if (!closeAck) throw Error('No owned pending synthetic close.');
                const ack = closeAck;
                closeAck = undefined;
                ack();
            },
            recoverBreak() {
                const previous = receive;
                port.readable = input();
                previous.error(new DOMException('synthetic recoverable break', 'BreakError'));
            },
            push(text) {
                const bytes = new TextEncoder().encode(text);
                if (bytes.length > 128) throw Error('Synthetic receive bound exceeded.');
                receive.enqueue(bytes);
            },
        };
        const input = () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) { receive = controller; },
                cancel() { state.readerCancels++; },
            });
            const getReader = stream.getReader.bind(stream);
            Object.defineProperty(stream, 'getReader', { value: () => {
                state.readers++;
                return getReader();
            } });
            return stream;
        };
        const port = {
            readable: null as ReadableStream<Uint8Array> | null,
            writable: null as WritableStream<Uint8Array> | null,
            async open() {
                if (++state.opens !== 1) throw Error('Unexpected implicit reopen.');
                this.readable = input();
                this.writable = new WritableStream<Uint8Array>({
                    async write(bytes) {
                        if (bytes.length > 64 || state.writes.length >= 1)
                            throw Error('Unexpected replay or queued command.');
                        state.writes.push([...bytes]);
                        await new Promise<void>((resolve) => { writeAck = resolve; });
                        state.writeAcks++;
                    },
                    abort() { state.aborts++; },
                });
            },
            async close() {
                if (++state.closes !== 1) throw Error('Unexpected duplicate synthetic close.');
                if (this.readable?.locked || this.writable?.locked)
                    throw Error('Port close dispatched before stream locks retired.');
                await new Promise<void>((resolve) => { closeAck = resolve; });
                state.closeAcks++;
                this.readable = null;
                this.writable = null;
            },
            getInfo() { return { usbVendorId: 0xabcd, usbProductId: 0x1234 }; },
        };
        const api = Object.assign(new EventTarget(), {
            async getPorts() { return [port]; },
            async requestPort() { return port; },
        });
        Object.defineProperty(navigator, 'serial', { value: api, configurable: true });
        window.serialCustodyTest = state;
    });
}
