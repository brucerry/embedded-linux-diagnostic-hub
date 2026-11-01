export type LaunchClockDomain = 'main-module-body' | 'renderer-navigation';

export interface LaunchTimingSnapshot {
    schema: 1;
    clockDomain: LaunchClockDomain;
    milestones: { name: string; elapsedMs: number }[];
}

export interface LaunchTimingRecorder {
    mark(name: string, timestampMs?: number): void;
    snapshot(): LaunchTimingSnapshot;
}

/**
 * One clock domain per recorder. The caller supplies a monotonic clock and may
 * supply an origin from that SAME clock. No timers, transport, storage or logging.
 * First occurrence wins; at most 32 short names are retained.
 */
export function createLaunchTimingRecorder(
    clockDomain: LaunchClockDomain,
    now: () => number,
    originMs?: number,
): LaunchTimingRecorder {
    let origin = originMs;
    if (origin === undefined) {
        try {
            origin = now();
        } catch {
            origin = NaN;
        }
    }
    const baseline = origin ?? NaN;
    const milestones: LaunchTimingSnapshot['milestones'] = [];
    return {
        mark(name, timestampMs) {
            if (
                milestones.length >= 32 ||
                typeof name !== 'string' ||
                name.length === 0 ||
                name.length > 80 ||
                milestones.some((entry) => entry.name === name)
            )
                return;
            // Instrumentation must not turn a clock failure into an app failure.
            try {
                const elapsedMs = (timestampMs ?? now()) - baseline;
                if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
                milestones.push({ name, elapsedMs });
            } catch {
                // Missing evidence is not a zero-duration measurement.
            }
        },
        snapshot() {
            return {
                schema: 1,
                clockDomain,
                milestones: milestones.map((entry) => ({ ...entry })),
            };
        },
    };
}
