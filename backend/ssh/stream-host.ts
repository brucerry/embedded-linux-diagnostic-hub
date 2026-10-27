import { randomBytes } from 'node:crypto';
import type { AutomationRequest } from '../../shared/automation';
import type { CommandOutputSink, StreamedCommandCapture } from '../../shared/automation-stream';
import { CAPTURE_STORAGE, CaptureStorageError, frameCrc } from '../../shared/capture-store';
import { streamRequest, type SshStreamData } from '../../shared/ssh-stream-rpc';

function deferred<T>() {
    let resolve!: (v: T) => void, reject!: (e: Error) => void;
    const promise = new Promise<T>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}
type State = {
    request: AutomationRequest;
    capability: string;
    sequence: number;
    source: 'local-client' | 'gateway';
    data?: SshStreamData;
    ack?: ReturnType<typeof deferred<void>>;
    sent: boolean;
    reading: boolean;
    dead: boolean;
    stopped: boolean;
    rejected?: { bytes: number; code: 'backlog' | 'io'; message: string };
    wake?: () => void;
    result?: StreamedCommandCapture;
    resultReady: ReturnType<typeof deferred<void>>;
    finalized: ReturnType<typeof deferred<void>>;
    running: Promise<void>;
    runningDone: boolean;
};
/** One request and one outstanding observation; raw/outcome finalization releases execution ownership. */
export class SshStreamHost {
    private state?: State;
    private retiring = new Set<State>();
    private quiescent = new Set<() => void>();
    private shutdownTask?: Promise<void>;
    private prune(s: State) {
        if (s.runningDone && !s.reading) this.retiring.delete(s);
        if (!this.retiring.size) {
            for (const resolve of this.quiescent) resolve();
            this.quiescent.clear();
        }
    }
    private epoch = randomBytes(16).toString('hex');
    constructor(
        private run: (
            request: AutomationRequest,
            sink: CommandOutputSink,
            complete: (r: StreamedCommandCapture) => void,
            finalized: Promise<void>,
        ) => Promise<void>,
        private cancel: (id: string, connection: string) => void,
    ) {}
    clear() {
        this.epoch = randomBytes(16).toString('hex');
        const s = this.state;
        if (!s) return;
        this.retiring.add(s);
        s.dead = true;
        this.stop(s);
        s.finalized.resolve();
        s.wake?.();
        this.state = undefined;
        this.prune(s);
    }
    shutdown() {
        if (this.shutdownTask) return this.shutdownTask;
        const task = (async () => {
            this.clear();
            while (this.retiring.size) {
                await Promise.all([...this.retiring].map((s) => s.running));
                if (this.retiring.size)
                    await new Promise<void>((resolve) => this.quiescent.add(resolve));
            }
        })();
        this.shutdownTask = task;
        void task
            .finally(() => {
                if (this.shutdownTask === task) this.shutdownTask = undefined;
            })
            .catch(() => {});
        return task;
    }
    get ownershipSnapshot() {
        const states = [
            ...this.retiring,
            ...(this.state && !this.retiring.has(this.state) ? [this.state] : []),
        ];
        return {
            currentStates: this.state ? 1 : 0,
            retiringStates: this.retiring.size,
            producers: states.filter((s) => !s.runningDone).length,
            readers: states.filter((s) => s.reading).length,
            pendingAcks: states.filter((s) => s.ack).length,
            pendingDataBytes: states.reduce((bytes, s) => bytes + (s.data?.totalBytes ?? 0), 0),
            shutdownWaiters: this.quiescent.size,
        };
    }
    private stop(s: State) {
        s.stopped = true;
        if (s.data && !s.sent) this.lost(s, s.data.totalBytes);
        try {
            this.cancel(s.request.id, s.request.connection);
        } catch {}
        s.ack?.reject(new CaptureStorageError('io', 'SSH capture stopped.'));
        s.ack = undefined;
        s.data = undefined;
        s.sent = false;
    }
    private lost(s: State, bytes: number) {
        if (s.rejected) s.rejected.bytes += bytes;
        else
            s.rejected = {
                bytes,
                code: 'io',
                message: 'Received SSH bytes could not be retained after capture stopped.',
            };
    }
    async dispatch(
        input: unknown,
        source: 'local-client' | 'gateway' = 'local-client',
    ): Promise<unknown> {
        const r = streamRequest(input);
        if (this.shutdownTask) throw Error('SSH stream cleanup is still in progress.');
        if (r.action === 'capabilities')
            return {
                protocol: 1,
                independentStream: 1,
                receiveTimeSource: source,
                frameBytes: CAPTURE_STORAGE.frameBytes,
                backlogBytes: CAPTURE_STORAGE.backlogBytes,
                epoch: this.epoch,
            };
        if (r.action === 'start') {
            if (r.epoch !== this.epoch) throw Error('SSH stream generation changed. Arm again.');
            if (this.state) throw Error('Finish or cancel the owned SSH capture first.');
            const s: State = {
                request: r.request,
                capability: randomBytes(32).toString('hex'),
                sequence: 0,
                source,
                sent: false,
                reading: false,
                dead: false,
                stopped: false,
                resultReady: deferred<void>(),
                finalized: deferred<void>(),
                running: Promise.resolve(),
                runningDone: false,
            };
            this.state = s;
            const complete = (result: StreamedCommandCapture) => {
                s.result = result;
                s.resultReady.resolve();
                s.wake?.();
            };
            s.running = this.run(
                r.request,
                {
                    append: async (bytes, receivedAt, stream) => {
                        // Includes observations queued by the producer before cancellation.
                        // Already-sent data stays owned by the client and is not counted twice.
                        if (s.stopped) this.lost(s, bytes.length);
                        if (
                            s.dead ||
                            s.stopped ||
                            s.data ||
                            stream === 'serial' ||
                            !bytes.length ||
                            bytes.length > CAPTURE_STORAGE.backlogBytes
                        )
                            throw new CaptureStorageError(
                                'backlog',
                                'Invalid bounded SSH observation.',
                            );
                        const frames: SshStreamData['frames'] = [];
                        for (
                            let offset = 0;
                            offset < bytes.length;
                            offset += CAPTURE_STORAGE.frameBytes
                        ) {
                            const part = bytes.subarray(
                                offset,
                                offset + CAPTURE_STORAGE.frameBytes,
                            );
                            frames.push({
                                offset,
                                base64: Buffer.from(part).toString('base64'),
                                crc32: frameCrc(part),
                            });
                        }
                        const ack = deferred<void>();
                        s.ack = ack;
                        s.sent = false;
                        s.data = {
                            protocol: 1,
                            type: 'data',
                            id: r.request.id,
                            sequence: s.sequence++,
                            receivedAt,
                            receiveTimeSource: source,
                            stream,
                            totalBytes: bytes.length,
                            frames,
                        };
                        s.wake?.();
                        await ack.promise;
                    },
                    rejectObservation: (bytes, error) => {
                        if (s.rejected) s.rejected.bytes += bytes;
                        else s.rejected = { bytes, code: 'backlog', message: error.message };
                        this.stop(s);
                    },
                },
                complete,
                s.finalized.promise,
            )
                .catch((error: unknown) => {
                    if (!s.result)
                        complete({
                            stdout: '',
                            stderr:
                                error instanceof Error
                                    ? error.message.slice(0, 512)
                                    : 'SSH streaming failed.',
                            exitCode: null,
                            completion: 'transport-error',
                            truncated: false,
                            chunks: [],
                            previewClipped: false,
                        });
                })
                .finally(() => {
                    s.runningDone = true;
                    this.prune(s);
                });
            return { protocol: 1, capability: s.capability };
        }
        const s = this.state;
        if (
            !s ||
            s.dead ||
            s.request.id !== r.id ||
            s.request.connection !== r.connection ||
            s.capability !== r.capability ||
            s.source !== source
        )
            throw Error('SSH capture owner is invalid or stale.');
        if (r.action === 'ack') {
            if (!s.data || !s.sent || s.data.sequence !== r.sequence || !s.ack)
                throw Error('SSH capture acknowledgement is invalid or stale.');
            const ack = s.ack;
            s.ack = undefined;
            s.data = undefined;
            s.sent = false;
            ack.resolve();
            return { ok: true };
        }
        if (r.action === 'cancel') {
            this.stop(s);
            return { ok: true };
        }
        if (r.action === 'finalize') {
            if (!s.result) this.stop(s);
            await s.resultReady.promise;
            s.finalized.resolve();
            await s.running;
            if (this.state === s) {
                this.retiring.add(s);
                this.state = undefined;
                this.prune(s);
            }
            return { ok: true };
        }
        if (s.reading || s.sent)
            throw Error('Only one SSH observation may await durable acknowledgement.');
        s.reading = true;
        try {
            if (!s.data && !s.result)
                await new Promise<void>((resolve) => {
                    s.wake = resolve;
                });
            if (s.dead) throw Error('SSH capture connection changed.');
            if (s.data) {
                s.sent = true;
                return s.data;
            }
            if (!s.result) throw Error('SSH stream ended without completion.');
            return {
                protocol: 1,
                type: 'end',
                id: s.request.id,
                capture: s.result,
                ...(s.rejected ? { rejected: s.rejected } : {}),
            };
        } finally {
            s.reading = false;
            s.wake = undefined;
            this.prune(s);
        }
    }
}
