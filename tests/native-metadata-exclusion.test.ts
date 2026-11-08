import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { FileHandle } from 'node:fs/promises';
import { NativeCaptureStore } from '../electron/capture-store';
import { physicalFS } from '../electron/physical-fs';
import { CaptureRpcServer } from '../shared/capture-rpc';
import { CaptureStorageError, frameCrc } from '../shared/capture-store';
import { deferred, until } from './fixtures/serial-capture';

const stamp = '2026-10-16T00:00:00.000Z';
const header = {
    transport: 'serial' as const,
    receiveTimeSource: 'local-client' as const,
    runId: 'metadata-exclusion',
    stepId: 'one',
    name: 'Synthetic',
    command: 'synthetic',
    startedAt: stamp,
};
const frame = (value: number) => {
    const bytes = new Uint8Array([value, value + 1]);
    return {
        bytes,
        crc32: frameCrc(bytes),
        observation: 0,
        offset: 0,
        totalBytes: bytes.length,
        stream: 'serial' as const,
        receivedAt: stamp,
    };
};
type Opened = { file: string; handle: FileHandle; close: () => Promise<void> };
async function fixture(t: TestContext) {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-meta-exclusion-')),
        store = await NativeCaptureStore.open(profile, { profileOwned: true });
    const pending: Promise<unknown>[] = [],
        releases: (() => void)[] = [],
        opened: Opened[] = [],
        extraStores: NativeCaptureStore[] = [];
    const own = <T>(promise: Promise<T>) => {
        pending.push(promise);
        void promise.catch(() => {});
        return promise;
    };
    const f = {
        t,
        profile,
        store,
        own,
        releases,
        opened,
        extraStores,
        allowUncertainCleanup: false,
        renames: 0,
        queues: () => Reflect.get(store, 'metadataQueues') as Map<string, Promise<void>>,
        uncertain: () =>
            Reflect.get(store, 'metadataUncertain') as Map<string, CaptureStorageError>,
        metadata: (id: string) => path.join(profile, 'captures-v1', id, 'meta.json'),
    };
    t.after(async () => {
        for (const release of releases) release();
        await Promise.allSettled(pending);
        t.mock.restoreAll();
        for (const value of opened) if (value.handle.fd >= 0) await value.close();
        for (const owned of [store, ...extraStores]) {
            const queues = Reflect.get(owned, 'metadataQueues') as Map<string, Promise<void>>,
                uncertain = Reflect.get(owned, 'metadataUncertain') as Map<
                    string,
                    CaptureStorageError
                >;
            if (f.allowUncertainCleanup) {
                assert.ok(opened.every((value) => value.handle.fd === -1));
                uncertain.clear();
            }
            assert.equal(queues.size, 0);
            assert.equal(uncertain.size, 0);
            await owned.close();
        }
        const resolved = path.resolve(profile);
        assert.ok(
            resolved.startsWith(temp + path.sep) &&
                path.basename(resolved).startsWith('hub-meta-exclusion-'),
        );
        await fs.rm(resolved, { recursive: true, force: true });
    });
    const rename = physicalFS.promises.rename;
    t.mock.method(physicalFS.promises, 'rename', async (...args: Parameters<typeof rename>) => {
        if (path.basename(String(args[1])) === 'meta.json') {
            assert.equal(
                opened.filter((row) => row.file === String(args[1]) && row.handle.fd >= 0).length,
                0,
                'Metadata publication raced a live canonical reader.',
            );
            f.renames++;
        }
        return Reflect.apply(rename, physicalFS.promises, args);
    });
    return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function intercept(f: Fixture, configure: (handle: FileHandle, file: string) => void) {
    const open = physicalFS.promises.open;
    f.t.mock.method(physicalFS.promises, 'open', async (...args: Parameters<typeof open>) => {
        const handle = await Reflect.apply(open, physicalFS.promises, args),
            file = String(args[0]);
        f.opened.push({ file, handle, close: handle.close.bind(handle) });
        configure(handle, file);
        return handle;
    });
}
function hold(f: Fixture, handle: FileHandle, method: 'read' | 'sync' | 'close', failure?: Error) {
    const entered = deferred(),
        gate = deferred(),
        original = handle[method].bind(handle) as (...args: any[]) => Promise<any>;
    f.releases.push(() => gate.resolve());
    f.t.mock.method(handle, method, async (...args: any[]) => {
        entered.resolve();
        await gate.promise;
        if (failure) throw failure;
        return original(...args);
    });
    return { entered: entered.promise, release: () => gate.resolve() };
}
async function queued(f: Fixture, id: string, previous: Promise<void> | undefined) {
    await until(() => f.queues().get(id) !== previous && f.queues().has(id));
}
async function verify(f: Fixture, id: string, bytes: number) {
    const sealed = await f.store.seal(id, bytes, 'prompt-observed');
    assert.equal(sealed.committedBytes, bytes);
    assert.equal(sealed.state, 'complete');
    let count = 0;
    for await (const row of f.store.read(id))
        if (row.type === 'frame') count += row.frame.bytes.length;
    assert.equal(count, bytes);
    assert.equal(f.queues().size, 0);
}

test('an open page reader retains the real file until close and backpressures append without data loss', async (t) => {
    const f = await fixture(t),
        capture = await f.store.begin(header),
        file = f.metadata(capture.id);
    let gate: ReturnType<typeof hold> | undefined, reader: FileHandle | undefined;
    intercept(f, (handle, name) => {
        if (name === file && !gate) {
            reader = handle;
            gate = hold(f, handle, 'read');
        }
    });
    const page = f.own(f.store.page());
    await until(() => Boolean(gate));
    await gate!.entered;
    const before = f.queues().get(capture.id),
        append = f.own(f.store.append(capture.id, [frame(65)]));
    await queued(f, capture.id, before);
    assert.ok(reader!.fd >= 0);
    assert.equal(Reflect.get(f.store, 'modifying'), true);
    assert.equal(Reflect.get(f.store, 'listing'), 1);
    await assert.rejects(f.store.close(), (error: any) => error.code === 'busy');
    await assert.rejects(
        f.store.append(capture.id, [frame(70)]),
        (error: any) => error.code === 'backlog',
    );
    gate!.release();
    await page;
    assert.equal(reader!.fd, -1);
    const committed = await append;
    assert.equal(committed.committedBytes, 2);
    await verify(f, capture.id, 2);
});

test('publication queues behind a reader acquired during raw write and precedes later same-capture readers', async (t) => {
    const f = await fixture(t),
        capture = await f.store.begin(header),
        file = f.metadata(capture.id),
        raw = path.join(path.dirname(file), 'raw.jsonl');
    let rawGate: ReturnType<typeof hold> | undefined,
        pageGate: ReturnType<typeof hold> | undefined,
        pageHandle: FileHandle | undefined;
    intercept(f, (handle, name) => {
        if (name === raw && !rawGate) rawGate = hold(f, handle, 'sync');
        if (name === file && rawGate && !pageGate) {
            pageHandle = handle;
            pageGate = hold(f, handle, 'read');
        }
    });
    const append = f.own(f.store.append(capture.id, [frame(65)]));
    await until(() => Boolean(rawGate));
    await rawGate!.entered;
    const page = f.own(f.store.page());
    await until(() => Boolean(pageGate));
    await pageGate!.entered;
    const readerTail = f.queues().get(capture.id);
    rawGate!.release();
    await queued(f, capture.id, readerTail);
    const publisherTail = f.queues().get(capture.id),
        later = f.own(f.store.page());
    await queued(f, capture.id, publisherTail);
    assert.ok(pageHandle!.fd >= 0);
    pageGate!.release();
    await page;
    await append;
    assert.equal((await later).records[0].committedBytes, 2);
    await verify(f, capture.id, 2);
});

test('a new page cannot open canonical metadata while a publication owns its temporary sync', async (t) => {
    const f = await fixture(t),
        capture = await f.store.begin(header),
        file = f.metadata(capture.id);
    let publish: ReturnType<typeof hold> | undefined;
    intercept(f, (handle, name) => {
        if (path.dirname(name) === path.dirname(file) && name.endsWith('.tmp') && !publish)
            publish = hold(f, handle, 'sync');
    });
    const append = f.own(f.store.append(capture.id, [frame(65)]));
    await until(() => Boolean(publish));
    await publish!.entered;
    const before = f.queues().get(capture.id),
        count = f.opened.filter((row) => row.file === file).length,
        page = f.own(f.store.page());
    await queued(f, capture.id, before);
    assert.equal(f.opened.filter((row) => row.file === file).length, count);
    await assert.rejects(f.store.close(), (error: any) => error.code === 'busy');
    publish!.release();
    await append;
    assert.equal((await page).records[0].committedBytes, 2);
    await verify(f, capture.id, 2);
});

test('holding one capture metadata queue does not block a different record', async (t) => {
    const f = await fixture(t),
        first = await f.store.begin(header);
    await f.store.append(first.id, [frame(65)]);
    await f.store.seal(first.id, 2, 'prompt-observed');
    const active = await f.store.begin({ ...header, stepId: 'two' }),
        file = f.metadata(active.id);
    let gate: ReturnType<typeof hold> | undefined;
    intercept(f, (handle, name) => {
        if (name === file && !gate) gate = hold(f, handle, 'read');
    });
    const held = f.own(f.store.page(first.sequence, 1));
    await until(() => Boolean(gate));
    await gate!.entered;
    const before = f.queues().get(active.id),
        append = f.own(f.store.append(active.id, [frame(70)]));
    await queued(f, active.id, before);
    const other = await f.store.page(0, 1, first.sequence);
    assert.equal(other.records[0].id, first.id);
    assert.equal(other.records[0].committedBytes, 2);
    gate!.release();
    await held;
    await append;
    await verify(f, active.id, 2);
});

test('a failed page read still joins real close before a queued writer continues', async (t) => {
    const f = await fixture(t),
        capture = await f.store.begin(header),
        file = f.metadata(capture.id);
    let gate: ReturnType<typeof hold> | undefined;
    intercept(f, (handle, name) => {
        if (name === file && !gate) {
            t.mock.method(handle, 'read', async () => {
                throw Object.assign(Error('synthetic page read failure'), { code: 'EIO' });
            });
            gate = hold(f, handle, 'close');
        }
    });
    const page = f.own(f.store.page());
    await until(() => Boolean(gate));
    await gate!.entered;
    const before = f.queues().get(capture.id),
        append = f.own(f.store.append(capture.id, [frame(65)]));
    await queued(f, capture.id, before);
    gate!.release();
    await assert.rejects(page, /synthetic page read failure/);
    await append;
    assert.equal(f.uncertain().size, 0);
    await verify(f, capture.id, 2);
});

test('failed publication releases its queue and preserves the journal tail without retrying data', async (t) => {
    const f = await fixture(t),
        capture = await f.store.begin(header),
        file = f.metadata(capture.id),
        rename = physicalFS.promises.rename;
    let failed = false,
        attempts = 0;
    t.mock.method(physicalFS.promises, 'rename', async (...args: Parameters<typeof rename>) => {
        if (String(args[1]) === file) {
            attempts++;
            if (!failed) {
                failed = true;
                throw Object.assign(Error('synthetic metadata rename denial'), { code: 'EACCES' });
            }
        }
        return Reflect.apply(rename, physicalFS.promises, args);
    });
    await assert.rejects(
        f.store.append(capture.id, [frame(65)]),
        (error: any) => error.code === 'permission',
    );
    assert.equal(attempts, 1);
    assert.equal((await f.store.page()).records[0].committedBytes, 0);
    assert.equal(f.queues().size, 0);
    assert.equal(f.uncertain().size, 0);
    const names = await fs.readdir(path.dirname(file));
    assert.equal(names.filter((name) => name.endsWith('.tmp')).length, 1);
    await f.store.fail(
        capture.id,
        2,
        new CaptureStorageError('permission', 'fixture publication failure'),
    );
    assert.equal(
        attempts,
        2,
        'Only the distinct failure-status publication follows the failed data publication.',
    );
    const result = (await f.store.page()).records[0];
    assert.equal(result.state, 'incomplete');
    assert.equal(result.committedBytes, 0);
    assert.equal(result.observedBytes, 2);
});

for (const phase of ['read-close', 'validation-close', 'publication-close'] as const)
    test(
        'unacknowledged ' + phase + ' rejects waiters and retains store ownership explicitly',
        async (t) => {
            const f = await fixture(t),
                capture = await f.store.begin(header),
                file = f.metadata(capture.id);
            let gate: ReturnType<typeof hold> | undefined;
            f.allowUncertainCleanup = true;
            intercept(f, (handle, name) => {
                const selected =
                    phase === 'publication-close'
                        ? path.dirname(name) === path.dirname(file) && name.endsWith('.tmp')
                        : name === file;
                if (selected && !gate) {
                    if (phase === 'validation-close')
                        t.mock.method(handle, 'stat', async () => {
                            throw Error('synthetic metadata validation failure');
                        });
                    gate = hold(
                        f,
                        handle,
                        'close',
                        Object.assign(Error('synthetic metadata close not acknowledged'), {
                            code: 'EIO',
                        }),
                    );
                }
            });
            const first = f.own<unknown>(
                phase === 'publication-close'
                    ? f.store.append(capture.id, [frame(65)])
                    : f.store.page(),
            );
            await until(() => Boolean(gate));
            await gate!.entered;
            const before = f.queues().get(capture.id),
                waiting = f.own<unknown>(
                    phase === 'publication-close'
                        ? f.store.page()
                        : f.store.append(capture.id, [frame(65)]),
                );
            await queued(f, capture.id, before);
            gate!.release();
            await assert.rejects(first, /synthetic metadata close not acknowledged/);
            await assert.rejects(waiting, /closure was not confirmed/);
            assert.equal(f.queues().size, 0);
            assert.equal(f.uncertain().size, 1);
            assert.equal(Reflect.get(f.store, 'closed'), false);
            await assert.rejects(f.store.page(), /closure was not confirmed/);
            await assert.rejects(f.store.close(), (error: any) => error.code === 'busy');
            await assert.rejects(
                NativeCaptureStore.open(f.profile, { profileOwned: true }),
                (error: any) => error.code === 'busy',
            );
            // Fault-only teardown below closes the real descriptor, then clears the test store's
            // uncertainty record. Production intentionally supplies no clear/retry operation.
        },
    );

test('RPC reset joins a queued commit and page before ending the old generation', async (t) => {
    const f = await fixture(t),
        server = new CaptureRpcServer(f.store);
    t.after(() => server.dispose());
    const begin = await server.dispatch({ op: 'begin', header });
    assert.equal(begin.ok, true);
    if (!begin.ok) throw Error('No capture');
    const capture = begin.value as any,
        file = f.metadata(capture.id);
    let gate: ReturnType<typeof hold> | undefined;
    intercept(f, (handle, name) => {
        if (name === file && !gate) gate = hold(f, handle, 'read');
    });
    const page = f.own(server.dispatch({ op: 'page' }));
    await until(() => Boolean(gate));
    await gate!.entered;
    const before = f.queues().get(capture.id),
        append = f.own(server.dispatch({ op: 'append', id: capture.id, frames: [frame(65)] }));
    await queued(f, capture.id, before);
    let resetDone = false;
    const reset = f.own(
        server.reset().then(() => {
            resetDone = true;
        }),
    );
    assert.equal(resetDone, false);
    assert.equal(Reflect.get(f.store, 'modifying'), true);
    gate!.release();
    await Promise.all([page, append, reset]);
    assert.equal(resetDone, true);
    assert.equal(f.queues().size, 0);
    assert.equal(f.uncertain().size, 0);
    assert.equal(Reflect.get(f.store, 'active'), undefined);
    const result = (await f.store.page()).records[0];
    assert.equal(result.state, 'incomplete');
    assert.equal(result.committedBytes, 2);
    assert.equal(result.observedBytes, null);
    for (const response of [await page, await append]) {
        assert.equal(response.ok, false);
        if (!response.ok) assert.equal(response.error.code, 'busy');
    }
    await server.dispose();
});

test('failure and cancellation joins do not hold a metadata queue while awaiting append', async (t) => {
    const f = await fixture(t),
        capture = await f.store.begin(header),
        file = f.metadata(capture.id);
    let gate: ReturnType<typeof hold> | undefined;
    intercept(f, (handle, name) => {
        if (name === file && !gate) gate = hold(f, handle, 'read');
    });
    const page = f.own(f.store.page());
    await until(() => Boolean(gate));
    await gate!.entered;
    const before = f.queues().get(capture.id),
        append = f.own(f.store.append(capture.id, [frame(65)]));
    await queued(f, capture.id, before);
    const tail = f.queues().get(capture.id),
        failure = f.own(
            f.store.fail(capture.id, 2, new CaptureStorageError('io', 'synthetic cancellation')),
        );
    assert.equal(f.queues().get(capture.id), tail);
    assert.equal(Reflect.get(f.store, 'active'), capture.id);
    assert.equal(Reflect.get(f.store, 'modifying'), true);
    gate!.release();
    await Promise.all([page, append, failure]);
    const captureAfter = (await f.store.page()).records[0];
    assert.equal(captureAfter.state, 'incomplete');
    assert.equal(captureAfter.committedBytes, 2);
    assert.equal(captureAfter.observedBytes, 2);
    assert.equal(f.queues().size, 0);
});

test('many admitted page callers and one writer drain the same queue without retaining a tail', async (t) => {
    const f = await fixture(t),
        capture = await f.store.begin(header),
        file = f.metadata(capture.id);
    let gate: ReturnType<typeof hold> | undefined;
    intercept(f, (handle, name) => {
        if (name === file && !gate) gate = hold(f, handle, 'read');
    });
    const first = f.own(f.store.page());
    await until(() => Boolean(gate));
    await gate!.entered;
    const before = f.queues().get(capture.id),
        append = f.own(f.store.append(capture.id, [frame(65)]));
    await queued(f, capture.id, before);
    const pages = Array.from({ length: 15 }, () => f.own(f.store.page()));
    assert.equal(Reflect.get(f.store, 'listing'), 16);
    assert.equal(f.queues().size, 1);
    gate!.release();
    await append;
    for (const page of await Promise.all([first, ...pages])) {
        assert.equal(page.records[0].id, capture.id);
        assert.ok([0, 2].includes(page.records[0].committedBytes));
    }
    assert.equal(Reflect.get(f.store, 'listing'), 0);
    await verify(f, capture.id, 2);
});

test('close retains ownership when its own failure publication discovers an unacknowledged reader close', async (t) => {
    const f = await fixture(t),
        capture = await f.store.begin(header),
        file = f.metadata(capture.id);
    let gate: ReturnType<typeof hold> | undefined;
    f.allowUncertainCleanup = true;
    intercept(f, (handle, name) => {
        if (name === file && !gate)
            gate = hold(f, handle, 'close', Error('synthetic close-during-close failure'));
    });
    const closing = f.own(f.store.close());
    await until(() => Boolean(gate));
    await gate!.entered;
    gate!.release();
    await assert.rejects(closing, /close-during-close/);
    assert.equal(Reflect.get(f.store, 'closed'), false);
    assert.equal(f.uncertain().size, 1);
    assert.ok(Reflect.get(f.store, 'catalog'));
    await assert.rejects(
        NativeCaptureStore.open(f.profile, { profileOwned: true }),
        (error: any) => error.code === 'busy',
    );
});

for (const phase of ['reader', 'publisher'] as const)
    test(
        'failed recovery ' + phase + ' close cannot release installation profile ownership',
        async (t) => {
            const f = await fixture(t),
                capture = await f.store.begin(header),
                file = f.metadata(capture.id);
            await f.store.append(capture.id, [frame(65)]);
            const interruptedImage = await fs.readFile(file);
            await f.store.close();
            // Stage only this private fixture's pre-close active metadata to model process interruption.
            await fs.writeFile(file, interruptedImage);
            let gate: ReturnType<typeof hold> | undefined;
            f.allowUncertainCleanup = true;
            const prototype = NativeCaptureStore.prototype as any,
                exclusive = prototype.metadataExclusive;
            t.mock.method(
                prototype,
                'metadataExclusive',
                function (this: NativeCaptureStore, ...args: any[]) {
                    if (this !== f.store && !f.extraStores.includes(this)) f.extraStores.push(this);
                    return Reflect.apply(exclusive, this, args);
                },
            );
            intercept(f, (handle, name) => {
                const chosen =
                    phase === 'reader'
                        ? name === file
                        : path.dirname(name) === path.dirname(file) && name.endsWith('.tmp');
                if (chosen && !gate)
                    gate = hold(f, handle, 'close', Error('synthetic recovery close failure'));
            });
            const opening = f.own(NativeCaptureStore.open(f.profile, { profileOwned: true }));
            await until(() => Boolean(gate));
            await gate!.entered;
            gate!.release();
            await assert.rejects(opening, /recovery close failure/);
            assert.equal(f.extraStores.length, 1);
            assert.equal(
                (Reflect.get(f.extraStores[0], 'metadataUncertain') as Map<unknown, unknown>).size,
                1,
            );
            assert.equal(Reflect.get(f.extraStores[0], 'closed'), false);
            await assert.rejects(
                NativeCaptureStore.open(f.profile, { profileOwned: true }),
                (error: any) => error.code === 'busy',
            );
        },
    );
