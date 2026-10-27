import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Page } from '@playwright/test';
import {
    createProductParentClosureWitness,
    requireProductParentClosure,
    type ProductParentClosure,
} from './fixtures/memory-product-parent-closure';
import { AggregateExportWorker } from './fixtures/memory-product-aggregate-worker';

// Explicit DTO/event models. These controls do not create a browser, token or native worker.
function parentModel(page: object = {}) {
    const state = { host: false, page: false, connection: false, processJoins: 0 };
    let processJoin = async () => {};
    const witness = createProductParentClosureWitness({
        page,
        hostId: 'model-parent',
        hostCleanupVerified: () => state.host,
        pageClosed: () => state.page,
        connectionClosed: () => state.connection,
        joinProcessHistory: async () => {
            state.processJoins++;
            await processJoin();
        },
    });
    return {
        page,
        state,
        witness,
        close() {
            state.host = state.page = state.connection = true;
        },
        processJoin(action: () => Promise<void>) {
            processJoin = action;
        },
    };
}
function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}
async function observerModel() {
    const protocol = new EventEmitter() as EventEmitter & {
        send(): Promise<object>;
        detach(): Promise<void>;
    };
    let detaches = 0;
    let detach = async () => {
        protocol.emit('close');
    };
    protocol.send = async () => ({});
    protocol.detach = async () => {
        detaches++;
        await detach();
    };
    const worker = new EventEmitter() as EventEmitter & {
        url(): string;
        evaluate(): Promise<object>;
    };
    let evaluate = async () => ({});
    worker.url = () => 'http://127.0.0.1:12345/capture-download-sw.js';
    worker.evaluate = () => evaluate();
    const page = {
        url: () => 'http://127.0.0.1:12345/',
        context: () => ({
            newCDPSession: async () => protocol,
            serviceWorkers: () => [worker],
        }),
    };
    const events: { stage: string; data: unknown }[] = [];
    let emitFailure: unknown;
    let disposalEvidence = async () => {};
    const observer = new AggregateExportWorker(page as unknown as Page, async (stage, data) => {
        if (stage === 'aggregate-service-worker-observer-disposed') {
            await disposalEvidence();
            if (emitFailure) throw emitFailure;
        }
        events.push({ stage, data });
    });
    await observer.initialize();
    await observer.faults.status(); // Admit the actual observer's worker-close subscription.
    const parent = parentModel(page);
    return {
        observer,
        worker,
        protocol,
        parent,
        events,
        detaches: () => detaches,
        detach(action: () => Promise<void>) {
            detach = action;
        },
        evaluate(action: () => Promise<object>) {
            evaluate = action;
        },
        failDisposalEvidence(error: unknown) {
            emitFailure = error;
        },
        disposalEvidence(action: () => Promise<void>) {
            disposalEvidence = action;
        },
    };
}

