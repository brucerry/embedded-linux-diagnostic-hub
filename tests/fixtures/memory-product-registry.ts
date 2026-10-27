/** Private qualification build only. Never imported by the shipping entry. */
export type ProductKind =
    'serial' | 'runner' | 'repository' | 'native-repository' | 'console-journal' | 'gateway';
import { CaptureStorageError } from '../../shared/capture-store';
type Fields = Record<string, unknown>;
type Tracked = { id: number; kind: ProductKind; value: WeakRef<object> };
const tracked: Tracked[] = [];
let sequence = 0;
const tasks = new WeakMap<object, Map<string, Set<number>>>();
export function trackProductTask<T>(
    owner: object,
    kind: 'rpc' | 'httpReader' | 'cleanup',
    task: Promise<T>,
): Promise<T> {
    let record = tasks.get(owner);
    if (!record) {
        record = new Map();
        tasks.set(owner, record);
    }
    let active = record.get(kind);
    if (!active) {
        active = new Set();
        record.set(kind, active);
    }
    const id = ++sequence;
    active.add(id);
    const release = () => {
        active!.delete(id);
    };
    void task.then(release, release);
    return task;
}
type FaultMethod = 'begin' | 'append' | 'seal' | 'record';
type Fault = {
    method: FaultMethod;
    action: 'hold' | 'quota';
    entered: boolean;
    released: boolean;
    release?: () => void;
};
let fault: Fault | undefined;
export const productFaults = {
    arm(method: FaultMethod, action: 'hold' | 'quota') {
        if (fault && !fault.released) throw Error('A private repository fault is already armed.');
        fault = { method, action, entered: false, released: false };
    },
    status() {
        return fault
            ? {
                  method: fault.method,
                  action: fault.action,
                  entered: fault.entered,
                  released: fault.released,
              }
            : null;
    },
    release() {
        if (!fault?.entered || fault.released || !fault.release)
            throw Error('No entered repository gate.');
        fault.release();
        fault.released = true;
    },
    clear() {
        if (fault?.entered && !fault.released && fault.action === 'hold')
            throw Error('Cannot abandon a held repository operation.');
        fault = undefined;
    },
};

export function trackProduct(kind: ProductKind, value: object) {
    // Keep no product object alive merely to inspect it after unmount.
    for (let i = tracked.length - 1; i >= 0; i--)
        if (!tracked[i].value.deref()) tracked.splice(i, 1);
    if (tracked.length >= 256) throw Error('Private product probe inventory exceeded.');
    tracked.push({ id: ++sequence, kind, value: new WeakRef(value) });
    if (kind === 'native-repository' || kind === 'gateway') {
        const row = value as Record<string, (...args: unknown[]) => Promise<unknown>>;
        for (const method of kind === 'native-repository'
            ? ['call']
            : [
                  'request',
                  'connect',
                  'cancelConnect',
                  'disconnect',
                  'openTerminal',
                  'closeTerminal',
              ]) {
            const original = row[method];
            if (typeof original !== 'function')
                throw Error(`Private async boundary missing: ${kind}.${method}`);
            row[method] = function (...args: unknown[]) {
                return trackProductTask(this, 'rpc', original.apply(this, args));
            };
        }
    }
    if (kind === 'repository' || kind === 'native-repository') {
        for (const method of ['begin', 'append', 'seal', 'record'] as const) {
            const instance = value as Record<FaultMethod, (...args: unknown[]) => Promise<unknown>>;
            const original = instance[method];
            if (typeof original !== 'function')
                throw Error(`Repository fault boundary absent: ${method}`);
            instance[method] = async function (...args: unknown[]) {
                const current = fault;
                if (current?.method === method && !current.entered) {
                    current.entered = true;
                    if (current.action === 'quota') {
                        current.released = true;
                        throw new CaptureStorageError(
                            'quota',
                            'Private synthetic repository quota control.',
                        );
                    }
                    await new Promise<void>((resolve) => {
                        current.release = resolve;
                    });
                }
                return original.apply(this, args);
            };
        }
    }
}

export function productInstances(kind: ProductKind): { id: number; value: object }[] {
    return tracked.flatMap((entry) => {
        const value = entry.value.deref();
        return value && entry.kind === kind ? [{ id: entry.id, value }] : [];
    });
}

function fields(value: object, keys: readonly string[]): Fields {
    const row = value as Fields;
    for (const key of keys)
        if (!Object.hasOwn(row, key)) throw Error(`Private product probe field absent: ${key}`);
    return row;
}
const has = (value: unknown) => Number(Boolean(value));
function size(value: unknown, name: string) {
    if (value instanceof Set || value instanceof Map) return value.size;
    if (Array.isArray(value)) return value.length;
    throw Error(`Private product probe collection absent: ${name}`);
}

