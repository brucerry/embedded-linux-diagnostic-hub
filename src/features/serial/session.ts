import {
    AUTOMATION_LIMITS,
    type CommandCapture,
    type Completion,
} from '../../../shared/automation';
import { VisibleTail, Utf8Boundary } from '../automation/serial-completion';
import { SerialCaptureBlocks } from '../automation/serial-capture';
import {
    CommandPreview,
    type CommandOutputSink,
    type StreamedCommandCapture,
} from '../../../shared/automation-stream';
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
interface AutomationWrite {
    task: Promise<void>;
    settled: boolean;
    failed: boolean;
    error?: unknown;
    retainedReason?: string;
}
interface AutomationOwner {
    port: LocalSerialPort;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    generation: number;
    write?: AutomationWrite;
    retirement: Promise<void>;
    acknowledge(): void;
    finishing: boolean;
    retired: boolean;
    releaseRequested: boolean;
    closeRequested: boolean;
    closed: boolean;
    closing?: Promise<void>;
    closeFailed: boolean;
    closeError?: unknown;
}
export interface SerialAutomationRelease {
    (): void;
    finish(): Promise<void>;
    failure(): string | undefined;
}
export class SerialSession {
    private automationOwner?: AutomationOwner;
    private capture?: {
        append(bytes: Uint8Array, receivedAt: string): void | Promise<void>;
        cancel(): void;
        interrupt(error: Error): boolean;
        delivered?(): void;
    };
    private lastReceived = 0;
    private receiveBusy = false;
    private automationInput?: (bytes: Uint8Array, generation: number) => void;
    setAutomationInputConsumer(consume?: (bytes: Uint8Array, generation: number) => void) {
        this.automationInput = consume;
    }
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
    private closing?: {
        task: Promise<void>;
        intent: { deselect: boolean; selected?: LocalSerialPort; generation: number };
    };
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
        if (!this.selected) throw Error('Choose a local port first.');
        if (this.port || this.closing) throw Error('The current port is still open or closing.');
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
    get automationQuarantined() {
        const owner = this.automationOwner;
        return Boolean(owner?.write?.retainedReason && owner.port === this.port && !this.closing);
    }
    private retainedWriteMessage(owner: AutomationOwner) {
        const write = owner.write;
        return (
            (write?.retainedReason ?? 'Serial command interrupted') +
            (write?.failed ? ': write failed: ' + serialFailure(write.error) + '.' : '.') +
            (owner.closed
                ? ' Requested port cleanup acknowledged.'
                : owner.retired
                  ? ' Input retirement acknowledged; command did not complete.'
                  : ' Port retained; input blocked until write retirement or explicit Disconnect is acknowledged.')
        );
    }
    private releaseAutomationOwner(owner: AutomationOwner) {
        if (this.automationOwner !== owner || (owner.closeRequested && !owner.closed)) return;
        this.automationOwner = undefined;
        this.inputRevision++;
        if (
            owner.write?.retainedReason &&
            !owner.write.failed &&
            !owner.closeRequested &&
            owner.port === this.port &&
            owner.writer === this.writer &&
            owner.generation === this.status.generation &&
            !this.closing
        )
            this.publish(
                'connected',
                this.retainedWriteMessage(owner) + ' Arm explicitly to resume.',
            );
        else this.publish(this.status.state);
    }
    private acknowledgeAutomation(owner: AutomationOwner) {
        if (!owner.finishing) return;
        if (owner.retired) {
            if (owner.releaseRequested) this.releaseAutomationOwner(owner);
            return;
        }
        if (
            !owner.closed &&
            (owner.closeRequested || (owner.write && (!owner.write.settled || owner.write.failed)))
        )
            return;
        owner.retired = true;
        owner.acknowledge();
        if (owner.releaseRequested) this.releaseAutomationOwner(owner);
    }
    private async finishAutomation(owner: AutomationOwner) {
        owner.finishing = true;
        this.acknowledgeAutomation(owner);
        const failure = () =>
            owner.closeFailed ? owner.closeError : Error(this.retainedWriteMessage(owner));
        if (owner.closeFailed || (owner.write?.failed && !owner.closeRequested)) throw failure();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                (async () => {
                    await owner.retirement;
                    if (owner.closeRequested && !owner.closed) await owner.closing;
                })(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(failure()), this.closeTimeout);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
    acquireAutomation(): SerialAutomationRelease {
        if (
            this.status.state !== 'connected' ||
            this.automationOwner ||
            !this.port ||
            !this.writer ||
            this.writing ||
            this.queue.length ||
            this.receiveBusy
        )
            throw Error('Serial: connect and wait for pending interactive writes first.');
        let acknowledge!: () => void;
        const owner: AutomationOwner = {
            port: this.port,
            writer: this.writer,
            generation: this.status.generation,
            retirement: new Promise<void>((resolve) => {
                acknowledge = resolve;
            }),
            acknowledge: () => acknowledge(),
            finishing: false,
            retired: false,
            releaseRequested: false,
            closeRequested: false,
            closed: false,
            closeFailed: false,
        };
        this.automationOwner = owner;
        this.clearInput();
        this.publish(this.status.state);
        const release = () => {
            if (this.automationOwner === owner) {
                this.capture?.cancel();
                owner.releaseRequested = true;
                owner.finishing = true;
                this.acknowledgeAutomation(owner);
                if (owner.retired) this.releaseAutomationOwner(owner);
            }
        };
        return Object.assign(release, {
            finish: () => this.finishAutomation(owner),
            failure: () =>
                owner.write?.retainedReason ? this.retainedWriteMessage(owner) : undefined,
        });
    }
    async runAutomation(
        bytes: Uint8Array,
        prompt: string,
        timeoutMs: number,
        signal: AbortSignal,
        output: CommandOutputSink,
    ): Promise<StreamedCommandCapture>;
    async runAutomation(
        bytes: Uint8Array,
        prompt: string,
        timeoutMs: number,
        signal: AbortSignal,
    ): Promise<CommandCapture>;
    async runAutomation(
        bytes: Uint8Array,
        prompt: string,
        timeoutMs: number,
        signal: AbortSignal,
        output?: CommandOutputSink,
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
        const owner = this.automationOwner,
            generation = this.status.generation,
            started = performance.now();
        while (this.receiveBusy || performance.now() - this.lastReceived < 100) {
            if (signal.aborted) throw Error('Cancelled.');
            if (performance.now() - started > 1000)
                throw Error('Serial input is not quiet. Drain unsolicited output before running.');
            await new Promise((r) => setTimeout(r, 25));
        }
        if (
            signal.aborted ||
            generation !== this.status.generation ||
            this.automationOwner !== owner ||
            !this.writer
        )
            throw Error('Serial connection changed.');
        const writer = this.writer;
        if (output)
            return this.captureStreamingAutomation(
                writer,
                bytes,
                prompt,
                timeoutMs,
                signal,
                generation,
                output,
                owner,
            );
        return new Promise((resolve) => {
            let settled = false,
                stdout = '',
                size = 0,
                quiet: ReturnType<typeof setTimeout> | undefined,
                writingDone = false;
            const decoder = new TextDecoder(),
                tail = new VisibleTail(),
                boundary = new Utf8Boundary(),
                blocks = new SerialCaptureBlocks();
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
                    chunks: blocks.finish(),
                });
            };
            const cancel = () => finish('cancelled'),
                timer = setTimeout(() => finish('timeout'), timeoutMs);
            const capture = {
                cancel,
                interrupt: () => {
                    const pendingWrite = !writingDone;
                    cancel();
                    return pendingWrite;
                },
                append: (value: Uint8Array) => {
                    if (settled) return;
                    clearTimeout(quiet);
                    const kept = value.slice(0, Math.max(0, AUTOMATION_LIMITS.outputBytes - size));
                    size += kept.length;
                    if (kept.length) {
                        blocks.append(kept, new Date().toISOString());
                        const decoded = decoder.decode(kept, { stream: true });
                        boundary.append(kept);
                        stdout += decoded;
                        tail.append(decoded);
                    }
                    if (kept.length < value.length) return finish('output-limit');
                    if (
                        writingDone &&
                        boundary.complete &&
                        tail.complete &&
                        tail.value.endsWith(prompt)
                    )
                        quiet = setTimeout(() => finish('prompt-observed'), 200);
                },
            };
            this.capture = capture;
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) return cancel();
            void (async () => {
                try {
                    this.automationInput?.(bytes.slice(), generation);
                    for (let offset = 0; offset < bytes.length; offset += SERIAL_CHUNK_BYTES) {
                        if (settled || generation !== this.status.generation) return;
                        await writer.write(bytes.slice(offset, offset + SERIAL_CHUNK_BYTES));
                    }
                    writingDone = true;
                    if (
                        !settled &&
                        boundary.complete &&
                        tail.complete &&
                        tail.value.endsWith(prompt)
                    )
                        quiet = setTimeout(() => finish('prompt-observed'), 200);
                } catch {
                    finish('transport-error');
                }
            })();
        });
    }
    private captureStreamingAutomation(
        writer: WritableStreamDefaultWriter<Uint8Array>,
        bytes: Uint8Array,
        prompt: string,
        timeoutMs: number,
        signal: AbortSignal,
        generation: number,
        output: CommandOutputSink,
        owner: AutomationOwner,
    ): Promise<StreamedCommandCapture> {
        return new Promise((resolve) => {
            let stopping = false,
                writingDone = false,
                receiving = false,
                appending: Promise<void> | undefined,
                quiet: ReturnType<typeof setTimeout> | undefined;
            const decoder = new TextDecoder(),
                tail = new VisibleTail(),
                boundary = new Utf8Boundary(),
                preview = new CommandPreview();
            let acknowledgeWrite!: () => void;
            const write: AutomationWrite = {
                task: new Promise<void>((resolve) => {
                    acknowledgeWrite = resolve;
                }),
                settled: false,
                failed: false,
            };
            // Install custody before callbacks, abort handlers or writer.write can run.
            owner.write = write;
            const finish = (completion: Completion) => {
                if (stopping) return;
                stopping = true;
                clearTimeout(timer);
                clearTimeout(quiet);
                signal.removeEventListener('abort', cancel);
                if (!writingDone && !write.retainedReason) {
                    owner.closeRequested = true;
                    void Promise.resolve()
                        .then(() => this.close())
                        .catch(() => {});
                }
                // Keep this capture and its flow owner until the accepted observation has
                // settled. Cancellation cannot turn a pending write into a success.
                void Promise.resolve().then(async () => {
                    await appending;
                    if (this.capture === capture) this.capture = undefined;
                    resolve({
                        ...preview.finish(),
                        exitCode: null,
                        completion,
                        truncated: false,
                        chunks: [],
                        previewClipped: preview.clipped,
                    });
                });
            };
            const ready = () => {
                clearTimeout(quiet);
                if (
                    !stopping &&
                    !receiving &&
                    writingDone &&
                    boundary.complete &&
                    tail.complete &&
                    tail.value.endsWith(prompt)
                )
                    quiet = setTimeout(() => {
                        if (!receiving && generation === this.status.generation)
                            finish('prompt-observed');
                    }, 200);
            };
            const cancel = () => finish('cancelled'),
                timer = setTimeout(() => finish('timeout'), timeoutMs);
            const capture = {
                cancel,
                delivered: () => {
                    receiving = false;
                    ready();
                },
                interrupt: (error: Error) => {
                    if (!writingDone) write.retainedReason ??= 'UART ' + error.name;
                    finish('transport-error');
                    return false;
                },
                append: (value: Uint8Array, receivedAt: string) => {
                    if (stopping) return;
                    receiving = true;
                    clearTimeout(quiet);
                    const pending = (async () => {
                        try {
                            await output.append(value, receivedAt, 'serial');
                            preview.append(value, 'serial');
                            boundary.append(value);
                            tail.append(decoder.decode(value, { stream: true }));
                        } catch {
                            finish('transport-error');
                        }
                    })();
                    appending = pending;
                    return pending;
                },
            };
            this.capture = capture;
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
            void (async () => {
                try {
                    if (stopping) return;
                    this.automationInput?.(bytes.slice(), generation);
                    for (let offset = 0; offset < bytes.length; offset += SERIAL_CHUNK_BYTES) {
                        if (stopping || generation !== this.status.generation) return;
                        await writer.write(bytes.slice(offset, offset + SERIAL_CHUNK_BYTES));
                    }
                    writingDone = true;
                    ready();
                } catch (error) {
                    write.failed = true;
                    write.error = error;
                    finish('transport-error');
                    if (
                        write.retainedReason &&
                        this.automationOwner === owner &&
                        owner.port === this.port &&
                        owner.generation === this.status.generation &&
                        !this.closing
                    )
                        this.publish('error', this.retainedWriteMessage(owner));
                } finally {
                    write.settled = true;
                    acknowledgeWrite();
                    this.acknowledgeAutomation(owner);
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
        let stream = this.port?.readable;
        try {
            while (generation === this.status.generation && !signal.aborted) {
                let result: ReadableStreamReadResult<Uint8Array>;
                try {
                    result = await reader.read();
                } catch (error) {
                    const replacement = this.port?.readable;
                    const recoverable =
                        error instanceof Error &&
                        [
                            'BreakError',
                            'FramingError',
                            'ParityError',
                            'BufferOverrunError',
                            'UnknownError',
                        ].includes(error.name);
                    if (
                        !recoverable ||
                        signal.aborted ||
                        generation !== this.status.generation ||
                        !replacement ||
                        replacement === stream
                    )
                        throw error;
                    if (this.capture?.interrupt(error)) {
                        this.publish(
                            'error',
                            'UART ' +
                                error.name +
                                ': a write was still pending. Closing this port; reconnect explicitly.',
                        );
                        return;
                    }
                    // Web Serial replaces a recoverable errored stream. Never reopen the port.
                    reader.releaseLock();
                    reader = replacement.getReader();
                    this.reader = reader;
                    stream = replacement;
                    this.clearInput();
                    const owner = this.automationOwner;
                    if (owner?.write?.retainedReason)
                        this.publish('error', this.retainedWriteMessage(owner));
                    else this.publish('connected', 'UART ' + error.name + ': reception continues.');
                    // Bound repeated driver errors without a tight recovery loop.
                    await new Promise((resolve) => setTimeout(resolve, 25));
                    continue;
                }
                const { value, done } = result;
                if (done) {
                    if (generation === this.status.generation)
                        throw Error('Serial input stream ended.');
                    break;
                }
                if (!value || generation !== this.status.generation) continue;
                this.lastReceived = performance.now();
                this.receiveBusy = true;
                // A delivery acknowledgement belongs to the capture present at this read.
                // Never notify a replacement capture after cancellation or generation changes.
                const receivingCapture = this.capture;
                await receivingCapture?.append(value, new Date().toISOString());
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
                this.receiveBusy = false;
                receivingCapture?.delivered?.();
            }
        } catch (error) {
            if (generation === this.status.generation) {
                this.publish('error', serialFailure(error));
                void this.close().catch(() => {});
            }
        } finally {
            this.receiveBusy = false;
            reader.releaseLock();
        }
    }
    async close(deselect = false): Promise<void> {
        if (!this.closing) {
            const automation = this.automationOwner;
            if (automation) {
                automation.closeRequested = true;
                automation.finishing = true;
                automation.releaseRequested = true;
                automation.closeFailed = false;
            }
            this.capture?.cancel();
            this.next();
            const intent = {
                deselect,
                selected: this.selected,
                generation: this.status.generation,
            };
            this.clearInput();
            this.aborted?.abort();
            this.publish('closing');
            const port = this.port;
            const reader = this.reader;
            const writer = this.writer;
            const opening = this.opening;
            const reading = this.reading;
            const writing = this.writing;
            // Publish the transaction/owner join before cancellation invokes external callbacks.
            const task = Promise.resolve().then(async () => {
                await Promise.allSettled([
                    reader?.cancel(),
                    writer?.abort(),
                    opening,
                    reading,
                    writing,
                    automation?.write?.task,
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
            });
            const transaction = { task, intent };
            this.closing = transaction;
            if (automation) automation.closing = task;
            void task.then(
                () => {
                    if (this.closing === transaction) {
                        if (automation) {
                            automation.closed = true;
                            this.acknowledgeAutomation(automation);
                        }
                        if (
                            intent.deselect &&
                            this.selected === intent.selected &&
                            this.status.generation === intent.generation
                        ) {
                            this.selected = undefined;
                            this.status = { ...this.status, label: '' };
                        }
                        this.closing = undefined;
                        this.publish(this.selected ? 'selected' : 'idle');
                    }
                },
                (error) => {
                    if (this.closing === transaction) this.closing = undefined;
                    if (automation) {
                        automation.closeFailed = true;
                        automation.closeError = error;
                    }
                },
            );
        } else if (deselect) {
            // A waiter's watchdog does not cancel the owned close or its Deselect intent.
            this.closing.intent.deselect = true;
        }
        const task = this.closing.task;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                task,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                Error(
                                    'Timed out waiting for Serial cleanup; completion was not observed before this wait expired.',
                                ),
                            ),
                        this.closeTimeout,
                    );
                }),
            ]);
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
