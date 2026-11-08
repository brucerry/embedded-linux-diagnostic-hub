import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FileHandle } from 'node:fs/promises';
import type { NativeCaptureStore as Store } from '../electron/capture-store';
import { deferred, until } from './fixtures/serial-capture';

const source =
    process.env.HUB_JSON_OLD_SOURCE ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let NativeCaptureStore: typeof import('../electron/capture-store').NativeCaptureStore;
let physicalFS: typeof import('../electron/physical-fs').physicalFS;
const implementation = Promise.all([
    import(pathToFileURL(path.join(source, 'electron/capture-store.ts')).href),
    import(pathToFileURL(path.join(source, 'electron/physical-fs.ts')).href),
]).then(([store, physical]) => {
    NativeCaptureStore = store.NativeCaptureStore;
    physicalFS = physical.physicalFS;
});
const stamp = '2026-10-16T00:00:00.000Z';
const header = {
    transport: 'serial' as const,
    receiveTimeSource: 'local-client' as const,
    runId: 'json-owners',
    stepId: 'one',
    name: 'Synthetic',
    command: 'synthetic',
    startedAt: stamp,
};
const outcome = {
    id: 'a'.repeat(32),
    ordinal: 1,
    completion: 'prompt-observed' as const,
    exitCode: null,
    truncated: false,
    completedAt: stamp,
    localZone: 'UTC',
    durationMs: 1,
    deviceTime: null,
};
type Opened = { file: string; handle: FileHandle; close: () => Promise<void> };
async function fixture(t: TestContext) {
    await implementation;
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-json-owners-'));
    const stores = new Set<Store>(),
        pending: Promise<unknown>[] = [],
        releases: (() => void)[] = [],
        opened: Opened[] = [];
    const prototype = NativeCaptureStore.prototype as any,
        recover = prototype.recover;
    t.mock.method(prototype, 'recover', function (this: Store, ...args: any[]) {
        stores.add(this);
        return Reflect.apply(recover, this, args);
    });
    const own = <T>(promise: Promise<T>) => {
        pending.push(promise);
        void promise.catch(() => {});
        return promise;
    };
    const store = await NativeCaptureStore.open(profile, { profileOwned: true });
    t.after(async () => {
        for (const release of releases) release();
        await Promise.allSettled(pending);
        t.mock.restoreAll();
        for (const row of opened) if (row.handle.fd >= 0) await row.close();
        assert.ok(opened.every((row) => row.handle.fd === -1));
        for (const current of stores) {
            const operations = Reflect.get(current, 'jsonOperations') as
                Map<string, number> | undefined;
            if (operations) assert.equal(operations.size, 0);
            // Fixture-only fault recovery, after every real descriptor is actually closed.
            (Reflect.get(current, 'metadataUncertain') as Map<unknown, unknown>).clear();
            await current.close();
        }
        const resolved = path.resolve(profile);
        assert.ok(
            resolved.startsWith(temp + path.sep) &&
                path.basename(resolved).startsWith('hub-json-owners-'),
        );
        await fs.rm(resolved, { recursive: true, force: true });
    });
    return {
        t,
        profile,
        store,
        stores,
        own,
        releases,
        opened,
        root: path.join(profile, 'captures-v1'),
        open: () => NativeCaptureStore.open(profile, { profileOwned: true }),
    };
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
function holdClose(f: Fixture, handle: FileHandle, fail: boolean) {
    const entered = deferred(),
        gate = deferred(),
        close = handle.close.bind(handle);
    f.releases.push(() => gate.resolve());
    f.t.mock.method(handle, 'close', async () => {
        entered.resolve();
        await gate.promise;
        if (fail) throw Error('synthetic unacknowledged JSON close');
        await close();
    });
    return { entered: entered.promise, release: () => gate.resolve() };
}
async function sealed(f: Fixture, recorded = false) {
    const capture = await f.store.begin(header);
    await f.store.seal(capture.id, 0, 'empty');
    if (recorded) await f.store.record(capture.id, outcome);
    return capture;
}
const busy = (error: any) => error.code === 'busy';
const phases = [
    'sequence-read',
    'sequence-write',
    'pending-write',
    'result-read',
    'result-write',
] as const;
for (const phase of phases)
    for (const validation of [false, true])
        test(`${phase} ${validation ? 'validation cleanup' : 'ordinary'} close failure retains installation ownership`, async (t) => {
            const f = await fixture(t);
            let id = '';
            if (phase === 'sequence-read' || phase.startsWith('result-')) {
                id = (await sealed(f, phase === 'result-read')).id;
                if (phase === 'sequence-read') await f.store.close();
            }
            let gate: ReturnType<typeof holdClose> | undefined, held: FileHandle | undefined;
            intercept(f, (handle, file) => {
                const temporary = path.basename(file).startsWith('meta-') && file.endsWith('.tmp');
                const chosen =
                    phase === 'sequence-read'
                        ? file === path.join(f.root, 'sequence.json')
                        : phase === 'sequence-write'
                          ? temporary && path.dirname(file) === f.root
                          : phase === 'pending-write'
                            ? temporary && path.basename(path.dirname(file)).startsWith('.pending-')
                            : phase === 'result-read'
                              ? file === path.join(f.root, id, 'result.json')
                              : temporary && path.dirname(file) === path.join(f.root, id);
                if (!chosen || gate) return;
                held = handle;
                gate = holdClose(f, handle, true);
                if (validation) {
                    const stat = handle.stat.bind(handle);
                    t.mock.method(handle, 'stat', async () => {
                        const value = await stat();
                        value.nlink = 2;
                        return value;
                    });
                }
            });
            const operation = f.own<unknown>(
                phase === 'sequence-read'
                    ? f.open()
                    : phase === 'result-read'
                      ? f.store.result(id)
                      : phase === 'result-write'
                        ? f.store.record(id, outcome)
                        : f.store.begin(header),
            );
            await until(() => Boolean(gate));
            await gate!.entered;
            if (phase !== 'sequence-read') await assert.rejects(f.store.close(), busy);
            await assert.rejects(f.open(), busy);
            assert.ok(held!.fd >= 0);
            gate!.release();
            await assert.rejects(operation, /unacknowledged JSON close/);
            const current =
                phase === 'sequence-read'
                    ? [...f.stores].find((value) => value !== f.store)!
                    : f.store;
            assert.ok(current);
            await assert.rejects(f.open(), busy);
            await assert.rejects(current.close(), busy);
            assert.equal(Reflect.get(current, 'closed'), false);
            assert.equal(
                (Reflect.get(current, 'metadataUncertain') as Map<unknown, unknown>).size,
                1,
            );
            assert.equal((Reflect.get(current, 'jsonOperations') as Map<unknown, unknown>).size, 0);
            await assert.rejects(current.page(), /closure was not confirmed/);
            assert.ok(held!.fd >= 0);
        });

for (const phase of ['folder-validation', 'close'] as const)
    test(`a pending result ${phase} owns store closure and record deletion through actual close`, async (t) => {
        const f = await fixture(t),
            capture = await sealed(f, true),
            folder = path.join(f.root, capture.id),
            entered = deferred(),
            gate = deferred();
        f.releases.push(() => gate.resolve());
        let handle: FileHandle | undefined;
        if (phase === 'folder-validation') {
            const lstat = physicalFS.promises.lstat;
            t.mock.method(
                physicalFS.promises,
                'lstat',
                async (...args: Parameters<typeof lstat>) => {
                    if (String(args[0]) === folder) {
                        entered.resolve();
                        await gate.promise;
                    }
                    return Reflect.apply(lstat, physicalFS.promises, args);
                },
            );
        } else
            intercept(f, (value, file) => {
                if (file === path.join(folder, 'result.json')) {
                    handle = value;
                    const close = value.close.bind(value);
                    t.mock.method(value, 'close', async () => {
                        entered.resolve();
                        await gate.promise;
                        await close();
                    });
                }
            });
        const reading = f.own(f.store.result(capture.id));
        await entered.promise;
        await assert.rejects(f.store.close(), busy);
        await assert.rejects(f.store.delete(capture.id), busy);
        await assert.rejects(f.open(), busy);
        gate.resolve();
        assert.deepEqual(await reading, outcome);
        if (handle) assert.equal(handle.fd, -1);
        assert.equal((Reflect.get(f.store, 'jsonOperations') as Map<unknown, unknown>).size, 0);
        await f.store.delete(capture.id);
        await f.store.close();
        await f.open();
    });

test('two result readers retain a counted owner until the final actual close without serializing readers', async (t) => {
    const f = await fixture(t),
        capture = await sealed(f, true);
    let gate: ReturnType<typeof holdClose> | undefined, handle: FileHandle | undefined;
    intercept(f, (value, file) => {
        if (file === path.join(f.root, capture.id, 'result.json') && !gate) {
            handle = value;
            gate = holdClose(f, value, false);
        }
    });
    const first = f.own(f.store.result(capture.id));
    await until(() => Boolean(gate));
    await gate!.entered;
    assert.deepEqual(await f.store.result(capture.id), outcome);
    assert.equal(
        (Reflect.get(f.store, 'jsonOperations') as Map<string, number>).get(
            capture.id + '/result.json',
        ),
        1,
    );
    assert.ok(handle!.fd >= 0);
    await assert.rejects(f.store.close(), busy);
    gate!.release();
    assert.deepEqual(await first, outcome);
    assert.equal(handle!.fd, -1);
});

test('result read errors with acknowledged close release ownership and allow a later healthy result read', async (t) => {
    const f = await fixture(t),
        capture = await sealed(f, true);
    let selected: FileHandle | undefined;
    intercept(f, (handle, file) => {
        if (!selected && file === path.join(f.root, capture.id, 'result.json')) {
            selected = handle;
            t.mock.method(handle, 'read', async () => {
                throw Object.assign(Error('synthetic result read error'), { code: 'EIO' });
            });
        }
    });
    await assert.rejects(f.store.result(capture.id), /result read error/);
    assert.equal(selected!.fd, -1);
    assert.equal((Reflect.get(f.store, 'jsonOperations') as Map<unknown, unknown>).size, 0);
    assert.equal((Reflect.get(f.store, 'metadataUncertain') as Map<unknown, unknown>).size, 0);
    assert.deepEqual(await f.store.result(capture.id), outcome);
    await f.store.close();
    await f.open();
});

test('result admission refuses an already owned record deletion without opening JSON', async (t) => {
    const f = await fixture(t),
        capture = await sealed(f, true),
        entered = deferred(),
        gate = deferred(),
        rename = physicalFS.promises.rename;
    f.releases.push(() => gate.resolve());
    t.mock.method(physicalFS.promises, 'rename', async (...args: Parameters<typeof rename>) => {
        if (String(args[0]) === path.join(f.root, capture.id)) {
            entered.resolve();
            await gate.promise;
        }
        return Reflect.apply(rename, physicalFS.promises, args);
    });
    const deleting = f.own(f.store.delete(capture.id));
    await entered.promise;
    await assert.rejects(f.store.result(capture.id), busy);
    gate.resolve();
    await deleting;
});

test('closing admission rejects new work while asynchronous catalog cleanup still owns the profile', async (t) => {
    const f = await fixture(t),
        capture = await sealed(f, true),
        catalogFile = Reflect.get(f.store, 'catalogFile') as string;
    assert.equal(typeof catalogFile, 'string');
    const entered = deferred(),
        gate = deferred(),
        unlink = physicalFS.promises.unlink;
    f.releases.push(() => gate.resolve());
    t.mock.method(physicalFS.promises, 'unlink', async (...args: Parameters<typeof unlink>) => {
        if (String(args[0]) === catalogFile) {
            entered.resolve();
            await gate.promise;
        }
        return Reflect.apply(unlink, physicalFS.promises, args);
    });
    const closing = f.own(f.store.close());
    await entered.promise;
    assert.equal(Reflect.get(f.store, 'closed'), false);
    await assert.rejects(f.store.result(capture.id), busy);
    await assert.rejects(f.store.page(), busy);
    await assert.rejects(f.store.begin(header), busy);
    await assert.rejects(f.store.close(), busy);
    await assert.rejects(f.open(), busy);
    gate.resolve();
    await closing;
    assert.equal(Reflect.get(f.store, 'closing'), false);
    await f.open();
});

test('close rechecks JSON owners admitted while its active-capture failure publication was pending', async (t) => {
    const f = await fixture(t),
        saved = await sealed(f, true),
        active = await f.store.begin(header);
    let failing: ReturnType<typeof holdClose> | undefined,
        reading: ReturnType<typeof holdClose> | undefined;
    intercept(f, (handle, file) => {
        if (file === path.join(f.root, active.id, 'meta.json') && !failing)
            failing = holdClose(f, handle, false);
        if (file === path.join(f.root, saved.id, 'result.json') && !reading)
            reading = holdClose(f, handle, false);
    });
    const closing = f.own(f.store.close());
    await until(() => Boolean(failing));
    await failing!.entered;
    const result = f.own(f.store.result(saved.id));
    await until(() => Boolean(reading));
    await reading!.entered;
    failing!.release();
    await assert.rejects(closing, busy);
    assert.equal(Reflect.get(f.store, 'closed'), false);
    assert.equal(Reflect.get(f.store, 'closing'), false);
    await assert.rejects(f.open(), busy);
    reading!.release();
    assert.deepEqual(await result, outcome);
    await f.store.close();
    await f.open();
});

for (const ordering of [
    'uncertain-before-success-return',
    'prior-publication-error',
    'healthy-complete',
    'pending-fault',
] as const)
    test(`close acknowledgement ordering: ${ordering}`, async (t) => {
        const f = await fixture(t),
            saved = await sealed(f, true),
            active = await f.store.begin(header),
            publication = path.join(f.root, active.id, 'meta.json');
        let initial: ReturnType<typeof holdClose> | undefined,
            reading: ReturnType<typeof holdClose> | undefined,
            result: Promise<unknown> | undefined,
            classifiedPublicationError: unknown;
        intercept(f, (handle, file) => {
            if (file === publication && !initial) initial = holdClose(f, handle, false);
            if (file === path.join(f.root, saved.id, 'result.json') && !reading)
                reading = holdClose(f, handle, ordering !== 'healthy-complete');
        });
        const fail = f.store.fail.bind(f.store);
        t.mock.method(f.store, 'fail', async (...args: Parameters<typeof fail>) => {
            try {
                return await fail(...args);
            } catch (error) {
                classifiedPublicationError = error;
                throw error;
            }
        });
        const rename = physicalFS.promises.rename,
            syntheticPublicationError = Object.assign(
                Error('synthetic first publication failure'),
                {
                    code: 'EIO',
                },
            );
        t.mock.method(physicalFS.promises, 'rename', async (...args: Parameters<typeof rename>) => {
            if (String(args[1]) !== publication)
                return Reflect.apply(rename, physicalFS.promises, args);
            if (ordering !== 'prior-publication-error')
                await Reflect.apply(rename, physicalFS.promises, args);
            if (ordering !== 'pending-fault') {
                reading!.release();
                await result!.catch(() => {});
            }
            if (ordering === 'prior-publication-error') throw syntheticPublicationError;
        });
        const closing = f.own(f.store.close());
        await until(() => Boolean(initial));
        await initial!.entered;
        result = f.own(f.store.result(saved.id));
        await until(() => Boolean(reading));
        await reading!.entered;
        initial!.release();
        if (ordering === 'healthy-complete') {
            await closing;
            assert.deepEqual(await result, outcome);
            assert.equal(Reflect.get(f.store, 'closed'), true);
            assert.equal(
                (Reflect.get(f.store, 'metadataUncertain') as Map<unknown, unknown>).size,
                0,
            );
            await f.open();
            return;
        }
        if (ordering === 'prior-publication-error')
            await assert.rejects(closing, (error) => {
                assert.match((error as Error).message, /synthetic first publication failure/);
                assert.equal(error, classifiedPublicationError);
                return true;
            });
        else await assert.rejects(closing, busy);
        if (ordering === 'pending-fault') reading!.release();
        await assert.rejects(result, /unacknowledged JSON close/);
        assert.equal(Reflect.get(f.store, 'closed'), false);
        assert.equal(Reflect.get(f.store, 'closing'), false);
        assert.equal(Reflect.get(f.store, 'active'), undefined);
        assert.equal((Reflect.get(f.store, 'metadataUncertain') as Map<unknown, unknown>).size, 1);
        assert.equal((Reflect.get(f.store, 'jsonOperations') as Map<unknown, unknown>).size, 0);
        assert.equal((Reflect.get(f.store, 'metadataQueues') as Map<unknown, unknown>).size, 0);
        await assert.rejects(f.open(), busy);
        await assert.rejects(f.store.close(), busy);
    });
