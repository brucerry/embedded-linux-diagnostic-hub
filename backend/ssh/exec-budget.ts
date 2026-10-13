export interface SlotOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}
export class ExecSlots {
    private active = 0;
    private waiters: (() => void)[] = [];
    async run<T>(work: () => Promise<T>, options: SlotOptions = {}): Promise<T> {
        if (options.signal?.aborted) throw Error('Queued diagnostic cancelled.');
        if (this.active >= 3)
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const cleanup = () => {
                    clearTimeout(timer);
                    options.signal?.removeEventListener('abort', aborted);
                };
                const wake = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve();
                };
                const fail = (message: string) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    const index = this.waiters.indexOf(wake);
                    if (index >= 0) this.waiters.splice(index, 1);
                    reject(Error(message));
                };
                const aborted = () => fail('Queued diagnostic cancelled.');
                const timer = setTimeout(
                    () => fail('Diagnostic queue timed out within its collection deadline.'),
                    options.timeoutMs ?? 12000,
                );
                this.waiters.push(wake);
                options.signal?.addEventListener('abort', aborted, { once: true });
                if (options.signal?.aborted) aborted();
            });
        else this.active++;
        try {
            if (options.signal?.aborted) throw Error('Queued diagnostic cancelled.');
            return await work();
        } finally {
            const next = this.waiters.shift();
            if (next) next();
            else this.active--;
        }
    }
}
