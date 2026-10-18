import type { Client, ClientChannel } from 'ssh2';
import {
    TERMINAL_CHUNK_BYTES,
    TERMINAL_QUEUE_BYTES,
    TERMINAL_WINDOW_BYTES,
    TERMINAL_STALL_MS,
    terminalData,
    terminalSequence,
    terminalSize,
    type TerminalEvent,
    type TerminalOpen,
    type TerminalSize,
} from '../../shared/terminal';

// A PTY channel owns only its shell, never the authenticated SSH connection.
export class SshTerminal {
    private stream?: ClientChannel;
    private ended = false;
    private sequence = 0;
    private acknowledged = 0;
    private pending = new Map<number, number>();
    private pendingBytes = 0;
    private inputBytes = 0;
    private stalled?: ReturnType<typeof setTimeout>;
    private openingTimer?: ReturnType<typeof setTimeout>;
    private rejectOpening?: (error: Error) => void;
    private writes = new Set<(error?: Error) => void>();
    private underlyingWrites = new Set<(error?: Error | null) => void>();
    private openingPending = false;
    private channelClosed = false;
    private cleanupClosed = false;
    private cleanupResolve!: () => void;
    private cleanupDone = new Promise<void>((resolve) => {
        this.cleanupResolve = resolve;
    });
    private outputData = (data: Buffer) => this.output(data);
    private streamError = () =>
        this.close('The remote terminal channel failed. Reconnect the device to retry.');
    private streamClose = () => {
        this.channelClosed = true;
        this.close();
        this.settleCleanup();
    };
    readonly id: string;

    constructor(
        request: TerminalOpen,
        private emit: (event: TerminalEvent) => void,
        private finished: () => void,
        private stallMs = TERMINAL_STALL_MS,
        private inputBlocked: () => boolean = () => false,
    ) {
        this.id = request.id;
    }

    open(client: Client, size: TerminalSize): Promise<void> {
        if (this.ended) return Promise.reject(Error('This terminal is already closed.'));
        this.emit({ id: this.id, type: 'state', state: 'opening' });
        return new Promise((resolve, reject) => {
            this.openingPending = true;
            this.rejectOpening = reject;
            this.openingTimer = setTimeout(
                () => this.close('The device did not open a terminal within 30 seconds.'),
                TERMINAL_STALL_MS,
            );
            try {
                client.shell({ term: 'xterm-256color', ...terminalSize(size) }, (error, stream) => {
                    this.openingPending = false;
                    if (stream) {
                        this.stream = stream;
                        stream.on('error', this.streamError);
                        stream.stderr.on('error', this.streamError);
                        stream.once('close', this.streamClose);
                    }
                    if (this.ended) {
                        stream?.destroy();
                        stream?.resume();
                        stream?.stderr.resume();
                        this.settleCleanup();
                        return;
                    }
                    if (error) {
                        this.close(
                            'The device refused the terminal. Check PTY and shell access for this SSH user.',
                        );
                        return;
                    }
                    clearTimeout(this.openingTimer);
                    this.openingTimer = undefined;
                    this.rejectOpening = undefined;
                    this.stream = stream;
                    stream.on('data', this.outputData);
                    stream.stderr.on('data', this.outputData);
                    this.emit({ id: this.id, type: 'state', state: 'open' });
                    resolve();
                });
            } catch {
                this.openingPending = false;
                this.close('The remote terminal channel could not be opened. Reconnect to retry.');
            }
        });
    }

    private output(data: Buffer): void {
        if (this.ended) return;
        if (data.length + this.pendingBytes > TERMINAL_QUEUE_BYTES) {
            this.close(
                'Terminal output exceeded the display capacity. Reconnect the device to retry.',
            );
            return;
        }
        for (let offset = 0; offset < data.length; offset += TERMINAL_CHUNK_BYTES) {
            const chunk = data.subarray(offset, offset + TERMINAL_CHUNK_BYTES);
            const sequence = ++this.sequence;
            this.pending.set(sequence, chunk.length);
            this.pendingBytes += chunk.length;
            this.emit({ id: this.id, type: 'data', sequence, data: chunk.toString('base64') });
        }
        if (this.pendingBytes >= TERMINAL_WINDOW_BYTES) {
            this.stream?.pause();
            this.stream?.stderr.pause();
        }
        if (this.pendingBytes && !this.stalled)
            this.stalled = setTimeout(
                () =>
                    this.close(
                        'Terminal display stopped consuming output. Reconnect the device to retry.',
                    ),
                this.stallMs,
            );
    }

