import { randomBytes } from 'node:crypto';
import type { SshSession } from './session';
import type { ConsoleRepository } from '../../shared/console-journal';
import { consoleRpcRequest, type ConsoleOwner } from '../../shared/console-rpc';
import { dispatchConsoleWrite, RemoteConsoleRepository } from '../../shared/console-storage';
import { ConsoleOperationPort } from './console-port';
import { GatewayConsoleRepository } from './gateway-console-repository';

type Source = 'local-client' | 'gateway';
type Phase = 'opening' | 'ready' | 'executing' | 'stopping' | 'closed' | 'cleanup-pending';
type State = {
    id: string;
    connection: string;
    capability: string;
    source: Source;
    phase: Phase;
    revision: number;
    sequence: number;
    error: string | null;
    controller: AbortController;
    bound: ReturnType<SshSession['createAutomationConsole']>;
    port?: ConsoleOperationPort;
    store: RemoteConsoleRepository;
    loss?: Error;
    stepTask?: Promise<unknown>;
    retirement?: Promise<void>;
    openingSettled: boolean;
    lastOwnerContact: number;
    opening: Promise<void>;
    closing?: Promise<unknown>;
    timer?: ReturnType<typeof setInterval>;
};
/** Private session capability; retained cleanup ownership is never replaced by an HTTP response. */
export class SshConsoleHost {
    private epoch = randomBytes(16).toString('hex');
    private state?: State;
    private shuttingDown = false;
    private receipts = new Map<
        string,
        {
            owner: ConsoleOwner;
            source: Source;
            status: ReturnType<SshConsoleHost['status']>;
            expires: number;
        }
    >();
    private trimReceipts() {
        for (const [id, receipt] of this.receipts)
            if (receipt.expires <= Date.now()) this.receipts.delete(id);
        while (this.receipts.size > 128) this.receipts.delete(this.receipts.keys().next().value!);
    }
    constructor(
        private session: SshSession,
        private localStore?: () => Promise<ConsoleRepository>,
    ) {}
    private status(s: State) {
        return {
            protocol: 1,
            id: s.id,
            revision: s.revision,
            phase: s.phase,
            error: s.error,
            snapshot: s.bound.actor.snapshot,
            ownerHeld: s.bound.actor.owned,
            cleanup: {
                storageAdapterClosed:
                    s.store.resourceClosed ||
                    (s.store instanceof GatewayConsoleRepository &&
                        s.store.localDisposal?.disposed === true),
                journalClosure: s.store.resourceClosed
                    ? ('acknowledged' as const)
                    : s.store instanceof GatewayConsoleRepository && s.store.localDisposal?.disposed
                      ? ('unacknowledged' as const)
                      : ('pending' as const),
            },
        };
    }
    private change(s: State, phase: Phase, error?: unknown) {
        s.phase = phase;
        s.revision++;
        if (error !== undefined)
            s.error = (error instanceof Error ? error.message : String(error)).slice(0, 512);
        s.port?.notify();
    }
    invalidate() {
        this.epoch = randomBytes(16).toString('hex');
        const s = this.state;
        if (!s) return;
        this.lose(
            s,
            Error('Console connection changed; remote journal closure may be unacknowledged.'),
        );
    }
    transportLost(owner: ConsoleOwner) {
        const s = this.state;
        if (
            !s ||
            s.id !== owner.id ||
            s.connection !== owner.connection ||
            s.capability !== owner.capability
        )
            return;
        this.lose(
            s,
            Error('Console transport was lost; remote journal closure is unacknowledged.'),
        );
    }
    private lose(s: State, error: Error) {
        s.loss ??= error;
        if (s.store instanceof GatewayConsoleRepository) s.store.transportLost(s.loss);
        s.controller.abort();
        void this.finish(s, 'cancelled')
            .catch(() => {})
            .then(() => this.retireLost(s))
            .catch(() => {});
    }
    private async retireLost(s: State) {
        if (!s.loss) return;
        const store = s.store;
        if (s.retirement) return s.retirement;
        const task = (async () => {
            await s.opening;
            await s.stepTask?.catch(() => {});
            await s.closing?.catch(() => {});
            if (
                s.bound.actor.owned ||
                (!store.resourceClosed &&
                    !(store instanceof GatewayConsoleRepository && store.localDisposal?.disposed))
            )
                return;
            await s.port!.dispose(s.loss!);
            this.change(s, 'closed', s.loss);
            if (!this.shuttingDown)
                this.receipts.set(s.id, {
                    owner: { id: s.id, connection: s.connection, capability: s.capability },
                    source: s.source,
                    status: this.status(s),
                    expires: Date.now() + 10 * 60_000,
                });
            this.trimReceipts();
            if (this.state === s) this.state = undefined;
        })();
        s.retirement = task;
        await task;
    }
    async shutdown() {
        this.shuttingDown = true;
        this.invalidate();
        const s = this.state;
        if (s) {
            try {
                await this.finish(s, 'cancelled');
            } catch (error) {
                if (s.bound.actor.owned) throw error;
            }
            await s.opening;
            await s.stepTask?.catch(() => {});
            await s.retirement;
            await s.port?.dispose(Error('Console host shut down.'));
            if (s.bound.actor.owned) throw Error('Console shutdown cleanup remains pending.');
            if (this.state === s) this.state = undefined;
        }
        this.receipts.clear();
    }
    private async finish(s: State, reason: 'complete' | 'cancelled') {
        if (s.phase === 'closed') return this.status(s);
        if (s.closing) {
            await s.closing;
            return this.status(s);
        }
        if (reason === 'complete' && s.phase !== 'ready')
            throw Error('Await console readiness and the active step before finishing.');
        if (reason === 'cancelled') s.controller.abort();
        this.change(s, 'stopping');
        const task = (async () => {
            try {
                if (reason === 'complete') await s.bound.actor.finish();
                else await s.bound.actor.cancel();
                this.change(s, 'closed');
            } catch (error) {
                this.change(s, s.bound.actor.owned ? 'cleanup-pending' : 'closed', error);
                throw error;
            } finally {
                clearInterval(s.timer);
                s.timer = undefined;
            }
        })();
        s.closing = task;
        try {
            await task;
        } finally {
            if (s.closing === task) s.closing = undefined;
        }
        return this.status(s);
    }
    async dispatch(input: unknown, source: Source = 'local-client'): Promise<unknown> {
        const r = consoleRpcRequest(input);
        if (this.shuttingDown) throw Error('Console host is shutting down.');
        this.trimReceipts();
        if (r.action === 'capabilities')
            return {
                protocol: 1,
                independentStream: 1,
                persistentConsole: 1,
                epoch: this.epoch,
                receiveTimeSource: source,
                journal: this.localStore ? 'native-v2' : 'browser-v2',
                heartbeat: source === 'gateway' ? { intervalMs: 500, stallMs: 2500 } : null,
            };
        if (r.action === 'open') {
            if (!this.localStore && source !== 'gateway')
                throw Error('Native console storage is unavailable.');
            if (this.state) throw Error('Release the previous console after acknowledged cleanup.');
            if (this.receipts.has(r.id))
                throw Error('Console identity was retired. Arm explicitly with a new identity.');
            if (r.epoch !== this.epoch || r.connection !== this.session.automationConnection)
                throw Error('Console generation changed. Arm explicitly to resume.');
            let s!: State;
            const port = new ConsoleOperationPort(() => this.status(s));
            let actual: Promise<ConsoleRepository> | undefined;
            const store = !this.localStore
                ? new GatewayConsoleRepository(port)
                : new RemoteConsoleRepository(async (request) => {
                      actual ??= this.localStore!();
                      let journal: ConsoleRepository;
                      try {
                          journal = await actual;
                      } catch (error) {
                          // A factory rejection owns no journal; NativeConsoleJournal.open cleans up its reservation.
                          if (request.op === 'close')
                              return { snapshot: null, value: null, closed: true };
                          throw error;
                      }
                      return dispatchConsoleWrite(journal, request);
                  });
            const controller = new AbortController();
            let local = Date.now(),
                mono = performance.now();
            const fresh = () => {
                if (controller.signal.aborted) throw Error('Console arm is no longer current.');
                const now = Date.now(),
                    tick = performance.now(),
                    elapsed = tick - mono;
                if (elapsed < 0 || elapsed > 2500 || Math.abs(now - local - elapsed) > 1000) {
                    controller.abort();
                    throw Error(
                        'Console runtime slept, stalled or changed its clock. Arm explicitly to resume.',
                    );
                }
                local = now;
                mono = tick;
            };
            const bound = this.session.createAutomationConsole(
                store,
                r.connection,
                fresh,
                store instanceof GatewayConsoleRepository ? () => store.localDisposal : undefined,
            );
            s = {
                id: r.id,
                connection: r.connection,
                capability: randomBytes(32).toString('hex'),
                source,
                phase: 'opening',
                revision: 1,
                sequence: 0,
                error: null,
                controller,
                bound,
                port,
                store,
                openingSettled: false,
                lastOwnerContact: performance.now(),
                opening: Promise.resolve(),
            };
            this.state = s;
            s.timer = setInterval(() => {
                try {
                    if (s.source === 'gateway' && performance.now() - s.lastOwnerContact > 2500)
                        throw Error('Console owner heartbeat was lost; later input is disarmed.');
                    fresh();
                } catch (error) {
                    s.error = (error as Error).message;
                    if (s.source === 'gateway') this.lose(s, error as Error);
                    else void this.finish(s, 'cancelled').catch(() => {});
                }
            }, 250);
            s.timer.unref();
            s.opening = bound.actor
                .open(
                    {
                        flowId: r.id,
                        startedAt: new Date().toISOString(),
                        target: bound.target,
                        receiveTimeSource: source,
                        ready: r.ready,
                    },
                    AbortSignal.any([controller.signal, bound.signal]),
                    r.timeoutMs,
                )
                .then(() => {
                    this.change(s, 'ready');
                })
                .catch((error) => {
                    clearInterval(s.timer);
                    s.timer = undefined;
                    this.change(s, bound.actor.owned ? 'cleanup-pending' : 'closed', error);
                })
                .finally(() => {
                    s.openingSettled = true;
                });
            return { protocol: 1, id: s.id, connection: s.connection, capability: s.capability };
        }
        const s = this.state;
        if (
            !s ||
            s.id !== r.id ||
            s.connection !== r.connection ||
            s.capability !== r.capability ||
            s.source !== source
        ) {
            const receipt = this.receipts.get(r.id);
            if (
                !receipt ||
                receipt.owner.connection !== r.connection ||
                receipt.owner.capability !== r.capability ||
                receipt.source !== source
            )
                throw Error('Console owner is invalid or stale.');
            if (r.action === 'status' || r.action === 'finish')
                return structuredClone(receipt.status);
            if (r.action === 'read') return { type: 'state', ...structuredClone(receipt.status) };
            if (r.action === 'release') return { ok: true };
            throw Error(
                'Console owner is retired; no further input or acknowledgement is accepted.',
            );
        }
        switch (r.action) {
            case 'heartbeat':
                if (s.loss) throw s.loss;
                s.lastOwnerContact = performance.now();
                return { ok: true };
            case 'status':
                return this.status(s);
            case 'read':
                return s.port!.read(r.revision);
            case 'ack':
                if (!s.port)
                    throw Error('Native console storage does not accept browser acknowledgements.');
                return s.port.acknowledge(r.sequence, r.reply, r.error);
            case 'step': {
                if (s.phase !== 'ready' || s.sequence !== r.sequence)
                    throw Error('Console input sequence is stale or another operation is active.');
                s.sequence++;
                this.change(s, 'executing');
                const task = (async () => {
                    try {
                        const result = await s.bound.actor.step(r.segment, r.timeoutMs);
                        this.change(s, 'ready');
                        return { protocol: 1, ...result, console: s.bound.actor.snapshot };
                    } catch (error) {
                        clearInterval(s.timer);
                        s.timer = undefined;
                        this.change(s, s.bound.actor.owned ? 'cleanup-pending' : 'closed', error);
                        throw error;
                    }
                })();
                s.stepTask = task;
                try {
                    return await task;
                } finally {
                    if (s.stepTask === task) s.stepTask = undefined;
                }
            }
            case 'finish':
                return this.finish(s, r.reason);
            case 'release':
                if (s.bound.actor.owned || s.phase !== 'closed')
                    throw Error('Console cleanup remains pending.');
                await s.opening;
                await s.port?.dispose(Error('Console owner was released.'));
                this.receipts.set(s.id, {
                    owner: { id: s.id, connection: s.connection, capability: s.capability },
                    source: s.source,
                    status: this.status(s),
                    expires: Date.now() + 10 * 60_000,
                });
                this.trimReceipts();
                this.state = undefined;
                return { ok: true };
        }
    }
    get snapshot() {
        const s = this.state;
        return s ? { ...this.status(s), port: s.port?.snapshot ?? null } : null;
    }
    /** Local module inspection only; never serialized by a production HTTP or renderer route. */
    get ownershipSnapshot() {
        this.trimReceipts();
        const s = this.state;
        return {
            activeStates: s ? 1 : 0,
            actors: s?.bound.actor.owned ? 1 : 0,
            actor: s?.bound.actor.ownershipSnapshot ?? null,
            opening: s && !s.openingSettled ? 1 : 0,
            executing: s?.stepTask ? 1 : 0,
            closing: s?.closing ? 1 : 0,
            heartbeatTimers: s?.timer ? 1 : 0,
            port: s?.port?.snapshot ?? null,
            terminalReceipts: this.receipts.size,
            terminalReceiptBytes: Buffer.byteLength(
                JSON.stringify([...this.receipts.values()].map((receipt) => receipt.status)),
            ),
            receiptLimit: 128,
            receiptTtlMs: 10 * 60_000,
        };
    }
}
