/** Pure protocol/observer models only; these are not native reconnect receipts. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CDPSession, Page, Worker } from '@playwright/test';
import {
    BrowserDownloadEvents,
    createBrowserDownloads,
} from './fixtures/memory-product-browser-downloads';
import { ProductViewerWorkers } from './fixtures/memory-product-viewer-lifecycle';
import {
    ProductInspectionRealm,
    requireInspectionRealmDestruction,
} from './fixtures/memory-product-inspection-realm';
import type { AggregateDiagnosticClock } from './fixtures/memory-product-aggregate-diagnostics';
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}
class Protocol extends EventEmitter {
    detachGate?: Promise<void>;
    async send(method: string) {
        if (method === 'Runtime.enable')
            this.emit('Runtime.executionContextCreated', {
                context: { id: 1, auxData: { isDefault: true } },
            });
        return {};
    }
    async detach() {
        await this.detachGate;
        this.emit('close');
    }
}
const pageFor = (session: Protocol) =>
    ({ context: () => ({ newCDPSession: async () => session }) }) as unknown as Page;

test('actual Runtime event history proves destruction; inspector reset and ID substitution cannot', async () => {
    const protocol = new Protocol(),
        realm = new ProductInspectionRealm(async () => {});
    await realm.bind(pageFor(protocol), 1);
    const before = realm.snapshot();
    assert.throws(() => requireInspectionRealmDestruction(before, realm.snapshot()));
    protocol.emit('Runtime.executionContextsCleared');
    requireInspectionRealmDestruction(before, realm.snapshot());
    const wrong = realm.snapshot();
    wrong.history.at(-1)!.ids = [999];
    assert.throws(() => requireInspectionRealmDestruction(before, wrong));
    const reset = realm.snapshot();
    reset.history.at(-1)!.kind = 'inspector-detached';
    assert.throws(() => requireInspectionRealmDestruction(before, reset));
    const next = realm.snapshot();
    next.generation++;
    assert.throws(() => requireInspectionRealmDestruction(before, next));
    await realm.release();
    assert.throws(() => requireInspectionRealmDestruction(before, realm.snapshot()));
});

test('Runtime release is an acknowledged inspector reset, and reused IDs stay scoped to generation', async () => {
    const events: string[] = [],
        realm = new ProductInspectionRealm(async (stage) => {
            events.push(stage);
        });
    const first = new Protocol(),
        page1 = pageFor(first);
    await realm.bind(page1, 1);
    realm.assertBound(page1, 1);
    const gate = deferred();
    first.detachGate = gate.promise;
    const release = realm.release();
    await Promise.resolve();
    assert.equal(realm.snapshot().state, 'releasing');
    assert.deepEqual(realm.snapshot().defaults, [1]);
    assert.throws(() => realm.assertReleased());
    gate.resolve();
    await release;
    realm.assertReleased();
    assert.equal(first.listenerCount('Runtime.executionContextCreated'), 0);
    assert.deepEqual(
        realm.snapshot().history.map((x) => x.kind),
        ['created', 'inspector-detached'],
    );
    const second = new Protocol(),
        page2 = pageFor(second);
    await realm.bind(page2, 2);
    realm.assertBound(page2, 2);
    second.emit('Runtime.executionContextDestroyed', { executionContextId: 1 });
    assert.deepEqual(
        realm.snapshot().history.map((x) => [x.kind, x.generation]),
        [
            ['created', 1],
            ['inspector-detached', 1],
            ['created', 2],
            ['destroyed', 2],
        ],
    );
    assert.equal(realm.cleanupPage(), page2);
    await realm.release();
    assert.equal(events.filter((x) => x === 'inspection-realm-bound').length, 2);
});

test('Runtime evidence failure cannot certify the binding or discard its session', async () => {
    const failure = Error('Realm evidence unavailable.'),
        session = new Protocol();
    const realm = new ProductInspectionRealm(async (stage) => {
        if (stage === 'inspection-realm-bound') throw failure;
    });
    const page = pageFor(session);
    await assert.rejects(realm.bind(page, 1), (error) => error === failure);
    assert.equal(realm.snapshot().state, 'failed');
    assert.equal(realm.snapshot().hasProtocol, true);
    assert.equal(realm.cleanupPage(), page);
    assert.throws(() => realm.assertBound(page, 1));
    realm.assertJoined();
});

test('Runtime session returned after a deadline remains owned for cleanup', async () => {
    const timers = new Map<object, () => void>();
    const clock: AggregateDiagnosticClock = {
        set(callback, ms) {
            assert.equal(ms, 10000);
            const key = {};
            timers.set(key, callback);
            return key;
        },
        clear(key) {
            timers.delete(key as object);
        },
    };
    const entered = deferred(),
        gate = deferred<Protocol>(),
        session = new Protocol();
    const page = {
        context: () => ({
            newCDPSession: async () => {
                entered.resolve();
                return gate.promise;
            },
        }),
    } as unknown as Page;
    const realm = new ProductInspectionRealm(async () => {}, clock),
        bind = realm.bind(page, 1);
    await entered.promise;
    for (const callback of timers.values()) callback();
    await assert.rejects(bind, /10000 ms/);
    assert.throws(() => realm.assertJoined(), /unjoined/);
    gate.resolve(session);
    for (let n = 0; n < 20; n++) await Promise.resolve();
    realm.assertJoined();
    assert.equal(realm.snapshot().state, 'failed');
    assert.equal(realm.snapshot().hasProtocol, true);
    assert.equal(realm.cleanupPage(), page);
    assert.equal(session.listenerCount('close'), 1);
    assert.equal(session.listenerCount('Runtime.executionContextCreated'), 0);
});

async function downloads(run: (directory: string) => Promise<void>) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-inspection-downloads-'));
    try {
        await run(directory);
    } finally {
        await fs.rm(directory, { recursive: true });
    }
}
const downloadPage = {
    send: async () => ({ frameTree: { frame: { id: 'frame', url: 'http://fixture/' } } }),
} as unknown as CDPSession;
const begin = (guid: string) => ({
    guid,
    frameId: 'frame',
    suggestedFilename: 'result.json',
    url: 'http://fixture/export',
});
const progress = (guid: string) => ({ guid, state: 'completed', receivedBytes: 3, totalBytes: 3 });

test('download binding reuses one journal, retains counts and refuses calls through released listeners', async () =>
    downloads(async (directory) => {
        const journal = new BrowserDownloadEvents(),
            first = new Protocol();
        const create = (root: Protocol) =>
            createBrowserDownloads({
                root: root as unknown as CDPSession,
                page: downloadPage,
                directory,
                journal,
                emit: async () => {},
            });
        const one = await create(first);
        await fs.writeFile(path.join(directory, 'first'), 'abc');
        await one.download('json', async () => {
            first.emit('Browser.downloadWillBegin', begin('first'));
            first.emit('Browser.downloadProgress', progress('first'));
        });
        one.releaseForInspection();
        one.assertInspectionReleased();
        assert.equal(first.listenerCount('Browser.downloadWillBegin'), 0);
        await assert.rejects(
            one.download('json', async () => {}),
            /released/,
        );
        const second = new Protocol(),
            two = await create(second);
        assert.equal(two.count(), 1);
        await fs.writeFile(path.join(directory, 'second'), 'abc');
        await two.download('json', async () => {
            second.emit('Browser.downloadWillBegin', begin('second'));
            second.emit('Browser.downloadProgress', progress('second'));
        });
        assert.equal(two.count(), 2);
        assert.deepEqual(journal.snapshot().unconsumed, []);
        two.releaseForInspection();
    }));

for (const condition of ['pending', 'errors']) {
    test(`download ${condition} prevent release and cannot disappear at a new binding`, async () =>
        downloads(async (directory) => {
            const journal = new BrowserDownloadEvents(),
                root = new Protocol();
            const input = {
                root: root as unknown as CDPSession,
                page: downloadPage,
                directory,
                journal,
                emit: async () => {},
            };
            const monitor = await createBrowserDownloads(input);
            if (condition === 'pending') root.emit('Browser.downloadWillBegin', begin('unclaimed'));
            else root.emit('Browser.downloadProgress', progress('unknown'));
            assert.throws(() => monitor.releaseForInspection(), /prevent inspection/);
            assert.equal(root.listenerCount('Browser.downloadWillBegin'), 1);
            await assert.rejects(
                createBrowserDownloads({ ...input, root: new Protocol() as unknown as CDPSession }),
                /prior errors|pending receipts/,
            );
            monitor.releaseAfterBrowserExit();
            assert.equal(
                journal.snapshot().unconsumed.length > 0 || journal.snapshot().errors.length > 0,
                true,
            );
        }));
}

function viewerPage(workers: Worker[] = []) {
    const state = { closed: false };
    const page = Object.assign(new EventEmitter(), {
        workers: () => workers,
        isClosed: () => state.closed,
    });
    return { page, state, typed: page as unknown as Page };
}
const worker = () => Object.assign(new EventEmitter(), { url: () => 'model://export' });

test('viewer inspection release requires settled tokens/records and rebind preserves primitive history', async () => {
    const first = viewerPage(),
        viewer = new ProductViewerWorkers(first.typed, () => true);
    const token = viewer.baseline(),
        one = worker();
    first.page.emit('worker', one);
    const witness = viewer.since(token)[0];
    assert.throws(() => viewer.releaseForInspection(), /tokens/);
    viewer.releaseBaseline(token);
    assert.throws(() => viewer.releaseForInspection(), /closed viewer workers/);
    one.emit('close');
    viewer.retireClosed([witness]);
    viewer.releaseForInspection();
    viewer.assertInspectionReleased();
    assert.equal(first.page.listenerCount('worker'), 0);
    assert.throws(() => viewer.baseline(), /released/);
    const second = viewerPage();
    viewer.bindInspection(second.typed, 2);
    viewer.assertInspectionBound(second.typed, 2);
    assert.equal(viewer.inspectionPageForCleanup(), second.typed);
    assert.equal(viewer.snapshotObserver().observed, 1);
    assert.equal(viewer.snapshotObserver().retiredActualClosed, 1);
    first.page.emit('worker', worker());
    assert.equal(viewer.snapshotObserver().observed, 1);
    const next = viewer.baseline(),
        two = worker();
    second.page.emit('worker', two);
    const nextWitness = viewer.since(next)[0];
    two.emit('close');
    viewer.releaseBaseline(next);
    viewer.retireClosed([nextWitness]);
    assert.equal(viewer.snapshotObserver().observed, 2);
    assert.equal(viewer.snapshotObserver().retiredActualClosed, 2);
    second.state.closed = true;
    viewer.dispose();
});

test('unexpected worker on viewer bind remains retained with its actual new cleanup page', () => {
    const first = viewerPage(),
        viewer = new ProductViewerWorkers(first.typed, () => true);
    viewer.releaseForInspection();
    const unexpected = worker(),
        second = viewerPage([unexpected as unknown as Worker]);
    assert.throws(() => viewer.bindInspection(second.typed, 2), /Unexpected live viewer/);
    assert.equal(viewer.inspectionPageForCleanup(), second.typed);
    assert.equal(viewer.snapshotObserver().records.length, 1);
    assert.throws(() => viewer.assertInspectionBound(second.typed, 2));
    unexpected.emit('close');
    second.state.closed = true;
    viewer.dispose();
});
