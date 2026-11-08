/** Test-only observations. Install before the production page mounts; never a production debug API. */
export type BrowserOwnerKind =
    | 'event-listener'
    | 'timeout'
    | 'interval'
    | 'animation-frame'
    | 'resize-observer'
    | 'mutation-observer'
    | 'worker'
    | 'object-url'
    | 'pointer-capture'
    | 'canvas'
    | 'idb-open-request'
    | 'idb-connection'
    | 'idb-transaction';
export interface BrowserOwner {
    id: string;
    kind: BrowserOwnerKind | 'observer-listener';
    scope: 'product' | 'observer';
    phase: string;
    target?: {
        id: string;
        disposition: 'window' | 'document' | 'connected' | 'detached' | 'other';
        connected: boolean | null;
    };
    detail: Record<string, string | number | boolean | null>;
}
export interface BrowserLedgerSnapshot {
    schemaVersion: 1;
    ledgerId: string;
    scope: 'observed-after-install';
    disposed: boolean;
    product: BrowserOwner[];
    observer: BrowserOwner[];
    patches: { id: string; name: string; installed: boolean }[];
    capabilities: Record<
        string,
        { coverage: 'observed' | 'partial' | 'unsupported'; reason: string }
    >;
    uncertainties: string[];
}
export interface BrowserLedgerToken {
    readonly ledgerId: string;
    readonly ordinal: number;
}
export interface BrowserLedgerDelta {
    snapshot: BrowserLedgerSnapshot;
    added: BrowserOwner[];
    removedBaselineIds: string[];
    retainedBaselineIds: string[];
    observerAdded: BrowserOwner[];
    removedObserverBaselineIds: string[];
}
export interface BrowserResourceLedger {
    identify(target: object): string;
    snapshot(): BrowserLedgerSnapshot;
    baseline(): BrowserLedgerToken;
    delta(token: BrowserLedgerToken): BrowserLedgerDelta;
    observer<T>(operation: () => T): T;
    dispose(): { status: 'disposed' | 'blocked'; snapshot: BrowserLedgerSnapshot; reason?: string };
}
type Internal = {
    id: string;
    kind: BrowserOwner['kind'];
    scope: BrowserOwner['scope'];
    phase: string;
    active: boolean;
    running: number;
    weak?: WeakRef<object>;
    target?: WeakRef<object>;
    detail: BrowserOwner['detail'];
    cleanup: (() => void)[];
    targets?: Map<string, WeakRef<object>>;
    callback?: WeakRef<object>;
    capture?: boolean;
    eventType?: string;
    handle?: number;
    closeRequested?: boolean;
    transactions?: Set<string>;
    signal?: WeakRef<AbortSignal>;
};

