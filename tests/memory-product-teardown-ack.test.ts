import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}
function model(acknowledge: () => Promise<void>) {
    const source = fs
        .readFileSync(new URL('./fixtures/memory-product-aggregate.ts', import.meta.url), 'utf8')
        .replaceAll('\r\n', '\n');
    const functions = ['teardown', 'teardownOnce'].map((name) => {
        const found = source.match(
            new RegExp(`    async function ${name}\\(\\) \\{[\\s\\S]*?\\n    \\}`),
        );
        assert.ok(found, 'Actual teardown function missing: ' + name);
        return found[0];
    });
    const methods = ['snapshotOwners', 'assertDescendantsExited'].map((name) => {
        const found = source.match(
            new RegExp(`        async ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n        \\},`),
        );
        assert.ok(found, 'Actual driver method missing: ' + name);
        return found[0]
            .trim()
            .replace(/^async /, 'async function ')
            .replace(/,$/, '');
    });
    const calls: string[] = [];
    const proof = Object.freeze({ parent: 'explicit model only' });
    const sandbox = vm.createContext({
        assert,
        AggregateError,
        host: {
            page: { isClosed: () => true },
            pageForCleanup: () => ({ isClosed: () => true }),
            async close() {
                calls.push('host-close');
            },
            async joinParentClosure() {
                calls.push('parent-history-join');
                return proof;
            },
            async assertExited() {
                calls.push('host-exit-join');
            },
        },
        gateway: {
            async close() {
                calls.push('gateway-close');
            },
            async assertExited() {
                calls.push('gateway-exit-join');
            },
        },
        rootClosed: Promise.resolve(),
        rootExit: { code: 0, signal: null },
        rootClose: { code: 0, signal: null },
        inspection: {
            async close() {
                calls.push('host-close', 'parent-history-join', 'observer-disposed');
            },
        },
        diagnosticCalls: {
            assertJoined() {
                calls.push('calls-joined');
            },
        },
        exportWorker: {
            async dispose(value: unknown) {
                assert.equal(value, proof);
                calls.push('observer-disposed');
            },
        },
        viewerWorkers: undefined,
        context: {
            viewer: false,
            async emit(stage: string) {
                if (stage === 'aggregate-full-process-teardown') await acknowledge();
                else assert.equal(stage, 'aggregate-native-root-exit-close');
            },
        },
        ownerKinds: ['writer'],
        viewerOwnerKinds: ['raf'],
        async rawOwners() {
            throw Error('No live owner snapshot in this teardown model.');
        },
    });
    const body = `let closed=false,teardownStarted=false,teardownTask,teardownEvidenceFailed=false,teardownEvidenceFailure,finalOwners;
const rootExit={code:0,signal:null},rootClose={code:0,signal:null},rootClosed=Promise.resolve();
${functions.join('\n')}
${methods.join('\n')}
globalThis.driver={teardown,snapshotOwners,assertDescendantsExited,state:()=>({closed,hasFinalOwners:finalOwners!==undefined})};`;
    vm.runInContext(
        transformSync(body, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
        sandbox,
    );
    return {
        driver: sandbox.driver as {
            teardown(): Promise<void>;
            snapshotOwners(stage: string): Promise<unknown>;
            assertDescendantsExited(): Promise<void>;
            state(): { closed: boolean; hasFinalOwners: boolean };
        },
        calls,
    };
}
function observed(promise: Promise<unknown>) {
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
async function ticks() {
    for (let index = 0; index < 5; index++) await Promise.resolve();
}

for (const rejected of [false, true]) {
    test(`actual aggregate teardown joins callers through ${rejected ? 'failed' : 'successful'} receipt publication`, async () => {
        const entered = deferred(),
            write = deferred(),
            failure = Error('Aggregate receipt write failed.');
        const { driver, calls } = model(async () => {
            entered.resolve();
            await write.promise;
            if (rejected) throw failure;
        });
        const first = observed(driver.teardown());
        await entered.promise;
        const second = observed(driver.teardown());
        await ticks();
        assert.equal(first.state(), 'pending');
        assert.equal(second.state(), 'pending');
        assert.equal(driver.state().closed, false);
        assert.equal(driver.state().hasFinalOwners, false);
        await assert.rejects(driver.snapshotOwners('post-teardown'), /pending or failed/);
        await assert.rejects(driver.assertDescendantsExited(), /not acknowledged/);
        write.resolve();
        const [a, b] = await Promise.all([first.result, second.result]);
        assert.equal(a.kind, rejected ? 'rejected' : 'resolved');
        assert.equal(b.kind, a.kind);
        if (rejected) {
            if (a.kind !== 'rejected' || b.kind !== 'rejected') throw Error('Wrong verdict.');
            assert.equal(a.error, failure);
            assert.equal(b.error, failure);
            await assert.rejects(driver.teardown(), (error) => error === failure);
            assert.equal(driver.state().closed, false);
            assert.equal(driver.state().hasFinalOwners, false);
            await assert.rejects(driver.snapshotOwners('post-teardown'), /pending or failed/);
        } else {
            await driver.teardown();
            assert.equal(driver.state().closed, true);
            assert.equal(
                JSON.stringify(await driver.snapshotOwners('post-teardown')),
                '{"writer":0}',
            );
            await driver.assertDescendantsExited();
        }
        assert.equal(calls.filter((value) => value === 'host-close').length, 1);
        assert.equal(calls.filter((value) => value === 'observer-disposed').length, 1);
    });
    test(`aggregate evidence callback reentry cannot acknowledge ${rejected ? 'failed' : 'pending'} teardown early`, async () => {
        const entered = deferred(),
            write = deferred(),
            failure = Error('Reentrant aggregate receipt failed.');
        let nested: ReturnType<typeof observed> | undefined;
        const { driver } = model(async () => {
            nested = observed(driver.teardown());
            entered.resolve();
            await write.promise;
            if (rejected) throw failure;
        });
        const outer = observed(driver.teardown());
        await entered.promise;
        await ticks();
        assert.ok(nested);
        assert.equal(nested.state(), 'pending');
        assert.equal(outer.state(), 'pending');
        write.resolve();
        const [a, b] = await Promise.all([outer.result, nested.result]);
        assert.equal(a.kind, rejected ? 'rejected' : 'resolved');
        assert.equal(b.kind, a.kind);
        if (a.kind === 'rejected' && b.kind === 'rejected') {
            assert.equal(a.error, failure);
            assert.equal(b.error, failure);
        }
    });
}
