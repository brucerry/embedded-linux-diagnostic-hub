import { IndexedDbConsoleJournal } from '../../src/features/automation/capture/indexeddb-console';
import { bytesBase64, base64Bytes, CaptureStorageError } from '../../shared/capture-store';
import type { ConsoleRecord, ConsoleSegment } from '../../shared/console-journal';
import { streamConsoleReport } from '../../shared/console-report';
import { startBrowserCaptureExport } from '../../src/features/automation/capture/browser-export';
const stamp = '2026-10-15T15:00:00.000Z';
const header = {
    flowId: 'browser-console',
    startedAt: stamp,
    receiveTimeSource: 'local-client' as const,
    target: { endpoint: 'owned browser journal fixture' },
    ready: { role: 'shell-prompt' as const, literals: ['fixture#'] },
};
const request = <T>(r: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
const completed = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? Error('Aborted fixture'));
        tx.onerror = () => {};
    });
async function raw(name: string, version?: number, upgrade?: (db: IDBDatabase) => void) {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const r = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
        r.onupgradeneeded = () => upgrade?.(r.result);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}
async function inspect(name: string, id: string) {
    const db = await raw(name);
    try {
        const tx = db.transaction(['captures', 'records'], 'readonly'),
            done = completed(tx);
        const [meta, records] = await Promise.all([
            request(tx.objectStore('captures').get(id)),
            request(
                tx
                    .objectStore('records')
                    .getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
            ),
        ]);
        await done;
        return { meta, records: records as ConsoleRecord[] };
    } finally {
        db.close();
    }
}
async function change(
    name: string,
    id: string,
    edit: (meta: any, records: ConsoleRecord[]) => void,
) {
    const db = await raw(name);
    try {
        const tx = db.transaction(['captures', 'records'], 'readwrite'),
            done = completed(tx);
        const [meta, records] = await Promise.all([
            request(tx.objectStore('captures').get(id)),
            request(
                tx
                    .objectStore('records')
                    .getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
            ),
        ]);
        edit(meta, records);
        await request(tx.objectStore('captures').put(meta));
        for (const record of records as ConsoleRecord[])
            await request(tx.objectStore('records').put(record, [id, record.sequence]));
        await done;
    } finally {
        db.close();
    }
}
const command = (
    intent: 'script' | 'send-enter' = 'script',
): Extract<ConsoleSegment, { kind: 'command' }> => ({
    kind: 'command',
    runId: 'run',
    stepId: 'step',
    ordinal: 1,
    name: 'Fixture',
    input: { intent, command: intent === 'script' ? 'pwd' : '' },
    requestBase64: bytesBase64(new TextEncoder().encode(intent === 'script' ? 'pwd\r' : '\r')),
    criterion: { role: 'shell-prompt', literals: ['fixture#'] },
});
async function healthy(store: IndexedDbConsoleJournal) {
    const meta = await store.begin(header);
    await store.start({ kind: 'context', phase: 'startup' }, stamp);
    await store.observe(new TextEncoder().encode('fixture#'), stamp, 'channel');
    await store.end('ready', { role: 'shell-prompt', literal: 'fixture#' }, stamp);
    await store.start({ kind: 'context', phase: 'shutdown' }, stamp);
    await store.end('closed', null, stamp);
    return meta.header.id;
}
async function read(store: IndexedDbConsoleJournal, id: string) {
    const events = [];
    for await (const event of store.read(id)) events.push(event);
    return events;
}
const trackedOwners = new Set<IndexedDbConsoleJournal>();
let trackingOwners = false;
const qa = {
    trackOwners() {
        if (trackingOwners) return;
        trackingOwners = true;
        const open = IndexedDbConsoleJournal.open;
        IndexedDbConsoleJournal.open = async (...args) => {
            const store = await open.apply(IndexedDbConsoleJournal, args);
            trackedOwners.add(store);
            const close = store.close.bind(store);
            store.close = async () => {
                await close();
                if (!store.resourceClosed) throw Error('Fixture observed an unclosed journal');
                trackedOwners.delete(store);
            };
            return store;
        };
    },
    async owners() {
        const locks = await navigator.locks.query();
        return {
            rendererJournals: trackedOwners.size,
            heldLocks: (locks.held ?? [])
                .filter((lock) => lock.name?.startsWith('diagnostic-hub-console-v2'))
                .map((lock) => lock.name),
            pendingLocks: (locks.pending ?? [])
                .filter((lock) => lock.name?.startsWith('diagnostic-hub-console-v2'))
                .map((lock) => lock.name),
        };
    },
    streamConsoleReport,
    IndexedDbConsoleJournal,
    CaptureStorageError,
    stamp,
    header,
    request,
    completed,
    raw,
    inspect,
    change,
    command,
    healthy,
    read,
    base64Bytes,
    async seed(count = 30) {
        const ids: string[] = [];
        let largeId = '';
        for (let index = 0; index < count; index++) {
            const writer = await IndexedDbConsoleJournal.open();
            const meta = await writer.begin({
                ...header,
                flowId: 'saved-flow-' + index,
                target: { endpoint: 'Owned <script> target ' + index },
            });
            ids.push(meta.header.id);
            if (index === 0) largeId = meta.header.id;
            const matched = { role: 'shell-prompt' as const, literal: 'fixture#' };
            await writer.start({ kind: 'context', phase: 'startup' }, stamp);
            await writer.observe(new TextEncoder().encode('fixture#'), stamp, 'channel');
            await writer.end('ready', matched, stamp);
            await writer.start({ ...command(), name: 'Saved diagnostic ' + index }, stamp);
            if (index === 0) {
                await writer.observe(new Uint8Array(128 * 1024).fill(65), stamp, 'channel');
                await writer.observe(
                    new TextEncoder().encode(
                        'UI-BEYOND-PREVIEW <img src=x onerror=window.consoleInjected=true> fixture#',
                    ),
                    stamp,
                    'extended',
                );
            } else
                await writer.observe(new TextEncoder().encode('small fixture#'), stamp, 'channel');
            await writer.end('prompt-observed', matched, stamp);
            await writer.outcome('prompt-observed', matched, stamp);
            await writer.start({ kind: 'context', phase: 'shutdown' }, stamp);
            await writer.end('closed', null, stamp);
            await writer.finish('complete', writer.snapshot!.bytes, true);
            await writer.close();
        }
        return { ids, largeId };
    },
    exportButtons() {
        for (const format of ['json', 'csv', 'markdown', 'text'] as const) {
            const button = document.createElement('button');
            button.id = 'qa-console-export-' + format;
            button.textContent = 'Export console ' + format;
            button.addEventListener('click', () => {
                window.consoleExportOutcome = { state: 'preparing' };
                void startBrowserCaptureExport(format, {}, 'console')
                    .then((job) => {
                        window.consoleExportJob = job;
                        return job.completed;
                    })
                    .then((result) => {
                        window.consoleExportOutcome = result;
                    })
                    .catch((error) => {
                        window.consoleExportOutcome = {
                            state: 'failed',
                            error: String(error.message),
                        };
                    });
            });
            document.body.append(button);
        }
    },
    name: () => 'diagnostic-hub-console-test-' + crypto.randomUUID() + '-v2',
};
declare global {
    interface Window {
        consoleQA: typeof qa;
        consoleExportJob?: Awaited<ReturnType<typeof startBrowserCaptureExport>>;
        consoleExportOutcome?: { state: string; bytes?: number; error?: string };
    }
}
window.consoleQA = qa;
