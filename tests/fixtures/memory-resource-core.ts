import type { StoredCapture } from '../../shared/capture-store';

/** Bounded evidence from the returned operation; never retain output, headers or byte chunks. */
export function captureDiagnostic(row: { completion: string; stored?: StoredCapture }) {
    const stored = row.stored;
    return {
        completion: row.completion,
        stored: stored
            ? {
                  id: stored.id.slice(0, 64),
                  state: stored.state,
                  committedBytes: stored.committedBytes,
                  observedBytes: stored.observedBytes,
                  failure: stored.failure
                      ? { code: stored.failure.code, message: stored.failure.message.slice(0, 512) }
                      : null,
              }
            : null,
    };
}

/** Test-only ownership receipts. A token ends only after the real disposer acknowledges. */
export class Owners {
    private next = 0;
    private active = new Map<number, { kind: string; label: string; site: string }>();
    take(kind: string, label: string) {
        if (this.active.size >= 256) throw Error('Ownership diagnostic bound exceeded.');
        const id = ++this.next;
        this.active.set(id, { kind, label, site: new Error().stack?.slice(0, 1200) ?? '' });
        let released = false;
        return () => {
            if (!released) {
                released = true;
                this.active.delete(id);
            }
        };
    }
    snapshot() {
        return [...this.active.values()];
    }
    empty(stage: string) {
        if (this.active.size)
            throw Error(`${stage}: unsettled owners ${JSON.stringify(this.snapshot())}`);
    }
    async join<T>(kind: string, label: string, task: () => Promise<T>) {
        const release = this.take(kind, label);
        try {
            return await task();
        } finally {
            release();
        }
    }
}
export function argumentsOf(values: string[]) {
    return new Map(
        values.map((value): [string, string] => {
            const [key, ...rest] = value.replace(/^--/, '').split('=');
            return [key, rest.join('=')];
        }),
    );
}

export type Memory = {
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    rss: number;
};
export function assertMemorySample(value: Memory) {
    for (const key of ['heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'rss'] as const)
        if (!Number.isSafeInteger(value?.[key]) || value[key] < 0)
            throw Error(`Missing or invalid required memory metric: ${key}`);
}
export const provisional = { heapUsed: 8 * 1024 ** 2, arrayBuffers: 2 * 1024 ** 2 };
export const median = (values: number[]) => {
    const ordered = [...values].sort((a, b) => a - b);
    if (!ordered.length) throw Error('Missing memory samples.');
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
export function trend(values: number[]) {
    if (values.length < 3) throw Error('Need at least three comparable closed cycles.');
    const x = (values.length - 1) / 2;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    let numerator = 0,
        denominator = 0;
    for (const [index, value] of values.entries()) {
        numerator += (index - x) * (value - average);
        denominator += (index - x) ** 2;
    }
    return {
        firstMedian: median(values.slice(0, 3)),
        lastMedian: median(values.slice(-3)),
        medianDelta: median(values.slice(-3)) - median(values.slice(0, 3)),
        bytesPerCycle: numerator / denominator,
    };
}
export function retained(baseline: Memory, samples: Memory[], ceilings = provisional) {
    assertMemorySample(baseline);
    samples.forEach(assertMemorySample);
    const metrics = Object.fromEntries(
        (['heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'rss'] as const).map((key) => [
            key,
            {
                ...trend(samples.map((s) => s[key])),
                maxDelta: Math.max(...samples.map((s) => s[key] - baseline[key])),
            },
        ]),
    );
    for (const key of ['heapUsed', 'arrayBuffers'] as const)
        for (const [cycle, sample] of samples.entries())
            if (sample[key] - baseline[key] > ceilings[key])
                throw Error(
                    `retained-${key}: cycle ${cycle + 1}, delta ${sample[key] - baseline[key]}, ceiling ${ceilings[key]}`,
                );
    return metrics;
}

/** Test factories/acknowledgements, never a product debug IPC API. */
export interface ViewerQualificationHook {
    exercise(context: { ordinal: number; reducedMotion: boolean }): Promise<string[]>;
    snapshot(): Promise<Record<string, number>>;
    dispose(): Promise<void>;
}
export const soakCoverage = [
    'run-success',
    'run-repeat-delay',
    'cancel-start',
    'cancel-write',
    'cancel-append',
    'cancel-seal',
    'cancel-outcome',
    'quota-before-begin',
    'quota-append',
    'timeout',
    'owner-loss',
    'same-generation-rearm',
    'stale-generation',
    'connect-disconnect',
    'pending-open',
    'blocked-write',
    'server-loss',
    'client-loss',
    'manual-pty-separate',
    'stdout-stderr',
    'transport-switch',
    'page-switch-active',
    'hide-show',
    'unmount-remount',
    'reload',
    'versionchange',
    'large-slow-capture',
    'search-page-offscreen-selection',
    'export-json',
    'export-csv',
    'export-markdown',
    'export-text',
    'export-cancel',
    'export-failure',
    'clear-reopen',
    'constant-catalog',
    'bounded-growing-catalog',
] as const;
export const viewerCoverage = [
    'viewer-open-close-live',
    'viewer-pointer-keyboard',
    'viewer-reduced-motion',
    'viewer-svg',
    'viewer-png',
    'viewer-pdf',
    'viewer-export-cancel-failure',
    'viewer-unmount',
] as const;
export const ownerKinds = [
    'producer',
    'channel',
    'writer',
    'reader',
    'pin',
    'export',
    'ack',
    'rpc',
    'httpReader',
    'queuedInput',
    'cleanup',
    'listenerDelta',
    'timerDelta',
    'databaseConnectionDelta',
] as const;
export const viewerOwnerKinds = [
    'listenerDelta',
    'timerDelta',
    'raf',
    'observer',
    'pointerCapture',
    'worker',
    'canvas',
    'blobUrl',
    'pdfWindow',
] as const;
export interface QualificationDriver {
    versions: Record<string, string>;
    capabilities: { supported: string[]; unsupported: Record<string, string> };
    memoryScope?: {
        roles: string[];
        runtimeIdentity: unknown;
        unsupported: Record<string, string>;
    };
    cycle(context: {
        phase: 'warmup' | 'measured';
        ordinal: number;
        payloadBytes: number;
        catalogMode: 'constant' | 'growing';
    }): Promise<{
        coverage: string[];
        capturedBytes: number;
        exportedBytes: number;
        diskBytes: number | null;
        diskRecords: number;
        cache: Record<string, number | string>;
    }>;
    /** Stable PID + creation time. Bytes only; unavailable metrics are null with a reason. */
    sampleProcesses(context?: { quiescent: boolean; forceGc: boolean }): Promise<
        {
            pid: number;
            created: string;
            role: string;
            state: 'running' | 'terminated';
            rssBytes: number | null;
            heapUsedBytes: number | null;
            externalBytes: number | null;
            arrayBuffersBytes: number | null;
            unsupported: string[];
        }[]
    >;
    snapshotOwners(stage: string): Promise<Record<string, number>>;
    /** Independent owned OS PID/creation histories; safe during/after actual teardown, no CDP/RPC/GC. */
    sampleShutdownProcesses?(): ReturnType<QualificationDriver['sampleProcesses']>;
    teardown(): Promise<void>;
    assertDescendantsExited(): Promise<void>;
    preflightGc?(): Promise<unknown>;
}
