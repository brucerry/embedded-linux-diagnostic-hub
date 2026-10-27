import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeCaptureHost } from '../electron/capture-host';
import { NativeCaptureStore } from '../electron/capture-store';
import { CaptureRpcServer } from '../shared/capture-rpc';
import { CaptureWriter } from '../shared/capture-writer';
import { NativeCaptureRepository } from '../src/features/automation/capture/native-repository';
import { deferred, until } from './fixtures/serial-capture';

async function fixture(t: TestContext, exportFails = false) {
    const temporary = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temporary, 'hub-capture-shutdown-review-')),
        gate = deferred();
    let selecting = false;
    const destination = path.join(
            profile,
            exportFails ? 'missing-parent/export.json' : 'export.json',
        ),
        host = await NativeCaptureHost.open(profile, { profileOwned: true }, async () => {
            selecting = true;
            await gate.promise;
            return destination;
        }),
        store = (host as unknown as { store: NativeCaptureStore }).store,
        close = NativeCaptureStore.prototype.close,
        proxy = await NativeCaptureRepository.open((request) => host.dispatch(request)),
        writer = await CaptureWriter.begin(proxy, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'shutdown-review',
            stepId: 'one',
            name: 'Synthetic only',
            command: 'fixture',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
    await writer.append(
        new TextEncoder().encode('retained exact bytes'),
        '2026-10-15T00:00:00.000Z',
        'serial',
    );
    const capture = await writer.finish('prompt-observed');
    const exporting = host.dispatch({ op: 'export', format: 'json', scope: { ids: [capture.id] } });
    await until(() => selecting);
    t.after(async () => {
        gate.resolve();
        await exporting;
        await host.shutdown().catch(() => {});
        await close.call(store).catch(() => {});
        assert.ok(
            path.resolve(profile).startsWith(temporary + path.sep) &&
                path.basename(profile).startsWith('hub-capture-shutdown-review-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    });
    return { host, store, destination, gate, exporting };
}

test('disposal failure cannot bypass a pending native export or the final storage close', async (t) => {
    const { host, destination, gate, exporting } = await fixture(t),
        dispose = CaptureRpcServer.prototype.dispose,
        close = NativeCaptureStore.prototype.close,
        disposalFailure = Error('Injected renderer disposal failure');
    let disposed = false,
        closed = 0,
        settled = false;
    t.mock.method(CaptureRpcServer.prototype, 'dispose', async function (this: CaptureRpcServer) {
        await dispose.call(this);
        disposed = true;
        throw disposalFailure;
    });
    t.mock.method(NativeCaptureStore.prototype, 'close', async function (this: NativeCaptureStore) {
        closed++;
        return close.call(this);
    });
    const shutting = host.shutdown();
    void shutting.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    assert.equal(host.shutdown(), shutting, 'Repeated shutdown must join the same cleanup.');
    await until(() => disposed);
    await new Promise((resolve) => setImmediate(resolve));
    try {
        assert.equal(
            settled,
            false,
            'Disposal failure must not let quit overtake the pending export.',
        );
        assert.equal(closed, 0);
        assert.equal((await host.dispatch({ op: 'info' })).ok, false);
        gate.resolve();
        assert.equal((await exporting).ok, true);
        await assert.rejects(shutting, (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [disposalFailure]);
            assert.match(error.message, /renderer disposal failure/);
            return true;
        });
        assert.equal(closed, 1);
        const json = JSON.parse(await fs.readFile(destination, 'utf8'));
        assert.equal(
            Buffer.from(json.captures[0].rawObservations[0].base64, 'base64').toString(),
            'retained exact bytes',
        );
    } finally {
        gate.resolve();
    }
});

test('shutdown attempts storage closure after disposal and pending-export failures and reports every failure', async (t) => {
    const { host, gate, exporting } = await fixture(t, true),
        dispose = CaptureRpcServer.prototype.dispose,
        close = NativeCaptureStore.prototype.close,
        disposalFailure = Error('Injected dispose failure'),
        closeFailure = Error('Injected close acknowledgement failure');
    let disposed = false,
        closeAttempts = 0,
        settled = false;
    t.mock.method(CaptureRpcServer.prototype, 'dispose', async function (this: CaptureRpcServer) {
        await dispose.call(this);
        disposed = true;
        throw disposalFailure;
    });
    t.mock.method(NativeCaptureStore.prototype, 'close', async function (this: NativeCaptureStore) {
        closeAttempts++;
        await close.call(this);
        throw closeFailure;
    });
    const shutting = host.shutdown();
    void shutting.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    await until(() => disposed);
    await new Promise((resolve) => setImmediate(resolve));
    try {
        assert.equal(settled, false);
        assert.equal(closeAttempts, 0);
        gate.resolve();
        assert.equal((await exporting).ok, false);
        await assert.rejects(shutting, (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors.length, 3);
            assert.equal(error.errors[0], disposalFailure);
            assert.match(String(error.errors[1]), /ENOENT|cannot find/i);
            assert.equal(error.errors[2], closeFailure);
            assert.match(error.message, /dispose failure/);
            assert.match(error.message, /close acknowledgement failure/);
            return true;
        });
        assert.equal(closeAttempts, 1);
    } finally {
        gate.resolve();
    }
});

test('shutdown retains an export failure that settles while renderer disposal is still pending', async (t) => {
    const { host, gate, exporting } = await fixture(t, true),
        dispose = CaptureRpcServer.prototype.dispose,
        close = NativeCaptureStore.prototype.close,
        disposalGate = deferred(),
        disposalFailure = Error('Delayed renderer disposal failure');
    let disposing = false,
        closeAttempts = 0;
    t.mock.method(CaptureRpcServer.prototype, 'dispose', async function (this: CaptureRpcServer) {
        await dispose.call(this);
        disposing = true;
        await disposalGate.promise;
        throw disposalFailure;
    });
    t.mock.method(NativeCaptureStore.prototype, 'close', async function (this: NativeCaptureStore) {
        closeAttempts++;
        return close.call(this);
    });
    const shutting = host.shutdown();
    void shutting.catch(() => {});
    try {
        await until(() => disposing);
        gate.resolve();
        assert.equal((await exporting).ok, false);
        assert.equal(closeAttempts, 0);
        disposalGate.resolve();
        await assert.rejects(shutting, (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(
                error.errors.length,
                2,
                'The export pending at shutdown entry must remain part of its joined outcome.',
            );
            assert.equal(error.errors[0], disposalFailure);
            assert.match(String(error.errors[1]), /ENOENT|cannot find/i);
            return true;
        });
        assert.equal(closeAttempts, 1);
    } finally {
        gate.resolve();
        disposalGate.resolve();
    }
});
