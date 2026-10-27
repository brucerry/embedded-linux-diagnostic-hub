import type { LocalSerialPort } from '../../shared/serial';

/** Pull-driven synthetic UART. At most one generated receive chunk is queued. */
export function serialCaptureFixture(
    response: (request: Uint8Array, ordinal: number) => AsyncIterable<Uint8Array>,
) {
    let controller: ReadableStreamDefaultController<Uint8Array>,
        demand = false,
        pumping = false,
        iterator: AsyncIterator<Uint8Array> | undefined,
        opens = 0,
        closes = 0;
    const writes: Uint8Array[] = [];
    const pump = async () => {
        if (!demand || pumping || !iterator) return;
        pumping = true;
        try {
            const item = await iterator.next();
            if (item.done) iterator = undefined;
            else {
                demand = false;
                controller.enqueue(Uint8Array.from(item.value));
            }
        } catch (error) {
            controller.error(error);
        } finally {
            pumping = false;
            if (demand && iterator) void pump();
        }
    };
    const port: LocalSerialPort = {
        readable: null,
        writable: null,
        async open() {
            opens++;
            this.readable = new ReadableStream<Uint8Array>({
                start(c) {
                    controller = c;
                },
                pull() {
                    demand = true;
                    void pump();
                },
                async cancel() {
                    await iterator?.return?.();
                    iterator = undefined;
                },
            });
            this.writable = new WritableStream<Uint8Array>({
                write(request) {
                    if (iterator)
                        throw Error(
                            'Synthetic UART received another command before its response drained.',
                        );
                    const owned = Uint8Array.from(request);
                    writes.push(owned);
                    iterator = response(owned, writes.length)[Symbol.asyncIterator]();
                    void pump();
                },
            });
        },
        async close() {
            closes++;
            this.readable = null;
            this.writable = null;
        },
        getInfo: () => ({}),
    };
    return {
        port,
        writes,
        get opens() {
            return opens;
        },
        get closes() {
            return closes;
        },
    };
}
export function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
export async function until(check: () => boolean, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > end) throw Error('Synthetic capture condition did not settle.');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
