import { randomUUID } from 'node:crypto';
// One trusted renderer owns the lease. Minimize is eligible; suspend invalidates it.
export class AutomationActivity {
    private lease = '';
    private suspended = false;
    constructor(
        private throttle: (enabled: boolean) => void,
        private notify: (reason: string) => void,
        private blocked: () => boolean,
    ) {}
    acquire(): string {
        if (this.suspended || this.blocked())
            throw Error('Automation is unavailable during sleep or update.');
        if (this.lease) throw Error('Automation already owns background execution.');
        this.lease = randomUUID();
        this.throttle(false);
        return this.lease;
    }
    release(id: unknown) {
        if (typeof id === 'string' && id === this.lease) this.clear();
    }
    clear() {
        this.lease = '';
        this.throttle(true);
    }
    interrupt(reason: string) {
        const active = Boolean(this.lease);
        this.clear();
        if (active) this.notify(reason);
    }
    suspend() {
        this.suspended = true;
        this.interrupt('System slept. Arm explicitly to resume.');
    }
    resume() {
        this.suspended = false;
    }
}
