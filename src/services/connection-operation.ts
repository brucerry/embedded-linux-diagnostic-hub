import type { ConnectOptions } from '../../shared/types';
import {
    ConnectionFailure,
    CONNECTION_FAILURE_MESSAGES,
    connectionFailure,
} from '../../shared/connection';

export interface ConnectionTransport {
    connect(options: ConnectOptions, attemptId?: string): Promise<void>;
    cancelConnect?(attemptId: string): Promise<void>;
}
export interface ConnectionProgress {
    state: 'attempting' | 'waiting' | 'cancelling' | 'paused' | 'connected' | 'cancelled';
    attempt: number;
    message: string;
}
interface Run {
    cancelled: boolean;
    attemptId: string;
    transport: ConnectionTransport;
    wake?: () => void;
    cleanup?: Promise<void>;
    finished: Promise<void>;
    finish(): void;
    progress: (state: ConnectionProgress) => void;
    attempt: number;
}
interface RetryClock {
    set(callback: () => void, delay: number): unknown;
    clear(timer: unknown): void;
}
const clock: RetryClock = {
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class ConnectionOperation {
    private active?: Run;
    constructor(
        private readonly timers: RetryClock = clock,
        private readonly newId = () => crypto.randomUUID().replaceAll('-', ''),
    ) {}

    get running() {
        return Boolean(this.active);
    }

    async cancel(): Promise<void> {
        const run = this.active;
        if (!run) return;
        run.cancelled = true;
        run.progress({
            state: 'cancelling',
            attempt: run.attempt,
            message: 'Cancelling connection…',
        });
        run.wake?.();
        if (run.attemptId) run.cleanup ??= run.transport.cancelConnect!(run.attemptId);
        try {
            await run.cleanup;
            await run.finished;
        } catch {
            throw new ConnectionFailure('cleanup', CONNECTION_FAILURE_MESSAGES.cleanup);
        }
    }

    async connect(
        transport: ConnectionTransport,
        input: ConnectOptions,
        progress: (state: ConnectionProgress) => void,
    ): Promise<boolean> {
        if (this.active)
            throw new ConnectionFailure('policy', 'A connection is already in progress.');
        if (!transport.cancelConnect)
            throw new ConnectionFailure(
                'policy',
                'This transport needs an update before connection cancellation is available.',
            );
        let finish!: () => void;
        const run: Run = {
            cancelled: false,
            attemptId: '',
            transport,
            finished: new Promise<void>((resolve) => {
                finish = resolve;
            }),
            finish: () => finish(),
            progress,
            attempt: 0,
        };
        this.active = run;
        const options = { ...input };
        try {
            while (!run.cancelled) {
                run.attempt++;
                run.attemptId = this.newId();
                run.cleanup = undefined;
                progress({
                    state: 'attempting',
                    attempt: run.attempt,
                    message: `Connecting via SSH (attempt ${run.attempt})…`,
                });
                try {
                    await transport.connect(options, run.attemptId);
                    if (run.cancelled) {
                        run.cleanup ??= transport.cancelConnect(run.attemptId);
                        await run.cleanup;
                        return false;
                    }
                    progress({
                        state: 'connected',
                        attempt: run.attempt,
                        message: 'SSH authenticated.',
                    });
                    return true;
                } catch (error) {
                    const failure = connectionFailure(error);
                    // Cleanup must finish before retry delay starts, including ambiguous gateway results.
                    run.cleanup ??= transport.cancelConnect(run.attemptId);
                    try {
                        await run.cleanup;
                    } catch {
                        throw new ConnectionFailure('cleanup', CONNECTION_FAILURE_MESSAGES.cleanup);
                    }
                    run.attemptId = '';
                    if (run.cancelled || failure.code === 'cancelled') return false;
                    if (failure.code !== 'network') {
                        progress({
                            state: 'paused',
                            attempt: run.attempt,
                            message: failure.message,
                        });
                        throw failure;
                    }
                    progress({
                        state: 'waiting',
                        attempt: run.attempt,
                        message: 'SSH connection failed. Retrying in 3 seconds…',
                    });
                    await new Promise<void>((resolve) => {
                        const timer = this.timers.set(() => {
                            run.wake = undefined;
                            resolve();
                        }, 3000);
                        run.wake = () => {
                            this.timers.clear(timer);
                            run.wake = undefined;
                            resolve();
                        };
                        if (run.cancelled) run.wake();
                    });
                }
            }
            return false;
        } finally {
            options.password = undefined;
            options.passphrase = undefined;
            options.privateKey = undefined;
            if (run.cancelled)
                progress({
                    state: 'cancelled',
                    attempt: run.attempt,
                    message: 'Connection cancelled.',
                });
            if (this.active === run) this.active = undefined;
            run.finish();
        }
    }
}
