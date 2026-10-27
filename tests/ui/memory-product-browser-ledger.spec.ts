import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import type { BrowserResourceLedger } from '../fixtures/memory-product-browser-ledger';

declare global {
    interface Window {
        BrowserLedgerModule: typeof import('../fixtures/memory-product-browser-ledger');
        ledger: BrowserResourceLedger;
        ledgerFixture: any;
    }
}
let server: http.Server, origin: string, bundle: string;
test.beforeAll(async ({ browser }) => {
    console.log(
        'LEDGER_BROWSER_RUNTIME ' +
            JSON.stringify({
                name: browser.browserType().name(),
                version: browser.version(),
                platform: process.platform,
                arch: process.arch,
            }),
    );
    const result = await build({
        entryPoints: ['tests/fixtures/memory-product-browser-ledger.ts'],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'BrowserLedgerModule',
        write: false,
        target: 'es2022',
    });
    bundle = result.outputFiles[0].text;
    server = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(
            '<!doctype html><meta charset="utf-8"><title>Owned browser ledger fixture</title><body></body>',
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
test.afterAll(async ({ browser }) => {
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    await browser.close();
});
test.beforeEach(async ({ page }) => {
    await page.goto(origin);
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
        const nativeAdd = EventTarget.prototype.addEventListener,
            nativeRemove = EventTarget.prototype.removeEventListener;
        window.ledger = window.BrowserLedgerModule.installBrowserResourceLedger();
        window.ledgerFixture = { nativeAdd, nativeRemove };
    });
});
test.afterEach(async ({ page }, info) => {
    if (!page.isClosed()) {
        const state = await page.evaluate(() => window.ledger?.snapshot());
        await info.attach('actual-end-ledger', {
            body: Buffer.from(JSON.stringify(state ?? { unavailable: true })),
            contentType: 'application/json',
        });
    }
});

test('listeners preserve duplicate/capture/object/once reentry and signal lifetimes without observer leftovers', async ({
    page,
}) => {
    const result = await page.evaluate(() => {
        const l = window.ledger,
            target = document.createElement('button'),
            events: string[] = [],
            base = l.baseline();
        document.body.append(target);
        function fn(this: EventTarget, event: Event) {
            events.push(`${this === target}:${event.type}`);
        }
        target.addEventListener('ordinary', fn);
        target.addEventListener('ordinary', fn);
        target.addEventListener('ordinary', fn, true);
        target.dispatchEvent(new Event('ordinary'));
        target.removeEventListener('ordinary', fn);
        target.removeEventListener('ordinary', fn, true);
        const object = {
            handleEvent(event: Event) {
                events.push('object:' + event.type);
            },
        };
        target.addEventListener('object', object, { once: true });
        target.dispatchEvent(new Event('object'));
        target.dispatchEvent(new Event('object'));
        let reentered = false,
            duringCallback = false;
        function once() {
            duringCallback ||= l
                .snapshot()
                .product.some((x) => x.kind === 'event-listener' && x.phase === 'callback');
            if (!reentered) {
                reentered = true;
                target.addEventListener('once', once, { once: true });
            }
        }
        target.addEventListener('once', once, { once: true });
        target.dispatchEvent(new Event('once'));
        target.dispatchEvent(new Event('once'));
        const nativeTarget = new EventTarget(),
            nativeController = new AbortController(),
            duplicateController = new AbortController();
        let duplicateNativeCalls = 0,
            duplicateWrappedCalls = 0;
        const nativeDuplicate = () => duplicateNativeCalls++,
            duplicate = () => duplicateWrappedCalls++;
        window.ledgerFixture.nativeAdd.call(nativeTarget, 'duplicate-signal', nativeDuplicate);
        window.ledgerFixture.nativeAdd.call(nativeTarget, 'duplicate-signal', nativeDuplicate, {
            signal: nativeController.signal,
        });
        target.addEventListener('duplicate-signal', duplicate);
        target.addEventListener('duplicate-signal', duplicate, {
            signal: duplicateController.signal,
        });
        nativeController.abort();
        duplicateController.abort();
        nativeTarget.dispatchEvent(new Event('duplicate-signal'));
        target.dispatchEvent(new Event('duplicate-signal'));
        const duplicateOwners = l
            .snapshot()
            .product.filter((x) => x.detail.type === 'duplicate-signal').length;
        window.ledgerFixture.nativeRemove.call(nativeTarget, 'duplicate-signal', nativeDuplicate);
        target.removeEventListener('duplicate-signal', duplicate);
        const controller = new AbortController();
        const blocker = (event: Event) => event.stopImmediatePropagation();
        controller.signal.addEventListener('abort', blocker);
        target.addEventListener('signal', fn, { signal: controller.signal });
        controller.abort();
        const afterAbort = l.snapshot();
        controller.signal.removeEventListener('abort', blocker);
        const aborted = new AbortController();
        aborted.abort();
        target.addEventListener('aborted', fn, { signal: aborted.signal });
        target.remove();
        return {
            events,
            duringCallback,
            afterAbortProduct: afterAbort.product.filter((x) => x.detail.type === 'signal').length,
            afterAbortObserver: afterAbort.observer.length,
            added: l.delta(base).added,
            observer: l.snapshot().observer,
            duplicateNativeCalls,
            duplicateWrappedCalls,
            duplicateOwners,
        };
    });
    expect(result.events).toEqual(['true:ordinary', 'true:ordinary', 'object:object']);
    expect(result.duringCallback).toBe(true);
    expect(result.afterAbortProduct).toBe(0);
    expect(result.afterAbortObserver).toBe(0);
    expect(result.added).toEqual([]);
    expect(result.observer).toEqual([]);
    expect(result.duplicateWrappedCalls).toBe(result.duplicateNativeCalls);
    expect(result.duplicateOwners).toBe(result.duplicateNativeCalls > 0 ? 1 : 0);
});

test('actual native options getters run once in native order and keep the original receiver', async ({
    page,
}) => {
    const result = await page.evaluate(() => {
        const l = window.ledger;
        const accesses: string[] = [],
            target = new EventTarget(),
            fn = () => {};
        const options: AddEventListenerOptions = {};
        for (const key of ['capture', 'once', 'passive', 'signal'])
            Object.defineProperty(options, key, {
                get() {
                    accesses.push(key + ':' + (this === options));
                    return key === 'signal' ? undefined : false;
                },
            });
        target.addEventListener('probe', fn, options);
        target.removeEventListener('probe', fn);
        return { accesses, product: l.snapshot().product };
    });
    expect(result.accesses).toEqual(['capture:true', 'once:true', 'passive:true', 'signal:true']);
    expect(result.product).toEqual([]);
});

test('a removed baseline identity never masks a new owner and detached roots remain explicit', async ({
    page,
}) => {
    const result = await page.evaluate(() => {
        const l = window.ledger,
            first = () => {},
            replacement = () => {};
        window.addEventListener('baseline', first);
        const token = l.baseline();
        const old = l.snapshot().product[0].id;
        window.removeEventListener('baseline', first);
        window.addEventListener('replacement', replacement);
        const root = document.createElement('div'),
            rootId = l.identify(root),
            delegated = () => {};
        root.addEventListener('delegated', delegated);
        document.body.append(root);
        const connected = l.snapshot().product.find((x) => x.target?.id === rootId)
            ?.target?.disposition;
        root.remove();
        const delta = l.delta(token);
        root.removeEventListener('delegated', delegated);
        window.removeEventListener('replacement', replacement);
        let invalid = false;
        try {
            l.delta({ ...token });
        } catch {
            invalid = true;
        }
        return {
            old,
            rootId,
            connected,
            added: delta.added,
            removed: delta.removedBaselineIds,
            invalid,
            end: l.snapshot().product,
        };
    });
    expect(result.added).toHaveLength(2);
    expect(result.removed).toEqual([result.old]);
    expect(result.connected).toBe('connected');
    expect(result.added.find((x) => x.target?.id === result.rootId)?.target?.disposition).toBe(
        'detached',
    );
    expect(result.added.find((x) => x.detail.type === 'replacement')?.target?.disposition).toBe(
        'window',
    );
    expect(result.invalid).toBe(true);
    expect(result.end).toEqual([]);
});

test('function timers/RAF settle naturally, cross-clears convert primitive IDs, and observer handles stay separate', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const l = window.ledger,
            token = l.baseline();
        let calls = 0,
            running = false;
        await new Promise<void>((resolve) =>
            setTimeout(
                function (this: Window, value: string) {
                    calls += Number(this === window && value === 'argument');
                    running = l
                        .snapshot()
                        .product.some((x) => x.kind === 'timeout' && x.phase === 'callback');
                    resolve();
                },
                0,
                'argument',
            ),
        );
        const timeout = setTimeout(() => {
            calls += 100;
        }, 60000);
        clearInterval(String(timeout) as unknown as number);
        await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                clearTimeout(interval);
                calls++;
                resolve();
            }, 0);
        });
        const frame = requestAnimationFrame(() => {
            calls += 100;
        });
        cancelAnimationFrame(String(frame) as unknown as number);
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => {
                calls++;
                resolve();
            }),
        );
        const observerTimer = l.observer(() => setInterval(() => {}, 60000));
        const observerListener = () => {};
        l.observer(() => window.addEventListener('owned-observer', observerListener));
        const state = l.delta(token);
        clearInterval(observerTimer);
        window.removeEventListener('owned-observer', observerListener);
        return {
            calls,
            running,
            product: state.added,
            observing: state.observerAdded.map((x) => x.kind),
            end: l.snapshot(),
        };
    });
    expect(result.calls).toBe(3);
    expect(result.running).toBe(true);
    expect(result.product).toEqual([]);
    expect(result.observing.sort()).toEqual(['event-listener', 'interval']);
    expect(result.end.observer).toEqual([]);
    expect(result.end.product).toEqual([]);
});

