// Fixed local test-adapter counters only. No command, result, channel or identifier is retained.
export type ProbeDisposition = 'completed' | 'timedOut' | 'failed';
export class ProbeObservation {
    private counts = {started: 0, completed: 0, timedOut: 0, failed: 0, pending: 0, unproved: false};
    constructor(private readonly limit = 65535) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65535) throw Error('Invalid observation bound.');
    }
    private increment(key: 'started' | ProbeDisposition | 'pending') {
        if (this.counts[key] === this.limit) this.counts.unproved = true;
        else this.counts[key]++;
    }
    begin() {
        this.increment('started'); this.increment('pending');
        let settled = false;
        return (disposition: ProbeDisposition) => {
            if (settled) { this.counts.unproved = true; return; }
            settled = true;
            if (!['completed', 'timedOut', 'failed'].includes(disposition)) { this.counts.unproved = true; return; }
            if (this.counts.pending) this.counts.pending--;
            else this.counts.unproved = true;
            this.increment(disposition);
        };
    }
    get snapshot() { return {...this.counts}; }
    unprove() { this.counts.unproved = true; }
}
