import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    captureHeader,
    integer,
    pageBounds,
    storageError,
    validId,
    validateFrame,
    type CaptureFrame,
    type CaptureRead,
    type CaptureRepository,
} from './capture-store';
import { automationOutcome } from './automation-result';
import type { CaptureReportFormat, CaptureReportScope } from './capture-report';
import { captureScope } from './capture-query';

export type CaptureRpcRequest = { op: string; [key: string]: unknown };
export type CaptureRpcReply =
    { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
export type CaptureRpcTransport = (request: CaptureRpcRequest) => Promise<CaptureRpcReply>;
const operations: Record<string, string[]> = {
    info: [],
    begin: ['header'],
    append: ['id', 'frames'],
    seal: ['id', 'observedBytes', 'reason'],
    fail: ['id', 'observedBytes', 'error'],
    page: ['after', 'limit', 'through'],
    result: ['id'],
    record: ['id', 'outcome'],
    delete: ['id'],
    pin: [],
    unpin: ['handle'],
    read: ['id'],
    pull: ['handle'],
    return: ['handle'],
    close: [],
    export: ['format', 'scope'],
};
export function captureRpcRequest(input: unknown): CaptureRpcRequest {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new CaptureStorageError('invalid', 'Invalid capture operation.');
    const request = input as CaptureRpcRequest;
    if (typeof request.op !== 'string' || request.op.length > 32)
        throw new CaptureStorageError('invalid', 'Invalid capture operation name.');
    const fields = operations[request.op];
    if (
        !Object.hasOwn(operations, request.op) ||
        !fields ||
        Object.keys(request).some((key) => key !== 'op' && !fields.includes(key))
    )
        throw new CaptureStorageError('invalid', 'Unknown capture operation or field.');
    for (const field of fields)
        if (
            request.op !== 'page' &&
            !(request.op === 'export' && field === 'scope') &&
            !Object.hasOwn(request, field)
        )
            throw new CaptureStorageError('invalid', 'Missing capture operation field.');
    if ('id' in request) {
        if (typeof request.id !== 'string')
            throw new CaptureStorageError('invalid', 'Invalid capture identity.');
        validId(request.id);
    }
    if ('handle' in request) {
        if (typeof request.handle !== 'string')
            throw new CaptureStorageError('invalid', 'Invalid capture lease.');
        validId(request.handle);
    }
    if (request.op === 'begin')
        captureHeader(request.header as Parameters<CaptureRepository['begin']>[0]);
    if (request.op === 'append') {
        const frames = request.frames as CaptureFrame[];
        if (
            !Array.isArray(frames) ||
            !frames.length ||
            frames.length > 256 ||
            frames.reduce(
                (sum, frame) =>
                    sum + (frame?.bytes?.byteLength ?? CAPTURE_STORAGE.batchBytes) + 256,
                0,
            ) > CAPTURE_STORAGE.batchBytes
        )
            throw new CaptureStorageError(
                'backlog',
                'Capture IPC batch exceeds its bounded operation.',
            );
        for (const frame of frames) {
            if (
                !frame ||
                Object.keys(frame).some(
                    (key) =>
                        ![
                            'observation',
                            'receivedAt',
                            'stream',
                            'offset',
                            'totalBytes',
                            'bytes',
                            'crc32',
                        ].includes(key),
                )
            )
                throw new CaptureStorageError('invalid', 'Unknown capture frame field.');
            validateFrame(frame);
        }
    }
    if (request.op === 'page')
        pageBounds(
            request.after as number | undefined,
            request.limit as number | undefined,
            request.through as number | undefined,
        );
    if (request.op === 'seal' || request.op === 'fail') {
        if (request.observedBytes !== null || request.op === 'seal')
            integer(request.observedBytes as number);
        if (
            request.op === 'seal' &&
            (typeof request.reason !== 'string' || request.reason.length > 512)
        )
            throw new CaptureStorageError('invalid', 'Invalid capture completion reason.');
        if (request.op === 'fail') {
            const error = request.error as { code: string; message: string };
            if (
                !error ||
                Object.keys(error).some((key) => !['code', 'message'].includes(key)) ||
                ![
                    'quota',
                    'permission',
                    'io',
                    'unsupported',
                    'busy',
                    'invalid',
                    'integrity',
                    'backlog',
                ].includes(error.code) ||
                typeof error.message !== 'string' ||
                error.message.length > 512
            )
                throw new CaptureStorageError('invalid', 'Invalid capture failure.');
        }
    }
    if (request.op === 'record') automationOutcome(request.outcome);
    if (request.op === 'export') {
        if (!['json', 'csv', 'markdown', 'text'].includes(request.format as string))
            throw new CaptureStorageError('invalid', 'Invalid export format.');
        captureScope(request.scope ?? {});
    }
    return request;
}
interface Reader {
    iterator: AsyncIterator<CaptureRead>;
    first?: IteratorResult<CaptureRead>;
    busy?: Promise<unknown>;
    ending?: Promise<void>;
    closing: boolean;
    deadline: number;
}
interface Pin {
    release(): Promise<void>;
    through: number;
    ending?: Promise<void>;
    deadline: number;
    closing: boolean;
}
/** One authenticated renderer generation. No request contains a host path or a caller-chosen database. */
export class CaptureRpcServer {
    private writer?: string;
    private beginning?: Promise<unknown>;
    private generation = 0;
    private completed = new Set<string>();
    private readers = new Map<string, Reader>();
    private pins = new Map<string, Pin>();
    private mutations = new Set<Promise<unknown>>();
    private calls = 0;
    private expiredPins = new Set<string>();
    private resetting: Promise<void> = Promise.resolve();
    private timer: ReturnType<typeof setInterval>;
    private disposed = false;
    private pinReservations = 0;
    constructor(
        private store: CaptureRepository,
        private save: (
            format: CaptureReportFormat,
            scope: CaptureReportScope,
        ) => Promise<boolean> = async () => {
            throw new CaptureStorageError('unsupported', 'Native save is unavailable.');
        },
        private now = () => Date.now(),
        private ttl = 60000,
    ) {
        this.timer = setInterval(() => {
            void this.expire();
        }, 1000);
        (this.timer as unknown as { unref?: () => void }).unref?.();
    }
    private remember(id: string) {
        this.completed.add(id);
        while (this.completed.size > 64)
            this.completed.delete(this.completed.values().next().value!);
    }
    private own(id: string) {
        if (this.writer !== id)
            throw new CaptureStorageError('busy', 'This renderer does not own the capture writer.');
    }
    async dispatch(input: unknown): Promise<CaptureRpcReply> {
        let reserved = false;
        try {
            if (this.disposed)
                throw new CaptureStorageError('io', 'Native capture session is closed.');
            const request = captureRpcRequest(input),
                cleanup = ['return', 'unpin', 'close', 'info'].includes(request.op);
            if (this.calls >= (cleanup ? 32 : 16))
                throw new CaptureStorageError('busy', 'Too many capture operations are pending.');
            this.calls++;
            reserved = true;
            const requestGeneration = this.generation;
            while (true) {
                const barrier = this.resetting;
                await barrier;
                if (barrier === this.resetting) break;
            }
            if (requestGeneration !== this.generation && !['return', 'unpin'].includes(request.op))
                throw new CaptureStorageError(
                    'busy',
                    'Renderer generation changed before the operation started.',
                );
            if (this.expiredPins.size && !cleanup)
                throw new CaptureStorageError(
                    'busy',
                    'Capture snapshot expired; release it and restart the operation.',
                );
            for (const pin of this.pins.values())
                if (!pin.closing) pin.deadline = this.now() + this.ttl;
            const generation = this.generation,
                operation = this.perform(request),
                mutation = !['close', 'return', 'unpin', 'info', 'export'].includes(request.op);
            if (mutation) this.mutations.add(operation);
            try {
                const value = await operation;
                if (
                    generation !== this.generation &&
                    !['close', 'return', 'unpin', 'export'].includes(request.op)
                )
                    throw new CaptureStorageError(
                        'busy',
                        'Renderer generation changed before the operation was acknowledged.',
                    );
                return { ok: true, value };
            } finally {
                if (mutation) this.mutations.delete(operation);
            }
        } catch (error) {
            const failure = storageError(error);
            return { ok: false, error: { code: failure.code, message: failure.message } };
        } finally {
            if (reserved) this.calls--;
        }
    }
    private async perform(r: CaptureRpcRequest): Promise<unknown> {
        const id = r.id as string,
            handle = r.handle as string;
        switch (r.op) {
            case 'info':
                return {
                    schema: 1,
                    recoveryFailure: this.store.recoveryFailure
                        ? {
                              code: this.store.recoveryFailure.code,
                              message: this.store.recoveryFailure.message,
                          }
                        : null,
                };
            case 'begin': {
                if (this.writer || this.beginning)
                    throw new CaptureStorageError('busy', 'A capture writer is already active.');
                const generation = this.generation,
                    pending = (async () => {
                        const capture = await this.store.begin(
                            captureHeader(r.header as Parameters<CaptureRepository['begin']>[0]),
                        );
                        if (generation !== this.generation) {
                            await this.store.fail(
                                capture.id,
                                null,
                                new CaptureStorageError(
                                    'io',
                                    'Renderer ended during capture creation.',
                                ),
                            );
                            throw new CaptureStorageError('busy', 'Renderer generation changed.');
                        }
                        this.writer = capture.id;
                        return capture;
                    })();
                this.beginning = pending;
                try {
                    return await pending;
                } finally {
                    if (this.beginning === pending) this.beginning = undefined;
                }
            }
            case 'append':
                this.own(id);
                return this.store.append(id, r.frames as CaptureFrame[]);
            case 'seal': {
                this.own(id);
                const result = await this.store.seal(
                    id,
                    r.observedBytes as number,
                    r.reason as string,
                );
                this.writer = undefined;
                this.remember(id);
                return result;
            }
            case 'fail': {
                this.own(id);
                try {
                    const error = r.error as { code: CaptureStorageError['code']; message: string };
                    await this.store.fail(
                        id,
                        r.observedBytes as number | null,
                        new CaptureStorageError(error.code, error.message),
                    );
                } finally {
                    this.writer = undefined;
                    this.remember(id);
                }
                return null;
            }
            case 'page':
                return this.store.page(
                    r.after as number | undefined,
                    r.limit as number | undefined,
                    r.through as number | undefined,
                );
            case 'result':
                return this.store.result?.(id) ?? null;
            case 'record':
                if (!this.completed.has(id) || !this.store.record)
                    throw new CaptureStorageError(
                        'busy',
                        'This renderer does not own the command outcome.',
                    );
                await this.store.record(id, automationOutcome(r.outcome));
                return null;
            case 'delete':
                await this.store.delete(id);
                return null;
            case 'pin': {
                if (this.pins.size + this.pinReservations >= 8)
                    throw new CaptureStorageError('busy', 'Finish another capture snapshot first.');
                this.pinReservations++;
                try {
                    const key = crypto.randomUUID(),
                        pin = await this.store.pin();
                    this.pins.set(key, { ...pin, closing: false, deadline: this.now() + this.ttl });
                    return { handle: key, through: pin.through };
                } finally {
                    this.pinReservations--;
                }
            }
            case 'unpin':
                await this.releasePin(handle);
                this.expiredPins.delete(handle);
                return null;
            case 'read': {
                if (this.readers.size >= 4)
                    throw new CaptureStorageError('busy', 'Finish another output reader first.');
                const key = crypto.randomUUID(),
                    iterator = this.store.read(id)[Symbol.asyncIterator](),
                    entry: Reader = { iterator, closing: false, deadline: this.now() + this.ttl };
                this.readers.set(key, entry);
                try {
                    entry.busy = iterator.next();
                    entry.first = (await entry.busy) as IteratorResult<CaptureRead>;
                    return { handle: key };
                } catch (error) {
                    await this.closeReader(key);
                    throw error;
                } finally {
                    entry.busy = undefined;
                }
            }
            case 'pull': {
                const reader = this.readers.get(handle);
                if (!reader || reader.closing || reader.busy)
                    throw new CaptureStorageError(
                        'busy',
                        'Capture reader expired or is already reading.',
                    );
                reader.deadline = this.now() + this.ttl;
                const pending = (async () => {
                    const events: CaptureRead[] = [];
                    for (let index = 0; index < 3; index++) {
                        const next = reader.first ?? (await reader.iterator.next());
                        reader.first = undefined;
                        if (next.done) return { events, done: true };
                        events.push(next.value);
                        if (next.value.type === 'metadata') break;
                    }
                    return { events, done: false };
                })();
                reader.busy = pending;
                try {
                    return await pending;
                } finally {
                    reader.busy = undefined;
                }
            }
            case 'return':
                await this.closeReader(handle);
                return null;
            case 'close':
                await this.reset();
                return null;
            case 'export':
                return this.save(r.format as CaptureReportFormat, r.scope as CaptureReportScope);
        }
        throw new CaptureStorageError('invalid', 'Unknown capture operation.');
    }
    private closeReader(handle: string) {
        const entry = this.readers.get(handle);
        if (!entry) return Promise.resolve();
        if (entry.ending) return entry.ending;
        entry.closing = true;
        return (entry.ending = (async () => {
            await entry.busy?.catch(() => {});
            try {
                await entry.iterator.return?.();
            } finally {
                this.readers.delete(handle);
            }
        })());
    }
    private releasePin(handle: string) {
        const pin = this.pins.get(handle);
        if (!pin) return Promise.resolve();
        if (pin.ending) return pin.ending;
        pin.closing = true;
        return (pin.ending = (async () => {
            await Promise.allSettled([...this.readers.values()].map((reader) => reader.busy));
            try {
                await pin.release();
            } finally {
                this.pins.delete(handle);
            }
        })());
    }
    private async expire() {
        for (const [handle, reader] of this.readers)
            if (!reader.closing && reader.deadline <= this.now())
                void this.closeReader(handle).catch(() => {});
        for (const [handle, pin] of this.pins)
            if (!pin.closing && pin.deadline <= this.now()) {
                this.expiredPins.add(handle);
                void this.releasePin(handle).catch(() => {});
            }
    }
    reset() {
        this.generation++;
        const previous = this.resetting,
            pending = previous.then(async () => {
                await Promise.allSettled([...this.mutations]);
                await this.beginning?.catch(() => {});
                await Promise.allSettled(
                    [...this.readers.keys()].map((key) => this.closeReader(key)),
                );
                await Promise.allSettled([...this.pins.keys()].map((key) => this.releasePin(key)));
                if (this.writer) {
                    const id = this.writer;
                    this.writer = undefined;
                    await this.store.fail(
                        id,
                        null,
                        new CaptureStorageError('io', 'Renderer ended before capture completion.'),
                    );
                }
                this.completed.clear();
                this.expiredPins.clear();
            });
        this.resetting = pending.catch(() => {});
        return pending;
    }
    async dispose() {
        this.disposed = true;
        clearInterval(this.timer);
        await this.reset();
    }
}