test('Mutation/ResizeObserver registration and callback/disconnect ownership use actual instances', async ({
    page,
}) => {
    await page.evaluate(() => {
        const target = document.createElement('div');
        target.style.cssText = 'width:20px;height:20px';
        document.body.append(target);
        const state = window.ledgerFixture;
        state.target = target;
        state.mutationCalls = 0;
        state.resizeCalls = 0;
        state.mutation = new MutationObserver(() => state.mutationCalls++);
        state.mutation.observe(target, { attributes: true });
        state.resize = new ResizeObserver(() => state.resizeCalls++);
        state.resize.observe(target);
        target.style.width = '30px';
    });
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.ledgerFixture.mutationCalls > 0 && window.ledgerFixture.resizeCalls > 0,
            ),
        )
        .toBe(true);
    const result = await page.evaluate(() => {
        const l = window.ledger,
            state = window.ledgerFixture;
        const before = l.snapshot().product.filter((x) => x.kind.endsWith('observer'));
        state.mutation.disconnect();
        state.resize.unobserve(state.target);
        state.resize.disconnect();
        state.target.remove();
        window.ledgerFixture = {};
        return { before, after: l.snapshot().product };
    });
    expect(result.before.map((x) => x.kind).sort()).toEqual([
        'mutation-observer',
        'resize-observer',
    ]);
    expect(result.after).toEqual([]);
});