export function productOwnership() {
    const owners = {
        producer: 0,
        channel: 0,
        writer: 0,
        reader: 0,
        pin: 0,
        export: 0,
        ack: 0,
        rpc: 0,
        httpReader: 0,
        queuedInput: 0,
        cleanup: 0,
    };
    const retained: { id: number; kind: ProductKind; details: Record<string, number | boolean> }[] =
        [];
    for (const entry of tracked) {
        const value = entry.value.deref();
        if (!value) continue;
        owners.rpc += tasks.get(value)?.get('rpc')?.size ?? 0;
        owners.httpReader += tasks.get(value)?.get('httpReader')?.size ?? 0;
        owners.cleanup += tasks.get(value)?.get('cleanup')?.size ?? 0;
        if (entry.kind === 'serial') {
            const row = fields(value, [
                'port',
                'opened',
                'reader',
                'writer',
                'opening',
                'reading',
                'writing',
                'closing',
                'queue',
                'queuedBytes',
                'capture',
                'automationOwner',
                'receiveBusy',
                'listeners',
            ]);
            owners.channel += has(row.port || row.opened);
            owners.reader += has(row.reader) + has(row.reading);
            owners.writer += has(row.writer) + has(row.writing);
            owners.producer += has(row.capture) + has(row.automationOwner) + has(row.receiveBusy);
            owners.queuedInput += size(row.queue, 'serial.queue');
            owners.cleanup += has(row.opening) + has(row.closing);
            retained.push({
                id: entry.id,
                kind: entry.kind,
                details: {
                    listeners: size(row.listeners, 'serial.listeners'),
                    queuedBytes: Number(row.queuedBytes),
                },
            });
        } else if (entry.kind === 'runner') {
            const row = fields(value, [
                'active',
                'controller',
                'cleanup',
                'cleanupRetry',
                'executing',
            ]);
            owners.producer += has(row.active) + has(row.executing);
            owners.cleanup += has(row.cleanup) + has(row.cleanupRetry);
            retained.push({
                id: entry.id,
                kind: entry.kind,
                details: { controller: has(row.controller) },
            });
        } else if (entry.kind === 'repository') {
            const row = fields(value, [
                'active',
                'modifying',
                'closed',
                'opening',
                'initializing',
                'operation',
                'recording',
                'leases',
                'reserving',
                'releasing',
            ]);
            owners.writer +=
                has(row.active) +
                has(row.modifying) +
                has(row.initializing) +
                has(row.operation) +
                has(row.recording);
            owners.pin += size(row.leases, 'repository.leases') + Number(row.reserving);
            owners.cleanup += has(row.opening);
            retained.push({
                id: entry.id,
                kind: entry.kind,
                details: {
                    connectionOpen: !row.closed,
                    releasingBarrierRetained: has(row.releasing),
                },
            });
        } else if (entry.kind === 'native-repository') {
            fields(value, ['transport']);
            retained.push({ id: entry.id, kind: entry.kind, details: { adapterCached: true } });
        } else if (entry.kind === 'gateway') {
            const row = fields(value, [
                'sessionId',
                'connectionAttempt',
                'heartbeat',
                'terminalAbort',
                'clockAbort',
                'listeners',
                'terminalListeners',
            ]);
            owners.channel += has(row.sessionId) + has(row.terminalAbort);
            owners.cleanup += has(row.clockAbort);
            retained.push({
                id: entry.id,
                kind: entry.kind,
                details: {
                    listeners: size(row.listeners, 'gateway.listeners'),
                    terminalListeners: size(row.terminalListeners, 'gateway.terminalListeners'),
                    heartbeat: has(row.heartbeat),
                    connectionAttemptMetadata: has(row.connectionAttempt),
                },
            });
        } else if (entry.kind === 'console-journal') {
            const row = fields(value, [
                'operation',
                'closing',
                'ended',
                'writer',
                'captureWriter',
                'activity',
                'transactions',
                'readers',
            ]);
            owners.writer += has(row.writer) + has(row.captureWriter);
            owners.reader += Number(row.readers);
            owners.cleanup +=
                has(row.operation) +
                has(row.closing && !row.ended) +
                size(row.transactions, 'console.transactions');
            owners.pin += has(row.activity);
            retained.push({
                id: entry.id,
                kind: entry.kind,
                details: { connectionOpen: !row.ended },
            });
        } else {
            // Constructors are never silently accepted without a named lifetime adapter.
            throw Error(`Unsupported private product owner probe: ${entry.kind}`);
        }
    }
    const browserExports =
        typeof (globalThis as any).__memoryBrowserExports === 'function'
            ? (globalThis as any).__memoryBrowserExports()
            : null;
    if (browserExports) {
        for (const field of ['active', 'rpc', 'helpers', 'busyHelpers', 'connectedHelpers'])
            if (!Number.isSafeInteger(browserExports[field]) || browserExports[field] < 0)
                throw Error('Browser export probe count missing: ' + field);
        owners.export += browserExports.active;
        owners.rpc += browserExports.rpc;
    }
    return { owners, retained, modules: { browserExports } };
}
