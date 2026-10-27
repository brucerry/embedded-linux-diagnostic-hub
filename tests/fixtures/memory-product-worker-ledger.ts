/** Independent worker-realm IDB observation, installed before the shipping worker opens a store. */
export function installProductWorkerLedger(realm: typeof globalThis = globalThis) {
    const factory = realm.indexedDB;
    if (!factory || typeof realm.WeakRef !== 'function')
        throw Error('Worker IDB observation unsupported.');
    const originalOpen = IDBFactory.prototype.open,
        originalClose = IDBDatabase.prototype.close,
        originalTransaction = IDBDatabase.prototype.transaction;
    const connections = new Map<
        IDBDatabase,
        { id: number; transactions: number; closeRequested: boolean }
    >();
    const requests = new Set<IDBOpenDBRequest>();
    let sequence = 0,
        logicalCloseAcknowledgements = 0,
        transactionCount = 0;
    const retire = (db: IDBDatabase) => {
        const state = connections.get(db);
        if (state?.closeRequested && state.transactions === 0) {
            connections.delete(db);
            logicalCloseAcknowledgements++;
        }
    };
    const observe = (db: IDBDatabase) => {
        if (!connections.has(db)) {
            if (connections.size >= 16)
                throw Error('Worker IDB connection observation bound exceeded.');
            connections.set(db, { id: ++sequence, transactions: 0, closeRequested: false });
            db.addEventListener(
                'close',
                () => {
                    const state = connections.get(db);
                    if (state) {
                        state.closeRequested = true;
                        retire(db);
                    }
                },
                { once: true },
            );
        }
    };
    IDBFactory.prototype.open = function (...args) {
        const request = Reflect.apply(originalOpen, this, args) as IDBOpenDBRequest;
        requests.add(request);
        request.addEventListener(
            'success',
            () => {
                requests.delete(request);
                observe(request.result);
            },
            { once: true },
        );
        request.addEventListener('error', () => requests.delete(request), { once: true });
        return request;
    };
    IDBDatabase.prototype.close = function () {
        const value = Reflect.apply(originalClose, this, []);
        const state = connections.get(this);
        if (!state) throw Error('Worker database close was not independently observed.');
        state.closeRequested = true;
        retire(this);
        return value;
    };
    IDBDatabase.prototype.transaction = function (...args) {
        const tx = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
        const db = this,
            state = connections.get(db);
        if (!state) throw Error('Worker transaction started on an unobserved connection.');
        state.transactions++;
        transactionCount++;
        let settled = false;
        const done = () => {
            if (settled) throw Error('Worker transaction terminal event repeated.');
            settled = true;
            state.transactions--;
            transactionCount--;
            tx.removeEventListener('complete', done);
            tx.removeEventListener('abort', done);
            retire(db);
        };
        tx.addEventListener('complete', done);
        tx.addEventListener('abort', done);
        return tx;
    };
    return {
        snapshot() {
            return {
                installedBeforeStore: true,
                owners: { openRequest: requests.size, transaction: transactionCount },
                connections: [...connections].map(([db, value]) => ({
                    ...value,
                    name: db.name,
                    version: db.version,
                })),
                logicalCloseAcknowledgements,
                physicalClose:
                    'Normal IDB close has no physical-close event; logical completion and later actual worker-target destruction are separate receipts.',
            };
        },
    };
}
