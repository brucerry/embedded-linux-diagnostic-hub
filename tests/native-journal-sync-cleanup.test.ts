import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FileHandle } from 'node:fs/promises';
import { physicalFS } from '../electron/physical-fs';
import { NativeCaptureStore as CurrentStore } from '../electron/capture-store';

const stamp = '2026-10-16T00:00:00.000Z';
const header = {
    transport: 'serial' as const,
    receiveTimeSource: 'local-client' as const,
    runId: 'sync-failure-fixture',
    stepId: 'one',
    name: 'synthetic',
    command: 'synthetic',
    startedAt: stamp,
};
const storeType = async () =>
    process.env.HUB_JOURNAL_OLD_SOURCE
        ? (await import(pathToFileURL(process.env.HUB_JOURNAL_OLD_SOURCE).href)).NativeCaptureStore
        : CurrentStore;
const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
        assert.ok(Date.now() < deadline, 'Synthetic close gate was not reached.');
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
};

for (const hold of [false, true])
    test(
        hold
            ? 'begin retains ownership until failed-sync journal close acknowledges'
            : 'sync rejection closes the actual opened journal before begin rejects',
        async (t) => {
            const Store = await storeType();
            const temp = path.resolve(os.tmpdir()),
                profile = await fs.mkdtemp(path.join(temp, 'hub-journal-sync-'));
            const store = await Store.open(profile, { profileOwned: true });
            const open = physicalFS.promises.open;
            let journal: FileHandle | undefined,
                closeCalls = 0,
                closeEntered = false,
                settled = false;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const injected = Object.assign(Error('synthetic-journal-sync-EIO'), { code: 'EIO' });
            const patch = t.mock.method(
                physicalFS.promises,
                'open',
                async (...args: Parameters<typeof open>) => {
                    const handle = await Reflect.apply(open, physicalFS.promises, args);
                    if (path.basename(String(args[0])) === 'raw.jsonl') {
                        journal = handle;
                        const close = handle.close.bind(handle);
                        t.mock.method(handle, 'sync', async () => {
                            throw injected;
                        });
                        t.mock.method(handle, 'close', async () => {
                            closeCalls++;
                            closeEntered = true;
                            if (hold) await gate;
                            await close();
                        });
                    }
                    return handle;
                },
            );
            t.after(async () => {
                release();
                patch.mock.restore();
                t.mock.restoreAll();
                if (journal && journal.fd >= 0) await journal.close();
                await store.close();
                const resolved = path.resolve(profile);
                assert.ok(
                    resolved.startsWith(temp + path.sep) &&
                        path.basename(resolved).startsWith('hub-journal-sync-'),
                );
                await fs.rm(resolved, { recursive: true, force: true });
            });
            const pending = store.begin(header).finally(() => {
                settled = true;
            });
            // Attach the expected rejection immediately while the real close can remain held.
            const rejected = assert.rejects(
                pending,
                (error: any) => error.code === 'io' && error.message.includes(injected.message),
            );
            if (hold) {
                await until(() => closeEntered);
                assert.equal(settled, false);
                assert.equal(Reflect.get(store, 'modifying'), true);
                release();
            }
            await rejected;
            assert.equal(closeCalls, 1, 'begin skipped actual journal close after sync failure.');
            assert.ok(journal);
            assert.equal(journal.fd, -1);
            assert.equal(Reflect.get(store, 'modifying'), false);
            assert.equal(Reflect.get(store, 'active'), undefined);
            assert.deepEqual(
                (await store.page()).records,
                [],
                'Failed initialization published a canonical capture.',
            );
        },
    );

test('a simultaneous sync/close failure preserves both messages and the initial permission classification', async (t) => {
    const Store = await storeType();
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-journal-sync-'));
    const store = await Store.open(profile, { profileOwned: true }),
        open = physicalFS.promises.open;
    let journal: FileHandle | undefined,
        closeCalls = 0;
    const patch = t.mock.method(
        physicalFS.promises,
        'open',
        async (...args: Parameters<typeof open>) => {
            const handle = await Reflect.apply(open, physicalFS.promises, args);
            if (path.basename(String(args[0])) === 'raw.jsonl') {
                journal = handle;
                const close = handle.close.bind(handle);
                t.mock.method(handle, 'sync', async () => {
                    throw Object.assign(Error('synthetic-sync-permission'), { code: 'EACCES' });
                });
                t.mock.method(handle, 'close', async () => {
                    closeCalls++;
                    await close();
                    throw Object.assign(Error('synthetic-close-ack-failure'), { code: 'EIO' });
                });
            }
            return handle;
        },
    );
    t.after(async () => {
        patch.mock.restore();
        t.mock.restoreAll();
        if (journal && journal.fd >= 0) await journal.close();
        await store.close();
        const resolved = path.resolve(profile);
        assert.ok(
            resolved.startsWith(temp + path.sep) &&
                path.basename(resolved).startsWith('hub-journal-sync-'),
        );
        await fs.rm(resolved, { recursive: true, force: true });
    });
    await assert.rejects(
        store.begin(header),
        (error: any) =>
            error.code === 'permission' &&
            error.message.includes('synthetic-sync-permission') &&
            error.message.includes('synthetic-close-ack-failure'),
    );
    assert.equal(closeCalls, 1);
    assert.ok(journal);
    assert.equal(journal.fd, -1);
});
