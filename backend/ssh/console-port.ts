import { CaptureStorageError } from '../../shared/capture-store';
import { CONSOLE_IDLE_RENEWAL_MS } from '../../shared/console-rpc';
import {
    consoleWriteRequest,
    consoleWriteReply,
    type ConsoleWrite,
    type ConsoleWriteReply,
} from '../../shared/console-storage';
type Pending = {
    sequence: number;
    request: ConsoleWrite;
    delivered: boolean;
    resolve: (reply: ConsoleWriteReply) => void;
    reject: (error: Error) => void;
};
/** One durable operation in flight. Delivery never means commit; only the matching ACK does. */
export class ConsoleOperationPort {
    private pending?: Pending;
    private sequence = 0;
    private wake?: () => void;
    private reading = false;
    private failure?: Error;
    private closedWaiters = new Set<() => void>();
    constructor(private status: () => { revision: number; [key: string]: unknown }) {}
    notify() {
        this.wake?.();
    }
    call = (input: ConsoleWrite): Promise<unknown> => {
        if (this.failure) return Promise.reject(this.failure);
        if (this.pending)
            return Promise.reject(
                new CaptureStorageError(
                    'backlog',
                    'A console persistence operation is still awaiting acknowledgement.',
                ),
            );
        const request = consoleWriteRequest(input);
        return new Promise<ConsoleWriteReply>((resolve, reject) => {
            this.pending = {
                sequence: this.sequence++,
                request,
                delivered: false,
                resolve,
                reject,
            };
            this.notify();
        });
    };
    async read(revision: number) {
        if (this.reading || this.pending?.delivered)
            throw Error('Only one console operation may await acknowledgement.');
        this.reading = true;
        let idle = false;
        const renewal = setTimeout(() => {
            idle = true;
            this.notify();
        }, CONSOLE_IDLE_RENEWAL_MS);
        try {
            while (!this.pending && this.status().revision === revision && !this.failure && !idle)
                await new Promise<void>((resolve) => {
                    this.wake = resolve;
                });
            if (this.failure) throw this.failure;
            if (this.pending) {
                this.pending.delivered = true;
                return {
                    protocol: 1,
                    type: 'operation',
                    sequence: this.pending.sequence,
                    request: structuredClone(this.pending.request),
                };
            }
            const status = this.status();
            if (idle && status.revision === revision)
                return { protocol: 1, type: 'idle', id: status.id, revision: status.revision };
            return { protocol: 1, type: 'state', ...status };
        } finally {
            clearTimeout(renewal);
            this.wake = undefined;
            this.reading = false;
            this.settleClosed();
        }
    }
    acknowledge(
        sequence: number,
        reply: ConsoleWriteReply | null,
        error: { code: string; message: string } | null,
    ) {
        const pending = this.pending;
        if (!pending || !pending.delivered || pending.sequence !== sequence)
            throw Error('Console acknowledgement is invalid or stale.');
        const value = reply === null ? null : consoleWriteReply(reply);
        this.pending = undefined;
        if (error)
            pending.reject(
                new CaptureStorageError(error.code as CaptureStorageError['code'], error.message),
            );
        else pending.resolve(value!);
        return { ok: true };
    }
    fail(error: Error) {
        this.failure ??= error;
        this.pending?.reject(error);
        this.pending = undefined;
        this.notify();
        this.settleClosed();
    }
    private settleClosed() {
        if (!this.failure || this.pending || this.reading) return;
        for (const resolve of this.closedWaiters) resolve();
        this.closedWaiters.clear();
    }
    /** Close only this local port and join its actual outstanding reader. No remote ACK is implied. */
    async dispose(error: Error) {
        this.fail(error);
        if (this.reading || this.pending)
            await new Promise<void>((resolve) => this.closedWaiters.add(resolve));
        if (this.reading || this.pending)
            throw Error('Console operation port cleanup remains pending.');
    }
    get snapshot() {
        return {
            pending: this.pending ? 1 : 0,
            reading: this.reading,
            delivered: Boolean(this.pending?.delivered),
            failed: Boolean(this.failure),
            closeWaiters: this.closedWaiters.size,
        };
    }
}
