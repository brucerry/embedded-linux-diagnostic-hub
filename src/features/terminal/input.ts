import { TERMINAL_CHUNK_BYTES, TERMINAL_QUEUE_BYTES } from '../../../shared/terminal';

export function encodeTerminalBytes(bytes: Uint8Array): string {
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

// Short batches keep gateway typing below the request budget; writes remain ordered.
export class TerminalInputQueue {
    private bytes: number[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private sending = false;
    private ended = false;
    constructor(
        private send: (data: string) => Promise<void>,
        private failed: (message: string) => void,
    ) {}

    push(data: Uint8Array): void {
        if (this.ended) return;
        if (this.bytes.length + data.length > TERMINAL_QUEUE_BYTES) {
            this.failed('Terminal input queue is full. Wait before pasting more text.');
            return;
        }
        for (const byte of data) this.bytes.push(byte);
        if (!this.sending && !this.timer)
            this.timer = setTimeout(() => {
                void this.flush();
            }, 20);
    }

    private async flush(): Promise<void> {
        this.timer = undefined;
        this.sending = true;
        try {
            while (this.bytes.length && !this.ended) {
                const chunk = new Uint8Array(this.bytes.splice(0, TERMINAL_CHUNK_BYTES));
                await this.send(encodeTerminalBytes(chunk));
            }
        } catch {
            this.clear();
            if (!this.ended)
                this.failed(
                    'Terminal input could not be delivered. Reconnect the device to retry.',
                );
        } finally {
            this.sending = false;
        }
    }

    clear(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.bytes = [];
    }
    close(): void {
        this.ended = true;
        this.clear();
    }
}