test('worker termination requests and URLs are observed while native worker exit stays explicitly unassessed', async ({
    page,
}) => {
    const created = page.waitForEvent('worker');
    await page.evaluate(() => {
        const state = window.ledgerFixture;
        state.url = URL.createObjectURL(
            new Blob(['self.onmessage=()=>self.postMessage("pong")'], { type: 'text/javascript' }),
        );
        state.worker = new Worker(state.url);
    });
    const worker = await created;
    await worker.evaluate(() => 1);
    const before = await page.evaluate(() => window.ledger.snapshot());
    expect(before.product.map((x) => x.kind).sort()).toEqual(['object-url', 'worker']);
    expect(before.capabilities.workers.coverage).toBe('partial');
    const closed = new Promise<void>((resolve) => worker.once('close', () => resolve()));
    await page.evaluate(() => {
        const state = window.ledgerFixture;
        state.worker.terminate();
        URL.revokeObjectURL(state.url);
        window.ledgerFixture = {};
    });
    await closed;
    expect((await page.evaluate(() => window.ledger.snapshot())).product).toEqual([]);
});

test('trusted pointer down/up and explicit release settle actual capture identity', async ({
    page,
}) => {
    await page.evaluate(() => {
        const target = document.createElement('div');
        target.id = 'pointer-target';
        target.style.cssText = 'width:100px;height:100px;background:#aaa';
        const down = (event: PointerEvent) => {
            window.ledgerFixture.pointerId = event.pointerId;
            target.setPointerCapture(event.pointerId);
        };
        target.addEventListener('pointerdown', down);
        document.body.append(target);
        window.ledgerFixture.target = target;
        window.ledgerFixture.down = down;
    });
    await page.mouse.move(30, 30);
    await page.mouse.down();
    expect(
        await page.evaluate(
            () =>
                window.ledger.snapshot().product.filter((x) => x.kind === 'pointer-capture').length,
        ),
    ).toBe(1);
    await page.mouse.up();
    expect(
        await page.evaluate(
            () =>
                window.ledger.snapshot().product.filter((x) => x.kind === 'pointer-capture').length,
        ),
    ).toBe(0);
    await page.mouse.down();
    await page.evaluate(() =>
        window.ledgerFixture.target.releasePointerCapture(window.ledgerFixture.pointerId),
    );
    expect(
        await page.evaluate(
            () =>
                window.ledger.snapshot().product.filter((x) => x.kind === 'pointer-capture').length,
        ),
    ).toBe(0);
    await page.mouse.up();
    const end = await page.evaluate(() => {
        const state = window.ledgerFixture;
        state.target.removeEventListener('pointerdown', state.down);
        state.target.remove();
        window.ledgerFixture = {};
        return window.ledger.snapshot();
    });
    expect(end.product).toEqual([]);
});

