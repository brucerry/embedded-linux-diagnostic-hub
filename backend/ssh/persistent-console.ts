import type { Client, ClientChannel } from 'ssh2';
import { CAPTURE_STORAGE, CaptureStorageError, storageError } from '../../shared/capture-store';
import {
    consoleSegment,
    type ConsoleHeader,
    type ConsoleSegment,
    type ConsoleMatch,
    type ConsoleRepository,
    type ConsoleSnapshot,
    type GatewayConsoleDisposal,
} from '../../shared/console-journal';
import { consoleReady, type ConsoleCompletion } from '../../shared/ssh-console';
import { base64Bytes } from '../../shared/capture-store';
// Reuse the existing bounded UTF-8/ANSI parser; it has no UI/runtime side effects.
import { Utf8Boundary, VisibleTail } from '../../src/features/automation/serial-completion';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let settled = false;
    const promise = new Promise<T>(
        (r) =>
            (resolve = (value) => {
                settled = true;
                r(value);
            }),
    );
    return {
        promise,
        resolve,
        get settled() {
            return settled;
        },
    };
}
type StopReason = 'complete' | 'cancelled' | 'timeout' | 'transport-error';
type Waiter = {
    criterion: ConsoleCompletion;
    decoder: TextDecoder;
    utf8: Utf8Boundary;
    tail: VisibleTail;
    firstObservation: number;
    lastReceivedMono: number;
    deadline: number;
    resolve: (match: ConsoleMatch) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
};
export interface ConsoleBinding {
    /** The authenticated session supplies exclusive ownership and its immutable generation check. */
    acquire(): () => void;
    assertCurrent(): void;
    /** Carry the arm's original freshness check through every asynchronous preparation boundary. */
    assertFresh(): void;
    open(callback: (error: Error | undefined, channel?: ClientChannel) => void): void;
}
/** Normal interactive shell initialization only; no profile commands, alias rewriting or env injection. */
export function interactiveShellBinding(
    client: Client,
    acquire: ConsoleBinding['acquire'],
    assertCurrent: ConsoleBinding['assertCurrent'],
    assertFresh: ConsoleBinding['assertFresh'],
): ConsoleBinding {
    return {
        acquire,
        assertCurrent,
        assertFresh,
        open: (callback) =>
            client.shell({ term: 'xterm-256color', rows: 40, cols: 120 }, (error, channel) =>
                callback(error ?? undefined, channel),
            ),
    };
}

