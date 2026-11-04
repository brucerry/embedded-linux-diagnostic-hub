const fields = ['started', 'completed', 'timedOut', 'failed', 'pending'] as const;
// Project only the existing module-local ownership getter. Never expose command/result data.
export function projectProbeObservation(owners: unknown) {
    if (!Array.isArray(owners) || !owners.length || owners.length > 128) return null;
    const total = {started: 0, completed: 0, timedOut: 0, failed: 0, pending: 0, unproved: false};
    for (const owner of owners) {
        const value = owner?.probeCommands;
        if (!value || typeof value.unproved !== 'boolean' || fields.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 65535)) return null;
        total.unproved ||= value.unproved;
        for (const key of fields) {
            if (total[key] + value[key] > 65535) total.unproved = true;
            total[key] = Math.min(65535, total[key] + value[key]);
        }
    }
    if (total.started !== total.completed + total.timedOut + total.failed + total.pending) total.unproved = true;
    return total;
}
