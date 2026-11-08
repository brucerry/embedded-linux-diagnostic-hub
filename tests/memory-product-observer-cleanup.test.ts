import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    createObserverCleanupGuard,
    verifyProductCleanup,
    canReleaseObserver,
} from './fixtures/observer-cleanup-guard';

// New versioned guard, not the missing external run-product-check.cjs.
// The old source-extraction test remains in immutable bd013ed history; none of
// its private launcher observations or historical receipts are claimed here.
const identity = { token: 'owned', pid: 1234, cohort: 'mock' };
const checks = (verified: boolean) => ({
    resultRead: verified,
    cleanupVerified: verified,
    receiptWritten: verified,
    sourceVerified: verified,
});
function fixture(
    outcome: unknown,
    verified = false,
    foreign = false,
    options: {
        markerChange?: Partial<typeof identity>;
        releaseError?: Error;
        receiptError?: Error;
        verificationError?: Error;
        throwChild?: boolean;
    } = {},
) {
    const operations: ({ operation: 'write'; value: string } | { operation: 'unlink' })[] = [];
    const calls = { child: 0, verification: 0, release: 0, receipt: 0 };
    let current: typeof identity | null = { ...identity, token: foreign ? 'foreign' : 'owned' };
    const guard = createObserverCleanupGuard(identity, {
        runChild() {
            calls.child++;
            if (options.throwChild) throw outcome;
            return outcome;
        },
        verify() {
            calls.verification++;
            if (options.verificationError) throw options.verificationError;
            return checks(verified);
        },
        readMarker() {
            const observed = current ? { ...current } : null;
            if (options.markerChange && current) current = { ...current, ...options.markerChange };
            return observed;
        },
        releaseOwnedMarker(expected) {
            calls.release++;
            // In-memory identity-conditioned operation, not a native unlink adapter.
            assert.deepEqual(current, expected, 'Marker changed at release.');
            if (options.releaseError) throw options.releaseError;
            current = null;
            operations.push({ operation: 'unlink' });
            return { released: true, identity: { ...expected } };
        },
        writeHeldReceipt(receipt) {
            calls.receipt++;
            if (options.receiptError) throw options.receiptError;
            operations.push({ operation: 'write', value: JSON.stringify(receipt) });
        },
    });
    return { guard, operations, calls, marker: () => current };
}
function runGuard(outcome: unknown, verified = false, foreign = false) {
    const f = fixture(outcome, verified, foreign);
    return { ...f, ...f.guard.run() };
}
test('nonshipping observer guard retains its marker on normal code1, signal and spawn error', () => {
    for (const outcome of [
        { status: 1, signal: null },
        { status: null, signal: 'SIGTERM' },
        { status: null, signal: null, error: Error('synthetic spawn failure') },
    ]) {
        const row = runGuard(outcome);
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
test('code0 observer guard still requires result, source and explicit cleanup receipts', () => {
    const row = runGuard({ status: 0, signal: null });
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
    const good = runGuard({ status: 0, signal: null }, true);
    assert.equal(good.failure, undefined);
    assert.equal(
        good.operations.some((op) => op.operation === 'unlink'),
        true,
    );
    const foreign = runGuard({ status: 0, signal: null }, true, true);
    assert.ok(foreign.failure);
    assert.equal(
        foreign.operations.some((op) => op.operation === 'unlink'),
        false,
    );
});
test('mode-specific host/descendant summary records are mandatory and failures stay latched', () => {
    const result = {
        status: 'actual-console-development-passed',
        qualified: false,
        native: true,
        failure: null,
        scope: 'bounded synthetic fixture',
    };
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

test('every proof field is required and inherited/accessor claims do not release custody', () => {
    const good = runGuard({ status: 0, signal: null }, true);
    assert.equal(canReleaseObserver(good.releaseProof), true);
    assert.equal(good.qualification, false);
    for (const key of [
        'childStarted',
        'outcome',
        'failureLatched',
        'resultRead',
        'cleanupVerified',
        'receiptWritten',
        'sourceVerified',
    ]) {
        const missing = { ...good.releaseProof } as Record<string, unknown>;
        delete missing[key];
        assert.equal(canReleaseObserver(missing), false, key);
    }
    for (const key of ['resultRead', 'cleanupVerified', 'receiptWritten', 'sourceVerified'])
        assert.equal(canReleaseObserver({ ...good.releaseProof, [key]: false }), false, key);
    assert.equal(canReleaseObserver(Object.create(good.releaseProof)), false);
    const accessor = { ...good.releaseProof };
    Object.defineProperty(accessor, 'cleanupVerified', {
        get() {
            assert.fail('Untrusted getter must not run.');
        },
    });
    assert.equal(canReleaseObserver(accessor), false);
});

test('abnormal child outcomes skip verification and cannot be redeemed by passing flags', () => {
    const spawnFailure = Error('synthetic spawn uncertainty');
    for (const output of [
        null,
        {},
        { status: 0 },
        { status: 0, signal: 'SIGTERM' },
        { status: 0, signal: null, error: spawnFailure },
        { status: null, signal: null },
        { status: '0', signal: null },
        Object.create({ status: 0, signal: null }),
    ]) {
        const f = fixture(output, true);
        const result = f.guard.run();
        assert.ok(result.failure);
        assert.equal(result.disposition, 'retained-or-unknown');
        assert.equal(result.releaseProof.failureLatched, true);
        assert.equal(f.calls.verification, 0);
        assert.equal(f.calls.release, 0);
        assert.equal(canReleaseObserver({ ...result.releaseProof, ...checks(true) }), false);
    }
    for (const thrown of [spawnFailure, undefined, null, false]) {
        const f = fixture(thrown, true, false, { throwChild: true });
        const result = f.guard.run();
        assert.ok(result.failure);
        if (thrown === spawnFailure) assert.equal(result.failure, spawnFailure);
        assert.equal(f.calls.verification, 0);
        assert.equal(f.calls.release, 0);
        assert.equal(result.releaseProof.childStarted, true);
    }
    assert.equal(
        runGuard({ status: null, signal: null, error: spawnFailure }, true).failure,
        spawnFailure,
    );
});

test('PID cohort token and identity at release all remain bound to the admitted marker', () => {
    for (const change of [{ token: 'foreign' }, { pid: 1235 }, { cohort: 'other' }]) {
        const f = fixture({ status: 0, signal: null }, true, false, { markerChange: change });
        const result = f.guard.run();
        assert.ok(result.failure);
        assert.equal(result.disposition, 'retained-or-unknown');
        assert.equal(f.calls.release, 1);
        assert.equal(
            f.operations.some((row) => row.operation === 'unlink'),
            false,
        );
        assert.deepEqual(f.marker(), { ...identity, ...change });
    }
});

test('verification and release failures remain latched with no implicit second attempt', () => {
    const failure = Error('synthetic verification failure');
    const verification = fixture({ status: 0, signal: null }, true, false, {
        verificationError: failure,
    });
    assert.equal(verification.guard.run().failure, failure);
    assert.equal(verification.calls.release, 0);
    const release = fixture({ status: 0, signal: null }, true, false, { releaseError: failure });
    const result = release.guard.run();
    assert.equal(result.failure, failure);
    assert.equal(result.disposition, 'retained-or-unknown');
    assert.equal(release.calls.release, 1);
    assert.throws(() => release.guard.run(), /already used/);
    assert.equal(release.calls.child, 1);
    assert.equal(release.calls.release, 1);
    assert.deepEqual(release.marker(), identity);
});

test('failure to write the held receipt preserves both failures and never releases the marker', () => {
    const receiptFailure = Error('synthetic held receipt failure');
    const f = fixture({ status: 1, signal: null }, true, false, { receiptError: receiptFailure });
    const result = f.guard.run();
    assert.ok(result.failure instanceof AggregateError);
    assert.equal(result.failure.errors.length, 2);
    assert.equal(result.failure.errors[1], receiptFailure);
    assert.equal(f.calls.release, 0);
    assert.deepEqual(f.marker(), identity);
});

test('summary checks reject unsupported modes, failed results and false or missing closure evidence', () => {
    const result = {
        status: 'actual-console-development-passed',
        qualified: false,
        native: true,
        failure: null,
    };
    const events = [
        { stage: 'actual-process-exit', data: { verified: true } },
        { stage: 'actual-gateway-exit', data: { verified: true } },
    ];
    assert.deepEqual(verifyProductCleanup('console-native', result, events), {
        verified: true,
        qualification: false,
        scope: 'diagnostic-summary-only',
    });
    for (const mode of ['console-web', 'native', '', null])
        assert.throws(() => verifyProductCleanup(mode, result, events), /Unsupported/);
    for (const change of [{ status: 'failed' }, { qualified: true }, { native: false }])
        assert.throws(() =>
            verifyProductCleanup('console-native', { ...result, ...change }, events),
        );
    for (const stage of [
        'failure',
        'cleanup-failure',
        'gateway-cleanup-failure',
        'observer-cleanup-failure',
    ])
        assert.throws(() =>
            verifyProductCleanup('console-native', result, [
                ...events,
                { stage, data: { verified: true } },
            ]),
        );
    assert.throws(() =>
        verifyProductCleanup('console-native', result, [
            ...events,
            { stage: 'actual-foreign-exit' },
        ]),
    );
    assert.throws(() =>
        verifyProductCleanup('console-native', result, Array(4097).fill(events[0])),
    );
    assert.throws(() =>
        verifyProductCleanup('console-native', result, [
            events[0],
            { stage: 'actual-gateway-exit', data: Object.create({ verified: true }) },
        ]),
    );
});

test('supported summary shape is bound to the existing first-party console smoke emitter', () => {
    const source = readFileSync('tests/memory-product-console-smoke.mts', 'utf8');
    assert.match(
        source,
        /await gateway\.close\(\);\s+await gateway\.assertExited\(\);\s+await emit\('actual-gateway-exit', \{ verified: true \}\);/,
    );
    assert.match(
        source,
        /await host\.close\(\);\s+await host\.assertExited\(\);\s+await emit\('actual-process-exit', \{ verified: true \}\);/,
    );
    assert.ok(source.includes("status: failure ? 'failed' : 'actual-console-development-passed'"));
    assert.ok(source.includes('qualified: false,'));
    assert.ok(source.includes('failure: failure ? String(failure) : null,'));
    // Reading emitter source is no claim that its browser/native workload ran.
});

test('missing or foreign release acknowledgements remain unknown and are never retried', () => {
    for (const acknowledgement of [
        undefined,
        { released: false, identity },
        { released: true, identity: { ...identity, token: 'foreign' } },
    ]) {
        let releases = 0,
            receipts = 0;
        const guard = createObserverCleanupGuard(identity, {
            runChild: () => ({ status: 0, signal: null }),
            verify: () => checks(true),
            readMarker: () => ({ ...identity }),
            releaseOwnedMarker() {
                releases++;
                // Could represent an uncertain operation; never infer rollback or retry.
                return acknowledgement as { released: true; identity: typeof identity };
            },
            writeHeldReceipt(receipt) {
                receipts++;
                assert.equal(receipt.marker, 'retained-or-unknown');
                assert.equal(receipt.qualification, false);
            },
        });
        const result = guard.run();
        assert.ok(result.failure);
        assert.equal(result.disposition, 'retained-or-unknown');
        assert.equal(releases, 1);
        assert.equal(receipts, 1);
        assert.throws(() => guard.run(), /already used/);
        assert.equal(releases, 1);
    }
});

test('invalid admission fails before calling ports and admitted identity is copied', () => {
    let calls = 0;
    const supplied = { ...identity };
    const ports = {
        runChild() {
            calls++;
            supplied.token = 'changed-after-admission';
            return { status: 0, signal: null };
        },
        verify: () => checks(true),
        readMarker: () => ({ ...identity }),
        releaseOwnedMarker(expected: typeof identity) {
            assert.deepEqual(expected, identity);
            assert.equal(Object.isFrozen(expected), true);
            return { released: true as const, identity: { ...identity } };
        },
        writeHeldReceipt() {
            assert.fail('Valid frozen identity should release.');
        },
    };
    for (const invalid of [
        { ...identity, pid: 0 },
        { ...identity, token: '../foreign' },
        Object.create(identity),
    ])
        assert.throws(() => createObserverCleanupGuard(invalid, ports));
    assert.equal(calls, 0);
    const guard = createObserverCleanupGuard(supplied, ports);
    assert.equal(guard.run().disposition, 'released');
    assert.equal(calls, 1);
});
