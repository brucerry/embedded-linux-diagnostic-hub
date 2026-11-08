import type { Client, ClientChannel, ServerChannel } from 'ssh2';

type Row = {
    sequence: number;
    event: string;
    channel?: number;
    hostChannels?: number;
    hostOpening?: number;
    hostProducers?: number;
    hostStates?: number;
    serverActive?: number;
};
const events = new Set([
    'server-close-request',
    'server-close',
    'client-close-request',
    'client-close',
    'checkpoint',
    'before-passive-wait',
    'after-passive-wait',
    'server-acknowledged',
]);

/** Test-only passive observations. No commands, outputs, paths, IDs or arbitrary error text. */
export class SshCloseObservation {
    private rows: Row[] = [];
    private overflow = false;
    private bytes = 128;
    private clients = new WeakSet<Client>();
    private serverPending = 0;
    private serial = 0;
    private wake = new Set<() => void>();
    private restore: (() => void)[] = [];
    record(event: string, values: Omit<Row, 'sequence' | 'event'> = {}) {
        if (!events.has(event)) throw Error('Unrecognized fixed trace event.');
        for (const [name, value] of Object.entries(values))
            if (
                ![
                    'channel',
                    'hostChannels',
                    'hostOpening',
                    'hostProducers',
                    'hostStates',
                    'serverActive',
                ].includes(name) ||
                !Number.isSafeInteger(value) ||
                value < 0 ||
                value > 128
            )
                throw Error('Invalid bounded trace counter.');
        const row = { sequence: this.rows.length + 1, event, ...values };
        const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
        if (this.rows.length >= 128 || this.bytes + size > 16384) {
            this.overflow = true;
            return;
        }
        this.rows.push(row);
        this.bytes += size;
    }
    private channel(channel: ClientChannel | ServerChannel, side: 'client' | 'server') {
        const ordinal = ++this.serial;
        if (side === 'server') this.serverPending++;
        const original = channel.close;
        const wrapped = () => {
            this.record(side + '-close-request', { channel: ordinal });
            return original.call(channel);
        };
        channel.close = wrapped;
        const close = () => {
            this.record(side + '-close', { channel: ordinal });
            if (side === 'server') {
                this.serverPending--;
                for (const wake of this.wake) wake();
            }
        };
        channel.once('close', close);
        this.restore.push(() => {
            if (channel.close === wrapped) channel.close = original;
            channel.off('close', close);
        });
    }
    server(channel: ServerChannel) {
        this.channel(channel, 'server');
    }
    client(client: Client) {
        if (this.clients.has(client)) return;
        this.clients.add(client);
        const original = client.exec,
            trace = this;
        const wrapped = function (this: Client, ...args: unknown[]) {
            const callback = args.at(-1);
            if (typeof callback !== 'function') throw Error('Expected owned exec callback.');
            return Reflect.apply(original, this, [
                ...args.slice(0, -1),
                (...values: unknown[]) => {
                    if (values[1]) trace.channel(values[1] as ClientChannel, 'client');
                    return Reflect.apply(callback, undefined, values);
                },
            ]);
        } as typeof client.exec;
        client.exec = wrapped;
        this.restore.push(() => {
            if (client.exec === wrapped) client.exec = original;
        });
    }
    async waitServerClose(timeoutMs = 1000): Promise<boolean> {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000)
            throw Error('Invalid server observation deadline.');
        if (!this.serverPending) return true;
        return new Promise((resolve) => {
            const finish = (closed: boolean) => {
                clearTimeout(timer);
                this.wake.delete(check);
                resolve(closed);
            };
            const check = () => {
                if (!this.serverPending) finish(true);
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            this.wake.add(check);
            check();
        });
    }
    snapshot() {
        return {
            rows: this.rows.map((row) => ({ ...row })),
            overflow: this.overflow,
            serverPending: this.serverPending,
        };
    }
    dispose() {
        for (const restore of this.restore.reverse()) restore();
        this.restore = [];
    }
}