test('parent witness refuses missing host/page/connection closure before process join', async () => {
    const model = parentModel();
    await assert.rejects(model.witness.join(), /host cleanup is unverified/);
    model.state.host = true;
    await assert.rejects(model.witness.join(), /parent page remains live/);
    model.state.page = true;
    await assert.rejects(model.witness.join(), /parent connection remains live/);
    assert.equal(model.state.processJoins, 0);
});
test('parent witness retains process-history failure and rechecks state after the join', async () => {
    const model = parentModel();
    model.close();
    const error = Error('Exact PID/creation is unknown.');
    model.processJoin(async () => {
        throw error;
    });
    await assert.rejects(model.witness.join(), (actual) => actual === error);
    model.processJoin(async () => {
        model.state.connection = false;
    });
    await assert.rejects(model.witness.join(), /parent connection remains live/);
});
test('parent receipt is exact-page bound, immutable and not accepted after copying', async () => {
    const model = parentModel();
    model.close();
    const receipt = await model.witness.join();
    assert.equal(requireProductParentClosure(receipt, model.page), receipt);
    assert.equal(Object.isFrozen(receipt), true);
    assert.throws(() => requireProductParentClosure(receipt, {}), /unrelated/);
    assert.throws(() => requireProductParentClosure({ ...receipt }, model.page), /forged/);
    assert.equal(await model.witness.join(), receipt);
    assert.equal(model.state.processJoins, 2);
});
test('ordinary live detach joins notification and releases only owned listeners once', async () => {
    const model = await observerModel();
    const foreign = () => {};
    model.protocol.on('close', foreign);
    model.worker.emit('close');
    const receipt = await model.observer.dispose();
    assert.equal(receipt.disposition, 'detached-live-session');
    assert.equal(receipt.retired, 0);
    assert.equal(model.detaches(), 1);
    assert.deepEqual(model.protocol.listeners('close'), [foreign]);
    assert.equal(model.protocol.listenerCount('ServiceWorker.workerVersionUpdated'), 0);
    assert.equal(model.worker.listenerCount('close'), 0);
    assert.equal(await model.observer.dispose(), receipt);
    assert.equal(model.detaches(), 1);
});
test('session close before host join needs no redundant RPC', async () => {
    const model = await observerModel();
    model.worker.emit('close');
    model.protocol.emit('close');
    const receipt = await model.observer.dispose();
    assert.equal(receipt.disposition, 'session-close-observed');
    assert.equal(model.detaches(), 0);
});
test('verified parent closure disposes without a missing session-close notification', async () => {
    const model = await observerModel();
    model.worker.emit('close');
    model.parent.close();
    model.detach(async () => {
        throw Error('RPC to a dead transport must not be invoked.');
    });
    const receipt = await model.observer.dispose(await model.parent.witness.join());
    assert.equal(receipt.disposition, 'disposed-by-verified-parent-closure');
    assert.equal(receipt.protocolCloseObserved, false);
    assert.equal(receipt.workerCloseObserved, true);
    assert.equal(receipt.retired, 0);
    assert.equal(model.detaches(), 0);
    assert.equal(model.protocol.listenerCount('close'), 0);
    assert.equal(model.protocol.listenerCount('ServiceWorker.workerVersionUpdated'), 0);
    assert.equal(model.events.filter((row) => row.stage.endsWith('observer-disposed')).length, 1);
});
test('forged or foreign parent receipt cannot release observer ownership', async () => {
    const model = await observerModel();
    model.worker.emit('close');
    await assert.rejects(model.observer.dispose({} as ProductParentClosure), /forged/);
    const foreign = parentModel();
    foreign.close();
    await assert.rejects(model.observer.dispose(await foreign.witness.join()), /unrelated/);
    assert.equal(model.protocol.listenerCount('ServiceWorker.workerVersionUpdated'), 1);
    assert.equal(model.detaches(), 0);
});
test('live-parent detach failure remains a failure and retains local observation', async () => {
    const model = await observerModel();
    model.worker.emit('close');
    const failure = Error('Live detach refused.');
    model.detach(async () => {
        throw failure;
    });
    await assert.rejects(model.observer.dispose(), (error) => error === failure);
    assert.equal(model.protocol.listenerCount('ServiceWorker.workerVersionUpdated'), 1);
    assert.equal(
        model.events.some((row) => row.stage.endsWith('observer-disposed')),
        false,
    );
    // A later actual parent join can establish cleanup, without rewriting the first rejection.
    model.parent.close();
    const receipt = await model.observer.dispose(await model.parent.witness.join());
    assert.equal(receipt.disposition, 'disposed-by-verified-parent-closure');
    assert.equal(model.detaches(), 1);
});
test('parent receipt cannot settle an unobserved worker-close promise', async () => {
    const model = await observerModel();
    model.parent.close();
    const closure = await model.parent.witness.join();
    await assert.rejects(model.observer.dispose(closure), /before its close notification/);
    assert.equal(model.protocol.listenerCount('ServiceWorker.workerVersionUpdated'), 1);
    model.worker.emit('close');
    assert.equal((await model.observer.dispose(closure)).retired, 0);
});
test('pending actual evaluation must settle before parent-closure disposal', async () => {
    const model = await observerModel();
    const held = deferred<object>();
    const entered = deferred();
    model.evaluate(() => {
        entered.resolve();
        return held.promise;
    });
    const status = model.observer.faults.status();
    await entered.promise;
    model.worker.emit('close');
    model.parent.close();
    const closure = await model.parent.witness.join();
    await assert.rejects(model.observer.dispose(closure), /unjoined|pending/i);
    assert.equal(model.protocol.listenerCount('ServiceWorker.workerVersionUpdated'), 1);
    held.resolve({});
    await status;
    assert.equal((await model.observer.dispose(closure)).retired, 0);
});
test('concurrent disposal joins one detach and one release receipt', async () => {
    const model = await observerModel();
    const held = deferred();
    model.worker.emit('close');
    model.detach(async () => {
        await held.promise;
        model.protocol.emit('close');
    });
    const a = model.observer.dispose();
    const b = model.observer.dispose();
    held.resolve();
    const [first, second] = await Promise.all([a, b]);
    assert.equal(first, second);
    assert.equal(model.detaches(), 1);
    assert.equal(model.events.filter((row) => row.stage.endsWith('observer-disposed')).length, 1);
});
test('failed disposal evidence stays failed on reentry even after local listeners release', async () => {
    const model = await observerModel();
    model.worker.emit('close');
    const failure = Error('Create-only evidence write failed.');
    model.failDisposalEvidence(failure);
    await assert.rejects(model.observer.dispose(), (error) => error === failure);
    assert.equal(model.protocol.listenerCount('ServiceWorker.workerVersionUpdated'), 0);
    await assert.rejects(model.observer.dispose(), (error) => error === failure);
    assert.equal(model.detaches(), 1);
});

