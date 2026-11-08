import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import {
    aggregateSupported,
    aggregatePending,
    serialExpectation,
    scheduledCatalog,
    assertCoverageReceipt,
    aggregateCaptureAccounting,
    assertDistinctAggregateScopes,
} from './fixtures/memory-product-aggregate-contract';
import { validateDeclaredMemoryScope } from './fixtures/memory-resource-policy';
import { requirements as fullRequirements } from './fixtures/memory-resource-verdict';
import { joinAggregatePageOperations } from './fixtures/memory-product-aggregate-cleanup';

test('actual adapter keeps every unimplemented full product case blocking', () => {
    const supported = aggregateSupported(true);
    const full = fullRequirements(false, supported, true);
    const missing = full.coverage.filter((id) => !supported.includes(id as never));
    assert.deepEqual([...missing].sort(), Object.keys(aggregatePending).sort());
    assert.doesNotThrow(() => assertCoverageReceipt(['versionchange'], true));
    assert.throws(() => assertCoverageReceipt(['run-success', 'run-success'], true));
    assert.throws(() =>
        validateDeclaredMemoryScope({
            roles: ['browser-renderer'],
            runtimeIdentity: {},
            unsupported: { pending: 'actual scope not verified' },
        }),
    );
});
test('catalog schedule requires actual matching mode and repeats bounded endpoints', () => {
    const counts = new Map<string, number>();
    for (let ordinal = 0; ordinal < 12; ordinal++) {
        const mode = ordinal % 2 ? 'growing' : 'constant';
        const key = mode + '/' + scheduledCatalog(ordinal, mode);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    assert.deepEqual(Object.fromEntries(counts), {
        'constant/1': 6,
        'growing/2': 3,
        'growing/3': 3,
    });
    assert.throws(() => scheduledCatalog(1, 'constant'));
    assert.throws(() => scheduledCatalog(-1, 'growing'));
});
test('independent expected stream hashes bind producer x bytes, tail and prompt', () => {
    const bytes = Buffer.concat([
        Buffer.alloc(65536 - 4, 120),
        Buffer.from('tail\r\nqualification# '),
    ]);
    assert.deepEqual(serialExpectation(65536, 'tail'), {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    assert.throws(() => serialExpectation(1, 'oversized-tail'));
});
test('aggregate invokes actual App helpers and preserves fail-closed qualification boundary', () => {
    const source = fs
        .readFileSync(new URL('./fixtures/memory-product-aggregate.ts', import.meta.url), 'utf8')
        .replace(/\s+/g, ' ');
    assert.ok(source.includes('createProductBrowser('));
    assert.ok(source.includes('createProductGateway('));
    assert.ok(source.includes('exerciseProductSerial('));
    assert.ok(source.includes('exerciseProductSsh('));
    assert.ok(source.includes('exerciseProductResults('));
    assert.ok(source.includes('exerciseProductSerialLifecycle('));
    assert.ok(source.includes("receipts.has('independent-stream-stored')"));
    assert.ok(source.includes('createNativeAggregateDriver(context)'));
    assert.ok(!source.includes('memoryResourceQA'));
    assert.ok(!source.includes('await nativeCycle('));
    assert.ok(source.includes('closed = true;'));
    assert.ok(source.includes('errors.length) throw new AggregateError'));
    assert.ok(source.includes('await host!.assertExited(); await gateway!.assertExited();'));
    assert.ok(source.includes('window.memoryProduct.joinAggregatePageOperations()'));
    assert.ok(!source.includes('page.evaluate(joinAggregatePageOperations)'));
    const app = fs.readFileSync(
        new URL('./fixtures/memory-product-app.tsx', import.meta.url),
        'utf8',
    );
    assert.ok(app.includes('import { joinAggregatePageOperations }'));
});

function closedSerial() {
    return {
        opens: 3,
        closes: 3,
        remaining: 0,
        readerActive: false,
        writerActive: false,
        pumping: false,
        heldOpen: false,
        heldWrite: false,
        promptPending: false,
    };
}
async function cleanupModel(api: unknown, action: () => Promise<void>) {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
        value: { memoryProduct: api },
        configurable: true,
    });
    try {
        await action();
    } finally {
        if (before) Object.defineProperty(globalThis, 'window', before);
        else Reflect.deleteProperty(globalThis, 'window');
    }
}
test('actual cleanup function does not require a collected instance when real port counters prove closed', async () => {
    let repo = false;
    await cleanupModel(
        {
            runnerCleanupTargets: () => [],
            unmount() {
                throw Error('Actual App not mounted.');
            },
            serial: { snapshot: closedSerial },
            async closeSerial() {
                throw Error('Product instance not mounted: serial');
            },
            async closeRepository() {
                repo = true;
            },
        },
        async () => {
            const actual = await joinAggregatePageOperations();
            assert.equal(actual.serialJoinInvoked, false);
            assert.equal(actual.repositoryJoined, true);
            assert.equal(repo, true);
        },
    );
});
test('actual cleanup function awaits an open port join before publishing acknowledgement', async () => {
    const state = { ...closedSerial(), closes: 2, writerActive: true };
    let release!: () => void,
        repo = false,
        joined = false;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    await cleanupModel(
        {
            runnerCleanupTargets: () => [],
            unmount() {},
            serial: { snapshot: () => ({ ...state }) },
            async closeSerial() {
                await pending;
                state.closes = 3;
                state.writerActive = false;
            },
            async closeRepository() {
                repo = true;
            },
        },
        async () => {
            const result = joinAggregatePageOperations().then((value) => {
                joined = true;
                return value;
            });
            await Promise.resolve();
            assert.equal(joined, false);
            assert.equal(repo, false);
            release();
            assert.equal((await result).serialJoinInvoked, true);
            assert.equal(repo, true);
        },
    );
});
test('missing or still-open actual probes fail cleanup while repository close is attempted', async () => {
    for (const state of [
        { ...closedSerial(), opens: 4 },
        { ...closedSerial(), pumping: undefined },
    ]) {
        let repo = false;
        await cleanupModel(
            {
                runnerCleanupTargets: () => [],
                unmount() {},
                serial: { snapshot: () => state },
                async closeSerial() {},
                async closeRepository() {
                    repo = true;
                },
            },
            async () => {
                await assert.rejects(joinAggregatePageOperations(), AggregateError);
                assert.equal(repo, true);
            },
        );
    }
});

test('bundled page API retains compiler support that direct function serialization loses', async () => {
    const helper = fs.readFileSync(
        new URL('./fixtures/memory-product-aggregate-cleanup.ts', import.meta.url),
        'utf8',
    );
    const bundle = transformSync(helper, {
        loader: 'ts',
        format: 'iife',
        globalName: 'aggregateCleanup',
        keepNames: true,
        target: 'es2022',
    }).code;
    let repositoryClosed = 0;
    const api = {
        runnerCleanupTargets: () => [],
        unmount() {},
        serial: { snapshot: closedSerial },
        async closeSerial() {
            throw Error('Product instance not mounted: serial');
        },
        async closeRepository() {
            repositoryClosed++;
        },
    };
    const realm = vm.createContext({ window: { memoryProduct: api } });
    vm.runInContext(bundle, realm);
    const direct = vm.runInContext('aggregateCleanup.joinAggregatePageOperations', realm);
    const fresh = vm.createContext({ window: { memoryProduct: api } });
    await assert.rejects(
        vm.runInContext('(' + direct.toString() + ')()', fresh),
        /__name is not defined/,
    );
    api['joinAggregatePageOperations' as keyof typeof api] = direct;
    const actual = await vm.runInContext(
        '(() => window.memoryProduct.joinAggregatePageOperations())()',
        realm,
    );
    assert.equal(actual.repositoryJoined, true);
    assert.equal(actual.serialJoinInvoked, false);
    assert.equal(repositoryClosed, 1);
});

test('page cleanup joins the captured active runner promise before closing its repository', async () => {
    let release!: () => void,
        repositoryClosed = false;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    const runner = {
        active: pending as Promise<void> | undefined,
        busy: true,
        cleanupPending: false,
    };
    const order: string[] = [];
    await cleanupModel(
        {
            runnerCleanupTargets() {
                order.push('capture');
                return [{ id: 9, value: runner }];
            },
            unmount() {
                order.push('unmount');
            },
            serial: { snapshot: closedSerial },
            async closeSerial() {
                throw Error('Unexpected synthetic port close.');
            },
            async closeRepository() {
                repositoryClosed = true;
                order.push('repository');
            },
        },
        async () => {
            const result = joinAggregatePageOperations();
            await Promise.resolve();
            assert.deepEqual(order, ['capture', 'unmount']);
            assert.equal(repositoryClosed, false);
            runner.active = undefined;
            runner.busy = false;
            release();
            assert.deepEqual((await result).runnerJoins, [9]);
            assert.equal(repositoryClosed, true);
        },
    );
});

test('runner cleanup pending and absent join probes remain named failures', async () => {
    for (const targets of [
        undefined,
        () => [{ id: 7, value: { active: undefined, busy: true, cleanupPending: true } }],
    ]) {
        let repositoryAttempted = false;
        await cleanupModel(
            {
                runnerCleanupTargets: targets,
                unmount() {},
                serial: { snapshot: closedSerial },
                async closeSerial() {},
                async closeRepository() {
                    repositoryAttempted = true;
                },
            },
            async () => {
                await assert.rejects(joinAggregatePageOperations(), (error) => {
                    assert.ok(error instanceof AggregateError);
                    assert.match(error.message, targets ? /join-runner-7/ : /capture-runner-joins/);
                    return true;
                });
                assert.equal(repositoryAttempted, true);
            },
        );
    }
});

test('page cleanup retains each failed stage in the error crossing the browser boundary', async () => {
    await cleanupModel(
        {
            runnerCleanupTargets: () => [],
            unmount() {
                throw Error('unmount-model');
            },
            serial: { snapshot: () => ({ ...closedSerial(), pumping: true }) },
            async closeSerial() {
                throw Error('port-model');
            },
            async closeRepository() {
                throw Error('repository-model');
            },
        },
        async () => {
            await assert.rejects(joinAggregatePageOperations(), (error) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.errors.length, 3);
                assert.match(error.message, /unmount: Error: unmount-model/);
                assert.match(error.message, /close-serial: Error: port-model/);
                assert.match(error.message, /close-repository: Error: repository-model/);
                return true;
            });
        },
    );
});
