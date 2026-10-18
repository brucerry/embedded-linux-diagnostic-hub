import { IndexedDbCaptureStore } from '../../src/features/automation/capture/indexeddb-store';
import { CaptureWriter } from '../../shared/capture-writer';
import {
    newCapture,
    appendFrames,
    sealedCapture,
    failedCapture,
    frameCrc,
    CaptureStorageError,
    type CaptureFrame,
} from '../../shared/capture-store';
import { streamCaptureReport } from '../../shared/capture-report';
const stamp = '2026-10-15T00:00:00.000Z';
export const request = <T>(input: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
        input.onsuccess = () => resolve(input.result);
        input.onerror = () => reject(input.error);
    });
export const done = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? Error('Aborted fixture transaction'));
        tx.onerror = () => {};
    });
export function openRaw(
    name: string,
    version?: number,
    upgrade?: (db: IDBDatabase, tx: IDBTransaction) => void,
) {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const opening =
            version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
        opening.onupgradeneeded = () => upgrade?.(opening.result, opening.transaction!);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => resolve(opening.result);
    });
}
export async function snapshot(db: IDBDatabase) {
    const stores = Array.from(db.objectStoreNames),
        tx = db.transaction(stores, 'readonly'),
        completed = done(tx);
    const [captures, frames, sequence, extra, results] = await Promise.all([
        request(tx.objectStore('captures').getAll()),
        request(tx.objectStore('frames').getAll()),
        request(tx.objectStore('settings').get('sequence')),
        request(tx.objectStore('preserved').get('fixture')),
        stores.includes('results')
            ? request(tx.objectStore('results').getAll())
            : Promise.resolve([]),
    ]);
    await completed;
    return {
        version: db.version,
        stores,
        captures: captures.sort((a, b) => a.sequence - b.sequence),
        frames: frames.map((frame) => ({ ...frame, bytes: Array.from(frame.bytes) })),
        sequence,
        extra,
        results,
    };
}
export async function inspect(name: string) {
    const db = await openRaw(name);
    try {
        return await snapshot(db);
    } finally {
        db.close();
    }
}
export async function seedLegacy(
    name: string,
    options: {
        version?: number;
        counter?: unknown;
        omitCounter?: boolean;
        badIndex?: boolean;
        omitResults?: boolean;
        keepOpen?: boolean;
    } = {},
) {
    const version = options.version ?? 1,
        db = await openRaw(name, version, (db) => {
            const captures = db.createObjectStore('captures', { keyPath: 'id' });
            captures.createIndex('sequence', 'sequence', { unique: !options.badIndex });
            for (const table of ['frames', 'settings', 'preserved']) db.createObjectStore(table);
            if (version >= 2 && !options.omitResults) db.createObjectStore('results');
        });
    const tx = db.transaction(['captures', 'frames', 'settings', 'preserved'], 'readwrite'),
        completed = done(tx),
        ids: string[] = [];
    for (const [index, sequence] of [4, 17, 42].entries()) {
        const id = crypto.randomUUID(),
            bytes = new Uint8Array([0, 255, 27, 91, 51, 49, 109, 65 + index]);
        const frame: CaptureFrame = {
            observation: 0,
            receivedAt: stamp,
            stream: 'serial',
            offset: 0,
            totalBytes: bytes.length,
            bytes,
            crc32: frameCrc(bytes),
        };
        let capture = appendFrames(
            newCapture(id, sequence, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'schema-one',
                stepId: 'legacy-' + index,
                name: 'Legacy ' + index,
                command: 'synthetic only',
                startedAt: stamp,
            }),
            [frame],
        );
        if (index === 0) capture = sealedCapture(capture, bytes.length, 'legacy complete');
        if (index === 1)
            capture = failedCapture(
                capture,
                bytes.length,
                new CaptureStorageError('io', 'Legacy incomplete fixture'),
            );
        tx.objectStore('captures').add(capture);
        tx.objectStore('frames').add(frame, [id, 0]);
        ids.push(id);
    }
    if (!options.omitCounter) tx.objectStore('settings').put(options.counter ?? 700, 'sequence');
    tx.objectStore('preserved').put(
        { unknownFutureField: 'retain exactly', bytes: [0, 255] },
        'fixture',
    );
    await completed;
    const before = await snapshot(db);
    if (options.keepOpen) window.heldLegacy = db;
    else db.close();
    return { ids, before };
}
export async function bytes(store: IndexedDbCaptureStore, id: string) {
    const raw: number[] = [];
    for await (const event of store.read(id))
        if (event.type === 'frame') raw.push(...event.frame.bytes);
    return raw;
}
export async function report(store: IndexedDbCaptureStore) {
    let json = '';
    for await (const chunk of streamCaptureReport(store, 'json')) {
        json += new TextDecoder().decode(chunk);
        if (json.length > 128 * 1024) throw Error('Lifecycle fixture report exceeded its bound.');
    }
    return JSON.parse(json);
}
export const outcome = () => ({
    id: crypto.randomUUID().replaceAll('-', ''),
    ordinal: 1,
    completion: 'prompt-observed' as const,
    exitCode: null,
    truncated: false,
    completedAt: stamp,
    localZone: 'UTC',
    durationMs: 0,
    deviceTime: null,
});
export const api = {
    IndexedDbCaptureStore,
    CaptureWriter,
    request,
    done,
    openRaw,
    snapshot,
    inspect,
    seedLegacy,
    bytes,
    report,
    outcome,
    stamp,
};
declare global {
    interface Window {
        lifecycleQA: typeof api;
        heldLegacy?: IDBDatabase;
        lifecycleStore?: IndexedDbCaptureStore;
    }
}
window.lifecycleQA = api;