/** One ordered journal actor and one shell for a flow; no automatic input or inferred exit status. */
export class PersistentSshConsole {
    private channel?: ClientChannel;
    private opened = deferred<void>();
    private closed = deferred<void>();
    private outputEnded = deferred<void>();
    private extendedEnded = deferred<void>();
    private openStarted = false;
    private channelClosed = false;
    private release?: () => void;
    private queue: Promise<void> = Promise.resolve();
    private pendingBytes = 0;
    private observedBytes = 0;
    private observation = 0;
    private receivedDecoder = new TextDecoder('utf-8');
    private receivedUtf8 = new Utf8Boundary();
    private receivedTail = new VisibleTail();
    private segment?: ConsoleSegment;
    private prepared?: Extract<ConsoleSegment, { kind: 'command' }>;
    private waiter?: Waiter;
    private stepTask?: Promise<ConsoleCommandResult>;
    private writeTask?: Promise<void>;
    private writePending = false;
    private pendingOperations = 0;
    private closingActive = false;
    private abortListenerOwned = false;
    private stopReason?: StopReason;
    private failure?: CaptureStorageError;
    private closing?: Promise<ConsoleSnapshot | null>;
    private boundary = true;
    private ready = false;
    private started = false;
    private signal?: AbortSignal;
    private cancelListener = () => {
        this.abortListenerOwned = false;
        void this.cancel().catch(() => {});
    };
    constructor(
        private binding: ConsoleBinding,
        private store: ConsoleRepository,
        private quietMs = 100,
        private remoteDisposal?: () => GatewayConsoleDisposal | null,
    ) {
        if (!Number.isInteger(quietMs) || quietMs < 50 || quietMs > 1000)
            throw Error('Console quiet interval must be 50–1000 ms.');
    }
    get snapshot() {
        return this.store.snapshot;
    }
    get owned() {
        return Boolean(this.release);
    }
    private at() {
        return new Date().toISOString();
    }
    private check(signal?: AbortSignal) {
        if (this.stopReason || this.failure || this.signal?.aborted || signal?.aborted)
            throw Error('Console stopped; arm explicitly to resume.');
        this.binding.assertCurrent();
        this.binding.assertFresh();
    }
    private pause() {
        this.channel?.pause();
        this.channel?.stderr.pause();
    }
    private resume() {
        if ((!this.boundary || this.stopReason) && !this.pendingBytes) {
            this.channel?.resume();
            this.channel?.stderr.resume();
        }
    }
    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        this.pendingOperations++;
        const task = this.queue.then(work);
        this.queue = task.then(
            () => {},
            (error) => {
                if (error instanceof CaptureStorageError) this.failure ??= error;
                this.stop('transport-error');
            },
        );
        void task
            .finally(() => {
                this.pendingOperations--;
            })
            .catch(() => {});
        return task;
    }
    private async drained() {
        while (true) {
            const queued = this.queue;
            await queued;
            if (this.queue === queued) return;
        }
    }
    private buffered() {
        return (this.channel?.readableLength ?? 0) + (this.channel?.stderr.readableLength ?? 0);
    }
    private drainBuffered() {
        const channel = this.channel;
        if (!channel) return;
        // Consume already-buffered bytes before establishing the fresh post-write criterion.
        // read() emits data itself, so temporarily detach our listeners to account exactly once.
        channel.off('data', this.output);
        channel.stderr.off('data', this.extended);
        try {
            for (const [stream, origin] of [
                [channel, 'channel'],
                [channel.stderr, 'extended'],
            ] as const) {
                while (stream.readableLength && !this.failure) {
                    const bytes = stream.read(
                        Math.min(stream.readableLength, CAPTURE_STORAGE.frameBytes),
                    ) as Buffer | null;
                    if (!bytes) break;
                    this.receive(origin, bytes);
                }
            }
        } finally {
            channel.on('data', this.output);
            channel.stderr.on('data', this.extended);
        }
    }
    private receive = (origin: 'channel' | 'extended', input: Buffer) => {
        if (!input.length) return;
        this.observedBytes += input.length;
        const observation = this.observation++,
            receivedAt = this.at(),
            mono = performance.now();
        this.pause();
        if (
            !Number.isSafeInteger(this.observedBytes) ||
            this.pendingBytes + input.length > CAPTURE_STORAGE.backlogBytes
        ) {
            this.failure ??= new CaptureStorageError(
                'backlog',
                'Console receive backlog exhausted; observed bytes exceed retained data.',
            );
            this.stop('transport-error');
            this.channel?.resume();
            this.channel?.stderr.resume();
            return;
        }
        if (this.failure) {
            this.channel?.resume();
            this.channel?.stderr.resume();
            return;
        }
        const bytes = Uint8Array.from(input);
        this.pendingBytes += bytes.length;
        void this.enqueue(async () => {
            if (this.failure) return;
            if (!this.segment) {
                this.segment = { kind: 'context', phase: this.stopReason ? 'shutdown' : 'idle' };
                await this.store.start(this.segment, receivedAt);
            }
            await this.store.observe(bytes, receivedAt, origin);
            this.receivedUtf8.append(bytes);
            this.receivedTail.append(this.receivedDecoder.decode(bytes, { stream: true }));
            const waiter = this.waiter;
            if (waiter && observation >= waiter.firstObservation) {
                waiter.utf8.append(bytes);
                waiter.tail.append(waiter.decoder.decode(bytes, { stream: true }));
                waiter.lastReceivedMono = mono;
            }
        })
            .catch(() => {})
            .finally(() => {
                this.pendingBytes -= bytes.length;
                this.resume();
            });
    };
    private output = (bytes: Buffer) => this.receive('channel', bytes);
    private extended = (bytes: Buffer) => this.receive('extended', bytes);
    private channelError = () => this.stop('transport-error');
    private outputEnd = () => this.outputEnded.resolve();
    private extendedEnd = () => this.extendedEnded.resolve();
    private channelClose = () => {
        this.channelClosed = true;
        this.closed.resolve();
        if (!this.stopReason) this.stop('transport-error');
    };
    private rejectWaiter(error: Error) {
        const waiter = this.waiter;
        if (!waiter) return;
        this.waiter = undefined;
        clearTimeout(waiter.timer);
        waiter.reject(error);
    }
    private waiting(criterion: ConsoleCompletion, timeoutMs: number) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000)
            throw Error('Console timeout must be 100–300000 ms.');
        if (this.waiter) throw Error('A console criterion is already pending.');
        const promise = new Promise<ConsoleMatch>((resolve, reject) => {
            const waiter: Waiter = {
                criterion,
                decoder: new TextDecoder('utf-8'),
                utf8: new Utf8Boundary(),
                tail: new VisibleTail(),
                firstObservation: this.observation,
                lastReceivedMono: Infinity,
                deadline: performance.now() + timeoutMs,
                resolve,
                reject,
            };
            this.waiter = waiter;
            const tick = () => {
                if (this.waiter !== waiter) return;
                try {
                    this.check();
                } catch (error) {
                    this.stop('transport-error');
                    return;
                }
                const now = performance.now();
                if (now >= waiter.deadline) {
                    this.stop('timeout');
                    return;
                }
                const literal = waiter.criterion.literals.find((s) =>
                    waiter.tail.value.endsWith(s),
                );
                if (
                    literal &&
                    waiter.utf8.complete &&
                    waiter.tail.complete &&
                    !this.pendingBytes &&
                    now - waiter.lastReceivedMono >= this.quietMs
                ) {
                    this.boundary = true;
                    this.pause();
                    this.waiter = undefined;
                    resolve({ role: criterion.role, literal });
                    return;
                }
                waiter.timer = setTimeout(tick, 10);
            };
            waiter.timer = setTimeout(tick, 10);
        });
        void promise.catch(() => {});
        return promise;
    }
    async open(
        header: Omit<ConsoleHeader, 'schema' | 'id'>,
        signal: AbortSignal,
        timeoutMs: number,
    ) {
        if (this.started) throw Error('This flow console has already opened.');
        const criterion = consoleReady(header.ready);
        this.started = true;
        this.signal = signal;
        try {
            this.check();
            this.release = this.binding.acquire();
            signal.addEventListener('abort', this.cancelListener, { once: true });
            this.abortListenerOwned = true;
            await this.enqueue(async () => {
                await this.store.begin({ ...header, ready: criterion });
                this.check();
                this.segment = { kind: 'context', phase: 'startup' };
                await this.store.start(this.segment, this.at());
            });
            this.check();
            const match = this.waiting(criterion, timeoutMs);
            this.openStarted = true;
            try {
                this.binding.open((error, channel) => {
                    if (error || !channel) {
                        this.channelClosed = true;
                        this.closed.resolve();
                        this.outputEnded.resolve();
                        this.extendedEnded.resolve();
                        this.opened.resolve();
                        this.stop('transport-error');
                        return;
                    }
                    this.channel = channel;
                    channel.on('data', this.output);
                    channel.stderr.on('data', this.extended);
                    channel.on('error', this.channelError);
                    channel.stderr.on('error', this.channelError);
                    channel.once('close', this.channelClose);
                    channel.once('end', this.outputEnd);
                    channel.stderr.once('end', this.extendedEnd);
                    if (channel.readableEnded) this.outputEnd();
                    if (channel.stderr.readableEnded) this.extendedEnd();
                    this.opened.resolve();
                    if (this.stopReason) {
                        channel.close();
                        channel.resume();
                        channel.stderr.resume();
                    } else {
                        this.boundary = false;
                        this.resume();
                    }
                });
            } catch (error) {
                this.channelClosed = true;
                this.closed.resolve();
                this.outputEnded.resolve();
                this.extendedEnded.resolve();
                this.opened.resolve();
                throw error;
            }
            const matched = await match;
            await this.enqueue(async () => {
                this.check();
                await this.store.end('ready', matched, this.at());
                this.segment = undefined;
            });
            this.check();
            this.ready = true;
            this.boundary = false;
            this.resume();
            return this.store.snapshot!;
        } catch (error) {
            this.stop(signal.aborted ? 'cancelled' : 'transport-error');
            await this.close();
            throw error;
        }
    }
    step(
        segment: Extract<ConsoleSegment, { kind: 'command' }>,
        timeoutMs: number,
        signal?: AbortSignal,
    ) {
        if (!this.ready || this.stepTask || this.stopReason)
            return Promise.reject(Error('Console is unavailable or a step is active.'));
        const frozen = consoleSegment(segment) as Extract<ConsoleSegment, { kind: 'command' }>;
        const task = this.runStep(frozen, timeoutMs, signal);
        this.stepTask = task;
        void task
            .finally(() => {
                if (this.stepTask === task) this.stepTask = undefined;
            })
            .catch(() => {});
        return task;
    }
    private async runStep(
        segment: Extract<ConsoleSegment, { kind: 'command' }>,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<ConsoleCommandResult> {
        const abort = () => this.stop('cancelled');
        signal?.addEventListener('abort', abort, { once: true });
        this.boundary = true;
        this.pause();
        try {
            this.check(signal);
            const preparationDeadline = performance.now() + timeoutMs;
            this.drainBuffered();
            await this.enqueue(async () => {
                this.check(signal);
                if (this.segment) {
                    await this.store.end('idle-boundary', null, this.at());
                    this.segment = undefined;
                }
                this.check(signal);
                this.segment = { kind: 'context', phase: 'idle' };
                await this.store.start(this.segment, this.at());
                this.check(signal);
                await this.store.start(segment, this.at());
                this.prepared = segment;
            });
            do {
                this.drainBuffered();
                await this.drained();
                this.check(signal);
                if (performance.now() >= preparationDeadline)
                    throw Error(
                        'Console output did not quiesce before input preparation timed out.',
                    );
            } while (this.buffered());
            if (!this.receivedUtf8.complete || !this.receivedTail.complete)
                throw Error(
                    'Console has unfinished UTF-8 or escape output; later input is disarmed.',
                );
            const matched = this.waiting(segment.criterion, timeoutMs);
            const bytes = base64Bytes(segment.requestBase64);
            let dispatched = false;
            const sentAt = this.at();
            this.check(signal); // No await between the original freshness check and the write.
            const sent = this.enqueue(async () => {
                if (!dispatched) return;
                await this.store.inputSent(sentAt);
                this.segment = segment;
                this.prepared = undefined;
            });
            this.writePending = true;
            this.writeTask = new Promise<void>((resolve, reject) => {
                this.channel!.write(bytes, (error?: Error | null) =>
                    error ? reject(error) : resolve(),
                );
                dispatched = true;
            });
            void this.writeTask
                .finally(() => {
                    this.writePending = false;
                })
                .catch(() => {});
            this.boundary = false;
            this.resume();
            await this.writeTask;
            await sent;
            const match = await matched;
            await this.enqueue(async () => {
                this.check(signal);
                await this.store.end('prompt-observed', match, this.at());
                this.segment = undefined;
                await this.store.outcome('prompt-observed', match, this.at());
            });
            this.check(signal);
            this.boundary = false;
            this.resume();
            return {
                completion: 'prompt-observed',
                exitCode: null,
                match,
                requestBase64: segment.requestBase64,
            };
        } catch (error) {
            this.stop(signal?.aborted ? 'cancelled' : 'transport-error');
            await this.close();
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
        }
    }
    private stop(reason: StopReason) {
        if (this.stopReason) return;
        this.stopReason = reason;
        this.ready = false;
        this.boundary = true;
        this.pause();
        this.rejectWaiter(Error('Console ended with ' + reason + '; later input is disarmed.'));
        // Insert this boundary before any close-generated output, after accepted observations.
        void this.enqueue(async () => {
            if (this.failure || !this.store.snapshot) return;
            if (this.prepared) {
                await this.store.discardPreparation(
                    reason === 'complete' ? 'cancelled' : reason,
                    this.at(),
                );
                this.prepared = undefined;
            }
            if (this.segment) {
                const completion = reason === 'complete' ? 'closed' : reason;
                await this.store.end(completion, null, this.at());
                if (this.segment.kind === 'command')
                    await this.store.outcome(
                        completion as 'cancelled' | 'timeout' | 'transport-error',
                        null,
                        this.at(),
                    );
                this.segment = undefined;
            }
            this.segment = { kind: 'context', phase: 'shutdown' };
            await this.store.start(this.segment, this.at());
        }).catch(() => {});
        if (!this.openStarted) {
            this.opened.resolve();
            this.closed.resolve();
            this.outputEnded.resolve();
            this.extendedEnded.resolve();
            this.channelClosed = true;
        }
        this.channel?.close();
        this.channel?.resume();
        this.channel?.stderr.resume();
        void this.close().catch(() => {});
    }
    cancel() {
        this.stop('cancelled');
        return this.close();
    }
    finish() {
        if (this.stepTask)
            return Promise.reject(
                Error('Await the active step and its persisted outcome before finishing.'),
            );
        this.stop('complete');
        return this.close();
    }
    close(): Promise<ConsoleSnapshot | null> {
        if (this.closing) return this.closing;
        if (!this.stopReason) this.stop('cancelled');
        if (this.closing) return this.closing;
        this.closingActive = true;
        const task = (async () => {
            await this.opened.promise;
            await this.closed.promise;
            // close can precede buffered extended-data delivery; both readable drains are owned.
            await this.outputEnded.promise;
            await this.extendedEnded.promise;
            await this.writeTask?.catch(() => {});
            await this.drained();
            let metadataError: unknown;
            if (this.failure) {
                try {
                    await this.store.fail(this.observedBytes, this.failure, true);
                } catch (error) {
                    metadataError = error;
                }
            } else if (this.store.snapshot) {
                try {
                    if (this.segment) {
                        await this.store.end('closed', null, this.at());
                        this.segment = undefined;
                    }
                    await this.store.finish(this.stopReason!, this.observedBytes, true);
                } catch (error) {
                    this.failure ??= storageError(error);
                    try {
                        await this.store.fail(this.observedBytes, this.failure, true);
                    } catch (failure) {
                        metadataError = failure;
                    }
                }
            }
            await this.store.close();
            const proof = this.remoteDisposal?.();
            const remoteUnacknowledged =
                !this.store.resourceClosed &&
                proof?.scope === 'gateway-operation-adapter' &&
                proof.disposed === true &&
                proof.journalClosure === 'unacknowledged';
            if (!this.store.resourceClosed && !remoteUnacknowledged)
                throw Error('Console storage cleanup is still pending.');
            this.channel?.off('data', this.output);
            this.channel?.stderr.off('data', this.extended);
            this.channel?.off('error', this.channelError);
            this.channel?.stderr.off('error', this.channelError);
            this.channel?.off('close', this.channelClose);
            this.channel?.off('end', this.outputEnd);
            this.channel?.stderr.off('end', this.extendedEnd);
            this.signal?.removeEventListener('abort', this.cancelListener);
            this.abortListenerOwned = false;
            this.release?.();
            this.release = undefined;
            if (metadataError) throw metadataError;
            if (remoteUnacknowledged)
                throw new CaptureStorageError(
                    'io',
                    'Gateway console closed locally; remote journal closure is unacknowledged. Retained evidence may be incomplete; arm explicitly to resume.',
                );
            return this.store.snapshot;
        })();
        this.closing = task;
        void task
            .finally(() => {
                this.closingActive = false;
            })
            .catch(() => {});
        void task.catch(() => {
            if (this.closing === task) this.closing = undefined;
        });
        return task;
    }
    get ownershipSnapshot() {
        const channel = this.channel;
        const listeners = channel
            ? channel.listeners('data').filter((value) => value === this.output).length +
              channel.stderr.listeners('data').filter((value) => value === this.extended).length +
              channel.listeners('error').filter((value) => value === this.channelError).length +
              channel.stderr.listeners('error').filter((value) => value === this.channelError)
                  .length +
              channel.listeners('close').filter((value) => value === this.channelClose).length +
              channel.listeners('end').filter((value) => value === this.outputEnd).length +
              channel.stderr.listeners('end').filter((value) => value === this.extendedEnd).length
            : 0;
        return {
            lease: this.owned ? 1 : 0,
            opening: this.openStarted && !this.opened.settled ? 1 : 0,
            channel: channel && !this.channelClosed ? 1 : 0,
            outputDrain: this.openStarted && !this.outputEnded.settled ? 1 : 0,
            extendedDrain: this.openStarted && !this.extendedEnded.settled ? 1 : 0,
            operations: this.pendingOperations,
            pendingBytes: this.pendingBytes,
            write: this.writePending ? 1 : 0,
            criterion: this.waiter ? 1 : 0,
            timers: this.waiter?.timer ? 1 : 0,
            abortListeners: this.abortListenerOwned ? 1 : 0,
            listeners,
            closing: this.closingActive ? 1 : 0,
        };
    }
}
export interface ConsoleCommandResult {
    completion: 'prompt-observed';
    exitCode: null;
    match: ConsoleMatch;
    requestBase64: string;
}
