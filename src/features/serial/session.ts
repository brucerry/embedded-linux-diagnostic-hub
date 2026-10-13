import {
    AUTOMATION_LIMITS,
    bytesBase64,
    type CommandCapture,
    type Completion,
} from '../../../shared/automation';
import { VisibleTail } from '../automation/serial-completion';
import {
    SERIAL_CHUNK_BYTES,
    SERIAL_QUEUE_BYTES,
    SERIAL_CLOSE_MS,
    serialSettings,
    type SerialSettings,
    type LocalSerialPort,
} from '../../../shared/serial';

export type SerialState =
    'idle' | 'selecting' | 'selected' | 'opening' | 'connected' | 'closing' | 'error';
export interface SerialStatus {
    state: SerialState;
    label: string;
    message: string;
    generation: number;
}
export class SerialSession {
    private automationOwner?: symbol;
    private capture?: { append(bytes: Uint8Array): void; cancel(): void };
    private lastReceived = 0;
    private framingValue = '';
    get framing() {
        return this.framingValue;
    }
    private selected?: LocalSerialPort;
    private port?: LocalSerialPort;
    private opened?: LocalSerialPort;
    private reader?: ReadableStreamDefaultReader<Uint8Array>;
    private writer?: WritableStreamDefaultWriter<Uint8Array>;
    private opening?: Promise<void>;
    private reading?: Promise<void>;
    private writing?: Promise<void>;
    private closing?: Promise<void>;
    private aborted?: AbortController;
    private queue: Uint8Array[] = [];
    private queuedBytes = 0;
    private inputRevision = 0;
    private listeners = new Set<(value: SerialStatus) => void>();
    private status: SerialStatus = { state: 'idle', label: '', message: '', generation: 0 };
    constructor(
        private consume: (bytes: Uint8Array, generation: number) => Promise<void>,
        private closeTimeout = SERIAL_CLOSE_MS,
    ) {}
    setConsumer(consume: (bytes: Uint8Array, generation: number) => Promise<void>) {
        this.consume = consume;
    }
    get current(): SerialStatus {
        return { ...this.status };
    }
    get inputEpoch() {
        return this.inputRevision;
    }
    disconnected() {
        this.publish(
            'error',
            'The selected local serial port disconnected. Reconnect explicitly after checking it.',
        );
        return this.close();
    }
    get isOwned() {
        return Boolean(this.port || this.closing);
    }
    get selectedPort() {
        return this.selected;
    }
    subscribe(callback: (value: SerialStatus) => void) {
        this.listeners.add(callback);
        callback(this.current);
        return () => {
            this.listeners.delete(callback);
        };
    }
    private publish(state: SerialState, message = this.status.message) {
        this.status = { ...this.status, state, message };
        for (const callback of this.listeners) callback(this.current);
    }
    private next() {
        this.status = { ...this.status, generation: this.status.generation + 1 };
        return this.status.generation;
    }
    async choose(
        request: () => Promise<LocalSerialPort>,
        label: (port: LocalSerialPort) => string,
    ) {
        if (this.port || this.closing || this.status.state === 'selecting')
            throw Error('Disconnect the current port before choosing another.');
        const generation = this.next();
        this.publish('selecting', '');
        try {
            // Invoke immediately: requestPort must retain the user's activation.
            const port = await request();
            if (generation !== this.status.generation) return;
            this.selected = port;
            this.status = { ...this.status, label: label(port) };
            this.publish('selected', '');
        } catch (error) {
            if (generation !== this.status.generation) return;
            const cancelled = error instanceof Error && error.name === 'NotFoundError';
            this.publish(
                this.selected ? 'selected' : 'idle',
                cancelled ? '' : serialFailure(error),
            );
        }
    }
    select(port: LocalSerialPort, label: string) {
        if (this.port || this.closing || this.status.state === 'selecting')
            throw Error('Disconnect the current port before selecting another.');
        this.next();
        this.selected = port;
        this.status = { ...this.status, label };
        this.publish('selected', '');
    }
    cancelSelection() {
        if (this.status.state !== 'selecting') return;
        this.next();
        this.publish(this.selected ? 'selected' : 'idle', '');
    }
    async connect(settings: SerialSettings) {
        const options = serialSettings(settings);
        this.framingValue =
            options.baudRate +
            ' baud · ' +
            options.dataBits +
            '/' +
            options.parity +
            '/' +
            options.stopBits +
            ' · ' +
            options.flowControl;
        if (!this.selected) throw Error('Choose a local port first.');
        if (this.port || this.closing) throw Error('The current port is still open or closing.');
        const port = this.selected;
        const generation = this.next();
        this.port = port;
        this.aborted = new AbortController();
        this.publish('opening', '');
        const opening = port.open({ ...options, bufferSize: SERIAL_CHUNK_BYTES });
        this.opening = opening;
        try {
            await opening;
            this.opened = port;
            if (this.port !== port || generation !== this.status.generation) return;
            if (!port.readable || !port.writable) throw Error('Serial streams are unavailable.');
            this.reader = port.readable.getReader();
            this.writer = port.writable.getWriter();
            this.publish('connected', '');
            this.reading = this.read(generation, this.reader, this.aborted.signal);
        } catch (error) {
            if (generation === this.status.generation) {
                const message = serialFailure(error);
                // open() failure has no owned OS stream; successful open with missing streams does.
                if (this.opened !== port) this.port = undefined;
                await this.close().catch(() => {});
                this.publish('error', message);
                throw Error(message);
            }
        } finally {
            if (this.opening === opening) this.opening = undefined;
        }
    }
    get automationActive() {
        return Boolean(this.automationOwner);
    }
    acquireAutomation() {
        if (
            this.status.state !== 'connected' ||
            this.automationOwner ||
            this.writing ||
            this.queue.length
        )
            throw Error('Serial: connect and wait for pending interactive writes first.');
        const owner = Symbol();
        this.automationOwner = owner;
        this.clearInput();
        return () => {
            if (this.automationOwner === owner) {
                this.capture?.cancel();
                this.automationOwner = undefined;
                this.inputRevision++;
            }
        };
    }
    async runAutomation(
        bytes: Uint8Array,
        prompt: string,
        timeoutMs: number,
        signal: AbortSignal,
    ): Promise<CommandCapture> {
        if (
            !this.automationOwner ||
            this.status.state !== 'connected' ||
            !this.writer ||
            this.capture
        )
            throw Error('Serial automation no longer owns the connected port.');
        if (
            !bytes.length ||
            bytes.length > AUTOMATION_LIMITS.commandBytes + 2 ||
            !Number.isFinite(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 300000
        )
            throw Error('Serial payload or timeout is invalid.');
        if (!prompt.trim() || prompt.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(prompt))
            throw Error('Serial completion prompt is invalid.');
        const generation = this.status.generation,
            started = performance.now();
        while (performance.now() - this.lastReceived < 100) {
            if (signal.aborted) throw Error('Cancelled.');
            if (performance.now() - started > 1000)
                throw Error('Serial input is not quiet. Drain unsolicited output before running.');
            await new Promise((r) => setTimeout(r, 25));
        }
        if (
            signal.aborted ||
            generation !== this.status.generation ||
            !this.automationOwner ||
            !this.writer
        )
            throw Error('Serial connection changed.');
        const writer = this.writer;
        return new Promise((resolve) => {
            let settled = false,
                stdout = '',
                size = 0,
                quiet: ReturnType<typeof setTimeout> | undefined,
                writingDone = false;
            const decoder = new TextDecoder(),
                tail = new VisibleTail(),
                chunks: CommandCapture['chunks'] = [];
            const finish = (completion: Completion) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearTimeout(quiet);
                signal.removeEventListener('abort', cancel);
                if (this.capture === capture) this.capture = undefined;
                stdout += decoder.decode();
                if (!writingDone)
                    void Promise.resolve()
                        .then(() => this.close())
                        .catch(() => {});
                resolve({
                    stdout,
                    stderr: '',
                    exitCode: null,
                    completion,
                    truncated: completion === 'output-limit',
                    chunks,
                });
            };
            const cancel = () => finish('cancelled'),
                timer = setTimeout(() => finish('timeout'), timeoutMs);
            const capture = {
                cancel,
                append: (value: Uint8Array) => {
                    if (settled) return;
                    clearTimeout(quiet);
                    const kept = value.slice(0, Math.max(0, AUTOMATION_LIMITS.outputBytes - size));
                    if (chunks.length >= AUTOMATION_LIMITS.chunks) return finish('output-limit');
                    size += kept.length;
                    if (kept.length) {
                        chunks.push({
                            stream: 'serial',
                            base64: bytesBase64(kept),
                            receivedAt: new Date().toISOString(),
                        });
                        const decoded = decoder.decode(kept, { stream: true });
                        stdout += decoded;
                        tail.append(decoded);
                    }
                    if (kept.length < value.length) return finish('output-limit');
                    if (writingDone && tail.value.endsWith(prompt))
                        quiet = setTimeout(() => finish('prompt-observed'), 200);
                },
            };
            this.capture = capture;
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) return cancel();
            void (async () => {
                try {
                    for (let offset = 0; offset < bytes.length; offset += SERIAL_CHUNK_BYTES) {
                        if (settled || generation !== this.status.generation) return;
                        await writer.write(bytes.slice(offset, offset + SERIAL_CHUNK_BYTES));
                    }
                    writingDone = true;
                    if (!settled && tail.value.endsWith(prompt))
                        quiet = setTimeout(() => finish('prompt-observed'), 200);
                } catch {
                    finish('transport-error');
                }
            })();
        });
    }
    send(bytes: Uint8Array) {
        if (this.automationOwner)
            throw Error('Serial input is owned by Automation. Stop or cancel the flow first.');
        if (this.status.state !== 'connected' || !this.writer)
            throw Error('Serial is not connected.');
        if (this.queuedBytes + bytes.length > SERIAL_QUEUE_BYTES)
            throw Error('Serial input queue is full. Wait before pasting more text.');
        for (let index = 0; index < bytes.length; index += SERIAL_CHUNK_BYTES)
            this.queue.push(bytes.slice(index, index + SERIAL_CHUNK_BYTES));
        this.queuedBytes += bytes.length;
        if (!this.writing) {
            const task = this.flush(this.status.generation);
            this.writing = task;
            void task.finally(() => {
                if (this.writing === task) this.writing = undefined;
            });
        }
    }
    clearInput() {
        this.inputRevision++;
        this.queue = [];
        this.queuedBytes = 0;
    }
    private async flush(generation: number) {
        try {
            while (this.queue.length && generation === this.status.generation && this.writer) {
                const bytes = this.queue.shift()!;
                await this.writer.write(bytes);
                this.queuedBytes = Math.max(0, this.queuedBytes - bytes.length);
            }
        } catch (error) {
            if (generation === this.status.generation) {
                this.publish('error', serialFailure(error));
                void this.close().catch(() => {});
            }
        }
    }
    private async read(
        generation: number,
        reader: ReadableStreamDefaultReader<Uint8Array>,
        signal: AbortSignal,
    ) {
        try {
            while (generation === this.status.generation) {
                const { value, done } = await reader.read();
                if (done) {
                    if (generation === this.status.generation)
                        throw Error('Serial input stream ended.');
                    break;
                }
                if (!value || generation !== this.status.generation) continue;
                this.lastReceived = performance.now();
                this.capture?.append(value);
                if (value.byteLength > SERIAL_QUEUE_BYTES)
                    throw Error('Serial output exceeded its buffer limit.');
                for (
                    let offset = 0;
                    offset < value.length && generation === this.status.generation;
                    offset += SERIAL_CHUNK_BYTES
                ) {
                    await new Promise<void>((resolve, reject) => {
                        const cancel = () => {
                            clearTimeout(timer);
                            resolve();
                        };
                        const timer = setTimeout(() => {
                            signal.removeEventListener('abort', cancel);
                            reject(Error('Serial display stopped consuming output.'));
                        }, 30000);
                        signal.addEventListener('abort', cancel, { once: true });
                        void this.consume(
                            value.slice(offset, offset + SERIAL_CHUNK_BYTES),
                            generation,
                        )
                            .then(resolve, reject)
                            .finally(() => {
                                clearTimeout(timer);
                                signal.removeEventListener('abort', cancel);
                            });
                        if (signal.aborted) cancel();
                    });
                }
            }
        } catch (error) {
            if (generation === this.status.generation) {
                this.publish('error', serialFailure(error));
                void this.close().catch(() => {});
            }
        } finally {
            reader.releaseLock();
        }
    }
    async close(deselect = false): Promise<void> {
        if (!this.closing) {
            this.capture?.cancel();
            this.automationOwner = undefined;
            this.next();
            this.clearInput();
            this.aborted?.abort();
            this.publish('closing');
            const port = this.port;
            const reader = this.reader;
            const writer = this.writer;
            const opening = this.opening;
            const reading = this.reading;
            const writing = this.writing;
            const task = (async () => {
                await Promise.allSettled([
                    reader?.cancel(),
                    writer?.abort(),
                    opening,
                    reading,
                    writing,
                ]);
                writer?.releaseLock();
                this.reader = undefined;
                this.writer = undefined;
                this.reading = undefined;
                this.writing = undefined;
                if (port && this.opened === port) {
                    try {
                        await port.close();
                    } catch (error) {
                        if (!(error instanceof Error && error.name === 'InvalidStateError'))
                            throw error;
                    }
                    if (this.opened === port) this.opened = undefined;
                }
                if (this.port === port) this.port = undefined;
                if (deselect) {
                    this.selected = undefined;
                    this.status = { ...this.status, label: '' };
                }
                this.publish(this.selected ? 'selected' : 'idle');
            })();
            this.closing = task;
            void task.then(
                () => {
                    if (this.closing === task) this.closing = undefined;
                },
                () => {
                    if (this.closing === task) this.closing = undefined;
                },
            );
        }
        const task = this.closing;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                task,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                Error('Serial cleanup is still pending. New opens remain blocked.'),
                            ),
                        this.closeTimeout,
                    );
                }),
            ]);
            if (deselect && this.selected && !this.port) {
                this.selected = undefined;
                this.status = { ...this.status, label: '' };
                this.publish('idle', '');
            }
        } catch (error) {
            this.publish('error', serialFailure(error));
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
    async forget() {
        const port = this.selected;
        await this.close(true);
        if (!port?.forget) throw Error('Manage serial permissions in your browser settings.');
        await port.forget();
    }
}
export function serialFailure(error: unknown): string {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError')
        return 'Serial access was denied by permission or policy.';
    if (name === 'NetworkError')
        return 'Serial could not open or transfer data. Check the port, access and whether another app is using it.';
    return error instanceof Error ? error.message.slice(0, 512) : 'Serial operation failed.';
}
