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
    networkEvidence?: import('./diagnostics/network/evidence').NetworkEvidence;
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

export interface DesktopBridge
    extends
        Partial<import('./terminal').TerminalTransport>,
        Partial<import('./serial').SerialDesktopBridge>,
        Partial<import('./automation').AutomationTransport> {
    captureStorage?: import('./capture-rpc').CaptureRpcTransport;
    consoleStorage?: import('./console-archive-rpc').ConsoleArchiveRpc;
    acquireAutomationActivity?(): Promise<string>;
    releaseAutomationActivity?(id: string): Promise<void>;
    onAutomationInterrupted?(callback: (reason: string) => void): () => void;
    onWindowRestored?(callback: () => void): () => void;
    checkUpdates(includePrereleases: boolean): Promise<UpdateStatus>;
    startUpdate(request: UpdateRequest): Promise<void>;
    readUpdateReport(): Promise<UpdateRecovery | null>;
    acknowledgeUpdateReport(id: string): Promise<void>;
    clearSessionData(): Promise<void>;
    onUpdateProgress?(callback: (progress: UpdateProgress | string) => void): () => void;
    readUpdateInfo?(): Promise<UpdateInfo>;
    openUpdateFolder?(target: 'current' | 'verified'): Promise<void>;
    copyUpdatePath?(target: 'current' | 'verified'): Promise<void>;
    onHostKeyVerification?(callback: (request: HostKeyVerification | null) => void): () => void;
    confirmHostKey?(id: string, accepted: boolean): Promise<boolean>;
    connect(options: ConnectOptions, attemptId?: string): Promise<void>;
    cancelConnect?(attemptId: string): Promise<void>;
    disconnect(): Promise<void>;
    collect(options?: import('./diagnostics/network/evidence').CollectOptions): Promise<Snapshot>;
    readDeviceClock?(
        connection?: string,
    ): Promise<import('./diagnostics/device-clock').DeviceClockResponse>;
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

export interface UpdateProgress {
    stage: 'preparing' | 'download' | 'verify' | 'install' | 'handoff' | 'failed';
    message: string;
    receivedBytes?: number;
    totalBytes?: number;
    stagingPath?: string;
    verifiedPath?: string;
}
export interface UpdateReceipt {
    previousVersion: string;
    version: string;
    executable: string;
    hash: string;
    state: 'verified' | 'restart-requested' | 'restart-failed' | 'confirmed';
    updatedAt: string;
}
export interface UpdateInfo {
    installation?: {
        id: string;
        layout: import('./installation').InstalledLayout;
        profilePath: string;
        payloadIntegrity: 'not-checked';
        automaticUpdateQualified: false;
    };
    currentVersion: string;
    currentPath: string | null;
    receipt: UpdateReceipt | null;
    handoffConfirmed: boolean;
}
export interface UpdateStatus {
    currentVersion: string;
    installable: boolean;
    readyPath?: string;
    installationUnavailableReason?: string;
    manualUpdate?: {
        platform: 'darwin';
        architecture: 'x64' | 'arm64';
        defaultDestination: string;
        verificationCommand: string;
    };
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