test('temporary canvases retain weak detached candidates and report empty logical bitmaps without physical-memory claims', async ({
    page,
}) => {
    const result = await page.evaluate(() => {
        const l = window.ledger,
            target = document.createElement('canvas');
        target.width = 40;
        target.height = 20;
        document.body.append(target);
        target.getContext('2d')!.fillRect(0, 0, 20, 20);
        const id = l.identify(target),
            connected = l.snapshot().product.find((x) => x.target?.id === id);
        target.remove();
        const detached = l.snapshot().product.find((x) => x.target?.id === id);
        target.width = 0;
        target.height = 0;
        let offscreen: string | null = null;
        if (typeof OffscreenCanvas === 'function') {
            const c = new OffscreenCanvas(20, 20);
            offscreen =
                l.snapshot().product.find((x) => x.detail.implementation === 'OffscreenCanvas')
                    ?.kind ?? null;
            c.width = 0;
            c.height = 0;
        }
        return {
            connected,
            detached,
            offscreen,
            offscreenAvailable: typeof OffscreenCanvas === 'function',
            end: l.snapshot(),
        };
    });
    expect(result.connected?.target?.disposition).toBe('connected');
    expect(result.detached?.target?.disposition).toBe('detached');
    expect(result.detached?.detail.width).toBe(40);
    expect(result.end.product).toEqual([]);
    if (result.offscreenAvailable) expect(result.offscreen).toBe('canvas');
    expect(result.end.capabilities.canvases.coverage).toBe('partial');
});

