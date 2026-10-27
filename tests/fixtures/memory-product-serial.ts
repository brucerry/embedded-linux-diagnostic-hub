import type { LocalSerialPort } from '../../shared/serial';

type Mode = {
    bytes: number;
    chunkBytes: number;
    delayMs: number;
    prompt: string;
    holdOpen?: boolean;
    holdWrite?: boolean;
    stall?: boolean;
    holdPrompt?: boolean;
    tail?: string;
};
export function installProductSerial() {
    let mode: Mode = { bytes: 32, chunkBytes: 16384, delayMs: 0, prompt: 'qualification# ' };
    let generation = 0,
        opens = 0,
        closes = 0,
        sent = 0,
        writes = 0,
        produced = 0,
        pumping = false,
        demand = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let readerActive = false,
        writerActive = false,
        cancelled = false;
    let remaining = 0,
        promptPending = false;
    let openRelease: (() => void) | undefined, writeRelease: (() => void) | undefined;
    let pumpTask: Promise<void> | undefined;
    const events: { ordinal: number; event: string; bytes: number }[] = [];
    let ordinal = 0;
    const event = (name: string, bytes = 0) => {
        events.push({ ordinal: ++ordinal, event: name, bytes });
        if (events.length > 64) events.shift();
    };
    const pump = () => {
        if (
            pumping ||
            !demand ||
            !controller ||
            cancelled ||
            mode.stall ||
            (!remaining && (!promptPending || mode.holdPrompt))
        )
            return;
        const current = generation;
        pumping = true;
        pumpTask = (async () => {
            if (mode.delayMs)
                await new Promise<void>((resolve) => setTimeout(resolve, mode.delayMs));
            if (current !== generation || cancelled) return;
            let bytes: Uint8Array;
            if (remaining) {
                const offset = mode.bytes - remaining;
                bytes = new Uint8Array(Math.min(remaining, mode.chunkBytes)).fill(120);
                if (mode.tail) {
                    const tail = new TextEncoder().encode(mode.tail),
                        start = mode.bytes - tail.length;
                    for (let index = Math.max(0, start - offset); index < bytes.length; index++)
                        bytes[index] = tail[offset + index - start];
                }
                remaining -= bytes.length;
            } else {
                bytes = new TextEncoder().encode('\r\n' + mode.prompt);
                promptPending = false;
            }
            demand = false;
            produced += bytes.length;
            controller!.enqueue(bytes);
        })().finally(() => {
            pumping = false;
            pumpTask = undefined;
            if (demand) pump();
        });
    };
    const port: LocalSerialPort = {
        readable: null,
        writable: null,
        getInfo: () => ({ usbVendorId: 0xabcd, usbProductId: 0x0600 }),
        async open() {
            event('open-start');
            opens++;
            if (mode.holdOpen)
                await new Promise<void>((resolve) => {
                    openRelease = resolve;
                });
            cancelled = false;
            generation++;
            remaining = 0;
            promptPending = false;
            demand = false;
            const input = new ReadableStream<Uint8Array>(
                {
                    start(value) {
                        controller = value;
                    },
                    pull() {
                        demand = true;
                        pump();
                    },
                    async cancel() {
                        cancelled = true;
                        generation++;
                        remaining = 0;
                        promptPending = false;
                        await pumpTask;
                        event('read-cancel');
                    },
                },
                { highWaterMark: 0 },
            );
            const getReader = input.getReader.bind(input);
            Object.defineProperty(input, 'getReader', {
                value: () => {
                    if (readerActive) throw Error('Fixture duplicate reader.');
                    readerActive = true;
                    const reader = getReader();
                    const release = reader.releaseLock.bind(reader);
                    reader.releaseLock = () => {
                        release();
                        readerActive = false;
                        event('reader-release');
                    };
                    return reader;
                },
            });
            const output = new WritableStream<Uint8Array>({
                async write(bytes) {
                    writes++;
                    event('write-start', bytes.length);
                    sent += bytes.length;
                    if (mode.holdWrite)
                        await new Promise<void>((resolve) => {
                            writeRelease = resolve;
                        });
                    if (remaining || promptPending)
                        throw Error('Fixture command overlapped undrained output.');
                    remaining = mode.bytes;
                    promptPending = true;
                    event('write-ack', bytes.length);
                    pump();
                },
            });
            const getWriter = output.getWriter.bind(output);
            Object.defineProperty(output, 'getWriter', {
                value: () => {
                    if (writerActive) throw Error('Fixture duplicate writer.');
                    writerActive = true;
                    const writer = getWriter();
                    const release = writer.releaseLock.bind(writer);
                    writer.releaseLock = () => {
                        release();
                        writerActive = false;
                        event('writer-release');
                    };
                    return writer;
                },
            });
            this.readable = input;
            this.writable = output;
            event('open-ack');
        },
        async close() {
            if (readerActive || writerActive || openRelease || writeRelease)
                throw Error('Fixture port closed before actual stream ownership ended.');
            cancelled = true;
            generation++;
            await pumpTask;
            if (pumping) throw Error('Fixture producer did not join at close.');
            event('producer-close', remaining);
            remaining = 0;
            promptPending = false;
            demand = false;
            closes++;
            this.readable = null;
            this.writable = null;
            controller = undefined;
            event('close-ack');
        },
    };
    const api = Object.assign(new EventTarget(), {
        async getPorts() {
            return [port];
        },
        async requestPort() {
            return port;
        },
    });
    // This module runs only in a private qualification document. Shadow the API without
    // enumerating, requesting, or opening any real host port.
    Object.defineProperty(navigator, 'serial', { value: api, configurable: true });
    return {
        port,
        configure(next: Partial<Mode>) {
            if (remaining || promptPending || pumping)
                throw Error('Finish current fixture response before reconfiguration.');
            mode = { ...mode, ...next };
            if (
                !Number.isSafeInteger(mode.bytes) ||
                mode.bytes < 0 ||
                mode.bytes > 64 * 1024 ** 2 ||
                !Number.isSafeInteger(mode.chunkBytes) ||
                mode.chunkBytes < 1 ||
                mode.chunkBytes > 16384 ||
                !Number.isFinite(mode.delayMs) ||
                mode.delayMs < 0 ||
                mode.delayMs > 1000
            )
                throw Error('Invalid bounded Serial fixture response.');
            if (
                mode.tail !== undefined &&
                (typeof mode.tail !== 'string' ||
                    new TextEncoder().encode(mode.tail).length > Math.min(256, mode.bytes))
            )
                throw Error('Invalid bounded Serial fixture tail.');
        },
        releaseOpen() {
            const release = openRelease;
            openRelease = undefined;
            if (!release) throw Error('No held fixture open.');
            release();
        },
        releaseWrite() {
            const release = writeRelease;
            writeRelease = undefined;
            if (!release) throw Error('No held fixture write.');
            release();
        },
        releaseOutput() {
            mode.stall = false;
            mode.holdPrompt = false;
            pump();
            event('output-release');
        },
        unplug() {
            cancelled = true;
            generation++;
            controller?.error(Error('Synthetic local adapter removed.'));
            const e = new Event('disconnect');
            Object.defineProperty(e, 'port', { value: port });
            api.dispatchEvent(e);
            event('unplug');
        },
        snapshot() {
            return {
                opens,
                closes,
                sent,
                writes,
                generation,
                stalled: mode.stall === true,
                promptHeld: mode.holdPrompt === true && remaining === 0 && promptPending,
                produced,
                readerActive,
                writerActive,
                pumping,
                remaining,
                promptPending,
                heldOpen: Boolean(openRelease),
                heldWrite: Boolean(writeRelease),
                events: [...events],
            };
        },
    };
}
