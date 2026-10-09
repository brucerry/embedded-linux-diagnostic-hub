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

    get isCollecting(): boolean {
        return this.running;
    }

    get isConnected(): boolean {
        return this.session.isConnected;
    }

    get isTesting() {
        return this.session.isTesting;
    }
    discoverTests() {
        return this.session.discoverTests();
    }
    prepareTests(profile: unknown) {
        return this.session.prepareTests(profile);
    }
    startTests(request: unknown) {
        if (this.running) throw Error('Wait for collection to finish.');
        return this.session.startTests(request);
    }
    readTestRun() {
        return this.session.readTestRun();
    }
    cancelTests(id: unknown) {
        return this.session.cancelTests(id);
    }
    cancelTestWork() {
        return this.session.cancelTestWork();
    }
    confirmTest(request: unknown) {
        return this.session.confirmTest(request);
    }
    clearTestData() {
        this.session.clearTestData();
    }

    async configure(
        options: ConnectOptions,
        verify: (key: string) => Promise<boolean>,
        key?: Buffer,
    ): Promise<void> {
        if (this.running) throw new Error('Wait for the current collection to finish.');
        if (this.isTesting)
            throw Error(
                'Cancel the active tests and wait for cleanup before connecting another target.',
            );
        this.clear();
        await this.session.connect(options, verify, key);
    }

    async collect(): Promise<Snapshot> {
        if (this.running) throw new Error('A collection is already running.');
        if (!this.session.isConnected) throw new Error('Connect to a target device first.');
        this.running = true;
        try {
            return await this.session.collect();
        } finally {
            this.running = false;
        }
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
