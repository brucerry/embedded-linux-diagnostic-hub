import type { CollectOptions } from '../../shared/diagnostics/network/evidence';
import type { ConnectOptions, Snapshot } from '../../shared/types';
import { SshSession } from './session';
import type { TerminalEvent, TerminalOpen } from '../../shared/terminal';

// Reuse one authenticated SSH connection until explicit disconnect or app closure.
export class DeviceMonitor {
    private running = false;
    private session: SshSession;

    constructor(onDisconnected: () => void = () => {}) {
        this.session = new SshSession(onDisconnected);
    }

    get automationConnection() {
        return this.session.automationConnection;
    }
    runAutomation(request: import('../../shared/automation').AutomationRequest) {
        return this.session.runAutomation(request);
    }
    cancelAutomation(id: string, connection: string) {
        this.session.cancelAutomation(id, connection);
    }
    get isCollecting(): boolean {
        return this.running;
    }

    get isConnected(): boolean {
        return this.session.isConnected;
    }

    async configure(
        options: ConnectOptions,
        verify: (key: string) => Promise<boolean>,
        key?: Buffer,
        signal?: AbortSignal,
    ): Promise<void> {
        if (this.running) throw new Error('Wait for the current collection to finish.');
        this.clear();
        await this.session.connect(options, verify, key, signal);
    }

    async collect(options?: CollectOptions): Promise<Snapshot> {
        if (this.running) throw new Error('A collection is already running.');
        if (!this.session.isConnected) throw new Error('Connect to a target device first.');
        this.running = true;
        try {
            return await this.session.collect(options);
        } finally {
            this.running = false;
        }
    }

    clearNetworkCache(): void {
        this.session.clearNetworkCache();
    }

    clear(): void {
        this.session.disconnect();
    }

    openTerminal(request: TerminalOpen, emit: (event: TerminalEvent) => void) {
        return this.session.openTerminal(request, emit);
    }

    getTerminal(id: unknown) {
        return this.session.getTerminal(id);
    }

    readClock(signal?: AbortSignal) {
        return this.session.readClock(signal);
    }
}
