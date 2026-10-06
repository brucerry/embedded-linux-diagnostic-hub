import { randomUUID } from 'node:crypto';
import type { HostKeyVerification } from '../shared/types';

// Approval belongs to one handshake; expired or stale UI replies cannot trust a later key.
export class HostVerification {
    private pending: { id: string; finish: (accepted: boolean) => void } | null = null;

    constructor(
        private readonly notify: (request: HostKeyVerification | null) => void,
        private readonly timeoutMs = 45_000,
    ) {}

    request(endpoint: string, received: string, saved?: string): Promise<boolean> {
        this.clear();
        const id = randomUUID();
        return new Promise((resolve) => {
            const timer = setTimeout(() => finish(false), this.timeoutMs);
            const finish = (accepted: boolean) => {
                clearTimeout(timer);
                this.pending = null;
                this.notify(null);
                resolve(accepted);
            };
            this.pending = { id, finish };
            this.notify({ id, endpoint, received, saved });
        });
    }

    confirm(id: unknown, accepted: unknown): boolean {
        if (typeof id !== 'string' || typeof accepted !== 'boolean' || this.pending?.id !== id)
            return false;
        this.pending.finish(accepted);
        return true;
    }

    clear(): void {
        this.pending?.finish(false);
    }
}