function observeSettlement<T>(promise: Promise<T>) {
    let state = 'pending';
    const result = promise.then(
        (value) => {
            state = 'resolved';
            return { kind: 'resolved' as const, value };
        },
        (error: unknown) => {
            state = 'rejected';
            return { kind: 'rejected' as const, error };
        },
    );
    return { state: () => state, result };
}
async function modelTicks() {
    for (let ordinal = 0; ordinal < 5; ordinal++) await Promise.resolve();
}
for (const mode of ['session-close-observed', 'verified-parent-closure', 'live-detach']) {
    for (const rejectEvidence of [false, true]) {
        test(`${mode}: overlapping callers wait for ${rejectEvidence ? 'rejected' : 'successful'} evidence`, async () => {
            const model = await observerModel();
            const entered = deferred(),
                write = deferred();
            const failure = Error('Deferred evidence write failed.');
            model.worker.emit('close');
            let closure: ProductParentClosure | undefined;
            if (mode === 'verified-parent-closure') {
                model.parent.close();
                closure = await model.parent.witness.join();
            } else if (mode === 'session-close-observed') model.protocol.emit('close');
            model.disposalEvidence(async () => {
                entered.resolve();
                await write.promise;
                if (rejectEvidence) throw failure;
            });
            const first = observeSettlement(model.observer.dispose(closure));
            await entered.promise;
            assert.equal(model.protocol.listenerCount('ServiceWorker.workerVersionUpdated'), 0);
            const second = observeSettlement(model.observer.dispose(closure));
            await modelTicks();
            assert.equal(first.state(), 'pending');
            assert.equal(
                second.state(),
                'pending',
                'No cached success before evidence settlement.',
            );
            write.resolve();
            const [a, b] = await Promise.all([first.result, second.result]);
            if (rejectEvidence) {
                assert.equal(a.kind, 'rejected');
                assert.equal(b.kind, 'rejected');
                if (a.kind !== 'rejected' || b.kind !== 'rejected') throw Error('Wrong verdict.');
                assert.equal(a.error, failure);
                assert.equal(b.error, failure);
                await assert.rejects(model.observer.dispose(closure), (error) => error === failure);
            } else {
                assert.equal(a.kind, 'resolved');
                assert.equal(b.kind, 'resolved');
                if (a.kind !== 'resolved' || b.kind !== 'resolved') throw Error('Wrong verdict.');
                assert.equal(a.value, b.value);
                assert.equal(await model.observer.dispose(closure), a.value);
            }
            assert.equal(model.detaches(), Number(mode === 'live-detach'));
            assert.equal(
                model.events.filter((row) => row.stage.endsWith('observer-disposed')).length,
                Number(!rejectEvidence),
            );
        });
    }
}
for (const rejectEvidence of [false, true]) {
    test(`synchronous evidence callback reentry joins ${rejectEvidence ? 'failure' : 'success'}`, async () => {
        const model = await observerModel();
        const entered = deferred(),
            write = deferred();
        const failure = Error('Reentrant evidence failed.');
        let nested: ReturnType<typeof observeSettlement<unknown>> | undefined;
        model.worker.emit('close');
        model.protocol.emit('close');
        model.disposalEvidence(async () => {
            nested = observeSettlement(model.observer.dispose());
            entered.resolve();
            await write.promise;
            if (rejectEvidence) throw failure;
        });
        const outer = observeSettlement(model.observer.dispose());
        await entered.promise;
        await modelTicks();
        assert.ok(nested);
        assert.equal(nested.state(), 'pending');
        assert.equal(outer.state(), 'pending');
        write.resolve();
        const [a, b] = await Promise.all([outer.result, nested.result]);
        assert.equal(a.kind, rejectEvidence ? 'rejected' : 'resolved');
        assert.equal(b.kind, a.kind);
        if (a.kind === 'rejected' && b.kind === 'rejected') {
            assert.equal(a.error, failure);
            assert.equal(b.error, failure);
        } else if (a.kind === 'resolved' && b.kind === 'resolved') assert.equal(a.value, b.value);
    });
}
test('terminal evidence failure keeps new worker/protocol admission closed', async () => {
    const model = await observerModel();
    const failure = Error('Terminal evidence failure.');
    model.worker.emit('close');
    model.protocol.emit('close');
    model.failDisposalEvidence(failure);
    await assert.rejects(model.observer.dispose(), (error) => error === failure);
    await assert.rejects(model.observer.faults.status(), /admission is closed/);
    await assert.rejects(model.observer.initialize(), /initialized twice/);
    assert.equal(model.worker.listenerCount('close'), 0);
});