let installations = 0;
export function installBrowserResourceLedger(
    realm: typeof globalThis = globalThis,
): BrowserResourceLedger {
    // `any` is deliberate at native interception boundaries; native WebIDL conversion remains authoritative.
    const w = realm as typeof globalThis & Record<string, any>;
    if (!w.document || typeof w.WeakRef !== 'function')
        throw Error('Browser ledger unsupported: a browser realm with WeakRef is required.');
    const ledgerId = `browser-ledger-${++installations}`;
    let serial = 0,
        tokenSerial = 0,
        observerDepth = 0,
        disposed = false;
    const owners = new Map<string, Internal>();
    const objectIds = new WeakMap<object, string>();
    const tokens = new WeakMap<
        BrowserLedgerToken,
        { product: Set<string>; observer: Set<string> }
    >();
    const uncertainties = new Set<string>();
    const capabilities: BrowserLedgerSnapshot['capabilities'] = {
        listeners: {
            coverage: 'observed',
            reason: 'Actual add/remove/once/signal lifetimes after installation; DOM targets and callbacks are weakly held by the ledger.',
        },
        timers: {
            coverage: 'observed',
            reason: 'Function callbacks settle naturally; interval ownership ends on actual clear.',
        },
        animationFrames: {
            coverage: 'observed',
            reason: 'Actual cancellation or callback return.',
        },
        observers: {
            coverage: 'observed',
            reason: 'Actual observe/unobserve/disconnect; callbacks remain visible while running.',
        },
        workers: {
            coverage: 'partial',
            reason: 'Constructor and explicit terminate request observed. Web APIs provide no dedicated-worker native-exit acknowledgement or owner-worker self.close notification.',
        },
        objectURLs: {
            coverage: 'observed',
            reason: 'Actual createObjectURL/revokeObjectURL calls; no Blob payload retained.',
        },
        pointerCapture: {
            coverage: 'observed',
            reason: 'Actual set/release and native hasPointerCapture state at snapshots, including implicit release.',
        },
        canvases: {
            coverage: 'partial',
            reason: 'Weak HTML/Offscreen canvas candidates and current bitmap dimensions. A detached reachable canvas is not proof of an abandoned backing store; physical allocation/free is not exposed.',
        },
        indexedDB: {
            coverage: 'partial',
            reason: 'Actual requests/connections/transactions and close-pending until observed transactions settle. Normal DB.close has no physical close event; logical spec completion is distinguished from native exit proof.',
        },
        preinstall: {
            coverage: 'unsupported',
            reason: 'Resources created before installation cannot be enumerated reliably. Install before App; an empty observed set does not prove absence of pre-existing resources.',
        },
        otherRealms: {
            coverage: 'unsupported',
            reason: 'Iframes/workers have independent globals. Install a separate ledger in each required realm.',
        },
        propertyHandlers: {
            coverage: 'unsupported',
            reason: 'on* property assignment, browser-internal listeners, SharedWorker/ServiceWorker, GPU/ImageBitmap/OffscreenCanvas transferred to another realm and async callback-returned Promise lifetimes are not inferred.',
        },
        nativeReflection: {
            coverage: 'unsupported',
            reason: 'Test interception replaces function/constructor identities and stacks. Code depending on native function identity/toString, invalid native receivers or saved pre-install aliases is outside this observation scope.',
        },
    };
    const nativeAdd = w.EventTarget.prototype.addEventListener;
    const nativeRemove = w.EventTarget.prototype.removeEventListener;
    const nodeConnected = Object.getOwnPropertyDescriptor(w.Node.prototype, 'isConnected')?.get;
    const signalAborted = Object.getOwnPropertyDescriptor(w.AbortSignal.prototype, 'aborted')!.get!;
    const patches: {
        id: string;
        name: string;
        target: object;
        key: PropertyKey;
        before: PropertyDescriptor;
        value: unknown;
    }[] = [];
    const objectId = (value: object) => {
        let id = objectIds.get(value);
        if (!id) {
            id = `object-${++serial}`;
            objectIds.set(value, id);
        }
        return id;
    };
    const weak = <T extends object>(value: T) => new WeakRef(value);
    function uncertain(reason: string) {
        if (uncertainties.size < 64) uncertainties.add(reason);
    }
    function owner(
        kind: Internal['kind'],
        target?: object,
        detail: Internal['detail'] = {},
    ): Internal {
        const result: Internal = {
            id: `${kind}-${++serial}`,
            kind,
            scope: observerDepth ? 'observer' : 'product',
            phase: 'active',
            active: true,
            running: 0,
            detail,
            cleanup: [],
            ...(target ? { target: weak(target) } : {}),
        };
        owners.set(result.id, result);
        return result;
    }
    function settle(record: Internal) {
        record.active = false;
        for (const clean of record.cleanup.splice(0)) clean();
        if (!record.running) owners.delete(record.id);
    }
    function callback<T>(record: Internal, fn: () => T): T {
        record.running++;
        record.phase = 'callback';
        owners.set(record.id, record);
        const depth = observerDepth;
        if (record.scope === 'observer') observerDepth++;
        try {
            return fn();
        } finally {
            observerDepth = depth;
            record.running--;
            if (!record.active && !record.running) owners.delete(record.id);
            else if (!record.running) record.phase = 'active';
        }
    }
    function patch(target: object, key: PropertyKey, value: unknown, name: string) {
        const before = Object.getOwnPropertyDescriptor(target, key);
        if (!before || !('value' in before) || (!before.configurable && !before.writable)) {
            uncertain('Cannot intercept ' + name);
            return;
        }
        Object.defineProperty(target, key, { ...before, value });
        patches.push({ id: `patch-${++serial}`, name, target, key, before, value });
    }
    function observerListener(
        target: EventTarget,
        type: string,
        listener: (event: Event) => void,
        once = false,
    ) {
        const record = owner('observer-listener', target, { type });
        record.scope = 'observer';
        const targetRef = weak(target);
        let wrappedRef: WeakRef<EventListener>;
        const remove = () => {
            const t = targetRef.deref(),
                f = wrappedRef.deref();
            if (t && f) Reflect.apply(nativeRemove, t, [type, f]);
            owners.delete(record.id);
            record.active = false;
        };
        const wrapped: EventListener = function (event) {
            if (once) remove();
            listener(event);
        };
        wrappedRef = weak(wrapped);
        Reflect.apply(nativeAdd, target, [type, wrapped, { once }]);
        return remove;
    }
    function targetInfo(value: object): BrowserOwner['target'] {
        const id = objectId(value);
        if (value === w) return { id, disposition: 'window', connected: true };
        if (value instanceof w.Document) return { id, disposition: 'document', connected: true };
        if (value instanceof w.Node) {
            const connected = nodeConnected
                ? (Reflect.apply(nodeConnected, value, []) as boolean)
                : null;
            if (connected === null) uncertain('Native Node connectivity cannot be observed.');
            return {
                id,
                disposition: connected === null ? 'other' : connected ? 'connected' : 'detached',
                connected,
            };
        }
        return { id, disposition: 'other', connected: null };
    }
    // A proxy preserves the native dictionary read order and invokes user getters once, including
    // the receiver of accessors. Capture is pre-read once only because it selects listener identity.
    function options(value: unknown) {
        const cache = new Map<PropertyKey, unknown>();
        if (value && (typeof value === 'object' || typeof value === 'function')) {
            const original = value as object;
            const get = (key: PropertyKey) => {
                if (!cache.has(key)) cache.set(key, Reflect.get(original, key, original));
                return cache.get(key);
            };
            const capture = Boolean(get('capture'));
            return {
                capture,
                passed: new Proxy(original, { get: (_target, key) => get(key) }),
                cache,
            };
        }
        return { capture: Boolean(value), passed: value, cache };
    }
    const targetListeners = new WeakMap<
        object,
        WeakMap<object, Map<string, (Internal | undefined)[]>>
    >();
    function pair(target: object, listener: object, type: string, create: boolean) {
        let byCallback = targetListeners.get(target);
        if (!byCallback && create) targetListeners.set(target, (byCallback = new WeakMap()));
        let byType = byCallback?.get(listener);
        if (!byType && create) byCallback!.set(listener, (byType = new Map()));
        let result = byType?.get(type);
        if (!result && create) byType!.set(type, (result = []));
        return result;
    }
    function detach(record: Internal) {
        const target = record.target?.deref(),
            listener = record.callback?.deref();
        if (target && listener) {
            const p = pair(target, listener, record.eventType!, false),
                index = record.capture ? 1 : 0;
            if (p?.[index] === record) p[index] = undefined;
        }
        settle(record);
    }
    patch(
        w.EventTarget.prototype,
        'addEventListener',
        function (
            this: EventTarget,
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            opts?: AddEventListenerOptions | boolean,
        ) {
            if (!listener || (typeof listener !== 'function' && typeof listener !== 'object'))
                return Reflect.apply(nativeAdd, this, [type, listener, opts]);
            if (typeof type !== 'string') {
                uncertain(
                    'Non-string EventTarget event types are delegated without lifetime coverage.',
                );
                return Reflect.apply(nativeAdd, this, [type, listener, opts]);
            }
            const parsed = options(opts),
                entries = pair(this, listener, type, true)!,
                index = parsed.capture ? 1 : 0;
            const existing = entries[index];
            const previousWrapper = existing?.weak?.deref();
            if (existing?.active && previousWrapper)
                return Reflect.apply(nativeAdd, this, [type, previousWrapper, parsed.passed]);
            if (existing?.active) detach(existing);
            let record: Internal;
            const wrapped: EventListener = function (this: EventTarget, event) {
                if (record.detail.once) detach(record);
                return callback(record, () =>
                    typeof listener === 'function'
                        ? Reflect.apply(listener, this, [event])
                        : Reflect.apply(listener.handleEvent, listener, [event]),
                );
            };
            Reflect.apply(nativeAdd, this, [type, wrapped, parsed.passed]);
            const signal = parsed.cache.get('signal') as AbortSignal | undefined;
            if (signal && Reflect.apply(signalAborted, signal, [])) return;
            record = owner('event-listener', this, {
                type,
                capture: parsed.capture,
                once: Boolean(parsed.cache.get('once')),
                passive:
                    parsed.cache.get('passive') !== undefined
                        ? Boolean(parsed.cache.get('passive'))
                        : null,
            });
            record.weak = weak(wrapped);
            record.callback = weak(listener);
            record.capture = parsed.capture;
            record.eventType = type;
            entries[index] = record;
            if (signal) {
                record.signal = weak(signal);
                record.cleanup.push(observerListener(signal, 'abort', () => detach(record), true));
            }
        },
        'EventTarget.addEventListener',
    );
    patch(
        w.EventTarget.prototype,
        'removeEventListener',
        function (
            this: EventTarget,
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            opts?: EventListenerOptions | boolean,
        ) {
            if (
                !listener ||
                typeof type !== 'string' ||
                (typeof listener !== 'function' && typeof listener !== 'object')
            )
                return Reflect.apply(nativeRemove, this, [type, listener, opts]);
            const parsed = options(opts),
                record = pair(this, listener, type, false)?.[parsed.capture ? 1 : 0];
            const result = Reflect.apply(nativeRemove, this, [
                type,
                record?.active ? record.weak!.deref() : listener,
                parsed.passed,
            ]);
            if (record) detach(record);
            return result;
        },
        'EventTarget.removeEventListener',
    );

    const timers = new Map<number, Internal>();
    function numericHandle(value: unknown, unsigned = false) {
        if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
            uncertain(
                'Object handle conversion is delegated; cancellation identity cannot be repeated safely.',
            );
            return undefined;
        }
        const number = Number(value);
        return unsigned ? number >>> 0 : number >> 0;
    }
    for (const [name, kind] of [
        ['setTimeout', 'timeout'],
        ['setInterval', 'interval'],
    ] as const) {
        const native = w[name];
        patch(
            w,
            name,
            function (this: unknown, handler: TimerHandler, delay?: number, ...args: unknown[]) {
                if (typeof handler !== 'function') {
                    uncertain(
                        'String/non-function timer callbacks have unobservable natural settlement.',
                    );
                    capabilities.timers.coverage = 'partial';
                    return Reflect.apply(native, this, [handler, delay, ...args]);
                }
                let record: Internal;
                const wrapped = function (this: unknown, ...received: unknown[]) {
                    if (kind === 'timeout') {
                        timers.delete(record.handle!);
                        record.active = false;
                    }
                    return callback(record, () => Reflect.apply(handler, this, received));
                };
                const handle = Reflect.apply(native, this, [wrapped, delay, ...args]) as number;
                record = owner(kind, undefined, { handle });
                record.handle = handle;
                timers.set(handle, record);
                return handle;
            },
            name,
        );
    }
    for (const name of ['clearTimeout', 'clearInterval'] as const) {
        const native = w[name];
        patch(
            w,
            name,
            function (this: unknown, handle: number) {
                const result = Reflect.apply(native, this, [handle]);
                const key = numericHandle(handle),
                    record = key === undefined ? undefined : timers.get(key);
                if (record) {
                    timers.delete(key!);
                    settle(record);
                }
                return result;
            },
            name,
        );
    }
    const frames = new Map<number, Internal>();
    if (typeof w.requestAnimationFrame === 'function') {
        const request = w.requestAnimationFrame,
            cancel = w.cancelAnimationFrame;
        patch(
            w,
            'requestAnimationFrame',
            function (this: unknown, handler: FrameRequestCallback) {
                if (typeof handler !== 'function') return Reflect.apply(request, this, [handler]);
                let record: Internal;
                const wrapped = function (this: unknown, timestamp: number) {
                    frames.delete(record.handle!);
                    record.active = false;
                    return callback(record, () => Reflect.apply(handler, this, [timestamp]));
                };
                const handle = Reflect.apply(request, this, [wrapped]) as number;
                record = owner('animation-frame', undefined, { handle });
                record.handle = handle;
                frames.set(handle, record);
                return handle;
            },
            'requestAnimationFrame',
        );
        patch(
            w,
            'cancelAnimationFrame',
            function (this: unknown, handle: number) {
                const result = Reflect.apply(cancel, this, [handle]);
                const key = numericHandle(handle, true),
                    record = key === undefined ? undefined : frames.get(key);
                if (record) {
                    frames.delete(key!);
                    settle(record);
                }
                return result;
            },
            'cancelAnimationFrame',
        );
    } else
        capabilities.animationFrames = {
            coverage: 'unsupported',
            reason: 'requestAnimationFrame is unavailable in this realm.',
        };

    for (const [name, kind] of [
        ['ResizeObserver', 'resize-observer'],
        ['MutationObserver', 'mutation-observer'],
    ] as const) {
        const Native = w[name];
        if (!Native) {
            capabilities[name] = { coverage: 'unsupported', reason: name + ' is unavailable.' };
            continue;
        }
        const instances = new WeakMap<object, Internal>();
        let Wrapped: typeof Native;
        Wrapped = new Proxy(Native, {
            construct(target, args, newTarget) {
                const fn = args[0];
                if (typeof fn !== 'function') return Reflect.construct(target, args, newTarget);
                let record: Internal;
                const wrapped = function (this: unknown, ...values: unknown[]) {
                    return callback(record, () => Reflect.apply(fn, this, values));
                };
                const instance = Reflect.construct(
                    target,
                    [wrapped],
                    newTarget === Wrapped ? target : newTarget,
                );
                record = owner(kind);
                owners.delete(record.id);
                record.active = false;
                record.weak = weak(instance);
                record.targets = new Map();
                instances.set(instance, record);
                return instance;
            },
        });
        patch(w, name, Wrapped, name);
        for (const method of [
            'observe',
            ...(kind === 'resize-observer' ? ['unobserve'] : []),
            'disconnect',
        ]) {
            const native = (
                Native.prototype as unknown as Record<string, (...values: any[]) => unknown>
            )[method];
            patch(
                Native.prototype,
                method,
                function (this: object, ...args: unknown[]) {
                    const result = Reflect.apply(native, this, args),
                        record = instances.get(this);
                    if (!record) {
                        uncertain(name + ' instance existed before installation/another realm.');
                        return result;
                    }
                    if (method === 'observe') {
                        const target = args[0] as object;
                        record.targets!.set(objectId(target), weak(target));
                        record.active = true;
                        owners.set(record.id, record);
                    }
                    if (method === 'unobserve') record.targets!.delete(objectId(args[0] as object));
                    if (method === 'disconnect') record.targets!.clear();
                    if (!record.targets!.size) settle(record);
                    return result;
                },
                name + '.' + method,
            );
        }
    }
    if (w.Worker) {
        const Native = w.Worker,
            workers = new WeakMap<object, Internal>();
        const Wrapped = new Proxy(Native, {
            construct(target, args, newTarget) {
                const instance = Reflect.construct(target, args, newTarget),
                    record = owner('worker', undefined, { nativeExit: 'unassessed' });
                record.weak = weak(instance);
                workers.set(instance, record);
                return instance;
            },
        });
        patch(w, 'Worker', Wrapped, 'Worker');
        const terminate = Native.prototype.terminate;
        patch(
            Native.prototype,
            'terminate',
            function (this: object) {
                const result = Reflect.apply(terminate, this, []),
                    record = workers.get(this);
                if (record) settle(record);
                else uncertain('Worker termination was requested for an unobserved worker.');
                return result;
            },
            'Worker.terminate',
        );
    } else
        capabilities.workers = {
            coverage: 'unsupported',
            reason: 'Dedicated Worker is unavailable.',
        };

    const urls = new Map<string, Internal>();
    if (typeof w.URL.createObjectURL === 'function') {
        const create = w.URL.createObjectURL,
            revoke = w.URL.revokeObjectURL;
        patch(
            w.URL,
            'createObjectURL',
            function (this: unknown, value: Blob | MediaSource) {
                const url = Reflect.apply(create, this, [value]) as string;
                const record = owner('object-url', undefined, { url });
                urls.set(url, record);
                return url;
            },
            'URL.createObjectURL',
        );
        patch(
            w.URL,
            'revokeObjectURL',
            function (this: unknown, url: string) {
                const result = Reflect.apply(revoke, this, [url]);
                if (typeof url !== 'string')
                    uncertain(
                        'Non-string object URL revocation cannot be observed without repeating conversion.',
                    );
                else {
                    const record = urls.get(url);
                    if (record) {
                        urls.delete(url);
                        settle(record);
                    }
                }
                return result;
            },
            'URL.revokeObjectURL',
        );
    } else
        capabilities.objectURLs = {
            coverage: 'unsupported',
            reason: 'Object URL API is unavailable.',
        };

    const pointers = new WeakMap<object, Map<number, Internal>>();
    const hasCapture = w.Element.prototype.hasPointerCapture;
    if (hasCapture)
        for (const method of ['setPointerCapture', 'releasePointerCapture'] as const) {
            const native = w.Element.prototype[method];
            patch(
                w.Element.prototype,
                method,
                function (this: Element, pointerId: number) {
                    const result = Reflect.apply(native, this, [pointerId]);
                    if (typeof pointerId !== 'number' || !Number.isFinite(pointerId)) {
                        uncertain(
                            'Non-numeric pointer capture conversion is delegated without lifetime coverage.',
                        );
                        return result;
                    }
                    const id = pointerId >> 0;
                    let entries = pointers.get(this);
                    if (!entries) pointers.set(this, (entries = new Map()));
                    const previous = entries.get(id);
                    if (Reflect.apply(hasCapture, this, [id])) {
                        if (!previous?.active)
                            entries.set(id, owner('pointer-capture', this, { pointerId: id }));
                    } else if (previous) {
                        entries.delete(id);
                        settle(previous);
                    }
                    return result;
                },
                'Element.' + method,
            );
        }
    else
        capabilities.pointerCapture = {
            coverage: 'unsupported',
            reason: 'Pointer capture API is unavailable.',
        };

    const canvases = new WeakMap<object, Internal>();
    const htmlWidth = Object.getOwnPropertyDescriptor(w.HTMLCanvasElement.prototype, 'width')!.get!;
    const htmlHeight = Object.getOwnPropertyDescriptor(
        w.HTMLCanvasElement.prototype,
        'height',
    )!.get!;
    const offscreenWidth =
        w.OffscreenCanvas &&
        Object.getOwnPropertyDescriptor(w.OffscreenCanvas.prototype, 'width')?.get;
    const offscreenHeight =
        w.OffscreenCanvas &&
        Object.getOwnPropertyDescriptor(w.OffscreenCanvas.prototype, 'height')?.get;
    function canvas(value: object, kind: string) {
        if (!canvases.has(value)) {
            const record = owner('canvas', value, {
                implementation: kind,
                backingStore: 'candidate-not-physical-allocation-proof',
            });
            record.weak = weak(value);
            canvases.set(value, record);
        }
    }
    for (const method of ['createElement', 'createElementNS'] as const) {
        const native = w.Document.prototype[method];
        patch(
            w.Document.prototype,
            method,
            function (this: Document, ...args: unknown[]) {
                const result = Reflect.apply(native, this, args);
                if (result instanceof w.HTMLCanvasElement) canvas(result, 'HTMLCanvasElement');
                return result;
            },
            'Document.' + method,
        );
    }
    if (w.OffscreenCanvas) {
        const Native = w.OffscreenCanvas;
        patch(
            w,
            'OffscreenCanvas',
            new Proxy(Native, {
                construct(target, args, newTarget) {
                    const result = Reflect.construct(target, args, newTarget);
                    canvas(result, 'OffscreenCanvas');
                    return result;
                },
            }),
            'OffscreenCanvas',
        );
    } else
        capabilities.offscreenCanvas = {
            coverage: 'unsupported',
            reason: 'OffscreenCanvas is unavailable in this realm.',
        };
    if (w.HTMLCanvasElement.prototype.transferControlToOffscreen) {
        const native = w.HTMLCanvasElement.prototype.transferControlToOffscreen;
        patch(
            w.HTMLCanvasElement.prototype,
            'transferControlToOffscreen',
            function (this: HTMLCanvasElement) {
                const result = Reflect.apply(native, this, []);
                canvas(result, 'transferred-OffscreenCanvas');
                uncertain(
                    'Transferred canvas backing-store lifetime requires its destination realm/owner.',
                );
                return result;
            },
            'HTMLCanvasElement.transferControlToOffscreen',
        );
    }

    const databases = new WeakMap<object, Internal>(),
        transactions = new WeakMap<object, Internal>();
    function maybeCloseDB(record: Internal) {
        if (record.closeRequested && !record.transactions!.size) settle(record);
    }
    function database(
        db: IDBDatabase,
        scope: Internal['scope'] = observerDepth ? 'observer' : 'product',
    ) {
        let record = databases.get(db);
        if (record) return record;
        record = owner('idb-connection');
        record.scope = scope;
        record.weak = weak(db);
        record.transactions = new Set();
        databases.set(db, record);
        record.cleanup.push(
            observerListener(
                db,
                'close',
                () => {
                    record!.closeRequested = true;
                    maybeCloseDB(record!);
                },
                true,
            ),
        );
        return record;
    }
    function transaction(tx: IDBTransaction, db: Internal) {
        if (transactions.has(tx)) return;
        const record = owner('idb-transaction', undefined, { databaseOwnerId: db.id });
        record.scope = observerDepth ? 'observer' : db.scope;
        record.weak = weak(tx);
        transactions.set(tx, record);
        db.transactions!.add(record.id);
        const done = () => {
            settle(record);
            db.transactions!.delete(record.id);
            maybeCloseDB(db);
        };
        record.cleanup.push(
            observerListener(tx, 'complete', done, true),
            observerListener(tx, 'abort', done, true),
        );
    }
    if (w.indexedDB && w.IDBFactory && w.IDBDatabase) {
        for (const method of ['open', 'deleteDatabase'] as const) {
            const native = w.IDBFactory.prototype[method];
            patch(
                w.IDBFactory.prototype,
                method,
                function (this: IDBFactory, ...args: unknown[]) {
                    const request = Reflect.apply(native, this, args) as IDBOpenDBRequest;
                    const record = owner('idb-open-request', undefined, { operation: method });
                    record.weak = weak(request);
                    const requestRef = weak(request);
                    let upgradeDB: Internal | undefined;
                    const upgrade = () => {
                        const r = requestRef.deref() as IDBOpenDBRequest | undefined;
                        if (r) {
                            upgradeDB = database(r.result, record.scope);
                            if (r.transaction) transaction(r.transaction, upgradeDB);
                        }
                    };
                    const success = () => {
                        const r = requestRef.deref() as IDBOpenDBRequest | undefined;
                        if (r && method === 'open') database(r.result, record.scope);
                        settle(record);
                    };
                    const failure = () => {
                        if (upgradeDB) {
                            upgradeDB.closeRequested = true;
                            maybeCloseDB(upgradeDB);
                        }
                        settle(record);
                    };
                    record.cleanup.push(
                        observerListener(request, 'upgradeneeded', upgrade),
                        observerListener(request, 'success', success, true),
                        observerListener(request, 'error', failure, true),
                    );
                    return request;
                },
                'IDBFactory.' + method,
            );
        }
        const create = w.IDBDatabase.prototype.transaction,
            close = w.IDBDatabase.prototype.close;
        patch(
            w.IDBDatabase.prototype,
            'transaction',
            function (this: IDBDatabase, ...args: unknown[]) {
                const result = Reflect.apply(create, this, args) as IDBTransaction;
                if (!databases.has(this))
                    uncertain(
                        'IDB connection first observed after installation; previous transactions are unassessed.',
                    );
                transaction(result, database(this));
                return result;
            },
            'IDBDatabase.transaction',
        );
        patch(
            w.IDBDatabase.prototype,
            'close',
            function (this: IDBDatabase) {
                const result = Reflect.apply(close, this, []),
                    record = databases.get(this);
                if (record) {
                    record.closeRequested = true;
                    record.phase = 'close-pending';
                    maybeCloseDB(record);
                } else uncertain('IDB close for an unobserved connection.');
                return result;
            },
            'IDBDatabase.close',
        );
    } else
        capabilities.indexedDB = {
            coverage: 'unsupported',
            reason: 'IndexedDB is unavailable in this realm.',
        };

    function snapshot(): BrowserLedgerSnapshot {
        const product: BrowserOwner[] = [],
            observer: BrowserOwner[] = [];
        for (const record of [...owners.values()]) {
            if (!record.active && !record.running) {
                owners.delete(record.id);
                continue;
            }
            const signal = record.signal?.deref();
            if (
                record.kind === 'event-listener' &&
                signal &&
                Reflect.apply(signalAborted, signal, [])
            ) {
                detach(record);
                if (!record.running) continue;
            }
            const target = record.target?.deref(),
                instance = record.weak?.deref();
            if (
                (record.target && !target) ||
                (record.weak && !instance && record.kind !== 'event-listener')
            ) {
                settle(record);
                continue;
            }
            if (
                record.kind === 'pointer-capture' &&
                target &&
                !Reflect.apply(hasCapture, target, [record.detail.pointerId])
            ) {
                settle(record);
                continue;
            }
            if (record.kind === 'canvas' && instance) {
                const html = instance instanceof w.HTMLCanvasElement;
                const width = html ? htmlWidth : offscreenWidth,
                    height = html ? htmlHeight : offscreenHeight;
                if (width && height) {
                    try {
                        record.detail.width = Reflect.apply(width, instance, []);
                        record.detail.height = Reflect.apply(height, instance, []);
                    } catch {
                        record.detail.width = null;
                        record.detail.height = null;
                        uncertain(
                            'Canvas dimensions are unreadable after transfer; its destination owner is unassessed.',
                        );
                    }
                } else uncertain('Native canvas dimension getters are unavailable.');
                if (record.detail.width === 0 || record.detail.height === 0) continue; // Explicitly empty logical bitmap; no physical-memory claim.
            }
            if (record.targets) {
                for (const [id, ref] of record.targets) if (!ref.deref()) record.targets.delete(id);
                if (!record.targets.size && !record.running) {
                    settle(record);
                    continue;
                }
                record.detail.observedTargets = record.targets.size;
            }
            const result: BrowserOwner = {
                id: record.id,
                kind: record.kind,
                scope: record.scope,
                phase: record.phase,
                detail: { ...record.detail },
                ...(target ? { target: targetInfo(target) } : {}),
            };
            (record.scope === 'observer' ? observer : product).push(result);
        }
        const state = patches.map((item) => ({
            id: item.id,
            name: item.name,
            installed: Object.getOwnPropertyDescriptor(item.target, item.key)?.value === item.value,
        }));
        if (!disposed && state.some((item) => !item.installed))
            uncertain(
                'An instrumented API was replaced after installation; subsequent lifetimes are unassessed.',
            );
        return {
            schemaVersion: 1,
            ledgerId,
            scope: 'observed-after-install',
            disposed,
            product,
            observer,
            patches: state,
            capabilities: structuredClone(capabilities),
            uncertainties: [...uncertainties],
        };
    }
    return {
        identify: objectId,
        snapshot,
        baseline() {
            const state = snapshot(),
                token = Object.freeze({ ledgerId, ordinal: ++tokenSerial });
            tokens.set(token, {
                product: new Set(state.product.map((item) => item.id)),
                observer: new Set(state.observer.map((item) => item.id)),
            });
            return token;
        },
        delta(token) {
            const base = tokens.get(token);
            if (!base || token.ledgerId !== ledgerId)
                throw Error(
                    'Baseline token belongs to another ledger or is not the original token.',
                );
            const state = snapshot(),
                live = new Set(state.product.map((item) => item.id)),
                observing = new Set(state.observer.map((item) => item.id));
            return {
                snapshot: state,
                added: state.product.filter((item) => !base.product.has(item.id)),
                removedBaselineIds: [...base.product].filter((id) => !live.has(id)),
                retainedBaselineIds: [...base.product].filter((id) => live.has(id)),
                observerAdded: state.observer.filter((item) => !base.observer.has(item.id)),
                removedObserverBaselineIds: [...base.observer].filter((id) => !observing.has(id)),
            };
        },
        observer<T>(operation: () => T): T {
            observerDepth++;
            try {
                return operation();
            } finally {
                observerDepth--;
            }
        },
        dispose() {
            const state = snapshot();
            if (state.product.length || state.observer.length)
                return {
                    status: 'blocked',
                    snapshot: state,
                    reason: 'Live registrations remain; APIs cannot be restored beneath live wrappers without changing removal semantics. Close the actual page/world after qualification, or let owners dispose naturally.',
                };
            if (state.patches.some((item) => !item.installed) && !disposed)
                return {
                    status: 'blocked',
                    snapshot: state,
                    reason: 'Patch integrity was lost; another observer owns the current API.',
                };
            for (const item of [...patches].reverse())
                if (Object.getOwnPropertyDescriptor(item.target, item.key)?.value === item.value)
                    Object.defineProperty(item.target, item.key, item.before);
            disposed = true;
            return { status: 'disposed', snapshot: snapshot() };
        },
    };
}
