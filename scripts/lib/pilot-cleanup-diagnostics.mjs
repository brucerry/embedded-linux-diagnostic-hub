/** Data-only observations; never a cleanup or release capability. */
export const cleanupDiagnosticLimits = Object.freeze({
    bytes: 8192,
    depth: 8,
    nodes: 64,
    keys: 16,
    items: 8,
    string: 512,
    rows: 16,
    pendingBytes: 65536,
});
const unavailable = '[unavailable accessor or reflection]';
// Fixed cleanup schemas only: never enumerate an arbitrary error/reply's key set.
const diagnosticFields = Object.freeze([
    'name',
    'message',
    'code',
    'disposer',
    'cause',
    'errors',
    'cleanup',
    'role',
    'pid',
    'created',
    'phase',
    'shutdown',
    'beforeReleaseObservation',
    'release',
    'firstFailure',
    'termination',
    'actualExit',
    'pipeClose',
    'outcome',
    'connected',
    'started',
    'pendingRequest',
    'releaseAuthorized',
    'resources',
    'stage',
    'processes',
    'state',
    'signal',
    'kind',
    'error',
    'verified',
    'ipcMessageListeners',
    'ipcDisconnectListeners',
    'timers',
    'timerDelta',
    'clients',
    'channels',
    'pumps',
    'httpRequests',
    'httpSockets',
    'server',
    'rssBytes',
    'heapUsedBytes',
    'externalBytes',
    'arrayBuffersBytes',
    'unsupported',
    'before',
    'after',
    'serialJoinInvoked',
    'repositoryJoined',
    'runnerJoins',
    'scope',
    'opens',
    'closes',
    'sent',
    'writes',
    'generation',
    'stalled',
    'promptHeld',
    'produced',
    'readerActive',
    'writerActive',
    'pumping',
    'remaining',
    'promptPending',
    'heldOpen',
    'heldWrite',
    'events',
    'stack',
]);

function field(value, key) {
    if (value === null || !['object', 'function'].includes(typeof value)) return undefined;
    try {
        const d = Object.getOwnPropertyDescriptor(value, key);
        return d ? ('value' in d ? d.value : unavailable) : undefined;
    } catch {
        return unavailable;
    }
}
/** No getters, toJSON, iterators, or user toString calls. All output is fresh plain data. */
export function boundedCleanupDiagnostic(input) {
    let remaining = 7168,
        nodes = 0;
    const seen = new Set();
    const text = (value) => {
        const clipped = value.slice(0, cleanupDiagnosticLimits.string);
        const cost = Buffer.byteLength(JSON.stringify(clipped)) + 16;
        if (cost > remaining) return '[byte limit]';
        remaining -= cost;
        return clipped + (value.length > clipped.length ? '[truncated]' : '');
    };
    const copy = (value, depth) => {
        if (++nodes > cleanupDiagnosticLimits.nodes || remaining < 128) return '[budget limit]';
        remaining -= 16;
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value === 'string') return text(value);
        if (typeof value === 'number') return Number.isFinite(value) ? value : '[nonfinite]';
        if (typeof value !== 'object') return '[' + typeof value + ']';
        if (seen.has(value)) return '[cycle]';
        if (depth >= cleanupDiagnosticLimits.depth) return '[depth limit]';
        seen.add(value);
        try {
            if (Array.isArray(value)) {
                const length = field(value, 'length');
                if (!Number.isSafeInteger(length)) return unavailable;
                const result = [];
                for (let i = 0; i < Math.min(length, cleanupDiagnosticLimits.items); i++)
                    result.push(copy(field(value, String(i)), depth + 1));
                if (length > result.length) result.push('[items truncated: ' + length + ']');
                return result;
            }
            const result = Object.create(null);
            // Error fields precede stack/context so nested causes get the remaining budget first.
            const keys = diagnosticFields.filter((key) => field(value, key) !== undefined);
            let name = field(value, 'name');
            if (name === undefined && field(value, 'message') !== undefined) {
                let proto = value;
                for (let i = 0; i < 3 && name === undefined; i++) {
                    proto = Object.getPrototypeOf(proto);
                    if (!proto) break;
                    name = field(proto, 'name');
                }
                if (name !== undefined) result.name = copy(name, depth + 1);
            }
            for (const key of keys.slice(0, cleanupDiagnosticLimits.keys)) {
                if (remaining < 128) {
                    result.truncated = '[byte limit]';
                    break;
                }
                remaining -= Buffer.byteLength(JSON.stringify(key.slice(0, 64))) + 8;
                result[key.slice(0, 64)] = copy(field(value, key), depth + 1);
            }
            if (keys.length > cleanupDiagnosticLimits.keys) result.truncatedKeys = keys.length;
            return result;
        } catch {
            return unavailable;
        }
    };
    try {
        const result = copy(input, 0);
        return Buffer.byteLength(JSON.stringify(result)) <= cleanupDiagnosticLimits.bytes
            ? result
            : { unavailable: 'Diagnostic byte limit' };
    } catch {
        return { unavailable: 'Diagnostic serialization failed' };
    }
}
export function cleanupErrorReason(error) {
    const message = field(error, 'message');
    return typeof message === 'string'
        ? message.slice(0, 512)
        : typeof error === 'string'
          ? error.slice(0, 512)
          : 'Cleanup failure; see bounded error';
}
export function namedCleanupFailure(disposer, cause, cleanup) {
    const error = new Error(disposer + ': ' + cleanupErrorReason(cause), { cause });
    error.name = 'CleanupDisposerError';
    error.disposer = disposer;
    if (cleanup !== undefined) error.cleanup = boundedCleanupDiagnostic(cleanup);
    return error;
}
export function cleanupHostReply(value) {
    return boundedCleanupDiagnostic({ resources: field(value, 'resources') });
}
/** Queue only fixed, bounded observations. Independent disposers never await this transport. */
export function cleanupDiagnostics(emit) {
    const pending = [],
        errors = [];
    let bytes = 0,
        rows = 0;
    return {
        note(stage, data) {
            try {
                const bounded = boundedCleanupDiagnostic(data),
                    size = Buffer.byteLength(JSON.stringify({ stage, data: bounded }));
                if (
                    rows >= cleanupDiagnosticLimits.rows ||
                    bytes + size > cleanupDiagnosticLimits.pendingBytes
                )
                    throw Error('Cleanup diagnostic queue limit');
                rows++;
                bytes += size;
                pending.push(
                    Promise.resolve(emit(stage, bounded)).catch((error) => {
                        if (errors.length < 8) errors.push(error);
                    }),
                );
            } catch (error) {
                if (errors.length < 8) errors.push(error);
            }
        },
        async drain() {
            await Promise.all(pending);
            if (errors.length)
                throw new AggregateError(errors, 'Cleanup diagnostic publication failed');
        },
    };
}
