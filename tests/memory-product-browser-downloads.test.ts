import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { CDPSession } from '@playwright/test';
import {
    BrowserDownloadEvents,
    createBrowserDownloads,
    readCompletedBrowserDownload,
    ownedDownloadFrame,
} from './fixtures/memory-product-browser-downloads';

const started = {
    guid: 'owned-guid',
    frameId: 'actual-owned-frame',
    suggestedFilename: 'results.json',
    url: 'blob:http://127.0.0.1:12345/owned',
};
const complete = {
    ...started,
    ordinal: 1,
    state: 'completed' as const,
    receivedBytes: 3,
    totalBytes: 3,
};
test('download frame is bound to actual page ancestry, including sandboxed helper frames', () => {
    const tree = {
        frame: { id: 'page', url: 'http://127.0.0.1/app' },
        childFrames: [
            { frame: { id: 'helper', parentId: 'page', url: 'http://127.0.0.1/export' } },
        ],
    };
    assert.deepEqual(
        ownedDownloadFrame(tree, 'page', 'helper').map((frame) => frame.id),
        ['helper', 'page'],
    );
    assert.throws(() => ownedDownloadFrame(tree, 'page', 'foreign'), /outside/);
    assert.throws(() => ownedDownloadFrame(tree, 'another-page', 'helper'), /different root/);
    assert.throws(
        () =>
            ownedDownloadFrame(
                {
                    ...tree,
                    childFrames: [{ frame: { id: 'helper', parentId: 'foreign', url: '' } }],
                },
                'page',
                'helper',
            ),
        /ancestry/,
    );
});
async function fixture(run: (directory: string) => Promise<void>) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-cdp-download-control-'));
    try {
        await fs.writeFile(path.join(directory, started.guid), 'abc', { flag: 'wx' });
        await run(directory);
    } finally {
        assert.ok(directory.startsWith(path.join(os.tmpdir(), 'hub-cdp-download-control-')));
        await fs.rm(directory, { recursive: true });
    }
}

test('CDP journal retains real start count after completion consumption', () => {
    const events = new BrowserDownloadEvents();
    events.begin(started);
    events.progress({ ...complete, state: 'inProgress', receivedBytes: 1 });
    events.progress(complete);
    assert.equal(events.count(), 1);
    assert.equal(events.since(0)[0].state, 'completed');
    events.consume(started.guid);
    assert.equal(events.count(), 1);
    assert.deepEqual(events.snapshot().unconsumed, []);
});

for (const [name, change] of [
    ['duplicate start', (events: BrowserDownloadEvents) => events.begin(started)],
    [
        'unknown progress',
        (events: BrowserDownloadEvents) => events.progress({ ...complete, guid: 'foreign' }),
    ],
    [
        'decreasing byte accounting',
        (events: BrowserDownloadEvents) => {
            events.progress({ ...complete, state: 'inProgress', receivedBytes: 2 });
            events.progress({ ...complete, state: 'inProgress', receivedBytes: 1 });
        },
    ],
    [
        'progress after terminal acknowledgement',
        (events: BrowserDownloadEvents) => {
            events.progress(complete);
            events.progress(complete);
        },
    ],
] as const) {
    test('CDP journal refuses ' + name, () => {
        const events = new BrowserDownloadEvents();
        events.begin(started);
        change(events);
        assert.throws(() => events.since(0));
        assert.ok(events.snapshot().errors.length);
    });
}

test('a canceled browser download cannot be consumed as successful', () => {
    const events = new BrowserDownloadEvents();
    events.begin(started);
    events.progress({ ...complete, state: 'canceled' });
    assert.throws(() => events.consume(started.guid), /actual completed/);
    assert.equal(events.count(), 1);
});
test('progress cannot replace the original frame binding and error samples stay bounded', () => {
    const events = new BrowserDownloadEvents();
    events.begin(started);
    events.progress({ ...complete, frameId: 'foreign-frame' } as typeof complete);
    assert.equal(events.since(0)[0].frameId, started.frameId);
    for (let index = 0; index < 1000; index++)
        events.progress({ ...complete, guid: 'unowned-' + index });
    assert.equal(events.snapshot().errors.length, 16);
    assert.throws(() => events.since(0));
});

test('completed-file receipt reads exact bounded bytes', async () => {
    await fixture(async (directory) => {
        assert.deepEqual(
            await readCompletedBrowserDownload(directory, complete, 'json', started.frameId, 3),
            Buffer.from('abc'),
        );
    });
});

for (const [name, receipt, format, frame, limit] of [
    ['another frame', complete, 'json', 'other-frame', 3],
    ['unacknowledged completion', { ...complete, state: 'inProgress' }, 'json', started.frameId, 3],
    ['cancellation', { ...complete, state: 'canceled' }, 'json', started.frameId, 3],
    ['path traversal GUID', { ...complete, guid: '../owned-guid' }, 'json', started.frameId, 3],
    ['wrong extension', complete, 'pdf', started.frameId, 3],
    ['unbounded receipt', complete, 'json', started.frameId, 2],
    ['incomplete totals', { ...complete, totalBytes: 4 }, 'json', started.frameId, 3],
    [
        'truncated file',
        { ...complete, receivedBytes: 4, totalBytes: 4 },
        'json',
        started.frameId,
        4,
    ],
] as const) {
    test('completed-file verifier refuses ' + name, async () => {
        await fixture(async (directory) => {
            await assert.rejects(() =>
                readCompletedBrowserDownload(
                    directory,
                    receipt as typeof complete,
                    format,
                    frame,
                    limit,
                ),
            );
        });
    });
}

test('protocol adapter uses its real event channel and detaches after caller exit join', async () => {
    await fixture(async (directory) => {
        const root = new EventEmitter() as EventEmitter & { send: CDPSession['send'] };
        const requests: string[] = [];
        root.send = (async (method: string) => {
            requests.push(method);
            return {};
        }) as CDPSession['send'];
        const page = {
            send: async () => ({ frameTree: { frame: { id: started.frameId, url: started.url } } }),
        } as unknown as CDPSession;
        const receipts: unknown[] = [];
        const observer = await createBrowserDownloads({
            root: root as unknown as CDPSession,
            page,
            directory,
            emit: async (_stage, value) => {
                receipts.push(value);
            },
        });
        const bytes = await observer.download('JSON', async () => {
            root.emit('Browser.downloadWillBegin', started);
            root.emit('Browser.downloadProgress', complete);
        });
        assert.deepEqual(bytes, Buffer.from('abc'));
        assert.deepEqual(requests, ['Browser.setDownloadBehavior']);
        assert.equal(observer.count(), 1);
        assert.equal(observer.snapshot().requestPending, false);
        assert.equal(receipts.length, 1);
        assert.equal(root.listenerCount('Browser.downloadWillBegin'), 1);
        observer.releaseAfterBrowserExit();
        assert.equal(root.listenerCount('Browser.downloadWillBegin'), 0);
        assert.equal(root.listenerCount('Browser.downloadProgress'), 0);
    });
});
