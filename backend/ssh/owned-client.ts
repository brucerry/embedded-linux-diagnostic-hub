import {
    Client,
    type ClientChannel,
    type ConnectConfig,
    type ClientCallback,
    type ExecOptions,
    type PseudoTtyOptions,
    type ShellOptions,
} from 'ssh2';

/** Tracks callback/channel/transport settlement, not the public connected/closing flag. */
export class SshConnectionOwners {
    private transportClosed = false;
    private channels = new Set<ClientChannel>();
    private opening = new Set<object>();
    private released = false;
    private unknownStart: Error | undefined;
    private resolve!: () => void;
    private reject!: (error: Error) => void;
    private done = new Promise<void>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
    });
    constructor() {
        void this.done.catch(() => {});
    }
    transportDidClose() {
        this.transportClosed = true;
        this.settle();
    }
    noTransportWasCreated() {
        this.transportClosed = true;
        this.settle();
    }
    startIsUnverified(error: Error) {
        this.unknownStart = error;
        this.reject(error);
    }
    private settle() {
        if (
            !this.unknownStart &&
            this.transportClosed &&
            !this.channels.size &&
            !this.opening.size
        ) {
            this.released = true;
            this.resolve();
        }
    }
    /** The exact callback is still pending after cancellation until the library invokes it. */
    open(
        invoke: (callback: (...values: unknown[]) => void) => Client,
        callback: (...values: unknown[]) => void,
    ) {
        if (this.transportClosed || this.released || this.unknownStart)
            throw Error('This SSH connection is closed or its ownership is unverified.');
        const token = {};
        this.opening.add(token);
        let called = false;
        const opened = (...values: unknown[]) => {
            if (called) throw Error('SSH channel opening callback was invoked twice.');
            called = true;
            const channel = values[1] as ClientChannel | undefined;
            if (channel) {
                this.channels.add(channel);
                channel.once('close', () => {
                    this.channels.delete(channel);
                    this.settle();
                });
            }
            this.opening.delete(token);
            this.settle();
            callback(...values);
        };
        try {
            return invoke(opened);
        } catch (error) {
            if (!called) this.opening.delete(token);
            this.settle();
            throw error;
        }
    }
    async join() {
        if (this.unknownStart) throw this.unknownStart;
        await this.done;
    }
    get snapshot() {
        return {
            transport: this.transportClosed ? 0 : 1,
            channels: this.channels.size,
            opening: this.opening.size,
            cleanup: this.released ? 0 : 1,
            unknownStart: this.unknownStart ? 1 : 0,
        };
    }
}

/** Retains ssh2's public method overloads and observes the original callbacks unchanged. */
export class OwnedSshClient extends Client {
    readonly owners = new SshConnectionOwners();
    private started = false;
    constructor() {
        super();
        this.once('close', () => this.owners.transportDidClose());
    }
    override connect(config: ConnectConfig): this {
        if (this.started) throw Error('This owned SSH connection has already been started.');
        this.started = true;
        try {
            return super.connect(config);
        } catch (error) {
            // ssh2 initializes this own slot in its constructor and allocates it only after
            // synchronous key/options validation. Missing/changed layout is unknown, never zero.
            const state = this as unknown as Record<string, unknown>;
            if (Object.hasOwn(state, '_sock') && state._sock === undefined)
                this.owners.noTransportWasCreated();
            else
                this.owners.startIsUnverified(
                    Error('Failed SSH start transport closure is unverified.', { cause: error }),
                );
            throw error;
        }
    }
    private channelCall(method: 'exec' | 'shell', args: unknown[]) {
        const callback = args.at(-1);
        if (typeof callback !== 'function') throw Error('SSH channel callback is required.');
        return this.owners.open(
            (opened) => {
                const actual = [...args.slice(0, -1), opened];
                return Reflect.apply(Client.prototype[method], this, actual) as Client;
            },
            callback as (...values: unknown[]) => void,
        );
    }
    override exec(command: string, options: ExecOptions, callback: ClientCallback): this;
    override exec(command: string, callback: ClientCallback): this;
    override exec(...args: unknown[]): this {
        this.channelCall('exec', args);
        return this;
    }
    override shell(
        window: PseudoTtyOptions | false,
        options: ShellOptions,
        callback: ClientCallback,
    ): this;
    override shell(window: PseudoTtyOptions | false, callback: ClientCallback): this;
    override shell(options: ShellOptions, callback: ClientCallback): this;
    override shell(callback: ClientCallback): this;
    override shell(...args: unknown[]): this {
        this.channelCall('shell', args);
        return this;
    }
}
