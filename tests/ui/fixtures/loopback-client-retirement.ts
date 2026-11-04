interface CloseObservable { once(event: 'close', listener: () => void): unknown; }

// Test-fixture custody only. A server close callback is not a client close event.
export function createClientRetirement() {
    const pending = new Map<CloseObservable, Promise<void>>();
    function track(client: CloseObservable): Promise<void> {
        const existing = pending.get(client);
        if (existing) return existing;
        let acknowledge!: () => void;
        const done = new Promise<void>(resolve => { acknowledge = resolve; });
        pending.set(client, done); // Own admission before registering the observer.
        client.once('close', () => {
            if (pending.get(client) !== done) return;
            pending.delete(client);
            acknowledge();
        });
        return done;
    }
    async function join(): Promise<void> {
        while (pending.size) await Promise.all([...pending.values()]);
    }
    return {track, join, get pending() { return pending.size; }};
}

// ssh2.Server exposes address(); unlike net.Server it has no listening property.
export function loopbackListening(server?: { address(): unknown }): boolean {
    return Boolean(server?.address());
}