    acknowledge(sequence: unknown): void {
        const next = terminalSequence(sequence);
        if (next <= this.acknowledged || !this.pending.has(next))
            throw Error('Invalid terminal output acknowledgment.');
        for (const [index, bytes] of this.pending) {
            if (index > next) break;
            this.pendingBytes -= bytes;
            this.pending.delete(index);
        }
        this.acknowledged = next;
        clearTimeout(this.stalled);
        this.stalled = undefined;
        if (this.pendingBytes)
            this.stalled = setTimeout(
                () =>
                    this.close(
                        'Terminal display stopped consuming output. Reconnect the device to retry.',
                    ),
                this.stallMs,
            );
        if (this.pendingBytes < TERMINAL_WINDOW_BYTES) {
            this.stream?.resume();
            this.stream?.stderr.resume();
        }
    }

    get hasPendingInput() {
        return this.inputBytes > 0 || this.underlyingWrites.size > 0;
    }
    async write(data: unknown): Promise<void> {
        if (this.inputBlocked()) throw Error('Terminal input is paused during Automation.');
        const bytes = Buffer.from(terminalData(data), 'base64');
        const stream = this.stream;
        if (this.ended || !stream) throw Error('Connect to a device first.');
        if (this.inputBytes + bytes.length > TERMINAL_QUEUE_BYTES)
            throw Error('Terminal input queue is full. Wait before pasting more text.');
        this.inputBytes += bytes.length;
        await new Promise<void>((resolve, reject) => {
            const finish = (error?: Error | null) => {
                if (!this.writes.delete(finish)) return;
                this.inputBytes -= bytes.length;
                error ? reject(Error('Terminal input could not be delivered.')) : resolve();
            };
            this.writes.add(finish);
            const written = (error?: Error | null) => {
                if (!this.underlyingWrites.delete(written)) return;
                finish(error);
                this.settleCleanup();
            };
            this.underlyingWrites.add(written);
            try {
                stream.write(bytes, written);
            } catch (error) {
                written(error instanceof Error ? error : Error(String(error)));
            }
        });
    }

    resize(size: unknown): void {
        const { rows, cols } = terminalSize(size);
        if (this.ended || !this.stream) throw Error('Connect to a device first.');
        this.stream.setWindow(rows, cols, 0, 0);
    }

    close(message?: string): void {
        if (this.ended) {
            this.settleCleanup();
            return;
        }
        this.ended = true;
        clearTimeout(this.stalled);
        clearTimeout(this.openingTimer);
        this.stalled = undefined;
        this.openingTimer = undefined;
        this.rejectOpening?.(Error(message ?? 'Terminal closed before opening.'));
        this.rejectOpening = undefined;
        for (const finish of this.writes) finish(Error('Terminal closed.'));
        this.pending.clear();
        this.pendingBytes = 0;
        this.stream?.destroy();
        this.stream?.resume();
        this.stream?.stderr.resume();
        this.finished();
        this.emit({ id: this.id, type: 'state', state: message ? 'error' : 'closed', message });
        this.settleCleanup();
    }
    private settleCleanup() {
        if (
            this.cleanupClosed ||
            !this.ended ||
            this.openingPending ||
            (this.stream && !this.channelClosed) ||
            this.underlyingWrites.size
        )
            return;
        this.stream?.off('data', this.outputData);
        this.stream?.stderr.off('data', this.outputData);
        this.stream?.off('error', this.streamError);
        this.stream?.stderr.off('error', this.streamError);
        this.stream?.off('close', this.streamClose);
        this.stream = undefined;
        this.cleanupClosed = true;
        this.cleanupResolve();
    }
    join() {
        return this.cleanupDone;
    }
    get ownershipSnapshot() {
        const stream = this.stream;
        const listeners = stream
            ? stream.listeners('data').filter((value) => value === this.outputData).length +
              stream.stderr.listeners('data').filter((value) => value === this.outputData).length +
              stream.listeners('error').filter((value) => value === this.streamError).length +
              stream.stderr.listeners('error').filter((value) => value === this.streamError)
                  .length +
              stream.listeners('close').filter((value) => value === this.streamClose).length
            : 0;
        return {
            opening: this.openingPending ? 1 : 0,
            channel: stream && !this.channelClosed ? 1 : 0,
            writeCallbacks: this.underlyingWrites.size,
            inputBytes: this.inputBytes,
            pendingAcks: this.pending.size,
            pendingAckBytes: this.pendingBytes,
            timers: (this.stalled ? 1 : 0) + (this.openingTimer ? 1 : 0),
            listeners,
            closing: this.ended && !this.cleanupClosed ? 1 : 0,
            cleanupClosed: this.cleanupClosed,
        };
    }
}
