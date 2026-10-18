/** Controller admission models use the real coordinator/tracker; no native leak claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { ProductInspection } from './fixtures/memory-product-inspection';
import { AggregateCallTracker } from './fixtures/memory-product-aggregate-diagnostics';
import { runNativeCleanup } from './fixtures/memory-product-native-cleanup';
import type { ProductInspectionController } from './fixtures/memory-product-inspection-controller';
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const tick = async () => {
    for (let i = 0; i < 24; i++) await Promise.resolve();
};
function model(heldEvidence?: 'started' | 'settled') {
    const page = {},
        gate = deferred(),
        evidence = deferred(),
        trace: string[] = [];
    const observer = { async release() {}, assertReleased() {}, async bind() {}, assertBound() {} };
    const connection = {
        identity: {
            nativePageId: 'model-page',
            nativeContextId: 'model-context',
            browserProduct: 'model-only',
            root: { pid: 123, created: 'model-only' },
        },
        currentPage: () => page,
        async disconnect() {},
        async reconnect() {
            throw Error('Not used by these admission models.');
        },
        async verify() {},
        async commit() {},
        hostObserver: observer,
        downloadObserver: observer,
        snapshotOwners: () => ({}),
    };
    class Realm {
        async bind() {}
        release = observer.release;
        assertReleased() {}
        assertBound() {}
        snapshot() {
            return {};
        }
        assertJoined() {}
        cleanupPage() {
            return undefined;
        }
    }
    const viewer = {
        async releaseForInspection() {},
        assertInspectionReleased() {},
        async bindInspection() {},
        assertInspectionBound() {},
        snapshotObserver() {
            return {};
        },
        inspectionPageForCleanup: () => page,
        async settleInspectionWorkers() {},
        dispose() {},
    };
    class Export {
        faults = {
            realm: 'service-worker',
            quotaMessage: 'model-only',
            async arm() {
                trace.push('fault-entered');
            },
            async status() {
                trace.push('fault-entered');
                return {};
            },
            async release() {
                trace.push('fault-entered');
            },
            async clear() {
                trace.push('fault-entered');
            },
            async snapshot() {
                trace.push('fault-entered');
                return {};
            },
        };
        configureInspection(_value: unknown) {}
        async initialize() {}
        async releaseForInspection() {}
        assertInspectionReleased() {}
        async bindInspection() {}
        assertInspectionBound() {}
        async retire(destroy: () => Promise<void>) {
            trace.push('export-retire-entered');
            await destroy();
            await gate.promise;
        }
        pending() {
            return [];
        }
        assertInspectionCallsJoined() {}
        inspectionPageForCleanup() {
            return page;
        }
        async dispose() {}
    }
    const original =
        process.env.HUB_CONTROLLER_MODEL_SOURCE ??
        path.join(import.meta.dirname, 'fixtures/memory-product-inspection-controller.ts');
    const code = transformSync(fs.readFileSync(original, 'utf8'), {
        loader: 'ts',
        format: 'cjs',
        target: 'es2022',
    }).code;
    const exports: Record<string, unknown> = {},
        nativeRequire = createRequire(import.meta.url);
    const require = (name: string): unknown => {
        if (name === './memory-product-inspection') return { ProductInspection };
        if (name === './memory-product-inspection-realm') return { ProductInspectionRealm: Realm };
        if (name === './memory-product-aggregate-worker') return { AggregateExportWorker: Export };
        if (name === './memory-product-aggregate-workloads')
            return { createAggregateViewerWitness: async () => ({ workers: viewer }) };
        if (name === './memory-product-aggregate-diagnostics') return { AggregateCallTracker };
        if (name === './memory-product-native-cleanup') return { runNativeCleanup };
        return nativeRequire(name);
    };
    const sandbox = { exports, module: { exports }, require, Promise, Map, Object, Error };
    vm.runInNewContext(code, sandbox, { filename: original });
    const Controller = sandbox.module.exports
        .ProductInspectionController as typeof ProductInspectionController;
    const host = {
        root: '/model-only',
        async createInspection() {
            trace.push('create-inspection-entered');
            return connection;
        },
        bindInspectionAdmission(_guard: unknown) {},
        async close() {
            trace.push('host-close');
        },
        async assertExited() {},
        async joinParentClosure() {
            return {};
        },
    };
    const controller = new Controller(
        host as never,
        async (stage, data: any) => {
            if (stage === 'inspection-admitted-call' && data.state === heldEvidence)
                await evidence.promise;
        },
        () => {},
    );
    const destroy = async (actualPage: unknown) => {
        assert.equal(actualPage, page);
        trace.push('destroy-client-realms');
    };
    return { controller, gate, evidence, trace, destroy };
}

for (const held of ['started', 'work', 'settled'] as const) {
    test(
        'retirement refuses an admitted call held at ' +
            held +
            ' before side effects or state change',
        async () => {
            const f = model(held === 'work' ? undefined : held),
                active = deferred();
            await f.controller.initialize();
            const work = f.controller.use('admitted-in-flight', async () => {
                f.trace.push('admitted-work-entered');
                if (held === 'work') await active.promise;
            });
            await tick();
            const before = f.controller.snapshot();
            let refusal: unknown;
            let retirement: Promise<void> | undefined;
            try {
                retirement = f.controller.retire(f.destroy);
                void retirement.catch(() => {});
            } catch (error) {
                refusal = error;
            }
            await tick();
            const after = f.controller.snapshot(),
                sideEffects = [...f.trace];
            active.resolve();
            f.evidence.resolve();
            f.gate.resolve();
            await work;
            await retirement?.catch(() => {});
            await f.controller.close();
            assert.match(String(refusal), /Actual calls remain unjoined/);
            assert.equal(before.inspection!.admittedCalls.length, 1);
            assert.equal(after.state, 'ready');
            assert.equal(after.inspection!.phase, 'ready');
            assert.equal(sideEffects.includes('export-retire-entered'), false);
            assert.equal(sideEffects.includes('destroy-client-realms'), false);
        },
    );
}

test('a joined admitted call permits one retirement and admits new work only after it settles', async () => {
    const f = model();
    await f.controller.initialize();
    await f.controller.use('finished', async () => {});
    const retirement = f.controller.retire(f.destroy);
    assert.equal(f.controller.snapshot().state, 'retiring');
    assert.throws(() => f.controller.retire(f.destroy));
    await assert.rejects(
        f.controller.use('during-retirement', async () => {
            f.trace.push('unexpected-admission');
        }),
    );
    await tick();
    assert.equal(f.trace.filter((value) => value === 'export-retire-entered').length, 1);
    assert.equal(f.trace.filter((value) => value === 'destroy-client-realms').length, 1);
    f.gate.resolve();
    await retirement;
    assert.equal(f.controller.snapshot().state, 'ready');
    await f.controller.use('after-retirement', async () => {
        f.trace.push('new-admission');
    });
    assert.equal(f.trace.includes('unexpected-admission'), false);
    assert.equal(f.trace.includes('new-admission'), true);
    await f.controller.close();
});

test('retirement queued before immediate close rejects without entering export or client callbacks', async () => {
    const f = model();
    await f.controller.initialize();
    const retirement = f.controller.retire(f.destroy);
    void retirement.catch(() => {});
    const closing = f.controller.close();
    assert.equal(f.controller.close(), closing);
    await tick();
    f.gate.resolve();
    await assert.rejects(retirement, /retiring/);
    await closing;
    assert.equal(f.trace.includes('export-retire-entered'), false);
    assert.equal(f.trace.includes('destroy-client-realms'), false);
    assert.equal(f.controller.snapshot().state, 'closed');
    await assert.rejects(
        f.controller.use('after-close', async () => {
            f.trace.push('unexpected-admission');
        }),
    );
    assert.throws(() => f.controller.retire(f.destroy));
    assert.equal(f.trace.includes('unexpected-admission'), false);
});

test('initialization queued before immediate close rejects before inspection acquisition', async () => {
    const f = model();
    const initialization = f.controller.initialize();
    void initialization.catch(() => {});
    const closing = f.controller.close();
    assert.equal(f.controller.close(), closing);
    await assert.rejects(initialization, /initializing/);
    await closing;
    assert.deepEqual(f.trace, ['host-close']);
    assert.equal(f.controller.snapshot().state, 'closed');
});

test('closing a never-initialized controller refuses later initialization and retirement', async () => {
    const f = model();
    await f.controller.close();
    assert.throws(() => f.controller.initialize());
    assert.throws(() => f.controller.retire(f.destroy));
    assert.deepEqual(f.trace, ['host-close']);
    assert.equal(f.controller.snapshot().state, 'closed');
});

test('retained aggregate export-fault ports refuse callbacks after close', async () => {
    const f = model();
    await f.controller.initialize();
    const faults = f.controller.exportReadFaults();
    await f.controller.close();
    for (const run of [
        () => faults.arm({} as never),
        () => faults.status(),
        () => faults.release(),
        () => faults.clear(),
        () => faults.snapshot(),
    ])
        await assert.rejects(run());
    assert.equal(f.trace.includes('fault-entered'), false);
});
