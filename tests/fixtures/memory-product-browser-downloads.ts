/** Actual CDP download events and completed files; never emits synthetic Page events. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, type CDPSession } from '@playwright/test';

interface Started {
    guid: string;
    frameId: string;
    suggestedFilename: string;
    url: string;
}
interface Progress {
    guid: string;
    state: string;
    receivedBytes: number;
    totalBytes: number;
}
interface Receipt extends Started {
    ordinal: number;
    state: 'inProgress' | 'completed' | 'canceled';
    receivedBytes: number;
    totalBytes: number;
}
interface FrameTree {
    frame: { id: string; parentId?: string; url: string };
    childFrames?: FrameTree[];
}

export function ownedDownloadFrame(tree: FrameTree, rootId: string, frameId: string) {
    assert.equal(tree.frame.id, rootId, 'Owning page navigated to a different root frame.');
    const frames = new Map<string, { id: string; parentId: string | null; url: string }>();
    function visit(node: FrameTree, parentId: string | null) {
        assert.ok(node.frame.id && !frames.has(node.frame.id) && frames.size < 64);
        assert.equal(node.frame.parentId ?? null, parentId, 'Contradictory frame ancestry.');
        frames.set(node.frame.id, { id: node.frame.id, parentId, url: node.frame.url });
        for (const child of node.childFrames ?? []) visit(child, node.frame.id);
    }
    visit(tree, null);
    assert.ok(frames.has(frameId), 'Download frame is outside the actual owning page tree.');
    const chain = [];
    let frame = frames.get(frameId)!;
    for (;;) {
        chain.push(frame);
        if (!frame.parentId) break;
        frame = frames.get(frame.parentId)!;
    }
    return chain;
}

export class BrowserDownloadEvents {
    private total = 0;
    private records = new Map<string, Receipt>();
    private errors: string[] = [];
    private fail(message: string) {
        if (this.errors.length < 16) this.errors.push(message);
    }

    begin(value: Started) {
        this.total++;
        if (
            !/^[a-zA-Z0-9-]{1,100}$/.test(value.guid) ||
            !value.frameId ||
            this.records.has(value.guid) ||
            this.records.size >= 16 ||
            !value.suggestedFilename ||
            value.suggestedFilename.length > 256 ||
            path.basename(value.suggestedFilename) !== value.suggestedFilename
        ) {
            this.fail('Malformed, duplicate or unbounded actual download start.');
            return;
        }
        this.records.set(value.guid, {
            ...value,
            ordinal: this.total,
            state: 'inProgress',
            receivedBytes: 0,
            totalBytes: 0,
        });
    }
    progress(value: Progress) {
        const row = this.records.get(value.guid);
        if (
            !row ||
            row.state !== 'inProgress' ||
            !['inProgress', 'completed', 'canceled'].includes(value.state) ||
            !Number.isSafeInteger(value.receivedBytes) ||
            !Number.isSafeInteger(value.totalBytes) ||
            value.receivedBytes < row.receivedBytes ||
            value.totalBytes < 0 ||
            value.receivedBytes < 0 ||
            (value.totalBytes > 0 && value.receivedBytes > value.totalBytes)
        ) {
            this.fail('Unknown, late, contradictory or invalid actual download progress.');
            return;
        }
        row.state = value.state as Receipt['state'];
        row.receivedBytes = value.receivedBytes;
        row.totalBytes = value.totalBytes;
    }
    count() {
        return this.total;
    }
    since(ordinal: number) {
        assert.equal(this.errors.length, 0, this.errors.join(' | '));
        return [...this.records.values()].filter((row) => row.ordinal > ordinal);
    }
    consume(guid: string) {
        const row = this.records.get(guid);
        assert.ok(row?.state === 'completed', 'Only an actual completed download can be consumed.');
        this.records.delete(guid);
    }
    snapshot() {
        return {
            observed: this.total,
            unconsumed: [...this.records.values()].map((row) => ({ ...row })),
            errors: [...this.errors],
        };
    }
}

export async function readCompletedBrowserDownload(
    directory: string,
    receipt: Receipt,
    format: string,
    expectedFrame: string,
    limit: number,
) {
    assert.equal(receipt.frameId, expectedFrame, 'Download belongs to another frame.');
    assert.equal(receipt.state, 'completed', 'Browser did not acknowledge download completion.');
    assert.match(receipt.guid, /^[a-zA-Z0-9-]{1,100}$/);
    assert.ok(['json', 'csv', 'md', 'txt', 'svg', 'png', 'pdf'].includes(format));
    assert.equal(path.extname(receipt.suggestedFilename).toLowerCase(), '.' + format);
    assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 128 * 1024 ** 2);
    assert.ok(receipt.receivedBytes > 0 && receipt.receivedBytes <= limit);
    assert.equal(receipt.totalBytes, receipt.receivedBytes, 'Incomplete browser byte accounting.');
    const file = path.join(directory, receipt.guid);
    const before = await fs.lstat(file);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
    assert.equal(before.size, receipt.receivedBytes);
    const handle = await fs.open(file, 'r');
    try {
        const opened = await handle.stat();
        assert.equal(opened.ino, before.ino);
        assert.equal(opened.dev, before.dev);
        assert.equal(opened.size, before.size);
        const chunks: Buffer[] = [];
        let bytes = 0;
        for (;;) {
            const buffer = Buffer.allocUnsafe(65536);
            const read = await handle.read(buffer);
            if (!read.bytesRead) break;
            bytes += read.bytesRead;
            assert.ok(bytes <= limit && bytes <= receipt.receivedBytes);
            chunks.push(buffer.subarray(0, read.bytesRead));
        }
        const after = await handle.stat();
        assert.equal(after.size, before.size);
        assert.equal(after.mtimeMs, before.mtimeMs);
        assert.equal(after.ino, before.ino);
        assert.equal(bytes, receipt.receivedBytes);
        return Buffer.concat(chunks, bytes);
    } finally {
        await handle.close();
    }
}

export async function createBrowserDownloads(input: {
    root: CDPSession;
    page: CDPSession;
    directory: string;
    emit(stage: string, value: unknown): Promise<void>;
    journal?: BrowserDownloadEvents;
}) {
    assert.ok(path.isAbsolute(input.directory));
    await fs.mkdir(input.directory, { recursive: true });
    const journal = input.journal ?? new BrowserDownloadEvents();
    assert.deepEqual(journal.snapshot().errors, [], 'Download journal has prior errors.');
    assert.deepEqual(journal.snapshot().unconsumed, [], 'Download journal has pending receipts.');
    const begin = (value: Started) => journal.begin(value);
    const progress = (value: Progress) => journal.progress(value);
    input.root.on('Browser.downloadWillBegin', begin);
    input.root.on('Browser.downloadProgress', progress);
    let busy = false;
    let released = false;
    const detachListeners = () => {
        input.root.off('Browser.downloadWillBegin', begin);
        input.root.off('Browser.downloadProgress', progress);
        released = true;
    };
    try {
        // CDP sends these events to this subscribing browser session. noDefaults
        // intentionally leaves Playwright's own download event plumbing disabled.
        await input.root.send('Browser.setDownloadBehavior', {
            behavior: 'allowAndName',
            downloadPath: input.directory,
            eventsEnabled: true,
        });
    } catch (error) {
        input.root.off('Browser.downloadWillBegin', begin);
        input.root.off('Browser.downloadProgress', progress);
        throw error;
    }
    return {
        count: () => journal.count(),
        snapshot: () => ({ ...journal.snapshot(), requestPending: busy }),
        async download(format: string, action: () => Promise<void>) {
            assert.equal(released, false, 'Download connection binding is released.');
            assert.equal(busy, false, 'Actual browser download requests cannot overlap.');
            busy = true;
            try {
                const extension = format.toLowerCase();
                const frame = (await input.page.send('Page.getFrameTree')).frameTree.frame.id;
                const ordinal = journal.count();
                assert.equal(
                    journal.snapshot().unconsumed.length,
                    0,
                    'Unclaimed earlier download.',
                );
                await action();
                // Preserve Results' existing five-second begin assertion.
                await expect.poll(() => journal.since(ordinal).length, { timeout: 5000 }).toBe(1);
                const receipt = journal.since(ordinal)[0];
                const ancestry = ownedDownloadFrame(
                    (await input.page.send('Page.getFrameTree')).frameTree,
                    frame,
                    receipt.frameId,
                );
                await expect
                    .poll(() => receipt.state !== 'inProgress', { timeout: 30000 })
                    .toBe(true);
                assert.equal(journal.since(ordinal).length, 1, 'Unexpected duplicate download.');
                const bytes = await readCompletedBrowserDownload(
                    input.directory,
                    receipt,
                    extension,
                    receipt.frameId,
                    128 * 1024 ** 2,
                );
                await input.emit('actual-cdp-download-completed-file', {
                    ...receipt,
                    owningPageFrameId: frame,
                    downloadFrameAncestry: ancestry,
                    path: path.join(input.directory, receipt.guid),
                    bytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex'),
                    source: 'actual Browser.downloadWillBegin/progress and completed owned file',
                });
                journal.consume(receipt.guid);
                return bytes;
            } finally {
                busy = false;
            }
        },
        releaseForInspection() {
            assert.equal(released, false, 'Download connection binding released twice.');
            assert.equal(busy, false, 'Actual download request is still pending.');
            const value = journal.snapshot();
            assert.deepEqual(value.errors, [], 'Download errors prevent inspection release.');
            assert.deepEqual(
                value.unconsumed,
                [],
                'Unconsumed downloads prevent inspection release.',
            );
            detachListeners();
        },
        assertInspectionReleased() {
            assert.equal(released, true, 'Download listeners remain bound.');
            assert.equal(busy, false);
        },
        /** Called only after actual browser root and descendant exit joins. */
        releaseAfterBrowserExit() {
            assert.equal(busy, false, 'Actual download request is still pending.');
            detachListeners();
        },
    };
}