test('real IndexedDB upgrade/transaction/close-pending/abort settles observer listeners and actual logical connections', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const l = window.ledger,
            name = 'browser-ledger-' + crypto.randomUUID();
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('items');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const initial = l.snapshot();
        const tx = db.transaction('items', 'readwrite');
        tx.objectStore('items').put('retained bytes', 'key');
        const completed = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
        });
        db.close();
        const pending = l.snapshot();
        await completed;
        const afterClose = l.snapshot();
        const reopened = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const aborted = reopened.transaction('items', 'readwrite');
        const abortDone = new Promise<void>((resolve) => {
            aborted.onabort = () => resolve();
        });
        aborted.abort();
        await abortDone;
        reopened.close();
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
        return { initial, pending, afterClose, final: l.snapshot() };
    });
    expect(result.initial.product.filter((x) => x.kind === 'idb-connection')).toHaveLength(1);
    expect(result.pending.product.filter((x) => x.kind === 'idb-transaction')).toHaveLength(1);
    expect(result.pending.product.find((x) => x.kind === 'idb-connection')?.phase).toBe(
        'close-pending',
    );
    expect(result.afterClose.product).toEqual([]);
    expect(result.afterClose.observer).toEqual([]);
    expect(result.final.product).toEqual([]);
    expect(result.final.observer).toEqual([]);
    expect(result.final.capabilities.indexedDB.coverage).toBe('partial');
});

test('dispose blocks live wrappers without forced cleanup, then restores the exact APIs after actual removal', async ({
    page,
}) => {
    const result = await page.evaluate(() => {
        const l = window.ledger;
        let calls = 0;
        const fn = () => calls++;
        window.addEventListener('dispose-probe', fn);
        const first = l.dispose();
        window.dispatchEvent(new Event('dispose-probe'));
        window.removeEventListener('dispose-probe', fn);
        const end = l.dispose();
        return {
            first: first.status,
            calls,
            end: end.status,
            observers: end.snapshot.observer,
            patches: end.snapshot.patches.filter((x) => x.installed),
            unsupported: end.snapshot.capabilities.preinstall.coverage,
        };
    });
    expect(result.first).toBe('blocked');
    expect(result.calls).toBe(1);
    expect(result.end).toBe('disposed');
    expect(result.observers).toEqual([]);
    expect(result.patches).toEqual([]);
    expect(result.unsupported).toBe('unsupported');
});

test('observer-owned IndexedDB callbacks retain observer provenance and really remove their listeners', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const l = window.ledger,
            name = 'observer-ledger-' + crypto.randomUUID();
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = l.observer(() => indexedDB.open(name, 1));
            request.onupgradeneeded = () => request.result.createObjectStore('items');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const active = l.snapshot();
        db.close();
        await new Promise<void>((resolve, reject) => {
            const request = l.observer(() => indexedDB.deleteDatabase(name));
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
        return { active, end: l.snapshot() };
    });
    expect(result.active.product).toEqual([]);
    expect(result.active.observer.some((x) => x.kind === 'idb-connection')).toBe(true);
    expect(result.end.product).toEqual([]);
    expect(result.end.observer).toEqual([]);
});

test('unobservable string callbacks and overwritten hooks stay unassessed instead of a clean-zero claim', async ({
    page,
}) => {
    const result = await page.evaluate(() => {
        const l = window.ledger;
        const handle = setTimeout('globalThis.__unusedLedgerString=true', 60000);
        clearTimeout(handle);
        const wrapped = window.setTimeout;
        window.setTimeout = (() => 0) as unknown as typeof setTimeout;
        const state = l.snapshot(),
            blocked = l.dispose().status;
        window.setTimeout = wrapped;
        const end = l.dispose();
        return {
            coverage: state.capabilities.timers.coverage,
            uncertainties: state.uncertainties,
            blocked,
            end: end.status,
        };
    });
    expect(result.coverage).toBe('partial');
    expect(result.uncertainties.some((x) => x.includes('String/non-function'))).toBe(true);
    expect(result.uncertainties.some((x) => x.includes('replaced'))).toBe(true);
    expect(result.blocked).toBe('blocked');
    expect(result.end).toBe('disposed');
});
