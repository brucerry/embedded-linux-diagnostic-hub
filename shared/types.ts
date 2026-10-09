export type Category =
    'system' | 'memory' | 'storage' | 'network' | 'processes' | 'services' | 'logs' | 'hardware';
export type ResultStatus = 'collected' | 'unavailable' | 'error';

export interface Probe {
    id: string;
    title: string;
    category: Category;
    description: string;
    command: string;
}

export interface ProbeResult {
    id: string;
    command?: string;
    status: ResultStatus;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    collectedAt: string;
    truncated: boolean;
}

export interface Snapshot {
    schemaVersion: 1;
    mode: 'demo' | 'ssh';
    endpoint: string;
    username: string;
    capturedAt: string;
    results: ProbeResult[];
}

export interface ConnectOptions {
    host: string;
    port: number;
    username: string;
    auth: 'password' | 'key';
    password?: string;
    passphrase?: string;
    privateKey?: string;
    expectedFingerprint?: string;
}

export interface HostKeyVerification {
    id: string;
    endpoint: string;
    received: string;
    saved?: string;
}

export interface DesktopBridge extends Partial<import('./terminal').TerminalTransport> {
    checkUpdates(includePrereleases: boolean): Promise<UpdateStatus>;
    startUpdate(request: UpdateRequest): Promise<void>;
    readUpdateReport(): Promise<UpdateRecovery | null>;
    acknowledgeUpdateReport(id: string): Promise<void>;
    clearSessionData(): Promise<void>;
    onUpdateProgress?(callback: (progress: string) => void): () => void;
    onHostKeyVerification?(callback: (request: HostKeyVerification | null) => void): () => void;
    confirmHostKey?(id: string, accepted: boolean): Promise<boolean>;
    connect(options: ConnectOptions): Promise<void>;
    disconnect(): Promise<void>;
    collect(): Promise<Snapshot>;
    readDeviceClock?(): Promise<import('./diagnostics/device-clock').DeviceClockResponse>;
    pickKey(): Promise<string | null>;
    copyText(command: string): Promise<void>;
    readClipboard?(): Promise<string>;
    openRepository(): Promise<void>;
    openReleases(): Promise<void>;
    exportReport(importedSnapshot?: Snapshot): Promise<boolean>;
    onDisconnected(callback: (reason?: 'update') => void): () => void;
}

export type UpdateMode = 'clean' | 'preserve' | 'smart';

export interface UpdateRequest {
    mode: UpdateMode;
    snapshot?: Snapshot;
}

export interface UpdateRecovery {
    id: string;
    mode: 'preserve' | 'smart';
    reportPath: string;
    snapshot?: Snapshot;
}

export interface UpdateStatus {
    currentVersion: string;
    installable: boolean;
    readyPath?: string;
    release: {
        version: string;
        prerelease: boolean;
        publishedAt: string;
        notes: string;
    } | null;
}

declare global {
    interface Window {
        diagnosticHub?: DesktopBridge;
    }
}
