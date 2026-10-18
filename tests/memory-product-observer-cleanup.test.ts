import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '../..');
const { verifyProductCleanup, canReleaseObserver } = createRequire(import.meta.url)(
    path.join(root, 'observer-cleanup-verdict.cjs'),
);
const observerFile =
    process.env.HUB_CLEANUP_OBSERVER_SOURCE ?? path.join(root, 'run-product-check.cjs');
function actualObserverRegions(outcome: any, verified = false, foreign = false) {
    const source = fs.readFileSync(observerFile, 'utf8');
    const run = source.slice(
        source.indexOf('function run('),
        source.indexOf('function inventory('),
    );
    const finallyStart = source.indexOf('}finally{\n const current=');
    assert.ok(finallyStart >= 0, 'Update exact observer-region test for changed boundaries.');
    const body = source.slice(
        finallyStart + '}finally{'.length,
        source.indexOf('\n}', finallyStart),
    );
    const operations: any[] = [];
    const releaseProof = {
        childStarted: false,
        outcome: null,
        resultRead: verified,
        cleanupVerified: verified,
        receiptWritten: verified,
        sourceVerified: verified,
    };
    const context = vm.createContext({
        assert,
        cp: { spawnSync: () => outcome },
        fs: {
            writeFileSync: (_file: string, value: string) =>
                operations.push({ operation: 'write', value }),
            readFileSync: () =>
                JSON.stringify({
                    token: foreign ? 'foreign' : 'owned',
                    pid: process.pid,
                    cohort: 'mock',
                }),
            unlinkSync: () => operations.push({ operation: 'unlink' }),
        },
        path,
        process,
        Date,
        JSON,
        console,
        workspace: 'mock-workspace',
        modules: 'mock-modules',
        output: 'mock-output',
        marker: 'mock-marker',
        token: 'owned',
        cohort: 'mock',
        mode: 'console-native',
        gcMode: 'normal',
        scenarios: 'stream',
        notBeforeUTC: '2000-01-01T00:00:00Z',
        uncertain: false,
        releaseProof,
        canReleaseObserver,
    });
    vm.runInContext(
        run + '\nglobalThis.actualRun=run;globalThis.actualFinally=()=>{' + body + '};',
        context,
    );
    let failure: unknown;
    try {
        vm.runInContext("actualRun('mock',[])", context);
    } catch (error) {
        failure = error;
    }
    try {
        vm.runInContext('actualFinally()', context);
    } catch (error) {
        failure ??= error;
    }
    return { operations, failure, releaseProof };
}
test('actual observer retains its marker on normal code1, signal and spawn error', () => {
    for (const outcome of [
        { status: 1, signal: null },
        { status: null, signal: 'SIGTERM' },
        { status: null, signal: null, error: Error('synthetic spawn failure') },
    ]) {
        const row = actualObserverRegions(outcome);
        assert.ok(row.failure);
        assert.equal(
            row.operations.some((op) => op.operation === 'unlink'),
            false,
            'Failed child released exclusivity.',
        );
        assert.ok(
            row.operations.some(
                (op) =>
                    op.operation === 'write' && op.value.includes('cleanup-verification-required'),
            ),
        );
    }
});
test('actual code0 observer still requires result, source and explicit cleanup receipts', () => {
    const row = actualObserverRegions({ status: 0, signal: null });
    assert.equal(
        row.operations.some((op) => op.operation === 'unlink'),
        false,
    );
    assert.equal(
        canReleaseObserver({
            ...row.releaseProof,
            resultRead: true,
            receiptWritten: true,
            sourceVerified: true,
        }),
        false,
    );
});
test('verified normal success releases only its own token; foreign token remains untouched', () => {
    const good = actualObserverRegions({ status: 0, signal: null }, true);
    assert.equal(good.failure, undefined);
    assert.equal(
        good.operations.some((op) => op.operation === 'unlink'),
        true,
    );
    const foreign = actualObserverRegions({ status: 0, signal: null }, true, true);
    assert.ok(foreign.failure);
    assert.equal(
        foreign.operations.some((op) => op.operation === 'unlink'),
        false,
    );
});
test('mode-specific actual host/descendant receipts are mandatory and failures stay latched', () => {
    const result = { qualified: false, failure: null, scope: 'bounded synthetic fixture' };
    const events = [
        { stage: 'actual-process-exit', data: { verified: true } },
        { stage: 'actual-gateway-exit', data: { verified: true } },
    ];
    assert.equal(verifyProductCleanup('console-native', result, events).verified, true);
    for (const altered of [
        [],
        [events[0]],
        [...events, events[0]],
        [...events, { stage: 'cleanup-failure', data: { verified: true } }],
        [events[0], { stage: 'actual-gateway-exit', data: { verified: false } }],
    ])
        assert.throws(() => verifyProductCleanup('console-native', result, altered));
    assert.throws(() =>
        verifyProductCleanup('console-native', { ...result, failure: 'failed descendant' }, events),
    );
});
