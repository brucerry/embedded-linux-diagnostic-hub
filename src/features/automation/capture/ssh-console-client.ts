import { CaptureStorageError, integer, storageError } from '../../../../shared/capture-store';
import {
    consoleOwner,
    consoleCleanup,
    type ConsoleOwner,
    type ConsoleRpc,
    type ConsoleRpcRequest,
} from '../../../../shared/console-rpc';
import { streamObject } from '../../../../shared/ssh-stream-rpc';
import {
    consoleSnapshot,
    consoleWriteRequest,
    dispatchConsoleWrite,
} from '../../../../shared/console-storage';
import { consoleReady, type ConsoleCompletion } from '../../../../shared/ssh-console';
import {
    consoleSegment,
    type ConsoleRepository,
    type ConsoleSegment,
    type ConsoleSnapshot,
} from '../../../../shared/console-journal';

function deferred() {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((a, b) => {
        resolve = a;
        reject = b;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
/** One flow, one ordered durable operation pump, no command retry or automatic reconnection. */
export class SshConsoleClient {
    private owner?: ConsoleOwner;
    private pump?: Promise<void>;
    private ready = deferred();
    private ownerReady = deferred();
    private openingStarted = false;
    private closed = false;
    private sequence = 0;
    private closeTask?: Promise<ConsoleSnapshot | null>;
    private current: ConsoleSnapshot | null = null;
    private guard = () => {};
    private phase = 'idle';
    private executing?: Promise<Awaited<ReturnType<SshConsoleClient['runStep']>>>;
    private requests = new Set<Promise<unknown>>();
    private ioAbort = new AbortController();
    private pumpSettled = false;
    private pumpFailure?: unknown;
    private openingUnacknowledged = false;
    private serverClosureAcknowledged = false;
    private heartbeat?: ReturnType<typeof setInterval>;
    private heartbeatPending?: Promise<unknown>;
    constructor(
        private rpc: ConsoleRpc,
        private source: 'local-client' | 'gateway',
        private browserStore?: ConsoleRepository,
    ) {}
    private call(input: ConsoleRpcRequest) {
        const task = Promise.resolve().then(() =>
            this.rpc(
                input,
                this.source === 'gateway' ? { signal: this.ioAbort.signal } : undefined,
            ),
        );
        this.requests.add(task);
        void task.finally(() => this.requests.delete(task)).catch(() => {});
        return task;
    }
    private stopHeartbeat() {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
    }
    private startHeartbeat() {
        if (this.source !== 'gateway') return;
        this.heartbeat = setInterval(() => {
            if (!this.owner || this.closed || this.ioAbort.signal.aborted || this.heartbeatPending)
                return;
            const task = this.call({ protocol: 1, action: 'heartbeat', ...this.owner })
                .then((input) => {
                    const reply = streamObject(input, ['ok']);
                    if (reply.ok !== true)
                        throw Error('Console owner heartbeat was not acknowledged.');
                })
                .catch((error) => {
                    this.pumpFailure ??= error;
                    this.ioAbort.abort(error);
                    this.ready.reject(error instanceof Error ? error : Error(String(error)));
                })
                .finally(() => {
                    if (this.heartbeatPending === task) this.heartbeatPending = undefined;
                });
            this.heartbeatPending = task;
        }, 500);
    }
    private async closeBrowserAfterFailure(error: unknown) {
        if (!this.browserStore) return;
        const failures: unknown[] = [];
        if (!this.browserStore.resourceClosed) {
            try {
                await this.browserStore.fail(null, storageError(error));
            } catch (failure) {
                failures.push(failure);
            }
            try {
                await this.browserStore.close();
            } catch (failure) {
                failures.push(failure);
            }
        }
        const snapshot = this.browserStore.snapshot;
        if (snapshot && (!this.owner || snapshot.header.flowId === this.owner.id))
            this.current = consoleSnapshot(snapshot);
        if (!this.browserStore.resourceClosed)
            throw new AggregateError(
                [error, ...failures],
                'Browser journal cleanup remains pending.',
            );
    }
    get snapshot() {
        return this.current ? structuredClone(this.current) : null;
    }
    get failed() {
        return this.pumpFailure !== undefined;
    }
    open(
        connection: string,
        id: string,
        ready: ConsoleCompletion,
        timeoutMs: number,
        assertFresh: () => void,
    ) {
        if (this.openingStarted)
            return Promise.reject(Error('This flow console has already been used.'));
        this.openingStarted = true;
        return this.openInternal(connection, id, ready, timeoutMs, assertFresh).catch((error) => {
            this.ownerReady.reject(error);
            throw error;
        });
    }
    private async openInternal(
        connection: string,
        id: string,
        ready: ConsoleCompletion,
        timeoutMs: number,
        assertFresh: () => void,
    ) {
        if (this.owner || this.phase !== 'idle')
            throw Error('This flow console has already been used.');
        this.guard = assertFresh;
        assertFresh();
        consoleReady(ready);
        integer(timeoutMs, 1000, 300000);
        const capability = streamObject(await this.call({ protocol: 1, action: 'capabilities' }), [
            'protocol',
            'persistentConsole',
            'independentStream',
            'epoch',
            'receiveTimeSource',
            'journal',
            'heartbeat',
        ]);
        if (
            capability.protocol !== 1 ||
            capability.persistentConsole !== 1 ||
            capability.independentStream !== 1 ||
            capability.receiveTimeSource !== this.source ||
            typeof capability.epoch !== 'string' ||
            !/^[a-f0-9]{32}$/.test(capability.epoch) ||
            capability.journal !== (this.source === 'gateway' ? 'browser-v2' : 'native-v2')
        )
            throw new CaptureStorageError(
                'unsupported',
                'Update the desktop app or gateway to enable persistent console capture.',
            );
        if (this.source === 'gateway' && !this.browserStore)
            throw new CaptureStorageError(
                'unsupported',
                'Full browser console storage is unavailable.',
            );
        if (this.source === 'gateway') {
            const heartbeat = streamObject(capability.heartbeat, ['intervalMs', 'stallMs']);
            if (heartbeat.intervalMs !== 500 || heartbeat.stallMs !== 2500)
                throw Error('Gateway console heartbeat capability differs.');
        } else if (capability.heartbeat !== null)
            throw Error('Native console heartbeat capability differs.');
        assertFresh();
        this.phase = 'opening';
        this.openingUnacknowledged = true;
        const value = streamObject(
            await this.call({
                protocol: 1,
                action: 'open',
                epoch: capability.epoch,
                id,
                connection,
                ready,
                timeoutMs,
            }),
            ['protocol', 'id', 'connection', 'capability'],
        );
        const owner = consoleOwner({
            id: value.id,
            connection: value.connection,
            capability: value.capability,
        });
        if (value.protocol !== 1 || owner.id !== id || owner.connection !== connection)
            throw Error('Console opened with a different owner.');
        this.owner = owner;
        this.openingUnacknowledged = false;
        this.ownerReady.resolve();
        this.startHeartbeat();
        this.pump = this.consume();
        void this.pump.catch((error) => this.ready.reject(error));
        await this.ready.promise;
        assertFresh();
        return this.snapshot;
    }
    private async consume() {
        let revision = 0,
            sequence = 0;
        try {
            while (!this.closed) {
                const input = await this.call({
                    protocol: 1,
                    action: 'read',
                    ...this.owner!,
                    revision,
                });
                const event = streamObject(input, [
                    'protocol',
                    'type',
                    'sequence',
                    'request',
                    'id',
                    'revision',
                    'phase',
                    'error',
                    'snapshot',
                    'ownerHeld',
                    'cleanup',
                ]);
                if (event.protocol !== 1) throw Error('Invalid console pump protocol.');
                if (event.type === 'operation') {
                    streamObject(event, ['protocol', 'type', 'sequence', 'request']);
                    if (
                        this.source !== 'gateway' ||
                        !this.browserStore ||
                        event.sequence !== sequence++
                    )
                        throw Error('Console persistence sequence is invalid or stale.');
                    const request = consoleWriteRequest(event.request);
                    let reply: Awaited<ReturnType<typeof dispatchConsoleWrite>> | null = null,
                        error: { code: string; message: string } | null = null;
                    try {
                        if (
                            request.op === 'begin' ||
                            (request.op === 'start' && request.segment.kind === 'command')
                        )
                            this.guard();
                        reply = await dispatchConsoleWrite(this.browserStore, request);
                    } catch (e) {
                        const failure = storageError(e);
                        error = { code: failure.code, message: failure.message.slice(0, 512) };
                    }
                    await this.call({
                        protocol: 1,
                        action: 'ack',
                        ...this.owner!,
                        sequence: event.sequence as number,
                        reply,
                        error,
                    });
                } else if (event.type === 'idle') {
                    streamObject(event, ['protocol', 'type', 'id', 'revision']);
                    if (event.id !== this.owner!.id || event.revision !== revision)
                        throw Error(
                            'Console idle renewal belongs to a different owner or revision.',
                        );
                } else if (event.type === 'state') {
                    streamObject(event, [
                        'protocol',
                        'type',
                        'id',
                        'revision',
                        'phase',
                        'error',
                        'snapshot',
                        'ownerHeld',
                        'cleanup',
                    ]);
                    integer(event.revision as number, revision + 1);
                    if (
                        event.id !== this.owner!.id ||
                        typeof event.ownerHeld !== 'boolean' ||
                        ![
                            'opening',
                            'ready',
                            'executing',
                            'stopping',
                            'closed',
                            'cleanup-pending',
                        ].includes(event.phase as string) ||
                        (event.error !== null &&
                            (typeof event.error !== 'string' || event.error.length > 512))
                    )
                        throw Error('Invalid console lifecycle state.');
                    revision = event.revision as number;
                    const cleanup = consoleCleanup(event.cleanup);
                    this.phase = event.phase as string;
                    this.current = event.snapshot === null ? null : consoleSnapshot(event.snapshot);
                    if (
                        this.current &&
                        (this.current.header.flowId !== this.owner!.id ||
                            this.current.header.receiveTimeSource !== this.source)
                    )
                        throw Error('Console capture belongs to a different flow or observer.');
                    if (this.phase === 'ready') this.ready.resolve();
                    if (this.phase === 'cleanup-pending')
                        throw Error(
                            (event.error ?? 'Console cleanup is unacknowledged.') as string,
                        );
                    if (this.phase === 'closed') {
                        if (
                            event.ownerHeld ||
                            !cleanup.storageAdapterClosed ||
                            cleanup.journalClosure !== 'acknowledged'
                        )
                            throw Error(
                                (event.error ??
                                    'Console cleanup or remote journal closure is unacknowledged.') as string,
                            );
                        if (event.error !== null) throw Error(event.error as string);
                        if (this.browserStore && !this.browserStore.resourceClosed)
                            throw Error('Console closed before the browser journal closed.');
                        this.closed = true;
                        this.ready.reject(
                            Error((event.error ?? 'Console closed before readiness.') as string),
                        );
                    }
                } else throw Error('Unknown console pump event.');
            }
        } catch (error) {
            this.pumpFailure = error;
            this.ready.reject(error instanceof Error ? error : Error(String(error)));
            if (this.source === 'gateway') {
                this.ioAbort.abort(error);
                this.stopHeartbeat();
                await this.heartbeatPending;
                await this.executing?.catch(() => {});
                while (this.requests.size) await Promise.allSettled([...this.requests]);
            }
            await this.closeBrowserAfterFailure(error);
            if (this.source === 'gateway') {
                this.owner = undefined;
                this.closed = true;
                this.phase = 'closed';
            }
            throw error;
        } finally {
            this.stopHeartbeat();
            this.pumpSettled = true;
        }
    }
    step(
        segment: Extract<ConsoleSegment, { kind: 'command' }>,
        timeoutMs: number,
        assertFresh: () => void,
    ) {
        if (this.executing) return Promise.reject(Error('A console command is already executing.'));
        const task = this.runStep(segment, timeoutMs, assertFresh);
        this.executing = task;
        void task
            .finally(() => {
                if (this.executing === task) this.executing = undefined;
            })
            .catch(() => {});
        return task;
    }
    private async runStep(
        segment: Extract<ConsoleSegment, { kind: 'command' }>,
        timeoutMs: number,
        assertFresh: () => void,
    ) {
        if (!this.owner || this.phase !== 'ready' || this.closed)
            throw Error('Console is not ready for input.');
        const checked = consoleSegment(segment);
        if (checked.kind !== 'command') throw Error('Console input requires a command.');
        this.guard = assertFresh;
        assertFresh();
        this.phase = 'executing';
        const sequence = this.sequence++;
        const reply = streamObject(
            await this.call({
                protocol: 1,
                action: 'step',
                ...this.owner,
                sequence,
                segment: checked,
                timeoutMs,
            }),
            ['protocol', 'completion', 'exitCode', 'match', 'requestBase64', 'console'],
        );
        if (
            reply.protocol !== 1 ||
            reply.completion !== 'prompt-observed' ||
            reply.exitCode !== null ||
            reply.requestBase64 !== checked.requestBase64
        )
            throw Error('Invalid console command evidence.');
        if (this.pumpFailure) throw this.pumpFailure;
        if (this.closed) throw Error('Console closed before command evidence was accepted.');
        const match = streamObject(reply.match, ['role', 'literal']);
        if (
            match.role !== checked.criterion.role ||
            !checked.criterion.literals.includes(match.literal as string)
        )
            throw Error('Console matched a different completion criterion.');
        this.current = consoleSnapshot(reply.console);
        if (!this.closed) this.phase = 'ready';
        assertFresh();
        return {
            completion: 'prompt-observed' as const,
            exitCode: null,
            match: {
                role: match.role as ConsoleCompletion['role'],
                literal: match.literal as string,
            },
            requestBase64: checked.requestBase64,
            console: this.snapshot!,
        };
    }
    close(reason: 'complete' | 'cancelled' = 'cancelled'): Promise<ConsoleSnapshot | null> {
        if (this.closeTask) return this.closeTask;
        const task = (async () => {
            if (this.openingStarted && !this.owner) await this.ownerReady.promise.catch(() => {});
            if (!this.owner) {
                this.stopHeartbeat();
                await this.browserStore?.close();
                if (this.source === 'local-client' && this.openingUnacknowledged)
                    throw Error(
                        'Native console opening ownership is unacknowledged. Actual host cleanup is required.',
                    );
                this.phase = 'closed';
                this.closed = true;
                if (this.pumpFailure) throw this.pumpFailure;
                return this.snapshot;
            }
            try {
                if (this.source === 'gateway' && this.pumpFailure) throw this.pumpFailure;
                const status = streamObject(
                    await this.call({ protocol: 1, action: 'finish', ...this.owner, reason }),
                    [
                        'protocol',
                        'id',
                        'revision',
                        'phase',
                        'error',
                        'snapshot',
                        'ownerHeld',
                        'cleanup',
                    ],
                );
                const cleanup = consoleCleanup(status.cleanup);
                if (
                    status.protocol !== 1 ||
                    status.id !== this.owner.id ||
                    status.phase !== 'closed' ||
                    status.ownerHeld !== false ||
                    !cleanup.storageAdapterClosed ||
                    cleanup.journalClosure !== 'acknowledged'
                )
                    throw Error('Console cleanup or remote journal closure is unacknowledged.');
                this.serverClosureAcknowledged = true;
                const pumpFailure = await this.pump?.then(
                    () => undefined,
                    (error) => error,
                );
                await this.heartbeatPending;
                await this.browserStore?.close();
                if (this.browserStore && !this.browserStore.resourceClosed)
                    throw Error('Browser journal cleanup remains pending.');
                await this.call({ protocol: 1, action: 'release', ...this.owner });
                this.owner = undefined;
                this.closed = true;
                this.phase = 'closed';
                if (pumpFailure) throw pumpFailure;
                return this.snapshot;
            } catch (error) {
                if (this.source === 'gateway') {
                    this.ioAbort.abort(error);
                    this.stopHeartbeat();
                    await this.pump?.catch(() => {});
                    await this.heartbeatPending;
                    await this.executing?.catch(() => {});
                    while (this.requests.size) await Promise.allSettled([...this.requests]);
                    await this.closeBrowserAfterFailure(error);
                    if (!this.browserStore?.resourceClosed || !this.pumpSettled)
                        throw Error('Browser console cleanup remains pending.');
                    this.owner = undefined;
                    this.closed = true;
                    this.phase = 'closed';
                }
                throw error;
            }
        })();
        this.closeTask = task;
        void task.catch(() => {
            if (this.closeTask === task) this.closeTask = undefined;
        });
        return task;
    }
    get resourceSnapshot() {
        return {
            owner: Boolean(this.owner),
            phase: this.phase,
            pump: Boolean(this.pump && !this.pumpSettled),
            storeClosed: this.browserStore?.resourceClosed ?? null,
            requests: this.requests.size,
            executing: Boolean(this.executing),
            heartbeatTimers: this.heartbeat ? 1 : 0,
            heartbeatRequests: this.heartbeatPending ? 1 : 0,
            journalClosure: this.serverClosureAcknowledged
                ? 'acknowledged'
                : this.closed
                  ? 'unacknowledged'
                  : 'pending',
            localCleanupClosed:
                this.closed &&
                !this.owner &&
                !this.executing &&
                !this.requests.size &&
                !this.heartbeat &&
                !this.heartbeatPending &&
                (!this.pump || this.pumpSettled) &&
                (this.source === 'gateway'
                    ? !this.browserStore || this.browserStore.resourceClosed
                    : !this.openingUnacknowledged &&
                      (!this.pump || this.serverClosureAcknowledged)),
        };
    }
}
